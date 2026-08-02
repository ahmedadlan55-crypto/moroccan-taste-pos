/**
 * Unified inventory-OPERATIONS read model — pure rules (no DB, no express).
 *
 * WHY this module exists
 * ──────────────────────
 * Eleven independent document families (three "v2" doc types, stocktakes,
 * transfers, production V2 + production legacy, GRN, RTV, legacy purchases,
 * legacy adjustments) each own a header table with its OWN status vocabulary,
 * its OWN date type, its OWN actor column names and — for two of them — no
 * document number at all. A single operations screen needs ONE row shape over
 * all of them.
 *
 * The ONLY way that stays injection-safe is a DECLARATIVE descriptor: every
 * table name, column name and status literal in the generated SQL comes from
 * `SOURCES` below and is validated against a strict identifier regex; every
 * value that originates from the caller is bound as a parameter. A route may
 * never hand a column name to this module.
 *
 * The descriptor is ALSO the single authority for the status mapping: both
 * `canonicalStatus()` (JS) and the `CASE` expression emitted into SQL are
 * generated from the SAME `statusMap`, so the two can never drift.
 *
 * Pure + unit-tested in tests/inventoryOperations.test.js.
 */
'use strict';

// ── The canonical status set every source vocabulary is projected onto ───────
// Ordered from "not yet real" to "undone" — the UI renders tabs in this order.
const CANONICAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'in_progress',
  'posted',
  'partially_completed',
  'completed',
  'cancelled',
  'reversed',
];

// Sort keys → the PROJECTED alias of the union (never a raw table column, so a
// branch that lacks the underlying column can still be sorted). Allow-list.
const SORTABLE = {
  date: 'date',
  documentNumber: 'documentNumber',
  status: 'status',
  documentType: 'documentType',
  totalValue: 'totalValue',
  createdAt: 'createdAt',
};
const DEFAULT_SORT = 'date';
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

// ── Identifier / literal guards ─────────────────────────────────────────────
// Everything interpolated into SQL passes through one of these. They exist so a
// future descriptor typo (or a malicious edit) fails LOUDLY at build time
// instead of producing an injectable statement.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LITERAL_RE = /^[A-Za-z0-9_]+$/;

function ident(name) {
  const s = String(name == null ? '' : name);
  if (!IDENT_RE.test(s)) throw new Error('INVALID_IDENTIFIER: ' + s);
  return s;
}
function _t(col) { return 't.' + ident(col); }
function _lit(v) {
  const s = String(v == null ? '' : v);
  if (!LITERAL_RE.test(s)) throw new Error('INVALID_LITERAL: ' + s);
  return "'" + s + "'";
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCES — one entry per document type.
//
// Field reference (only `documentType`, `table`, `pk`, `dateColumn`,
// `statusColumn`, `statusMap`, `source`, `destination` are mandatory):
//   numberColumn        column holding the human document number, or null
//   numberFallbackToPk  COALESCE(number, id) — the column exists but may be NULL
//   dateIsDatetime      the business date is DATETIME → needs DATE() in SQL
//   statusMap           raw status → canonical status (covers the FULL enum)
//   source/destination  { kind, idColumn } — kind ∈ warehouse|supplier|
//                       gl_account|expense|external
//   partyLabelColumns   COALESCE-ordered columns holding a human party name
//   lines               { table, fk, qtyExpr, nameColumn|joinItems }
//   quantityHeaderColumn  header column that IS the quantity (production)
//   value               { netColumn, vatColumn, grossColumn, signed }
//   capability          capability id required to SEE this branch, or null when
//                       the branch's own list endpoint has no guard today
//   scopeColumns        warehouse columns the scope clause is OR-ed across
//   warehouseColumns    columns an explicit ?warehouseId filter matches
//   extraWhere          trusted constant SQL fragment (soft-delete / source tag)
//   actorStamps         [action, byColumn, atColumn] — synthetic timeline
//   timeline            { kind, docType } — which audit table to fan out to
//   movements           how to find the inventory_movements this doc produced
//   journals            { columns, jsonColumns } — GL journal id holders
//   detailGuard         'single' (guardWh) | 'both' (guardTransfer)
// ════════════════════════════════════════════════════════════════════════════

const V2_STATUS_MAP = {
  draft: 'draft', approved: 'approved', posted: 'posted', cancelled: 'cancelled', reversed: 'reversed',
};
const V2_STAMPS = [
  ['create', 'created_by', 'created_at'],
  ['approve', 'approved_by', 'approved_at'],
  ['post', 'posted_by', 'posted_at'],
  ['cancel', 'cancelled_by', 'cancelled_at'],
  ['reverse', 'reversed_by', 'reversed_at'],
];

const SOURCES = [
  {
    documentType: 'receipt',
    labelAr: 'إذن استلام مخزني',
    table: 'inv_receipts',
    pk: 'id',
    numberColumn: 'receipt_number',
    numberFallbackToPk: false,
    dateColumn: 'receipt_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: V2_STATUS_MAP,
    // A v2 receipt is stock IN with NO supplier: its logical "source" is the
    // credited counter GL account, its destination is the warehouse.
    source: { kind: 'gl_account', idColumn: 'counter_account_code' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['source_ref'],
    lines: { table: 'inv_receipt_items', fk: 'receipt_id', qtyExpr: 'li.qty', nameColumn: 'item_name' },
    value: { netColumn: 'total_value', vatColumn: null, grossColumn: 'total_value', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: V2_STAMPS,
    timeline: { kind: 'inv_tx_events', docType: 'receipt' },
    movements: { refTypes: ['inv_receipt', 'inv_receipt_reverse'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id', 'reverse_gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'issue',
    labelAr: 'إذن صرف مخزني',
    table: 'inv_issues',
    pk: 'id',
    numberColumn: 'issue_number',
    numberFallbackToPk: false,
    dateColumn: 'issue_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: V2_STATUS_MAP,
    // Mirror image of the receipt: warehouse OUT → expense account.
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'expense', idColumn: 'expense_account_code' },
    partyLabelColumns: ['recipient'],
    lines: { table: 'inv_issue_items', fk: 'issue_id', qtyExpr: 'li.qty', nameColumn: 'item_name' },
    value: { netColumn: 'total_value', vatColumn: null, grossColumn: 'total_value', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: V2_STAMPS,
    timeline: { kind: 'inv_tx_events', docType: 'issue' },
    movements: { refTypes: ['inv_issue', 'inv_issue_reverse'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id', 'reverse_gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'adjustment',
    labelAr: 'تسوية مخزنية',
    table: 'inv_adjustments',
    pk: 'id',
    numberColumn: 'adjustment_number',
    numberFallbackToPk: false,
    dateColumn: 'adjustment_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: V2_STATUS_MAP,
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['reason'],
    // `delta` is SIGNED (+ recount up / − recount down); the operations list
    // shows MAGNITUDE moved, so ABS. The VALUE stays signed (see value.signed).
    lines: { table: 'inv_adjustment_items', fk: 'adjustment_id', qtyExpr: 'ABS(li.delta)', nameColumn: 'item_name' },
    value: { netColumn: 'total_value', vatColumn: null, grossColumn: 'total_value', signed: true },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: V2_STAMPS,
    timeline: { kind: 'inv_tx_events', docType: 'adjustment' },
    movements: { refTypes: ['inv_adjustment', 'inv_adjustment_reverse'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id', 'reverse_gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'stocktake',
    labelAr: 'جرد مخزني',
    table: 'inv_stocktakes',
    pk: 'id',
    numberColumn: 'stocktake_number',
    numberFallbackToPk: false,
    dateColumn: 'stocktake_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    // Sixth vocabulary: counting is genuinely "work in progress"; submitted is
    // the only source in the system with an explicit await-approval state.
    statusMap: {
      draft: 'draft', counting: 'in_progress', submitted: 'pending_approval',
      approved: 'approved', posted: 'posted', cancelled: 'cancelled',
    },
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['reason'],
    lines: { table: 'inv_stocktake_items', fk: 'stocktake_id', qtyExpr: 'ABS(li.variance)', nameColumn: 'item_name' },
    value: { netColumn: 'total_variance_value', vatColumn: null, grossColumn: 'total_variance_value', signed: true },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['submit', 'submitted_by', 'submitted_at'],
      ['request-recount', 'recount_by', 'recount_at'],
      ['approve', 'approved_by', 'approved_at'],
      ['post', 'posted_by', 'posted_at'],
      ['cancel', 'cancelled_by', 'cancelled_at'],
    ],
    timeline: { kind: 'inv_tx_events', docType: 'stocktake' },
    // A stocktake never writes stock itself — posting MATERIALIZES an
    // inv_adjustments document, so its ledger rows carry that document's id.
    movements: { refTypes: ['inv_adjustment', 'inv_adjustment_reverse'], refFrom: 'adjustment_id' },
    journals: { columns: ['gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'transfer',
    labelAr: 'تحويل مخزني',
    table: 'stock_issues',
    pk: 'id',
    numberColumn: 'issue_number',
    numberFallbackToPk: true, // NOT NULL but carries no UNIQUE key — be defensive
    dateColumn: 'issue_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: {
      draft: 'draft', approved: 'approved', issued: 'in_progress',
      partially_received: 'partially_completed', received: 'completed',
      cancelled: 'cancelled', reversed: 'reversed',
    },
    source: { kind: 'warehouse', idColumn: 'from_warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'to_warehouse_id' },
    partyLabelColumns: [],
    // qty_requested / qty_issued / qty_received are three different truths.
    // The operations list reports what LEFT the source warehouse (qty_issued) —
    // that is the number the ledger and the GL agree with.
    lines: { table: 'stock_issue_items', fk: 'issue_id', qtyExpr: 'li.qty_issued', joinItems: true },
    value: { netColumn: 'total_cost', vatColumn: null, grossColumn: 'total_cost', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['from_warehouse_id', 'to_warehouse_id'],
    warehouseColumns: ['from_warehouse_id', 'to_warehouse_id'],
    extraWhere: null,
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['approve', 'approved_by', 'approved_at'],
      ['issue', 'issued_by', 'issued_at'],
      ['receive', 'received_by', 'received_at'],
      ['reverse', 'reversed_by', 'reversed_at'],
    ],
    timeline: { kind: 'stock_issue_events', docType: null },
    movements: { refTypes: ['transfer', 'transfer_reverse'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id', 'reverse_gl_journal_id'], jsonColumns: [] },
    // Parity with routes/warehouse-transfers.js:148 — the LIST shows a transfer
    // when EITHER end is in scope, the DETAIL requires BOTH.
    detailGuard: 'both',
  },
  {
    documentType: 'production',
    labelAr: 'أمر إنتاج',
    table: 'production_orders',
    pk: 'id',
    numberColumn: 'order_number',
    numberFallbackToPk: false,
    // planned_date is the only DATE on this table; released_at/completed_at are
    // DATETIME event stamps, so the list/sort date is the planned date.
    dateColumn: 'planned_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    // `closed` is the GL-final state (gl_close_id flushes WIP) → posted.
    statusMap: {
      draft: 'draft', approved: 'approved', in_progress: 'in_progress',
      completed: 'completed', closed: 'posted', cancelled: 'cancelled', reversed: 'reversed',
    },
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'output_warehouse_id' },
    partyLabelColumns: [],
    lines: { table: 'production_consumption', fk: 'production_order_id', qtyExpr: 'li.qty_actual', joinItems: true },
    quantityHeaderColumn: 'qty_produced',
    value: { netColumn: 'total_cost', vatColumn: null, grossColumn: 'total_cost', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    // FIXES routes/inventory-production.js:225, which scopes only on
    // warehouse_id even though create guards BOTH ends.
    scopeColumns: ['warehouse_id', 'output_warehouse_id'],
    warehouseColumns: ['warehouse_id', 'output_warehouse_id'],
    extraWhere: "t.source = 'v2'",
    productColumn: 'product_id',
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['approve', 'approved_by', 'approved_at'],
      ['release', 'released_by', 'released_at'],
      ['complete', 'completed_by', 'completed_at'],
      ['close', 'closed_by', 'closed_at'],
      ['cancel', 'cancelled_by', 'cancelled_at'],
      ['reverse', 'reversed_by', 'reversed_at'],
    ],
    timeline: { kind: 'inv_tx_events', docType: 'production' },
    // Production movements reference the ISSUE/OUTPUT EVENT id, not the order.
    movements: {
      refTypes: ['prod_issue', 'prod_output', 'prod_issue_reverse', 'prod_output_reverse'],
      refFrom: 'production_events',
      docRefTypes: ['production', 'production_reverse'],
    },
    journals: { columns: ['gl_release_id', 'gl_complete_id', 'gl_close_id'], jsonColumns: ['reverse_gl_ids'] },
    detailGuard: 'single',
  },
  {
    documentType: 'production_legacy',
    labelAr: 'أمر إنتاج (قديم)',
    table: 'production_orders',
    pk: 'id',
    numberColumn: 'order_number',
    numberFallbackToPk: false,
    dateColumn: 'planned_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    // Legacy writers only ever produce planned/released; the remaining values
    // are mapped anyway because `source` defaults to 'legacy', so a V2 writer
    // that forgets to set it lands here (server.js:5921 GAP).
    statusMap: {
      planned: 'draft', released: 'in_progress', in_progress: 'in_progress',
      completed: 'completed', closed: 'posted', cancelled: 'cancelled',
      draft: 'draft', approved: 'approved', reversed: 'reversed',
    },
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'output_warehouse_id' },
    partyLabelColumns: [],
    lines: { table: 'production_consumption', fk: 'production_order_id', qtyExpr: 'li.qty_actual', joinItems: true },
    quantityHeaderColumn: 'qty_produced',
    value: { netColumn: 'total_cost', vatColumn: null, grossColumn: 'total_cost', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id', 'output_warehouse_id'],
    warehouseColumns: ['warehouse_id', 'output_warehouse_id'],
    extraWhere: "t.source <> 'v2'",
    productColumn: 'product_id',
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['release', 'released_by', 'released_at'],
      ['complete', 'completed_by', 'completed_at'],
    ],
    timeline: { kind: null, docType: null }, // legacy production writes no events
    movements: {
      refTypes: ['prod_issue', 'prod_output', 'prod_issue_reverse', 'prod_output_reverse'],
      refFrom: 'production_events',
      docRefTypes: ['production', 'production_reverse'],
    },
    journals: { columns: ['gl_release_id', 'gl_complete_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'purchase_receipt',
    labelAr: 'استلام مشتريات',
    table: 'purchase_receipts',
    pk: 'id',
    numberColumn: 'receipt_number',
    numberFallbackToPk: true, // UNIQUE but NULLABLE in the base DDL
    dateColumn: 'receipt_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: {
      draft: 'draft', approved: 'approved', posted: 'posted',
      reversed: 'reversed', cancelled: 'cancelled',
    },
    source: { kind: 'supplier', idColumn: 'supplier_id' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['supplier_name_snapshot'],
    lines: { table: 'purchase_receipt_lines', fk: 'receipt_id', qtyExpr: 'li.quantity', joinItems: true },
    // Procurement money is VAT-INCLUSIVE in `total`; the operations list reports
    // the NET (subtotal) like every other document and exposes VAT separately.
    value: { netColumn: 'subtotal', vatColumn: 'vat_amount', grossColumn: 'total', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: 'procurement.view',
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['approve', 'approved_by', 'approved_at'],
      ['post', 'posted_by', 'posted_at'],
      ['reverse', 'reversed_by', 'reversed_at'],
      ['cancel', 'cancelled_by', 'cancelled_at'],
    ],
    timeline: { kind: 'procurement_events', docType: 'grn' },
    movements: { refTypes: ['GoodsReceipt', 'GoodsReceiptReversal'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'purchase_return',
    labelAr: 'مرتجع مشتريات',
    table: 'purchase_returns',
    pk: 'id',
    numberColumn: 'return_number',
    numberFallbackToPk: true,
    dateColumn: 'return_date',
    dateIsDatetime: false,
    statusColumn: 'status',
    statusMap: {
      draft: 'draft', approved: 'approved', posted: 'posted',
      settled: 'completed', cancelled: 'cancelled',
    },
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'supplier', idColumn: 'supplier_id' },
    partyLabelColumns: ['supplier_name_snapshot'],
    lines: { table: 'purchase_return_lines', fk: 'return_id', qtyExpr: 'li.base_qty', nameColumn: 'item_name_snapshot' },
    value: { netColumn: 'subtotal', vatColumn: 'vat_amount', grossColumn: 'total', signed: false },
    createdByColumn: 'created_by',
    approvedByColumn: 'approved_by',
    capability: 'procurement.view',
    // warehouse_id is NULLABLE here, so a scoped user will NOT see returns with
    // no warehouse. That is deliberate (fail-closed) and TIGHTER than
    // routes/procurement/returns.js:81, which applies no scope at all.
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: [
      ['create', 'created_by', 'created_at'],
      ['approve', 'approved_by', 'approved_at'],
      ['post', 'posted_by', 'posted_at'],
    ],
    timeline: { kind: 'procurement_events', docType: 'return' },
    movements: { refTypes: ['PurchaseReturn'], refFrom: 'pk' },
    journals: { columns: ['gl_journal_id'], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'purchase_legacy',
    labelAr: 'مشتريات (قديم)',
    table: 'purchases',
    pk: 'id',
    numberColumn: null, // db/schema.sql:316 — no document-number column at all
    numberFallbackToPk: false,
    dateColumn: 'purchase_date',
    dateIsDatetime: true,
    statusColumn: 'status',
    // 'received' means stock moved AND the cost hit the books → posted.
    statusMap: { draft: 'draft', received: 'posted' },
    source: { kind: 'supplier', idColumn: 'supplier_id' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['supplier_name'],
    // Lines live in a TEXT `items_json` blob — there is no line table, so
    // lineCount/totalQuantity are resolved by parsing the JSON in JS (the SQL
    // path emits NULL rather than a fabricated zero).
    lines: null,
    itemsJsonColumn: 'items_json',
    value: { netColumn: 'total_price', vatColumn: null, grossColumn: 'total_price', signed: false },
    createdByColumn: 'username', // NOT created_by
    approvedByColumn: null,      // receive_approved_by approves the RECEIPT, not the purchase
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: 't.deleted_at IS NULL', // soft-deleted purchases are not documents
    actorStamps: [['create', 'username', 'created_at']],
    timeline: { kind: null, docType: null },
    // routes/purchases.js:337 writes movements with NO reference_type/id — the
    // ONLY link is the notes marker, which the revert path also relies on (:528).
    movements: { refTypes: [], refFrom: 'notes_marker', notesPrefix: 'PUR: ' },
    journals: { columns: [], jsonColumns: [] },
    detailGuard: 'single',
  },
  {
    documentType: 'adjustment_legacy',
    labelAr: 'تعديل كمية (قديم)',
    table: 'stock_adjustments',
    pk: 'id',
    // server.js:4781 DOES add adjustment_number — but it is NULL on every row
    // created before that migration, hence the PK fallback.
    numberColumn: 'adjustment_number',
    numberFallbackToPk: true,
    dateColumn: 'adjustment_date',
    dateIsDatetime: true,
    statusColumn: 'status',
    // Only two states. `approved` is where stock is deducted AND the GL journal
    // is posted (routes/inventory.js:4086-4110) → posted, not merely approved.
    statusMap: { pending: 'pending_approval', approved: 'posted' },
    source: { kind: 'warehouse', idColumn: 'warehouse_id' },
    destination: { kind: 'warehouse', idColumn: 'warehouse_id' },
    partyLabelColumns: ['reason'],
    // The ONE line table whose item FK is not `item_id` (server.js:1566).
    lines: { table: 'stock_adjustment_items', fk: 'adjustment_id', qtyExpr: 'li.qty', nameColumn: 'inv_item_name', itemIdColumn: 'inv_item_id' },
    value: { netColumn: 'total_cost', vatColumn: null, grossColumn: 'total_cost', signed: false },
    createdByColumn: 'username', // NOT created_by
    approvedByColumn: 'approved_by',
    capability: null,
    scopeColumns: ['warehouse_id'],
    warehouseColumns: ['warehouse_id'],
    extraWhere: null,
    actorStamps: [
      ['create', 'username', 'created_at'],
      ['approve', 'approved_by', 'approved_at'],
    ],
    timeline: { kind: null, docType: null },
    movements: { refTypes: ['adjustment'], refFrom: 'pk' },
    journals: { columns: [], jsonColumns: [] },
    detailGuard: 'single',
  },
];

const DOCUMENT_TYPES = SOURCES.map((s) => s.documentType);
const _BY_TYPE = Object.create(null);
SOURCES.forEach((s) => { _BY_TYPE[s.documentType] = s; });

function sourceFor(documentType) {
  return _BY_TYPE[String(documentType == null ? '' : documentType)] || null;
}

// Every physical table the union may touch (used to probe availability — the
// procurement tables only exist when PROCUREMENT_P2P_ENABLE has ever run).
function allTables() {
  const seen = Object.create(null);
  const out = [];
  SOURCES.forEach((s) => {
    [s.table, s.lines && s.lines.table].forEach((tbl) => {
      if (tbl && !seen[tbl]) { seen[tbl] = true; out.push(tbl); }
    });
  });
  return out;
}

// The distinct capability ids the endpoint must resolve for the caller.
function capabilitiesRequired() {
  const seen = Object.create(null);
  const out = [];
  SOURCES.forEach((s) => {
    if (s.capability && !seen[s.capability]) { seen[s.capability] = true; out.push(s.capability); }
  });
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// canonicalStatus — the JS half of the mapping the SQL CASE mirrors exactly.
// Returns null for an unknown document type (a programming error, not data).
// An unrecognized raw status falls back to 'draft': every statusMap above
// covers the FULL enum domain of its column, so this branch is unreachable
// unless the enum is widened without updating the descriptor.
// ════════════════════════════════════════════════════════════════════════════
function canonicalStatus(documentType, rawStatus) {
  const s = sourceFor(documentType);
  if (!s) return null;
  const key = String(rawStatus == null ? '' : rawStatus).toLowerCase();
  return Object.prototype.hasOwnProperty.call(s.statusMap, key) ? s.statusMap[key] : 'draft';
}

// Reverse lookup: which RAW statuses of this source map onto the requested
// canonical set. Empty ⇒ the branch cannot possibly match ⇒ drop it.
function rawStatusesFor(source, canonicalList) {
  const want = Object.create(null);
  (canonicalList || []).forEach((c) => { want[String(c)] = true; });
  return Object.keys(source.statusMap).filter((raw) => want[source.statusMap[raw]]);
}

// ── SQL expression builders (descriptor-driven; never caller-driven) ─────────
function _numberExpr(s) {
  if (!s.numberColumn) return _t(s.pk);
  if (s.numberFallbackToPk) return 'COALESCE(' + _t(s.numberColumn) + ', ' + _t(s.pk) + ')';
  return _t(s.numberColumn);
}
function _dateExpr(s) {
  return s.dateIsDatetime ? 'DATE(' + _t(s.dateColumn) + ')' : _t(s.dateColumn);
}
function _statusCaseExpr(s) {
  const whens = Object.keys(s.statusMap)
    .map((raw) => 'WHEN ' + _lit(raw) + ' THEN ' + _lit(s.statusMap[raw]))
    .join(' ');
  return 'CASE ' + _t(s.statusColumn) + ' ' + whens + ' ELSE ' + _lit('draft') + ' END';
}
function _coalesceCols(cols) {
  const list = (cols || []).filter(Boolean);
  if (!list.length) return 'NULL';
  if (list.length === 1) return _t(list[0]);
  return 'COALESCE(' + list.map(_t).join(', ') + ')';
}
function _lineCountExpr(s) {
  if (!s.lines) return 'NULL';
  return '(SELECT COUNT(*) FROM ' + ident(s.lines.table) + ' li WHERE li.' + ident(s.lines.fk) + ' = ' + _t(s.pk) + ')';
}
function _quantityExpr(s) {
  if (s.quantityHeaderColumn) return _t(s.quantityHeaderColumn);
  if (!s.lines) return 'NULL';
  return '(SELECT COALESCE(SUM(' + s.lines.qtyExpr + '), 0) FROM ' + ident(s.lines.table) +
         ' li WHERE li.' + ident(s.lines.fk) + ' = ' + _t(s.pk) + ')';
}

// ════════════════════════════════════════════════════════════════════════════
// buildUnionSql(sources, opts) → { sql, params, includedTypes, excludedTypes }
//
// `sql` is the INNER union only (no ORDER BY / LIMIT) so the caller can wrap it
// once for the page, once for COUNT(*) and once for the per-type tab counts
// without rebuilding the filters (and without them drifting apart).
//
// opts:
//   types[]        restrict to these document types ([] = all)
//   statuses[]     canonical statuses ([] = all)
//   warehouseId    explicit warehouse filter (branches with no warehouse column
//                  are dropped — they cannot satisfy it)
//   dateFrom/To    'YYYY-MM-DD'
//   search         substring of the document number
//   hasCapability  (capId) => boolean — per-branch visibility, NOT one gate
//   isAvailable    (tableName) => boolean — drop branches whose table is absent
//   scopeFor       (qualifiedColumn) => { sql, params } — req.whScopeClause
//   includeAggregates  also project lineCount/totalQuantity (correlated
//                  subqueries: only for small result sets / exports)
// ════════════════════════════════════════════════════════════════════════════
function buildUnionSql(sources, opts) {
  const list = Array.isArray(sources) && sources.length ? sources : SOURCES;
  const o = opts || {};
  const wantTypes = Array.isArray(o.types) && o.types.length ? o.types.map(String) : null;
  const wantStatuses = Array.isArray(o.statuses) && o.statuses.length ? o.statuses.map(String) : null;
  const hasCap = typeof o.hasCapability === 'function' ? o.hasCapability : function () { return true; };
  const isAvail = typeof o.isAvailable === 'function' ? o.isAvailable : function () { return true; };
  const scopeFor = typeof o.scopeFor === 'function' ? o.scopeFor : function () { return { sql: '', params: [] }; };

  const branches = [];
  const params = [];
  const includedTypes = [];
  const excludedTypes = [];

  list.forEach((s) => {
    if (wantTypes && wantTypes.indexOf(s.documentType) === -1) {
      excludedTypes.push({ documentType: s.documentType, reason: 'not_requested' });
      return;
    }
    // Per-branch capability — a user without procurement.view simply does not
    // get a procurement branch in the union. No 403, no leak, no escalation.
    if (s.capability && !hasCap(s.capability)) {
      excludedTypes.push({ documentType: s.documentType, reason: 'capability' });
      return;
    }
    if (!isAvail(s.table) || (s.lines && !isAvail(s.lines.table))) {
      excludedTypes.push({ documentType: s.documentType, reason: 'unavailable' });
      return;
    }
    let rawStatuses = null;
    if (wantStatuses) {
      rawStatuses = rawStatusesFor(s, wantStatuses);
      if (!rawStatuses.length) {
        excludedTypes.push({ documentType: s.documentType, reason: 'status_filter' });
        return;
      }
    }
    if (o.warehouseId && !(s.warehouseColumns || []).length) {
      excludedTypes.push({ documentType: s.documentType, reason: 'warehouse_filter' });
      return;
    }

    const where = [];
    // NOTE: params MUST be pushed in the same order the placeholders appear.
    if (s.extraWhere) where.push('(' + s.extraWhere + ')');
    if (rawStatuses) {
      where.push(_t(s.statusColumn) + ' IN (' + rawStatuses.map(function () { return '?'; }).join(',') + ')');
      rawStatuses.forEach((r) => params.push(r));
    }
    if (o.warehouseId) {
      const cols = s.warehouseColumns;
      where.push('(' + cols.map((c) => _t(c) + ' = ?').join(' OR ') + ')');
      cols.forEach(() => params.push(String(o.warehouseId)));
    }
    if (o.dateFrom) { where.push(_dateExpr(s) + ' >= ?'); params.push(String(o.dateFrom)); }
    if (o.dateTo) { where.push(_dateExpr(s) + ' <= ?'); params.push(String(o.dateTo)); }
    if (o.search) { where.push(_numberExpr(s) + ' LIKE ?'); params.push('%' + String(o.search) + '%'); }

    // Warehouse scope: OR-ed across every scope column so a two-sided document
    // is visible when EITHER end is in the caller's set (matching
    // routes/warehouse-transfers.js:30-37). Branches with no scope column get
    // no clause at all — never one global clause.
    const scopeParts = [];
    (s.scopeColumns || []).forEach((col) => {
      const sc = scopeFor(_t(col)) || { sql: '', params: [] };
      if (sc.sql) {
        scopeParts.push('(' + String(sc.sql).replace(/^\s*AND\s+/i, '') + ')');
        (sc.params || []).forEach((p) => params.push(p));
      }
    });
    if (scopeParts.length) where.push('(' + scopeParts.join(' OR ') + ')');

    const value = s.value || {};
    const cols = [
      // The composite surrogate: ids are only prefix-conventional and nothing
      // enforces uniqueness ACROSS tables, so (type, id) is the only real key.
      'CONCAT(' + _lit(s.documentType) + ", ':', " + _t(s.pk) + ') AS `id`',
      _lit(s.documentType) + ' AS `documentType`',
      'CAST(' + _t(s.pk) + ' AS CHAR(60)) AS `documentId`',
      'CAST(' + _numberExpr(s) + ' AS CHAR(60)) AS `documentNumber`',
      _dateExpr(s) + ' AS `date`',
      _statusCaseExpr(s) + ' AS `status`',
      'CAST(' + _t(s.statusColumn) + ' AS CHAR(40)) AS `rawStatus`',
      _lit(s.source.kind) + ' AS `sourceKind`',
      'CAST(' + (s.source.idColumn ? _t(s.source.idColumn) : 'NULL') + ' AS CHAR(60)) AS `sourceId`',
      _lit(s.destination.kind) + ' AS `destinationKind`',
      'CAST(' + (s.destination.idColumn ? _t(s.destination.idColumn) : 'NULL') + ' AS CHAR(60)) AS `destinationId`',
      'CAST(' + _coalesceCols(s.partyLabelColumns) + ' AS CHAR(200)) AS `partyLabel`',
      'CAST(' + (value.netColumn ? _t(value.netColumn) : 'NULL') + ' AS DECIMAL(20,6)) AS `totalValue`',
      'CAST(' + (value.vatColumn ? _t(value.vatColumn) : 'NULL') + ' AS DECIMAL(20,6)) AS `vatAmount`',
      'CAST(' + (value.grossColumn ? _t(value.grossColumn) : 'NULL') + ' AS DECIMAL(20,6)) AS `grossValue`',
      (value.signed ? '1' : '0') + ' AS `valueSigned`',
      'CAST(' + (s.createdByColumn ? _t(s.createdByColumn) : 'NULL') + ' AS CHAR(100)) AS `createdBy`',
      'CAST(' + (s.approvedByColumn ? _t(s.approvedByColumn) : 'NULL') + ' AS CHAR(100)) AS `approvedBy`',
      _t('created_at') + ' AS `createdAt`',
    ];
    if (o.includeAggregates) {
      cols.push('CAST(' + _lineCountExpr(s) + ' AS SIGNED) AS `lineCount`');
      cols.push('CAST(' + _quantityExpr(s) + ' AS DECIMAL(20,6)) AS `totalQuantity`');
    }

    branches.push('SELECT ' + cols.join(', ') + ' FROM ' + ident(s.table) + ' t' +
      (where.length ? ' WHERE ' + where.join(' AND ') : ''));
    includedTypes.push(s.documentType);
  });

  return { sql: branches.join(' UNION ALL '), params, includedTypes, excludedTypes };
}

// Wrap the inner union for a page. `sort` MUST already be an allow-listed key.
function pageSql(innerSql, sort, dir) {
  const col = SORTABLE[String(sort)] || SORTABLE[DEFAULT_SORT];
  const d = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  // `id` is the deterministic tiebreaker — without it, rows with an identical
  // sort key can repeat/vanish across pages.
  return 'SELECT u.* FROM (' + innerSql + ') u ORDER BY u.`' + col + '` ' + d + ', u.`id` ASC LIMIT ? OFFSET ?';
}
function countSql(innerSql) {
  return 'SELECT COUNT(*) AS total FROM (' + innerSql + ') u';
}
function countsByTypeSql(innerSql) {
  return 'SELECT u.`documentType` AS documentType, COUNT(*) AS n FROM (' + innerSql + ') u GROUP BY u.`documentType`';
}

// ════════════════════════════════════════════════════════════════════════════
// parseOperationsQuery — normalize + clamp + allow-list. Anything the caller
// got wrong is reported in `invalid` so the route can answer 422 instead of
// silently returning a different result set than the one that was asked for.
// ════════════════════════════════════════════════════════════════════════════
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function _intOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function _csv(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  const seen = Object.create(null);
  arr.forEach((x) => {
    const s = String(x).trim();
    if (s && !seen[s]) { seen[s] = true; out.push(s); }
  });
  return out;
}

function parseOperationsQuery(query) {
  const q = query || {};
  const invalid = { types: [], statuses: [], dateFrom: null, dateTo: null };

  let page = _intOr(q.page, 1);
  if (page < 1) page = 1;
  let pageSize = _intOr(q.pageSize, DEFAULT_PAGE_SIZE);
  if (pageSize < 1) pageSize = 1;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  const types = [];
  _csv(q.type != null ? q.type : q.types).forEach((t) => {
    if (_BY_TYPE[t]) types.push(t); else invalid.types.push(t);
  });

  const statuses = [];
  _csv(q.status != null ? q.status : q.statuses).forEach((s) => {
    if (CANONICAL_STATUSES.indexOf(s) !== -1) statuses.push(s); else invalid.statuses.push(s);
  });

  let dateFrom = '';
  if (q.dateFrom != null && String(q.dateFrom).trim() !== '') {
    const v = String(q.dateFrom).trim();
    if (DATE_RE.test(v)) dateFrom = v; else invalid.dateFrom = v;
  }
  let dateTo = '';
  if (q.dateTo != null && String(q.dateTo).trim() !== '') {
    const v = String(q.dateTo).trim();
    if (DATE_RE.test(v)) dateTo = v; else invalid.dateTo = v;
  }

  // A non-allow-listed sort silently falls back to the default — the same
  // behavior as lib/inventoryTxContract.parseListQuery, and the reason a raw
  // column name can never reach the ORDER BY.
  const sortRaw = q.sort != null ? String(q.sort) : '';
  const sort = Object.prototype.hasOwnProperty.call(SORTABLE, sortRaw) ? sortRaw : DEFAULT_SORT;
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const search = String(q.q != null ? q.q : (q.search != null ? q.search : '')).trim().slice(0, 120);

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search,
    types,
    statuses,
    warehouseId: q.warehouseId ? String(q.warehouseId) : '',
    dateFrom,
    dateTo,
    sort,
    dir,
    invalid,
    hasInvalid: !!(invalid.types.length || invalid.statuses.length || invalid.dateFrom || invalid.dateTo),
  };
}

// Compose the display summary for a document's products: the biggest line plus
// a count of the rest. Pure so the route and the tests agree.
function productSummary(firstName, lineCount) {
  const n = Number(lineCount) || 0;
  const name = firstName == null ? '' : String(firstName);
  if (!name) return n ? String(n) + ' أصناف' : '';
  return n > 1 ? name + ' (+' + (n - 1) + ')' : name;
}

module.exports = {
  CANONICAL_STATUSES,
  SORTABLE,
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  SOURCES,
  DOCUMENT_TYPES,
  sourceFor,
  allTables,
  capabilitiesRequired,
  canonicalStatus,
  rawStatusesFor,
  buildUnionSql,
  pageSql,
  countSql,
  countsByTypeSql,
  parseOperationsQuery,
  productSummary,
  ident,
};
