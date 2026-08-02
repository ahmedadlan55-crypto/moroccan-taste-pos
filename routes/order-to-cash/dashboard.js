/**
 * routes/order-to-cash/dashboard.js — the sales/AR dashboard summary.
 * Today's sales, open AR, overdue AR, unallocated payments, top exposure — all
 * derived (never customer.balance). One bounded set of grouped queries.
 *
 * Every figure here is an AGGREGATE, so — exactly as in
 * services/order-to-cash/O2CReportingService.js — the branch predicate has to be
 * inside each statement. `o2c.dashboard.view` says the caller may open the
 * dashboard; it never said whose money it should show. Without these clauses a
 * branch manager's landing page reported the whole company's sales, AR and top
 * debtors. Zero grants → `1=0` → zeros, never the company total.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const calc = require('../../lib/order-to-cash/calculations');
const SalesScope = require('../../lib/salesScope');
const money = calc.money;

router.get('/dashboard', requireCapability('o2c.dashboard.view'), async (req, res) => {
  try {
    const today = calc.ymd(new Date());
    // Intersected with any ?branchId= the caller sent — a branch they hold no
    // grant for drops out and yields the fail-closed clause, not that branch.
    const scope = await SalesScope.effectiveScope(db, req);
    const bDoc = SalesScope.andBranchClause(scope, 'branch_id');   // ar_documents
    const bPay = SalesScope.andBranchClause(scope, 'branch_id');   // customer_payments
    const [[todaySales]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status NOT IN ('cancelled','draft') AND issue_date = ?${bDoc.sql}`,
      [today].concat(bDoc.params))];
    const [[openAr]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND balance_amount > 0.01${bDoc.sql}`,
      bDoc.params)];
    const [[overdue]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND balance_amount > 0.01
          AND due_date IS NOT NULL AND due_date < ?${bDoc.sql}`, [today].concat(bDoc.params))];
    const [[unalloc]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(unapplied_amount),0) AS total FROM customer_payments WHERE status='posted' AND unapplied_amount > 0.01${bPay.sql}`,
      bPay.params)];
    // v_customer_ar_balance is keyed by customer and sums every branch — a
    // customer's debt is company-wide and a "branch share" of it would not
    // reconcile with what they owe (the same call lib/salesScope
    // .assertCustomerInScope makes for the statement). So the BALANCE stays
    // whole and the ROW SET is restricted to customers who have traded in a
    // branch the caller may see: no other branch's debtors are ever named.
    const bx = SalesScope.branchClause(scope, 'x.branch_id');
    const topExposure = (await db.query(
      `SELECT v.customer_id, v.customer_name, v.ar_balance FROM v_customer_ar_balance v
        WHERE v.ar_balance > 0${bx.sql ? ` AND EXISTS (SELECT 1 FROM ar_documents x
              WHERE x.customer_id COLLATE utf8mb4_unicode_ci = v.customer_id COLLATE utf8mb4_unicode_ci AND ${bx.sql})` : ''}
        ORDER BY v.ar_balance DESC LIMIT 5`, bx.params))[0];
    const [[mtd]] = [await db.query(
      `SELECT COALESCE(SUM(total_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status NOT IN ('cancelled','draft') AND issue_date >= DATE_FORMAT(?, '%Y-%m-01')${bDoc.sql}`,
      [today].concat(bDoc.params))];

    return H.sendData(res, {
      today: { count: Number(todaySales.n), total: money(todaySales.total) },
      monthToDate: { total: money(mtd.total) },
      openAr: { count: Number(openAr.n), total: money(openAr.total) },
      overdueAr: { count: Number(overdue.n), total: money(overdue.total) },
      unallocatedPayments: { count: Number(unalloc.n), total: money(unalloc.total) },
      topExposure: topExposure.map((r) => ({ customerId: r.customer_id, customerName: r.customer_name, balance: money(r.ar_balance) })),
    });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
