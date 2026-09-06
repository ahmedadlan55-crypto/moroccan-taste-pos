/**
 * Reports built on the immutable valued movement ledger.
 *
 *   GET /reports/inventory-value/stock-card    — one item's valued movements
 *   GET /reports/inventory-value/roll-forward  — opening + in − out = closing
 *   GET /reports/inventory-value/nrv           — lower of cost and NRV, per item
 *   GET /reports/inventory-value/products-below-cost — products priced under cost
 *
 * ─── WHY THESE COULD NOT EXIST BEFORE ───────────────────────────────────────
 * Both need the cost of a movement AS IT STOOD WHEN THE MOVEMENT HAPPENED.
 * `inventory_movements` stores quantity only, and `warehouse_stock.avg_cost` is
 * today's average — so pricing a March quantity meant applying an August cost
 * and calling the result "historical". That is why they were kept OUT of the
 * catalogue rather than shipped wrong. `inventory_value_ledger` records the
 * cost per movement, so the question is now answerable.
 *
 * ─── THE HONESTY GUARD ──────────────────────────────────────────────────────
 * The ledger is forward-only: rows before `activated_at` were never written,
 * because their cost at the time is not recoverable. So every endpoint here
 * REFUSES a `from` earlier than that date instead of returning a partial
 * period. A half-covered month looks exactly like a quiet month, and a reader
 * cannot tell the difference from the page. `LEDGER_STARTS_LATER` carries the
 * real start date so the UI can say what the earliest answerable date is
 * rather than showing an empty table.
 */
'use strict';

const router = require('express').Router();
const pool = require('../../../db/connection');
const { hasCapability } = require('../../../middleware/requireCapability');
const RE = require('../../../lib/reportErrors');
const SNAP = require('../../../lib/reportSnapshot');
const IVL = require('../../../lib/inventoryValueLedger');

/** Reading inventory value is a finance-or-inventory question, not either alone. */
async function READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const allowed = await hasCapability(req.user, 'finance.reports.view')
      || await hasCapability(req.user, 'inventory.reports')
      || await hasCapability(req.user, 'reports.view');
    if (!allowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية' });
  }
}

function badRequest(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  error.http = 422;
  error.expose = true;
  if (extra) Object.assign(error, extra);
  return error;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(value, field) {
  const raw = String(value || '').trim();
  if (!ISO_DATE.test(raw)) {
    throw badRequest('VALIDATION_ERROR', `${field} مطلوب بصيغة YYYY-MM-DD`);
  }
  return raw;
}

/**
 * Refuse a window the ledger cannot honestly cover.
 *
 * Returns the ledger's start date so the caller can report it. A report that
 * silently clipped `from` forward would answer a question nobody asked and
 * label it with the period they DID ask for.
 */
async function assertCoverage(from) {
  const startsAt = await IVL.reportingStartsAt(pool);
  if (!startsAt) {
    throw badRequest('LEDGER_NOT_ACTIVATED', 'دفتر قيمة المخزون لم يُفعَّل بعد على هذا الخادم.');
  }
  const startDate = new Date(startsAt);
  // Compare on the calendar day: a request for the activation day itself is
  // covered from the moment of activation onward, and saying otherwise would
  // make the first day permanently unreportable.
  const startDay = startDate.toISOString().slice(0, 10);
  if (from < startDay) {
    const error = badRequest(
      'LEDGER_STARTS_LATER',
      'الدفتر لا يغطي هذه الفترة. أقدم تاريخ يمكن الإجابة عنه هو ' + startDay + '.',
    );
    error.ledgerStartsAt = startDay;
    throw error;
  }
  return startDay;
}

// ── The valued stock card ───────────────────────────────────────────────────
//
// Every movement of ONE item, with the cost it actually carried, and a running
// quantity and value. Scoped to one item deliberately: a stock card for "all
// items" is not a stock card, it is a movement dump, and its running balance
// would be meaningless.
router.get('/reports/inventory-value/stock-card', READ, async (req, res) => {
  try {
    const itemId = String(req.query.itemId || '').trim();
    if (!itemId) throw badRequest('VALIDATION_ERROR', 'itemId مطلوب');
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    if (from > to) throw badRequest('VALIDATION_ERROR', 'from يجب ألا يتجاوز to');
    const ledgerStartsAt = await assertCoverage(from);

    const warehouseId = String(req.query.warehouseId || '').trim();
    const params = [itemId, from, to];
    let scope = '';
    if (warehouseId) { scope = ' AND l.warehouse_id = ?'; params.push(warehouseId); }

    // The opening position is everything BEFORE the window — computed from the
    // ledger itself, not carried in by the caller, so it cannot disagree with
    // the rows underneath it.
    const openingParams = [itemId, from];
    let openingScope = '';
    if (warehouseId) { openingScope = ' AND l.warehouse_id = ?'; openingParams.push(warehouseId); }
    const [openingRows] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.quantity ELSE -l.quantity END), 0) AS qty,
         COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.extended_value ELSE -l.extended_value END), 0) AS value
       FROM inventory_value_ledger l
      WHERE l.item_id = ?
        AND DATE(l.movement_at) < ?${openingScope}`,
      openingParams,
    );
    const opening = {
      quantity: Number(openingRows[0] ? openingRows[0].qty : 0),
      value: Number(openingRows[0] ? openingRows[0].value : 0),
    };

    const wantsAll = SNAP.wantsSnapshot(req);
    const limit = wantsAll ? SNAP.probeSize() : 500;
    const [rows] = await pool.query(
      `SELECT
         l.id, l.movement_id, l.movement_at, l.accounting_period,
         l.warehouse_id, w.name AS warehouse_name,
         l.direction, l.quantity, l.unit_cost, l.extended_value,
         l.cost_basis, l.source_type, l.source_id, l.reverses_ledger_id, l.actor
       FROM inventory_value_ledger l
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.item_id = ?
        AND DATE(l.movement_at) >= ?
        AND DATE(l.movement_at) <= ?${scope}
      ORDER BY l.movement_seq ASC
      LIMIT ${Number(limit)}`,
      params,
    );

    if (wantsAll && SNAP.overflowed(rows)) return SNAP.tooLarge(res, rows.length);

    // The running balance is computed HERE, over the ordered rows, so it can
    // never disagree with the column beside it.
    let runQty = opening.quantity;
    let runValue = opening.value;
    const lines = rows.map((r) => {
      const signedQty = r.direction === 'in' ? Number(r.quantity) : -Number(r.quantity);
      const signedValue = r.direction === 'in' ? Number(r.extended_value) : -Number(r.extended_value);
      runQty += signedQty;
      runValue += signedValue;
      return {
        id: r.id,
        movementId: r.movement_id,
        movementAt: r.movement_at,
        period: r.accounting_period,
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        direction: r.direction,
        quantity: Number(r.quantity),
        unitCost: Number(r.unit_cost),
        extendedValue: Number(r.extended_value),
        // Per row, because the two bases are NOT equally strong and a reader
        // auditing a number is entitled to know which one produced it.
        costBasis: r.cost_basis,
        sourceType: r.source_type,
        sourceId: r.source_id,
        reversesLedgerId: r.reverses_ledger_id,
        actor: r.actor,
        runningQuantity: Number(runQty.toFixed(4)),
        runningValue: Number(runValue.toFixed(2)),
      };
    });

    return res.json({
      success: true,
      data: lines,
      opening,
      closing: {
        quantity: Number(runQty.toFixed(4)),
        value: Number(runValue.toFixed(2)),
      },
      // Rows whose cost could not be established are counted, not hidden. A
      // stock card whose total silently includes zero-cost rows is a wrong
      // total that looks like a right one.
      unknownCostRows: lines.filter((l) => l.costBasis === IVL.COST_BASIS.UNKNOWN).length,
      ledgerStartsAt,
      meta: SNAP.meta(lines.length, wantsAll),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return RE.sendReportError(res, e, 'erp/reports/inventory-value/stock-card', req);
  }
});

// ── The value roll-forward ──────────────────────────────────────────────────
//
// Opening + in − out = closing, per item. This is the statement an auditor
// asks for: it proves the closing inventory value is the opening value plus
// what demonstrably moved, rather than a fresh recomputation that happens to
// land nearby.
router.get('/reports/inventory-value/roll-forward', READ, async (req, res) => {
  try {
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    if (from > to) throw badRequest('VALIDATION_ERROR', 'from يجب ألا يتجاوز to');
    const ledgerStartsAt = await assertCoverage(from);

    const warehouseId = String(req.query.warehouseId || '').trim();
    const scope = warehouseId ? ' AND l.warehouse_id = ?' : '';

    const openingParams = [from];
    if (warehouseId) openingParams.push(warehouseId);
    const movementParams = [from, to];
    if (warehouseId) movementParams.push(warehouseId);

    const wantsAll = SNAP.wantsSnapshot(req);
    const limit = wantsAll ? SNAP.probeSize() : 500;

    // One query per side, joined in JS: a single query with two conditional
    // aggregates over the whole ledger reads every historical row for every
    // item on every request, and this table only grows.
    const [openingRows] = await pool.query(
      `SELECT l.item_id,
              COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.quantity ELSE -l.quantity END), 0) AS qty,
              COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.extended_value ELSE -l.extended_value END), 0) AS value
         FROM inventory_value_ledger l
        WHERE DATE(l.movement_at) < ?${scope}
        GROUP BY l.item_id`,
      openingParams,
    );
    const [movementRows] = await pool.query(
      `SELECT l.item_id,
              COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.quantity ELSE 0 END), 0) AS in_qty,
              COALESCE(SUM(CASE WHEN l.direction = 'in' THEN l.extended_value ELSE 0 END), 0) AS in_value,
              COALESCE(SUM(CASE WHEN l.direction = 'out' THEN l.quantity ELSE 0 END), 0) AS out_qty,
              COALESCE(SUM(CASE WHEN l.direction = 'out' THEN l.extended_value ELSE 0 END), 0) AS out_value,
              SUM(CASE WHEN l.cost_basis = 'unknown' THEN 1 ELSE 0 END) AS unknown_rows
         FROM inventory_value_ledger l
        WHERE DATE(l.movement_at) >= ? AND DATE(l.movement_at) <= ?${scope}
        GROUP BY l.item_id`,
      movementParams,
    );

    const byItem = new Map();
    const touch = (id) => {
      if (!byItem.has(id)) {
        byItem.set(id, {
          itemId: id, itemName: null,
          openingQuantity: 0, openingValue: 0,
          inQuantity: 0, inValue: 0,
          outQuantity: 0, outValue: 0,
          unknownCostRows: 0,
        });
      }
      return byItem.get(id);
    };
    for (const r of openingRows) {
      const row = touch(r.item_id);
      row.openingQuantity = Number(r.qty);
      row.openingValue = Number(r.value);
    }
    for (const r of movementRows) {
      const row = touch(r.item_id);
      row.inQuantity = Number(r.in_qty);
      row.inValue = Number(r.in_value);
      row.outQuantity = Number(r.out_qty);
      row.outValue = Number(r.out_value);
      row.unknownCostRows = Number(r.unknown_rows);
    }

    // An item with an opening balance and no movement still belongs on a
    // roll-forward — dropping it would make the closing total stop reconciling.
    const items = [...byItem.values()];
    if (wantsAll && items.length > SNAP.REPORT_SNAPSHOT_LIMIT) {
      return SNAP.tooLarge(res, items.length);
    }
    const trimmed = wantsAll ? items : items.slice(0, limit);

    const ids = trimmed.map((r) => r.itemId);
    if (ids.length) {
      const [names] = await pool.query(
        `SELECT id, name FROM inv_items WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      const nameById = new Map(names.map((n) => [n.id, n.name]));
      for (const row of trimmed) row.itemName = nameById.get(row.itemId) || null;
    }

    for (const row of trimmed) {
      row.closingQuantity = Number((row.openingQuantity + row.inQuantity - row.outQuantity).toFixed(4));
      row.closingValue = Number((row.openingValue + row.inValue - row.outValue).toFixed(2));
    }
    trimmed.sort((a, b) => b.closingValue - a.closingValue);

    const totals = trimmed.reduce((acc, r) => ({
      openingValue: acc.openingValue + r.openingValue,
      inValue: acc.inValue + r.inValue,
      outValue: acc.outValue + r.outValue,
      closingValue: acc.closingValue + r.closingValue,
      unknownCostRows: acc.unknownCostRows + r.unknownCostRows,
    }), { openingValue: 0, inValue: 0, outValue: 0, closingValue: 0, unknownCostRows: 0 });
    for (const k of ['openingValue', 'inValue', 'outValue', 'closingValue']) {
      totals[k] = Number(totals[k].toFixed(2));
    }

    return res.json({
      success: true,
      data: trimmed,
      totals,
      ledgerStartsAt,
      meta: SNAP.meta(trimmed.length, wantsAll),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return RE.sendReportError(res, e, 'erp/reports/inventory-value/roll-forward', req);
  }
});

// ── Net realizable value ────────────────────────────────────────────────────
//
// IAS 2 carries inventory at the LOWER of cost and NRV. A raw material has no
// price of its own, so its selling basis is a menu product whose ACTIVE recipe
// consumes it through exactly one BOM line. All arithmetic lives in
// lib/nrv.js; this handler only fetches the rows and refuses what it cannot
// honestly compute.

const NRV = require('../../../lib/nrv');

/**
 * The two settings NRV depends on. The VAT rate is NEVER defaulted: a report
 * that quietly assumed 15% would strip the wrong tax the day the rate changes
 * and still print a confident number. Absent ⇒ 422 VAT_RATE_MISSING.
 */
async function readNrvSettings() {
  const [rows] = await pool.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('VATRate', 'NrvSellingCostPct')",
  );
  const byKey = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  const vatRatePct = NRV.parseVatRate(byKey.get('VATRate'));
  if (vatRatePct == null) {
    throw badRequest('VAT_RATE_MISSING', 'إعداد نسبة ضريبة القيمة المضافة (VATRate) غير موجود؛ لا يمكن تجريد الضريبة من سعر البيع.');
  }
  const sellingCostPct = NRV.parseSellingCostPct(byKey.get('NrvSellingCostPct'));
  if (sellingCostPct == null) {
    throw badRequest('NRV_SELLING_COST_INVALID', 'إعداد نسبة تكاليف البيع (NrvSellingCostPct) غير صالح؛ يجب أن يكون رقمًا بين 0 و100.');
  }
  return { vatRatePct, sellingCostPct };
}

/** An unknown warehouse must be refused: an empty report for it would read as an empty warehouse. */
async function requireWarehouse(raw) {
  const warehouseId = String(raw || '').trim();
  if (!warehouseId) return '';
  const [rows] = await pool.query('SELECT id FROM warehouses WHERE id = ? LIMIT 1', [warehouseId]);
  if (!rows.length) throw badRequest('WAREHOUSE_NOT_FOUND', 'المستودع غير موجود: ' + warehouseId);
  return warehouseId;
}

router.get('/reports/inventory-value/nrv', READ, async (req, res) => {
  try {
    const settings = await readNrvSettings();
    const warehouseId = await requireWarehouse(req.query.warehouseId);

    // Items with stock on hand. With a warehouse, quantity and cost are that
    // warehouse's (uq_wh_item makes the MAX a plain read of the single row);
    // without one, quantity is the sum over warehouses and cost is the item's
    // own weighted average — one basis per request, named below.
    const stockScope = warehouseId ? ' AND ws.warehouse_id = ?' : '';
    const [itemRows] = await pool.query(
      `SELECT i.id, i.name, i.name_en, i.unit, i.cost AS item_cost,
              SUM(ws.qty) AS quantity,
              MAX(ws.avg_cost) AS warehouse_avg_cost
         FROM inv_items i
         JOIN warehouse_stock ws ON ws.item_id = i.id${stockScope}
        WHERE COALESCE(i.active, 1) = 1
          AND i.deleted_at IS NULL
          AND COALESCE(i.is_inventoried, 1) = 1
        GROUP BY i.id, i.name, i.name_en, i.unit, i.cost
       HAVING SUM(ws.qty) > 0`,
      warehouseId ? [warehouseId] : [],
    );

    // Every (item, product) pair whose ACTIVE recipe consumes the item through
    // exactly ONE line. product_source is checked because a NULL there means
    // 'inv' everywhere else in this codebase (routes/erp-core.js) — a
    // semi-finished item's BOM is not a selling basis. HAVING COUNT(*) = 1 is
    // the "exactly one line" rule: a recipe listing the same item twice
    // cannot say how much of it one sale consumes.
    const [candidateRows] = await pool.query(
      `SELECT bl.component_item_id AS item_id,
              m.id AS menu_id, m.name AS product_name, m.name_en AS product_name_en,
              m.price, m.is_tax_inclusive, m.tax_category,
              b.yield_quantity,
              MIN(bl.quantity) AS line_quantity,
              MIN(bl.base_quantity) AS base_quantity
         FROM bom b
         JOIN menu m ON m.id = b.product_id
         JOIN bom_lines bl ON bl.bom_id = b.id
        WHERE b.product_source = 'menu'
          AND (b.is_active = 1 OR b.status = 'active')
          AND COALESCE(m.active, 1) = 1
          AND m.is_deleted = 0
          AND COALESCE(m.is_combo, 0) = 0
        GROUP BY b.id, bl.component_item_id, m.id, m.name, m.name_en,
                 m.price, m.is_tax_inclusive, m.tax_category, b.yield_quantity
       HAVING COUNT(*) = 1`,
    );

    const stocked = new Set(itemRows.map((r) => r.id));
    const { rows, totals } = NRV.buildNrvRows({
      vatRatePct: settings.vatRatePct,
      sellingCostPct: settings.sellingCostPct,
      items: itemRows.map((r) => ({
        itemId: r.id,
        itemName: r.name,
        itemNameEn: r.name_en,
        unit: r.unit,
        quantity: r.quantity,
        unitCost: warehouseId ? r.warehouse_avg_cost : r.item_cost,
      })),
      candidates: candidateRows
        .filter((c) => stocked.has(c.item_id))
        .map((c) => ({
          itemId: c.item_id,
          menuId: c.menu_id,
          productName: c.product_name,
          productNameEn: c.product_name_en,
          price: c.price,
          isTaxInclusive: c.is_tax_inclusive,
          taxCategory: c.tax_category,
          quantity: c.line_quantity,
          baseQuantity: c.base_quantity,
          yieldQuantity: c.yield_quantity,
        })),
    });

    // The item universe is bounded (stocked items), so the whole set is always
    // computed; a snapshot only adds the overflow refusal.
    const wantsAll = SNAP.wantsSnapshot(req.query);
    if (wantsAll && rows.length > SNAP.REPORT_SNAPSHOT_LIMIT) return SNAP.tooLarge(res, rows.length);

    return res.json({
      success: true,
      data: rows,
      totals,
      basis: {
        vatRatePct: settings.vatRatePct,
        sellingCostPct: settings.sellingCostPct,
        costSource: warehouseId ? 'warehouse-wac' : 'item-wac',
        warehouseId: warehouseId || null,
        asOf: new Date().toISOString(),
      },
      meta: SNAP.meta(rows.length),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return RE.sendReportError(res, e, 'erp/reports/inventory-value/nrv', req);
  }
});

// ── Products sold below cost ────────────────────────────────────────────────
//
// The mirror question: not "is the material worth less than we paid" but "is
// the product priced under what it costs to make". Cost precedence and the
// no-cost rule live in lib/nrv.js; the sales window comes from the analytics
// daily item fact and is NAMED in `basis.salesSource` — or null, with null
// quantities, on a server that has no such table.

const SALES_SOURCE_TABLE = 'analytics_daily_item';
const SALES_SOURCE_COLUMNS = ['business_day', 'menu_id', 'qty_sold', 'qty_returned'];

/** True only when the analytics fact exists with every column the query reads. */
async function salesSourceAvailable() {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND COLUMN_NAME IN (${SALES_SOURCE_COLUMNS.map(() => '?').join(',')})`,
    [SALES_SOURCE_TABLE, ...SALES_SOURCE_COLUMNS],
  );
  return cols.length === SALES_SOURCE_COLUMNS.length;
}

router.get('/reports/inventory-value/products-below-cost', READ, async (req, res) => {
  try {
    const settings = await readNrvSettings();
    const rawDays = req.query.days == null || String(req.query.days).trim() === '' ? '30' : String(req.query.days).trim();
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw badRequest('VALIDATION_ERROR', 'days يجب أن يكون عددًا صحيحًا بين 1 و366');
    }

    // One active BOM per product. Should a product carry several, the HIGHEST
    // cost is the prudent one to measure against.
    const [productRows] = await pool.query(
      `SELECT m.id AS menu_id, m.name, m.name_en, m.price, m.is_tax_inclusive, m.tax_category,
              m.cost AS menu_cost, m.cost_source AS menu_cost_source,
              ab.cost_per_unit AS bom_cost_per_unit
         FROM menu m
         LEFT JOIN (
                SELECT product_id, MAX(cost_per_unit) AS cost_per_unit
                  FROM bom
                 WHERE product_source = 'menu' AND (is_active = 1 OR status = 'active')
                 GROUP BY product_id
              ) ab ON ab.product_id = m.id
        WHERE COALESCE(m.active, 1) = 1
          AND m.is_deleted = 0
          AND COALESCE(m.is_combo, 0) = 0`,
    );

    // Units sold = the hub's `qty_net` (sold − returned): a returned unit was
    // not realised, so it carries no exposure. The window is `days` calendar
    // days ending on the DB session's today (Riyadh), the same clock that
    // stamps business_day.
    let sold = null;
    let salesFrom = null;
    if (await salesSourceAvailable()) {
      const [[win]] = await pool.query(
        "SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL ? DAY), '%Y-%m-%d') AS from_day",
        [days - 1],
      );
      salesFrom = win.from_day;
      const [soldRows] = await pool.query(
        `SELECT menu_id, SUM(qty_sold) - SUM(qty_returned) AS qty_net
           FROM ${SALES_SOURCE_TABLE}
          WHERE business_day >= ?
          GROUP BY menu_id`,
        [salesFrom],
      );
      sold = new Map(soldRows.map((r) => [r.menu_id, Number(r.qty_net)]));
    }

    const { rows, totals } = NRV.buildBelowCostRows({
      vatRatePct: settings.vatRatePct,
      sold,
      products: productRows.map((p) => ({
        menuId: p.menu_id,
        productName: p.name,
        productNameEn: p.name_en,
        price: p.price,
        isTaxInclusive: p.is_tax_inclusive,
        taxCategory: p.tax_category,
        menuCost: p.menu_cost,
        menuCostSource: p.menu_cost_source,
        bomCostPerUnit: p.bom_cost_per_unit,
      })),
    });

    const wantsAll = SNAP.wantsSnapshot(req.query);
    if (wantsAll && rows.length > SNAP.REPORT_SNAPSHOT_LIMIT) return SNAP.tooLarge(res, rows.length);

    return res.json({
      success: true,
      data: rows,
      totals,
      basis: {
        vatRatePct: settings.vatRatePct,
        days,
        salesSource: sold ? SALES_SOURCE_TABLE : null,
        salesMeasure: sold ? 'qty_sold - qty_returned' : null,
        salesFrom,
        asOf: new Date().toISOString(),
      },
      meta: SNAP.meta(rows.length),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return RE.sendReportError(res, e, 'erp/reports/inventory-value/products-below-cost', req);
  }
});

module.exports = router;
