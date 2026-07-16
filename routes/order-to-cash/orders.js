/**
 * routes/order-to-cash/orders.js — sales orders lifecycle.
 * draft → confirm → fulfill → invoice → (close) ; cancel before fulfillment.
 * Confirming/invoicing a credit order runs the server credit gate; a credit
 * override requires the credit.override capability (checked here, enforced in svc).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const events = require('../../lib/order-to-cash/events');
const SalesOrderService = require('../../services/order-to-cash/SalesOrderService');

async function _overrideCtx(req) {
  const has = await requireCapability.hasCapability(req.user, 'credit.override');
  return {
    actor: H.actorOf(req), actorId: H.actorIdOf(req),
    expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
    requestHash: H.requestHashOf(req),
    hasOverrideCapability: has, override: !!(req.body && req.body.override),
  };
}

router.get('/', requireCapability('sales_orders.view'), async (req, res) => {
  try {
    const out = await SalesOrderService.list(req.query);
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('sales_orders.view'), async (req, res) => {
  try { return H.sendData(res, await db.withTransaction((c) => SalesOrderService.getWithLines(c, req.params.id))); }
  catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('sales_orders.create'), async (req, res) => {
  try {
    const idemKey = H.idemOf(req);
    const reqHash = H.requestHashOf(req);
    const body = Object.assign({}, req.body || {}, { idempotencyKey: idemKey, requestHash: reqHash });
    let out;
    try {
      out = await db.withTransaction((c) => SalesOrderService.create(c, body, H.actorOf(req)));
    } catch (e) {
      // Parallel same-key race — recover on the POOL (see returns.js).
      const prior = idemKey && e && e.code === 'ER_DUP_ENTRY'
        ? await events.findPrior(db, 'sales_order', 'create', '', idemKey, reqHash) : null;
      if (!prior) throw e;
      out = await db.withTransaction((c) => SalesOrderService.getWithLines(c, prior.entity_id));
    }
    return H.sendOk(res, { data: out, documentNumber: out.order_number, status: out.status, version: out.version }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/confirm', requireCapability('sales_orders.confirm'), async (req, res) => {
  try {
    const r = await SalesOrderService.confirm(req.params.id, await _overrideCtx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.order_number, status: r.toStatus, version: r.newVersion, warnings: (r.result && r.result.warnings) || [] });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/fulfill', requireCapability('sales_orders.fulfill'), async (req, res) => {
  try {
    const r = await SalesOrderService.fulfill(req.params.id, await _overrideCtx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.order_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/invoice', requireCapability('invoices.issue'), async (req, res) => {
  try {
    const r = await SalesOrderService.invoiceOrder(req.params.id, await _overrideCtx(req));
    return H.sendOk(res, { data: { id: req.params.id, invoiceId: r.result && r.result.payload && r.result.payload.invoiceId }, documentNumber: r.row.order_number, status: r.toStatus, version: r.newVersion, journalIds: (r.result && r.result.journalIds) || [] });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('sales_orders.create'), async (req, res) => {
  try {
    const r = await SalesOrderService.cancel(req.params.id, await _overrideCtx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.order_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
