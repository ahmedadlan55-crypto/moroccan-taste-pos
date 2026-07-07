/**
 * routes/order-to-cash/customers.js — customer master + 360 + statement + merge.
 * Reads guarded by customers.view; writes by customers.create/edit/deactivate;
 * merge by customers.merge. Actor always from the JWT.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const CustomerService = require('../../services/order-to-cash/CustomerService');
const StatementService = require('../../services/order-to-cash/CustomerStatementService');
const CreditLimitService = require('../../services/order-to-cash/CreditLimitService');
const MergeService = require('../../services/order-to-cash/CustomerMergeService');

// ── list + search ────────────────────────────────────────────────────────────
router.get('/', requireCapability('customers.view'), async (req, res) => {
  try {
    const out = await CustomerService.list({
      q: req.query.q, type: req.query.type, active: req.query.active, brandId: req.query.brandId,
      page: req.query.page, pageSize: req.query.pageSize, sort: req.query.sort, dir: req.query.dir,
    });
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

// search (combobox: first page instantly, then server search)
router.get('/search', requireCapability('customers.view'), async (req, res) => {
  try {
    const out = await CustomerService.list({ q: req.query.q, active: 'true', pageSize: req.query.pageSize || 20, sort: 'name', dir: 'ASC' });
    return H.sendData(res, out.data, { pagination: out.pagination });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('customers.view'), async (req, res) => {
  try { return H.sendData(res, await CustomerService.get(req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

router.get('/:id/360', requireCapability('customers.view'), async (req, res) => {
  try { return H.sendData(res, await StatementService.customer360(req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

router.get('/:id/statement', requireCapability('customers.view'), async (req, res) => {
  try { return H.sendData(res, await StatementService.statement(req.params.id, { from: req.query.from, to: req.query.to })); }
  catch (e) { return H.sendErr(res, e); }
});

router.get('/:id/exposure', requireCapability('customers.view'), async (req, res) => {
  try { return H.sendData(res, await CreditLimitService.exposure(req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

// ── create / update / (de)activate ───────────────────────────────────────────
router.post('/', requireCapability('customers.create'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => CustomerService.create(c, req.body || {}, H.actorOf(req)));
    return H.sendOk(res, { data: out, status: out.isActive ? 'active' : 'inactive' }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

router.put('/:id', requireCapability('customers.edit'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => CustomerService.update(c, req.params.id, req.body || {}, H.actorOf(req)));
    return H.sendOk(res, { data: out });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/deactivate', requireCapability('customers.deactivate'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => CustomerService.deactivate(c, req.params.id, H.actorOf(req)));
    return H.sendOk(res, { data: out, status: 'inactive' });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/activate', requireCapability('customers.edit'), async (req, res) => {
  try {
    const out = await db.withTransaction((c) => CustomerService.activate(c, req.params.id, H.actorOf(req)));
    return H.sendOk(res, { data: out, status: 'active' });
  } catch (e) { return H.sendErr(res, e); }
});

// ── merge (preview + apply) ──────────────────────────────────────────────────
router.get('/:id/merge-preview', requireCapability('customers.merge'), async (req, res) => {
  try {
    if (!req.query.target) throw require('../../lib/order-to-cash/errors').err('VALIDATION_ERROR', 'العميل الهدف مطلوب');
    return H.sendData(res, await MergeService.preview(req.params.id, String(req.query.target)));
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/merge', requireCapability('customers.merge'), async (req, res) => {
  try {
    const target = (req.body && req.body.targetId) || '';
    const out = await MergeService.apply(req.params.id, target, H.actorOf(req));
    return H.sendOk(res, { data: out });
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
