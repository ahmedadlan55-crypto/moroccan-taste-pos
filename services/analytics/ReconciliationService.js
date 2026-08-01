/**
 * services/analytics/ReconciliationService.js — three-way daily reconciliation
 * of the sales truth, per (business_day, branch):
 *
 *   A. sales side    — analytics_order_facts ⋈ ar_documents with the planner's
 *                      DEFAULT filters verbatim (RollupService semantics):
 *                      voided facts excluded, CN-source docs excluded.
 *                      invoice_total = Σ doc.total_amount, orders = COUNT(*).
 *   B. payments side — analytics_payment_facts: in, out, net = in − out.
 *   C. till side     — analytics_till_facts: expected cash via
 *                      equations.expectedCash(open_float, cash_sale,
 *                      cash_refund, pay_in, pay_out + deposit) — DEPOSIT IS AN
 *                      OUTFLOW (merge-owner ruling: a bank deposit removes cash
 *                      from the drawer exactly like a pay-out) — vs counted =
 *                      Σ close_count. counted is NULL (honest "not measured",
 *                      never 0) on a day with no close_count fact, and the
 *                      cash delta is NULL with it.
 *
 * Deltas per row:
 *   salesVsPayments       = invoice_total − (payments in − out). NOTE: a
 *                           refund-only day (CN excluded from A, its 'out' leg
 *                           in B) legitimately shows +refund here — the report
 *                           SHOWS the asymmetry rather than netting it away.
 *   cashExpectedVsCounted = expected − counted (positive = cash missing);
 *                           NULL when counted is NULL.
 *
 * Exceptions per row (each with ids capped at DRILL_CAP + a true total):
 *   paymentsWithoutOrder — payment facts whose document_id is NULL or points
 *                          at no order fact. AR receipts (document_id NULL by
 *                          design) are listed too: they ARE payments with no
 *                          order — the reconciler's job is to show them.
 *   ordersWithoutPayment — COMPLETED, non-CN order facts whose 'in' payment
 *                          legs sum < doc.total_amount − 0.01.
 *
 * Drill lists: sales documentIds / payment factIds per cell, capped at 200
 * with the uncapped total alongside (documentIdsTotal === orders).
 *
 * Scope: caller must hold analytics.reconciliation.view (403 otherwise);
 * branch set is CLAMPED to the caller's scope — an out-of-scope request gets
 * empty rows, never someone else's data (fail-closed, same as the planner).
 *
 * Money: summed by SQL (DECIMAL), deltas composed via lib/analytics/equations
 * (integer-halala arithmetic, rounded once at the edge).
 */
'use strict';

const equations = require('../../lib/analytics/equations');

const DRILL_CAP = 200;
const MAX_RANGE_DAYS = 92; // per-day rows + drill ids — keep the payload sane

// Planner default filters, verbatim (lib/analytics/planner.js / RollupService).
const NOT_VOID = "(f.status IS NULL OR f.status <> 'voided')";
const NOT_CN = "(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))";

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

function _isIsoDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/** mysql2 (+03:00 session) returns DATE as a shifted JS Date — recover the
 *  wall-clock 'YYYY-MM-DD' (same trick as RollupService/QueryService). */
function _dbOffsetMinutes(db) {
  const tz = (db && db.DB_TIME_ZONE) || '+03:00';
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(tz));
  if (!m) return 180;
  const min = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -min : min;
}
function _dayStr(v, offsetMin) {
  if (v == null) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() + (offsetMin || 0) * 60000).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

const _r2 = (n) => equations.roundMoney(Number(n) || 0);

/**
 * Resolve the effective branch set: requested ∩ scope for non-admin, requested
 * (or null = ALL branches) for admin. `null` return means "no branch clause";
 * an empty ARRAY means "fail-closed: answer with zero rows".
 */
function clampBranches(scope, branchIds) {
  const requested = Array.isArray(branchIds)
    ? [...new Set(branchIds.map(String).filter(Boolean))] : [];
  if (scope && scope.all) return requested.length ? requested : null;
  const allowed = new Set(((scope && scope.branchIds) || []).map(String));
  if (!requested.length) return [...allowed];
  return requested.filter((b) => allowed.has(b));
}

/**
 * @param {object} db  mysql2 pool
 * @param {object} p   { scope, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', branchIds? }
 * @returns {Promise<{rows: Array, totals: object, meta: object}>}
 */
async function threeWay(db, { scope, from, to, branchIds } = {}) {
  if (!scope || !scope.caps || !scope.caps.has('analytics.reconciliation.view')) {
    throw err('PERMISSION_DENIED', 403, 'صلاحية غير كافية لعرض التسويات (analytics.reconciliation.view)');
  }
  if (!_isIsoDay(from) || !_isIsoDay(to)) {
    throw err('VALIDATION_ERROR', 422, 'from/to مطلوبان بصيغة YYYY-MM-DD');
  }
  const fromMs = Date.parse(from + 'T00:00:00Z');
  const toMs = Date.parse(to + 'T00:00:00Z');
  if (!(fromMs <= toMs)) throw err('VALIDATION_ERROR', 422, 'to يسبق from');
  const days = Math.floor((toMs - fromMs) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw err('ANALYTICS_RANGE_TOO_WIDE', 422, `المدى ${days} يومًا يتجاوز حد ${MAX_RANGE_DAYS} يومًا للتسوية`);
  }

  const branches = clampBranches(scope, branchIds);
  const meta = {
    from, to,
    branchIds: branches, // null = all (admin)
    generatedAt: new Date().toISOString(),
  };
  if (Array.isArray(branches) && branches.length === 0) {
    // fail-closed: non-admin with zero grants (or fully clamped-out request)
    return { rows: [], totals: _emptyTotals(), meta };
  }

  const offsetMin = _dbOffsetMinutes(db);
  const dayOf = (v) => _dayStr(v, offsetMin);

  // branch clause factory for a given column
  const bClause = (col) => (branches == null
    ? { sql: '', params: [] }
    : { sql: ` AND ${col} IN (${branches.map(() => '?').join(',')})`, params: branches });

  const cells = new Map(); // 'day|branch' → row skeleton
  const cellOf = (day, branch) => {
    const k = day + '|' + branch;
    let c = cells.get(k);
    if (!c) {
      c = {
        business_day: day,
        branch_id: String(branch),
        sales: { orders: 0, invoice_total: 0, documentIds: [], documentIdsTotal: 0 },
        payments: { in: 0, out: 0, net: 0, factIds: [], factIdsTotal: 0 },
        till: {
          open_float: 0, cash_sale: 0, cash_refund: 0, pay_in: 0, pay_out: 0,
          deposit: 0, expected_cash: null, counted: null,
        },
        deltas: { salesVsPayments: null, cashExpectedVsCounted: null },
        exceptions: {
          paymentsWithoutOrder: { count: 0, factIds: [] },
          ordersWithoutPayment: { count: 0, documentIds: [] },
        },
      };
      cells.set(k, c);
    }
    return c;
  };

  // ── A. sales side (aggregates) ─────────────────────────────────────────────
  {
    const bc = bClause('f.branch_id');
    const [rows] = await db.query(
      `SELECT f.business_day AS d, f.branch_id AS b,
              COUNT(*) AS orders, COALESCE(SUM(doc.total_amount), 0) AS invoice_total
         FROM analytics_order_facts f
         JOIN ar_documents doc ON doc.id = f.document_id
        WHERE f.business_day BETWEEN ? AND ?${bc.sql}
          AND ${NOT_VOID} AND ${NOT_CN}
        GROUP BY f.business_day, f.branch_id`,
      [from, to, ...bc.params]);
    for (const r of rows) {
      const c = cellOf(dayOf(r.d), r.b);
      c.sales.orders = Number(r.orders);
      c.sales.invoice_total = _r2(r.invoice_total);
      c.sales.documentIdsTotal = Number(r.orders);
    }
    // drill: document ids, capped per cell
    const [ids] = await db.query(
      `SELECT f.business_day AS d, f.branch_id AS b, f.document_id AS id
         FROM analytics_order_facts f
         JOIN ar_documents doc ON doc.id = f.document_id
        WHERE f.business_day BETWEEN ? AND ?${bc.sql}
          AND ${NOT_VOID} AND ${NOT_CN}
        ORDER BY f.business_day, f.branch_id, f.document_id`,
      [from, to, ...bc.params]);
    for (const r of ids) {
      const c = cellOf(dayOf(r.d), r.b);
      if (c.sales.documentIds.length < DRILL_CAP) c.sales.documentIds.push(String(r.id));
    }
  }

  // ── B. payments side ───────────────────────────────────────────────────────
  {
    const bc = bClause('p.branch_id');
    const [rows] = await db.query(
      `SELECT p.business_day AS d, p.branch_id AS b,
              COALESCE(SUM(CASE WHEN p.direction = 'in'  THEN p.amount ELSE 0 END), 0) AS pin,
              COALESCE(SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE 0 END), 0) AS pout,
              COUNT(*) AS cnt
         FROM analytics_payment_facts p
        WHERE p.business_day BETWEEN ? AND ?${bc.sql}
        GROUP BY p.business_day, p.branch_id`,
      [from, to, ...bc.params]);
    for (const r of rows) {
      const c = cellOf(dayOf(r.d), r.b);
      c.payments.in = _r2(r.pin);
      c.payments.out = _r2(r.pout);
      c.payments.net = equations.netCollections(r.pin, r.pout);
      c.payments.factIdsTotal = Number(r.cnt);
    }
    const [ids] = await db.query(
      `SELECT p.business_day AS d, p.branch_id AS b, p.id AS id
         FROM analytics_payment_facts p
        WHERE p.business_day BETWEEN ? AND ?${bc.sql}
        ORDER BY p.business_day, p.branch_id, p.id`,
      [from, to, ...bc.params]);
    for (const r of ids) {
      const c = cellOf(dayOf(r.d), r.b);
      if (c.payments.factIds.length < DRILL_CAP) c.payments.factIds.push(Number(r.id));
    }
  }

  // ── C. till side ───────────────────────────────────────────────────────────
  {
    const bc = bClause('t.branch_id');
    const [rows] = await db.query(
      `SELECT t.business_day AS d, t.branch_id AS b,
              COALESCE(SUM(CASE WHEN t.movement_type = 'open_float'  THEN t.amount ELSE 0 END), 0) AS open_float,
              COALESCE(SUM(CASE WHEN t.movement_type = 'cash_sale'   THEN t.amount ELSE 0 END), 0) AS cash_sale,
              COALESCE(SUM(CASE WHEN t.movement_type = 'cash_refund' THEN t.amount ELSE 0 END), 0) AS cash_refund,
              COALESCE(SUM(CASE WHEN t.movement_type = 'pay_in'      THEN t.amount ELSE 0 END), 0) AS pay_in,
              COALESCE(SUM(CASE WHEN t.movement_type = 'pay_out'     THEN t.amount ELSE 0 END), 0) AS pay_out,
              COALESCE(SUM(CASE WHEN t.movement_type = 'deposit'     THEN t.amount ELSE 0 END), 0) AS deposit,
              COALESCE(SUM(CASE WHEN t.movement_type = 'close_count' THEN t.amount ELSE 0 END), 0) AS close_amt,
              SUM(t.movement_type = 'close_count') AS close_rows
         FROM analytics_till_facts t
        WHERE t.business_day BETWEEN ? AND ?${bc.sql}
        GROUP BY t.business_day, t.branch_id`,
      [from, to, ...bc.params]);
    for (const r of rows) {
      const c = cellOf(dayOf(r.d), r.b);
      c.till.open_float = _r2(r.open_float);
      c.till.cash_sale = _r2(r.cash_sale);
      c.till.cash_refund = _r2(r.cash_refund);
      c.till.pay_in = _r2(r.pay_in);
      c.till.pay_out = _r2(r.pay_out);
      c.till.deposit = _r2(r.deposit);
      // deposit is an OUTFLOW (merge-owner ruling) — folded into payOuts.
      c.till.expected_cash = equations.expectedCash(
        r.open_float, r.cash_sale, r.cash_refund, r.pay_in,
        Number(r.pay_out) + Number(r.deposit));
      c.till.counted = Number(r.close_rows) > 0 ? _r2(r.close_amt) : null;
    }
  }

  // ── exceptions: payments-without-order ─────────────────────────────────────
  {
    const bc = bClause('p.branch_id');
    const [rows] = await db.query(
      `SELECT p.business_day AS d, p.branch_id AS b, p.id AS id
         FROM analytics_payment_facts p
         LEFT JOIN analytics_order_facts f ON f.document_id = p.document_id
        WHERE p.business_day BETWEEN ? AND ?${bc.sql}
          AND (p.document_id IS NULL OR f.document_id IS NULL)
        ORDER BY p.business_day, p.branch_id, p.id`,
      [from, to, ...bc.params]);
    for (const r of rows) {
      const x = cellOf(dayOf(r.d), r.b).exceptions.paymentsWithoutOrder;
      x.count++;
      if (x.factIds.length < DRILL_CAP) x.factIds.push(Number(r.id));
    }
  }

  // ── exceptions: orders-without-payment ─────────────────────────────────────
  {
    const bc = bClause('f.branch_id');
    const [rows] = await db.query(
      `SELECT f.business_day AS d, f.branch_id AS b, f.document_id AS id
         FROM analytics_order_facts f
         JOIN ar_documents doc ON doc.id = f.document_id
        WHERE f.business_day BETWEEN ? AND ?${bc.sql}
          AND f.status = 'completed' AND ${NOT_CN}
          AND COALESCE((SELECT SUM(CASE WHEN p2.direction = 'in' THEN p2.amount ELSE 0 END)
                          FROM analytics_payment_facts p2
                         WHERE p2.document_id = f.document_id), 0)
              < doc.total_amount - 0.01
        ORDER BY f.business_day, f.branch_id, f.document_id`,
      [from, to, ...bc.params]);
    for (const r of rows) {
      const x = cellOf(dayOf(r.d), r.b).exceptions.ordersWithoutPayment;
      x.count++;
      if (x.documentIds.length < DRILL_CAP) x.documentIds.push(String(r.id));
    }
  }

  // ── deltas + totals ────────────────────────────────────────────────────────
  const rows = [...cells.values()]
    .sort((a, b) => (a.business_day < b.business_day ? -1 : a.business_day > b.business_day ? 1 :
      (a.branch_id < b.branch_id ? -1 : a.branch_id > b.branch_id ? 1 : 0)));

  const totals = _emptyTotals();
  for (const c of rows) {
    c.deltas.salesVsPayments = equations.fromMinor(
      equations.toMinor(c.sales.invoice_total) - equations.toMinor(c.payments.net));
    c.deltas.cashExpectedVsCounted = c.till.counted == null || c.till.expected_cash == null
      ? null
      : equations.roundMoney(c.till.expected_cash - c.till.counted);
    totals.orders += c.sales.orders;
    totals.invoice_total = equations.sumMoney([totals.invoice_total, c.sales.invoice_total]);
    totals.payments_in = equations.sumMoney([totals.payments_in, c.payments.in]);
    totals.payments_out = equations.sumMoney([totals.payments_out, c.payments.out]);
    totals.salesVsPayments = equations.sumMoney([totals.salesVsPayments, c.deltas.salesVsPayments]);
    if (c.deltas.cashExpectedVsCounted != null) {
      totals.cashExpectedVsCounted = equations.sumMoney(
        [totals.cashExpectedVsCounted, c.deltas.cashExpectedVsCounted]);
    }
    totals.paymentsWithoutOrder += c.exceptions.paymentsWithoutOrder.count;
    totals.ordersWithoutPayment += c.exceptions.ordersWithoutPayment.count;
    // The till leg. The movement columns default to 0 per row (a day with no
    // pay-outs really had none); the two MEASURED figures stay nullable.
    totals.open_float = equations.sumMoney([totals.open_float, c.till.open_float || 0]);
    totals.cash_sale = equations.sumMoney([totals.cash_sale, c.till.cash_sale || 0]);
    totals.cash_refund = equations.sumMoney([totals.cash_refund, c.till.cash_refund || 0]);
    totals.pay_in = equations.sumMoney([totals.pay_in, c.till.pay_in || 0]);
    totals.pay_out = equations.sumMoney([totals.pay_out, c.till.pay_out || 0]);
    totals.deposit = equations.sumMoney([totals.deposit, c.till.deposit || 0]);
    totals.expected_cash = _addNullable(totals.expected_cash, c.till.expected_cash);
    totals.counted = _addNullable(totals.counted, c.till.counted);
  }

  return { rows, totals, meta };
}

function _emptyTotals() {
  return {
    orders: 0, invoice_total: 0, payments_in: 0, payments_out: 0,
    salesVsPayments: 0, cashExpectedVsCounted: 0,
    paymentsWithoutOrder: 0, ordersWithoutPayment: 0,
    // ── the till leg of the cash chain ──────────────────────────────────────
    // Present per ROW since v2 but never summed, so the one screen that shows
    // the money's whole path — invoiced → collected → drawer → deposited — had
    // to add them up in the browser. Period figures belong in one place, next
    // to the deltas that are computed from them.
    //
    // expected_cash / counted stay NULLABLE all the way up: a period in which
    // no drawer was ever counted must read "—", not 0. A zero here is the
    // claim that the drawer was counted and found empty.
    open_float: 0, cash_sale: 0, cash_refund: 0, pay_in: 0, pay_out: 0, deposit: 0,
    expected_cash: null, counted: null,
  };
}

/** Sum that keeps null meaning "never measured" rather than collapsing to 0. */
function _addNullable(acc, v) {
  if (v == null) return acc;
  return equations.sumMoney([acc == null ? 0 : acc, v]);
}

module.exports = { threeWay, clampBranches, DRILL_CAP, MAX_RANGE_DAYS };
