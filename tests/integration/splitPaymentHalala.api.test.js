'use strict';
/* Integration — split payments keep their HALALAS all the way to the shift
 * reconciliation, live through the real server + DB.
 *
 * THE DEFECT (W0-A #2): routes/sales.js built the `sales.payment_method` split
 * string with `Math.round(v)` per leg, so a 50.40 cash + 30.10 card sale was
 * STORED as "كاش:50/شبكة:30". Every shift reader (aggregateShiftPayments,
 * /closing-data-v3, POST /close, the full report) parses that string back, so
 * the cashier was told to expect 80 against a total_final of 80.50 — a 0.50
 * drawer variance that no one could explain, on EVERY split sale with a
 * fractional leg.
 *
 * THE FIX: the writer emits 2-decimal legs; every shift reader goes through one
 * halala-safe parser (_parseSplitLegs) that reads decimals, tolerates the bare
 * integers already in the database, and rounds each accumulation to 2 dp.
 *
 * What this suite proves:
 *   (a) a decimal split sale STORES "…:50.40/…:30.10" (not ":50/:30");
 *   (b) GET /shifts/closing-data-v3 — the grid the cashier reconciles against —
 *       returns expectedTotal 80.50, split 50.40 / 30.10 per method, unmatched 0;
 *   (c) GET /shifts/:id/full-report (aggregateShiftPayments) agrees to the halala;
 *   (d) expectedTotal EQUALS the sale's total_final exactly (the money identity
 *       the whole defect broke);
 *   (e) BACK-COMPAT — a pre-existing row stored as "…:50/…:30" still parses to
 *       exactly 50 and 30 (old rows keep working);
 *   (f) the V5.7.14 rule survives: a method NAMED "شبكة/مدى …" (a '/' but no
 *       ':') is still credited as ONE method for the full total, never split;
 *   (g) POST /shifts/close records theoretical_cash 50.40 / card 30.10 /
 *       total 80.50 (the legacy literal cash/card matcher, same parser).
 *
 * Fixtures: ITEST-SPH-* prefixed; cleanup runs before AND in finally.
 * PORT 3986. Run: node tests/integration/splitPaymentHalala.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3986;
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-SPH-${SFX}-${s}`;
const ADMIN = 'w0a_sph_admin';
const MENU1 = P('M1');
const SH_NEW = P('SH-NEW');     // decimal split written by the fixed writer
const SH_OLD = P('SH-OLD');     // legacy integer row, inserted directly
const SH_SLASH = P('SH-SLASH'); // method NAME containing '/'
const SH_CLOSE = P('SH-CLOSE'); // literal cash/card legs → POST /close
// Unique Arabic labels: deterministic matching on any DB, and they still fold
// into the cash/electronic groups. No '/' or '-' inside (the name_ar tokenizer
// splits on those) — except the deliberately slash-named method below.
const CASH_AR = `كاش هللة ${SFX}`;
const CARD_AR = `شبكة هللة ${SFX}`;
const SLASH_AR = `شبكة/مدى ${SFX}`;

const PRICE = 80.50;     // tax-INCLUSIVE → the recorded total is exactly this
const LEG_CASH = 50.40;
const LEG_CARD = 30.10;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 320) : ''); }
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c));
      s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.setTimeout(20000, () => { r.destroy(); res({ status: 0 }); });
    if (d) r.write(d); r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 300; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
const tok = (id) => jwt.sign({ id, username: ADMIN, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const refType of ['Sale', 'ChannelCommission']) {
    const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type=? AND reference_id LIKE 'ITEST-SPH-%'", [refType]).catch(() => [[]]);
    for (const j of js) {
      await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]);
      await del('DELETE FROM gl_journals WHERE id=?', [j.id]);
    }
  }
  const [docs] = await db.query("SELECT id FROM ar_documents WHERE source_type='pos' AND source_id LIKE 'ITEST-SPH-%'").catch(() => [[]]);
  for (const d of docs) {
    await del('DELETE FROM ar_document_line_components WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_document_lines WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE entity_id=?', [d.id]);
    await del('DELETE FROM analytics_modifier_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM analytics_order_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_documents WHERE id=?', [d.id]);
  }
  await del("DELETE FROM analytics_payment_facts WHERE source_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM analytics_order_facts WHERE sale_id LIKE 'ITEST-SPH-%' OR document_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM analytics_till_facts WHERE source_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM zatca_submission_queue WHERE doc_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM audit_logs WHERE entity_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM sales_items WHERE order_id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM menu WHERE id LIKE 'ITEST-SPH-%'");
  await del("DELETE FROM payment_methods WHERE name LIKE 'ITEST-SPH-%'");
  await del('DELETE FROM users WHERE username=?', [ADMIN]);
}

async function fixtures() {
  await db.query("INSERT INTO users (username,password,role,active) VALUES (?,'disabled','admin',1)", [ADMIN]);
  const [u] = await db.query('SELECT id FROM users WHERE username=?', [ADMIN]);
  for (const s of [SH_NEW, SH_OLD, SH_SLASH, SH_CLOSE]) {
    await db.query("INSERT INTO shifts (id, username, status, start_time, opening_float) VALUES (?,?,'OPEN',NOW(),0)", [s, ADMIN]);
  }
  // Tax-INCLUSIVE so the server-recomputed total is exactly PRICE — this suite
  // is about the payment string, not about the tax split.
  await db.query('INSERT INTO menu (id, name, price, cost, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,?,1)',
    [MENU1, P('Couscous'), PRICE, 10, 'S']);
  const mk = (name, nameAr, group) => db.query(
    'INSERT INTO payment_methods (name, name_ar, is_active, group_type) VALUES (?,?,1,?)', [name, nameAr, group]);
  await mk(P('CASH'), CASH_AR, 'cash');
  await mk(P('CARD'), CARD_AR, 'electronic');
  await mk(P('SLASH'), SLASH_AR, 'electronic');
  const [pm] = await db.query("SELECT id, name, name_ar FROM payment_methods WHERE name LIKE 'ITEST-SPH-%'");
  const byAr = {}; pm.forEach((m) => { byAr[m.name_ar] = String(m.id); });
  return { adminId: u[0].id, cashId: byAr[CASH_AR], cardId: byAr[CARD_AR], slashId: byAr[SLASH_AR] };
}

const line = () => [{ id: MENU1, name: 'ITEST SPH Couscous', qty: 1, price: PRICE, lineDiscount: 0, baseQty: 1 }];

(async () => {
  await cleanup();
  const ids = await fixtures();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const admin = tok(ids.adminId);

  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }

    // ── (a) the writer keeps the halalas ────────────────────────────────────
    console.log('\n▶ WRITE — sales.payment_method carries 2 decimals');
    const sale = await call('POST', '/api/sales', admin, {
      clientOrderId: P('CO-1'), shiftId: SH_NEW, items: line(),
      total: PRICE, totalFinal: PRICE, discountAmount: 0, lineDiscountTotal: 0,
      paymentMethod: 'split',
      splitDetails: [{ method: CASH_AR, amount: LEG_CASH }, { method: CARD_AR, amount: LEG_CARD }],
    });
    check('POST /api/sales (decimal split) → 200', sale.status === 200 && sale.body && sale.body.success === true, { status: sale.status, body: sale.body });
    const saleId = sale.body && sale.body.orderId;
    const [rows] = await db.query('SELECT payment_method, total_final FROM sales WHERE id=? LIMIT 1', [saleId]);
    check('total_final is 80.50', rows.length === 1 && r2(rows[0].total_final) === PRICE, rows[0]);
    check(`payment_method stores the halalas: "${CASH_AR}:50.40/${CARD_AR}:30.10"`,
      rows.length === 1 && rows[0].payment_method === `${CASH_AR}:${LEG_CASH.toFixed(2)}/${CARD_AR}:${LEG_CARD.toFixed(2)}`,
      rows[0] && rows[0].payment_method);
    check('…and NOT the old rounded "…:50/…:30"',
      rows.length === 1 && rows[0].payment_method !== `${CASH_AR}:50/${CARD_AR}:30`, rows[0] && rows[0].payment_method);

    // ── (b)+(d) the reconciliation grid ─────────────────────────────────────
    console.log('\n▶ READ — GET /shifts/closing-data-v3 (the grid the cashier signs)');
    const cd = await call('GET', `/api/shifts/closing-data-v3/${SH_NEW}`, admin);
    check('closing-data-v3 → 200', cd.status === 200, { status: cd.status, body: cd.body });
    const exp = (cd.body && cd.body.expected && cd.body) || {};
    check('expectedTotal is 80.50 (NOT 80)', r2(cd.body && cd.body.expectedTotal) === PRICE, cd.body && cd.body.expectedTotal);
    check('THE MONEY IDENTITY: expectedTotal === the sale total, to the halala',
      r2(cd.body && cd.body.expectedTotal) === r2(rows[0].total_final), { expected: cd.body && cd.body.expectedTotal, total: rows[0] && rows[0].total_final });
    const byId = (cd.body && cd.body.methods) || [];
    const mCash = byId.find((m) => String(m.id) === ids.cashId);
    const mCard = byId.find((m) => String(m.id) === ids.cardId);
    check('cash leg lands as 50.40 on the cash method', !!mCash && r2(mCash.expectedAmount) === LEG_CASH, mCash);
    check('card leg lands as 30.10 on the card method', !!mCard && r2(mCard.expectedAmount) === LEG_CARD, mCard);
    check('nothing fell into the unmatched bucket', r2(cd.body && cd.body.unmatchedTotal) === 0, cd.body && cd.body.unmatchedTotal);
    void exp;

    // ── (c) aggregateShiftPayments (close-time + printed report) ────────────
    console.log('\n▶ READ — GET /shifts/:id/full-report (aggregateShiftPayments)');
    const fr = await call('GET', `/api/shifts/${SH_NEW}/full-report`, admin);
    check('full-report → 200', fr.status === 200, { status: fr.status, body: fr.body && fr.body.error });
    check('full-report expectedTotal is 80.50 (agrees with the grid to the halala)',
      r2(fr.body && fr.body.financials && fr.body.financials.expectedTotal) === PRICE,
      fr.body && fr.body.financials);
    const frCash = ((fr.body && fr.body.methods) || []).find((m) => String(m.id) === ids.cashId);
    check('full-report cash expected is 50.40', !!frCash && r2(frCash.expected) === LEG_CASH, frCash);

    // ── (e) BACK-COMPAT: a pre-fix integer row still reads the same ─────────
    console.log('\n▶ BACK-COMPAT — rows already in the database');
    await db.query(
      "INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, zatca_type) " +
      "VALUES (?, NOW(), '[]', ?, ?, ?, ?, 'simplified')",
      [P('OLD-1'), 80, `${CASH_AR}:50/${CARD_AR}:30`, ADMIN, SH_OLD]);
    const cdOld = await call('GET', `/api/shifts/closing-data-v3/${SH_OLD}`, admin);
    check('legacy integer row → expectedTotal exactly 80', r2(cdOld.body && cdOld.body.expectedTotal) === 80, cdOld.body && cdOld.body.expectedTotal);
    const oldCash = ((cdOld.body && cdOld.body.methods) || []).find((m) => String(m.id) === ids.cashId);
    const oldCard = ((cdOld.body && cdOld.body.methods) || []).find((m) => String(m.id) === ids.cardId);
    check('legacy row still credits 50 / 30 to the same two methods',
      !!oldCash && r2(oldCash.expectedAmount) === 50 && !!oldCard && r2(oldCard.expectedAmount) === 30, { oldCash, oldCard });

    // ── (f) the V5.7.14 rule: '/' in a NAME is not a split ──────────────────
    console.log('\n▶ NOT-A-SPLIT — a method NAMED with a slash');
    await db.query(
      "INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, zatca_type) " +
      "VALUES (?, NOW(), '[]', ?, ?, ?, ?, 'simplified')",
      [P('SLASH-1'), 77.25, SLASH_AR, ADMIN, SH_SLASH]);
    const cdSlash = await call('GET', `/api/shifts/closing-data-v3/${SH_SLASH}`, admin);
    const slashM = ((cdSlash.body && cdSlash.body.methods) || []).find((m) => String(m.id) === ids.slashId);
    check('a name containing "/" but no ":" is ONE method for the full total',
      !!slashM && r2(slashM.expectedAmount) === 77.25, { slashM, expectedTotal: cdSlash.body && cdSlash.body.expectedTotal });
    check('…and the shift total is 77.25, not zero', r2(cdSlash.body && cdSlash.body.expectedTotal) === 77.25, cdSlash.body && cdSlash.body.expectedTotal);

    // ── (g) POST /shifts/close — the legacy literal cash/card matcher ───────
    console.log('\n▶ CLOSE — POST /shifts/close theoretical figures');
    const sale2 = await call('POST', '/api/sales', admin, {
      clientOrderId: P('CO-2'), shiftId: SH_CLOSE, items: line(),
      total: PRICE, totalFinal: PRICE, discountAmount: 0, lineDiscountTotal: 0,
      paymentMethod: 'split',
      splitDetails: [{ method: 'cash', amount: LEG_CASH }, { method: 'card', amount: LEG_CARD }],
    });
    check('second split sale (literal cash/card legs) → 200', sale2.status === 200 && sale2.body && sale2.body.success === true, { status: sale2.status, body: sale2.body });
    const closed = await call('POST', '/api/shifts/close', admin, {
      shiftId: SH_CLOSE, actualCash: LEG_CASH, actualCard: LEG_CARD, actualKita: 0 });
    check('POST /shifts/close → 200', closed.status === 200, { status: closed.status, body: closed.body });
    const [sh] = await db.query(
      'SELECT theoretical_cash, theoretical_card, total_theoretical, diff_cash, diff_card FROM shifts WHERE id=?', [SH_CLOSE]);
    check('theoretical_cash is 50.40', sh.length === 1 && r2(sh[0].theoretical_cash) === LEG_CASH, sh[0]);
    check('theoretical_card is 30.10', sh.length === 1 && r2(sh[0].theoretical_card) === LEG_CARD, sh[0]);
    check('total_theoretical is 80.50 (equals the sale total)', sh.length === 1 && r2(sh[0].total_theoretical) === PRICE, sh[0]);
    check('a drawer counted at exactly the legs reconciles to ZERO variance',
      sh.length === 1 && r2(sh[0].diff_cash) === 0 && r2(sh[0].diff_card) === 0, sh[0]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} splitPaymentHalala: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
