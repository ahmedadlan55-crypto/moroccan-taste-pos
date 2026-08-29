/**
 * Unified warehouse control + purchasing intelligence (read only).
 *
 * Mount under /api/inventory/intelligence AFTER auth and warehouseScope.
 * Financial truth rules:
 *  - inventory value = positive on-hand x warehouse WAC, with item-cost fallback
 *    separately disclosed in costCoverage;
 *  - purchases = POSTED goods-receipt lines, not PO commitments or AP invoices;
 *  - open PO commitments are shown separately;
 *  - COGS / turnover are deliberately not inferred from inventory movements.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const { hasCapability } = require('../middleware/requireCapability');
const { sendCsv, CSV_ROW_CAP } = require('../lib/procurement/http');
const WI = require('../lib/warehouseIntelligence');
const STRICT_SCOPE = require('../lib/warehouseIntelligenceScope');
const IAR = require('../lib/inventoryAccountingReport');
const { getAccountByRole, AccountRoleError } = require('../lib/accountRoles');
const MOVEMENT = require('../lib/inventoryMovementSemantics');
const PERF = require('../lib/inventoryPerformance');

// The Reports Center is visible to the finance-report roles, while the
// procurement module has its own purchasing-report grant.  Requiring only one
// of the two made the UI/server contract contradictory (accountant/auditor saw
// the route but received 403).  Accept either server-side grant and keep the
// decision fail-closed; cashier/inventory-only users still cannot read spend.
async function READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const allowed = await hasCapability(req.user, 'finance.reports.view') ||
      await hasCapability(req.user, 'procurement.reports');
    if (!allowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير المستودعات والمشتريات' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقارير المستودعات والمشتريات' });
  }
}

async function FINANCE_READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'Authentication required' });
    }
    if (!await hasCapability(req.user, 'finance.reports.view')) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'Finance report permission required' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'Finance report permission required' });
  }
}

function now() { return new Date().toISOString(); }

function scopeMeta(req, filters) {
  const scope = STRICT_SCOPE.publicScope(req.warehouseScope);
  return {
    allWarehousesAccess: !!scope.all,
    warehouseIds: scope.all ? [] : (scope.warehouseIds || []).map(String),
    requestedWarehouseId: filters.warehouseId || null,
  };
}

function warning(code, message, level) { return { code, message, level: level || 'info' }; }

async function capabilities() {
  const placeholders = WI.SCHEMA_TABLES.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    WI.SCHEMA_TABLES);
  return WI.schemaMap(rows);
}

function handleError(res, error) {
  const status = Number(error && error.status) || 500;
  const code = (error && error.code) || 'WAREHOUSE_INTELLIGENCE_FAILED';
  console.error('[warehouse-intelligence]', code, error && error.message);
  return res.status(status).json({
    success: false,
    code,
    error: status === 503
      ? 'بنية بيانات تقارير المستودعات غير جاهزة بالكامل. أوقف التقرير بدل عرض أرقام ناقصة.'
      : status === 400
        ? String(error.message || 'مرشحات التقرير غير صالحة.')
        : 'تعذر تحميل تقارير المستودعات. لم يتم عرض أرقام بديلة أو تقديرية.',
  });
}

function guardRequestedWarehouse(req, res, filters) {
  if (!filters.warehouseId || STRICT_SCOPE.canReadWarehouse(req.warehouseScope, filters.warehouseId)) return true;
  res.status(403).json({
    success: false,
    code: 'WAREHOUSE_ACCESS_DENIED',
    error: 'لا تملك صلاحية الوصول إلى هذا المستودع.',
  });
  return false;
}

function guardCurrentValuationOnly(req, res, filters) {
  if (!filters.from && !filters.to && !req.query.asOf && !req.query.asOfDate) return true;
  res.status(422).json({
    success: false,
    code: 'HISTORICAL_VALUE_LEDGER_REQUIRED',
    error: 'Historical inventory valuation is unavailable until an immutable valued-movement ledger exists. This report is current-state only.',
  });
  return false;
}

async function resolveLedgerRole(roleKey) {
  // The current ledger is intentionally single-company (CO-MAIN).  Resolve
  // the governed symbolic role every request so a reassignment/revocation is
  // effective immediately; accountRoles deliberately has no stale cache and
  // no silent fallback.
  try {
    return await getAccountByRole(db, roleKey, { companyId: 'CO-MAIN' });
  } catch (error) {
    if (!(error instanceof AccountRoleError) && error.name !== 'AccountRoleError') throw error;
    const readiness = new Error(`Governed ledger role ${roleKey} is not ready: ${error.code || 'ACCOUNT_ROLE_ERROR'}`);
    readiness.code = 'ACCOUNT_ROLE_READINESS_MISSING';
    readiness.status = 503;
    readiness.details = { roleKey, cause: error.code || 'ACCOUNT_ROLE_ERROR' };
    throw readiness;
  }
}

function purchaseWhere(req, filters, model) {
  const where = ["pr.status = 'posted'"];
  const params = [];
  WI.appendDateRange(where, params, 'pr.receipt_date', filters.from, filters.to);
  if (filters.warehouseId) { where.push(model.warehouse + ' = ?'); params.push(filters.warehouseId); }
  if (filters.supplierId) { where.push('pr.supplier_id = ?'); params.push(filters.supplierId); }
  if (filters.itemId) { where.push('prl.item_id = ?'); params.push(filters.itemId); }
  if (filters.q) {
    const needle = '%' + filters.q + '%';
    where.push(`(${model.receiptNumber} LIKE ? OR ${model.poNumber} LIKE ? OR ${model.supplierName} LIKE ? OR ${model.itemName} LIKE ? OR prl.item_id LIKE ?)`);
    params.push(needle, needle, needle, needle, needle);
  }
  STRICT_SCOPE.append(req.warehouseScope, model.warehouse, where, params);
  return { where, params };
}

function purchaseFrom(schema) {
  return `FROM purchase_receipt_lines prl
    JOIN purchase_receipts pr ON pr.id = prl.receipt_id
    LEFT JOIN purchase_orders po ON po.id = pr.po_id
    LEFT JOIN suppliers s ON s.id = pr.supplier_id
    LEFT JOIN inv_items i ON i.id = prl.item_id
    LEFT JOIN warehouses w ON w.id = ${WI.purchaseModel(schema).warehouse}`;
}

function purchaseSelect(model) {
  return `prl.id AS line_id, pr.id AS receipt_id, ${model.receiptNumber} AS receipt_number,
    pr.receipt_date, pr.status, pr.po_id, ${model.poNumber} AS po_number,
    pr.supplier_id, ${model.supplierName} AS supplier_name,
    ${model.warehouse} AS warehouse_id, COALESCE(w.name, ${model.warehouse}) AS warehouse_name,
    prl.item_id, ${model.itemName} AS item_name, ${model.sku} AS sku,
    ${model.enteredQty} AS entered_qty, ${model.enteredUnit} AS entered_unit, ${model.baseUnit} AS base_unit,
    ${model.qty} AS base_qty, ${model.unitCost} AS base_unit_cost,
    ${model.netAmount} AS net_amount, ${model.vatAmount} AS vat_amount, ${model.grossAmount} AS gross_amount`;
}

function mapPurchaseRow(row) {
  return {
    id: String(row.line_id), lineId: String(row.line_id), purchaseId: String(row.receipt_id), receiptId: String(row.receipt_id), receiptNumber: String(row.receipt_number || row.receipt_id),
    documentNumber: row.po_number == null ? String(row.receipt_number || row.receipt_id) : String(row.po_number), date: row.receipt_date,
    receiptDate: row.receipt_date, poId: row.po_id == null ? null : String(row.po_id),
    poNumber: row.po_number == null ? null : String(row.po_number), supplierId: row.supplier_id == null ? null : String(row.supplier_id),
    supplierName: String(row.supplier_name || ''), warehouseId: String(row.warehouse_id || ''), warehouseName: String(row.warehouse_name || ''),
    itemId: String(row.item_id), itemName: String(row.item_name || row.item_id), sku: String(row.sku || ''), enteredQty: WI.round(row.entered_qty, 4),
    enteredUnit: String(row.entered_unit || ''), qty: WI.round(row.base_qty, 4), unit: String(row.base_unit || row.entered_unit || ''),
    baseQty: WI.round(row.base_qty, 4), unitCost: WI.round(row.base_unit_cost, 4), baseUnitCost: WI.round(row.base_unit_cost, 4),
    netAmount: WI.round(row.net_amount), vatAmount: row.vat_amount == null ? null : WI.round(row.vat_amount),
    grossAmount: row.gross_amount == null ? null : WI.round(row.gross_amount), status: String(row.status || ''),
  };
}

function purchaseCsvColumns(lang) {
  const en = lang === 'en';
  return [
    { key: 'date', label: en ? 'Receipt date' : 'تاريخ الاستلام' },
    { key: 'receiptNumber', label: en ? 'Goods receipt' : 'سند الاستلام' },
    { key: 'documentNumber', label: en ? 'Purchase order' : 'أمر الشراء' },
    { key: 'supplierName', label: en ? 'Supplier' : 'المورد' },
    { key: 'warehouseName', label: en ? 'Warehouse' : 'المستودع' },
    { key: 'itemId', label: en ? 'Item ID' : 'معرّف الصنف' },
    { key: 'sku', label: 'SKU' },
    { key: 'itemName', label: en ? 'Item' : 'الصنف' },
    { key: 'qty', label: en ? 'Base quantity' : 'الكمية الأساسية' },
    { key: 'unit', label: en ? 'Base unit' : 'الوحدة الأساسية' },
    { key: 'unitCost', label: en ? 'Base unit cost' : 'تكلفة الوحدة الأساسية' },
    { key: 'netAmount', label: en ? 'Net received value' : 'صافي قيمة الاستلام' },
    { key: 'vatAmount', label: en ? 'VAT (blank if not captured)' : 'الضريبة (فارغة إن لم تُسجّل)' },
    { key: 'grossAmount', label: en ? 'Gross (blank if VAT not captured)' : 'الإجمالي (فارغ إن لم تُسجّل الضريبة)' },
    { key: 'status', label: en ? 'Status' : 'الحالة' },
  ];
}

router.get('/overview', READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters)) return;
    const schema = await capabilities();
    WI.requireColumns(schema, {
      warehouse_stock: ['warehouse_id', 'item_id', 'qty', 'avg_cost'],
      inv_items: ['id', 'cost', 'min_stock'],
      warehouses: ['id'],
    });
    const purchase = WI.purchaseModel(schema);
    const openPo = WI.openPoModel(schema);
    const warnings = [
      warning('PURCHASES_ARE_GRN_COST', 'قيمة المشتريات هنا هي تكلفة الاستلامات المُرحّلة، وليست التزام فاتورة المورد أو المبلغ المسدد.'),
    ];
    if (openPo.valueBasis !== 'line_total_pro_rata_including_discount_and_vat') {
      warnings.push(warning(
        'OPEN_PO_VALUE_LEGACY_FALLBACK',
        'بنية أوامر الشراء القديمة لا تحمل إجمالي السطر؛ قيمة الالتزام المفتوح محسوبة من سعر الوحدة ولا تثبت الخصم أو الضريبة.',
        'warning'));
    }

    const invWhere = [];
    const invParams = [];
    if (WI.hasColumn(schema, 'inv_items', 'active')) invWhere.push('i.active = 1');
    if (WI.hasColumn(schema, 'inv_items', 'deleted_at')) invWhere.push('i.deleted_at IS NULL');
    if (filters.warehouseId) { invWhere.push('ws.warehouse_id = ?'); invParams.push(filters.warehouseId); }
    STRICT_SCOPE.append(req.warehouseScope, 'ws.warehouse_id', invWhere, invParams);
    const rulesAvailable = ['warehouse_id', 'item_id', 'reorder_point', 'min_qty'].every((c) => WI.hasColumn(schema, 'warehouse_item_rules', c));
    const threshold = rulesAvailable
      ? 'COALESCE(NULLIF(wir.reorder_point,0), NULLIF(wir.min_qty,0), NULLIF(i.min_stock,0), 0)'
      : 'COALESCE(NULLIF(i.min_stock,0), 0)';
    const ruleJoin = rulesAvailable
      ? 'LEFT JOIN warehouse_item_rules wir ON wir.warehouse_id=ws.warehouse_id AND wir.item_id=ws.item_id'
      : '';
    const inventorySql = `SELECT
        COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS stock_qty,
        COUNT(DISTINCT CASE WHEN ws.qty > 0 THEN ws.item_id END) AS stock_items,
        COUNT(CASE WHEN ws.qty > 0 THEN 1 END) AS stock_positions,
        COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * COALESCE(NULLIF(ws.avg_cost,0), NULLIF(i.cost,0), 0) ELSE 0 END),0) AS inventory_value,
        COUNT(CASE WHEN ws.qty > 0 AND NULLIF(ws.avg_cost,0) IS NOT NULL THEN 1 END) AS wac_positions,
        COUNT(CASE WHEN ws.qty > 0 AND NULLIF(ws.avg_cost,0) IS NULL AND NULLIF(i.cost,0) IS NOT NULL THEN 1 END) AS fallback_positions,
        COUNT(CASE WHEN ws.qty > 0 AND NULLIF(ws.avg_cost,0) IS NULL AND NULLIF(i.cost,0) IS NULL THEN 1 END) AS missing_cost_positions,
        COALESCE(SUM(CASE WHEN ws.qty > 0 AND NULLIF(ws.avg_cost,0) IS NULL THEN ws.qty * COALESCE(i.cost,0) ELSE 0 END),0) AS fallback_value,
        COUNT(CASE WHEN ws.qty < 0 THEN 1 END) AS negative_positions,
        COALESCE(SUM(CASE WHEN ws.qty < 0 THEN ABS(ws.qty) ELSE 0 END),0) AS negative_qty,
        COUNT(CASE WHEN ws.qty = 0 THEN 1 END) AS out_positions,
        COUNT(CASE WHEN ws.qty > 0 AND ${threshold} > 0 AND ws.qty <= ${threshold} THEN 1 END) AS low_positions
      FROM warehouse_stock ws
      JOIN inv_items i ON i.id=ws.item_id
      JOIN warehouses w ON w.id=ws.warehouse_id
      ${ruleJoin}
      ${invWhere.length ? 'WHERE ' + invWhere.join(' AND ') : ''}`;

    const pw = purchaseWhere(req, filters, purchase);
    const pFrom = purchaseFrom(schema);
    const purchaseSql = `SELECT COUNT(*) AS line_count, COUNT(DISTINCT pr.id) AS receipt_count,
        COUNT(DISTINCT pr.supplier_id) AS supplier_count,
        COALESCE(SUM(${purchase.qty}),0) AS received_qty,
        COALESCE(SUM(${purchase.netAmount}),0) AS purchase_spend
      ${pFrom} WHERE ${pw.where.join(' AND ')}`;

    const poWhere = ["po.status IN ('approved','sent','partially_received')", openPo.remaining + ' > 0'];
    const poParams = [];
    if (filters.warehouseId) { poWhere.push('po.warehouse_id = ?'); poParams.push(filters.warehouseId); }
    STRICT_SCOPE.append(req.warehouseScope, 'po.warehouse_id', poWhere, poParams);
    const poSql = `SELECT COUNT(DISTINCT po.id) AS open_po_count,
        COUNT(*) AS open_line_count,
        COALESCE(SUM(${openPo.remaining}),0) AS open_qty,
        COALESCE(SUM(${openPo.remainingValue}),0) AS open_value
      FROM po_lines pl JOIN purchase_orders po ON po.id=pl.po_id
      WHERE ${poWhere.join(' AND ')}`;

    const wasteAvailable = ['id', 'warehouse_id', 'waste_date', 'total_cost'].every((c) => WI.hasColumn(schema, 'waste_entries', c));
    let wasteHeaderPromise = Promise.resolve([[{ waste_value: null, waste_docs: null }]]);
    let wasteQtyPromise = Promise.resolve([[{ waste_qty: null }]]);
    if (wasteAvailable) {
      const ww = [];
      const wp = [];
      WI.appendDateRange(ww, wp, 'we.waste_date', filters.from, filters.to);
      if (filters.warehouseId) { ww.push('we.warehouse_id=?'); wp.push(filters.warehouseId); }
      STRICT_SCOPE.append(req.warehouseScope, 'we.warehouse_id', ww, wp);
      wasteHeaderPromise = db.query(`SELECT COUNT(*) AS waste_docs, COALESCE(SUM(we.total_cost),0) AS waste_value FROM waste_entries we${ww.length ? ' WHERE ' + ww.join(' AND ') : ''}`, wp);
      const wasteLinesAvailable = ['waste_id', 'quantity'].every((c) => WI.hasColumn(schema, 'waste_entry_items', c));
      if (wasteLinesAvailable) {
        wasteQtyPromise = db.query(`SELECT COALESCE(SUM(wei.quantity),0) AS waste_qty FROM waste_entry_items wei JOIN waste_entries we ON we.id=wei.waste_id${ww.length ? ' WHERE ' + ww.join(' AND ') : ''}`, wp);
      } else warnings.push(warning('WASTE_QUANTITY_UNAVAILABLE', 'جدول سطور الهدر غير متوفر؛ قيمة الهدر متاحة لكن الكمية غير متاحة.', 'warning'));
    } else warnings.push(warning('WASTE_DATA_UNAVAILABLE', 'سجل الهدر غير متوفر في هذه البنية؛ لم تُعرض قيمة صفر مضللة.', 'warning'));

    // Sales/cost bridge is intentionally sourced from frozen sale-time line
    // snapshots. Current recipes/current item cost are NEVER read here. Cost is
    // also capability-gated independently from procurement report access.
    let salesCostBridgePromise = Promise.resolve([[null]]);
    let salesCostBridgeState = 'unavailable';
    const canSeeCost = await hasCapability(req.user, 'analytics.cost.view');
    const bridgeSchemaOk = WI.hasTable(schema, 'analytics_order_facts') && WI.hasTable(schema, 'ar_document_lines') &&
      ['document_id', 'business_day', 'warehouse_id', 'status', 'source'].every((c) => WI.hasColumn(schema, 'analytics_order_facts', c)) &&
      ['document_id', 'net_amount', 'cost_snapshot'].every((c) => WI.hasColumn(schema, 'ar_document_lines', c));
    if (!canSeeCost) {
      salesCostBridgeState = 'permission_denied';
      warnings.push(warning('SALES_COST_PERMISSION_REQUIRED', 'تكلفة المبيعات والربح الإجمالي محجوبان لأن المستخدم لا يملك صلاحية عرض التكلفة.', 'info'));
    } else if (!bridgeSchemaOk) {
      warnings.push(warning('SALES_COST_SNAPSHOTS_UNAVAILABLE', 'لقطات تكلفة المبيعات التاريخية غير مكتملة في هذه البنية؛ لم تُستخدم تكلفة الوصفة الحالية كبديل.', 'warning'));
    } else {
      const sw = ["(f.status IS NULL OR f.status <> 'voided')", "(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))"];
      const sp = [];
      WI.appendDateRange(sw, sp, 'f.business_day', filters.from, filters.to);
      if (filters.warehouseId) { sw.push('f.warehouse_id=?'); sp.push(filters.warehouseId); }
      STRICT_SCOPE.append(req.warehouseScope, 'f.warehouse_id', sw, sp);
      salesCostBridgePromise = db.query(
        `SELECT COALESCE(SUM(d.net_amount),0) AS net_sales,
                COALESCE(SUM(d.cost_snapshot),0) AS cogs,
                COUNT(*) AS line_count,
                SUM(CASE WHEN d.cost_snapshot IS NOT NULL AND d.cost_snapshot <> 0 THEN 1 ELSE 0 END) AS costed_lines,
                SUM(CASE WHEN d.cost_snapshot IS NULL OR d.cost_snapshot = 0 THEN 1 ELSE 0 END) AS uncosted_lines,
                COALESCE(SUM(CASE WHEN d.cost_snapshot IS NULL OR d.cost_snapshot = 0 THEN d.net_amount ELSE 0 END),0) AS uncosted_net
           FROM ar_document_lines d
           JOIN analytics_order_facts f ON f.document_id=d.document_id
          WHERE ${sw.join(' AND ')}`, sp);
      salesCostBridgeState = 'available';
    }

    let returnsBridgePromise = Promise.resolve([[null]]);
    let returnsBridgeAvailable = false;
    const returnsSchemaOk = ['id', 'status', 'return_date', 'warehouse_id'].every((c) => WI.hasColumn(schema, 'sales_returns', c)) &&
      ['return_id', 'net_amount', 'cogs_reversed_amount'].every((c) => WI.hasColumn(schema, 'sales_return_lines', c));
    if (salesCostBridgeState === 'available' && returnsSchemaOk) {
      const returnWh = WI.hasColumn(schema, 'sales_return_lines', 'warehouse_id') ? 'COALESCE(rl.warehouse_id,sr.warehouse_id)' : 'sr.warehouse_id';
      const rw = ["sr.status='posted'"];
      const rp = [];
      WI.appendDateRange(rw, rp, 'sr.return_date', filters.from, filters.to);
      if (filters.warehouseId) { rw.push(returnWh + '=?'); rp.push(filters.warehouseId); }
      STRICT_SCOPE.append(req.warehouseScope, returnWh, rw, rp);
      returnsBridgePromise = db.query(
        `SELECT COALESCE(SUM(rl.net_amount),0) AS returns_net,
                COALESCE(SUM(rl.cogs_reversed_amount),0) AS reversed_cogs,
                COUNT(*) AS return_lines,
                SUM(CASE WHEN rl.cogs_reversed_amount IS NULL THEN 1 ELSE 0 END) AS unproven_cost_lines
           FROM sales_return_lines rl JOIN sales_returns sr ON sr.id=rl.return_id
          WHERE ${rw.join(' AND ')}`, rp);
      returnsBridgeAvailable = true;
    } else if (salesCostBridgeState === 'available') {
      warnings.push(warning('RETURN_COST_BRIDGE_UNAVAILABLE', 'صافي المبيعات قبل المرتجعات متاح، لكن ربط عكس تكلفة المرتجعات غير متوفر؛ لم تُستخدم لقطة تكلفة المرتجع بدل المبلغ المعكوس فعليًا.', 'warning'));
    }

    // Supplier concentration + purchase trend use exactly the same posted-GRN
    // population and filters as the headline spend, so every number reconciles.
    const supplierSql = `SELECT pr.supplier_id, ${purchase.supplierName} AS supplier_name,
        COUNT(DISTINCT pr.id) AS document_count,
        COALESCE(SUM(${purchase.qty}),0) AS received_qty,
        COALESCE(SUM(${purchase.netAmount}),0) AS spend
      ${pFrom} WHERE ${pw.where.join(' AND ')}
      GROUP BY pr.supplier_id, ${purchase.supplierName} ORDER BY spend DESC LIMIT 8`;
    const trendSpanDays = filters.from && filters.to
      ? Math.max(0, Math.round((Date.parse(filters.to) - Date.parse(filters.from)) / 86400000))
      : 30;
    const trendBucket = trendSpanDays > 92 ? "DATE_FORMAT(pr.receipt_date,'%Y-%m-01')" : 'DATE(pr.receipt_date)';
    const trendSql = `SELECT ${trendBucket} AS period,
        COALESCE(SUM(${purchase.qty}),0) AS received_qty,
        COALESCE(SUM(${purchase.netAmount}),0) AS spend
      ${pFrom} WHERE ${pw.where.join(' AND ')}
      GROUP BY period ORDER BY period`;

    let stockFlowPromise = Promise.resolve([[]]);
    const stockFlowAvailable = ['movement_date', 'warehouse_id', 'type', 'qty', 'reference_type'].every((c) => WI.hasColumn(schema, 'inventory_movements', c));
    if (stockFlowAvailable) {
      const fw = [];
      const fp = [];
      WI.appendDateRange(fw, fp, 'm.movement_date', filters.from, filters.to);
      if (filters.warehouseId) { fw.push('m.warehouse_id=?'); fp.push(filters.warehouseId); }
      STRICT_SCOPE.append(req.warehouseScope, 'm.warehouse_id', fw, fp);
      stockFlowPromise = db.query(
        `SELECT COALESCE(NULLIF(m.reference_type,''),'unclassified') AS reference_type, m.type,
                COALESCE(SUM(m.qty),0) AS qty
           FROM inventory_movements m ${fw.length ? 'WHERE ' + fw.join(' AND ') : ''}
          GROUP BY COALESCE(NULLIF(m.reference_type,''),'unclassified'), m.type
          ORDER BY reference_type, m.type`, fp);
      warnings.push(warning('STOCK_FLOW_VALUE_UNAVAILABLE', 'تدفق المخزون يعرض الكمية فقط؛ سجل الحركة لا يحمل لقطة قيمة مالية موثوقة، لذلك قيمة الحركة غير معروضة بدل احتسابها بتكلفة حالية.', 'info'));
    } else warnings.push(warning('STOCK_FLOW_UNAVAILABLE', 'سجل حركة المخزون لا يحتوي الحقول اللازمة لتحليل التدفق.', 'warning'));

    const [inventoryResult, purchaseResult, poResult, wasteHeaderResult, wasteQtyResult, salesBridgeResult, returnsBridgeResult, supplierResult, trendResult, stockFlowResult] = await Promise.all([
      db.query(inventorySql, invParams), db.query(purchaseSql, pw.params), db.query(poSql, poParams), wasteHeaderPromise, wasteQtyPromise,
      salesCostBridgePromise, returnsBridgePromise, db.query(supplierSql, pw.params), db.query(trendSql, pw.params), stockFlowPromise,
    ]);
    const inv = inventoryResult[0][0] || {};
    const pur = purchaseResult[0][0] || {};
    const po = poResult[0][0] || {};
    const waste = wasteHeaderResult[0][0] || {};
    const wasteQty = wasteQtyResult[0][0] || {};
    const sales = salesBridgeResult && salesBridgeResult[0] && salesBridgeResult[0][0] ? salesBridgeResult[0][0] : null;
    const returns = returnsBridgeResult && returnsBridgeResult[0] && returnsBridgeResult[0][0] ? returnsBridgeResult[0][0] : null;
    const fallbackPositions = Number(inv.fallback_positions) || 0;
    const missingCostPositions = Number(inv.missing_cost_positions) || 0;
    if (fallbackPositions) warnings.push(warning('ITEM_COST_FALLBACK', `${fallbackPositions} رصيدًا لا يملك متوسط تكلفة مستودع واستخدم تكلفة بطاقة الصنف.`, 'warning'));
    if (missingCostPositions) warnings.push(warning('MISSING_COST', `${missingCostPositions} رصيدًا موجبًا بلا تكلفة مستودع أو تكلفة بطاقة؛ قيمته غير مغطاة.`, 'error'));
    const salesNetBeforeReturns = sales ? WI.round(sales.net_sales) : null;
    const salesCogsBeforeReturns = sales ? WI.round(sales.cogs) : null;
    const returnsNet = returnsBridgeAvailable && returns ? WI.round(returns.returns_net) : null;
    const reversedCogs = returnsBridgeAvailable && returns ? WI.round(returns.reversed_cogs) : null;
    const unprovenReturnCostLines = returnsBridgeAvailable && returns ? Number(returns.unproven_cost_lines) || 0 : null;
    const salesNet = sales ? WI.round(salesNetBeforeReturns - (returnsNet || 0)) : null;
    // One NULL reversal means the historical COGS-after-returns is not proven.
    const salesCogs = sales && (!returnsBridgeAvailable || unprovenReturnCostLines === 0)
      ? WI.round(salesCogsBeforeReturns - (reversedCogs || 0)) : null;
    const grossProfit = salesCogs == null ? null : WI.round(salesNet - salesCogs);
    const marginPct = salesCogs != null && salesNet !== 0 ? WI.round(((salesNet - salesCogs) / salesNet) * 100) : null;
    const salesLineCount = sales ? Number(sales.line_count) || 0 : 0;
    const uncostedLines = sales ? Number(sales.uncosted_lines) || 0 : null;
    if (sales && uncostedLines) warnings.push(warning('UNCOSTED_SALES_LINES', `${uncostedLines} سطر مبيعات بقيمة صافية ${WI.round(sales.uncosted_net)} ر.س يحمل تكلفة صفر/مفقودة؛ الهامش غير مكتمل.`, 'error'));
    if (unprovenReturnCostLines) warnings.push(warning('UNPROVEN_RETURN_COGS', `${unprovenReturnCostLines} سطر مرتجع مُرحّل بلا مبلغ تكلفة معكوس مثبت؛ حُجب COGS والربح بعد المرتجعات بدل التخمين.`, 'error'));

    return res.json({
      success: true,
      data: {
        kpis: {
          inventoryValueWac: WI.round(inv.inventory_value),
          stockQty: WI.round(inv.stock_qty, 4),
          stockItems: Number(inv.stock_items) || 0,
          stockPositions: Number(inv.stock_positions) || 0,
          purchaseSpend: WI.round(pur.purchase_spend),
          receivedQty: WI.round(pur.received_qty, 4),
          receiptCount: Number(pur.receipt_count) || 0,
          supplierCount: Number(pur.supplier_count) || 0,
          openPoValue: WI.round(po.open_value),
          openPoQty: WI.round(po.open_qty, 4),
          openPoCount: Number(po.open_po_count) || 0,
          wasteValue: waste.waste_value == null ? null : WI.round(waste.waste_value),
          wasteQty: wasteQty.waste_qty == null ? null : WI.round(wasteQty.waste_qty, 4),
          wasteDocuments: waste.waste_docs == null ? null : Number(waste.waste_docs),
          negativePositions: Number(inv.negative_positions) || 0,
          negativeQty: WI.round(inv.negative_qty, 4),
          lowStockPositions: Number(inv.low_positions) || 0,
          outOfStockPositions: Number(inv.out_positions) || 0,
          totalQty: WI.round(inv.stock_qty, 4),
          itemCount: Number(inv.stock_items) || 0,
          negativeCount: Number(inv.negative_positions) || 0,
          lowCount: Number(inv.low_positions) || 0,
          outCount: Number(inv.out_positions) || 0,
          costedStockCount: Number(inv.wac_positions) || 0,
          estimatedCostStockCount: fallbackPositions,
        },
        costCoverage: {
          valuedPositions: Number(inv.stock_positions) || 0,
          warehouseWacPositions: Number(inv.wac_positions) || 0,
          itemCostFallbackPositions: fallbackPositions,
          missingCostPositions,
          fallbackValue: WI.round(inv.fallback_value),
          costedStockCount: Number(inv.wac_positions) || 0,
          estimatedCostStockCount: fallbackPositions,
          uncostedStockCount: missingCostPositions,
          totalStockCount: Number(inv.stock_positions) || 0,
          costedPct: Number(inv.stock_positions) ? WI.round((Number(inv.wac_positions) / Number(inv.stock_positions)) * 100) : 0,
          estimatedPct: Number(inv.stock_positions) ? WI.round((fallbackPositions / Number(inv.stock_positions)) * 100) : 0,
          uncostedPct: Number(inv.stock_positions) ? WI.round((missingCostPositions / Number(inv.stock_positions)) * 100) : 0,
        },
        purchaseBySupplier: (supplierResult[0] || []).map((row) => ({
          supplierId: row.supplier_id == null ? '' : String(row.supplier_id), supplierName: String(row.supplier_name || 'غير محدد'),
          documentCount: Number(row.document_count) || 0, receivedQty: WI.round(row.received_qty, 4), spend: WI.round(row.spend),
        })),
        purchaseTrend: (trendResult[0] || []).map((row) => ({ period: row.period, receivedQty: WI.round(row.received_qty, 4), spend: WI.round(row.spend) })),
        stockFlow: (stockFlowResult[0] || []).map((row) => ({
          type: String(row.reference_type) + ':' + String(row.type),
          label: String(row.reference_type || 'unclassified'), direction: row.type === 'in' ? 'in' : 'out',
          qty: WI.round(row.qty, 4), value: null,
        })),
        salesCostBridge: {
          state: salesCostBridgeState,
          basis: sales ? (returnsBridgeAvailable ? 'frozen_sale_cost_minus_proven_return_cogs_reversal' : 'frozen_ar_line_cost_snapshot_before_returns') : null,
          netSalesBeforeReturnsExVat: salesNetBeforeReturns,
          returnsNetExVat: returnsNet,
          netSalesExVat: salesNet,
          cogsBeforeReturnsSnapshot: salesCogsBeforeReturns,
          reversedCogs,
          cogsSnapshot: salesCogs,
          grossProfit,
          marginPct,
          lineCount: sales ? salesLineCount : null,
          costedLineCount: sales ? Number(sales.costed_lines) || 0 : null,
          uncostedLineCount: uncostedLines,
          uncostedNetAmount: sales ? WI.round(sales.uncosted_net) : null,
          coveragePct: sales && salesLineCount ? WI.round(((salesLineCount - uncostedLines) / salesLineCount) * 100) : null,
          includesReturns: returnsBridgeAvailable,
          unprovenReturnCostLineCount: unprovenReturnCostLines,
        },
        sourceCoverage: {
          inventory: 'warehouse_stock.avg_cost',
          purchases: 'posted_purchase_receipt_lines',
          openCommitments: openPo.valueBasis,
          waste: wasteAvailable ? 'waste_entries' : null,
          cogs: sales ? (returnsBridgeAvailable ? 'ar_document_lines.cost_snapshot - sales_return_lines.cogs_reversed_amount' : 'ar_document_lines.cost_snapshot') : null,
          turnover: null,
        },
      },
      filters: { from: filters.from, to: filters.to, warehouseId: filters.warehouseId },
      scope: scopeMeta(req, filters),
      warnings,
      generatedAt: now(),
    });
  } catch (error) { return handleError(res, error); }
});

/**
 * Current inventory subledger -> GL control reconciliation.
 *
 * This endpoint intentionally rejects historical/as-of filters.  The current
 * schema does not persist a complete immutable value on every inventory
 * movement, so recomputing an old balance with today's WAC would be false.
 */
router.get('/accounting-reconciliation', FINANCE_READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters) || !guardCurrentValuationOnly(req, res, filters)) return;
    const schema = await capabilities();
    WI.requireColumns(schema, {
      warehouse_stock: ['warehouse_id', 'item_id', 'qty', 'avg_cost'],
      inv_items: ['id', 'cost'],
      warehouses: ['id', 'name'],
      gl_accounts: ['id', 'code'],
      account_roles: ['role_key', 'company_id', 'account_id', 'is_active'],
      gl_journals: ['id', 'status'],
      gl_entries: ['journal_id', 'account_id', 'account_code', 'warehouse_id', 'debit', 'credit'],
    });

    const stockWhere = ['ws.qty <> 0'];
    const stockParams = [];
    if (filters.warehouseId) { stockWhere.push('ws.warehouse_id = ?'); stockParams.push(filters.warehouseId); }
    STRICT_SCOPE.append(req.warehouseScope, 'ws.warehouse_id', stockWhere, stockParams);
    const costExpr = 'COALESCE(NULLIF(ws.avg_cost,0), NULLIF(i.cost,0))';
    const [stockRows] = await db.query(
      `SELECT ws.warehouse_id, COALESCE(w.name,ws.warehouse_id) AS warehouse_name,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * COALESCE(${costExpr},0) ELSE 0 END),0) AS positive_value,
              COALESCE(SUM(CASE WHEN ws.qty < 0 THEN ws.qty * COALESCE(${costExpr},0) ELSE 0 END),0) AS negative_value,
              COALESCE(SUM(ws.qty * COALESCE(${costExpr},0)),0) AS subledger_value,
              COUNT(*) AS stock_positions,
              SUM(CASE WHEN NULLIF(ws.avg_cost,0) IS NOT NULL THEN 1 ELSE 0 END) AS wac_positions,
              SUM(CASE WHEN NULLIF(ws.avg_cost,0) IS NULL AND NULLIF(i.cost,0) IS NOT NULL THEN 1 ELSE 0 END) AS fallback_positions,
              SUM(CASE WHEN ${costExpr} IS NULL THEN 1 ELSE 0 END) AS missing_cost_positions,
              SUM(CASE WHEN ws.qty < 0 THEN 1 ELSE 0 END) AS negative_positions,
              SUM(CASE WHEN i.id IS NULL THEN 1 ELSE 0 END) AS orphan_stock_positions,
              SUM(CASE WHEN ${costExpr} < 0 THEN 1 ELSE 0 END) AS negative_cost_positions
         FROM warehouse_stock ws
         LEFT JOIN inv_items i ON i.id=ws.item_id
         LEFT JOIN warehouses w ON w.id=ws.warehouse_id
        WHERE ${stockWhere.join(' AND ')}
        GROUP BY ws.warehouse_id,w.name`, stockParams);

    const inventoryRole = await resolveLedgerRole(IAR.INVENTORY_ROLE);
    const glWhere = ["gj.status='posted'", '(ge.account_id=? OR (ge.account_id IS NULL AND ge.account_code=?))'];
    const glParams = [inventoryRole.accountId, inventoryRole.code];
    if (WI.hasColumn(schema, 'gl_journals', 'deleted_at')) glWhere.push('gj.deleted_at IS NULL');
    if (filters.warehouseId) { glWhere.push('ge.warehouse_id = ?'); glParams.push(filters.warehouseId); }
    STRICT_SCOPE.append(req.warehouseScope, 'ge.warehouse_id', glWhere, glParams);
    const [glRows] = await db.query(
      `SELECT ge.warehouse_id, COALESCE(w.name,ge.warehouse_id,'Unallocated') AS warehouse_name,
              COALESCE(SUM(ge.debit-ge.credit),0) AS gl_balance
         FROM gl_entries ge
         JOIN gl_journals gj ON gj.id=ge.journal_id
         LEFT JOIN gl_accounts ga ON ga.id=ge.account_id
         LEFT JOIN warehouses w ON w.id=ge.warehouse_id
        WHERE ${glWhere.join(' AND ')}
        GROUP BY ge.warehouse_id,w.name`, glParams);

    let inventoryMethod = 'perpetual';
    if (WI.hasColumn(schema, 'settings', 'setting_key') && WI.hasColumn(schema, 'settings', 'setting_value')) {
      const [methodRows] = await db.query("SELECT setting_value FROM settings WHERE setting_key='inventory_method' LIMIT 1");
      if (methodRows.length && methodRows[0].setting_value) inventoryMethod = String(methodRows[0].setting_value);
    }
    inventoryMethod = inventoryMethod.trim().toLowerCase();
    const rows = IAR.mergeReconciliationRows(stockRows, glRows);
    const publicScope = STRICT_SCOPE.publicScope(req.warehouseScope);
    const summary = IAR.summarizeReconciliation(rows, {
      scopeAll: publicScope.all && !filters.warehouseId,
      inventorySystem: inventoryMethod,
    });
    const perpetualReconciliationReady = inventoryMethod === 'perpetual' && summary.state === 'reconciled';
    const accountingBasisState = inventoryMethod === 'perpetual'
      ? 'perpetual_current_control'
      : inventoryMethod === 'periodic'
        ? 'periodic_close_required'
        : 'unsupported_inventory_system';

    return res.json({
      success: true,
      data: {
        rows,
        summary,
        measurement: {
          inventorySystem: inventoryMethod,
          accountingBasisState,
          perpetualReconciliationReady,
          costFormula: 'weighted_average_by_item_and_warehouse',
          currentOnly: true,
          inventoryControlAccount: { role: IAR.INVENTORY_ROLE, accountId: inventoryRole.accountId, code: inventoryRole.code },
          includesRecoverableVat: false,
          includesLandedCost: false,
        },
        ias2Readiness: {
          carryingAmount: summary.subledgerValue,
          carryingAmountReady: IAR.isCarryingAmountReady(summary, inventoryMethod),
          byInventoryClass: { state: 'unavailable', reason: 'INVENTORY_CLASSIFICATION_NOT_GOVERNED' },
          nrvAndWriteDowns: { state: 'unavailable', reason: 'NRV_TEST_AND_WRITE_DOWN_LEDGER_MISSING' },
          writeDownReversals: { state: 'unavailable', reason: 'WRITE_DOWN_REVERSAL_LEDGER_MISSING' },
          pledgedInventory: { state: 'unavailable', reason: 'PLEDGE_REGISTER_MISSING' },
          fairValueLessCostsToSell: { state: 'not_applicable_unless_such_inventory_exists', reason: 'NO_GOVERNED_FAIR_VALUE_CLASSIFICATION' },
        },
      },
      scope: scopeMeta(req, filters),
      warnings: summary.blockers.map((code) => warning(
        code,
        code,
        ['ORPHAN_STOCK_ITEM', 'NEGATIVE_COST', 'PERIODIC_INVENTORY_SYSTEM', 'INVENTORY_SYSTEM_UNSUPPORTED', 'SUBLEDGER_GL_DIFFERENCE'].includes(code)
          ? 'error'
          : 'warning',
      )),
      generatedAt: now(),
    });
  } catch (error) { return handleError(res, error); }
});

/** Current GRNI operational balance, aging and GL reconciliation. */
router.get('/grni-reconciliation', FINANCE_READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters) || !guardCurrentValuationOnly(req, res, filters)) return;
    const schema = await capabilities();
    WI.requireColumns(schema, {
      purchase_receipts: ['id', 'receipt_date', 'status', 'warehouse_id', 'supplier_id'],
      purchase_receipt_lines: ['id', 'receipt_id'],
      supplier_invoice_matches: ['invoice_id', 'receipt_line_id', 'matched_amount'],
      supplier_invoices: ['id', 'status'],
      purchase_returns: ['receipt_id', 'phase', 'status', 'subtotal'],
      gl_accounts: ['id', 'code'],
      account_roles: ['role_key', 'company_id', 'account_id', 'is_active'],
      gl_journals: ['id', 'status'],
      gl_entries: ['journal_id', 'account_id', 'account_code', 'debit', 'credit'],
    });
    const model = WI.purchaseModel(schema);
    const receiptWhere = ["pr.status='posted'"];
    const receiptParams = [];
    if (filters.warehouseId) { receiptWhere.push('pr.warehouse_id=?'); receiptParams.push(filters.warehouseId); }
    if (filters.supplierId) { receiptWhere.push('pr.supplier_id=?'); receiptParams.push(filters.supplierId); }
    STRICT_SCOPE.append(req.warehouseScope, 'pr.warehouse_id', receiptWhere, receiptParams);

    const receiptNumber = model.receiptNumber;
    const supplierName = model.supplierName;
    const grniOpenSql =
      `SELECT pr.id AS receipt_id, ${receiptNumber} AS receipt_number,
              pr.receipt_date, pr.warehouse_id, COALESCE(w.name,pr.warehouse_id) AS warehouse_name,
              pr.supplier_id, ${supplierName} AS supplier_name,
              DATEDIFF(CURDATE(),pr.receipt_date) AS age_days,
              COALESCE(SUM(${model.netAmount}),0) AS received_value,
              COALESCE(MAX(matched.matched_value),0) AS invoiced_value,
              COALESCE(MAX(ret.returned_value),0) AS returned_value,
              COALESCE(SUM(${model.netAmount}),0)-COALESCE(MAX(matched.matched_value),0)-COALESCE(MAX(ret.returned_value),0) AS outstanding_value
         FROM purchase_receipts pr
         JOIN purchase_receipt_lines prl ON prl.receipt_id=pr.id
         LEFT JOIN purchase_orders po ON po.id=pr.po_id
         LEFT JOIN suppliers s ON s.id=pr.supplier_id
         LEFT JOIN inv_items i ON i.id=prl.item_id
         LEFT JOIN warehouses w ON w.id=pr.warehouse_id
         LEFT JOIN (
           SELECT x.receipt_id, SUM(m.matched_amount) AS matched_value
             FROM purchase_receipt_lines x
             JOIN supplier_invoice_matches m ON m.receipt_line_id=x.id
             JOIN supplier_invoices si ON si.id=m.invoice_id
            WHERE si.status IN ('approved','partially_paid','paid','overdue','closed')
            GROUP BY x.receipt_id
         ) matched ON matched.receipt_id=pr.id
         LEFT JOIN (
           SELECT receipt_id, SUM(subtotal) AS returned_value
             FROM purchase_returns
            WHERE phase='before_invoice' AND status IN ('posted','settled')
            GROUP BY receipt_id
         ) ret ON ret.receipt_id=pr.id
        WHERE ${receiptWhere.join(' AND ')}
        GROUP BY pr.id,${receiptNumber},pr.receipt_date,pr.warehouse_id,w.name,pr.supplier_id,${supplierName}
       HAVING ABS(outstanding_value) > 0.009`;
    // Detail is deliberately capped for response size, but every aging and GL
    // reconciliation number below comes from the uncapped aggregate query.
    // Never compare a LIMITed subledger population with the complete GL.
    const [detailQuery, aggregateQuery] = await Promise.all([
      db.query(`${grniOpenSql} ORDER BY pr.receipt_date,pr.id LIMIT ?`, receiptParams.concat([IAR.GRNI_DETAIL_LIMIT])),
      db.query(
        `SELECT COUNT(*) AS open_count,
                COALESCE(SUM(outstanding_value),0) AS total,
                COALESCE(SUM(CASE WHEN outstanding_value < 0 THEN outstanding_value ELSE 0 END),0) AS negative,
                COALESCE(SUM(CASE WHEN outstanding_value >= 0 AND age_days <= 0 THEN outstanding_value ELSE 0 END),0) AS current_value,
                COALESCE(SUM(CASE WHEN outstanding_value >= 0 AND age_days BETWEEN 1 AND 30 THEN outstanding_value ELSE 0 END),0) AS d30,
                COALESCE(SUM(CASE WHEN outstanding_value >= 0 AND age_days BETWEEN 31 AND 60 THEN outstanding_value ELSE 0 END),0) AS d60,
                COALESCE(SUM(CASE WHEN outstanding_value >= 0 AND age_days BETWEEN 61 AND 90 THEN outstanding_value ELSE 0 END),0) AS d90,
                COALESCE(SUM(CASE WHEN outstanding_value >= 0 AND age_days > 90 THEN outstanding_value ELSE 0 END),0) AS d90plus
           FROM (${grniOpenSql}) grni_open`, receiptParams),
    ]);
    const rows = detailQuery[0] || [];

    const reportRows = rows.map((row) => {
      const outstanding = IAR.round2(Number(row.received_value) - Number(row.invoiced_value) - Number(row.returned_value));
      return {
        receiptId: String(row.receipt_id), receiptNumber: String(row.receipt_number || row.receipt_id),
        receiptDate: row.receipt_date, warehouseId: row.warehouse_id == null ? null : String(row.warehouse_id),
        warehouseName: String(row.warehouse_name || ''), supplierId: row.supplier_id == null ? null : String(row.supplier_id),
        supplierName: String(row.supplier_name || ''), ageDays: Number(row.age_days) || 0,
        receivedValue: IAR.round2(row.received_value), invoicedValue: IAR.round2(row.invoiced_value),
        returnedBeforeInvoiceValue: IAR.round2(row.returned_value), outstandingValue: outstanding,
      };
    });
    const aggregate = (aggregateQuery[0] && aggregateQuery[0][0]) || {};
    const aging = {
      current: IAR.round2(aggregate.current_value), d30: IAR.round2(aggregate.d30),
      d60: IAR.round2(aggregate.d60), d90: IAR.round2(aggregate.d90),
      d90plus: IAR.round2(aggregate.d90plus), negative: IAR.round2(aggregate.negative),
      total: IAR.round2(aggregate.total),
    };
    const openCount = Number(aggregate.open_count) || 0;
    const detailTruncated = openCount > reportRows.length;

    const publicScope = STRICT_SCOPE.publicScope(req.warehouseScope);
    const canReconcileCompanyGl = publicScope.all && !filters.warehouseId && !filters.supplierId;
    const grniRole = await resolveLedgerRole(IAR.GRNI_ROLE);
    let glBalance = null;
    if (canReconcileCompanyGl) {
      const glWhere = ["gj.status='posted'", '(ge.account_id=? OR (ge.account_id IS NULL AND ge.account_code=?))'];
      if (WI.hasColumn(schema, 'gl_journals', 'deleted_at')) glWhere.push('gj.deleted_at IS NULL');
      const [gl] = await db.query(
        `SELECT COALESCE(SUM(ge.credit-ge.debit),0) AS balance
           FROM gl_entries ge
           JOIN gl_journals gj ON gj.id=ge.journal_id
           LEFT JOIN gl_accounts ga ON ga.id=ge.account_id
          WHERE ${glWhere.join(' AND ')}`, [grniRole.accountId, grniRole.code]);
      glBalance = IAR.round2(gl[0] && gl[0].balance);
    }
    const difference = glBalance == null ? null : IAR.round2(aging.total - glBalance);
    const blockers = [];
    if (!canReconcileCompanyGl) blockers.push('GRNI_GL_NOT_WAREHOUSE_DIMENSIONED');
    if (aging.negative < -0.01) blockers.push('GRNI_OVER_CLEARED');
    if (difference != null && Math.abs(difference) > IAR.RECONCILIATION_TOLERANCE) blockers.push('GRNI_GL_DIFFERENCE');

    const reportWarnings = blockers.map((code) => warning(code, code, code === 'GRNI_GL_DIFFERENCE' ? 'error' : 'warning'));
    if (detailTruncated) reportWarnings.push(warning('GRNI_DETAIL_TRUNCATED', `Detail shows ${reportRows.length} of ${openCount} open receipts; aging and reconciliation still use the complete population.`, 'info'));

    return res.json({
      success: true,
      data: {
        rows: reportRows,
        aging,
        detail: { shown: reportRows.length, totalOpenReceipts: openCount, truncated: detailTruncated, limit: IAR.GRNI_DETAIL_LIMIT },
        reconciliation: {
          operationalOutstanding: aging.total,
          glBalance,
          difference,
          state: blockers.length ? 'not_reconciled' : 'reconciled',
          blockers,
          grniAccount: { role: IAR.GRNI_ROLE, accountId: grniRole.accountId, code: grniRole.code },
          currentOnly: true,
          population: 'uncapped_all_open_receipts',
        },
      },
      scope: scopeMeta(req, filters),
      warnings: reportWarnings,
      generatedAt: now(),
    });
  } catch (error) { return handleError(res, error); }
});

router.get('/purchases/export', READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters)) return;
    const schema = await capabilities();
    const model = WI.purchaseModel(schema);
    const built = purchaseWhere(req, filters, model);
    const rowsResult = await db.query(
      `SELECT ${purchaseSelect(model)}
         ${purchaseFrom(schema)} WHERE ${built.where.join(' AND ')}
        ORDER BY ${filters.sortColumn} ${filters.dir}, prl.id ${filters.dir}
        LIMIT ?`,
      built.params.concat([CSV_ROW_CAP + 1]),
    );
    const rows = (rowsResult[0] || []).map(mapPurchaseRow);
    if (rows.length > CSV_ROW_CAP) {
      return res.status(413).json({
        success: false,
        code: 'EXPORT_ROW_LIMIT',
        error: `نتيجة التصدير تتجاوز ${CSV_ROW_CAP} سطرًا. ضيّق الفترة أو المستودع أو المورد ثم أعد المحاولة.`,
        limit: CSV_ROW_CAP,
      });
    }
    const language = String(req.query.lang || '').toLowerCase() === 'en' ? 'en' : 'ar';
    const suffix = filters.from && filters.to ? `${filters.from}_${filters.to}` : new Date().toISOString().slice(0, 10);
    return sendCsv(res, `purchase-ledger-${suffix}.csv`, rows, purchaseCsvColumns(language));
  } catch (error) { return handleError(res, error); }
});

router.get('/purchases', READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters)) return;
    const schema = await capabilities();
    const model = WI.purchaseModel(schema);
    const built = purchaseWhere(req, filters, model);
    const fromSql = purchaseFrom(schema);
    const whereSql = 'WHERE ' + built.where.join(' AND ');
    const selectSql = `SELECT ${purchaseSelect(model)}
      ${fromSql} ${whereSql}
      ORDER BY ${filters.sortColumn} ${filters.dir}, prl.id ${filters.dir}
      LIMIT ? OFFSET ?`;
    const totalsSql = `SELECT COUNT(*) AS row_count, COUNT(DISTINCT pr.id) AS receipt_count,
        COUNT(DISTINCT pr.supplier_id) AS supplier_count, COUNT(DISTINCT prl.item_id) AS item_count,
        COALESCE(SUM(${model.enteredQty}),0) AS entered_qty,
        COALESCE(SUM(${model.qty}),0) AS base_qty,
        COALESCE(SUM(${model.netAmount}),0) AS net_amount,
        COALESCE(SUM(${model.vatAmount}),0) AS known_vat_amount,
        COALESCE(SUM(${model.grossAmount}),0) AS known_gross_amount,
        SUM(CASE WHEN (${model.vatRate}) IS NULL THEN 1 ELSE 0 END) AS missing_vat_lines
      ${fromSql} ${whereSql}`;
    const [rowsResult, totalsResult] = await Promise.all([
      db.query(selectSql, built.params.concat([filters.pageSize, filters.offset])),
      db.query(totalsSql, built.params),
    ]);
    const rows = (rowsResult[0] || []).map(mapPurchaseRow);
    const totals = totalsResult[0][0] || {};
    const total = Number(totals.row_count) || 0;
    const missingVatLines = Number(totals.missing_vat_lines) || 0;
    const knownVatAmount = WI.round(totals.known_vat_amount);
    const knownGrossAmount = WI.round(totals.known_gross_amount);
    const warnings = [warning('GRN_NET_COST', 'القيمة المعروضة هي صافي تكلفة سطر الاستلام المُرحّل؛ ضريبة ومديونية المورد تُراجع من فواتير المورد والمطابقة الثلاثية.')];
    if (missingVatLines) warnings.push(warning('GRN_VAT_SNAPSHOT_MISSING', `${missingVatLines} سطر استلام لا يحمل لقطة ضريبة؛ أُخفي إجمالي الضريبة والإجمالي الشامل بدل اعتبار الضريبة صفرًا.`, 'warning'));
    return res.json({
      success: true,
      data: rows,
      totals: {
        rows: total, receipts: Number(totals.receipt_count) || 0, suppliers: Number(totals.supplier_count) || 0,
        items: Number(totals.item_count) || 0, enteredQty: WI.round(totals.entered_qty, 4), baseQty: WI.round(totals.base_qty, 4),
        qty: WI.round(totals.base_qty, 4), netAmount: WI.round(totals.net_amount),
        vatAmount: missingVatLines ? null : knownVatAmount, grossAmount: missingVatLines ? null : knownGrossAmount,
        knownVatAmount, knownGrossAmount, missingVatLines,
      },
      pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.ceil(total / filters.pageSize) },
      filters: {
        from: filters.from, to: filters.to, warehouseId: filters.warehouseId, supplierId: filters.supplierId,
        itemId: filters.itemId, q: filters.q, sort: filters.sortKey, dir: filters.dir.toLowerCase(),
      },
      scope: scopeMeta(req, filters),
      warnings,
      generatedAt: now(),
    });
  } catch (error) { return handleError(res, error); }
});

// ── GET /performance ────────────────────────────────────────────────────────
// The measured half of the control centre: what actually moved, what it cost,
// which items carry the value, and what has stopped moving.
//
// ─── VALUATION BASIS, STATED ONCE ─────────────────────────────────────────
// There is no immutable valued-movement ledger in this schema, so a quantity
// that moved in June cannot be priced at June's cost. Everything valued here is
// priced at the CURRENT unit cost (warehouse WAC, item cost as fallback) and
// the payload says so in `valuationBasis`. That is the standard approximation
// and it is disclosed rather than implied — what is NOT done is inventing a
// historical cost and presenting it as fact.
//
// ─── WHY THE PERIOD ENDS ARE BACK-CAST ────────────────────────────────────
// Turnover needs average inventory, and average inventory needs the balance at
// both ends of the period. `warehouse_stock.qty` is TODAY's balance, not the
// period's. Reading it as the closing balance silently makes every historical
// period report today's stock — the mistake looks like a rounding difference
// and grows with how far back you look. So the balance at each end is rebuilt
// from today's balance minus the movements recorded since:
//     closing(to)   = on_hand − Σ signed movements after `to`
//     opening(from) = closing(to) − Σ signed movements within [from, to]
// which is exact for quantity whenever inventory_movements is the only writer.
//
// RC / MOVEMENT / PERF are required at the TOP of this file, not here. A
// `require` whose only use sits inside a route body passes `node --check` and
// passes module load — the ReferenceError waits until someone opens the report.
// This project has shipped that exact bug twice.

// Warehouse WAC with the item-cost fallback — the SAME expression the overview
// and the dashboard use, so a value here can be reconciled against those
// screens instead of being a third opinion.
const PERF_UNIT_COST = 'COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)';

function perfRiyadhToday() {
  // Riyadh is UTC+03:00 year-round (no DST), so the shift is a constant.
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function perfShiftDays(isoDate, days) {
  return new Date(Date.parse(isoDate + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

// Signed quantity: an inbound movement adds, an outbound subtracts.
const PERF_SIGNED_QTY = "(CASE WHEN m.type='in' THEN m.qty ELSE -m.qty END)";

router.get('/performance', READ, async (req, res) => {
  try {
    const filters = WI.parseFilters(req.query);
    if (!guardRequestedWarehouse(req, res, filters)) return;
    const schema = await capabilities();
    WI.requireColumns(schema, {
      warehouse_stock: ['warehouse_id', 'item_id', 'qty', 'avg_cost'],
      inv_items: ['id', 'name', 'cost'],
      inventory_movements: ['movement_date', 'item_id', 'type', 'qty', 'warehouse_id'],
    });

    const to = filters.to || perfRiyadhToday();
    const from = filters.from || perfShiftDays(to, -29);
    const days = PERF.rangeDays(from, to);
    // Daily buckets stay readable to about a quarter; past that they become a
    // hairline nobody can read, so the series switches to ISO weeks.
    const bucketMode = days > 92 ? 'week' : 'day';
    // DATE_FORMAT, not DATE(): mysql2 hands a DATE column back as a JS Date, and
    // String(Date) is "Mon Aug 03 2026 …". The trend is sorted by bucket, so
    // those strings sort ALPHABETICALLY — "Mon Aug 03" lands before "Mon Jul 27"
    // and the chart's time axis silently runs out of order. Caught on live data.
    const bucketSql = bucketMode === 'week'
      ? "DATE_FORMAT(m.movement_date,'%x-W%v')"
      : "DATE_FORMAT(m.movement_date,'%Y-%m-%d')";
    const warnings = [];

    const consumption = MOVEMENT.outboundConsumptionSql('m');

    // Scope fragments. Each query gets its OWN arrays: pushing onto a shared
    // one binds a warehouse id into whichever query happens to run first.
    function movementScope() {
      const where = [];
      const params = [];
      STRICT_SCOPE.append(req.warehouseScope, 'm.warehouse_id', where, params, filters.warehouseId);
      return { where, params };
    }
    function stockScope() {
      const where = [];
      const params = [];
      STRICT_SCOPE.append(req.warehouseScope, 'ws.warehouse_id', where, params, filters.warehouseId);
      return { where, params };
    }

    const ACTIVE_ITEM = 'i.active = 1 AND i.deleted_at IS NULL';
    // A movement row joins to the stock row of its OWN warehouse, so a transfer
    // is valued at the cost of the warehouse it left — not at some global mean.
    const MOVEMENT_JOIN =
      `FROM inventory_movements m
        JOIN inv_items i ON i.id = m.item_id
        LEFT JOIN warehouse_stock ws ON ws.warehouse_id = m.warehouse_id AND ws.item_id = m.item_id`;

    // ── 1. Consumption per item ────────────────────────────────────────────
    const c1 = movementScope();
    const consumedWhere = [consumption.sql, ACTIVE_ITEM].concat(c1.where);
    const consumedParams = consumption.params.concat([from, to], c1.params);
    const [consumedRows] = await db.query(
      `SELECT m.item_id AS itemId, i.name AS name, i.name_en AS nameEn, i.sku AS sku,
              COALESCE(NULLIF(i.category,''),'') AS category, COALESCE(i.unit,'') AS unit,
              COALESCE(SUM(m.qty),0) AS qty,
              COALESCE(SUM(m.qty * ${PERF_UNIT_COST}),0) AS value,
              COUNT(*) AS movements
         ${MOVEMENT_JOIN}
        WHERE ${consumedWhere[0]}
          AND m.movement_date >= ? AND m.movement_date < DATE_ADD(?, INTERVAL 1 DAY)
          AND ${consumedWhere.slice(1).join(' AND ')}
        GROUP BY m.item_id, i.name, i.name_en, i.sku, i.category, i.unit
        ORDER BY value DESC, qty DESC`,
      consumedParams);

    // ── 2. Per-item demand series → the XYZ coefficient of variation ───────
    const c2 = movementScope();
    const seriesWhere = [consumption.sql].concat(c2.where);
    const [seriesRows] = await db.query(
      `SELECT m.item_id AS itemId, ${bucketSql} AS bucket, COALESCE(SUM(m.qty),0) AS qty
         FROM inventory_movements m
        WHERE ${seriesWhere[0]}
          AND m.movement_date >= ? AND m.movement_date < DATE_ADD(?, INTERVAL 1 DAY)
          ${c2.where.length ? 'AND ' + c2.where.join(' AND ') : ''}
        GROUP BY m.item_id, bucket`,
      consumption.params.concat([from, to], c2.params));

    // ── 3. On-hand, last consumption, ageing ───────────────────────────────
    const c3 = stockScope();
    const c3sub = movementScope();
    const onHandWhere = [ACTIVE_ITEM].concat(c3.where);
    const [onHandRows] = await db.query(
      `SELECT i.id AS itemId, i.name AS name, i.name_en AS nameEn, i.sku AS sku,
              COALESCE(NULLIF(i.category,''),'') AS category, COALESCE(i.unit,'') AS unit,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * ${PERF_UNIT_COST} ELSE 0 END),0) AS value,
              MAX(lc.last_out) AS lastOut
         FROM warehouse_stock ws
         JOIN inv_items i ON i.id = ws.item_id
         LEFT JOIN (
           SELECT m.item_id, MAX(m.movement_date) AS last_out
             FROM inventory_movements m
            WHERE ${[consumption.sql].concat(c3sub.where).join(' AND ')}
            GROUP BY m.item_id
         ) lc ON lc.item_id = i.id
        WHERE ${onHandWhere.join(' AND ')}
        GROUP BY i.id, i.name, i.name_en, i.sku, i.category, i.unit`,
      // Placeholders inside the derived table are bound BEFORE the outer WHERE.
      MOVEMENT.subqueryFirstParams(consumption.params, c3sub.params, c3.params, []));

    // ── 4. Movement trend, valued ──────────────────────────────────────────
    const c4 = movementScope();
    const [trendRows] = await db.query(
      `SELECT ${bucketSql} AS bucket, m.type AS type,
              COALESCE(SUM(m.qty),0) AS qty,
              COALESCE(SUM(m.qty * ${PERF_UNIT_COST}),0) AS value
         ${MOVEMENT_JOIN}
        WHERE ${ACTIVE_ITEM}
          AND m.movement_date >= ? AND m.movement_date < DATE_ADD(?, INTERVAL 1 DAY)
          ${c4.where.length ? 'AND ' + c4.where.join(' AND ') : ''}
        GROUP BY bucket, m.type
        ORDER BY bucket`,
      [from, to].concat(c4.params));

    // ── 5. Period ends, back-cast (see the header note) ────────────────────
    const c5 = stockScope();
    const c5sub = movementScope();
    const [[endsRow]] = await db.query(
      `SELECT
         COALESCE(SUM(GREATEST(pos.on_hand,0) * pos.unit_cost),0) AS onHandValue,
         COALESCE(SUM(GREATEST(pos.on_hand,0)),0) AS onHandQty,
         COALESCE(SUM(GREATEST(pos.on_hand - pos.net_after,0) * pos.unit_cost),0) AS closingValue,
         COALESCE(SUM(GREATEST(pos.on_hand - pos.net_after - pos.net_in,0) * pos.unit_cost),0) AS openingValue,
         SUM(CASE WHEN pos.on_hand > 0 THEN 1 ELSE 0 END) AS inStockPositions,
         COUNT(*) AS stockedPositions
       FROM (
         SELECT ws.qty AS on_hand, ${PERF_UNIT_COST} AS unit_cost,
                COALESCE(mv.net_in,0) AS net_in, COALESCE(mv.net_after,0) AS net_after
           FROM warehouse_stock ws
           JOIN inv_items i ON i.id = ws.item_id
           LEFT JOIN (
             SELECT m.warehouse_id, m.item_id,
                    SUM(CASE WHEN m.movement_date >= ? AND m.movement_date < DATE_ADD(?, INTERVAL 1 DAY)
                             THEN ${PERF_SIGNED_QTY} ELSE 0 END) AS net_in,
                    SUM(CASE WHEN m.movement_date >= DATE_ADD(?, INTERVAL 1 DAY)
                             THEN ${PERF_SIGNED_QTY} ELSE 0 END) AS net_after
               FROM inventory_movements m
              ${c5sub.where.length ? 'WHERE ' + c5sub.where.join(' AND ') : ''}
              GROUP BY m.warehouse_id, m.item_id
           ) mv ON mv.warehouse_id = ws.warehouse_id AND mv.item_id = ws.item_id
          WHERE ${[ACTIVE_ITEM].concat(c5.where).join(' AND ')}
       ) pos`,
      [from, to, to].concat(c5sub.params, c5.params));

    // ── 6. Value on hand by warehouse ──────────────────────────────────────
    const c6 = stockScope();
    const [warehouseRows] = await db.query(
      `SELECT w.id AS warehouseId, w.name AS name, COALESCE(w.code,'') AS code,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty ELSE 0 END),0) AS qty,
              COALESCE(SUM(CASE WHEN ws.qty > 0 THEN ws.qty * ${PERF_UNIT_COST} ELSE 0 END),0) AS value
         FROM warehouse_stock ws
         JOIN warehouses w ON w.id = ws.warehouse_id
         JOIN inv_items i ON i.id = ws.item_id
        WHERE ${[ACTIVE_ITEM].concat(c6.where).join(' AND ')}
        GROUP BY w.id, w.name, w.code
        ORDER BY value DESC, qty DESC`,
      c6.params);

    // ── 7. Best sellers — what the CUSTOMER bought ─────────────────────────
    // Deliberately a different question from "most consumed": consumption is
    // raw material leaving a shelf, this is finished goods leaving the till,
    // and on a kitchen one sold item consumes many stock items. Reporting one
    // as the other is the classic restaurant-ERP mistake.
    let topSelling = { state: 'unavailable', rows: [] };
    const sellingColumns = ['document_id', 'base_qty', 'net_amount', 'cost_snapshot', 'description'];
    const salesAvailable = sellingColumns.every((c) => WI.hasColumn(schema, 'ar_document_lines', c)) &&
      ['id', 'document_type', 'status', 'issue_date'].every((c) => WI.hasColumn(schema, 'ar_documents', c));
    if (!salesAvailable) {
      warnings.push(warning('BEST_SELLERS_UNAVAILABLE', 'سجل سطور الفواتير غير متاح في هذه البنية، فلم تُعرض قائمة الأكثر مبيعًا.', 'warning'));
    } else {
      const c7 = [];
      const c7params = [];
      STRICT_SCOPE.append(req.warehouseScope, 'COALESCE(d.warehouse_id, doc.warehouse_id)', c7, c7params, filters.warehouseId);
      // A credit note is a negative sale. Counting it as a positive one makes
      // the most-REFUNDED item look like the best seller.
      const SIGN = "(CASE WHEN doc.document_type='credit_note' THEN -1 ELSE 1 END)";
      const [sellRows] = await db.query(
        `SELECT COALESCE(NULLIF(d.menu_id,''), NULLIF(d.item_id,''), d.description) AS soldKey,
                MAX(COALESCE(NULLIF(d.description,''),'')) AS name,
                MAX(COALESCE(d.category_name_snapshot,'')) AS category,
                COALESCE(SUM(${SIGN} * d.base_qty),0) AS qty,
                COALESCE(SUM(${SIGN} * d.net_amount),0) AS revenue,
                COALESCE(SUM(${SIGN} * d.cost_snapshot),0) AS cost,
                COUNT(DISTINCT d.document_id) AS orders
           FROM ar_document_lines d
           JOIN ar_documents doc ON doc.id = d.document_id
          WHERE doc.status NOT IN ('draft','cancelled')
            AND doc.issue_date >= ? AND doc.issue_date <= ?
            ${c7.length ? 'AND ' + c7.join(' AND ') : ''}
          GROUP BY soldKey
         HAVING qty <> 0 OR revenue <> 0
          ORDER BY revenue DESC, qty DESC
          LIMIT 15`,
        [from, to].concat(c7params));
      const revenueTotal = sellRows.reduce((sum, r) => sum + Math.max(Number(r.revenue) || 0, 0), 0);
      topSelling = {
        state: 'available',
        rows: sellRows.map((r) => {
          const revenue = PERF.round(r.revenue);
          const cost = PERF.round(r.cost);
          return {
            key: String(r.soldKey || ''),
            name: String(r.name || r.soldKey || ''),
            category: String(r.category || ''),
            qty: PERF.round(r.qty, 3),
            revenue,
            cost,
            grossProfit: PERF.round(revenue - cost),
            // Margin on zero revenue is not 0% — it is undefined. A 0 here
            // sorts a refunded item alongside a break-even one.
            marginPct: revenue > 0 ? PERF.round(((revenue - cost) / revenue) * 100, 2) : null,
            orders: Number(r.orders) || 0,
            share: revenueTotal > 0 ? PERF.round((Math.max(revenue, 0) / revenueTotal) * 100, 2) : 0,
          };
        }),
      };
    }

    // ── Assemble ───────────────────────────────────────────────────────────
    const seriesByItem = new Map();
    seriesRows.forEach((row) => {
      const key = String(row.itemId);
      if (!seriesByItem.has(key)) seriesByItem.set(key, []);
      seriesByItem.get(key).push(Number(row.qty) || 0);
    });

    const onHandByItem = new Map();
    onHandRows.forEach((row) => onHandByItem.set(String(row.itemId), row));

    const consumedBase = consumedRows.map((row) => ({
      itemId: String(row.itemId),
      name: String(row.name || ''),
      nameEn: row.nameEn ? String(row.nameEn) : null,
      sku: row.sku ? String(row.sku) : null,
      category: String(row.category || ''),
      unit: String(row.unit || ''),
      qty: PERF.round(row.qty, 3),
      value: PERF.round(row.value),
      movements: Number(row.movements) || 0,
    }));

    const classified = PERF.classifyAbc(consumedBase).map((row) => {
      const cv = PERF.coefficientOfVariation(seriesByItem.get(row.itemId) || []);
      const onHand = onHandByItem.get(row.itemId);
      const onHandQty = onHand ? PERF.round(onHand.qty, 3) : 0;
      return Object.assign({}, row, {
        cv,
        xyzClass: PERF.xyzClass(cv),
        onHandQty,
        daysOfCover: PERF.daysOfCover(onHandQty, row.qty, days),
      });
    });

    const trendMap = new Map();
    trendRows.forEach((row) => {
      const key = String(row.bucket);
      if (!trendMap.has(key)) trendMap.set(key, { bucket: key, inQty: 0, outQty: 0, inValue: 0, outValue: 0 });
      const point = trendMap.get(key);
      if (row.type === 'in') { point.inQty = PERF.round(row.qty, 3); point.inValue = PERF.round(row.value); }
      else { point.outQty = PERF.round(row.qty, 3); point.outValue = PERF.round(row.value); }
    });
    const consumptionTrend = [...trendMap.values()]
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
      .map((point) => Object.assign({}, point, { netQty: PERF.round(point.inQty - point.outQty, 3) }));

    const categoryMap = new Map();
    consumedBase.forEach((row) => {
      const key = row.category || '';
      if (!categoryMap.has(key)) categoryMap.set(key, { category: key, qty: 0, value: 0, items: 0 });
      const entry = categoryMap.get(key);
      entry.qty = PERF.round(entry.qty + row.qty, 3);
      entry.value = PERF.round(entry.value + row.value);
      entry.items += 1;
    });
    const categoryTotal = [...categoryMap.values()].reduce((sum, e) => sum + Math.max(e.value, 0), 0);
    const categoryMix = [...categoryMap.values()]
      .sort((a, b) => b.value - a.value)
      .map((entry) => Object.assign({}, entry, {
        share: categoryTotal > 0 ? PERF.round((Math.max(entry.value, 0) / categoryTotal) * 100, 2) : 0,
      }));

    const ageingMap = new Map(PERF.AGING_BUCKETS.map((b) => [b, { bucket: b, items: 0, qty: 0, value: 0 }]));
    let deadStockValue = 0;
    let deadStockItems = 0;
    const today = Date.parse(perfRiyadhToday() + 'T00:00:00Z');
    onHandRows.forEach((row) => {
      const qty = Number(row.qty) || 0;
      if (!(qty > 0)) return;
      const last = row.lastOut ? Date.parse(String(row.lastOut).slice(0, 10) + 'T00:00:00Z') : NaN;
      const age = Number.isFinite(last) ? Math.max(0, Math.round((today - last) / 86400000)) : null;
      const bucket = PERF.agingBucket(age);
      const entry = ageingMap.get(bucket);
      entry.items += 1;
      entry.qty = PERF.round(entry.qty + qty, 3);
      entry.value = PERF.round(entry.value + (Number(row.value) || 0));
      // Dead stock: on the shelf, and nothing consumed it in the no-movement
      // window. `never` counts — stock received and never issued is the purest
      // form of dead stock, not a special case to exclude.
      if (bucket === 'never' || bucket === 'over_180') {
        deadStockValue = PERF.round(deadStockValue + (Number(row.value) || 0));
        deadStockItems += 1;
      }
    });
    const ageingTotal = [...ageingMap.values()].reduce((sum, e) => sum + Math.max(e.value, 0), 0);
    const ageing = [...ageingMap.values()].map((entry) => Object.assign({}, entry, {
      sharePct: ageingTotal > 0 ? PERF.round((Math.max(entry.value, 0) / ageingTotal) * 100, 2) : 0,
    }));

    const consumptionValue = PERF.round(consumedBase.reduce((sum, r) => sum + r.value, 0));
    const consumptionQty = PERF.round(consumedBase.reduce((sum, r) => sum + r.qty, 0), 3);
    const openingValue = PERF.round(endsRow && endsRow.openingValue);
    const closingValue = PERF.round(endsRow && endsRow.closingValue);
    const onHandValue = PERF.round(endsRow && endsRow.onHandValue);
    const turns = PERF.turnover({ consumptionValue, openingValue, closingValue, days });
    const stockedPositions = Number(endsRow && endsRow.stockedPositions) || 0;
    const inStockPositions = Number(endsRow && endsRow.inStockPositions) || 0;

    if (turns.turnoverRatio == null) {
      warnings.push(warning('TURNOVER_NO_AVERAGE_INVENTORY', 'لا يوجد رصيد مخزون مقيَّم في طرفي الفترة، فلم يُحتسب معدل الدوران بدل عرض صفر مضلل.', 'info'));
    }

    // NOT RC.envelope: it renames `warnings` to `dataQualityWarnings` and drops
    // anything passed under the other name — the probe returned an empty
    // warnings array while the handler had genuinely pushed one. Every sibling
    // endpoint in this file emits `warnings`, and the client adapter reads it.
    return res.json({
      success: true,
      data: {
        period: { from, to, days, bucket: bucketMode },
        kpis: {
          consumptionValue,
          consumptionQty,
          consumedSkus: consumedBase.length,
          openingValue,
          closingValue,
          onHandValue,
          onHandQty: PERF.round(endsRow && endsRow.onHandQty, 3),
          averageInventoryValue: turns.averageInventoryValue,
          turnoverRatio: turns.turnoverRatio,
          annualizedTurnover: turns.annualizedTurnover,
          daysOnHand: turns.daysOnHand,
          deadStockValue,
          deadStockItems,
          deadStockPct: onHandValue > 0 ? PERF.round((deadStockValue / onHandValue) * 100, 2) : null,
          // Availability: stocked positions actually carrying stock. Null on an
          // empty catalogue — 0% would read as a total stock-out.
          availabilityPct: stockedPositions > 0 ? PERF.round((inStockPositions / stockedPositions) * 100, 2) : null,
          stockedPositions,
          outOfStockPositions: stockedPositions - inStockPositions,
          valuationBasis: 'current_unit_cost',
        },
        topConsumed: classified.slice(0, 15),
        abcSummary: PERF.summarizeAbc(classified),
        abcItemCount: classified.length,
        topSelling,
        consumptionTrend,
        categoryMix: categoryMix.slice(0, 10),
        warehouseMix: warehouseRows.map((row) => ({
          warehouseId: String(row.warehouseId),
          name: String(row.name || ''),
          code: String(row.code || ''),
          qty: PERF.round(row.qty, 3),
          value: PERF.round(row.value),
        })),
        ageing,
      },
      totals: { consumptionValue, consumptionQty, onHandValue, turnoverRatio: turns.turnoverRatio, daysOnHand: turns.daysOnHand },
      pagination: null,
      filters: { from, to, warehouseId: filters.warehouseId },
      scope: scopeMeta(req, filters),
      warnings,
      generatedAt: now(),
    });
  } catch (error) { return handleError(res, error); }
});

module.exports = router;
