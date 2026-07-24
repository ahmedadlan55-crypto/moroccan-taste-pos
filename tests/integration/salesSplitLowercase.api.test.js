'use strict';
/* Integration — lowercase 'split' guard fix (real server + DB).
 *
 * THE DEFECT: the React POS checkout (lib/posOrderMachine.js
 * legacyPaymentFields) posts paymentMethod:'split' (lowercase) with
 * splitDetails as an ARRAY [{method, amount}], while every write-path guard
 * in routes/sales.js compared `paymentMethod === 'Split'` (the legacy UI's
 * casing, whose splitDetails is an OBJECT {label: amount}). Consequence for
 * EVERY React split sale: split_details_json was never persisted,
 * sales.payment_method stored the literal string 'split', and the GL journal
 * collapsed all payment legs into ONE clearing-account debit.
 *
 * What this suite proves, live through POST /api/sales:
 *   (a) a lowercase-'split' sale with the REAL pos-v2 array shape persists
 *       split_details_json with both legs and a leg-joined payment_method
 *       (never the literal 'split');
 *   (b) its GL journal debits one account PER LEG, routed through the
 *       payment_methods.gl_account_id map (two DIFFERENT accounts here —
 *       the suite seeds two ITEST methods mapped to two ITEST GL accounts,
 *       exactly how an owner-configured cash/card method flows);
 *   (c) the legacy uppercase-'Split' object path behaves IDENTICALLY
 *       (no regression);
 *   (d) analytics_payment_facts receives 2 'pos_split' legs for the
 *       lowercase sale (ProjectionService reads the persisted array), with
 *       method_norm folding the Arabic labels into cash/card;
 *   (e) a plain non-split sale still stores paymentMethod VERBATIM (stored
 *       casing behavior unchanged for legacy callers).
 *
 * Fixtures: ITEST-SPL-* prefixed. Sales are created through the live API so
 * they land on TODAY's date (the endpoint stamps NOW()); every assertion is
 * keyed by the sale id, and cleanup runs before AND in finally — zero residue.
 * PORT 3989. Run: node tests/integration/salesSplitLowercase.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3989;
const ADMIN = 'itest_spl_admin';
const PW = 'Spl#Test!2032';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-SPL-${SFX}-${s}`;
const SHIFT = P('SH');
const MENU1 = P('M1');
const GLA = P('GLA'), GLB = P('GLB');
const CODE_A = `IT${SFX}A`, CODE_B = `IT${SFX}B`;   // gl_accounts.code varchar(20)
// The leg labels the React POS actually sends are the methods' Arabic names
// (name_ar) — built-ins are 'كاش'/'شبكة'; owner methods flow as configured.
// Unique-suffixed Arabic labels keep the GL routing deterministic on any DB
// (no collision with real payment_methods rows) while still folding into the
// cash/card analytics buckets. NOTE: no '-' or '/' inside name_ar — the
// pmGlMap builder tokenizes name_ar on those separators.
const CASH_AR = `كاش تجربة ${SFX}`;
const CARD_AR = `شبكة تجربة ${SFX}`;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
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

// The analytics projection runs post-commit fire-and-forget — poll for it.
async function pollFacts(saleId, wantLegs, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const [rows] = await db.query(
        "SELECT source_type, method_norm, direction, amount FROM analytics_payment_facts WHERE source_id = ? ORDER BY line_no",
        [saleId]);
      if (rows.length >= wantLegs) return rows;
    } catch (_) {}
    await new Promise((z) => setTimeout(z, 400));
  }
  return [];
}

async function glDebitsOf(saleId) {
  const [rows] = await db.query(
    `SELECT e.account_code, e.debit FROM gl_entries e
      WHERE e.journal_id IN (SELECT id FROM gl_journals WHERE reference_type = 'Sale' AND reference_id = ?)
        AND e.debit > 0 ORDER BY e.debit DESC`,
    [saleId]);
  return rows.map((r) => ({ code: r.account_code, debit: r2(r.debit) }));
}

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  await del('DELETE FROM users WHERE username=?', [ADMIN]);
  // GL journals the sales posted (generated ids — resolve via reference)
  for (const refType of ['Sale', 'ChannelCommission']) {
    const [js] = await db.query(
      "SELECT id FROM gl_journals WHERE reference_type=? AND reference_id LIKE 'ITEST-SPL-%'", [refType]
    ).catch(() => [[]]);
    for (const j of js) {
      await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]);
      await del('DELETE FROM gl_journals WHERE id=?', [j.id]);
    }
  }
  // O2C projection of the sales (ar_documents keyed by source_id = sale id)
  const [docs] = await db.query(
    "SELECT id FROM ar_documents WHERE source_type='pos' AND source_id LIKE 'ITEST-SPL-%'"
  ).catch(() => [[]]);
  for (const d of docs) {
    await del('DELETE FROM ar_document_line_components WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_document_lines WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE entity_id=?', [d.id]);
    await del('DELETE FROM analytics_modifier_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM analytics_order_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_documents WHERE id=?', [d.id]);
  }
  // Analytics facts (also covers the no-O2C keying where document_id = sale id)
  await del("DELETE FROM analytics_payment_facts WHERE source_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM analytics_order_facts WHERE sale_id LIKE 'ITEST-SPL-%' OR document_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM analytics_till_facts WHERE source_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM zatca_submission_queue WHERE doc_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM audit_log WHERE record_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM audit_log WHERE entity_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM sales_items WHERE order_id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM menu WHERE id LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM payment_methods WHERE name LIKE 'ITEST-SPL-%'");
  await del("DELETE FROM gl_accounts WHERE id LIKE 'ITEST-SPL-%'");
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SHIFT, ADMIN]);
  await db.query('INSERT INTO menu (id, name, price, cost, active) VALUES (?,?,?,?,1)', [MENU1, P('Burger'), 57.5, 10.0]);
  // Two postable leaf GL accounts (same predicate reportsEquations uses)
  const acc = (id, code, nameAr) => db.query(
    `INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, account_class, report_section)
     VALUES (?, ?, ?, ?, 'asset', NULL, 1, 1, 0, 'detail', NULL)`,
    [id, code, nameAr, nameAr]);
  await acc(GLA, CODE_A, 'ITEST صندوق تجزئة');
  await acc(GLB, CODE_B, 'ITEST شبكة تجزئة');
  // Two payment methods mapped to those accounts — the pmGlMap route.
  const [pm1] = await db.query(
    "INSERT INTO payment_methods (name, name_ar, is_active, group_type, gl_account_id) VALUES (?,?,1,'cash',?)",
    [P('CASH'), CASH_AR, GLA]);
  const [pm2] = await db.query(
    "INSERT INTO payment_methods (name, name_ar, is_active, group_type, gl_account_id) VALUES (?,?,1,'electronic',?)",
    [P('CARD'), CARD_AR, GLB]);
  return { pmCashId: pm1.insertId, pmCardId: pm2.insertId };
}

(async () => {
  await cleanup();
  const ids = await fixtures();

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);

    const items = [{ id: MENU1, name: 'ITEST SPL Burger', qty: 2, price: 57.5, lineDiscount: 0, baseQty: 2 }];

    // ── (a)+(b) lowercase 'split' — the EXACT React POS legacyPayload shape ──
    console.log('\n▶ lowercase split (pos-v2 array shape)');
    const resA = await call('POST', '/api/sales', admin, {
      clientOrderId: P('CO-A'),
      shiftId: SHIFT,
      items,
      total: 115, totalFinal: 115,
      discountAmount: 0, lineDiscountTotal: 0,
      paymentMethod: 'split',                                    // ← lowercase, as the React POS sends
      splitDetails: [                                             // ← ARRAY [{method, amount}] (posOrderMachine.js:164)
        { method: CASH_AR, amount: 80 },
        { method: CARD_AR, amount: 35 },
      ],
      // Structured payments ride ALONGSIDE (O2C contract) — same as the real payload.
      payments: [
        { method: String(ids.pmCashId), amount: 80 },
        { method: String(ids.pmCardId), amount: 35 },
      ],
      cashTendered: 80, changeDue: 0,
    });
    check('POST /api/sales (lowercase split) answers 200 success', resA.status === 200 && resA.body?.success === true, { status: resA.status, body: resA.body });
    const saleA = resA.body?.orderId;
    check('orderId returned', !!saleA, resA.body);

    const [rowsA] = await db.query('SELECT payment_method, split_details_json, total_final FROM sales WHERE id=? LIMIT 1', [saleA]);
    check('sale row exists with total 115', rowsA.length === 1 && r2(rowsA[0].total_final) === 115, rowsA[0]);
    check('payment_method is the leg-joined string, NOT the literal \'split\'',
      rowsA.length === 1 && rowsA[0].payment_method === `${CASH_AR}:80/${CARD_AR}:35`, rowsA[0]?.payment_method);
    let sdA = null; try { sdA = JSON.parse(rowsA[0]?.split_details_json || 'null'); } catch (_) {}
    check('split_details_json persisted with BOTH legs (array shape kept verbatim)',
      Array.isArray(sdA) && sdA.length === 2
        && sdA.some((l) => l.method === CASH_AR && r2(l.amount) === 80)
        && sdA.some((l) => l.method === CARD_AR && r2(l.amount) === 35), sdA);

    const debitsA = await glDebitsOf(saleA);
    check('GL: exactly 2 payment debit legs (no COGS leg — item has no recipe)', debitsA.length === 2, debitsA);
    check('GL: cash leg 80 debits the cash-mapped account ' + CODE_A,
      debitsA.some((d) => d.code === CODE_A && d.debit === 80), debitsA);
    check('GL: card leg 35 debits the card-mapped account ' + CODE_B,
      debitsA.some((d) => d.code === CODE_B && d.debit === 35), debitsA);
    check('GL: the two legs hit two DIFFERENT accounts (not one clearing account)',
      new Set(debitsA.map((d) => d.code)).size === 2, debitsA);

    // ── (d) analytics_payment_facts sees both legs ────────────────────────
    console.log('\n▶ analytics projection (Wave-1 facts)');
    const factsA = await pollFacts(saleA, 2);
    check('2 payment facts projected for the lowercase sale', factsA.length === 2, factsA);
    check('facts are pos_split / direction in', factsA.every((f) => f.source_type === 'pos_split' && f.direction === 'in'), factsA);
    check('method_norm folds the Arabic labels: cash 80 / card 35',
      factsA.some((f) => f.method_norm === 'cash' && r2(f.amount) === 80)
        && factsA.some((f) => f.method_norm === 'card' && r2(f.amount) === 35), factsA);

    // ── (c) legacy uppercase 'Split' + OBJECT — identical behavior ────────
    console.log('\n▶ legacy uppercase Split (object shape) — no regression');
    const resB = await call('POST', '/api/sales', admin, {
      clientOrderId: P('CO-B'),
      shiftId: SHIFT,
      items,
      total: 115, totalFinal: 115,
      discountAmount: 0, lineDiscountTotal: 0,
      paymentMethod: 'Split',                                    // ← legacy casing
      splitDetails: { [CASH_AR]: 60, [CARD_AR]: 55 },            // ← legacy OBJECT {label: amount}
    });
    check('POST /api/sales (legacy Split) answers 200 success', resB.status === 200 && resB.body?.success === true, { status: resB.status, body: resB.body });
    const saleB = resB.body?.orderId;

    const [rowsB] = await db.query('SELECT payment_method, split_details_json FROM sales WHERE id=? LIMIT 1', [saleB]);
    check('legacy payment_method is the leg-joined string',
      rowsB.length === 1 && rowsB[0].payment_method === `${CASH_AR}:60/${CARD_AR}:55`, rowsB[0]?.payment_method);
    let sdB = null; try { sdB = JSON.parse(rowsB[0]?.split_details_json || 'null'); } catch (_) {}
    check('legacy split_details_json persisted as the OBJECT shape',
      sdB && !Array.isArray(sdB) && r2(sdB[CASH_AR]) === 60 && r2(sdB[CARD_AR]) === 55, sdB);

    const debitsB = await glDebitsOf(saleB);
    check('legacy GL: 2 debit legs → 60@' + CODE_A + ' + 55@' + CODE_B,
      debitsB.length === 2
        && debitsB.some((d) => d.code === CODE_A && d.debit === 60)
        && debitsB.some((d) => d.code === CODE_B && d.debit === 55), debitsB);
    const factsB = await pollFacts(saleB, 2);
    check('legacy sale also projects 2 pos_split facts', factsB.length === 2 && factsB.every((f) => f.source_type === 'pos_split'), factsB);

    // ── (e) non-split sales keep their STORED casing verbatim ─────────────
    console.log('\n▶ non-split flow untouched');
    const resC = await call('POST', '/api/sales', admin, {
      clientOrderId: P('CO-C'),
      shiftId: SHIFT,
      items,
      total: 115, totalFinal: 115,
      paymentMethod: CASH_AR,                                    // single method, no split
    });
    check('single-method sale answers 200', resC.status === 200 && resC.body?.success === true, resC.status);
    const [rowsC] = await db.query('SELECT payment_method, split_details_json FROM sales WHERE id=? LIMIT 1', [resC.body?.orderId]);
    check('payment_method stored VERBATIM (no case normalization of stored values)',
      rowsC.length === 1 && rowsC[0].payment_method === CASH_AR, rowsC[0]?.payment_method);
    check('split_details_json stays NULL for a non-split sale', rowsC.length === 1 && rowsC[0].split_details_json == null, rowsC[0]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} salesSplitLowercase: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
