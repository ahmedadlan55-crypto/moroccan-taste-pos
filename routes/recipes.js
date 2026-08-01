/**
 * routes/recipes.js — THE unified recipe / BOM domain API.
 *
 * Mounted at /api/recipes (server.js). This is now the authoritative surface
 * for reading and writing recipes. The two pre-existing writers
 *
 *   POST /api/menu/:id/recipe-bom   (routes/menu.js)
 *   POST /api/erp/bom               (routes/erp-core.js)
 *
 * are kept as a COMPATIBILITY LAYER — they delegate here rather than owning
 * their own rules — because a grep proved they still have live callers
 * (frontend/erp/src/modules/menu/api.ts:801 calls the first one). They are not
 * deleted; they are made thin.
 *
 * WHAT THE SPLIT COST US, and why this file exists:
 *   • The two writers computed DIFFERENT costs for the same recipe — menu.js
 *     divided the batch by yield (menu.js:1312), erp-core.js did not
 *     (erp-core.js:1081-1087) — so a recipe's unit cost depended on which
 *     screen last saved it.
 *   • erp-core.js:1074 took the cost from the BROWSER (`req.body.recomputedCost`,
 *     commented "we trust it") and wrote it straight onto menu.cost.
 *   • Neither was transactional: both DELETE all lines then INSERT them one by
 *     one on the pool, so a failure halfway leaves a recipe with some of its
 *     components.
 *   • Neither validated yield > 0, waste range, duplicate components, or
 *     cycles; `Number(b.yieldQuantity) || 1` turned a typed 0 into a silent 1.
 *   • Reads swallowed DB errors into `res.json([])` (erp-core.js:867, 935), so
 *     a broken query was indistinguishable from "no recipes".
 *
 * Every one of those is fixed here, and the rules live in lib/recipeEngine.js
 * so they are unit-tested without a database.
 *
 * PERFORMANCE CONTRACT: no endpoint in this file ever selects `menu.image_data`.
 * The catalog returns an `imageVersion` hash and clients fetch bytes from
 * GET /api/recipes/product-image/:source/:productId, which is immutable-cached.
 * The live table holds ~66 MB of base64 across its rows; putting it in a list
 * payload is the single worst thing this API could do.
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const R = require('../lib/recipeEngine');
const IU = require('../lib/itemUnits');
const IDEM = require('../lib/idempotencyStore');
const { logAuditTx } = require('../lib/auditLogger');
const requireCapability = require('../middleware/requireCapability');
const requireRole = require('../middleware/auth').requireRole;

const MGR = requireRole('admin', 'manager');
const READ = requireRole('admin', 'manager', 'employee', 'custody', 'accountant', 'finance', 'auditor');

const MAX_PAGE_SIZE = 100;
const PRODUCT_TYPES = ['sold', 'semi_finished', 'combo', 'stock_item'];
const SORTS = {
  name: 'p.name',
  name_en: 'p.name_en',
  product_type: 'p.product_type',
  category: 'p.category',
  status: 'recipe_status',
  updated_at: 'b.updated_at',
  selling_price: 'p.selling_price',
  yield_quantity: 'b.yield_quantity',
  version: 'b.version',
};

// ── helpers ─────────────────────────────────────────────────────────────────
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
function _err(code, msg, detail) { const e = new Error(msg || code); e.code = code; if (detail) e.detail = detail; return e; }

const HTTP_FOR = {
  VALIDATION_ERROR: 422,
  DUPLICATE_COMPONENT_UNIT_MISMATCH: 422,
  RECIPE_SELF_REFERENCE: 422,
  RECIPE_CYCLE: 422,
  UNIT_REQUIRED: 422,
  UNIT_NOT_ALLOWED: 422,
  UNIT_CONVERSION_CONFLICT: 422,
  INVALID_CONVERSION_FACTOR: 422,
  ALLOCATION_PCT_OVERFLOW: 422,
  NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RECIPE_IMMUTABLE: 409,
};

/**
 * The ONE error path. Always carries `requestId` (server.js:57-64 mints one per
 * request and echoes it as the X-Request-Id header) so a user can quote a real
 * correlation id to support — the thing the UI could not show before, and the
 * thing `res.json([])` destroyed entirely.
 */
function _fail(req, res, codeOrErr, message) {
  const code = typeof codeOrErr === 'string' ? codeOrErr : ((codeOrErr && codeOrErr.code) || 'SERVER_ERROR');
  const status = HTTP_FOR[code] || (codeOrErr && codeOrErr.status) || 500;
  const msg = message || (typeof codeOrErr === 'object' && codeOrErr && codeOrErr.message) || code;
  const body = {
    success: false,
    code,
    error: status >= 500 ? 'خطأ داخلي في الخادم' : msg,
    requestId: req.requestId || null,
  };
  if (typeof codeOrErr === 'object' && codeOrErr && codeOrErr.detail) body.detail = codeOrErr.detail;
  if (status >= 500) {
    // Log the real cause; never leak it to the client.
    console.error('[recipes]', req.requestId || '-', req.method, req.originalUrl, (codeOrErr && codeOrErr.stack) || codeOrErr);
  }
  return res.status(status).json(body);
}
function _catch(req, res, e) { return _fail(req, res, e, e && e.message); }

function _int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function _src(v) { return v === 'menu' ? 'menu' : 'inv'; }
function _isValidSource(v) { return v === 'menu' || v === 'inv'; }

/** Can this user see cost figures? Cost is hidden, never faked, when they cannot. */
async function _canSeeCost(req) {
  if (!req.user) return false;
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin' || req.user.isDeveloper) return true;
  try { return await requireCapability.hasCapability(req.user, 'item.cost.view'); }
  catch (_) { return role === 'manager' || role === 'accountant' || role === 'finance'; }
}
function _stripCost(row) {
  return Object.assign({}, row, {
    unitCost: null, batchCost: null, foodCostPct: null, marginPct: null, costAnomalies: [],
  });
}

// The product universe of a RECIPE catalog: everything that is sold, is
// semi-finished, or is a stock item that can actually be produced (has a
// recipe). A pure raw material with no recipe is an ingredient, not a product,
// so it is excluded by default — `?includeRawMaterials=1` widens it.
function _productUniverseSql(includeRaw) {
  return `
    SELECT 'menu' AS product_source, m.id, m.name, COALESCE(m.name_en,'') AS name_en,
           COALESCE(m.category,'') AS category, m.brand_id, m.id AS sku,
           m.price AS selling_price,
           CASE WHEN COALESCE(m.is_combo,0)=1 THEN 'combo'
                WHEN COALESCE(m.is_semi_finished,0)=1 THEN 'semi_finished'
                ELSE 'sold' END AS product_type,
           COALESCE(m.production_unit, m.unit, '') AS unit,
           SUBSTRING(SHA2(m.image_data,256),1,8) AS image_version,
           m.bom_id AS linked_bom_id
      FROM menu m
     WHERE COALESCE(m.is_deleted,0)=0
    UNION ALL
    SELECT 'inv' AS product_source, i.id, i.name, COALESCE(i.name_en,'') AS name_en,
           COALESCE(i.category,'') AS category, i.brand_id, COALESCE(i.sku, i.id) AS sku,
           NULL AS selling_price,
           CASE WHEN COALESCE(i.kind,'raw')='semi' THEN 'semi_finished' ELSE 'stock_item' END AS product_type,
           COALESCE(i.unit,'') AS unit,
           NULL AS image_version,
           NULL AS linked_bom_id
      FROM inv_items i
     WHERE COALESCE(i.active,1)=1 AND i.deleted_at IS NULL
       ${includeRaw ? '' : `AND (COALESCE(i.kind,'raw')='semi'
             OR EXISTS (SELECT 1 FROM bom bx WHERE bx.product_id=i.id
                          AND COALESCE(bx.product_source,'inv')='inv' AND bx.status<>'archived'))`}`;
}

// Live batch cost of a BOM: Σ base_quantity × (1 + waste) × component cost.
// Computed in SQL rather than read from bom.cost_batch so the catalog can never
// show a stale number; the cached columns are still written on save because
// other consumers (and the "computed at" stamp) want them.
const COST_SUBQUERY = `
  (SELECT COALESCE(SUM(COALESCE(bl.base_quantity, bl.quantity)
                        * (1 + COALESCE(bl.waste_pct,0)/100)
                        * COALESCE(ci.cost,0)), 0)
     FROM bom_lines bl LEFT JOIN inv_items ci ON ci.id = bl.component_item_id
    WHERE bl.bom_id = b.id)`;
const MISSING_COST_SUBQUERY = `
  (SELECT COUNT(*) FROM bom_lines bl2 LEFT JOIN inv_items ci2 ON ci2.id = bl2.component_item_id
    WHERE bl2.bom_id = b.id AND COALESCE(ci2.cost,0) <= 0)`;

// ════════════════════════════════════════════════════════════════════════════
// META — option sets, so the client never hardcodes a vocabulary
// ════════════════════════════════════════════════════════════════════════════
router.get('/meta', READ, async (req, res) => {
  try {
    const [brands] = await db.query('SELECT id, name, COALESCE(name_en, name) AS name_en FROM brands ORDER BY name');
    const [cats] = await db.query(
      `SELECT DISTINCT category FROM (
         SELECT category FROM menu WHERE COALESCE(is_deleted,0)=0 AND category IS NOT NULL AND category<>''
         UNION SELECT category FROM inv_items WHERE category IS NOT NULL AND category<>''
       ) c ORDER BY category`);
    res.json({
      success: true,
      data: {
        brands: brands.map((b) => ({ id: b.id, name: b.name, nameEn: b.name_en || b.name })),
        categories: cats.map((c) => c.category),
        productTypes: PRODUCT_TYPES,
        recipeStatuses: R.STATUSES.concat(['none']),
        outputTypes: R.OUTPUT_TYPES,
        allocMethods: R.ALLOC_METHODS,
        costAnomalies: ['ZERO_COST', 'COMPONENT_WITHOUT_COST', 'COST_EXCEEDS_PRICE', 'FOOD_COST_HIGH', 'COST_STALE'],
        sorts: Object.keys(SORTS),
      },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CATALOG LIST — server-side paged/filtered/sorted; NEVER returns image bytes
// ════════════════════════════════════════════════════════════════════════════
router.get('/', READ, async (req, res) => {
  try {
    const page = Math.max(1, _int(req.query.page, 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, _int(req.query.pageSize, 25)));
    const offset = (page - 1) * pageSize;
    const sortKey = SORTS[String(req.query.sort)] ? String(req.query.sort) : 'name';
    const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const includeRaw = String(req.query.includeRawMaterials || '') === '1';
    const showCost = await _canSeeCost(req);

    const where = ['1=1'];
    const params = [];
    if (req.query.q) {
      const like = '%' + String(req.query.q).trim().slice(0, 120) + '%';
      where.push('(p.name LIKE ? OR p.name_en LIKE ? OR p.sku LIKE ? OR p.id LIKE ?)');
      params.push(like, like, like, like);
    }
    if (req.query.brandId) { where.push('p.brand_id = ?'); params.push(String(req.query.brandId)); }
    if (req.query.category) { where.push('p.category = ?'); params.push(String(req.query.category)); }
    if (req.query.source && _isValidSource(String(req.query.source))) {
      where.push('p.product_source = ?'); params.push(String(req.query.source));
    }
    const types = String(req.query.productType || '').split(',').map((s) => s.trim()).filter((s) => PRODUCT_TYPES.indexOf(s) !== -1);
    if (types.length) { where.push('p.product_type IN (' + types.map(() => '?').join(',') + ')'); params.push(...types); }

    // Recipe-state filters. `none` is the "بلا وصفة" case and is why the whole
    // catalog is a LEFT JOIN: products WITHOUT a recipe must be listed too.
    const recipeStatus = String(req.query.recipeStatus || '');
    if (recipeStatus === 'none') where.push('b.id IS NULL');
    else if (R.STATUSES.indexOf(recipeStatus) !== -1) { where.push('b.status = ?'); params.push(recipeStatus); }
    if (String(req.query.missingRecipe || '') === '1') where.push('b.id IS NULL');
    if (String(req.query.needsReview || '') === '1') where.push('COALESCE(b.needs_review,0) = 1');

    const whereSql = 'WHERE ' + where.join(' AND ');
    const join = `FROM (${_productUniverseSql(includeRaw)}) p
      LEFT JOIN bom b ON b.product_id = p.id
                     AND COALESCE(b.product_source,'inv') = p.product_source
                     AND b.status = 'active'`;

    // Cost-anomaly filtering has to happen AFTER the cost expression exists, so
    // it is a HAVING on the computed alias rather than a WHERE.
    const anomaly = String(req.query.costAnomaly || '');
    const having = [];
    if (anomaly === 'ZERO_COST') having.push('b.id IS NOT NULL AND batch_cost <= 0');
    else if (anomaly === 'COMPONENT_WITHOUT_COST') having.push('missing_cost_lines > 0');
    else if (anomaly === 'COST_EXCEEDS_PRICE') having.push('p.selling_price > 0 AND (batch_cost / GREATEST(b.yield_quantity,0.000001)) >= p.selling_price');
    else if (anomaly === 'FOOD_COST_HIGH') having.push('p.selling_price > 0 AND (batch_cost / GREATEST(b.yield_quantity,0.000001)) >= p.selling_price * 0.6');
    const havingSql = having.length ? ' HAVING ' + having.join(' AND ') : '';

    const selectSql = `
      SELECT p.product_source, p.id, p.name, p.name_en, p.category, p.brand_id, p.sku,
             p.selling_price, p.product_type, p.unit, p.image_version,
             br.name AS brand_name, COALESCE(br.name_en, br.name) AS brand_name_en,
             b.id AS bom_id, b.status AS recipe_status, b.version, b.row_version,
             b.yield_quantity, b.yield_unit, b.needs_review, b.updated_at, b.approved_at,
             b.effective_from, b.effective_to, b.cost_computed_at,
             (SELECT COUNT(*) FROM bom_lines bl3 WHERE bl3.bom_id = b.id) AS line_count,
             ${COST_SUBQUERY} AS batch_cost,
             ${MISSING_COST_SUBQUERY} AS missing_cost_lines
      ${join} LEFT JOIN brands br ON br.id = p.brand_id
      ${whereSql}${havingSql}`;

    const [rows] = await db.query(
      selectSql + ` ORDER BY ${SORTS[sortKey]} ${dir}, p.id ASC LIMIT ? OFFSET ?`,
      params.concat([pageSize, offset]));
    const [[cnt]] = await db.query(`SELECT COUNT(*) AS total FROM (${selectSql}) x`, params);

    // KPIs are computed over the SAME filtered set, so "بلا وصفة: 12" always
    // agrees with what filtering by that value would actually list.
    const [[kpi]] = await db.query(`
      SELECT COUNT(*) AS products,
             SUM(CASE WHEN bom_id IS NULL THEN 1 ELSE 0 END) AS without_recipe,
             SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS needs_review,
             AVG(CASE WHEN selling_price > 0 AND yield_quantity > 0 AND batch_cost > 0
                      THEN (batch_cost / yield_quantity) / selling_price * 100 END) AS avg_food_cost
        FROM (${selectSql}) k`, params);

    const total = Number(cnt.total) || 0;
    const data = rows.map((r) => {
      const yieldQ = Number(r.yield_quantity) || 0;
      const batchCost = Number(r.batch_cost) || 0;
      const unitCost = r.bom_id && yieldQ > 0 ? R.round6(batchCost / yieldQ) : null;
      const price = r.selling_price == null ? null : Number(r.selling_price);
      const row = {
        productSource: r.product_source,
        productId: r.id,
        sku: r.sku || r.id,
        name: r.name,
        nameEn: r.name_en || '',
        productType: r.product_type,
        brandId: r.brand_id || null,
        brandName: r.brand_name || '',
        brandNameEn: r.brand_name_en || '',
        category: r.category || '',
        unit: r.unit || '',
        // Bytes are NEVER inlined — the client builds
        // /api/recipes/product-image/<source>/<id>?v=<imageVersion>
        imageVersion: r.image_version || null,
        bomId: r.bom_id || null,
        recipeStatus: r.bom_id ? r.recipe_status : 'none',
        version: r.bom_id ? Number(r.version) || 1 : null,
        rowVersion: r.bom_id ? Number(r.row_version) || 1 : null,
        yieldQuantity: r.bom_id ? Number(r.yield_quantity) : null,
        yieldUnit: r.bom_id ? (r.yield_unit || '') : null,
        lineCount: Number(r.line_count) || 0,
        needsReview: !!r.needs_review,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        updatedAt: r.updated_at,
        sellingPrice: price,
        batchCost: r.bom_id ? R.round4(batchCost) : null,
        unitCost,
        foodCostPct: unitCost == null ? null : R.foodCostPct(unitCost, price),
        marginPct: unitCost == null ? null : R.marginPct(unitCost, price),
        costAnomalies: r.bom_id ? R.costAnomalies({
          unitCost, sellingPrice: price,
          missingComponentCost: Number(r.missing_cost_lines) > 0,
          staleDays: null,
        }) : [],
      };
      return showCost ? row : _stripCost(row);
    });

    res.json({
      success: true,
      data,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      kpis: {
        products: Number(kpi.products) || 0,
        withoutRecipe: Number(kpi.without_recipe) || 0,
        needsReview: Number(kpi.needs_review) || 0,
        avgFoodCostPct: showCost && kpi.avg_food_cost != null ? R.round2(kpi.avg_food_cost) : null,
      },
      canViewCost: showCost,
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRODUCT PICKER — deliberately NOT limited to products that already have an
// active BOM (the old /erp/bom/product-pool returned up to 3000 rows in one
// unpaginated shot; this is paged and carries no image bytes)
// ════════════════════════════════════════════════════════════════════════════
router.get('/products', READ, async (req, res) => {
  try {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, _int(req.query.pageSize, 25)));
    const page = Math.max(1, _int(req.query.page, 1));
    const where = ['1=1']; const params = [];
    if (req.query.q) {
      const like = '%' + String(req.query.q).trim().slice(0, 120) + '%';
      where.push('(p.name LIKE ? OR p.name_en LIKE ? OR p.sku LIKE ?)');
      params.push(like, like, like);
    }
    if (req.query.brandId) { where.push('p.brand_id = ?'); params.push(String(req.query.brandId)); }
    if (req.query.source && _isValidSource(String(req.query.source))) { where.push('p.product_source = ?'); params.push(String(req.query.source)); }
    const sql = `FROM (${_productUniverseSql(String(req.query.includeRawMaterials || '') === '1')}) p
      LEFT JOIN bom b ON b.product_id=p.id AND COALESCE(b.product_source,'inv')=p.product_source AND b.status='active'
      WHERE ${where.join(' AND ')}`;
    const [rows] = await db.query(
      `SELECT p.product_source, p.id, p.name, p.name_en, p.sku, p.product_type, p.unit,
              p.brand_id, p.image_version, b.id AS bom_id, b.version ${sql}
       ORDER BY p.name LIMIT ? OFFSET ?`, params.concat([pageSize, (page - 1) * pageSize]));
    const [[cnt]] = await db.query(`SELECT COUNT(*) AS total ${sql}`, params);
    const total = Number(cnt.total) || 0;
    res.json({
      success: true,
      data: rows.map((r) => ({
        productSource: r.product_source, productId: r.id, sku: r.sku || r.id,
        name: r.name, nameEn: r.name_en || '', productType: r.product_type,
        unit: r.unit || '', brandId: r.brand_id || null, imageVersion: r.image_version || null,
        bomId: r.bom_id || null, hasRecipe: !!r.bom_id, version: r.version || null,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT PICKER — inv_items only, paged, with live cost + registered units
// ════════════════════════════════════════════════════════════════════════════
router.get('/components', READ, async (req, res) => {
  try {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, _int(req.query.pageSize, 25)));
    const page = Math.max(1, _int(req.query.page, 1));
    const showCost = await _canSeeCost(req);
    const where = ['COALESCE(i.active,1)=1', 'i.deleted_at IS NULL']; const params = [];
    if (req.query.q) {
      const like = '%' + String(req.query.q).trim().slice(0, 120) + '%';
      where.push('(i.name LIKE ? OR i.name_en LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)');
      params.push(like, like, like, like);
    }
    if (req.query.brandId) { where.push('i.brand_id = ?'); params.push(String(req.query.brandId)); }
    const sql = 'FROM inv_items i WHERE ' + where.join(' AND ');
    const [rows] = await db.query(
      `SELECT i.id, i.name, COALESCE(i.name_en,'') AS name_en, COALESCE(i.sku,i.id) AS sku,
              i.unit, i.cost, i.kind, i.tracking_mode, i.category ${sql} ORDER BY i.name LIMIT ? OFFSET ?`,
      params.concat([pageSize, (page - 1) * pageSize]));
    const [[cnt]] = await db.query(`SELECT COUNT(*) AS total ${sql}`, params);
    const ids = rows.map((r) => r.id);
    let unitsByItem = new Map();
    if (ids.length) {
      const [us] = await db.query(
        `SELECT id, item_id, unit_name, unit_code, is_base, conversion_to_base, quantity_precision
           FROM item_units WHERE item_id IN (?) AND is_active=1 AND allow_production=1
          ORDER BY is_base DESC, conversion_to_base ASC`, [ids]);
      for (const u of us) {
        if (!unitsByItem.has(u.item_id)) unitsByItem.set(u.item_id, []);
        unitsByItem.get(u.item_id).push({
          id: u.id, name: u.unit_name, code: u.unit_code,
          isBase: !!u.is_base, conversionToBase: Number(u.conversion_to_base), precision: Number(u.quantity_precision),
        });
      }
    }
    const total = Number(cnt.total) || 0;
    res.json({
      success: true,
      data: rows.map((r) => ({
        itemId: r.id, name: r.name, nameEn: r.name_en, sku: r.sku,
        baseUnit: r.unit || '', kind: r.kind || 'raw', trackingMode: r.tracking_mode || 'none',
        category: r.category || '',
        unitCost: showCost ? Number(r.cost) || 0 : null,
        // Free-text units are gone: a line may only carry a REGISTERED unit
        // (item_units, allow_production=1) whose factor is snapshotted on save.
        units: unitsByItem.get(r.id) || [],
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      canViewCost: showCost,
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRODUCT IMAGE — real bytes, immutable-cached, so the catalog can carry only
// a hash. Mirrors routes/pos-v2.js:1049 (same ETag + 404-on-corrupt contract).
// ════════════════════════════════════════════════════════════════════════════
const IMG_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;
router.get('/product-image/:source/:productId', READ, async (req, res) => {
  try {
    if (_src(req.params.source) !== 'menu') return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'لا توجد صورة' });
    const [rows] = await db.query('SELECT image_data FROM menu WHERE id=? LIMIT 1', [String(req.params.productId).slice(0, 50)]);
    const raw = rows.length ? rows[0].image_data : null;
    if (!raw) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'لا توجد صورة لهذا المنتج' });
    const m = IMG_DATA_URL_RE.exec(String(raw));
    if (!m) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'الصورة المخزّنة تالفة' });
    const b64 = m[2].replace(/\s+/g, '');
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'الصورة المخزّنة تالفة' });
    const etag = '"' + crypto.createHash('sha1').update(b64).digest('hex') + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.setHeader('Content-Type', 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]));
    res.send(bytes);
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SHARED READERS
// ════════════════════════════════════════════════════════════════════════════
async function _loadProduct(q, source, productId) {
  const src = _src(source);
  if (src === 'menu') {
    const [r] = await q.query(
      `SELECT id, name, COALESCE(name_en,'') AS name_en, category, brand_id, price AS selling_price,
              COALESCE(production_unit, unit, '') AS unit, bom_id AS linked_bom_id,
              SUBSTRING(SHA2(image_data,256),1,8) AS image_version,
              CASE WHEN COALESCE(is_combo,0)=1 THEN 'combo'
                   WHEN COALESCE(is_semi_finished,0)=1 THEN 'semi_finished' ELSE 'sold' END AS product_type,
              production_method, deduct_strategy, allow_negative_stock, min_stock_alert, cost_source
         FROM menu WHERE id=? AND COALESCE(is_deleted,0)=0 LIMIT 1`, [productId]);
    return r.length ? Object.assign(r[0], { product_source: 'menu', sku: r[0].id }) : null;
  }
  const [r] = await q.query(
    `SELECT id, name, COALESCE(name_en,'') AS name_en, category, brand_id, NULL AS selling_price,
            COALESCE(unit,'') AS unit, NULL AS linked_bom_id, NULL AS image_version,
            CASE WHEN COALESCE(kind,'raw')='semi' THEN 'semi_finished' ELSE 'stock_item' END AS product_type,
            NULL AS production_method, NULL AS deduct_strategy, NULL AS allow_negative_stock,
            NULL AS min_stock_alert, NULL AS cost_source, COALESCE(sku,id) AS sku, tracking_mode
       FROM inv_items WHERE id=? AND deleted_at IS NULL LIMIT 1`, [productId]);
  return r.length ? Object.assign(r[0], { product_source: 'inv' }) : null;
}

async function _loadVersions(q, source, productId) {
  const [rows] = await q.query(
    `SELECT id, version, row_version, status, yield_quantity, yield_unit, effective_from, effective_to,
            revision_of, needs_review, created_by, created_at, updated_by, updated_at,
            approved_by, approved_at, notes, cost_batch, cost_per_unit, cost_computed_at
       FROM bom WHERE product_id=? AND COALESCE(product_source,'inv')=?
      ORDER BY version DESC, created_at DESC`, [productId, _src(source)]);
  return rows;
}

async function _loadLines(q, bomId, showCost) {
  const [rows] = await q.query(
    `SELECT bl.*, i.name AS item_name, COALESCE(i.name_en,'') AS item_name_en,
            i.unit AS base_unit, COALESCE(i.cost,0) AS wac_cost, COALESCE(i.standard_cost,0) AS standard_cost,
            i.cost_method, COALESCE(i.tracking_mode,'none') AS tracking_mode, i.kind AS item_kind,
            iu.unit_name AS entered_unit_name
       FROM bom_lines bl
       LEFT JOIN inv_items i ON i.id = bl.component_item_id
       LEFT JOIN item_units iu ON iu.id = bl.entered_unit_id
      WHERE bl.bom_id=? ORDER BY bl.line_no, bl.id`, [bomId]);
  return rows.map((l) => {
    const baseQty = Number(l.base_quantity != null ? l.base_quantity : l.quantity) || 0;
    const waste = Number(l.waste_pct) || 0;
    const unitCost = l.cost_method === 'standard' ? Number(l.standard_cost) || 0 : Number(l.wac_cost) || 0;
    const gross = R.round6(baseQty * (1 + waste / 100));
    return {
      id: l.id,
      componentItemId: l.component_item_id,
      itemName: l.item_name || l.component_item_id,
      itemNameEn: l.item_name_en || '',
      itemKind: l.item_kind || 'raw',
      trackingMode: l.tracking_mode,
      enteredUnitId: l.entered_unit_id || null,
      enteredUnitCode: l.entered_unit_code || l.unit || '',
      enteredUnitName: l.entered_unit_name || l.entered_unit_code || l.unit || '',
      baseUnit: l.base_unit || '',
      conversionFactor: Number(l.conversion_factor) || 1,
      quantity: Number(l.quantity) || 0,     // NET, in the entered unit
      baseQuantity: baseQty,                  // NET, in the component's base unit
      wastePct: waste,                        // EXPECTED recipe loss — not production scrap
      grossQuantity: gross,                   // what production actually issues
      costBasis: l.cost_method === 'standard' ? 'standard' : 'wac',
      unitCost: showCost ? R.round6(unitCost) : null,
      lineCost: showCost ? R.round4(gross * unitCost) : null,
      lineNo: Number(l.line_no) || 0,
      notes: l.notes || null,
    };
  });
}

async function _loadOutputs(q, bomId) {
  const [rows] = await q.query(
    `SELECT o.*, COALESCE(mi.name, ii.name, o.product_id) AS product_name,
            COALESCE(mi.name_en, ii.name_en, '') AS product_name_en,
            w.name AS warehouse_name
       FROM bom_outputs o
       LEFT JOIN menu mi ON mi.id=o.product_id AND o.product_source='menu'
       LEFT JOIN inv_items ii ON ii.id=o.product_id AND o.product_source='inv'
       LEFT JOIN warehouses w ON w.id=o.warehouse_id
      WHERE o.bom_id=? ORDER BY FIELD(o.output_type,'primary','co_product','by_product','rework','scrap'), o.line_no, o.id`,
    [bomId]);
  return rows.map((o) => ({
    id: o.id, outputType: o.output_type, productId: o.product_id, productSource: o.product_source,
    productName: o.product_name, productNameEn: o.product_name_en || '',
    quantity: Number(o.quantity), baseQuantity: Number(o.base_quantity),
    enteredUnitId: o.entered_unit_id || null, enteredUnitCode: o.entered_unit_code || '',
    conversionFactor: Number(o.conversion_factor) || 1,
    warehouseId: o.warehouse_id || null, warehouseName: o.warehouse_name || '',
    allocMethod: o.alloc_method, allocValue: o.alloc_value == null ? null : Number(o.alloc_value),
    requiresLot: !!o.requires_lot, lineNo: Number(o.line_no) || 0, notes: o.notes || null,
  }));
}

/** Adjacency for the cycle walker: every OTHER non-archived recipe's components. */
async function _loadRecipeGraph(q, excludeBomId) {
  const [rows] = await q.query(
    `SELECT b.id, b.product_id, COALESCE(b.product_source,'inv') AS product_source, bl.component_item_id
       FROM bom b LEFT JOIN bom_lines bl ON bl.bom_id=b.id
      WHERE b.status <> 'archived' ${excludeBomId ? 'AND b.id <> ?' : ''}`,
    excludeBomId ? [excludeBomId] : []);
  const g = new Map();
  for (const r of rows) {
    const k = R.productKey(r.product_source, r.product_id);
    if (!g.has(k)) g.set(k, []);
    if (r.component_item_id) g.get(k).push(r.component_item_id);
  }
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
// DETAIL by bom id (a SPECIFIC version)
// ════════════════════════════════════════════════════════════════════════════
router.get('/bom/:bomId', READ, async (req, res) => {
  try {
    const showCost = await _canSeeCost(req);
    const [b] = await db.query('SELECT * FROM bom WHERE id=? LIMIT 1', [req.params.bomId]);
    if (!b.length) return _fail(req, res, 'NOT_FOUND', 'الوصفة غير موجودة');
    const bom = b[0];
    const product = await _loadProduct(db, bom.product_source, bom.product_id);
    const lines = await _loadLines(db, bom.id, showCost);
    const outputs = await _loadOutputs(db, bom.id);
    const cost = R.computeRecipeCost(lines.map((l) => ({
      baseQuantity: l.baseQuantity, wastePct: l.wastePct, unitCost: l.unitCost || 0,
    })), Number(bom.yield_quantity) || 1);
    res.json({
      success: true,
      data: _shapeBom(bom, product, lines, outputs, cost, showCost),
      canViewCost: showCost,
    });
  } catch (e) { _catch(req, res, e); }
});

function _shapeBom(bom, product, lines, outputs, cost, showCost) {
  const price = product && product.selling_price != null ? Number(product.selling_price) : null;
  const unitCost = showCost ? cost.unitCost : null;
  return {
    bomId: bom.id,
    productSource: _src(bom.product_source),
    productId: bom.product_id,
    product: product ? {
      id: product.id, sku: product.sku || product.id, name: product.name, nameEn: product.name_en || '',
      productType: product.product_type, category: product.category || '', brandId: product.brand_id || null,
      unit: product.unit || '', imageVersion: product.image_version || null,
      sellingPrice: price, productionMethod: product.production_method || null,
      deductStrategy: product.deduct_strategy || null, costSource: product.cost_source || null,
      trackingMode: product.tracking_mode || null,
    } : null,
    status: bom.status,
    version: Number(bom.version) || 1,
    // The optimistic-lock token. DELIBERATELY not `version`: that is the
    // business revision number the user sees, and conflating the two would make
    // a concurrent edit look like a new recipe revision.
    rowVersion: Number(bom.row_version) || 1,
    revisionOf: bom.revision_of || null,
    yieldQuantity: Number(bom.yield_quantity),
    yieldUnit: bom.yield_unit || '',
    yieldUnitId: bom.yield_unit_id || null,
    effectiveFrom: bom.effective_from,
    effectiveTo: bom.effective_to,
    needsReview: !!bom.needs_review,
    notes: bom.notes || '',
    consumptionWarehouseId: bom.consumption_warehouse_id || null,
    createdBy: bom.created_by || null, createdAt: bom.created_at,
    updatedBy: bom.updated_by || null, updatedAt: bom.updated_at,
    approvedBy: bom.approved_by || null, approvedAt: bom.approved_at,
    lines,
    outputs,
    cost: showCost ? {
      batchCost: cost.batchCost,
      unitCost: cost.unitCost,
      sellingPrice: price,
      foodCostPct: R.foodCostPct(cost.unitCost, price),
      marginPct: R.marginPct(cost.unitCost, price),
      computedAt: bom.cost_computed_at,
      cachedBatchCost: bom.cost_batch == null ? null : Number(bom.cost_batch),
      anomalies: R.costAnomalies({
        unitCost: cost.unitCost, sellingPrice: price,
        missingComponentCost: lines.some((l) => !(Number(l.unitCost) > 0)),
      }),
    } : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// DETAIL by product — the ACTIVE recipe plus every version (the page URL is
// /menu/recipes/:source/:productId, so this is what that page loads)
// ════════════════════════════════════════════════════════════════════════════
router.get('/:source/:productId', READ, async (req, res, next) => {
  try {
    // `:source` is a 2-segment catch-all, so it also matches sibling routes such
    // as /where-used/:itemId. FALL THROUGH rather than 404 when the first
    // segment is not a real product source — that makes correctness independent
    // of registration order instead of quietly depending on it. (A 404 here is
    // exactly how /where-used/:itemId broke before this guard existed.)
    if (!_isValidSource(req.params.source)) return next();
    const source = _src(req.params.source);
    const productId = String(req.params.productId);
    const showCost = await _canSeeCost(req);

    const product = await _loadProduct(db, source, productId);
    if (!product) return _fail(req, res, 'NOT_FOUND', 'المنتج غير موجود');

    const versions = await _loadVersions(db, source, productId);
    // Prefer the active version; a product whose only recipe is a draft opens
    // on that draft; a product with NO recipe returns a null recipe and the
    // page renders its "create the first recipe" state (never an error).
    const chosen = versions.find((v) => v.status === 'active') || versions.find((v) => v.status === 'draft') || versions[0] || null;

    let recipe = null;
    if (chosen) {
      const [b] = await db.query('SELECT * FROM bom WHERE id=? LIMIT 1', [chosen.id]);
      const lines = await _loadLines(db, chosen.id, showCost);
      const outputs = await _loadOutputs(db, chosen.id);
      const cost = R.computeRecipeCost(lines.map((l) => ({
        baseQuantity: l.baseQuantity, wastePct: l.wastePct, unitCost: l.unitCost || 0,
      })), Number(b[0].yield_quantity) || 1);
      recipe = _shapeBom(b[0], product, lines, outputs, cost, showCost);
    }

    res.json({
      success: true,
      data: {
        productSource: source,
        productId,
        product: {
          id: product.id, sku: product.sku || product.id, name: product.name, nameEn: product.name_en || '',
          productType: product.product_type, category: product.category || '', brandId: product.brand_id || null,
          unit: product.unit || '', imageVersion: product.image_version || null,
          sellingPrice: product.selling_price == null ? null : Number(product.selling_price),
          productionMethod: product.production_method || null,
          deductStrategy: product.deduct_strategy || null,
          trackingMode: product.tracking_mode || null,
        },
        recipe,
        versions: versions.map((v) => ({
          bomId: v.id, version: Number(v.version) || 1, rowVersion: Number(v.row_version) || 1,
          status: v.status, yieldQuantity: Number(v.yield_quantity), yieldUnit: v.yield_unit || '',
          effectiveFrom: v.effective_from, effectiveTo: v.effective_to, revisionOf: v.revision_of || null,
          needsReview: !!v.needs_review,
          createdBy: v.created_by, createdAt: v.created_at,
          updatedBy: v.updated_by, updatedAt: v.updated_at,
          approvedBy: v.approved_by, approvedAt: v.approved_at,
          cachedUnitCost: showCost && v.cost_per_unit != null ? Number(v.cost_per_unit) : null,
        })),
      },
      canViewCost: showCost,
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// WHERE-USED — which recipes consume this component, and which products would
// be affected by a change to it
// ════════════════════════════════════════════════════════════════════════════
router.get('/where-used/:itemId', READ, async (req, res) => {
  try {
    const itemId = String(req.params.itemId);
    const [rows] = await db.query(
      `SELECT b.id AS bom_id, b.product_id, COALESCE(b.product_source,'inv') AS product_source,
              b.version, b.status, b.yield_quantity,
              COALESCE(m.name, i.name, b.product_id) AS product_name,
              COALESCE(m.name_en, i.name_en, '') AS product_name_en,
              bl.quantity, bl.base_quantity, bl.waste_pct, bl.entered_unit_code
         FROM bom_lines bl
         JOIN bom b ON b.id = bl.bom_id
         LEFT JOIN menu m ON m.id=b.product_id AND COALESCE(b.product_source,'inv')='menu'
         LEFT JOIN inv_items i ON i.id=b.product_id AND COALESCE(b.product_source,'inv')='inv'
        WHERE bl.component_item_id=?
        ORDER BY b.status='active' DESC, product_name`, [itemId]);
    // The legacy flat `recipe` table still has rows on some deployments; a
    // where-used that ignored it would under-report the blast radius.
    let legacy = [];
    try {
      const [lr] = await db.query(
        `SELECT r.menu_id AS product_id, m.name AS product_name, COALESCE(m.name_en,'') AS product_name_en, r.qty_used
           FROM recipe r JOIN menu m ON m.id=r.menu_id WHERE r.inv_item_id=?`, [itemId]);
      legacy = lr;
    } catch (_) { legacy = []; }
    res.json({
      success: true,
      data: {
        itemId,
        usedIn: rows.map((r) => ({
          bomId: r.bom_id, productId: r.product_id, productSource: r.product_source,
          productName: r.product_name, productNameEn: r.product_name_en,
          version: Number(r.version) || 1, status: r.status,
          yieldQuantity: Number(r.yield_quantity),
          quantity: Number(r.quantity), baseQuantity: Number(r.base_quantity != null ? r.base_quantity : r.quantity),
          wastePct: Number(r.waste_pct) || 0, unit: r.entered_unit_code || '', origin: 'bom',
        })).concat(legacy.map((r) => ({
          bomId: null, productId: r.product_id, productSource: 'menu',
          productName: r.product_name, productNameEn: r.product_name_en,
          version: null, status: 'legacy', yieldQuantity: 1,
          quantity: Number(r.qty_used) || 0, baseQuantity: Number(r.qty_used) || 0,
          wastePct: 0, unit: '', origin: 'legacy_recipe',
        }))),
        activeCount: rows.filter((r) => r.status === 'active').length,
        totalCount: rows.length + legacy.length,
      },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// WAREHOUSE AVAILABILITY — how many batches of this recipe the stock supports
// ════════════════════════════════════════════════════════════════════════════
router.get('/bom/:bomId/availability', READ, async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : null;
    if (warehouseId && req.guardWh && !req.guardWh(res, warehouseId)) return;
    const [b] = await db.query('SELECT * FROM bom WHERE id=? LIMIT 1', [req.params.bomId]);
    if (!b.length) return _fail(req, res, 'NOT_FOUND', 'الوصفة غير موجودة');
    const bom = b[0];
    const batches = Math.max(0.000001, Number(req.query.batches) || 1);
    const [lines] = await db.query(
      `SELECT bl.component_item_id, COALESCE(bl.base_quantity, bl.quantity) AS base_quantity, bl.waste_pct,
              i.name AS item_name, COALESCE(i.name_en,'') AS item_name_en, i.unit AS base_unit,
              COALESCE(i.stock,0) AS global_stock
         FROM bom_lines bl LEFT JOIN inv_items i ON i.id=bl.component_item_id
        WHERE bl.bom_id=? ORDER BY bl.line_no, bl.id`, [req.params.bomId]);
    const ids = lines.map((l) => l.component_item_id);
    const stock = new Map();
    if (warehouseId && ids.length) {
      const [ws] = await db.query('SELECT item_id, qty FROM warehouse_stock WHERE warehouse_id=? AND item_id IN (?)', [warehouseId, ids]);
      for (const r of ws) stock.set(r.item_id, Number(r.qty) || 0);
    }
    let makeableBatches = Infinity;
    const items = lines.map((l) => {
      const required = R.round6(Number(l.base_quantity) * (1 + (Number(l.waste_pct) || 0) / 100) * batches);
      const available = warehouseId
        ? (stock.has(l.component_item_id) ? stock.get(l.component_item_id) : 0)
        : Number(l.global_stock) || 0;
      const perBatch = required / batches;
      const canMake = perBatch > 0 ? available / perBatch : Infinity;
      if (canMake < makeableBatches) makeableBatches = canMake;
      return {
        itemId: l.component_item_id, itemName: l.item_name || l.component_item_id,
        itemNameEn: l.item_name_en || '', unit: l.base_unit || '',
        required, available, delta: R.round6(available - required),
        status: available >= required ? 'ok' : 'short',
      };
    });
    if (!Number.isFinite(makeableBatches)) makeableBatches = 0;
    const shortageCount = items.filter((i) => i.status === 'short').length;
    res.json({
      success: true,
      data: {
        bomId: bom.id, warehouseId, batches,
        items,
        summary: {
          shortageCount, allAvailable: shortageCount === 0, itemCount: items.length,
          makeableBatches: R.round4(Math.max(0, makeableBatches)),
          makeableQuantity: R.round4(Math.max(0, makeableBatches) * (Number(bom.yield_quantity) || 1)),
        },
      },
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// COMPARE two versions — a real diff, not two tables side by side
// ════════════════════════════════════════════════════════════════════════════
router.get('/compare', READ, async (req, res) => {
  try {
    const aId = String(req.query.a || ''), bId = String(req.query.b || '');
    if (!aId || !bId) return _fail(req, res, 'VALIDATION_ERROR', 'حدّد نسختين للمقارنة (a و b)');
    const showCost = await _canSeeCost(req);
    const [rows] = await db.query('SELECT * FROM bom WHERE id IN (?, ?)', [aId, bId]);
    const A = rows.find((r) => r.id === aId), B = rows.find((r) => r.id === bId);
    if (!A || !B) return _fail(req, res, 'NOT_FOUND', 'إحدى النسختين غير موجودة');
    const [la, lb] = [await _loadLines(db, aId, showCost), await _loadLines(db, bId, showCost)];
    const byId = (ls) => new Map(ls.map((l) => [l.componentItemId, l]));
    const ma = byId(la), mb = byId(lb);
    const all = Array.from(new Set(la.map((l) => l.componentItemId).concat(lb.map((l) => l.componentItemId))));
    const lineDiff = all.map((id) => {
      const a = ma.get(id) || null, b = mb.get(id) || null;
      let change = 'unchanged';
      if (!a) change = 'added';
      else if (!b) change = 'removed';
      else if (R.round6(a.baseQuantity) !== R.round6(b.baseQuantity) || R.round2(a.wastePct) !== R.round2(b.wastePct)) change = 'modified';
      return {
        componentItemId: id,
        itemName: (a || b).itemName, itemNameEn: (a || b).itemNameEn, unit: (a || b).baseUnit,
        change,
        before: a ? { baseQuantity: a.baseQuantity, wastePct: a.wastePct, lineCost: a.lineCost } : null,
        after: b ? { baseQuantity: b.baseQuantity, wastePct: b.wastePct, lineCost: b.lineCost } : null,
      };
    }).sort((x, y) => (x.change === 'unchanged' ? 1 : 0) - (y.change === 'unchanged' ? 1 : 0) || x.itemName.localeCompare(y.itemName, 'ar'));
    const costOf = (ls, y) => R.computeRecipeCost(ls.map((l) => ({ baseQuantity: l.baseQuantity, wastePct: l.wastePct, unitCost: l.unitCost || 0 })), Number(y) || 1);
    const ca = costOf(la, A.yield_quantity), cb = costOf(lb, B.yield_quantity);
    res.json({
      success: true,
      data: {
        a: { bomId: A.id, version: Number(A.version), status: A.status, yieldQuantity: Number(A.yield_quantity), unitCost: showCost ? ca.unitCost : null },
        b: { bomId: B.id, version: Number(B.version), status: B.status, yieldQuantity: Number(B.yield_quantity), unitCost: showCost ? cb.unitCost : null },
        header: {
          yieldQuantityChanged: R.round6(A.yield_quantity) !== R.round6(B.yield_quantity),
          yieldUnitChanged: (A.yield_unit || '') !== (B.yield_unit || ''),
        },
        lines: lineDiff,
        costDelta: showCost ? { batch: R.round4(cb.batchCost - ca.batchCost), unit: R.round6(cb.unitCost - ca.unitCost) } : null,
        summary: {
          added: lineDiff.filter((d) => d.change === 'added').length,
          removed: lineDiff.filter((d) => d.change === 'removed').length,
          modified: lineDiff.filter((d) => d.change === 'modified').length,
        },
      },
      canViewCost: showCost,
    });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SAVE — create, edit-in-place (drafts only) or mint a REVISION (active)
// ════════════════════════════════════════════════════════════════════════════
/**
 * ONE transaction covers the header, every line, every output, the recomputed
 * cost and the audit row. The endpoints this replaces did a bare
 * `DELETE FROM bom_lines` on the pool followed by N INSERTs, so a failure
 * halfway through left a recipe holding a subset of its own components.
 *
 * expectedVersion is checked against `row_version`, NOT `version`. See the
 * comment on `rowVersion` in _shapeBom for why those must stay distinct.
 */
// ════════════════════════════════════════════════════════════════════════════
// THE recipe save — exported so the two LEGACY endpoints delegate here
// (routes/menu.js POST /:id/recipe-bom and routes/erp-core.js POST /bom)
// instead of keeping their own divergent rules. They stay mounted as a
// compatibility layer for existing callers; they no longer own any logic.
//
// ONE transaction covers the header, every line, every output, the recomputed
// cost and the audit row. Throws typed errors (code + optional detail); the
// HTTP layer maps them.
// ════════════════════════════════════════════════════════════════════════════
async function saveRecipe(o) {
  const source = _src(o.source);
  const productId = String(o.productId);
  const actor = o.actor || '';
  const b = o.body || {};
  const reqIp = o.ip || null;
  const product = await _loadProduct(db, source, productId);
  if (!product) throw _err('NOT_FOUND', 'المنتج غير موجود');

  // ── validate BEFORE touching anything ──────────────────────────────────
  R.validateHeader({
    yieldQuantity: b.yieldQuantity,
    status: b.status,
    effectiveFrom: b.effectiveFrom,
    effectiveTo: b.effectiveTo,
  });
  const canonical = R.canonicalizeLines(b.lines || []);
  if (!canonical.length) throw _err('VALIDATION_ERROR', 'الوصفة تحتاج مكوّنًا واحدًا على الأقل');

  const expectedVersion = b.expectedVersion != null ? parseInt(b.expectedVersion, 10)
    : (o.ifMatch != null ? parseInt(o.ifMatch, 10) : null);

  const out = await db.withTransaction(async (conn) => {
    // ── resolve the target row (FOR UPDATE) ─────────────────────────────
    const [existing] = await conn.query(
      `SELECT * FROM bom WHERE product_id=? AND COALESCE(product_source,'inv')=?
        ORDER BY FIELD(status,'active','draft','archived'), version DESC FOR UPDATE`,
      [productId, source]);
    const target = b.bomId ? existing.find((r) => r.id === String(b.bomId))
      : (existing.find((r) => r.status === 'active') || existing.find((r) => r.status === 'draft') || null);

    if (b.bomId && !target) throw _err('NOT_FOUND', 'النسخة المطلوبة غير موجودة لهذا المنتج');
    if (target && target.status === 'archived') {
      throw _err('RECIPE_IMMUTABLE', 'لا يمكن تعديل نسخة مؤرشفة — أنشئ نسخة جديدة (clone)');
    }
    if (target && expectedVersion != null && Number(target.row_version) !== expectedVersion) {
      throw _err('VERSION_CONFLICT', 'تغيّرت الوصفة منذ آخر تحميل — أعد التحميل');
    }
    if (target && expectedVersion == null) {
      throw _err('VALIDATION_ERROR', 'expectedVersion مطلوب لتعديل وصفة قائمة');
    }

    // An ACTIVE recipe is in use by production and by sale-time deduction.
    // It is never edited in place — the save becomes a new draft revision.
    const revising = !!(target && R.requiresRevision(target.status));
    const maxVersion = existing.reduce((m, r) => Math.max(m, Number(r.version) || 1), 0);

    // ── units: free text is gone, every line carries a registered unit and
    //    a SNAPSHOTTED factor so a later unit redefinition cannot restate
    //    this recipe ──────────────────────────────────────────────────────
    const resolved = [];
    for (const l of canonical) {
      const [it] = await conn.query('SELECT id FROM inv_items WHERE id=? AND deleted_at IS NULL LIMIT 1', [l.componentItemId]);
      if (!it.length) throw _err('VALIDATION_ERROR', 'مكوّن غير موجود في المخزون: ' + l.componentItemId, { componentItemId: l.componentItemId });
      const u = await IU.resolveLineBase(conn, l.componentItemId, {
        enteredUnitId: l.enteredUnitId, enteredUnitCode: l.enteredUnitCode, enteredQty: l.quantity,
      }, 'production', { allowUnset: true });
      resolved.push(Object.assign({}, l, {
        enteredUnitId: u.enteredUnitId, enteredUnitCode: u.enteredUnitCode,
        conversionFactor: u.conversionFactorSnapshot, baseQuantity: u.baseQty,
      }));
    }

    // ── cycles: self-reference and multi-level ──────────────────────────
    const graph = await _loadRecipeGraph(conn, target ? target.id : null);
    R.assertAcyclic(source, productId, resolved.map((l) => l.componentItemId), graph);

    // ── outputs (joint production). Default to a single primary derived
    //    from the yield so a plain recipe needs no outputs block. ─────────
    const rawOutputs = Array.isArray(b.outputs) && b.outputs.length ? b.outputs : [{
      outputType: 'primary', productId, productSource: source,
      quantity: Number(b.yieldQuantity), allocMethod: 'standard_cost',
    }];
    const primaries = rawOutputs.filter((o) => (o.outputType || 'primary') === 'primary');
    if (primaries.length !== 1) throw _err('VALIDATION_ERROR', 'يجب تحديد مخرج رئيسي واحد بالضبط');
    const seenOut = new Set();
    const outputs = [];
    for (let i = 0; i < rawOutputs.length; i++) {
      const o = rawOutputs[i];
      const oSrc = _src(o.productSource || source);
      const oid = String(o.productId || productId);
      const dedupeKey = oSrc + ':' + oid;
      if (seenOut.has(dedupeKey)) throw _err('VALIDATION_ERROR', 'مخرج مكرر: ' + oid, { productId: oid });
      seenOut.add(dedupeKey);
      const qty = Number(o.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw _err('VALIDATION_ERROR', 'كمية المخرج يجب أن تكون موجبة', { productId: oid });
      if (R.OUTPUT_TYPES.indexOf(String(o.outputType || 'primary')) === -1) throw _err('VALIDATION_ERROR', 'نوع مخرج غير معروف: ' + o.outputType);
      if (o.allocMethod && R.ALLOC_METHODS.indexOf(String(o.allocMethod)) === -1) throw _err('VALIDATION_ERROR', 'أسلوب توزيع غير معروف: ' + o.allocMethod);
      let factor = 1, unitId = null, unitCode = o.enteredUnitCode || null;
      if (oSrc === 'inv') {
        const u = await IU.resolveLineBase(conn, oid, {
          enteredUnitId: o.enteredUnitId, enteredUnitCode: o.enteredUnitCode, enteredQty: qty,
        }, 'production', { allowUnset: true });
        factor = u.conversionFactorSnapshot; unitId = u.enteredUnitId; unitCode = u.enteredUnitCode;
      }
      outputs.push({
        outputType: String(o.outputType || 'primary'), productId: oid, productSource: oSrc,
        quantity: qty, enteredUnitId: unitId, enteredUnitCode: unitCode,
        conversionFactor: factor, baseQuantity: R.round6(qty * factor),
        warehouseId: o.warehouseId || null,
        allocMethod: String(o.allocMethod || 'standard_cost'),
        allocValue: o.allocValue == null ? null : Number(o.allocValue),
        requiresLot: o.requiresLot ? 1 : 0, lineNo: i, notes: o.notes ? String(o.notes).slice(0, 300) : null,
      });
    }
    // Proving the allocation is solvable NOW beats discovering at posting
    // time that the percentages sum past 100 with WIP already relieved.
    R.allocateJointCost(outputs.map((o) => ({
      id: o.productId, outputType: o.outputType, baseQuantity: o.baseQuantity,
      allocMethod: o.allocMethod, allocValue: o.allocValue,
    })), 100);

    // ── write the header ────────────────────────────────────────────────
    const yieldQ = Number(b.yieldQuantity);
    const status = b.activate === true ? 'active' : 'draft';
    const header = {
      yield_quantity: yieldQ,
      yield_unit: (b.yieldUnit || product.unit || 'PCS').toString().slice(0, 20),
      yield_unit_id: b.yieldUnitId || null,
      effective_from: b.effectiveFrom || null,
      effective_to: b.effectiveTo || null,
      notes: b.notes == null ? null : String(b.notes).slice(0, 2000),
      consumption_warehouse_id: b.consumptionWarehouseId || null,
      needs_review: b.needsReview ? 1 : 0,
    };

    let bomId, newVersion, newRowVersion, action;
    if (!target) {
      bomId = 'BOM-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      newVersion = 1; newRowVersion = 1; action = 'create';
      await conn.query(
        `INSERT INTO bom (id, product_id, product_source, version, row_version, status, yield_quantity,
                          yield_unit, yield_unit_id, is_active, effective_from, effective_to, notes,
                          consumption_warehouse_id, needs_review, created_by, updated_by, updated_at)
         VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [bomId, productId, source, 1, status, header.yield_quantity, header.yield_unit, header.yield_unit_id,
         status === 'active' ? 1 : 0, header.effective_from, header.effective_to, header.notes,
         header.consumption_warehouse_id, header.needs_review, actor, actor]);
    } else if (revising) {
      bomId = 'BOM-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      newVersion = maxVersion + 1; newRowVersion = 1; action = 'revise';
      await conn.query(
        `INSERT INTO bom (id, product_id, product_source, version, row_version, status, yield_quantity,
                          yield_unit, yield_unit_id, is_active, effective_from, effective_to, notes,
                          consumption_warehouse_id, needs_review, revision_of, created_by, updated_by, updated_at)
         VALUES (?,?,?,?,1,'draft',?,?,?,0,?,?,?,?,?,?,?,?,NOW())`,
        [bomId, productId, source, newVersion, header.yield_quantity, header.yield_unit, header.yield_unit_id,
         header.effective_from, header.effective_to, header.notes, header.consumption_warehouse_id,
         header.needs_review, target.id, actor, actor]);
    } else {
      bomId = target.id; newVersion = Number(target.version) || 1; action = 'edit';
      const [u] = await conn.query(
        `UPDATE bom SET yield_quantity=?, yield_unit=?, yield_unit_id=?, effective_from=?, effective_to=?,
                        notes=?, consumption_warehouse_id=?, needs_review=?, status=?, is_active=?,
                        updated_by=?, updated_at=NOW(), row_version=row_version+1
           WHERE id=? AND row_version=?`,
        [header.yield_quantity, header.yield_unit, header.yield_unit_id, header.effective_from,
         header.effective_to, header.notes, header.consumption_warehouse_id, header.needs_review,
         status, status === 'active' ? 1 : 0, actor, bomId, expectedVersion]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت الوصفة منذ آخر تحميل — أعد التحميل');
      newRowVersion = expectedVersion + 1;
    }

    // ── lines ───────────────────────────────────────────────────────────
    await conn.query('DELETE FROM bom_lines WHERE bom_id=?', [bomId]);
    for (const l of resolved) {
      await conn.query(
        `INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct, line_no,
                                entered_unit_id, entered_unit_code, conversion_factor, base_quantity, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['BL-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'), bomId, l.componentItemId,
         l.quantity, (l.enteredUnitCode || 'PCS').toString().slice(0, 20), l.wastePct, l.lineNo,
         l.enteredUnitId, l.enteredUnitCode, l.conversionFactor, l.baseQuantity, l.notes]);
    }

    // ── outputs ─────────────────────────────────────────────────────────
    await conn.query('DELETE FROM bom_outputs WHERE bom_id=?', [bomId]);
    for (const o of outputs) {
      await conn.query(
        `INSERT INTO bom_outputs (id, bom_id, output_type, product_id, product_source, quantity,
                                  entered_unit_id, entered_unit_code, conversion_factor, base_quantity,
                                  warehouse_id, alloc_method, alloc_value, requires_lot, line_no, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['BOUT-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'), bomId, o.outputType,
         o.productId, o.productSource, o.quantity, o.enteredUnitId, o.enteredUnitCode, o.conversionFactor,
         o.baseQuantity, o.warehouseId, o.allocMethod, o.allocValue, o.requiresLot, o.lineNo, o.notes]);
    }

    // ── cost: computed HERE, from component costs read inside this same
    //    transaction. A cost sent by the client is ignored outright. ──────
    const [costRows] = await conn.query(
      `SELECT bl.component_item_id, COALESCE(bl.base_quantity, bl.quantity) AS base_quantity, bl.waste_pct,
              CASE WHEN i.cost_method='standard' THEN COALESCE(i.standard_cost,0) ELSE COALESCE(i.cost,0) END AS unit_cost
         FROM bom_lines bl LEFT JOIN inv_items i ON i.id=bl.component_item_id WHERE bl.bom_id=?`, [bomId]);
    const cost = R.computeRecipeCost(costRows.map((r) => ({
      baseQuantity: Number(r.base_quantity), wastePct: Number(r.waste_pct), unitCost: Number(r.unit_cost),
    })), yieldQ);
    await conn.query('UPDATE bom SET cost_batch=?, cost_per_unit=?, cost_computed_at=NOW() WHERE id=?',
      [cost.batchCost, cost.unitCost, bomId]);

    // ── activation: exactly ONE active version per product ──────────────
    if (status === 'active') {
      await conn.query(
        `UPDATE bom SET status='archived', is_active=0 WHERE product_id=? AND COALESCE(product_source,'inv')=?
           AND id<>? AND status='active'`, [productId, source, bomId]);
    }

    // ── cascade the recipe cost onto the product, preserving exactly what
    //    the two legacy writers did (menu.cost + computed_cost + the
    //    cost_source='recipe' stamp that arms the manual-edit 409 lock in
    //    routes/menu.js PUT /:id, and the semi-finished mirror into
    //    inv_items.cost). NOT swallowed: a cascade failure now rolls the
    //    whole save back instead of leaving cost and recipe disagreeing. ──
    if (status === 'active') {
      if (source === 'menu') {
        await conn.query("UPDATE menu SET cost=?, computed_cost=?, cost_source='recipe', bom_id=? WHERE id=?",
          [cost.unitCost, cost.unitCost, bomId, productId]);
        const [mr] = await conn.query('SELECT is_semi_finished FROM menu WHERE id=?', [productId]);
        if (mr.length && Number(mr[0].is_semi_finished)) {
          // No-ops harmlessly (0 rows) when no inv_items twin exists.
          await conn.query('UPDATE inv_items SET cost=? WHERE id=?', [cost.unitCost, productId]);
        }
      } else {
        await conn.query("UPDATE inv_items SET cost=? WHERE id=? AND COALESCE(cost_method,'wavg')<>'wavg'", [cost.unitCost, productId]);
      }
    }

    // ── audit: FAIL-CLOSED. logAuditTx deliberately has no try/catch, and
    //    it runs on this transaction's connection, so a recipe can never be
    //    written without its audit row. ────────────────────────────────────
    await logAuditTx(conn, 'recipe.' + action, 'bom', bomId, actor, JSON.stringify({
      productSource: source, productId, version: newVersion, status,
      lineCount: resolved.length, outputCount: outputs.length,
      batchCost: cost.batchCost, unitCost: cost.unitCost,
      revisionOf: revising ? target.id : null,
      mergedDuplicates: canonical.filter((l) => l.mergedFrom > 1).map((l) => l.componentItemId),
    }), reqIp);

    return { bomId, version: newVersion, rowVersion: newRowVersion, status, action, cost, mergedCount: canonical.filter((l) => l.mergedFrom > 1).length };
  });
  return out;
}

router.post('/:source/:productId', MGR, requireCapability('inventory.edit'), async (req, res, next) => {
  let idemId = null;
  try {
    // Same fall-through rule as the GET catch-all above.
    if (!_isValidSource(req.params.source)) return next();
    const source = _src(req.params.source);
    const productId = String(req.params.productId);
    const actor = _actor(req);
    const b = req.body || {};

    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'recipe:save', source + ':' + productId, key, actor, b);
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(req, res, 'IDEMPOTENCY_CONFLICT', 'طلب حفظ مكرر بمحتوى مختلف أو قيد التنفيذ');
    if (idem.mode === 'proceed') idemId = idem.idemId;

    const out = await saveRecipe({
      source, productId, actor, ip: req.ip, body: b,
      ifMatch: (req.get && req.get('If-Match')) || null,
    });

    const body = {
      success: true,
      data: {
        bomId: out.bomId, productSource: source, productId,
        version: out.version, rowVersion: out.rowVersion, status: out.status, action: out.action,
        batchCost: out.cost.batchCost, unitCost: out.cost.unitCost,
      },
      warnings: out.mergedCount > 0
        ? [{ code: 'DUPLICATE_COMPONENTS_MERGED', message: 'تم دمج ' + out.mergedCount + ' مكوّن مكرر' }]
        : [],
      requestId: req.requestId || null,
    };
    if (idemId) await IDEM.complete(db, idemId, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    return _catch(req, res, e);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ACTIVATE a draft revision — atomically archives the previous active one
// ════════════════════════════════════════════════════════════════════════════
router.post('/bom/:bomId/activate', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    const actor = _actor(req);
    const expected = req.body && req.body.expectedVersion != null ? parseInt(req.body.expectedVersion, 10) : null;
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM bom WHERE id=? FOR UPDATE', [req.params.bomId]);
      if (!rows.length) throw _err('NOT_FOUND', 'الوصفة غير موجودة');
      const bom = rows[0];
      if (bom.status === 'active') throw _err('VALIDATION_ERROR', 'هذه النسخة نشطة بالفعل');
      if (bom.status === 'archived') throw _err('RECIPE_IMMUTABLE', 'لا يمكن تفعيل نسخة مؤرشفة — أنشئ نسخة جديدة');
      if (expected != null && Number(bom.row_version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّرت الوصفة — أعد التحميل');
      const [ln] = await conn.query('SELECT COUNT(*) AS c FROM bom_lines WHERE bom_id=?', [bom.id]);
      if (!Number(ln[0].c)) throw _err('VALIDATION_ERROR', 'لا يمكن تفعيل وصفة بلا مكوّنات');

      const src = _src(bom.product_source);
      await conn.query(
        `UPDATE bom SET status='archived', is_active=0 WHERE product_id=? AND COALESCE(product_source,'inv')=?
           AND id<>? AND status='active'`, [bom.product_id, src, bom.id]);
      const [u] = await conn.query(
        `UPDATE bom SET status='active', is_active=1, approved_by=?, approved_at=NOW(),
                        updated_by=?, updated_at=NOW(), row_version=row_version+1
           WHERE id=? AND status='draft'` + (expected != null ? ' AND row_version=?' : ''),
        expected != null ? [actor, actor, bom.id, expected] : [actor, actor, bom.id]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الوصفة — أعد التحميل');

      const [costRows] = await conn.query(
        `SELECT COALESCE(bl.base_quantity, bl.quantity) AS base_quantity, bl.waste_pct,
                CASE WHEN i.cost_method='standard' THEN COALESCE(i.standard_cost,0) ELSE COALESCE(i.cost,0) END AS unit_cost
           FROM bom_lines bl LEFT JOIN inv_items i ON i.id=bl.component_item_id WHERE bl.bom_id=?`, [bom.id]);
      const cost = R.computeRecipeCost(costRows.map((r) => ({
        baseQuantity: Number(r.base_quantity), wastePct: Number(r.waste_pct), unitCost: Number(r.unit_cost),
      })), Number(bom.yield_quantity) || 1);
      await conn.query('UPDATE bom SET cost_batch=?, cost_per_unit=?, cost_computed_at=NOW() WHERE id=?',
        [cost.batchCost, cost.unitCost, bom.id]);
      if (src === 'menu') {
        await conn.query("UPDATE menu SET cost=?, computed_cost=?, cost_source='recipe', bom_id=? WHERE id=?",
          [cost.unitCost, cost.unitCost, bom.id, bom.product_id]);
        const [mr] = await conn.query('SELECT is_semi_finished FROM menu WHERE id=?', [bom.product_id]);
        if (mr.length && Number(mr[0].is_semi_finished)) {
          await conn.query('UPDATE inv_items SET cost=? WHERE id=?', [cost.unitCost, bom.product_id]);
        }
      }
      await logAuditTx(conn, 'recipe.activate', 'bom', bom.id, actor, JSON.stringify({
        productSource: src, productId: bom.product_id, version: Number(bom.version), unitCost: cost.unitCost,
      }), req.ip);
      return { bomId: bom.id, version: Number(bom.version), rowVersion: Number(bom.row_version) + 1, cost };
    });
    res.json({ success: true, data: { bomId: out.bomId, status: 'active', version: out.version, rowVersion: out.rowVersion, unitCost: out.cost.unitCost }, requestId: req.requestId || null });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// CLONE — a new DRAFT revision from any version (the only way to change an
// archived or active recipe)
// ════════════════════════════════════════════════════════════════════════════
router.post('/bom/:bomId/clone', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    const actor = _actor(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM bom WHERE id=? LIMIT 1', [req.params.bomId]);
      if (!rows.length) throw _err('NOT_FOUND', 'الوصفة غير موجودة');
      const src0 = rows[0];
      const source = _src(src0.product_source);
      const [[mx]] = await conn.query(
        `SELECT COALESCE(MAX(version),0) AS v FROM bom WHERE product_id=? AND COALESCE(product_source,'inv')=? FOR UPDATE`,
        [src0.product_id, source]);
      const newVersion = Number(mx.v) + 1;
      const newId = 'BOM-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      await conn.query(
        `INSERT INTO bom (id, product_id, product_source, version, row_version, status, yield_quantity, yield_unit,
                          yield_unit_id, is_active, effective_from, effective_to, notes, consumption_warehouse_id,
                          needs_review, revision_of, created_by, updated_by, updated_at)
         VALUES (?,?,?,?,1,'draft',?,?,?,0,?,?,?,?,?,?,?,?,NOW())`,
        [newId, src0.product_id, source, newVersion, src0.yield_quantity, src0.yield_unit, src0.yield_unit_id,
         req.body && req.body.effectiveFrom ? req.body.effectiveFrom : null,
         req.body && req.body.effectiveTo ? req.body.effectiveTo : null,
         (req.body && req.body.notes != null) ? String(req.body.notes).slice(0, 2000) : src0.notes,
         src0.consumption_warehouse_id, 0, src0.id, actor, actor]);
      await conn.query(
        `INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct, line_no,
                                entered_unit_id, entered_unit_code, conversion_factor, base_quantity, notes)
         SELECT CONCAT('BL-', ?, '-', SUBSTRING(MD5(CONCAT(id, ?)), 1, 10)), ?, component_item_id, quantity, unit,
                waste_pct, line_no, entered_unit_id, entered_unit_code, conversion_factor, base_quantity, notes
           FROM bom_lines WHERE bom_id=?`, [Date.now(), newId, newId, src0.id]);
      await conn.query(
        `INSERT INTO bom_outputs (id, bom_id, output_type, product_id, product_source, quantity, entered_unit_id,
                                  entered_unit_code, conversion_factor, base_quantity, warehouse_id, alloc_method,
                                  alloc_value, requires_lot, line_no, notes)
         SELECT CONCAT('BOUT-', ?, '-', SUBSTRING(MD5(CONCAT(id, ?)), 1, 10)), ?, output_type, product_id,
                product_source, quantity, entered_unit_id, entered_unit_code, conversion_factor, base_quantity,
                warehouse_id, alloc_method, alloc_value, requires_lot, line_no, notes
           FROM bom_outputs WHERE bom_id=?`, [Date.now(), newId, newId, src0.id]);
      await logAuditTx(conn, 'recipe.clone', 'bom', newId, actor, JSON.stringify({
        clonedFrom: src0.id, productSource: source, productId: src0.product_id, version: newVersion,
      }), req.ip);
      return { bomId: newId, version: newVersion, productSource: source, productId: src0.product_id };
    });
    res.status(201).json({ success: true, data: Object.assign({ status: 'draft', rowVersion: 1 }, out), requestId: req.requestId || null });
  } catch (e) { _catch(req, res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// ARCHIVE — retire a version without deleting history
// ════════════════════════════════════════════════════════════════════════════
router.post('/bom/:bomId/archive', MGR, requireCapability('inventory.edit'), async (req, res) => {
  try {
    const actor = _actor(req);
    const expected = req.body && req.body.expectedVersion != null ? parseInt(req.body.expectedVersion, 10) : null;
    await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM bom WHERE id=? FOR UPDATE', [req.params.bomId]);
      if (!rows.length) throw _err('NOT_FOUND', 'الوصفة غير موجودة');
      const bom = rows[0];
      if (expected != null && Number(bom.row_version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّرت الوصفة — أعد التحميل');
      // An active recipe that production is mid-run against must not vanish
      // underneath those orders.
      const [open] = await conn.query(
        `SELECT id, order_number FROM production_orders
          WHERE bom_id=? AND status IN ('draft','approved','in_progress','planned','released') LIMIT 5`, [bom.id]);
      if (open.length) {
        throw _err('RECIPE_IMMUTABLE', 'لا يمكن أرشفة وصفة لها أوامر إنتاج مفتوحة: ' + open.map((o) => o.order_number).join('، '));
      }
      const [u] = await conn.query(
        `UPDATE bom SET status='archived', is_active=0, updated_by=?, updated_at=NOW(), row_version=row_version+1
           WHERE id=?` + (expected != null ? ' AND row_version=?' : ''),
        expected != null ? [actor, bom.id, expected] : [actor, bom.id]);
      if (!u || u.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت الوصفة — أعد التحميل');
      await logAuditTx(conn, 'recipe.archive', 'bom', bom.id, actor, JSON.stringify({ version: Number(bom.version) }), req.ip);
    });
    res.json({ success: true, data: { bomId: req.params.bomId, status: 'archived' }, requestId: req.requestId || null });
  } catch (e) { _catch(req, res, e); }
});

module.exports = router;
// `saveRecipe` is the ONE write path. routes/menu.js and routes/erp-core.js
// import it so their legacy endpoints keep working for existing callers without
// keeping any rules of their own.
module.exports.saveRecipe = saveRecipe;
module.exports.HTTP_FOR = HTTP_FOR;
module.exports._internals = { _loadProduct, _loadLines, _loadOutputs, _loadRecipeGraph, _shapeBom, _canSeeCost, _fail, _err, HTTP_FOR };
