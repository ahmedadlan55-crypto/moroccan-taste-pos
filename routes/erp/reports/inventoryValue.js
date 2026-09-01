/**
 * Reports built on the immutable valued movement ledger.
 *
 *   GET /reports/inventory-value/stock-card    — one item's valued movements
 *   GET /reports/inventory-value/roll-forward  — opening + in − out = closing
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

module.exports = router;
