/**
 * tests/fixtures/salesHubSeed.js — DIRECT-SQL fixture set for the Unified
 * Sales Analytics integration suites.
 *
 * Window: 2032-03 (plus one prior-window doc in 2032-02 for compare tests) —
 * far-future and disjoint from every other suite's window (reportsEquations
 * uses 2031-03/2031-07), so exact-value asserts can never collide with real
 * rows or other suites' residue.
 *
 * Two test branches:
 *   B1 — Asia/Riyadh,  day_close 04:00
 *   B2 — Africa/Cairo, day_close 04:00
 *
 * Fixtures (ids all `${prefix}-...`; every value below is HAND-COMPUTED and
 * exported via EXPECTED — tests assert against these constants, never against
 * "whatever the engine returned"):
 *   F1  mixed invoice D1 (B1, bd 03-10): 3 lines, line discount 10 + order
 *       discount 5.75 (total 15.75), S+Z VAT, paid modifier (+3.00 cheese) +
 *       free combo choice (fries), split cash 104 + card 100 = 204.
 *   F3  partial return w/ restock: D3 (B1, bd 03-11, 230) → R3/CN3 posted,
 *       CN dated the LATER day 03-12, 1 of 2 units (115), refund ar_reduction.
 *   F4  full return no-restock: D4 (B2, bd 03-11, 90, zero-rated) → R4/CN4
 *       on 03-13, refund ar_reduction.
 *   F5  voided-before-payment order D5 (B1, bd 03-10, 57.50): NO payment
 *       facts, order-fact status 'voided' — default queries must not see it.
 *   F7  midnight-crossing shift SH7 (B1): D7A at 21:00 (115) and D7B at
 *       01:30 the next calendar day (230) — BOTH business_day 03-15 (04:00
 *       close); calendar_day differs. Till open_float 300 / close_count 800.
 *   F8  same UTC instant 2032-03-20T01:30:00Z in both branches:
 *       B1 local 04:30 → business_day 03-20; B2 local 03:30 → 03-19.
 *   F14 cash refund: D14 (B1, bd 03-13, 57.50 cash) fully returned 03-14,
 *       refund_method cash → payment fact direction 'out' + till cash_refund.
 *   F1P prior-window doc (B1, bd 2032-02-10, 103.50) for compare/prevPeriod.
 *
 * Credit notes get ar_document_lines rows with POSITIVE amounts (mirroring
 * SalesReturnService.post) and their own analytics_order_facts rows
 * (mirroring ProjectionService.projectReturn) — that is exactly the shape
 * the planner's excluded_credit_note_docs default exists to neutralize, and
 * the no-double-count assertions depend on these rows being present.
 *
 * seed(db, prefix) applies the analytics schema first (idempotent) so the
 * fixture works on a DB the new server has never booted on.
 * cleanup(db, prefix) deletes by prefix from EVERY touched table; call it
 * before seeding AND in finally.
 */
'use strict';

const analyticsSchema = require('../../db/migrations/analytics/schema');

// ── hand-computed expectations (window 2032-03-01..2032-03-31, default
//    filters: voided + credit-note docs excluded) ─────────────────────────────
const EXPECTED = Object.freeze({
  // grand totals across both branches
  TOTAL: Object.freeze({
    orders: 8,                    // D1 D3 D4 D7A D7B D8A D8B D14 (D5 voided out)
    invoice_total: 1071.5,        // 204+230+90+115+230+115+30+57.5
    net_ex_vat: 950,              // 180+200+90+100+200+100+30+50
    vat_amount: 121.5,            // 24+30+0+15+30+15+0+7.5
    qty_sold: 15,                 // 4+2+3+1+2+1+1+1
    cogs: 365,                    // 70+80+15+40+90+40+10+20
    discounts_total: 15.75,       // D1 only
    discounted_orders: 1,
    guests: 3,                    // D1 only
    payments_in: 1071.5,
    refunds_out: 262.5,           // 115+90+57.5
    returns_net: 240,             // 100+90+50
    returns_value: 262.5,         // 115+90+57.5 (gross)
    qty_returned: 5,              // 1+3+1
    returns_count: 3,
    modifier_lines: 2,
    modifier_qty: 2,
    avg_ticket: 118.75,           // round2(950/8)
    net_incl_vat: 1071.5,         // 950+121.5
    qty_net: 10,                  // 15-5
  }),
  B1: Object.freeze({
    orders: 6, invoice_total: 951.5, net_ex_vat: 830, vat_amount: 121.5,
    qty_sold: 11, cogs: 340, payments_in: 951.5, refunds_out: 172.5,
  }),
  B2: Object.freeze({
    orders: 2, invoice_total: 120, net_ex_vat: 120, vat_amount: 0,
    qty_sold: 4, cogs: 25, payments_in: 120, refunds_out: 90,
  }),
  // net_ex_vat by day — B1
  BD_B1: Object.freeze({
    '2032-03-10': 180, '2032-03-11': 200, '2032-03-13': 50,
    '2032-03-15': 300, '2032-03-20': 100,
  }),
  CAL_B1: Object.freeze({
    '2032-03-10': 180, '2032-03-11': 200, '2032-03-13': 50,
    '2032-03-15': 100, '2032-03-16': 200, '2032-03-20': 100,
  }),
  BD_B2: Object.freeze({ '2032-03-11': 90, '2032-03-19': 30 }),
  CAL_B2: Object.freeze({ '2032-03-11': 90, '2032-03-20': 30 }),
  BD_ALL: Object.freeze({
    '2032-03-10': 180, '2032-03-11': 290, '2032-03-13': 50,
    '2032-03-15': 300, '2032-03-19': 30, '2032-03-20': 100,
  }),
  PAY_IN: Object.freeze({ cash: 511.5, card: 560 }),   // 104+90+115+115+30+57.5 / 100+230+230
  PAY_OUT: Object.freeze({ cash: 57.5, other: 205 }),  // F14 / R3 115 + R4 90
  MEAL: Object.freeze({ lunch: 520, dinner: 430 }),    // 180+200+90+50 / 100+200+100+30
  VOIDS: Object.freeze({ count: 1, value: 57.5 }),
  PREV: Object.freeze({ net_ex_vat: 90, orders: 1, invoice_total: 103.5, growthNetPct: 955.56 }),
  F1: Object.freeze({
    net: 180, vat: 24, total: 204, qty: 4, discount: 15.75,
    cash: 104, card: 100, split_sum: 204,
  }),
  F7: Object.freeze({ businessDay: '2032-03-15', calA: '2032-03-15', calB: '2032-03-16', netA: 100, netB: 200 }),
  F8: Object.freeze({
    utcInstant: '2032-03-20T01:30:00Z',
    b1Local: '2032-03-20 04:30:00', b1Day: '2032-03-20', b1Net: 100,
    b2Local: '2032-03-20 03:30:00', b2Day: '2032-03-19', b2Net: 30,
  }),
  F14: Object.freeze({ refund: 57.5, method: 'cash', day: '2032-03-14' }),
  RANGE: Object.freeze({ from: '2032-03-01', to: '2032-03-31' }),
});

function ids(prefix) {
  const P = (s) => `${prefix}-${s}`;
  return {
    BRAND: P('BRAND'), B1: P('B1'), B2: P('B2'), W1: P('W1'), W2: P('W2'),
    M1: P('M1'), M2: P('M2'), M3: P('M3'), M4: P('M4'), M5: P('M5'),
    SH1: P('SH1'), SH7: P('SH7'),
    S1: P('S1'), S3: P('S3'), S4: P('S4'), S5: P('S5'),
    S7A: P('S7A'), S7B: P('S7B'), S8A: P('S8A'), S8B: P('S8B'),
    S14: P('S14'), S1P: P('S1P'),
    D1: P('D1'), D3: P('D3'), D4: P('D4'), D5: P('D5'),
    D7A: P('D7A'), D7B: P('D7B'), D8A: P('D8A'), D8B: P('D8B'),
    D14: P('D14'), D1P: P('D1P'),
    CN3: P('CN3'), CN4: P('CN4'), CN14: P('CN14'),
    R3: P('R3'), R4: P('R4'), R14: P('R14'),
    C1: P('c1'), C2: P('c2'),
  };
}

async function cleanup(db, prefix = 'ITEST-SH') {
  const like = `${prefix}-%`;
  const del = async (sql) => { try { await db.query(sql, [like]); } catch (_) {} };
  await del('DELETE FROM analytics_modifier_facts WHERE document_id LIKE ?');
  await del('DELETE FROM analytics_payment_facts WHERE source_id LIKE ?');
  await del('DELETE FROM analytics_payment_facts WHERE document_id LIKE ?');
  await del('DELETE FROM analytics_till_facts WHERE source_id LIKE ?');
  await del('DELETE FROM analytics_order_facts WHERE document_id LIKE ?');
  await del('DELETE FROM analytics_rollup_dirty WHERE branch_id LIKE ?');
  await del('DELETE FROM ar_document_lines WHERE document_id LIKE ?');
  await del('DELETE FROM ar_documents WHERE id LIKE ?');
  await del('DELETE FROM sales_return_lines WHERE return_id LIKE ?');
  await del('DELETE FROM sales_returns WHERE id LIKE ?');
  await del('DELETE FROM sales WHERE id LIKE ?');
  await del('DELETE FROM shifts WHERE id LIKE ?');
  await del('DELETE FROM menu WHERE id LIKE ?');
  await del('DELETE FROM user_warehouse_access WHERE warehouse_id LIKE ?');
  await del('DELETE FROM warehouses WHERE id LIKE ?');
  await del('DELETE FROM branches WHERE id LIKE ?');
  await del('DELETE FROM brands WHERE id LIKE ?');
}

async function seed(db, prefix = 'ITEST-SH') {
  // The seed writes fact tables + branch tz columns — make sure they exist
  // even on a DB the new server build has never booted on. Idempotent.
  await analyticsSchema.apply(db);

  const I = ids(prefix);

  // ── masters ───────────────────────────────────────────────────────────────
  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [I.BRAND, 'ITEST SalesHub Brand']);
  await db.query(
    "INSERT INTO branches (id, name, brand_id, timezone, day_close_time) VALUES (?,?,?,?,?)",
    [I.B1, 'ITEST SH Riyadh', I.BRAND, 'Asia/Riyadh', '04:00:00']);
  await db.query(
    "INSERT INTO branches (id, name, brand_id, timezone, day_close_time) VALUES (?,?,?,?,?)",
    [I.B2, 'ITEST SH Cairo', I.BRAND, 'Africa/Cairo', '04:00:00']);
  await db.query(
    "INSERT INTO warehouses (id, code, name, type, branch_id) VALUES (?,?,?,'branch',?)",
    [I.W1, prefix.slice(-6) + 'W1', 'ITEST SH WH Riyadh', I.B1]);
  await db.query(
    "INSERT INTO warehouses (id, code, name, type, branch_id) VALUES (?,?,?,'branch',?)",
    [I.W2, prefix.slice(-6) + 'W2', 'ITEST SH WH Cairo', I.B2]);

  const menu = (id, name, price, cost, cat) => db.query(
    'INSERT INTO menu (id, name, price, cost, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,?,1)',
    [id, name, price, cost, cat]);
  await menu(I.M1, 'ITEST SH Burger', 57.5, 10, 'S');
  await menu(I.M2, 'ITEST SH Water', 20, 2, 'Z');
  await menu(I.M3, 'ITEST SH Combo', 69, 5, 'S');
  await menu(I.M4, 'ITEST SH Cheese', 3, 1.5, 'S');
  await menu(I.M5, 'ITEST SH Fries', 8, 1, 'S');

  await db.query(
    "INSERT INTO shifts (id, username, status, start_time, end_time, branch_id, opening_float, actual_cash) VALUES (?,?,'closed',?,?,?,?,?)",
    [I.SH1, I.C1, '2032-03-10 08:00:00', '2032-03-10 23:00:00', I.B1, 500, 604]);
  await db.query(
    "INSERT INTO shifts (id, username, status, start_time, end_time, branch_id, opening_float, actual_cash) VALUES (?,?,'closed',?,?,?,?,?)",
    [I.SH7, I.C1, '2032-03-15 18:00:00', '2032-03-16 02:00:00', I.B1, 300, 800]);

  // ── insert helpers ────────────────────────────────────────────────────────
  const sale = (id, when, total, method, extra = {}) => db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id,
                        brand_id, branch_id, zatca_type, split_details_json, has_credit_note, discount_amount)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, when, total, method, extra.user || I.C1, extra.shift || null, I.BRAND,
     extra.branch || I.B1, extra.zatca || 'simplified', extra.split || null,
     extra.hasCn ? 1 : 0, extra.discount || 0]);

  const doc = (id, type, issueDate, totals, extra = {}) => db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type, source_id,
                               brand_id, branch_id, warehouse_id, issue_date, subtotal,
                               discount_amount, vat_amount, total_amount, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, id, type, extra.sourceType || 'pos', extra.sourceId || null, I.BRAND,
     extra.branch || I.B1, extra.warehouse || null, issueDate,
     totals.subtotal, totals.discount || 0, totals.vat, totals.total,
     extra.status || 'paid', I.C1]);

  let lineSeq = 0;
  const line = (docId, menuId, qty, vat, amounts, extra = {}) => db.query(
    `INSERT INTO ar_document_lines (id, document_id, source_line_id, menu_id, description,
                                    entered_qty, base_qty, unit_price, discount_amount,
                                    vat_category, vat_rate, net_amount, vat_amount, gross_amount,
                                    warehouse_id, cost_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`${prefix}-L${++lineSeq}`, docId, extra.srcLine || 'L0', menuId, extra.desc || menuId,
     qty, qty, amounts.gross / (qty || 1), amounts.discount || 0,
     vat.cat, vat.rate, amounts.net, amounts.vat, amounts.gross,
     extra.warehouse || null, amounts.cost || 0]);

  const ofact = (docId, saleId, branch, local, bday, extra = {}) => db.query(
    `INSERT INTO analytics_order_facts
       (document_id, sale_id, brand_id, branch_id, warehouse_id, shift_id, channel_id,
        order_type, source, table_no, guests, customer_id, status, created_by, void_by,
        opened_at, closed_at, paid_at, occurred_at_local, business_day, tz_snapshot,
        discount_total, rounding_amount, tips_amount, fees_amount, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, saleId, I.BRAND, branch, extra.warehouse || null, extra.shift || null,
     extra.channel || null, extra.orderType || 'dine_in', extra.source || 'pos',
     extra.table || null, extra.guests != null ? extra.guests : null, null,
     extra.status || 'completed', extra.by || I.C1, extra.voidBy || null,
     local, local, local, local, bday, extra.tz || 'Asia/Riyadh',
     extra.discount || 0, 0, 0, 0, 'live']);

  const pfact = (srcType, srcId, lineNo, docId, branch, dir, method, norm, amount, local, bday, extra = {}) => db.query(
    `INSERT INTO analytics_payment_facts
       (source_type, source_id, line_no, document_id, branch_id, brand_id, shift_id,
        method_raw, method_norm, direction, amount, status, occurred_at, occurred_at_local,
        business_day, performed_by, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [srcType, srcId, lineNo, docId, branch, I.BRAND, extra.shift || null,
     method, norm, dir, amount, extra.status || 'captured', local, local, bday,
     extra.by || I.C1, 'live']);

  const mfact = (docId, srcLine, parent, comp, name, qty, delta, kind) => db.query(
    `INSERT INTO analytics_modifier_facts
       (document_id, source_line_id, parent_menu_id, component_menu_id,
        component_name_snapshot, qty, price_delta, cost_snapshot, kind, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,'live')`,
    [docId, srcLine, parent, comp, name, qty, delta, null, kind]);

  const tfact = (branch, type, amount, local, bday, srcType, srcId, extra = {}) => db.query(
    `INSERT INTO analytics_till_facts
       (shift_id, branch_id, movement_type, amount, occurred_at, occurred_at_local,
        business_day, performed_by, source_type, source_id, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,'live')`,
    [extra.shift || null, branch, type, amount, local, local, bday, extra.by || I.C1, srcType, srcId]);

  const ret = (id, origSale, origDoc, branch, wh, retDate, totals, cnId, extra = {}) => db.query(
    `INSERT INTO sales_returns (id, return_number, original_sale_id, original_ar_document_id,
                                brand_id, branch_id, warehouse_id, return_date, reason_code,
                                refund_method, subtotal, vat_amount, total_amount, status,
                                credit_note_id, created_by, posted_by, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?,?,?)`,
    [id, id, origSale, origDoc, I.BRAND, branch, wh, retDate, extra.reason || 'quality',
     extra.refund || 'ar_reduction', totals.net, totals.vat, totals.total,
     cnId, I.C1, I.C1, extra.postedAt || (retDate + ' 14:00:00')]);

  let rlSeq = 0;
  const retLine = (retId, menuId, qty, vat, amounts) => db.query(
    `INSERT INTO sales_return_lines (id, return_id, menu_id, description, sold_qty,
                                     return_qty, base_qty, unit_price_snapshot, vat_category,
                                     vat_rate, net_amount, vat_amount, gross_amount, cost_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`${prefix}-RL${++rlSeq}`, retId, menuId, menuId, qty, qty, qty,
     amounts.gross / (qty || 1), vat.cat, vat.rate, amounts.net, amounts.vat, amounts.gross,
     amounts.cost || 0]);

  // ── F1 — mixed invoice, split payment, modifiers ─────────────────────────
  await sale(I.S1, '2032-03-10 13:00:00', 204, 'Split', {
    shift: I.SH1, split: JSON.stringify({ Cash: 104, Mada: 100 }), discount: 15.75,
  });
  await doc(I.D1, 'invoice', '2032-03-10', { subtotal: 180, discount: 15.75, vat: 24, total: 204 }, { sourceId: I.S1, warehouse: I.W1 });
  await line(I.D1, I.M1, 2, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, discount: 10, cost: 40 }, { srcLine: 'L0' });
  await line(I.D1, I.M2, 1, { cat: 'Z', rate: 0 }, { net: 20, vat: 0, gross: 20, cost: 5 }, { srcLine: 'L1' });
  await line(I.D1, I.M3, 1, { cat: 'S', rate: 15 }, { net: 60, vat: 9, gross: 69, discount: 5.75, cost: 25 }, { srcLine: 'L2' });
  await ofact(I.D1, I.S1, I.B1, '2032-03-10 13:00:00', '2032-03-10',
    { shift: I.SH1, guests: 3, table: 'T1', discount: 15.75, warehouse: I.W1 });
  await pfact('pos_split', I.S1, 0, I.D1, I.B1, 'in', 'Cash', 'cash', 104, '2032-03-10 13:00:00', '2032-03-10', { shift: I.SH1 });
  await pfact('pos_split', I.S1, 1, I.D1, I.B1, 'in', 'Mada', 'card', 100, '2032-03-10 13:00:00', '2032-03-10', { shift: I.SH1 });
  await mfact(I.D1, 'L2', I.M3, I.M4, 'ITEST SH Cheese', 1, 3.0, 'modifier');
  await mfact(I.D1, 'L2', I.M3, I.M5, 'ITEST SH Fries', 1, null, 'combo_choice');
  await tfact(I.B1, 'cash_sale', 104, '2032-03-10 13:00:00', '2032-03-10', 'sale', I.S1, { shift: I.SH1 });

  // ── F3 — partial return, CN dated the later day ──────────────────────────
  await sale(I.S3, '2032-03-11 12:00:00', 230, 'Mada', { hasCn: true });
  await doc(I.D3, 'invoice', '2032-03-11', { subtotal: 200, vat: 30, total: 230 }, { sourceId: I.S3, warehouse: I.W1 });
  await line(I.D3, I.M1, 2, { cat: 'S', rate: 15 }, { net: 200, vat: 30, gross: 230, cost: 80 });
  await ofact(I.D3, I.S3, I.B1, '2032-03-11 12:00:00', '2032-03-11', { status: 'returned' });
  await pfact('pos_single', I.S3, 0, I.D3, I.B1, 'in', 'Mada', 'card', 230, '2032-03-11 12:00:00', '2032-03-11');
  await ret(I.R3, I.S3, I.D3, I.B1, I.W1, '2032-03-12', { net: 100, vat: 15, total: 115 }, I.CN3, { reason: 'quality' });
  await retLine(I.R3, I.M1, 1, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, cost: 40 });
  await doc(I.CN3, 'credit_note', '2032-03-12', { subtotal: 100, vat: 15, total: 115 },
    { sourceType: 'manual', sourceId: I.R3, status: 'issued', warehouse: I.W1 });
  await line(I.CN3, I.M1, 1, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, cost: 40 });
  await ofact(I.CN3, I.S3, I.B1, '2032-03-12 14:00:00', '2032-03-12', { source: 'sales_return', orderType: null });
  await pfact('refund', I.R3, 0, I.CN3, I.B1, 'out', 'ar_reduction', 'other', 115, '2032-03-12 14:00:00', '2032-03-12', { status: 'settled' });

  // ── F4 — full return, no restock (B2 / Cairo) ────────────────────────────
  await sale(I.S4, '2032-03-11 15:00:00', 90, 'Cash', { branch: I.B2, user: I.C2, hasCn: true });
  await doc(I.D4, 'invoice', '2032-03-11', { subtotal: 90, vat: 0, total: 90 }, { sourceId: I.S4, branch: I.B2, warehouse: I.W2 });
  await line(I.D4, I.M2, 3, { cat: 'Z', rate: 0 }, { net: 90, vat: 0, gross: 90, cost: 15 });
  await ofact(I.D4, I.S4, I.B2, '2032-03-11 15:00:00', '2032-03-11', { status: 'returned', by: I.C2, tz: 'Africa/Cairo' });
  await pfact('pos_single', I.S4, 0, I.D4, I.B2, 'in', 'Cash', 'cash', 90, '2032-03-11 15:00:00', '2032-03-11', { by: I.C2 });
  await tfact(I.B2, 'cash_sale', 90, '2032-03-11 15:00:00', '2032-03-11', 'sale', I.S4, { by: I.C2 });
  await ret(I.R4, I.S4, I.D4, I.B2, I.W2, '2032-03-13', { net: 90, vat: 0, total: 90 }, I.CN4, { reason: 'expired' });
  await retLine(I.R4, I.M2, 3, { cat: 'Z', rate: 0 }, { net: 90, vat: 0, gross: 90, cost: 15 });
  await doc(I.CN4, 'credit_note', '2032-03-13', { subtotal: 90, vat: 0, total: 90 },
    { sourceType: 'manual', sourceId: I.R4, status: 'issued', branch: I.B2, warehouse: I.W2 });
  await line(I.CN4, I.M2, 3, { cat: 'Z', rate: 0 }, { net: 90, vat: 0, gross: 90, cost: 15 });
  await ofact(I.CN4, I.S4, I.B2, '2032-03-13 11:00:00', '2032-03-13', { source: 'sales_return', orderType: null, tz: 'Africa/Cairo' });
  await pfact('refund', I.R4, 0, I.CN4, I.B2, 'out', 'ar_reduction', 'other', 90, '2032-03-13 11:00:00', '2032-03-13', { status: 'settled' });

  // ── F5 — voided before payment ───────────────────────────────────────────
  await sale(I.S5, '2032-03-10 10:30:00', 57.5, 'Cash', { zatca: 'cancellation' });
  await doc(I.D5, 'invoice', '2032-03-10', { subtotal: 50, vat: 7.5, total: 57.5 }, { sourceId: I.S5, status: 'cancelled' });
  await line(I.D5, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 });
  await ofact(I.D5, I.S5, I.B1, '2032-03-10 10:30:00', '2032-03-10', { status: 'voided', voidBy: I.C1 });
  // deliberately NO payment facts, NO till fact

  // ── F7 — midnight-crossing shift ─────────────────────────────────────────
  await sale(I.S7A, '2032-03-15 21:00:00', 115, 'Cash', { shift: I.SH7 });
  await doc(I.D7A, 'invoice', '2032-03-15', { subtotal: 100, vat: 15, total: 115 }, { sourceId: I.S7A });
  await line(I.D7A, I.M1, 1, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, cost: 40 });
  await ofact(I.D7A, I.S7A, I.B1, '2032-03-15 21:00:00', '2032-03-15', { shift: I.SH7 });
  await pfact('pos_single', I.S7A, 0, I.D7A, I.B1, 'in', 'Cash', 'cash', 115, '2032-03-15 21:00:00', '2032-03-15', { shift: I.SH7 });
  await tfact(I.B1, 'cash_sale', 115, '2032-03-15 21:00:00', '2032-03-15', 'sale', I.S7A, { shift: I.SH7 });

  await sale(I.S7B, '2032-03-16 01:30:00', 230, 'Mada', { shift: I.SH7 });
  await doc(I.D7B, 'invoice', '2032-03-16', { subtotal: 200, vat: 30, total: 230 }, { sourceId: I.S7B });
  await line(I.D7B, I.M3, 2, { cat: 'S', rate: 15 }, { net: 200, vat: 30, gross: 230, cost: 90 });
  // 01:30 local < 04:00 close → business_day is STILL 2032-03-15
  await ofact(I.D7B, I.S7B, I.B1, '2032-03-16 01:30:00', '2032-03-15', { shift: I.SH7 });
  await pfact('pos_single', I.S7B, 0, I.D7B, I.B1, 'in', 'Mada', 'card', 230, '2032-03-16 01:30:00', '2032-03-15', { shift: I.SH7 });

  await tfact(I.B1, 'open_float', 300, '2032-03-15 18:00:00', '2032-03-15', 'shift', I.SH7, { shift: I.SH7 });
  await tfact(I.B1, 'close_count', 800, '2032-03-16 02:00:00', '2032-03-15', 'shift', I.SH7, { shift: I.SH7 });

  // ── F8 — same UTC instant, two timezones ─────────────────────────────────
  // UTC 2032-03-20T01:30:00Z → Riyadh (+03) 04:30 ≥ close → day 03-20;
  //                            Cairo (+02, pre-DST) 03:30 < close → day 03-19.
  await sale(I.S8A, '2032-03-20 04:30:00', 115, 'Cash', {});
  await doc(I.D8A, 'invoice', '2032-03-20', { subtotal: 100, vat: 15, total: 115 }, { sourceId: I.S8A });
  await line(I.D8A, I.M1, 1, { cat: 'S', rate: 15 }, { net: 100, vat: 15, gross: 115, cost: 40 });
  await ofact(I.D8A, I.S8A, I.B1, '2032-03-20 04:30:00', '2032-03-20', {});
  await pfact('pos_single', I.S8A, 0, I.D8A, I.B1, 'in', 'Cash', 'cash', 115, '2032-03-20 04:30:00', '2032-03-20');
  await tfact(I.B1, 'cash_sale', 115, '2032-03-20 04:30:00', '2032-03-20', 'sale', I.S8A);

  await sale(I.S8B, '2032-03-20 03:30:00', 30, 'Cash', { branch: I.B2, user: I.C2 });
  await doc(I.D8B, 'invoice', '2032-03-20', { subtotal: 30, vat: 0, total: 30 }, { sourceId: I.S8B, branch: I.B2 });
  await line(I.D8B, I.M2, 1, { cat: 'Z', rate: 0 }, { net: 30, vat: 0, gross: 30, cost: 10 });
  await ofact(I.D8B, I.S8B, I.B2, '2032-03-20 03:30:00', '2032-03-19', { by: I.C2, tz: 'Africa/Cairo' });
  await pfact('pos_single', I.S8B, 0, I.D8B, I.B2, 'in', 'Cash', 'cash', 30, '2032-03-20 03:30:00', '2032-03-19', { by: I.C2 });
  await tfact(I.B2, 'cash_sale', 30, '2032-03-20 03:30:00', '2032-03-19', 'sale', I.S8B, { by: I.C2 });

  // ── F14 — cash refund ────────────────────────────────────────────────────
  await sale(I.S14, '2032-03-13 13:00:00', 57.5, 'Cash', { hasCn: true });
  await doc(I.D14, 'invoice', '2032-03-13', { subtotal: 50, vat: 7.5, total: 57.5 }, { sourceId: I.S14 });
  await line(I.D14, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 });
  await ofact(I.D14, I.S14, I.B1, '2032-03-13 13:00:00', '2032-03-13', { status: 'returned' });
  await pfact('pos_single', I.S14, 0, I.D14, I.B1, 'in', 'Cash', 'cash', 57.5, '2032-03-13 13:00:00', '2032-03-13');
  await tfact(I.B1, 'cash_sale', 57.5, '2032-03-13 13:00:00', '2032-03-13', 'sale', I.S14);
  await ret(I.R14, I.S14, I.D14, I.B1, I.W1, '2032-03-14', { net: 50, vat: 7.5, total: 57.5 }, I.CN14,
    { reason: 'customer_change', refund: 'cash', postedAt: '2032-03-14 11:00:00' });
  await retLine(I.R14, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 });
  await doc(I.CN14, 'credit_note', '2032-03-14', { subtotal: 50, vat: 7.5, total: 57.5 },
    { sourceType: 'manual', sourceId: I.R14, status: 'issued' });
  await line(I.CN14, I.M1, 1, { cat: 'S', rate: 15 }, { net: 50, vat: 7.5, gross: 57.5, cost: 20 });
  await ofact(I.CN14, I.S14, I.B1, '2032-03-14 11:00:00', '2032-03-14', { source: 'sales_return', orderType: null });
  await pfact('refund', I.R14, 0, I.CN14, I.B1, 'out', 'cash', 'cash', 57.5, '2032-03-14 11:00:00', '2032-03-14', { status: 'settled' });
  await tfact(I.B1, 'cash_refund', 57.5, '2032-03-14 11:00:00', '2032-03-14', 'sales_return', I.R14);

  // ── F1P — prior window (compare / prevPeriod) ────────────────────────────
  await sale(I.S1P, '2032-02-10 12:00:00', 103.5, 'Cash', {});
  await doc(I.D1P, 'invoice', '2032-02-10', { subtotal: 90, vat: 13.5, total: 103.5 }, { sourceId: I.S1P });
  await line(I.D1P, I.M1, 1, { cat: 'S', rate: 15 }, { net: 90, vat: 13.5, gross: 103.5, cost: 36 });
  await ofact(I.D1P, I.S1P, I.B1, '2032-02-10 12:00:00', '2032-02-10', {});
  await pfact('pos_single', I.S1P, 0, I.D1P, I.B1, 'in', 'Cash', 'cash', 103.5, '2032-02-10 12:00:00', '2032-02-10');

  return I;
}

module.exports = { seed, cleanup, ids, EXPECTED };
