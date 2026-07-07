/**
 * routes/order-to-cash/payments.js — customer collections + allocations.
 * create (draft) → approve → post (allocations + GL) → reverse; cancel before post.
 * Posted advances can be applied later via /:id/allocate.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const PaymentService = require('../../services/order-to-cash/CustomerPaymentService');
const events = require('../../lib/order-to-cash/events');

function _ctx(req, extra) {
  return Object.assign({
    actor: H.actorOf(req), actorId: H.actorIdOf(req),
    expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
  }, extra || {});
}

router.get('/', requireCapability('payments.view'), async (req, res) => {
  try {
    const out = await PaymentService.list(req.query);
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('payments.view'), async (req, res) => {
  try { return H.sendData(res, await db.withTransaction((c) => PaymentService.get(c, req.params.id))); }
  catch (e) { return H.sendErr(res, e); }
});

router.get('/:id/timeline', requireCapability('payments.view'), async (req, res) => {
  try { return H.sendData(res, await events.timeline(db, 'customer_payment', req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('payments.create'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => PaymentService.create(c, req.body || {}, H.actorOf(req)));
    return H.sendOk(res, { data: out, documentNumber: out.payment_number, status: out.status, version: out.version }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/approve', requireCapability('payments.approve'), async (req, res) => {
  try {
    const r = await PaymentService.approve(req.params.id, _ctx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/post', requireCapability('payments.post'), async (req, res) => {
  try {
    const r = await PaymentService.post(req.params.id, _ctx(req, { allocations: req.body && req.body.allocations }));
    return H.sendOk(res, {
      data: { id: req.params.id, allocations: r.result && r.result.payload && r.result.payload.perInvoice }, documentNumber: r.row.payment_number,
      status: r.toStatus, version: r.newVersion, journalIds: (r.result && r.result.journalIds) || [], affectedValue: r.result && r.result.affectedValue,
    });
  } catch (e) { return H.sendErr(res, e); }
});

// apply a posted advance's unapplied balance to invoices
router.post('/:id/allocate', requireCapability('payments.post'), async (req, res) => {
  try {
    const out = await PaymentService.allocateAdvance(req.params.id, { actor: H.actorOf(req), allocations: req.body && req.body.allocations });
    return H.sendOk(res, { data: out, journalIds: out.journalId ? [out.journalId] : [] });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/reverse', requireCapability('payments.reverse'), async (req, res) => {
  try {
    const r = await PaymentService.reverse(req.params.id, _ctx(req, { date: req.body && req.body.date }));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion, journalIds: (r.result && r.result.journalIds) || [] });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('payments.create'), async (req, res) => {
  try {
    const r = await PaymentService.cancel(req.params.id, _ctx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.payment_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
