/**
 * routes/order-to-cash/returns.js — sales returns (partial, per-line).
 * create (draft) → approve → post (credit note + append-only GL + stock restore)
 * → reverse ; cancel before post.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const ReturnService = require('../../services/order-to-cash/SalesReturnService');

function _ctx(req, extra) {
  return Object.assign({
    actor: H.actorOf(req), actorId: H.actorIdOf(req),
    expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
  }, extra || {});
}

router.get('/', requireCapability('returns.view'), async (req, res) => {
  try {
    const out = await ReturnService.list(req.query);
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('returns.view'), async (req, res) => {
  try { return H.sendData(res, await db.withTransaction((c) => ReturnService.getWithLines(c, req.params.id))); }
  catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('returns.create'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => ReturnService.create(c, req.body || {}, H.actorOf(req)));
    return H.sendOk(res, { data: out, documentNumber: out.return_number, status: out.status, version: out.version }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/approve', requireCapability('returns.approve'), async (req, res) => {
  try {
    const r = await ReturnService.approve(req.params.id, _ctx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/post', requireCapability('returns.post'), async (req, res) => {
  try {
    const r = await ReturnService.post(req.params.id, _ctx(req));
    return H.sendOk(res, {
      data: { id: req.params.id, creditNoteId: r.result && r.result.payload && r.result.payload.creditNoteId },
      documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion,
      journalIds: (r.result && r.result.journalIds) || [], affectedStock: (r.result && r.result.affectedStock) || [], affectedValue: r.result && r.result.affectedValue,
    });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/reverse', requireCapability('returns.reverse'), async (req, res) => {
  try {
    const r = await ReturnService.reverse(req.params.id, _ctx(req, { date: req.body && req.body.date }));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion, journalIds: (r.result && r.result.journalIds) || [] });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('returns.create'), async (req, res) => {
  try {
    const r = await ReturnService.cancel(req.params.id, _ctx(req));
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.return_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
