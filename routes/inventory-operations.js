/**
 * Unified Inventory OPERATIONS read model (READ-ONLY).
 *
 *   GET /            → one paginated, filtered, sorted list over EVERY inventory
 *                      document header (inbound / transfer / production / issue /
 *                      adjustment / stocktake / procurement / legacy) + per-type
 *                      counts for the tabs.
 *   GET /meta        → the document-type list + canonical status list, so the
 *                      client builds tabs/filters without hardcoding anything.
 *   GET /:type/:id   → one document in full: header, lines, the
 *                      inventory_movements it produced, lots touched, GL
 *                      journals + entries, and a timeline.
 *
 * WHY it reads DOCUMENT HEADERS and never inventory_movements: a movement is a
 * ledger side-effect, it exists only for POSTED documents, several documents
 * write several movements, and two legacy writers write none at all
 * (routes/purchases.js:337 writes no reference_type). A ledger-derived list can
 * therefore never show a draft, can never be complete, and can never be trusted.
 *
 * THREE rules this file will not bend:
 *  1. A DB failure is a real error status with a real code — NEVER `res.json([])`.
 *     A false-empty list is indistinguishable from "no documents" and is the
 *     exact bug this module exists to kill (contrast routes/purchases.js:59).
 *  2. Warehouse scope is applied PER BRANCH from lib/inventoryOperations.SOURCES
 *     (two columns for transfers/production, one for the rest) — never one
 *     global clause bolted onto the outer query.
 *  3. Capability is applied PER BRANCH too: a user without `procurement.view`
 *     simply does not get the procurement branches in the union. One gate over
 *     the whole endpoint would either lock everyone out of inventory or hand
 *     every cashier the procurement ledger.
 *
 * All SQL identifiers come from the descriptor; every caller value is bound.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const C = require('../lib/inventoryTxContract');
const OPS = require('../lib/inventoryOperations');
const requireCapability = require('../middleware/requireCapability');

// ── Response helpers ────────────────────────────────────────────────────────
function _fail(req, res, code, message, httpOverride) {
  const canonical = C.isCanonical(code) ? String(code) : null;
  const status = httpOverride || (canonical ? C.httpFor(canonical) : 500);
  return res.status(status).json({
    success: false,
    code: String(code),
    error: String(message || code),
    requestId: (req && req.requestId) || null,
  });
}
function _catch(req, res, e) {
  if (e && e._handled) return undefined;
  console.error('[inventory-operations]', (req && req.originalUrl) || '', e);
  if (e && e.httpCode) return _fail(req, res, e.code || 'VALIDATION_ERROR', e.message, e.httpCode);
  // A schema/DB failure MUST surface. Never a silent empty page.
  return _fail(req, res, 'SERVER_ERROR', (e && e.message) || 'تعذّر قراءة مستندات المخزون', 500);
}

// mysql2 hands DATE columns back as JS Date objects; the screen wants a plain
// calendar day with no timezone shifting it across midnight.
function _dateStr(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return String(d).slice(0, 10);
}
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _str(v) { return v == null ? null : String(v); }

// ── Availability probe ──────────────────────────────────────────────────────
// The procurement tables (purchase_returns, procurement_events, …) exist ONLY
// once db/migrations/procurement/schema.js has run — i.e. only when
// PROCUREMENT_P2P_ENABLE has ever been on. A UNION branch over a missing table
// kills the WHOLE list, so absent branches are dropped and REPORTED
// (`unavailableTypes`) instead of silently swallowed. If the probe itself
// fails, that is a real 500 — we never guess.
const AVAIL_TTL_MS = 60 * 1000;
let _availAt = 0;
let _availSet = null;
async function _availableTables() {
  const now = Date.now();
  if (_availSet && (now - _availAt) < AVAIL_TTL_MS) return _availSet;
  const names = OPS.allTables();
  const [rows] = await db.query(
    'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
    [names]
  );
  const set = Object.create(null);
  rows.forEach((r) => { set[String(r.t)] = true; });
  _availSet = set;
  _availAt = now;
  return set;
}

// ── Capability resolution ───────────────────────────────────────────────────
// One lookup per DISTINCT capability (today: `procurement.view`), not one per
// branch and not one per row.
async function _capabilityMap(user) {
  const out = Object.create(null);
  const caps = OPS.capabilitiesRequired();
  for (const cap of caps) {
    out[cap] = await requireCapability.hasCapability(user, cap);
  }
  return out;
}

function _scopeFor(req) {
  return function (qualifiedColumn) {
    return req.whScopeClause ? req.whScopeClause(qualifiedColumn) : { sql: '', params: [] };
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Row projection + enrichment
// ════════════════════════════════════════════════════════════════════════════
function _baseRow(r) {
  const src = OPS.sourceFor(r.documentType);
  return {
    id: String(r.id),
    documentType: String(r.documentType),
    documentTypeLabel: src ? src.labelAr : String(r.documentType),
    documentId: String(r.documentId),
    documentNumber: _str(r.documentNumber),
    date: _dateStr(r.date),
    status: String(r.status),
    rawStatus: _str(r.rawStatus),
    source: { kind: String(r.sourceKind), id: _str(r.sourceId), label: null },
    destination: { kind: String(r.destinationKind), id: _str(r.destinationId), label: null },
    partyLabel: _str(r.partyLabel),
    productSummary: null,
    lineCount: r.lineCount != null ? Number(r.lineCount) : null,
    totalQuantity: r.totalQuantity != null ? _num(r.totalQuantity) : null,
    totalValue: _num(r.totalValue),
    vatAmount: _num(r.vatAmount),
    grossValue: _num(r.grossValue),
    // Adjustments / stocktakes carry a SIGNED variance value: −500 means the
    // count destroyed 500 of value. The client must not ABS() it away.
    valueSigned: Number(r.valueSigned) === 1,
    currency: 'SAR', // no inventory-document table has a currency column
    createdBy: _str(r.createdBy),
    createdByName: null,
    approvedBy: _str(r.approvedBy),
    approvedByName: null,
    createdAt: r.createdAt || null,
  };
}

// Line aggregates (count / quantity / first item name) for the CURRENT PAGE
// only. Deliberately NOT correlated subqueries inside the union: those would be
// evaluated for every historical row before the LIMIT, not for the 25 shown.
async function _enrichLines(rows) {
  const byType = Object.create(null);
  rows.forEach((r) => {
    (byType[r.documentType] = byType[r.documentType] || []).push(r.documentId);
  });

  for (const type of Object.keys(byType)) {
    const s = OPS.sourceFor(type);
    if (!s) continue;
    const ids = byType[type];
    const rowsOfType = rows.filter((r) => r.documentType === type);

    if (s.lines) {
      const L = s.lines;
      const nameExpr = L.joinItems ? 'MIN(i.name)' : 'MIN(li.' + OPS.ident(L.nameColumn) + ')';
      const join = L.joinItems ? ' LEFT JOIN inv_items i ON i.id = li.' + OPS.ident(_itemIdCol(L)) : '';
      const [agg] = await db.query(
        'SELECT li.' + OPS.ident(L.fk) + ' AS doc_id, COUNT(*) AS n, ' +
        'COALESCE(SUM(' + L.qtyExpr + '), 0) AS q, ' + nameExpr + ' AS nm' +
        ' FROM ' + OPS.ident(L.table) + ' li' + join +
        ' WHERE li.' + OPS.ident(L.fk) + ' IN (?) GROUP BY li.' + OPS.ident(L.fk),
        [ids]
      );
      const map = Object.create(null);
      agg.forEach((a) => { map[String(a.doc_id)] = a; });
      rowsOfType.forEach((r) => {
        const a = map[r.documentId];
        r.lineCount = a ? Number(a.n) || 0 : 0;
        r.totalQuantity = a ? _num(a.q) : 0;
        r.productSummary = OPS.productSummary(a && a.nm, r.lineCount);
      });
    } else if (s.itemsJsonColumn) {
      // Legacy purchases keep their lines in a TEXT blob. Parsing it in JS is
      // the ONLY truthful count — JSON_LENGTH() over an untyped column throws
      // on the malformed rows this data is known to contain.
      // NB: the alias must not be `blob` — that is a reserved word in MySQL.
      const [hdrs] = await db.query(
        'SELECT ' + OPS.ident(s.pk) + ' AS doc_id, ' + OPS.ident(s.itemsJsonColumn) + ' AS items_blob FROM ' +
        OPS.ident(s.table) + ' WHERE ' + OPS.ident(s.pk) + ' IN (?)', [ids]
      );
      const map = Object.create(null);
      hdrs.forEach((h) => { map[String(h.doc_id)] = h.items_blob; });
      rowsOfType.forEach((r) => {
        const parsed = _parseItemsJson(map[r.documentId]);
        r.lineCount = parsed.length;
        r.totalQuantity = parsed.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
        r.productSummary = OPS.productSummary(parsed.length ? (parsed[0].name || parsed[0].itemName) : '', parsed.length);
      });
    }

    // Header-carried quantity / product (production): the order's OUTPUT is the
    // quantity that matters, not the sum of its component consumption.
    if (s.quantityHeaderColumn || s.productColumn) {
      const cols = [OPS.ident(s.pk) + ' AS doc_id'];
      if (s.quantityHeaderColumn) cols.push(OPS.ident(s.quantityHeaderColumn) + ' AS qty');
      if (s.productColumn) cols.push(OPS.ident(s.productColumn) + ' AS product_id');
      const [hdrs] = await db.query(
        'SELECT ' + cols.join(', ') + ' FROM ' + OPS.ident(s.table) +
        ' WHERE ' + OPS.ident(s.pk) + ' IN (?)', [ids]
      );
      const map = Object.create(null);
      hdrs.forEach((h) => { map[String(h.doc_id)] = h; });
      const productIds = [];
      rowsOfType.forEach((r) => {
        const h = map[r.documentId];
        if (!h) return;
        if (s.quantityHeaderColumn) r.totalQuantity = _num(h.qty);
        if (s.productColumn && h.product_id) { r._productId = String(h.product_id); productIds.push(String(h.product_id)); }
      });
      if (productIds.length) {
        // A BOM product may live in inv_items OR in menu — the same fallback
        // routes/inventory-production.js:243 uses. Two small lookups beat a
        // three-way join across tables with different collations.
        const pmap = Object.create(null);
        const [pm] = await db.query('SELECT id, name FROM menu WHERE id IN (?)', [productIds]);
        pm.forEach((x) => { pmap[String(x.id)] = x.name; });
        const [pi] = await db.query('SELECT id, name FROM inv_items WHERE id IN (?)', [productIds]);
        pi.forEach((x) => { pmap[String(x.id)] = x.name; }); // inv_items wins
        rowsOfType.forEach((r) => {
          if (r._productId) r.productSummary = String(pmap[r._productId] || r._productId);
          delete r._productId;
        });
      }
    }
  }
}

function _parseItemsJson(blob) {
  if (!blob) return [];
  try {
    const v = JSON.parse(String(blob));
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return []; // known-malformed legacy rows; the count is 0, never a crash
  }
}

// Resolve warehouse / supplier / GL-account / user display labels for the page.
async function _enrichLabels(rows) {
  const whIds = [];
  const supIds = [];
  const acctCodes = [];
  const users = [];
  const push = (arr, v) => { if (v && arr.indexOf(v) === -1) arr.push(v); };

  rows.forEach((r) => {
    [r.source, r.destination].forEach((side) => {
      if (!side || !side.id) return;
      if (side.kind === 'warehouse') push(whIds, side.id);
      else if (side.kind === 'supplier') push(supIds, side.id);
      else if (side.kind === 'gl_account' || side.kind === 'expense') push(acctCodes, side.id);
    });
    push(users, r.createdBy);
    push(users, r.approvedBy);
  });

  const wmap = Object.create(null);
  if (whIds.length) {
    const [w] = await db.query('SELECT id, name, code FROM warehouses WHERE id IN (?)', [whIds]);
    w.forEach((x) => { wmap[String(x.id)] = x.name || x.code || String(x.id); });
  }
  const smap = Object.create(null);
  if (supIds.length) {
    const [sup] = await db.query('SELECT id, name FROM suppliers WHERE id IN (?)', [supIds]);
    sup.forEach((x) => { smap[String(x.id)] = x.name || String(x.id); });
  }
  const amap = Object.create(null);
  if (acctCodes.length) {
    // gl_accounts has name_ar/name_en — there is NO plain `name` column.
    const [a] = await db.query('SELECT code, COALESCE(name_ar, name_en, code) AS name FROM gl_accounts WHERE code IN (?)', [acctCodes]);
    a.forEach((x) => { amap[String(x.code)] = x.name || String(x.code); });
  }
  const umap = Object.create(null);
  if (users.length) {
    const [u] = await db.query('SELECT username, full_name FROM users WHERE username IN (?)', [users]);
    u.forEach((x) => { umap[String(x.username)] = x.full_name || x.username; });
  }

  const labelOf = (side) => {
    if (!side || !side.id) return null;
    if (side.kind === 'warehouse') return wmap[side.id] || side.id;
    if (side.kind === 'supplier') return smap[side.id] || side.id;
    if (side.kind === 'gl_account' || side.kind === 'expense') return amap[side.id] || side.id;
    return side.id;
  };
  rows.forEach((r) => {
    r.source.label = labelOf(r.source);
    r.destination.label = labelOf(r.destination);
    r.createdByName = r.createdBy ? (umap[r.createdBy] || r.createdBy) : null;
    r.approvedByName = r.approvedBy ? (umap[r.approvedBy] || r.approvedBy) : null;
    // A supplier-side document with no snapshot name falls back to the joined
    // supplier so the party column is never blank when we DO know who it was.
    if (!r.partyLabel) {
      if (r.source.kind === 'supplier') r.partyLabel = r.source.label;
      else if (r.destination.kind === 'supplier') r.partyLabel = r.destination.label;
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// GET / — the unified list
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const p = OPS.parseOperationsQuery(req.query);
    if (p.hasInvalid) {
      return _fail(req, res, 'VALIDATION_ERROR',
        'معطيات تصفية غير صالحة: ' + JSON.stringify(p.invalid), 422);
    }
    // An explicit ?warehouseId the caller cannot reach is rejected outright —
    // no existence leak, same rule as routes/warehouse-transfers.js:45.
    if (p.warehouseId && req.guardWh && !req.guardWh(res, p.warehouseId)) return undefined;

    const avail = await _availableTables();
    const caps = await _capabilityMap(req.user);
    const opts = {
      types: p.types,
      statuses: p.statuses,
      warehouseId: p.warehouseId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      search: p.search,
      hasCapability: (cap) => !!caps[cap],
      isAvailable: (table) => !!avail[table],
      scopeFor: _scopeFor(req),
      includeAggregates: false,
    };

    const built = OPS.buildUnionSql(OPS.SOURCES, opts);
    // Per-type tab counts ignore the TYPE filter (otherwise every tab but the
    // selected one would read 0) but honor every other filter.
    const countsBuilt = OPS.buildUnionSql(OPS.SOURCES, Object.assign({}, opts, { types: [] }));

    const unavailableTypes = built.excludedTypes
      .filter((x) => x.reason === 'unavailable').map((x) => x.documentType);
    const deniedTypes = built.excludedTypes
      .filter((x) => x.reason === 'capability').map((x) => x.documentType);

    let rows = [];
    let total = 0;
    const counts = {};
    // Every visible branch may legitimately be filtered away (e.g. a status
    // filter no branch can satisfy). That is a real empty result, not an error
    // — and it is reported alongside includedTypes so the client can tell.
    if (built.includedTypes.length) {
      const [pageRows] = await db.query(
        OPS.pageSql(built.sql, p.sort, p.dir),
        built.params.concat([p.pageSize, p.offset])
      );
      rows = pageRows;
      const [cnt] = await db.query(OPS.countSql(built.sql), built.params);
      total = Number((cnt[0] || {}).total) || 0;
    }
    if (countsBuilt.includedTypes.length) {
      const [byType] = await db.query(OPS.countsByTypeSql(countsBuilt.sql), countsBuilt.params);
      byType.forEach((r) => { counts[String(r.documentType)] = Number(r.n) || 0; });
    }
    // Zero-fill so a tab that legitimately has no documents still renders.
    countsBuilt.includedTypes.forEach((t) => { if (counts[t] == null) counts[t] = 0; });

    const data = rows.map(_baseRow);
    if (data.length) {
      await _enrichLines(data);
      await _enrichLabels(data);
    }

    return res.json({
      success: true,
      data,
      counts,
      pagination: {
        page: p.page,
        pageSize: p.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
      },
      filters: {
        types: p.types, statuses: p.statuses, warehouseId: p.warehouseId,
        dateFrom: p.dateFrom, dateTo: p.dateTo, q: p.search, sort: p.sort, dir: p.dir,
      },
      includedTypes: built.includedTypes,
      unavailableTypes,
      deniedTypes,
      scope: { allWarehousesAccess: !!(req.warehouseScope && req.warehouseScope.all) },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { return _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /meta — types + statuses, so the client hardcodes nothing
// ════════════════════════════════════════════════════════════════════════════
router.get('/meta', async (req, res) => {
  try {
    const avail = await _availableTables();
    const caps = await _capabilityMap(req.user);
    // Envelope kept identical to /api/recipes/meta ({success, data:{…}}) so the
    // client has ONE shape across both new domains instead of two.
    const types = OPS.SOURCES.map((s) => ({
      documentType: s.documentType,
      label: s.labelAr,
      table: s.table,
      capability: s.capability || null,
      visible: (!s.capability || !!caps[s.capability]) && !!avail[s.table],
      available: !!avail[s.table],
      twoSided: (s.warehouseColumns || []).length > 1,
      hasDocumentNumber: !!s.numberColumn,
      statuses: Object.keys(s.statusMap).map((raw) => ({ raw, canonical: s.statusMap[raw] })),
    }));
    return res.json({
      success: true,
      data: {
        types,
        canonicalStatuses: OPS.CANONICAL_STATUSES,
        sortable: Object.keys(OPS.SORTABLE),
        maxPageSize: OPS.MAX_PAGE_SIZE,
        currency: 'SAR',
      },
    });
  } catch (e) { return _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /:type/:id — one document, everything about it
// ════════════════════════════════════════════════════════════════════════════
router.get('/:type/:id', async (req, res) => {
  try {
    const s = OPS.sourceFor(req.params.type);
    if (!s) return _fail(req, res, 'NOT_FOUND', 'نوع مستند غير معروف', 404);

    const avail = await _availableTables();
    if (!avail[s.table]) {
      return _fail(req, res, 'TYPE_UNAVAILABLE', 'هذا النوع من المستندات غير مفعّل في هذا النظام', 503);
    }
    if (s.capability) {
      const ok = await requireCapability.hasCapability(req.user, s.capability);
      if (!ok) return _fail(req, res, 'PERMISSION_DENIED', 'صلاحية غير كافية لعرض هذا المستند', 403);
    }

    const [hdrs] = await db.query(
      'SELECT t.* FROM ' + OPS.ident(s.table) + ' t WHERE t.' + OPS.ident(s.pk) + ' = ?' +
      (s.extraWhere ? ' AND (' + s.extraWhere + ')' : '') + ' LIMIT 1',
      [String(req.params.id)]
    );
    if (!hdrs.length) return _fail(req, res, 'NOT_FOUND', 'المستند غير موجود', 404);
    const h = hdrs[0];

    // Warehouse guard, per the branch's own rule. Transfers require BOTH ends
    // (parity with routes/warehouse-transfers.js:148); everyone else guards the
    // single primary warehouse.
    if (s.detailGuard === 'both') {
      if (req.guardTransfer && !req.guardTransfer(res, h[s.source.idColumn], h[s.destination.idColumn])) return undefined;
    } else {
      const whCol = (s.scopeColumns || [])[0];
      if (whCol && req.guardWh && !req.guardWh(res, h[whCol])) return undefined;
    }

    const summary = _baseRow({
      id: s.documentType + ':' + h[s.pk],
      documentType: s.documentType,
      documentId: h[s.pk],
      documentNumber: s.numberColumn ? (h[s.numberColumn] || (s.numberFallbackToPk ? h[s.pk] : null)) : h[s.pk],
      date: h[s.dateColumn],
      status: OPS.canonicalStatus(s.documentType, h[s.statusColumn]),
      rawStatus: h[s.statusColumn],
      sourceKind: s.source.kind,
      sourceId: s.source.idColumn ? h[s.source.idColumn] : null,
      destinationKind: s.destination.kind,
      destinationId: s.destination.idColumn ? h[s.destination.idColumn] : null,
      partyLabel: (s.partyLabelColumns || []).map((c) => h[c]).filter(Boolean)[0] || null,
      totalValue: s.value.netColumn ? h[s.value.netColumn] : null,
      vatAmount: s.value.vatColumn ? h[s.value.vatColumn] : null,
      grossValue: s.value.grossColumn ? h[s.value.grossColumn] : null,
      valueSigned: s.value.signed ? 1 : 0,
      createdBy: s.createdByColumn ? h[s.createdByColumn] : null,
      approvedBy: s.approvedByColumn ? h[s.approvedByColumn] : null,
      createdAt: h.created_at || null,
    });

    const lines = await _loadLines(s, h);
    summary.lineCount = lines.length;
    summary.totalQuantity = lines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
    summary.productSummary = OPS.productSummary(lines.length ? lines[0].itemName : '', lines.length);
    await _enrichLabels([summary]);

    const movementRefIds = await _movementRefIds(s, h);
    const movements = await _loadMovements(s, h, movementRefIds);
    const lots = await _loadLots(s, movementRefIds);
    const journals = await _loadJournals(s, h, movementRefIds);
    const timeline = await _loadTimeline(s, h);

    return res.json({
      success: true,
      data: summary,
      header: h, // every type-specific column, verbatim
      lines,
      movements,
      lots,
      journals,
      timeline,
      capabilities: { requiredToView: s.capability || null },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { return _catch(req, res, e); }
});

// ── detail loaders ──────────────────────────────────────────────────────────
async function _loadLines(s, h) {
  if (s.itemsJsonColumn) {
    // Legacy purchases: the "line table" is a TEXT blob on the header.
    return _parseItemsJson(h[s.itemsJsonColumn]).map((it, i) => ({
      id: String(h[s.pk]) + '#' + i,
      itemId: _str(it.id || it.itemId || it.item_id),
      itemName: _str(it.name || it.itemName || it.item_name),
      unit: _str(it.unit),
      qty: _num(it.qty) || 0,
      unitCost: _num(it.unitPrice != null ? it.unitPrice : it.unit_price),
      lineTotal: _num(it.total != null ? it.total : it.line_total),
      raw: it,
    }));
  }
  if (!s.lines) return [];
  const L = s.lines;
  const idCol = OPS.ident(_itemIdCol(L));
  // Always join inv_items: the tables that carry no item_name snapshot need it
  // for the name, and every table needs it for the unit.
  const nameExpr = L.joinItems ? 'i.name' : 'li.' + OPS.ident(L.nameColumn);
  const [rows] = await db.query(
    'SELECT li.*, ' + nameExpr + ' AS _item_name, i.unit AS _item_unit FROM ' + OPS.ident(L.table) + ' li' +
    ' LEFT JOIN inv_items i ON i.id = li.' + idCol +
    ' WHERE li.' + OPS.ident(L.fk) + ' = ? ORDER BY li.id',
    [String(h[s.pk])]
  );
  return rows.map((r) => ({
    id: _str(r.id),
    itemId: _str(r[idCol]),
    itemName: _str(r._item_name),
    unit: _str(r.unit || r._item_unit),
    qty: _num(_evalQty(L, r)),
    unitCost: _num(r.unit_cost != null ? r.unit_cost : r.base_unit_cost),
    lineTotal: _num(r.line_total != null ? r.line_total : r.total_cost),
    raw: r,
  }));
}
// stock_adjustment_items is the one line table whose item FK is not `item_id`.
function _itemIdCol(L) { return L.itemIdColumn || 'item_id'; }
// The descriptor's qtyExpr is SQL; the JS side mirrors it for the detail rows.
function _evalQty(L, r) {
  if (L.qtyExpr === 'ABS(li.delta)') return Math.abs(Number(r.delta) || 0);
  if (L.qtyExpr === 'ABS(li.variance)') return Math.abs(Number(r.variance) || 0);
  if (L.qtyExpr === 'li.qty_issued') return Number(r.qty_issued) || 0;
  if (L.qtyExpr === 'li.qty_actual') return Number(r.qty_actual) || 0;
  if (L.qtyExpr === 'li.quantity') return Number(r.quantity) || 0;
  if (L.qtyExpr === 'li.base_qty') return Number(r.base_qty) || 0;
  return Number(r.qty) || 0;
}

// Which reference_id values the ledger rows of this document carry.
async function _movementRefIds(s, h) {
  const m = s.movements || {};
  if (m.refFrom === 'adjustment_id') {
    // A posted stocktake materializes an inv_adjustments document; its ledger
    // rows point at THAT id, not at the stocktake.
    return h.adjustment_id ? [String(h.adjustment_id)] : [];
  }
  if (m.refFrom === 'production_events') {
    // Production movements reference the ISSUE/OUTPUT EVENT id, never the
    // order id, so each partial event reverses exactly.
    const ids = [];
    const [ev] = await db.query('SELECT id FROM production_issue_events WHERE production_order_id = ?', [String(h[s.pk])]);
    ev.forEach((r) => ids.push(String(r.id)));
    const [out] = await db.query('SELECT id FROM production_output WHERE production_order_id = ?', [String(h[s.pk])]);
    out.forEach((r) => ids.push(String(r.id)));
    return ids;
  }
  if (m.refFrom === 'notes_marker') return [];
  return [String(h[s.pk])];
}

async function _loadMovements(s, h, refIds) {
  const m = s.movements || {};
  const cols = 'id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id';
  const rows = [];
  if (m.refFrom === 'notes_marker') {
    // routes/purchases.js:337 writes NO reference_type/reference_id — the notes
    // marker is the only link, and it is the same predicate the revert path
    // uses (routes/purchases.js:528), so it is authoritative for this doc type.
    const [r] = await db.query(
      'SELECT ' + cols + ' FROM inventory_movements WHERE notes = ? ORDER BY movement_date, id',
      [String(m.notesPrefix || '') + String(h[s.pk])]
    );
    rows.push(...r);
  } else if ((m.refTypes || []).length && refIds.length) {
    const [r] = await db.query(
      'SELECT ' + cols + ' FROM inventory_movements WHERE reference_type IN (?) AND reference_id IN (?) ORDER BY movement_date, id',
      [m.refTypes, refIds]
    );
    rows.push(...r);
  }
  // Production also writes order-level movements under its own ref types.
  if ((m.docRefTypes || []).length) {
    const [r2] = await db.query(
      'SELECT ' + cols + ' FROM inventory_movements WHERE reference_type IN (?) AND reference_id = ? ORDER BY movement_date, id',
      [m.docRefTypes, String(h[s.pk])]
    );
    rows.push(...r2);
  }
  return rows.map((r) => ({
    id: String(r.id),
    at: r.movement_date,
    itemId: _str(r.item_id),
    itemName: _str(r.item_name),
    type: _str(r.type),
    qty: _num(r.qty),
    reason: _str(r.reason),
    warehouseId: _str(r.warehouse_id),
    referenceType: _str(r.reference_type),
    referenceId: _str(r.reference_id),
    actor: _str(r.username),
    notes: _str(r.notes),
  }));
}

async function _loadLots(s, refIds) {
  const m = s.movements || {};
  if (!(m.refTypes || []).length || !refIds.length) return [];
  const [rows] = await db.query(
    'SELECT lm.id, lm.lot_id, lm.warehouse_id, lm.item_id, lm.signed_qty, lm.reference_type, lm.reference_id, ' +
    '       lm.occurred_at, wl.lot_number, wl.expiry_date ' +
    '  FROM inventory_lot_movements lm LEFT JOIN inventory_lots wl ON wl.id = lm.lot_id ' +
    ' WHERE lm.reference_type IN (?) AND lm.reference_id IN (?) ORDER BY lm.id',
    [m.refTypes, refIds]
  );
  return rows.map((r) => ({
    id: String(r.id),
    lotId: _str(r.lot_id),
    lotNumber: _str(r.lot_number),
    expiryDate: _dateStr(r.expiry_date),
    itemId: _str(r.item_id),
    warehouseId: _str(r.warehouse_id),
    signedQty: _num(r.signed_qty),
    referenceType: _str(r.reference_type),
    referenceId: _str(r.reference_id),
    at: r.occurred_at,
  }));
}

async function _loadJournals(s, h, refIds) {
  const J = s.journals || { columns: [], jsonColumns: [] };
  const ids = [];
  (J.columns || []).forEach((c) => { if (h[c]) ids.push(String(h[c])); });
  (J.jsonColumns || []).forEach((c) => {
    let arr = [];
    try { arr = JSON.parse(h[c] || '[]') || []; } catch (_) { arr = []; }
    if (Array.isArray(arr)) arr.forEach((x) => { if (x) ids.push(String(x)); });
  });
  // Production posts one journal per issue/output EVENT, not on the header.
  if ((s.movements || {}).refFrom === 'production_events' && refIds.length) {
    const [ev] = await db.query('SELECT gl_journal_id AS j FROM production_issue_events WHERE production_order_id = ?', [String(h[s.pk])]);
    ev.forEach((r) => { if (r.j) ids.push(String(r.j)); });
    const [out] = await db.query('SELECT gl_journal_id AS j FROM production_output WHERE production_order_id = ?', [String(h[s.pk])]);
    out.forEach((r) => { if (r.j) ids.push(String(r.j)); });
  }
  const unique = ids.filter((x, i) => ids.indexOf(x) === i);
  if (!unique.length) return [];
  const [js] = await db.query(
    'SELECT id, journal_number, journal_date, total_debit, total_credit, reference_type, description ' +
    'FROM gl_journals WHERE id IN (?)', [unique]
  );
  if (!js.length) return [];
  const [entries] = await db.query(
    'SELECT journal_id, account_code, account_name, debit, credit FROM gl_entries WHERE journal_id IN (?) ORDER BY journal_id, id',
    [unique]
  );
  return js.map((j) => ({
    id: String(j.id),
    journalNumber: _str(j.journal_number),
    journalDate: _dateStr(j.journal_date),
    totalDebit: _num(j.total_debit),
    totalCredit: _num(j.total_credit),
    referenceType: _str(j.reference_type),
    description: _str(j.description),
    entries: entries.filter((e) => String(e.journal_id) === String(j.id)).map((e) => ({
      accountCode: _str(e.account_code), accountName: _str(e.account_name),
      debit: _num(e.debit), credit: _num(e.credit),
    })),
  }));
}

// Fan out to whichever of the THREE audit tables applies. Two legacy types have
// none at all, so their timeline is rebuilt from the stamped actor/at columns —
// the same fallback routes/warehouse-transfers.js:170 uses for pre-audit rows.
async function _loadTimeline(s, h) {
  const T = s.timeline || { kind: null };
  let rows = [];
  if (T.kind === 'inv_tx_events') {
    const [r] = await db.query(
      'SELECT action, from_status, to_status, actor, note, created_at FROM inv_tx_events WHERE doc_type = ? AND doc_id = ? ORDER BY created_at, id',
      [T.docType, String(h[s.pk])]);
    rows = r;
  } else if (T.kind === 'stock_issue_events') {
    const [r] = await db.query(
      'SELECT action, from_status, to_status, actor, note, created_at FROM stock_issue_events WHERE issue_id = ? ORDER BY created_at, id',
      [String(h[s.pk])]);
    rows = r;
  } else if (T.kind === 'procurement_events') {
    // purchase_receipts exists in the BASE DDL (server.js:4229) but
    // procurement_events only exists once the P2P migration has run, so a GRN
    // detail can legitimately be asked for while this table is absent. A
    // missing table falls back to the stamped actors below — an ERROR does not.
    try {
      const [r] = await db.query(
        'SELECT action, from_status, to_status, actor, NULL AS note, created_at FROM procurement_events WHERE document_type = ? AND document_id = ? ORDER BY created_at, id',
        [T.docType, String(h[s.pk])]);
      rows = r;
    } catch (e) {
      if (e && e.code !== 'ER_NO_SUCH_TABLE') throw e;
      rows = [];
    }
  }

  if (rows.length) {
    return rows.map((e) => ({
      action: _str(e.action), fromStatus: _str(e.from_status), toStatus: _str(e.to_status),
      actor: _str(e.actor) || '', note: _str(e.note), at: e.created_at, synthetic: false,
    }));
  }
  return (s.actorStamps || [])
    .filter((st) => h[st[2]])
    .map((st) => ({
      action: st[0], fromStatus: null, toStatus: null,
      actor: _str(h[st[1]]) || '', note: null, at: h[st[2]], synthetic: true,
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

module.exports = router;
