/**
 * routes/order-to-cash/dashboard.js — the sales/AR dashboard summary.
 * Today's sales, open AR, overdue AR, unallocated payments, top exposure — all
 * derived (never customer.balance). One bounded set of grouped queries.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const calc = require('../../lib/order-to-cash/calculations');
const money = calc.money;

router.get('/dashboard', requireCapability('o2c.dashboard.view'), async (req, res) => {
  try {
    const today = calc.ymd(new Date());
    const [[todaySales]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status NOT IN ('cancelled','draft') AND issue_date = ?`, [today])];
    const [[openAr]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND balance_amount > 0.01`)];
    const [[overdue]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status IN ('issued','partially_paid') AND balance_amount > 0.01
          AND due_date IS NOT NULL AND due_date < ?`, [today])];
    const [[unalloc]] = [await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(unapplied_amount),0) AS total FROM customer_payments WHERE status='posted' AND unapplied_amount > 0.01`)];
    const [topExposure] = await db.query(
      `SELECT customer_id, customer_name, ar_balance FROM v_customer_ar_balance WHERE ar_balance > 0 ORDER BY ar_balance DESC LIMIT 5`);
    const [[mtd]] = [await db.query(
      `SELECT COALESCE(SUM(total_amount),0) AS total FROM ar_documents
        WHERE document_type='invoice' AND status NOT IN ('cancelled','draft') AND issue_date >= DATE_FORMAT(?, '%Y-%m-01')`, [today])];

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
