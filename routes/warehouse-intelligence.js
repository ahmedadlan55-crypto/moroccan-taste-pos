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
      GROUP BY pr.supplier_id, supplier_name ORDER BY spend DESC LIMIT 8`;
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

module.exports = router;
