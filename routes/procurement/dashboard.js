/**
 * routes/procurement/dashboard.js — procurement command-center KPIs.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const calc = require('../../lib/procurement/calculations');

router.get('/dashboard', requireCapability('procurement.dashboard'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [[purchaseValue]] = await db.query("SELECT COALESCE(SUM(total_amount),0) v FROM supplier_invoices WHERE status NOT IN ('cancelled','draft')");
    const [[ordersPending]] = await db.query("SELECT COUNT(*) c FROM purchase_orders WHERE status='submitted'");
    const [[ordersOverdue]] = await db.query("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('approved','sent','partially_received') AND expected_date IS NOT NULL AND expected_date < ?", [today]);
    const [[partialReceipts]] = await db.query("SELECT COUNT(*) c FROM purchase_orders WHERE status='partially_received'");
    const [[unmatchedInvoices]] = await db.query("SELECT COUNT(*) c FROM supplier_invoices WHERE matching_status IN ('unmatched','partial') AND status NOT IN ('cancelled','draft','paid','closed')");
    const [[apDue]] = await db.query('SELECT COALESCE(SUM(ap_balance),0) v FROM v_supplier_ap_balance WHERE ap_balance > 0');
    const [[apOverdue]] = await db.query(
      `SELECT COALESCE(SUM(total_amount - COALESCE((SELECT SUM(allocated_amount) FROM payment_allocations pa WHERE pa.supplier_invoice_id = si.id AND pa.reversed=0),0)),0) v
         FROM supplier_invoices si WHERE si.status NOT IN ('cancelled','draft','paid','closed') AND si.due_date < ?`, [today]);
    const [[variances]] = await db.query('SELECT COUNT(*) c FROM supplier_invoice_matches WHERE ABS(price_variance) > 0 OR ABS(qty_variance) > 0');
    const [recent] = await db.query(
      `SELECT document_type, document_id, action, actor, to_status, created_at
         FROM procurement_events ORDER BY created_at DESC LIMIT 15`);

    return H.sendData(res, {
      purchaseValue: calc.money(purchaseValue.v),
      ordersPendingApproval: Number(ordersPending.c),
      ordersOverdue: Number(ordersOverdue.c),
      partialReceipts: Number(partialReceipts.c),
      unmatchedInvoices: Number(unmatchedInvoices.c),
      apDue: calc.money(apDue.v),
      apOverdue: calc.money(apOverdue.v),
      variances: Number(variances.c),
      recentActivity: recent,
    });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
