/**
 * Item Master & Replenishment — Phase 4A.
 *
 * The professional item-catalog + per-warehouse replenishment layer under
 *   /api/inventory/v2/{items,replenishment,categories,units}
 * EXTENDS the existing inv_items (additively) — it never duplicates it. The
 * legacy /api/inventory/items + sales/purchases that write inv_items.stock/cost
 * directly keep working untouched.
 *
 * Business rules enforced here:
 *   • SKU unique after trim + upper-case (sku_norm).
 *   • No HARD-delete of an item with stock / movements / history — only soft
 *     deactivate (active=0), which preserves the audit trail.
 *   • Inactive items can't enter NEW v2 documents (guard added to the doc builders).
 *   • SKU change after movements = HARD-BLOCK; unit change after movements = HARD-BLOCK.
 *   • Editing the GLOBAL cost touches ONLY inv_items.cost — never warehouse WAC.
 *   • Every mutation: expectedVersion + Idempotency-Key (create/rule) + JWT actor + RBAC + scope + audit.
 *
 * Replenishment is ADVISORY — it never creates a purchase order.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const C = require('../lib/inventoryTxContract');
const IDEM = require('../lib/idempotencyStore');
const REP = require('../lib/replenishmentEngine');
const CSV = require('../lib/csvExport');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const BACKOFFICE = requireRole('admin', 'manager', 'employee', 'custody');
const LOOKBACK_DAYS = (() => { const n = Number(process.env.REPLENISH_LOOKBACK_DAYS); return Number.isFinite(n) && n > 0 ? n : 30; })();

// ── helpers (mirror routes/inventory-transactions.js) ───────────────────────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _expectedVersion(req) {
  const raw = (req.body && req.body.expectedVersion != null) ? req.body.expectedVersion : (req.get && req.get('If-Match'));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  return res.status(C.httpFor(code)).json(C.errorBody(code, message || (codeOrErr && codeOrErr.message) || code));
}
function _catch(res, e) {
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) return _fail(res, 'VALIDATION_ERROR', 'الـ SKU مستخدم لصنف آخر');
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
function _ok(res, parts, legacy, statusCode) {
  const body = Object.assign({}, C.mutationEnvelope(parts), legacy || {});
  res.status(statusCode || 200).json(body);
  return body;
}
async function _audit(conn, docId, action, fromStatus, toStatus, actor, note, payload) {
  const q = conn || db;
  try {
    await q.query('INSERT INTO inv_tx_events (id, doc_type, doc_id, action, from_status, to_status, actor, note, payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
      ['EV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), 'item', docId, action, fromStatus || null, toStatus || null, actor || '', String(note || '').slice(0, 500), payload ? JSON.stringify(payload).slice(0, 8000) : null]);
  } catch (_) { /* best-effort */ }
  return { docType: 'item', docId, action, actor: actor || '', at: new Date().toISOString() };
}
function _skuNorm(sku) { return String(sku == null ? '' : sku).trim().toUpperCase(); }
async function _hasMovements(itemId, conn) { const [r] = await (conn || db).query('SELECT 1 FROM inventory_movements WHERE item_id=? LIMIT 1', [itemId]); return r.length > 0; }
async function _loadItem(id, conn) { const [r] = await (conn || db).query('SELECT * FROM inv_items WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]); return r[0] || null; }

function _validateBasics(b, { requireSku }) {
  const name = String(b.name == null ? '' : b.name).trim();
  if (!name) throw _err('VALIDATION_ERROR', 'اسم الصنف مطلوب');
  const unit = String(b.unit == null ? '' : b.unit).trim();
  if (!unit) throw _err('VALIDATION_ERROR', 'الوحدة مطلوبة');
  const sku = String(b.sku == null ? '' : b.sku).trim();
  if (requireSku && !sku) throw _err('VALIDATION_ERROR', 'الـ SKU مطلوب');
  if (b.cost != null && (!Number.isFinite(Number(b.cost)) || Number(b.cost) < 0)) throw _err('VALIDATION_ERROR', 'التكلفة لا يمكن أن تكون سالبة');
  return { name, unit, sku };
}

// ════════════════════════════════════════════════════════════════════════════
// CATEGORIES + UNITS (read)
// ════════════════════════════════════════════════════════════════════════════
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT DISTINCT category AS c FROM inv_items WHERE active=1 AND deleted_at IS NULL AND category IS NOT NULL AND category<>'' ORDER BY category");
    res.json({ data: rows.map((r) => r.c) });
  } catch (e) { _catch(res, e); }
});
router.get('/units', async (req, res) => {
  try {
    let rows = [];
    try { const [u] = await db.query('SELECT id, name_ar, name_en, type FROM units ORDER BY id'); rows = u; } catch (_) { rows = []; }
    if (!rows.length) { const [u2] = await db.query("SELECT DISTINCT unit AS id FROM inv_items WHERE unit IS NOT NULL AND unit<>'' ORDER BY unit"); rows = u2.map((r) => ({ id: r.id, name_ar: r.id, name_en: r.id, type: '' })); }
    res.json({ data: rows.map((r) => ({ code: r.id, nameAr: r.name_ar || r.id, nameEn: r.name_en || r.id, type: r.type || '' })) });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// REPLENISHMENT (advisory — never creates a PO)
// ════════════════════════════════════════════════════════════════════════════
function _replenWhere(req, p) {
  const sc = req.whScopeClause ? req.whScopeClause('ws.warehouse_id') : { sql: '', params: [] };
  const where = ['ii.deleted_at IS NULL'];
  const params = [];
  if (p.warehouseId) { where.push('ws.warehouse_id=?'); params.push(p.warehouseId); }
  if (p.category) { where.push('ii.category=?'); params.push(p.category); }
  if (p.q) { where.push('(ii.name LIKE ? OR ii.sku LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%'); }
  return { sql: ' WHERE ' + where.join(' AND ') + (sc.sql || ''), params: params.concat(sc.params || []) };
}
// One outbound-rate + rule + stock row → an engine recommendation row.
function _replRow(r) {
  const rule = {
    minQty: Number(r.min_qty) || 0, reorderPoint: r.reorder_point != null ? Number(r.reorder_point) : (Number(r.min_stock) || 0),
    reorderQty: Number(r.reorder_qty) || 0, maxStock: Number(r.max_stock) || 0, safetyStock: Number(r.safety_stock) || 0,
    leadTimeDays: Number(r.lead_time_days) || 0, isEnabled: r.is_enabled == null ? true : !!r.is_enabled,
  };
  const isActive = Number(r.active) !== 0; // inactive → recommendedQty 0 + 'inactive_balance' status
  const eng = REP.computeReplenishment({ onHand: Number(r.qty) || 0, avgDailyOut: REP.avgDailyOut(Number(r.out_qty) || 0, LOOKBACK_DAYS), hasRule: r.rule_id != null, rule, isActive });
  return {
    itemId: r.item_id, sku: r.sku || r.item_id, name: r.name, unit: r.unit, category: r.category, isActive,
    warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, cost: Number(r.cost) || Number(r.avg_cost) || 0,
    reorderPoint: rule.reorderPoint, reorderQty: rule.reorderQty, maxStock: rule.maxStock, safetyStock: rule.safetyStock, leadTimeDays: rule.leadTimeDays,
    onHand: eng.onHand, available: eng.available, avgDailyOutbound: eng.avgDailyOutbound, daysOfCover: eng.daysOfCover,
    reorderStatus: eng.reorderStatus, recommendedQty: eng.recommendedQty, stockoutRisk: eng.stockoutRisk,
    recommendedValue: REP.round3(eng.recommendedQty * (Number(r.cost) || Number(r.avg_cost) || 0)),
    hasRule: eng.hasRule, lastMovementAt: r.last_movement_at || null,
  };
}
const REPL_SELECT =
  'SELECT ws.warehouse_id, ws.qty, ws.avg_cost, w.name AS warehouse_name, ii.id AS item_id, ii.name, ii.sku, ii.unit, ii.category, ii.cost, ii.min_stock, ii.active, ' +
  ' wir.id AS rule_id, wir.min_qty, wir.reorder_point, wir.reorder_qty, wir.max_stock, wir.safety_stock, wir.lead_time_days, wir.is_enabled, ' +
  ' (SELECT COALESCE(SUM(m.qty),0) FROM inventory_movements m WHERE m.item_id=ii.id AND m.type=\'out\' AND m.warehouse_id=ws.warehouse_id AND m.movement_date >= DATE_SUB(CURDATE(), INTERVAL ' + LOOKBACK_DAYS + ' DAY)) AS out_qty, ' +
  ' (SELECT MAX(m2.movement_date) FROM inventory_movements m2 WHERE m2.item_id=ii.id AND m2.warehouse_id=ws.warehouse_id) AS last_movement_at ' +
  'FROM warehouse_stock ws JOIN inv_items ii ON ii.id=ws.item_id LEFT JOIN warehouses w ON w.id=ws.warehouse_id ' +
  'LEFT JOIN warehouse_item_rules wir ON wir.item_id=ii.id AND wir.warehouse_id=ws.warehouse_id';

router.get('/replenishment', async (req, res) => {
  try {
    const p = C.parseListQuery(req.query, ['name', 'qty', 'recommended'], []);
    p.warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
    p.category = req.query.category ? String(req.query.category) : '';
    const riskFilter = ['high', 'medium', 'low', 'unknown'].indexOf(String(req.query.risk || '')) !== -1 ? String(req.query.risk) : '';
    const statusFilter = ['negative', 'critical', 'reorder', 'watch', 'ok', 'inactive_balance'].indexOf(String(req.query.status || '')) !== -1 ? String(req.query.status) : '';
    const w = _replenWhere(req, p);
    const [rows] = await db.query(REPL_SELECT + w.sql + ' ORDER BY ii.name', w.params);
    let computed = rows.map(_replRow);
    if (riskFilter) computed = computed.filter((r) => r.stockoutRisk === riskFilter);
    if (statusFilter) computed = computed.filter((r) => r.reorderStatus === statusFilter);
    const total = computed.length;
    const pageRows = computed.slice(p.offset, p.offset + p.pageSize);
    res.json({ data: pageRows, pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) }, lookbackDays: LOOKBACK_DAYS, filters: { warehouseId: p.warehouseId, category: p.category, risk: riskFilter, status: statusFilter, q: p.q } });
  } catch (e) { _catch(res, e); }
});

router.get('/replenishment/summary', async (req, res) => {
  try {
    const p = { warehouseId: req.query.warehouseId ? String(req.query.warehouseId) : '', category: req.query.category ? String(req.query.category) : '', q: '' };
    const w = _replenWhere(req, p);
    const [rows] = await db.query(REPL_SELECT + w.sql, w.params);
    const computed = rows.map(_replRow);
    const byStatus = { negative: 0, critical: 0, reorder: 0, watch: 0, ok: 0, inactive_balance: 0 };
    const byRisk = { high: 0, medium: 0, low: 0, unknown: 0 };
    let recommendedValue = 0, reorderItems = 0;
    for (const r of computed) {
      byStatus[r.reorderStatus] = (byStatus[r.reorderStatus] || 0) + 1;
      byRisk[r.stockoutRisk] = (byRisk[r.stockoutRisk] || 0) + 1;
      recommendedValue += r.recommendedValue;
      if (r.recommendedQty > 0) reorderItems++;
    }
    res.json({ data: { total: computed.length, reorderItems, recommendedValue: REP.round3(recommendedValue), byStatus, byRisk, lookbackDays: LOOKBACK_DAYS } });
  } catch (e) { _catch(res, e); }
});

router.get('/replenishment/export', async (req, res) => {
  try {
    const p = { warehouseId: req.query.warehouseId ? String(req.query.warehouseId) : '', category: req.query.category ? String(req.query.category) : '', q: req.query.q ? String(req.query.q).slice(0, 120) : '' };
    const w = _replenWhere(req, p);
    const [rows] = await db.query(REPL_SELECT + w.sql + ' ORDER BY ii.name', w.params);
    let computed = rows.map(_replRow);
    const riskFilter = ['high', 'medium', 'low', 'unknown'].indexOf(String(req.query.risk || '')) !== -1 ? String(req.query.risk) : '';
    if (riskFilter) computed = computed.filter((r) => r.stockoutRisk === riskFilter);
    const headers = ['الصنف', 'SKU', 'المستودع', 'الكمية الحالية', 'حد إعادة الطلب', 'الكمية المقترحة', 'أيام التغطية', 'مخاطر النفاد', 'آخر حركة'];
    const body = computed.map((r) => [r.name, r.sku, r.warehouseName, r.onHand, r.reorderPoint, r.recommendedQty, r.daysOfCover == null ? '—' : r.daysOfCover, r.stockoutRisk, r.lastMovementAt || '']);
    const csv = CSV.toCsv(headers, body);
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="replenishment-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send(csv);
  } catch (e) {
    if (e && e.code === 'EXPORT_LIMIT') return res.status(413).json({ error: e.message });
    _catch(res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ITEMS — list + detail
// ════════════════════════════════════════════════════════════════════════════
router.get('/items', async (req, res) => {
  try {
    const p = C.parseListQuery(req.query, ['name', 'sku', 'category', 'created_at'], []);
    const status = ['active', 'inactive'].indexOf(String(req.query.status || '')) !== -1 ? String(req.query.status) : '';
    const category = req.query.category ? String(req.query.category) : '';
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
    const where = ['ii.deleted_at IS NULL']; const params = [];
    if (status === 'active') where.push('ii.active=1'); else if (status === 'inactive') where.push('ii.active=0');
    if (category) { where.push('ii.category=?'); params.push(category); }
    if (p.q) {
      // Phase W4 — also match the (normalized) barcode so a scanner typing into
      // the search box finds the item directly (primary + secondary codes).
      const bq = require('../lib/barcode').normalize(p.q);
      where.push('(ii.name LIKE ? OR ii.sku LIKE ? OR ii.barcode_norm=? OR EXISTS (SELECT 1 FROM item_barcodes ib WHERE ib.item_id=ii.id AND ib.code_norm=?))');
      params.push('%' + p.q + '%', '%' + p.q + '%', bq, bq);
    }
    let join = '';
    if (warehouseId) { join = ' JOIN warehouse_stock ws ON ws.item_id=ii.id AND ws.warehouse_id=?'; params.unshift(warehouseId); }
    const sortCol = ({ name: 'ii.name', sku: 'ii.sku', category: 'ii.category', created_at: 'ii.created_at' })[p.sort] || 'ii.name';
    const [rows] = await db.query(
      'SELECT ii.id, ii.name, ii.name_en, ii.sku, ii.category, ii.unit, ii.cost, ii.stock, ii.min_stock, ii.active, ii.kind, ii.version, ii.default_warehouse_id, ii.created_at FROM inv_items ii' + join +
      ' WHERE ' + where.join(' AND ') + ' ORDER BY ' + sortCol + ' ' + p.dir + ' LIMIT ? OFFSET ?', params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM inv_items ii' + join + ' WHERE ' + where.join(' AND '), params);
    const [kpi] = await db.query("SELECT COUNT(*) AS total, SUM(active=1) AS active, SUM(active=0) AS inactive, SUM(sku IS NULL OR sku='') AS no_sku FROM inv_items WHERE deleted_at IS NULL");
    const total = Number(cnt[0].total) || 0; const k = kpi[0] || {};
    res.json({
      data: rows,
      pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) },
      kpis: { total: Number(k.total) || 0, active: Number(k.active) || 0, inactive: Number(k.inactive) || 0, noSku: Number(k.no_sku) || 0 },
      filters: { status, category, warehouseId, q: p.q, sort: p.sort, dir: p.dir },
    });
  } catch (e) { _catch(res, e); }
});

// ─── Phase B — unified searchable item picker for every "add material" dialog ──
// GET /item-search?q=&warehouseId=&context=&category=&activeOnly=&page=&pageSize=
// Server-side search over name/name_en/sku/barcode/code/category. Returns the
// data the SearchableEntityCombobox needs: name, sku, primary barcode, base +
// major unit, the balance in the chosen warehouse, status, trackingMode and a
// low/out/negative warning. Warehouse-scope enforced; inactive items are hidden
// in input contexts (activeOnly default true) but visible for reports/correction.
router.get('/item-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : '';
    const context = String(req.query.context || '').trim();
    const category = req.query.category ? String(req.query.category) : '';
    // input contexts hide inactive by default; reports/correction can pass activeOnly=0
    const reportCtx = ['report', 'reports', 'correction', 'audit'].indexOf(context) !== -1;
    const activeOnly = req.query.activeOnly != null ? String(req.query.activeOnly) !== '0' : !reportCtx;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    if (warehouseId && req.guardWh && !req.guardWh(res, warehouseId)) return; // scope: no leak

    const where = ['ii.deleted_at IS NULL']; const params = [];
    if (activeOnly) where.push('ii.active=1');
    if (category) { where.push('ii.category=?'); params.push(category); }
    let exactBarcodeId = null;
    if (q) {
      const bq = require('../lib/barcode').normalize(q);
      where.push('(ii.name LIKE ? OR ii.name_en LIKE ? OR ii.sku LIKE ? OR ii.category LIKE ? OR ii.barcode_norm=? OR EXISTS (SELECT 1 FROM item_barcodes ib WHERE ib.item_id=ii.id AND ib.code_norm=?))');
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%', bq, bq);
      // exact unique barcode → caller can auto-select
      const [bx] = await db.query('SELECT item_id FROM item_barcodes WHERE code_norm=? UNION SELECT id FROM inv_items WHERE barcode_norm=? LIMIT 2', [bq, bq]);
      if (bx.length === 1) exactBarcodeId = bx[0].item_id;
    }
    // warehouse-scope clause (only rows in warehouses the user may see, when no explicit wh)
    if (!warehouseId && req.whScopeClause) {
      const sc = req.whScopeClause('ws2.warehouse_id');
      if (sc && sc.sql) { where.push('(EXISTS (SELECT 1 FROM warehouse_stock ws2 WHERE ws2.item_id=ii.id AND ' + sc.sql + ') OR NOT EXISTS (SELECT 1 FROM warehouse_stock ws3 WHERE ws3.item_id=ii.id))'); params.push(...sc.params); }
    }

    const stockJoin = warehouseId ? ' LEFT JOIN warehouse_stock ws ON ws.item_id=ii.id AND ws.warehouse_id=?' : '';
    const selBal = warehouseId ? 'ws.qty AS wh_qty, ws.avg_cost AS wh_cost' : 'NULL AS wh_qty, NULL AS wh_cost';
    const qp = warehouseId ? [warehouseId, ...params] : params;
    const [rows] = await db.query(
      'SELECT ii.id, ii.name, ii.name_en, ii.sku, ii.category, ii.unit, ii.cost, ii.stock, ii.min_stock, ii.active, ii.kind, ii.tracking_mode, ii.barcode, ' + selBal +
      ' FROM inv_items ii' + stockJoin + ' WHERE ' + where.join(' AND ') + ' ORDER BY ii.active DESC, ii.name LIMIT ? OFFSET ?',
      qp.concat([pageSize, offset]));
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM inv_items ii WHERE ' + where.join(' AND '), params);

    // units for the page (base + major) in one query
    const ids = rows.map((r) => r.id);
    let unitsByItem = {};
    if (ids.length) {
      const [us] = await db.query('SELECT item_id, unit_name, unit_code, is_base, conversion_to_base, is_active FROM item_units WHERE item_id IN (?) AND is_active=1 ORDER BY is_base DESC, conversion_to_base ASC', [ids]);
      for (const u of us) { (unitsByItem[u.item_id] = unitsByItem[u.item_id] || []).push(u); }
    }
    const [pb] = ids.length ? await db.query("SELECT item_id, code FROM item_barcodes WHERE item_id IN (?) AND is_primary=1", [ids]) : [[]];
    const primaryBc = {}; for (const b of pb) primaryBc[b.item_id] = b.code;

    const data = rows.map((r) => {
      const units = unitsByItem[r.id] || [];
      const base = units.find((u) => u.is_base) || { unit_name: r.unit, unit_code: r.unit, conversion_to_base: 1, is_base: 1 };
      const majors = units.filter((u) => !u.is_base).map((u) => ({ unitCode: u.unit_code, unitName: u.unit_name, factor: Number(u.conversion_to_base) }));
      const whQty = r.wh_qty == null ? null : Number(r.wh_qty);
      let warning = null;
      if (whQty != null) { if (whQty < 0) warning = 'negative'; else if (whQty <= 0) warning = 'out'; else if (Number(r.min_stock) > 0 && whQty <= Number(r.min_stock)) warning = 'low'; }
      return {
        id: r.id, name: r.name, nameEn: r.name_en, sku: r.sku, category: r.category,
        primaryBarcode: primaryBc[r.id] || r.barcode || null,
        baseUnit: { code: base.unit_code, name: base.unit_name }, majorUnits: majors,
        trackingMode: r.tracking_mode || 'none', active: r.active === 1 || r.active === true,
        warehouseQty: whQty, warehouseCost: r.wh_cost == null ? null : Number(r.wh_cost), warning,
      };
    });
    res.json({
      data,
      pagination: { page, pageSize, total: Number(cnt[0].total) || 0, totalPages: Math.max(1, Math.ceil((Number(cnt[0].total) || 0) / pageSize)) },
      exactBarcodeId, filters: { q, warehouseId, context, category, activeOnly },
    });
  } catch (e) { _catch(res, e); }
});

router.get('/items/:id/warehouses', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT ws.warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code, w.is_main, ws.qty, ws.avg_cost, (ws.qty*ws.avg_cost) AS value, ' +
      ' wir.reorder_point, wir.reorder_qty, wir.max_stock, wir.safety_stock, wir.lead_time_days, wir.is_enabled, wir.version AS rule_version ' +
      'FROM warehouse_stock ws LEFT JOIN warehouses w ON w.id=ws.warehouse_id LEFT JOIN warehouse_item_rules wir ON wir.item_id=ws.item_id AND wir.warehouse_id=ws.warehouse_id ' +
      'WHERE ws.item_id=? ORDER BY w.is_main DESC, w.name', [req.params.id]);
    res.json({ data: rows });
  } catch (e) { _catch(res, e); }
});

// Phase W4 — GET /items/by-barcode?code=X (registered BEFORE /items/:id so the
// literal path is not shadowed by the :id param). item_barcodes → inv_items.
router.get('/items/by-barcode', async (req, res) => {
  try {
    const BCq = require('../lib/barcode');
    const norm = BCq.normalize(req.query.code || '');
    if (!norm) return _fail(res, 'VALIDATION_ERROR', 'الرجاء تمرير code');
    let matchedBarcode = null, sizeVariant = null, itemId = null;
    const [b] = await db.query('SELECT item_id, code, size_variant FROM item_barcodes WHERE code_norm=? LIMIT 1', [norm]);
    if (b.length) { itemId = b[0].item_id; matchedBarcode = b[0].code; sizeVariant = b[0].size_variant; }
    else {
      const [p] = await db.query('SELECT id, barcode FROM inv_items WHERE barcode_norm=? LIMIT 1', [norm]);
      if (p.length) { itemId = p[0].id; matchedBarcode = p[0].barcode; }
    }
    if (!itemId) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'لا يوجد صنف بهذا الباركود', data: null });
    const item = await _loadItem(itemId);
    res.json({ success: true, data: { item, matchedBarcode, sizeVariant } });
  } catch (e) { _catch(res, e); }
});

router.get('/items/:id', async (req, res) => {
  try {
    const item = await _loadItem(req.params.id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    const [dist] = await db.query('SELECT ws.warehouse_id, w.name AS warehouse_name, w.is_main, ws.qty, ws.avg_cost, (ws.qty*ws.avg_cost) AS value FROM warehouse_stock ws LEFT JOIN warehouses w ON w.id=ws.warehouse_id WHERE ws.item_id=? ORDER BY w.is_main DESC, w.name', [item.id]);
    const [rules] = await db.query('SELECT * FROM warehouse_item_rules WHERE item_id=?', [item.id]);
    const [movements] = await db.query('SELECT id, movement_date, type, qty, reason, warehouse_id, reference_type FROM inventory_movements WHERE item_id=? ORDER BY seq DESC LIMIT 20', [item.id]);
    const [events] = await db.query("SELECT * FROM inv_tx_events WHERE doc_type='item' AND doc_id=? ORDER BY created_at ASC, id ASC", [item.id]);
    const [barcodes] = await db.query('SELECT id, code, size_variant, is_primary FROM item_barcodes WHERE item_id=? ORDER BY is_primary DESC, id', [item.id]).catch(() => [[]]);
    res.json({ data: item, distribution: dist, rules, movements, timeline: events, barcodes });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE / PATCH / activate / deactivate
// ════════════════════════════════════════════════════════════════════════════
router.post('/items', BACKOFFICE, async (req, res) => {
  let idemId = null;
  try {
    const actor = _actor(req); const b = req.body || {};
    const v = _validateBasics(b, { requireSku: true });
    const skuNorm = _skuNorm(v.sku);

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'item:create', '', key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إنشاء مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await db.withTransaction(async (conn) => {
      const [dup] = await conn.query('SELECT id FROM inv_items WHERE sku_norm=? LIMIT 1', [skuNorm]);
      if (dup.length) throw _err('VALIDATION_ERROR', 'الـ SKU "' + v.sku + '" مستخدم لصنف آخر');
      const id = 'INV-' + crypto.randomBytes(7).toString('hex');
      await conn.query(
        'INSERT INTO inv_items (id, name, name_en, sku, sku_norm, category, unit, big_unit, conv_rate, cost, stock, min_stock, max_stock, active, kind, brand_id, default_warehouse_id, description, notes, version) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?,?,?,?,1)',
        [id, v.name, (b.nameEn || '').toString().slice(0, 200) || null, v.sku, skuNorm, (b.category || '').toString().slice(0, 100) || null, v.unit,
          (b.bigUnit || '').toString().slice(0, 50) || null, Number.isFinite(Number(b.convRate)) && Number(b.convRate) > 0 ? Number(b.convRate) : 1,
          Number.isFinite(Number(b.cost)) ? Number(b.cost) : 0, Number.isFinite(Number(b.minStock)) ? Number(b.minStock) : 0,
          Number.isFinite(Number(b.maxStock)) ? Number(b.maxStock) : 0, (['raw', 'semi'].indexOf(String(b.kind)) !== -1 ? String(b.kind) : 'raw'),
          (b.brandId || null), (b.defaultWarehouseId || null), (b.description || '').toString().slice(0, 5000) || null, (b.notes || '').toString().slice(0, 500) || null]);
      const auditEvent = await _audit(conn, id, 'create', null, 'active', actor, 'إنشاء صنف', { sku: v.sku });
      return { id, auditEvent };
    });
    const body = Object.assign({}, C.mutationEnvelope({ data: { id: out.id }, documentNumber: v.sku, status: 'active', version: 1, auditEvent: out.auditEvent }), { id: out.id });
    if (idemId) await IDEM.complete(db, idemId, 201, body);
    return res.status(201).json(body);
  } catch (e) { if (idemId) await IDEM.abort(db, idemId).catch(() => {}); _catch(res, e); }
});

router.patch('/items/:id', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const b = req.body || {};
    const expected = _expectedVersion(req);
    if (expected == null) return _fail(res, 'VALIDATION_ERROR', 'expectedVersion مطلوب للتعديل');
    const item = await _loadItem(id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    const out = await db.withTransaction(async (conn) => {
      const cur = await _loadItem(id, conn); // FOR UPDATE
      if (Number(cur.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الصنف منذ آخر تحميل — أعد التحميل');
      const sets = ['version=version+1']; const vals = [];
      const moved = await _hasMovements(id, conn);
      // SKU change after movements = HARD-BLOCK.
      if (b.sku !== undefined && _skuNorm(b.sku) !== _skuNorm(cur.sku)) {
        if (moved) throw _err('VALIDATION_ERROR', 'لا يمكن تغيير SKU بعد وجود حركات للصنف');
        const sku = String(b.sku).trim(); const skuNorm = _skuNorm(sku);
        if (!sku) throw _err('VALIDATION_ERROR', 'الـ SKU لا يمكن أن يكون فارغًا');
        const [dup] = await conn.query('SELECT id FROM inv_items WHERE sku_norm=? AND id<>? LIMIT 1', [skuNorm, id]);
        if (dup.length) throw _err('VALIDATION_ERROR', 'الـ SKU "' + sku + '" مستخدم لصنف آخر');
        sets.push('sku=?', 'sku_norm=?'); vals.push(sku, skuNorm);
      }
      // Unit change after movements = HARD-BLOCK.
      if (b.unit !== undefined && String(b.unit).trim() !== String(cur.unit || '').trim()) {
        if (moved) throw _err('VALIDATION_ERROR', 'لا يمكن تغيير الوحدة بعد وجود حركات للصنف');
        if (!String(b.unit).trim()) throw _err('VALIDATION_ERROR', 'الوحدة مطلوبة');
        sets.push('unit=?'); vals.push(String(b.unit).trim());
      }
      if (b.name !== undefined) { const nm = String(b.name).trim(); if (!nm) throw _err('VALIDATION_ERROR', 'اسم الصنف مطلوب'); sets.push('name=?'); vals.push(nm); }
      if (b.nameEn !== undefined) { sets.push('name_en=?'); vals.push(String(b.nameEn).slice(0, 200) || null); }
      if (b.category !== undefined) { sets.push('category=?'); vals.push(String(b.category).slice(0, 100) || null); }
      // Editing the GLOBAL cost touches ONLY inv_items.cost — never warehouse WAC.
      if (b.cost !== undefined) { if (!Number.isFinite(Number(b.cost)) || Number(b.cost) < 0) throw _err('VALIDATION_ERROR', 'التكلفة لا يمكن أن تكون سالبة'); sets.push('cost=?'); vals.push(Number(b.cost)); }
      if (b.minStock !== undefined) { if (Number(b.minStock) < 0) throw _err('VALIDATION_ERROR', 'الحد الأدنى لا يمكن أن يكون سالبًا'); sets.push('min_stock=?'); vals.push(Number(b.minStock)); }
      if (b.maxStock !== undefined) { if (Number(b.maxStock) < 0) throw _err('VALIDATION_ERROR', 'الحد الأقصى لا يمكن أن يكون سالبًا'); sets.push('max_stock=?'); vals.push(Number(b.maxStock)); }
      if (b.defaultWarehouseId !== undefined) { sets.push('default_warehouse_id=?'); vals.push(b.defaultWarehouseId || null); }
      if (b.description !== undefined) { sets.push('description=?'); vals.push(String(b.description).slice(0, 5000) || null); }
      if (b.notes !== undefined) { sets.push('notes=?'); vals.push(String(b.notes).slice(0, 500) || null); }
      const [r] = await conn.query('UPDATE inv_items SET ' + sets.join(', ') + ' WHERE id=? AND version=?', vals.concat([id, expected]));
      if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر الصنف منذ آخر تحميل — أعد التحميل');
      const auditEvent = await _audit(conn, id, 'edit', 'active', 'active', actor, 'تعديل صنف', null);
      return { auditEvent };
    });
    return _ok(res, { data: { id }, documentNumber: item.sku, status: item.active ? 'active' : 'inactive', version: Number(item.version) + 1, auditEvent: out.auditEvent }, { id });
  } catch (e) { _catch(res, e); }
});

function _setActive(active) {
  return async (req, res) => {
    try {
      const actor = _actor(req); const id = req.params.id;
      const expected = _expectedVersion(req);
      const item = await _loadItem(id);
      if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
      if (!!Number(item.active) === active) return _fail(res, 'INVALID_STATE_TRANSITION', active ? 'الصنف نشط بالفعل' : 'الصنف غير نشط بالفعل');
      const out = await db.withTransaction(async (conn) => {
        const [r] = await conn.query('UPDATE inv_items SET active=?, version=version+1 WHERE id=? AND active=?' + (expected != null ? ' AND version=?' : ''),
          expected != null ? [active ? 1 : 0, id, active ? 0 : 1, expected] : [active ? 1 : 0, id, active ? 0 : 1]);
        if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر الصنف منذ آخر تحميل — أعد التحميل');
        const auditEvent = await _audit(conn, id, active ? 'activate' : 'deactivate', active ? 'inactive' : 'active', active ? 'active' : 'inactive', actor, req.body && req.body.reason, null);
        return { auditEvent };
      });
      return _ok(res, { data: { id }, documentNumber: item.sku, status: active ? 'active' : 'inactive', version: Number(item.version) + 1, auditEvent: out.auditEvent }, { id });
    } catch (e) { _catch(res, e); }
  };
}
router.post('/items/:id/activate', MGR, _setActive(true));
router.post('/items/:id/deactivate', MGR, _setActive(false));

// ════════════════════════════════════════════════════════════════════════════
// WAREHOUSE-ITEM RULES (upsert; scope-guarded; version + validation)
// ════════════════════════════════════════════════════════════════════════════
router.put('/items/:id/warehouse-rules/:warehouseId', BACKOFFICE, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const warehouseId = req.params.warehouseId; const b = req.body || {};
    if (req.guardWh && !req.guardWh(res, warehouseId)) return;
    const item = await _loadItem(id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    const [wh] = await db.query('SELECT id FROM warehouses WHERE id=? LIMIT 1', [warehouseId]);
    if (!wh.length) return _fail(res, 'VALIDATION_ERROR', 'المستودع غير موجود');
    let rule;
    try { rule = REP.validateRule(b); } catch (e) { return _fail(res, 'VALIDATION_ERROR', e.message); }
    const expected = _expectedVersion(req);

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'item:rule', id + ':' + warehouseId, key, actor, b);
    let idemId = null;
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;
    try {
      const out = await db.withTransaction(async (conn) => {
        const [ex] = await conn.query('SELECT * FROM warehouse_item_rules WHERE warehouse_id=? AND item_id=? LIMIT 1 FOR UPDATE', [warehouseId, id]);
        if (ex.length) {
          if (expected != null && Number(ex[0].version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّرت القاعدة منذ آخر تحميل — أعد التحميل');
          await conn.query('UPDATE warehouse_item_rules SET min_qty=?, reorder_point=?, reorder_qty=?, max_stock=?, safety_stock=?, lead_time_days=?, is_enabled=?, last_reviewed_at=NOW(), updated_by=?, version=version+1 WHERE warehouse_id=? AND item_id=?',
            [rule.minQty, rule.reorderPoint, rule.reorderQty, rule.maxStock, rule.safetyStock, rule.leadTimeDays, rule.isEnabled ? 1 : 0, actor, warehouseId, id]);
        } else {
          await conn.query('INSERT INTO warehouse_item_rules (id, warehouse_id, item_id, min_qty, reorder_point, reorder_qty, max_stock, safety_stock, lead_time_days, is_enabled, last_reviewed_at, created_by, updated_by, version) VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),?,?,1)',
            ['WIR-' + crypto.randomBytes(6).toString('hex'), warehouseId, id, rule.minQty, rule.reorderPoint, rule.reorderQty, rule.maxStock, rule.safetyStock, rule.leadTimeDays, rule.isEnabled ? 1 : 0, actor, actor]);
        }
        const [now] = await conn.query('SELECT version FROM warehouse_item_rules WHERE warehouse_id=? AND item_id=?', [warehouseId, id]);
        const auditEvent = await _audit(conn, id, 'rule', null, null, actor, 'قاعدة إعادة طلب للمستودع ' + warehouseId, { warehouseId, rule });
        return { version: Number(now[0] && now[0].version) || 1, auditEvent };
      });
      const body = Object.assign({}, C.mutationEnvelope({ data: { id, warehouseId }, status: 'saved', version: out.version, auditEvent: out.auditEvent }), { id, warehouseId });
      if (idemId) await IDEM.complete(db, idemId, 200, body);
      return res.status(200).json(body);
    } catch (e) { if (idemId) await IDEM.abort(db, idemId).catch(() => {}); throw e; }
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase W4 — Barcode: fast scan lookup + multi-code editor
// ════════════════════════════════════════════════════════════════════════════
const BC = require('../lib/barcode');

// PUT /items/:id/barcodes — replace the multi-code list (RBAC + expectedVersion + Audit).
// body: { primaryBarcode?, barcodes:[{code, sizeVariant?}], expectedVersion }
router.put('/items/:id/barcodes', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const b = req.body || {};
    const expected = _expectedVersion(req);
    const item = await _loadItem(id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    // Normalize + validate all provided codes; detect in-payload duplicates.
    const primary = b.primaryBarcode != null && String(b.primaryBarcode).trim() !== '' ? BC.requireValid(b.primaryBarcode) : null;
    const list = Array.isArray(b.barcodes) ? b.barcodes : [];
    const normed = [];
    const seen = new Set();
    if (primary) { seen.add(primary); }
    for (const it of list) {
      const code = BC.requireValid(it.code);
      if (seen.has(code)) throw _err('VALIDATION_ERROR', 'باركود مكرر في الطلب: ' + code);
      seen.add(code);
      normed.push({ code: String(it.code).trim().slice(0, 80), code_norm: code, size_variant: (it.sizeVariant || it.size_variant || '').toString().slice(0, 60) || null });
    }
    const out = await db.withTransaction(async (conn) => {
      const [cur] = await conn.query('SELECT id, version FROM inv_items WHERE id=? LIMIT 1 FOR UPDATE', [id]);
      if (!cur.length) throw _err('VALIDATION_ERROR', 'الصنف غير موجود');
      if (expected != null && Number(cur[0].version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الصنف منذ آخر تحميل — أعد التحميل');
      // Uniqueness across BOTH tables, excluding this item's own rows.
      for (const code of seen) {
        const [c1] = await conn.query('SELECT id FROM inv_items WHERE barcode_norm=? AND id<>? LIMIT 1', [code, id]);
        if (c1.length) throw _err('BARCODE_TAKEN', 'الباركود مستخدم لصنف آخر: ' + c1[0].id);
        const [c2] = await conn.query('SELECT item_id FROM item_barcodes WHERE code_norm=? AND item_id<>? LIMIT 1', [code, id]);
        if (c2.length) throw _err('BARCODE_TAKEN', 'الباركود مستخدم لصنف آخر: ' + c2[0].item_id);
      }
      // Primary → inv_items.barcode(+norm); secondaries → item_barcodes (replace all).
      await conn.query('UPDATE inv_items SET barcode=?, barcode_norm=?, version=version+1 WHERE id=?', [primary ? String(b.primaryBarcode).trim().slice(0, 80) : null, primary, id]);
      await conn.query('DELETE FROM item_barcodes WHERE item_id=?', [id]);
      for (const n of normed) {
        await conn.query('INSERT INTO item_barcodes (id, item_id, code, code_norm, size_variant, is_primary, created_by) VALUES (?,?,?,?,?,0,?)',
          ['IBC-' + crypto.randomBytes(6).toString('hex'), id, n.code, n.code_norm, n.size_variant, actor]);
      }
      const [now] = await conn.query('SELECT version FROM inv_items WHERE id=?', [id]);
      try {
        await conn.query('INSERT INTO inv_tx_events (id, doc_type, doc_id, action, actor, note, payload_json) VALUES (?,?,?,?,?,?,?)',
          ['EV-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), 'item', id, 'barcodes_changed', actor, 'تعديل باركودات الصنف', JSON.stringify({ primary, secondary: normed.map((x) => x.code_norm) }).slice(0, 8000)]);
      } catch (_) {}
      return { version: Number(now[0] && now[0].version) || 1 };
    });
    return res.status(200).json({ success: true, data: { id }, status: 'saved', version: out.version });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase U — Units & conversions per item (base + major units, frozen factors)
// GET  /items/:id/units → { item, units[], hasMovements }
// PUT  /items/:id/units → replace the unit set (RBAC + expectedVersion + audit +
//   factor-lock after history: once an item has posted movements you may NOT
//   change an existing unit's factor / base flag, nor delete an existing unit —
//   only add new major units, toggle allow_* flags, activate/deactivate, rename,
//   or (re)bind a per-unit barcode. Violations → UNIT_LOCKED_BY_HISTORY.
// ════════════════════════════════════════════════════════════════════════════
const UC = require('../lib/unitConversion');
const IU = require('../lib/itemUnits');

function _unitRowOut(r) {
  return {
    id: r.id, itemId: r.item_id, unitId: r.unit_id, unitName: r.unit_name, unitCode: r.unit_code,
    isBase: r.is_base === 1 || r.is_base === true, conversionToBase: Number(r.conversion_to_base),
    precision: Number(r.quantity_precision) || 2,
    allowPurchase: !!r.allow_purchase, allowReceipt: !!r.allow_receipt, allowIssue: !!r.allow_issue,
    allowTransfer: !!r.allow_transfer, allowStocktake: !!r.allow_stocktake,
    allowProduction: !!r.allow_production, allowSale: !!r.allow_sale,
    barcodeId: r.barcode_id, isActive: r.is_active === 1 || r.is_active === true, version: Number(r.version) || 1,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

router.get('/items/:id/units', async (req, res) => {
  try {
    const id = req.params.id;
    const item = await _loadItem(id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    const [rows] = await db.query('SELECT * FROM item_units WHERE item_id=? ORDER BY is_base DESC, conversion_to_base ASC', [id]);
    const hasMovements = await IU.itemHasMovements(db, id);
    res.json({
      success: true,
      data: {
        item: { id: item.id, name: item.name, unit: item.unit, version: Number(item.version) || 1 },
        units: rows.map(_unitRowOut),
        hasMovements,
      },
    });
  } catch (e) { _catch(res, e); }
});

router.put('/items/:id/units', MGR, async (req, res) => {
  try {
    const actor = _actor(req); const id = req.params.id; const b = req.body || {};
    const expected = _expectedVersion(req);
    const item = await _loadItem(id);
    if (!item) { const e = new Error('الصنف غير موجود'); e.status = 404; throw e; }
    const list = Array.isArray(b.units) ? b.units : null;
    if (!list || !list.length) return _fail(res, 'VALIDATION_ERROR', 'حدّد وحدة أساسية واحدة على الأقل');

    // Normalize incoming rows → the shape validateItemUnitSet expects.
    const norm = list.map((u) => {
      const code = String(u.unitCode || u.unit_code || '').trim().toUpperCase();
      const factor = Number(u.conversionToBase != null ? u.conversionToBase : u.conversion_to_base);
      return {
        unitCode: code,
        unitName: String(u.unitName || u.unit_name || code).trim().slice(0, 100),
        unitId: (u.unitId || u.unit_id) ? String(u.unitId || u.unit_id).slice(0, 20) : null,
        isBase: u.isBase === true || u.is_base === 1 || u.is_base === true,
        conversionToBase: factor,
        precision: Math.max(0, Math.min(6, Number(u.precision != null ? u.precision : u.quantity_precision) || 2)),
        allowPurchase: u.allowPurchase !== false && u.allow_purchase !== 0,
        allowReceipt: u.allowReceipt !== false && u.allow_receipt !== 0,
        allowIssue: u.allowIssue !== false && u.allow_issue !== 0,
        allowTransfer: u.allowTransfer !== false && u.allow_transfer !== 0,
        allowStocktake: u.allowStocktake !== false && u.allow_stocktake !== 0,
        allowProduction: u.allowProduction !== false && u.allow_production !== 0,
        allowSale: u.allowSale !== false && u.allow_sale !== 0,
        barcodeId: (u.barcodeId || u.barcode_id) ? String(u.barcodeId || u.barcode_id).slice(0, 50) : null,
        isActive: !(u.isActive === false || u.is_active === 0),
      };
    });
    // Structural validation (one base, base factor 1, positive factors, unique codes).
    const v = UC.validateItemUnitSet(norm);
    if (!v.ok) {
      const msg = { NO_BASE_UNIT: 'يجب تحديد وحدة أساسية واحدة', DUPLICATE_BASE_UNIT: 'لا يُسمح بأكثر من وحدة أساسية', BASE_FACTOR_NOT_ONE: 'عامل الوحدة الأساسية يجب أن يساوي 1', DUPLICATE_UNIT_CODE: 'رمز وحدة مكرر', INVALID_CONVERSION_FACTOR: 'عامل تحويل غير صالح (يجب أن يكون موجبًا)', UNIT_REQUIRED: 'رمز الوحدة مطلوب' }[v.code] || 'مجموعة وحدات غير صالحة';
      return _fail(res, v.code === 'DUPLICATE_BASE_UNIT' ? 'DUPLICATE_BASE_UNIT' : (v.code === 'INVALID_CONVERSION_FACTOR' ? 'INVALID_CONVERSION_FACTOR' : 'VALIDATION_ERROR'), msg);
    }

    const out = await db.withTransaction(async (conn) => {
      const [cur] = await conn.query('SELECT id, version FROM inv_items WHERE id=? LIMIT 1 FOR UPDATE', [id]);
      if (!cur.length) throw _err('VALIDATION_ERROR', 'الصنف غير موجود');
      if (expected != null && Number(cur[0].version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الصنف منذ آخر تحميل — أعد التحميل');
      const [exRows] = await conn.query('SELECT * FROM item_units WHERE item_id=? FOR UPDATE', [id]);
      const byCode = new Map(exRows.map((r) => [String(r.unit_code).toUpperCase(), r]));
      const hasMovements = await IU.itemHasMovements(conn, id);

      // Factor-lock after history: block factor/base changes + deletions of existing units.
      if (hasMovements) {
        const incomingCodes = new Set(norm.map((u) => u.unitCode));
        for (const ex of exRows) {
          const code = String(ex.unit_code).toUpperCase();
          if (!incomingCodes.has(code)) throw _err('UNIT_LOCKED_BY_HISTORY', 'لا يمكن حذف الوحدة "' + ex.unit_name + '" بعد وجود حركات — عطّلها بدل الحذف');
        }
        for (const u of norm) {
          const ex = byCode.get(u.unitCode);
          if (!ex) continue; // new units may be added freely
          if (UC.round(Number(ex.conversion_to_base), UC.MAX_PRECISION) !== UC.round(u.conversionToBase, UC.MAX_PRECISION)) {
            throw _err('UNIT_LOCKED_BY_HISTORY', 'لا يمكن تغيير عامل التحويل للوحدة "' + u.unitName + '" بعد وجود حركات — أضف وحدة جديدة بعامل مختلف');
          }
          if ((ex.is_base === 1) !== u.isBase) throw _err('UNIT_LOCKED_BY_HISTORY', 'لا يمكن تغيير الوحدة الأساسية بعد وجود حركات');
        }
      }

      // Per-unit barcode binding must be unique and belong to this item.
      const usedBc = new Set();
      for (const u of norm) {
        if (!u.barcodeId) continue;
        if (usedBc.has(u.barcodeId)) throw _err('BARCODE_UNIT_CONFLICT', 'باركود مرتبط بأكثر من وحدة في نفس الصنف');
        usedBc.add(u.barcodeId);
        const [bc] = await conn.query('SELECT item_id FROM item_barcodes WHERE id=? LIMIT 1', [u.barcodeId]);
        if (bc.length && String(bc[0].item_id) !== String(id)) throw _err('BARCODE_UNIT_CONFLICT', 'الباركود المرتبط بالوحدة يخص صنفًا آخر');
      }

      // Upsert: keep existing ids by code (preserves audit lineage); insert new; delete removed.
      const keepCodes = new Set(norm.map((u) => u.unitCode));
      for (const ex of exRows) {
        if (!keepCodes.has(String(ex.unit_code).toUpperCase())) {
          await conn.query('DELETE FROM item_units WHERE id=?', [ex.id]);
        }
      }
      for (const u of norm) {
        const ex = byCode.get(u.unitCode);
        const cols = [u.unitId, u.unitName, u.unitCode, u.isBase ? 1 : 0, u.conversionToBase, u.precision,
          u.allowPurchase ? 1 : 0, u.allowReceipt ? 1 : 0, u.allowIssue ? 1 : 0, u.allowTransfer ? 1 : 0,
          u.allowStocktake ? 1 : 0, u.allowProduction ? 1 : 0, u.allowSale ? 1 : 0, u.barcodeId, u.isActive ? 1 : 0];
        if (ex) {
          await conn.query(
            'UPDATE item_units SET unit_id=?, unit_name=?, unit_code=?, is_base=?, conversion_to_base=?, quantity_precision=?, allow_purchase=?, allow_receipt=?, allow_issue=?, allow_transfer=?, allow_stocktake=?, allow_production=?, allow_sale=?, barcode_id=?, is_active=?, version=version+1, updated_at=NOW(), updated_by=? WHERE id=?',
            cols.concat([actor, ex.id]));
        } else {
          await conn.query(
            'INSERT INTO item_units (id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base, quantity_precision, allow_purchase, allow_receipt, allow_issue, allow_transfer, allow_stocktake, allow_production, allow_sale, barcode_id, is_active, version, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NOW(),?)',
            ['IU-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), id, u.unitId, u.unitName, u.unitCode, u.isBase ? 1 : 0, u.conversionToBase, u.precision,
             u.allowPurchase ? 1 : 0, u.allowReceipt ? 1 : 0, u.allowIssue ? 1 : 0, u.allowTransfer ? 1 : 0, u.allowStocktake ? 1 : 0, u.allowProduction ? 1 : 0, u.allowSale ? 1 : 0, u.barcodeId, u.isActive ? 1 : 0, actor]);
        }
      }
      await conn.query('UPDATE inv_items SET version=version+1 WHERE id=?', [id]);
      const [now] = await conn.query('SELECT version FROM inv_items WHERE id=?', [id]);
      try {
        await conn.query('INSERT INTO inv_tx_events (id, doc_type, doc_id, action, actor, note, payload_json) VALUES (?,?,?,?,?,?,?)',
          ['EV-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), 'item', id, 'units_changed', actor, 'تعديل وحدات الصنف والتحويلات',
           JSON.stringify({ units: norm.map((u) => ({ code: u.unitCode, base: u.isBase, factor: u.conversionToBase })) }).slice(0, 8000)]);
      } catch (_) {}
      const [rows] = await conn.query('SELECT * FROM item_units WHERE item_id=? ORDER BY is_base DESC, conversion_to_base ASC', [id]);
      return { version: Number(now[0] && now[0].version) || 1, units: rows.map(_unitRowOut) };
    });
    return res.status(200).json({ success: true, data: { id, units: out.units }, status: 'saved', version: out.version });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
