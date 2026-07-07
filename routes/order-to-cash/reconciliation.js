/**
 * routes/order-to-cash/reconciliation.js — integrity endpoints.
 *   GET /reconcile → run all O2C invariants (read-only)
 *   GET /ready     → lightweight readiness: schema present + reconcile has no hard failure
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const Reconcile = require('../../services/order-to-cash/O2CReconciliationService');

router.get('/reconcile', requireCapability('ar_reports.view'), async (req, res) => {
  try { return H.sendData(res, await Reconcile.run()); }
  catch (e) { return H.sendErr(res, e); }
});

router.get('/ready', async (req, res) => {
  try {
    const [t] = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('ar_documents','customer_payments','ar_payment_allocations','sales_returns')");
    const schemaOk = Number(t[0].n) === 4;
    if (!schemaOk) return res.status(503).json({ ready: false, reason: 'schema-incomplete', at: new Date().toISOString() });
    const rec = await Reconcile.run();
    return res.status(rec.pass ? 200 : 503).json({ ready: rec.pass, checks: rec.checks, at: new Date().toISOString() });
  } catch (e) { return res.status(503).json({ ready: false, reason: 'error', at: new Date().toISOString() }); }
});

module.exports = router;
