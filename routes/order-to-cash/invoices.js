/**
 * routes/order-to-cash/invoices.js — customer invoices (ar_documents).
 * draft (create) → issue (GL + ZATCA) ; cancel a draft only (issued = immutable).
 * A correction after issue is a credit note (via /returns), never an edit.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const InvoiceService = require('../../services/order-to-cash/InvoiceService');

router.get('/', requireCapability('invoices.view'), async (req, res) => {
  try {
    const out = await InvoiceService.list(req.query);
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('invoices.view'), async (req, res) => {
  try { return H.sendData(res, await db.withTransaction((c) => InvoiceService.getWithLines(c, req.params.id))); }
  catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('invoices.create'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => InvoiceService.createDraft(c, req.body || {}, H.actorOf(req)));
    return H.sendOk(res, { data: out, documentNumber: out.document_number, status: out.status, version: out.version }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/issue', requireCapability('invoices.issue'), async (req, res) => {
  try {
    const has = await requireCapability.hasCapability(req.user, 'credit.override');
    const r = await InvoiceService.issue(req.params.id, {
      actor: H.actorOf(req), actorId: H.actorIdOf(req),
      expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      enforceCredit: !!(req.body && req.body.creditSale), override: !!(req.body && req.body.override), hasOverrideCapability: has,
    });
    return H.sendOk(res, {
      data: { id: req.params.id }, documentNumber: (r.result && r.result.payload && r.result.payload.documentNumber) || r.row.document_number,
      status: r.toStatus, version: r.newVersion, journalIds: (r.result && r.result.journalIds) || [], affectedValue: r.result && r.result.affectedValue,
    });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('invoices.create'), async (req, res) => {
  try {
    const r = await InvoiceService.cancel(req.params.id, {
      actor: H.actorOf(req), actorId: H.actorIdOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.document_number, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
