'use strict';
/* Integration — the MANDATORY no-double-count invoice, driven end-to-end
 * through the REAL checkout (POST /api/sales), never direct SQL:
 *
 *   items: Burger×2 @57.50 (S, incl) + Water×1 @20 (Z) + Combo×1 @69 (S)
 *          with TWO combo choices (cheese + fries) on the combo line,
 *   order discount 15.25 (gross space),
 *   split payment Cash 100 + Mada 88.75.
 *
 * Server math (hand-computed, mirrors routes/sales.js v6.20/v7.3/v8.1 exactly):
 *   grandNet 180, grandVat 24, gross 204
 *   grossAfterDiscount = 204 − 15.25 = 188.75 ; ratio = 188.75/204
 *   netAfterDiscount = round2(180×ratio) = 166.54
 *   vatAfterDiscount = round2(24×ratio)  =  22.21
 *   invTotal = round2(166.54 + 22.21) = 188.75 ; appliedDiscount 15.25 ; qty 4.
 *
 * v8.1 NOTE — this fixture used to expect 189: routes/sales.js rounded the
 * total to a whole SAR (pricing.roundToWhole) and pushed the +0.25 delta onto
 * the net side (net 166.79). That rounding was REMOVED so the owner's property
 * holds — "price before tax + tax = the number on the invoice" (a 16.00 net
 * item must read 16.00 + 2.40 = 18.40, not 18). The exact 2-decimal total is
 * now the product's behaviour, so the hand-computed constants below follow it;
 * the split legs sum to the same 188.75 so payments_in still closes.
 *
 * The checkout writes ar_documents + ar_document_lines eagerly (O2C on) and
 * the post-commit hook projects order + payment + modifier facts. Then the
 * analytics engine must answer IDENTICAL totals for net_ex_vat /
 * invoice_total / payments_in / orders / qty_sold across ≥6 grouping
 * permutations (none / branch / branch+item / item+modifier via the modifier
 * fact / payment_method / hour+cashier), plus a filter-closure check
 * (filtering to one group == that group's row).
 *
 * Fixtures: ITEST-SHN-* (salesHubSeed masters give the branch/menu; its
 * 2032-03 documents are OUTSIDE this suite's query range, so they cannot
 * contaminate the totals). PORT 3982.
 * Run: node tests/integration/analyticsNoDoubleCount.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');

const PORT = 3982;
const PREFIX = 'ITEST-SHN';
const ADMIN = 'itest_shn_admin';
const PW = 'Shn#Test!2032';
const SHIFT_API = `${PREFIX}-SHAPI`;
const CLIENT_ORDER_ID = `${PREFIX}-COID-${Date.now()}`;
let I = null;

// hand-computed expectation for the API-driven invoice
const X = Object.freeze({
  total: 188.75, net: 166.54, vat: 22.21, qty: 4, orders: 1,
  cash: 100, card: 88.75, discount: 15.25, modifierQty: 2,
});

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
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
async function waitUp() {
  for (let i = 0; i < 180; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
const Q = (token, body) => call('POST', '/api/analytics/query', token, Object.assign({ noCache: true }, body));

// query window around "now" (order_date = server now, Riyadh wall-clock)
function range() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const nowRiyadh = Date.now() + 3 * 3600000;
  return { from: iso(nowRiyadh - 3 * 86400000), to: iso(nowRiyadh + 3 * 86400000) };
}

async function cleanupApiArtifacts() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  // facts first (they reference ar_documents ids)
  await del(`DELETE m FROM analytics_modifier_facts m
             JOIN ar_documents d ON d.id = m.document_id
             WHERE d.source_type='pos' AND d.source_id LIKE ?`, [`${PREFIX}-%`]);
  await del('DELETE FROM analytics_payment_facts WHERE source_id LIKE ?', [`${PREFIX}-%`]);
  await del('DELETE FROM analytics_till_facts WHERE source_id LIKE ?', [`${PREFIX}-%`]);
  await del('DELETE FROM analytics_order_facts WHERE sale_id LIKE ?', [`${PREFIX}-%`]);
  await del(`DELETE l FROM ar_document_lines l
             JOIN ar_documents d ON d.id = l.document_id
             WHERE d.source_type='pos' AND d.source_id LIKE ?`, [`${PREFIX}-%`]);
  await del("DELETE FROM ar_documents WHERE source_type='pos' AND source_id LIKE ?", [`${PREFIX}-%`]);
  await del('DELETE FROM sales_items WHERE order_id LIKE ?', [`${PREFIX}-%`]);
  await del('DELETE FROM sales WHERE id LIKE ?', [`${PREFIX}-%`]);
  await del('DELETE FROM users WHERE username = ?', [ADMIN]);
}

(async () => {
  await cleanupApiArtifacts();
  await seedMod.cleanup(db, PREFIX);
  I = await seedMod.seed(db, PREFIX);

  // admin user WITH branch (checkout attributes the sale to the user's branch)
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active,branch_id,brand_id) VALUES (?,?,?,1,?,?)',
    [ADMIN, hash, 'admin', I.B1, I.BRAND]);
  await db.query("INSERT INTO shifts (id, username, status, start_time, branch_id) VALUES (?,?,'OPEN',NOW(),?)",
    [SHIFT_API, ADMIN, I.B1]);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);

    // ── the real checkout ─────────────────────────────────────────────────
    console.log('\n▶ POST /api/sales (combo choices + split + discount + rounding)');
    const sale = await call('POST', '/api/sales', admin, {
      clientOrderId: CLIENT_ORDER_ID,
      shiftId: SHIFT_API,
      warehouseId: I.W1,
      items: [
        { id: I.M1, name: 'ITEST SH Burger', qty: 2, price: 57.5 },
        { id: I.M2, name: 'ITEST SH Water', qty: 1, price: 20 },
        {
          id: I.M3, name: 'ITEST SH Combo', qty: 1, price: 69,
          comboChoices: [{ menuItemId: I.M4 }, { menuItemId: I.M5 }],
        },
      ],
      total: 204,
      totalFinal: X.total,
      discountName: 'itest order discount',
      discountAmount: X.discount,
      paymentMethod: 'Split',
      splitDetails: { Cash: X.cash, Mada: X.card },
    });
    check('checkout succeeded', sale.status === 200 && sale.body?.success === true, sale.body);
    const orderId = sale.body?.orderId || null;
    check('server total = 188.75 (exact 2-decimal total — no whole-SAR rounding)', Number(sale.body?.totals?.total) === X.total, sale.body?.totals);

    // wait for the post-commit projection (fire-and-forget on the pool)
    let fact = null;
    for (let i = 0; i < 20 && !fact; i++) {
      try {
        const [r] = await db.query('SELECT * FROM analytics_order_facts WHERE sale_id = ? LIMIT 1', [orderId]);
        if (r.length) fact = r[0];
      } catch (_) {}
      if (!fact) await new Promise((z) => setTimeout(z, 500));
    }
    check('projection hook wrote the order fact', !!fact, orderId);
    check('order fact carries the branch + discount', !!fact &&
      String(fact.branch_id) === I.B1 && r2(fact.discount_total) === X.discount, fact && { b: fact.branch_id, d: fact.discount_total });
    const [lineRows] = await db.query(
      `SELECT COUNT(*) c, SUM(l.net_amount) net, SUM(l.vat_amount) vat, SUM(l.gross_amount) gross, SUM(l.base_qty) qty
         FROM ar_document_lines l JOIN ar_documents d ON d.id = l.document_id
        WHERE d.source_type='pos' AND d.source_id = ?`, [orderId]);
    check('eager O2C lines: Σnet=166.54 Σvat=22.21 Σgross=188.75 qty=4 (allocation closes)',
      lineRows.length && Number(lineRows[0].c) === 3 && r2(lineRows[0].net) === X.net &&
      r2(lineRows[0].vat) === X.vat && r2(lineRows[0].gross) === X.total && Number(lineRows[0].qty) === X.qty,
      lineRows[0]);

    // ── permutations — totals must be IDENTICAL everywhere ────────────────
    const R = range();
    const branchFilter = { dimension: 'branch', op: 'eq', value: I.B1 };
    const totalsOf = (resp) => resp.body?.data?.totals?.values || {};
    const checkTotals = (name, t, keys) => {
      const expect = { net_ex_vat: X.net, invoice_total: X.total, payments_in: X.total, orders: X.orders, qty_sold: X.qty };
      for (const k of keys) {
        check(`${name}: ${k} = ${expect[k]}`, t[k] === expect[k], t);
      }
    };

    console.log('\n▶ permutation 1 — no grouping');
    const p1 = await Q(admin, {
      metrics: ['net_ex_vat', 'invoice_total', 'payments_in', 'orders', 'qty_sold'],
      dimensions: [], range: R, filters: [branchFilter],
    });
    check('answers 200', p1.status === 200 && p1.body?.success === true, p1.body);
    checkTotals('p1', totalsOf(p1), ['net_ex_vat', 'invoice_total', 'payments_in', 'orders', 'qty_sold']);

    console.log('\n▶ permutation 2 — [branch]');
    const p2 = await Q(admin, {
      metrics: ['net_ex_vat', 'invoice_total', 'payments_in', 'orders', 'qty_sold'],
      dimensions: ['branch'], range: R, filters: [branchFilter],
    });
    checkTotals('p2', totalsOf(p2), ['net_ex_vat', 'invoice_total', 'payments_in', 'orders', 'qty_sold']);
    const p2row = (p2.body?.data?.rows || [])[0];
    check('p2: the single branch row == the totals', !!p2row &&
      p2row.values.net_ex_vat === X.net && p2row.values.orders === 1, p2row);

    console.log('\n▶ permutation 3 — [branch, menu_item] (line-fact metrics)');
    const p3 = await Q(admin, {
      metrics: ['net_ex_vat', 'qty_sold'],
      dimensions: ['branch', 'menu_item'], range: R, filters: [branchFilter],
    });
    checkTotals('p3', totalsOf(p3), ['net_ex_vat', 'qty_sold']);
    const p3rows = p3.body?.data?.rows || [];
    const qtyByItem = {};
    for (const r of p3rows) qtyByItem[r.keys.menu_item] = r.values.qty_sold;
    check('p3: per-item qty 2/1/1 and Σrow nets == total', qtyByItem[I.M1] === 2 &&
      qtyByItem[I.M2] === 1 && qtyByItem[I.M3] === 1 &&
      r2(p3rows.reduce((s, r) => s + r.values.net_ex_vat, 0)) === X.net, qtyByItem);

    console.log('\n▶ permutation 4 — [menu_item] merged with the MODIFIER fact');
    const p4 = await Q(admin, {
      metrics: ['net_ex_vat', 'qty_sold', 'modifier_qty'],
      dimensions: ['menu_item'], range: R, filters: [branchFilter],
    });
    checkTotals('p4', totalsOf(p4), ['net_ex_vat', 'qty_sold']);
    check('p4: modifier_qty total = 2 (cheese + fries combo choices)', totalsOf(p4).modifier_qty === X.modifierQty, totalsOf(p4));
    const comboRow = (p4.body?.data?.rows || []).find((r) => String(r.keys.menu_item) === I.M3);
    check('p4: combo row carries its 2 modifier units (cross-fact key merge)',
      !!comboRow && comboRow.values.modifier_qty === 2, comboRow);

    console.log('\n▶ permutation 5 — [payment_method]');
    const p5 = await Q(admin, {
      metrics: ['payments_in'],
      dimensions: ['payment_method'], range: R, filters: [branchFilter],
    });
    checkTotals('p5', totalsOf(p5), ['payments_in']);
    const p5rows = p5.body?.data?.rows || [];
    const byMethod = {};
    for (const r of p5rows) byMethod[r.keys.payment_method] = r.values.payments_in;
    check('p5: cash 100 + card 88.75 (split legs, normalized buckets)',
      byMethod.cash === X.cash && byMethod.card === X.card, byMethod);

    console.log('\n▶ permutation 6 — [hour, cashier]');
    const p6 = await Q(admin, {
      metrics: ['net_ex_vat', 'invoice_total', 'orders', 'qty_sold'],
      dimensions: ['hour', 'cashier'], range: R, filters: [branchFilter],
    });
    checkTotals('p6', totalsOf(p6), ['net_ex_vat', 'invoice_total', 'orders', 'qty_sold']);
    const p6row = (p6.body?.data?.rows || [])[0];
    check('p6: the row is attributed to the authenticated cashier', !!p6row && p6row.keys.cashier === ADMIN, p6row);

    console.log('\n▶ filter closure — filter to one group == that group\'s row');
    const m1row = p3rows.find((r) => String(r.keys.menu_item) === I.M1);
    const fc = await Q(admin, {
      metrics: ['net_ex_vat', 'qty_sold'], dimensions: [], range: R,
      filters: [branchFilter, { dimension: 'menu_item', op: 'eq', value: I.M1 }],
    });
    const fct = totalsOf(fc);
    check('filtered totals == the Burger row from the grouped query', !!m1row &&
      fct.net_ex_vat === m1row.values.net_ex_vat && fct.qty_sold === m1row.values.qty_sold,
      { filtered: fct, row: m1row && m1row.values });

    console.log('\n▶ discount recorded once');
    const pd = await Q(admin, {
      metrics: ['discounts_total', 'discounted_orders'], dimensions: [], range: R, filters: [branchFilter],
    });
    check('discounts_total 15.25 / discounted_orders 1', totalsOf(pd).discounts_total === X.discount &&
      totalsOf(pd).discounted_orders === 1, totalsOf(pd));

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsNoDoubleCount: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanupApiArtifacts();
    await seedMod.cleanup(db, PREFIX);
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
