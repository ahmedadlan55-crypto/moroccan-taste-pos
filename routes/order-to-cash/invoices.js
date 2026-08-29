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
const events = require('../../lib/order-to-cash/events');
const Zqr = require('../../lib/zatca-qr-image');
const SalesScope = require('../../lib/salesScope');
const InvoiceService = require('../../services/order-to-cash/InvoiceService');
const SNAP = require('../../lib/reportSnapshot');

router.get('/', requireCapability('invoices.view'), async (req, res) => {
  try {
    // `invoices.view` says the caller may read invoices; it never said WHOSE.
    // Without this scope every branch manager could page through every other
    // branch's AR — customer names, amounts, balances, the lot. The scope is
    // intersected with any `?branchId=` the caller sent, so asking for a branch
    // they have no grant for yields an empty set (→ `1=0`), not that branch.
    const scope = await SalesScope.effectiveScope(db, req);
    // `scope` is passed down as well as enforced here: the day InvoiceService
    // .list appends the branch predicate to its own WHERE, this becomes a no-op
    // rather than a second thing to remember.
    const out = await InvoiceService.list(Object.assign({}, req.query, { scope }));
    // `?snapshot=1` asks for the whole filtered report for print/export. It is
    // COMPLETE or REFUSED — a partial snapshot printed under a totals row that
    // describes the full set is a document that is wrong in a way the reader
    // cannot see. See lib/reportSnapshot.js.
    if (out.tooLarge) return SNAP.tooLarge(res, out.total, out.limit);
    const page = await SalesScope.filterPage(db, scope, 'ar_documents', out.data);
    return H.sendData(res, page.rows, {
      pagination: Object.assign({}, out.pagination, page.dropped ? { scopeFiltered: true } : {}),
      // A defensive scope drop means the service and route disagreed. Never
      // expose the wider aggregate in that state; in the healthy path the
      // service predicate already removed every out-of-scope document and the
      // exact-filter totals are safe to publish.
      ...(page.dropped ? {} : { totals: out.totals }),
    });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('invoices.view'), async (req, res) => {
  try {
    const scope = await SalesScope.forRequest(db, req);
    const out = await db.withTransaction((c) => InvoiceService.getWithLines(c, req.params.id));
    // Out-of-scope reads answer 404, not 403: a 403 would confirm the invoice
    // exists, which is enough to enumerate another branch's document numbering
    // and trading volume without ever reading a line. Checked before the ZATCA
    // decode below so nothing about the other branch's seller block is computed.
    SalesScope.assertRowInScope(scope, out, 'الفاتورة غير موجودة');
    // Print support: the QR image and the frozen seller block both come from
    // the persisted TLV (clients never encode QRs; ar_documents has no seller
    // columns — the stamp is the issue-time truth).
    if (out && out.zatca_qr_base64) {
      out.zatca_qr_data_url = await Zqr.zatcaQrDataUrl(out.zatca_qr_base64);
      out.seller = Zqr.decodeZatcaTlv(out.zatca_qr_base64);
    }
    return H.sendData(res, out);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/', requireCapability('invoices.create'), async (req, res) => {
  try {
    const idemKey = H.idemOf(req);
    const reqHash = H.requestHashOf(req);
    const body = Object.assign({}, req.body || {}, { idempotencyKey: idemKey, requestHash: reqHash });
    let out;
    try {
      out = await db.withTransaction((c) => InvoiceService.createDraft(c, body, H.actorOf(req)));
    } catch (e) {
      // Parallel same-key race — recover on the POOL (see returns.js).
      const prior = idemKey && e && e.code === 'ER_DUP_ENTRY'
        ? await events.findPrior(db, 'ar_document', 'create', '', idemKey, reqHash) : null;
      if (!prior) throw e;
      out = await db.withTransaction((c) => InvoiceService.getWithLines(c, prior.entity_id));
    }
    return H.sendOk(res, { data: out, documentNumber: out.document_number, status: out.status, version: out.version }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/issue', requireCapability('invoices.issue'), async (req, res) => {
  try {
    const has = await requireCapability.hasCapability(req.user, 'credit.override');
    const r = await InvoiceService.issue(req.params.id, {
      actor: H.actorOf(req), actorId: H.actorIdOf(req),
      expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      requestHash: H.requestHashOf(req),
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
