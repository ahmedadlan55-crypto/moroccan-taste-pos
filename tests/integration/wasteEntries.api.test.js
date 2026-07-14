'use strict';
/* Integration — waste entries (real server + DB, synthesized fixtures).
 *
 * The backend genuinely works (it deducts warehouse stock, writes an inventory
 * movement, and posts Dr <waste sub-account by reason> / Cr Inventory). What it
 * lacked — everything its own DELETE sibling already had:
 *   · NO transaction on POST → a mid-loop failure left a half-written entry with
 *     partial stock deducted and no GL.
 *   · NO idempotency → genId('WE') is random, so a double-POST created two
 *     entries and deducted stock TWICE.
 *   · NO server-side qty validation → a negative qty INCREMENTED stock and
 *     posted a reversed GL entry. Only the browser enforced min="0".
 *   · created_by from req.body → a spoofable actor on an audit column.
 *   · NO period-lock check → waste posted into closed periods.
 *
 * waste_entries is EMPTY on this install, so every fixture here is synthesized
 * and cleaned up.
 *
 * Run: node tests/integration/wasteEntries.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3986;
const CASHIER = 'itest_waste_cashier';
const MANAGER = 'itest_waste_manager';
const PW = 'Waste#Test!2026';
const WH = 'ITEST-WH-WASTE';
const ITEM = 'ITEST-ITEM-WASTE';
const PERIOD = 'ITEST-WASTE-CLOSED';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const stockOf = async () => {
  const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM]);
  return r.length ? Number(r[0].qty) : null;
};
const wasteCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM waste_entries WHERE warehouse_id=?', [WH]); return Number(r[0].c); };
const journalCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM gl_journals'); return Number(r[0].c); };

async function cleanup() {
  for (const u of [CASHIER, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try {
    const [ws] = await db.query('SELECT id FROM waste_entries WHERE warehouse_id=?', [WH]);
    for (const w of ws) {
      await db.query('DELETE FROM waste_entry_items WHERE waste_id=?', [w.id]).catch(() => {});
      const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type='WasteEntry' AND reference_id=?", [w.id]);
      for (const j of js) {
        await db.query('DELETE FROM gl_entries WHERE journal_id=?', [j.id]).catch(() => {});
        await db.query('DELETE FROM gl_journals WHERE id=?', [j.id]).catch(() => {});
      }
    }
    await db.query('DELETE FROM waste_entries WHERE warehouse_id=?', [WH]);
  } catch (_) {}
  try { await db.query('DELETE FROM inventory_movements WHERE warehouse_id=?', [WH]); } catch (_) {}
  try { await db.query('DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]); } catch (_) {}
  try { await db.query('DELETE FROM inv_items WHERE id=?', [ITEM]); } catch (_) {}
  try { await db.query('DELETE FROM warehouses WHERE id=?', [WH]); } catch (_) {}
  try { await db.query('DELETE FROM accounting_periods WHERE id=?', [PERIOD]); } catch (_) {}
}

const payload = (extra = {}) => ({
  warehouseId: WH, wasteDate: '2029-06-15', reason: 'expired',
  items: [{ itemId: ITEM, quantity: 3, unit: 'PCS', unitCost: 10 }],
  ...extra,
});

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  // warehouses.code is NOT NULL with no default.
  await db.query("INSERT INTO warehouses (id, name, code) VALUES (?, 'ITEST Waste WH', 'ITSTW')", [WH]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST waste item', 'PCS', 10, 100)", [ITEM]);
  // warehouse_stock.id is NOT NULL with no default (not auto-increment).
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,100)', [`WS-${WH}-${ITEM}`, WH, ITEM]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ waste entries ═══');

    const [col] = await db.query("SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waste_entries' AND COLUMN_NAME='idempotency_key'");
    check('migration added waste_entries.idempotency_key (additive/nullable)', col.length === 1 && col[0].IS_NULLABLE === 'YES', col[0]);
    const [idx] = await db.query("SELECT COUNT(*) c FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='waste_entries' AND INDEX_NAME='uq_waste_idem'");
    check('unique index uq_waste_idem exists (what makes the race safe)', Number(idx[0].c) > 0);

    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('users authenticate', !!cashier && !!manager);

    // ── permissions ──
    const denied = await call('POST', '/api/erp/waste-entries', cashier, payload());
    check('cashier is DENIED creating waste (it posts GL + moves stock)', denied.status === 403, { status: denied.status });
    check('stock untouched by the denied attempt', (await stockOf()) === 100, await stockOf());

    // ── server-side validation (was browser-only) ──
    const neg = await call('POST', '/api/erp/waste-entries', manager, payload({ items: [{ itemId: ITEM, quantity: -5, unit: 'PCS', unitCost: 10 }] }));
    check('a NEGATIVE qty is refused (it would have INCREMENTED stock)', neg.body && neg.body.success === false, neg.body);
    const zero = await call('POST', '/api/erp/waste-entries', manager, payload({ items: [{ itemId: ITEM, quantity: 0, unit: 'PCS', unitCost: 10 }] }));
    check('a ZERO qty is refused', zero.body && zero.body.success === false, zero.body);
    const nan = await call('POST', '/api/erp/waste-entries', manager, payload({ items: [{ itemId: ITEM, quantity: 'abc', unit: 'PCS', unitCost: 10 }] }));
    check('a non-numeric qty is refused, not coerced to 0', nan.body && nan.body.success === false, nan.body);
    const badReason = await call('POST', '/api/erp/waste-entries', manager, payload({ reason: 'because' }));
    check('an invalid reason is refused', badReason.body && badReason.body.success === false, badReason.body);
    check('stock STILL untouched after every invalid attempt', (await stockOf()) === 100, await stockOf());
    check('no waste entry was created by any invalid attempt', (await wasteCount()) === 0);

    // ── the happy path: deducts EXACTLY once ──
    const jBefore = await journalCount();
    const ok = await call('POST', '/api/erp/waste-entries', manager, payload());
    check('manager CAN create waste', ok.body && ok.body.success === true, ok.body);
    check('the response returns the document number (was generated but never returned)',
      ok.body && typeof ok.body.wasteNumber === 'string' && ok.body.wasteNumber.length > 0, ok.body && ok.body.wasteNumber);
    check('stock deducted EXACTLY once: 100 − 3 = 97', (await stockOf()) === 97, await stockOf());
    check('a GL journal was posted', (await journalCount()) === jBefore + 1, { before: jBefore, after: await journalCount() });

    const [mv] = await db.query("SELECT item_name, qty, type, username FROM inventory_movements WHERE warehouse_id=? AND reference_id=?", [WH, ok.body.id]);
    check('an inventory movement was written', mv.length === 1, mv);
    check('the movement carries the ITEM NAME (was always empty — it read an unsent field)',
      mv.length === 1 && mv[0].item_name === 'ITEST waste item', mv[0]);
    check('the movement actor is the authenticated user', mv.length === 1 && mv[0].username === MANAGER, mv[0]);

    const [hdr] = await db.query('SELECT created_by FROM waste_entries WHERE id=?', [ok.body.id]);
    check('created_by is the TOKEN user', hdr[0].created_by === MANAGER, hdr[0]);

    // actor cannot be spoofed via the body
    const spoof = await call('POST', '/api/erp/waste-entries', manager, payload({ createdBy: 'someone_else' }));
    check('a spoofed createdBy in the body is ignored', spoof.body && spoof.body.success === true, spoof.body);
    const [hdr2] = await db.query('SELECT created_by FROM waste_entries WHERE id=?', [spoof.body.id]);
    check('…the real token user is recorded instead', hdr2[0].created_by === MANAGER, hdr2[0]);
    check('stock now 97 − 3 = 94', (await stockOf()) === 94, await stockOf());

    // ── idempotency: the double-POST that used to deduct twice ──
    const key = 'itest-waste-idem-1';
    const first = await call('POST', '/api/erp/waste-entries', manager, payload(), { 'X-Idempotency-Key': key });
    check('first keyed POST succeeds', first.body && first.body.success === true, first.body);
    const stockAfterFirst = await stockOf();
    const countAfterFirst = await wasteCount();
    const replay = await call('POST', '/api/erp/waste-entries', manager, payload(), { 'X-Idempotency-Key': key });
    check('the REPLAY returns the original entry rather than creating a second',
      replay.body && replay.body.success === true && replay.body.id === first.body.id && replay.body.replayed === true, replay.body);
    check('the replay did NOT deduct stock again (was a double-deduct)', (await stockOf()) === stockAfterFirst, { was: stockAfterFirst, now: await stockOf() });
    check('the replay did NOT create a second entry', (await wasteCount()) === countAfterFirst);

    // ── period lock (waste posts to the GL, so it must respect it) ──
    await db.query(
      "INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status) VALUES (?,'ITEST W','ITEST W','2029-06-01','2029-06-30','closed')",
      [PERIOD]);
    const stockBeforeLock = await stockOf();
    const locked = await call('POST', '/api/erp/waste-entries', manager, payload());
    check('waste into a CLOSED period is refused (the lock was never checked here)',
      locked.body && locked.body.success === false && /مُقفلة/.test(locked.body.error || ''), locked.body);
    check('…and stock did not move', (await stockOf()) === stockBeforeLock, await stockOf());

    // a soft-closed period must block it too (the enum gap fixed in da47ca5)
    await db.query("UPDATE accounting_periods SET status='soft_closed' WHERE id=?", [PERIOD]);
    const soft = await call('POST', '/api/erp/waste-entries', manager, payload());
    check('waste into a SOFT-closed period is refused too', soft.body && soft.body.success === false, soft.body);
    await db.query('DELETE FROM accounting_periods WHERE id=?', [PERIOD]);

    // ── rollback: a bad item id must leave NOTHING behind ──
    const countBefore = await wasteCount();
    const stockBefore = await stockOf();
    const jb = await journalCount();
    const bad = await call('POST', '/api/erp/waste-entries', manager, payload({
      items: [{ itemId: ITEM, quantity: 2, unit: 'PCS', unitCost: 10 }, { itemId: 'NO-SUCH-ITEM-XYZ', quantity: 2, unit: 'PCS', unitCost: 10 }],
    }));
    check('a line with an unknown item fails the whole entry', bad.body && bad.body.success === false, { status: bad.status, body: bad.body });
    check('ROLLBACK: no partial entry was left behind', (await wasteCount()) === countBefore, { before: countBefore, after: await wasteCount() });
    check('ROLLBACK: the good line did NOT deduct stock', (await stockOf()) === stockBefore, { before: stockBefore, after: await stockOf() });
    check('ROLLBACK: no GL journal was posted', (await journalCount()) === jb);

    // ── the delete reverses cleanly ──
    const target = first.body.id;
    const stockBeforeDel = await stockOf();
    const del = await call('DELETE', `/api/erp/waste-entries/${target}`, manager);
    check('delete reverses the entry', del.body && del.body.success === true, del.body);
    check('…and restores the stock it deducted (+3)', (await stockOf()) === stockBeforeDel + 3, { before: stockBeforeDel, now: await stockOf() });

    // ── the list exposes the document number ──
    const list = await call('GET', '/api/erp/waste-entries?limit=50', manager);
    const rows = (list.body && (list.body.items || list.body)) || [];
    const mine = Array.isArray(rows) ? rows.find((r) => r.id === spoof.body.id) : null;
    check('the list returns wasteNumber (was stored but never mapped)', !!mine && typeof mine.wasteNumber === 'string' && mine.wasteNumber.length > 0, mine && mine.wasteNumber);

    console.log(`\n${fail === 0 ? '✅' : '❌'} wasteEntries: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
