/**
 * Inventory accounting/reporting contract.
 *
 * The registry deliberately distinguishes financial-statement disclosures
 * from operational ERP reports.  A dashboard card is not evidence of IAS 2
 * compliance; every financial report must declare its measurement basis and
 * the immutable facts it needs before it can be marked authoritative.
 */
'use strict';

const INVENTORY_ROLE = 'INVENTORY';
const GRNI_ROLE = 'GRNI';
const RECONCILIATION_TOLERANCE = 0.01;
const GRNI_DETAIL_LIMIT = 2000;

const REPORT_REQUIREMENTS = Object.freeze([
  // IAS 2 / financial close
  { id: 'inventory-accounting-policy', family: 'financial', authority: 'IAS 2.36(a)', requiredFacts: ['cost_formula', 'measurement_policy'] },
  { id: 'inventory-carrying-amount-by-class', family: 'financial', authority: 'IAS 2.36(b)', requiredFacts: ['inventory_class', 'carrying_amount'] },
  { id: 'inventory-fair-value-less-costs-to-sell', family: 'financial', authority: 'IAS 2.36(c)', requiredFacts: ['fair_value_less_costs_to_sell'] },
  { id: 'inventory-expense-cogs', family: 'financial', authority: 'IAS 2.36(d)', requiredFacts: ['frozen_cogs', 'posting_date'] },
  { id: 'inventory-write-downs', family: 'financial', authority: 'IAS 2.36(e)', requiredFacts: ['nrv_test', 'write_down_journal'] },
  { id: 'inventory-write-down-reversals', family: 'financial', authority: 'IAS 2.36(f)-(g)', requiredFacts: ['reversal_journal', 'reversal_circumstances'] },
  { id: 'inventory-pledged', family: 'financial', authority: 'IAS 2.36(h)', requiredFacts: ['pledge_contract', 'pledged_carrying_amount'] },
  { id: 'inventory-subledger-gl-reconciliation', family: 'financial', authority: 'IAS 1 / close control', requiredFacts: ['warehouse_wac', 'posted_gl_entries'] },
  { id: 'inventory-roll-forward', family: 'financial', authority: 'close control', requiredFacts: ['opening_valuation', 'valued_movements', 'closing_valuation'] },
  { id: 'grni-reconciliation', family: 'financial', authority: 'accrual close control', requiredFacts: ['posted_grn', 'supplier_invoice_match', 'grni_gl'] },
  // Core warehouse control
  { id: 'stock-on-hand', family: 'warehouse', authority: 'ERP control', requiredFacts: ['warehouse_stock'] },
  { id: 'stock-card-valued', family: 'warehouse', authority: 'ERP control', requiredFacts: ['immutable_valued_movements'] },
  { id: 'inventory-as-of', family: 'warehouse', authority: 'ERP close control', requiredFacts: ['valued_movements', 'posting_timestamp'] },
  { id: 'lot-expiry-traceability', family: 'warehouse', authority: 'ERP control', requiredFacts: ['lot_id', 'expiry_date', 'movement_link'] },
  { id: 'inventory-aging-slow-dead', family: 'warehouse', authority: 'ERP control', requiredFacts: ['receipt_layer', 'issue_layer'] },
  { id: 'negative-backdated-stock', family: 'warehouse', authority: 'ERP control', requiredFacts: ['movement_timestamp', 'running_balance'] },
  { id: 'stocktake-accuracy-shrinkage', family: 'warehouse', authority: 'ERP control', requiredFacts: ['count_snapshot', 'variance_posting'] },
  { id: 'transfer-in-transit', family: 'warehouse', authority: 'ERP control', requiredFacts: ['dispatch', 'receipt', 'in_transit_status'] },
  { id: 'reorder-safety-stock-service-level', family: 'warehouse', authority: 'ERP planning', requiredFacts: ['demand_history', 'lead_time', 'service_level'] },
  { id: 'abc-xyz-turnover-doh', family: 'warehouse', authority: 'ERP analytics', requiredFacts: ['daily_valuation', 'net_cogs', 'demand_variability'] },
  // Procurement / cost control
  { id: 'purchase-order-commitments', family: 'procurement', authority: 'ERP control', requiredFacts: ['po_lines', 'received_qty'] },
  { id: 'purchase-receipts', family: 'procurement', authority: 'ERP control', requiredFacts: ['posted_grn_lines', 'frozen_cost'] },
  { id: 'three-way-match', family: 'procurement', authority: 'ERP control', requiredFacts: ['po', 'grn', 'supplier_invoice'] },
  { id: 'purchase-price-variance', family: 'procurement', authority: 'cost control', requiredFacts: ['matched_qty', 'grn_cost', 'invoice_price', 'ppv_gl'] },
  { id: 'landed-cost-allocation', family: 'procurement', authority: 'IAS 2 cost', requiredFacts: ['landed_cost_component', 'allocation_basis', 'inventory_layer'] },
  { id: 'supplier-performance-otif-quality', family: 'procurement', authority: 'ERP control', requiredFacts: ['promised_date', 'receipt_date', 'accepted_rejected_qty'] },
  { id: 'supplier-statement-ap-aging', family: 'procurement', authority: 'AP control', requiredFacts: ['supplier_invoice', 'payment_allocation', 'credit_note'] },
  { id: 'input-vat-reconciliation', family: 'procurement', authority: 'ZATCA VAT control', requiredFacts: ['tax_invoice', 'tax_code', 'credit_note', 'vat_gl'] },
  { id: 'purchase-returns', family: 'procurement', authority: 'ERP control', requiredFacts: ['original_receipt_cost', 'return_phase', 'supplier_credit_note'] },
  // Production and margin integration
  { id: 'production-wip-yield-variance', family: 'cost', authority: 'IAS 2 conversion cost', requiredFacts: ['material_issue', 'labor_overhead', 'good_output', 'waste'] },
  { id: 'recipe-standard-vs-actual', family: 'cost', authority: 'cost control', requiredFacts: ['standard_recipe_snapshot', 'actual_consumption'] },
  { id: 'sales-cogs-gross-margin', family: 'cost', authority: 'IAS 2 expense recognition', requiredFacts: ['net_sales', 'frozen_cogs', 'return_cogs_reversal'] },
]);

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function mergeReconciliationRows(stockRows, glRows) {
  const byWarehouse = new Map();
  for (const row of stockRows || []) {
    const id = row.warehouse_id == null ? null : String(row.warehouse_id);
    const key = id == null ? '__UNALLOCATED__' : id;
    byWarehouse.set(key, {
      warehouseId: id,
      warehouseName: String(row.warehouse_name || id || 'Unallocated'),
      positiveValue: round2(row.positive_value),
      negativeValue: round2(row.negative_value),
      subledgerValue: round2(row.subledger_value),
      stockPositions: Number(row.stock_positions) || 0,
      wacPositions: Number(row.wac_positions) || 0,
      fallbackPositions: Number(row.fallback_positions) || 0,
      missingCostPositions: Number(row.missing_cost_positions) || 0,
      negativePositions: Number(row.negative_positions) || 0,
      orphanStockPositions: Number(row.orphan_stock_positions) || 0,
      negativeCostPositions: Number(row.negative_cost_positions) || 0,
      glBalance: 0,
    });
  }
  for (const row of glRows || []) {
    const id = row.warehouse_id == null ? null : String(row.warehouse_id);
    const key = id == null ? '__UNALLOCATED__' : id;
    const current = byWarehouse.get(key) || {
      warehouseId: id,
      warehouseName: String(row.warehouse_name || id || 'Unallocated'),
      positiveValue: 0,
      negativeValue: 0,
      subledgerValue: 0,
      stockPositions: 0,
      wacPositions: 0,
      fallbackPositions: 0,
      missingCostPositions: 0,
      negativePositions: 0,
      orphanStockPositions: 0,
      negativeCostPositions: 0,
      glBalance: 0,
    };
    current.glBalance = round2(row.gl_balance);
    byWarehouse.set(key, current);
  }
  return [...byWarehouse.values()]
    .map((row) => ({ ...row, difference: round2(row.subledgerValue - row.glBalance) }))
    .sort((a, b) => String(a.warehouseName).localeCompare(String(b.warehouseName)));
}

function summarizeReconciliation(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  const scopeAll = !!(options && options.scopeAll);
  const inventorySystem = String((options && options.inventorySystem) || 'perpetual').trim().toLowerCase();
  const totals = list.reduce((acc, row) => {
    for (const key of ['positiveValue', 'negativeValue', 'subledgerValue', 'glBalance']) acc[key] += Number(row[key]) || 0;
    for (const key of ['stockPositions', 'wacPositions', 'fallbackPositions', 'missingCostPositions', 'negativePositions', 'orphanStockPositions', 'negativeCostPositions']) acc[key] += Number(row[key]) || 0;
    if (row.warehouseId === null) acc.unallocatedGlValue += Number(row.glBalance) || 0;
    return acc;
  }, {
    positiveValue: 0, negativeValue: 0, subledgerValue: 0, glBalance: 0,
    stockPositions: 0, wacPositions: 0, fallbackPositions: 0,
    missingCostPositions: 0, negativePositions: 0, orphanStockPositions: 0,
    negativeCostPositions: 0, unallocatedGlValue: 0,
  });
  for (const key of ['positiveValue', 'negativeValue', 'subledgerValue', 'glBalance', 'unallocatedGlValue']) totals[key] = round2(totals[key]);
  totals.difference = round2(totals.subledgerValue - totals.glBalance);
  const rowDifference = (row) => row.difference == null
    ? round2((Number(row.subledgerValue) || 0) - (Number(row.glBalance) || 0))
    : Number(row.difference) || 0;
  totals.warehouseDimensionDifferenceCount = list.filter((row) => Math.abs(rowDifference(row)) > RECONCILIATION_TOLERANCE).length;
  totals.maxWarehouseDimensionDifference = round2(list.reduce((max, row) => Math.max(max, Math.abs(rowDifference(row))), 0));

  const blockers = [];
  if (!scopeAll) blockers.push('WAREHOUSE_SCOPE_PARTIAL');
  if (totals.fallbackPositions) blockers.push('MASTER_COST_FALLBACK');
  if (totals.missingCostPositions) blockers.push('MISSING_COST');
  if (totals.negativePositions) blockers.push('NEGATIVE_STOCK');
  if (totals.orphanStockPositions) blockers.push('ORPHAN_STOCK_ITEM');
  if (totals.negativeCostPositions) blockers.push('NEGATIVE_COST');
  if (inventorySystem === 'periodic') blockers.push('PERIODIC_INVENTORY_SYSTEM');
  else if (inventorySystem !== 'perpetual') blockers.push('INVENTORY_SYSTEM_UNSUPPORTED');
  if (Math.abs(totals.unallocatedGlValue) > RECONCILIATION_TOLERANCE) blockers.push('UNALLOCATED_GL_BALANCE');
  if (totals.warehouseDimensionDifferenceCount) blockers.push('WAREHOUSE_DIMENSION_DIFFERENCE');
  if (Math.abs(totals.difference) > RECONCILIATION_TOLERANCE) blockers.push('SUBLEDGER_GL_DIFFERENCE');
  const state = blockers.length === 0 ? 'reconciled' : 'not_reconciled';
  return { ...totals, state, blockers, tolerance: RECONCILIATION_TOLERANCE, inventorySystem };
}

function isCarryingAmountReady(summary, inventorySystem) {
  const blockers = new Set((summary && summary.blockers) || []);
  const system = String(inventorySystem || (summary && summary.inventorySystem) || '').trim().toLowerCase();
  if (system !== 'perpetual') return false;
  return ![
    'MASTER_COST_FALLBACK',
    'MISSING_COST',
    'NEGATIVE_STOCK',
    'ORPHAN_STOCK_ITEM',
    'NEGATIVE_COST',
    'PERIODIC_INVENTORY_SYSTEM',
    'INVENTORY_SYSTEM_UNSUPPORTED',
  ].some((code) => blockers.has(code));
}

module.exports = {
  INVENTORY_ROLE,
  GRNI_ROLE,
  RECONCILIATION_TOLERANCE,
  GRNI_DETAIL_LIMIT,
  REPORT_REQUIREMENTS,
  round2,
  mergeReconciliationRows,
  summarizeReconciliation,
  isCarryingAmountReady,
};
