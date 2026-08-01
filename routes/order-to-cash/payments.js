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
const SalesScope = require('../../lib/salesScope');
const PaymentService = require('../../services/order-to-cash/CustomerPaymentService');
const events = require('../../lib/order-to-cash/events');

function _ctx(req, extra) {
  return Object.assign({
    actor: H.actorOf(req), actorId: H.actorIdOf(req),
    expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
    requestHash: H.requestHashOf(req),
  }, extra || {});
}

router.get('/', requireCapability('payments.view'), async (req, res) => {
  try {
    // Collections are money received AT a branch. Unscoped, this endpoint listed
    // every branch's receipts — amounts, methods, cash/bank destinations and the
    // unapplied balances that reveal who is behind on payment.
    const scope = await SalesScope.effectiveScope(db, req);
    const out = await PaymentService.list(Object.assign({}, req.query, { scope }));
    const page = await SalesScope.filterPage(db, scope, 'customer_payments', out.data);
    return H.sendData(res, page.rows, {
      pagination: Object.assign({}, out.pagination, page.dropped ? { scopeFiltered: true } : {}),
    });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('payments.view'), async (req, res) => {
  try {
    const scope = await SalesScope.forRequest(db, req);
    const out = await db.withTransaction((c) => PaymentService.get(c, req.params.id));
    // 404 rather than 403 — a 403 confirms the receipt exists (see salesScope.js).
    SalesScope.assertRowInScope(scope, out, 'سند القبض غير موجود');
    return H.sendData(res, out);
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id/timeline', requireCapability('payments.view'), async (req, res) => {
  try {
    // The timeline is keyed by id alone, so it never loaded the row and never
    // saw a branch: it handed out another branch's approval/post/reverse history
    // — actors, timestamps and GL journal ids — to anyone who could name an id.
    const scope = await SalesScope.forRequest(db, req);
    await SalesScope.assertRecordInScope(db, scope, 'customer_payments', req.params.id, 'سند القبض غير موجود');
    return H.sendData(res, await events.timeline(db, 'customer_payment', req.params.id));
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('payments.create'), async (req, res) => {
  try {
    const idemKey = H.idemOf(req);
    const reqHash = H.requestHashOf(req);
    const body = Object.assign({}, req.body || {}, { idempotencyKey: idemKey, requestHash: reqHash });
    let out;
    try {
      out = await db.withTransaction((c) => PaymentService.create(c, body, H.actorOf(req)));
    } catch (e) {
      // Parallel same-key race — recover on the POOL (see returns.js).
      const prior = idemKey && e && e.code === 'ER_DUP_ENTRY'
        ? await events.findPrior(db, 'customer_payment', 'create', '', idemKey, reqHash) : null;
      if (!prior) throw e;
      out = await db.withTransaction((c) => PaymentService.get(c, prior.entity_id));
    }
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
    const out = await PaymentService.allocateAdvance(req.params.id, {
      actor: H.actorOf(req), allocations: req.body && req.body.allocations,
      // This posts GL and moves invoice balances — it gets the same
      // key+fingerprint contract as every other money-moving endpoint.
      idempotencyKey: H.idemOf(req), requestHash: H.requestHashOf(req),
    });
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
