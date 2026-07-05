/**
 * schema.js — Procurement / P2P schema evolution (idempotent, additive-only).
 *
 * Evolves the EXISTING procurement tables (purchase_orders, po_lines,
 * purchase_receipts, purchase_receipt_lines, supplier_invoices,
 * supplier_invoice_lines, payment_records) and CREATES the genuinely-new
 * tables (supplier_invoice_matches, payment_allocations, purchase_returns,
 * purchase_return_lines, procurement_events). Reuses purchase_lots,
 * warehouse_stock, inv_items, units, doc_counters, gl_* untouched.
 *
 * NEVER drops a column or table. `suppliers.balance` is retained but abandoned
 * in favour of the derived view v_supplier_ap_balance.
 *
 * Money + quantity are DECIMAL. All ALTERs are guarded via information_schema
 * (MySQL 8 + MariaDB safe). Safe to re-run.
 */
'use strict';

const H = require('./ddlHelpers');

const MONEY = 'DECIMAL(18,4)';
const QTY = 'DECIMAL(18,4)';
const FACTOR = 'DECIMAL(18,6)';

async function apply(db, log = () => {}) {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. purchase_orders — lifecycle, version, snapshots, dimensions, idempotency
  // ─────────────────────────────────────────────────────────────────────────
  log('purchase_orders');
  await H.addColumn(db, 'purchase_orders', 'version', 'INT NOT NULL DEFAULT 1', log);
  await H.addColumn(db, 'purchase_orders', 'supplier_name_snapshot', 'VARCHAR(200) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'warehouse_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'cost_center_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'currency', "VARCHAR(8) NOT NULL DEFAULT 'SAR'", log);
  await H.addColumn(db, 'purchase_orders', 'discount_amount', `${MONEY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'purchase_orders', 'expected_date_snapshot', 'DATE NULL', log);
  await H.addColumn(db, 'purchase_orders', 'idempotency_key', 'VARCHAR(80) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'change_order_seq', 'INT NOT NULL DEFAULT 0', log);
  await H.addColumn(db, 'purchase_orders', 'submitted_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'submitted_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_orders', 'sent_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'sent_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_orders', 'closed_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'closed_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_orders', 'cancelled_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_orders', 'cancelled_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_orders', 'cancel_reason', 'VARCHAR(400) NULL', log);
  // widen status enum (keeps legacy values so old rows stay valid)
  await H.modifyColumn(db, 'purchase_orders', 'status',
    "ENUM('draft','submitted','approved','sent','partially_received','received','fully_received','closed','cancelled') NOT NULL DEFAULT 'draft'", log);
  await H.addIndex(db, 'purchase_orders', 'uq_po_idem', 'idempotency_key', { unique: true }, log);
  await H.addIndex(db, 'purchase_orders', 'idx_po_status_supplier', 'status, supplier_id, po_date', {}, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. po_lines — UoM snapshot, base qty, line lifecycle, nullable vat_rate
  // ─────────────────────────────────────────────────────────────────────────
  log('po_lines');
  await H.addColumn(db, 'po_lines', 'entered_qty', `${QTY} NULL`, log);
  await H.addColumn(db, 'po_lines', 'entered_unit_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'po_lines', 'entered_unit_code', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'po_lines', 'conversion_factor_snapshot', `${FACTOR} NOT NULL DEFAULT 1`, log);
  await H.addColumn(db, 'po_lines', 'base_qty', `${QTY} NULL`, log);
  await H.addColumn(db, 'po_lines', 'base_received_qty', `${QTY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'po_lines', 'unit_price_entered', `${MONEY} NULL`, log);
  await H.addColumn(db, 'po_lines', 'base_unit_price', `${FACTOR} NULL`, log);
  await H.addColumn(db, 'po_lines', 'tax_code', 'VARCHAR(10) NULL', log);
  await H.addColumn(db, 'po_lines', 'inclusive_tax', 'TINYINT(1) NOT NULL DEFAULT 0', log);
  await H.addColumn(db, 'po_lines', 'discount', `${MONEY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'po_lines', 'line_status',
    "ENUM('open','partially_received','received','closed','cancelled') NOT NULL DEFAULT 'open'", log);
  await H.modifyColumn(db, 'po_lines', 'vat_rate', 'DECIMAL(5,2) NULL', log);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. purchase_receipts — GRN lifecycle, GRNI journal, version, dims, idem
  // ─────────────────────────────────────────────────────────────────────────
  log('purchase_receipts');
  await H.addColumn(db, 'purchase_receipts', 'version', 'INT NOT NULL DEFAULT 1', log);
  await H.addColumn(db, 'purchase_receipts', 'receipt_seq', 'INT NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'supplier_name_snapshot', 'VARCHAR(200) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'brand_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'branch_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'cost_center_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'gl_journal_id', 'VARCHAR(60) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'reversal_of_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'idempotency_key', 'VARCHAR(80) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'notes', 'TEXT NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'approved_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'approved_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'posted_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'posted_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'reversed_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'reversed_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'cancelled_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'purchase_receipts', 'cancelled_at', 'DATETIME NULL', log);
  await H.modifyColumn(db, 'purchase_receipts', 'status',
    "ENUM('draft','approved','posted','reversed','cancelled') NOT NULL DEFAULT 'draft'", log);
  await H.addIndex(db, 'purchase_receipts', 'uq_grn_idem', 'idempotency_key', { unique: true }, log);
  await H.addIndex(db, 'purchase_receipts', 'idx_grn_po_status', 'po_id, status', {}, log);
  await H.addIndex(db, 'purchase_receipts', 'idx_grn_supplier_date', 'supplier_id, receipt_date', {}, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. purchase_receipt_lines — UoM snapshot, base cost, lot/expiry, wh
  // ─────────────────────────────────────────────────────────────────────────
  log('purchase_receipt_lines');
  await H.addColumn(db, 'purchase_receipt_lines', 'entered_qty', `${QTY} NULL`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'entered_unit_code', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipt_lines', 'conversion_factor_snapshot', `${FACTOR} NOT NULL DEFAULT 1`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'base_qty', `${QTY} NULL`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'base_unit_cost', `${FACTOR} NULL`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'base_returned_qty', `${QTY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'base_invoiced_qty', `${QTY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'purchase_receipt_lines', 'tax_code', 'VARCHAR(10) NULL', log);
  await H.addColumn(db, 'purchase_receipt_lines', 'warehouse_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'purchase_receipt_lines', 'lot_no', 'VARCHAR(80) NULL', log);
  await H.addColumn(db, 'purchase_receipt_lines', 'expiry_date', 'DATE NULL', log);
  await H.addColumn(db, 'purchase_receipt_lines', 'purchase_lot_id', 'INT NULL', log);
  await H.modifyColumn(db, 'purchase_receipt_lines', 'vat_rate', 'DECIMAL(5,2) NULL', log);
  await H.addIndex(db, 'purchase_receipt_lines', 'idx_grnl_po_line', 'po_line_id', {}, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 5. supplier_invoices — version, kind, actors, idempotency, matched amount
  // ─────────────────────────────────────────────────────────────────────────
  log('supplier_invoices');
  await H.addColumn(db, 'supplier_invoices', 'version', 'INT NOT NULL DEFAULT 1', log);
  await H.addColumn(db, 'supplier_invoices', 'invoice_kind',
    "ENUM('stock','non_stock') NOT NULL DEFAULT 'stock'", log);
  await H.addColumn(db, 'supplier_invoices', 'warehouse_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'matched_amount', `${MONEY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'supplier_invoices', 'idempotency_key', 'VARCHAR(80) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'submitted_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'submitted_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'approved_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'approved_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'posted_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'posted_at', 'DATETIME NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'cancelled_by', 'VARCHAR(100) NULL', log);
  await H.addColumn(db, 'supplier_invoices', 'cancelled_at', 'DATETIME NULL', log);
  await H.modifyColumn(db, 'supplier_invoices', 'status',
    "ENUM('draft','pending_review','pending_approval','approved','partially_paid','paid','overdue','closed','cancelled') NOT NULL DEFAULT 'draft'", log);
  await H.addIndex(db, 'supplier_invoices', 'uq_sinv_idem', 'idempotency_key', { unique: true }, log);
  // plain (non-unique) index first; a UNIQUE(supplier_id,invoice_no) is promoted
  // only after the backfill/dedup gate (see scripts/procurement/promote-constraints.js)
  await H.addIndex(db, 'supplier_invoices', 'idx_sinv_supplier_no', 'supplier_id, invoice_no', {}, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 6. supplier_invoice_lines — PO/GRN links, base qty/price, nullable vat_pct
  // ─────────────────────────────────────────────────────────────────────────
  log('supplier_invoice_lines');
  await H.addColumn(db, 'supplier_invoice_lines', 'po_line_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'supplier_invoice_lines', 'grn_line_id', 'VARCHAR(60) NULL', log);
  await H.addColumn(db, 'supplier_invoice_lines', 'base_qty', `${QTY} NULL`, log);
  await H.addColumn(db, 'supplier_invoice_lines', 'base_unit_price', `${FACTOR} NULL`, log);
  await H.addColumn(db, 'supplier_invoice_lines', 'tax_code', 'VARCHAR(10) NULL', log);
  await H.addColumn(db, 'supplier_invoice_lines', 'inclusive_tax', 'TINYINT(1) NOT NULL DEFAULT 0', log);
  await H.addColumn(db, 'supplier_invoice_lines', 'matched_qty', `${QTY} NOT NULL DEFAULT 0`, log);
  await H.modifyColumn(db, 'supplier_invoice_lines', 'vat_pct', 'DECIMAL(5,2) NULL', log);

  // ─────────────────────────────────────────────────────────────────────────
  // 7. payment_records — supplier link, version, idempotency (reuse header)
  // ─────────────────────────────────────────────────────────────────────────
  log('payment_records');
  await H.addColumn(db, 'payment_records', 'supplier_id', 'VARCHAR(50) NULL', log);
  await H.addColumn(db, 'payment_records', 'version', 'INT NOT NULL DEFAULT 1', log);
  await H.addColumn(db, 'payment_records', 'idempotency_key', 'VARCHAR(80) NULL', log);
  await H.addColumn(db, 'payment_records', 'allocated_amount', `${MONEY} NOT NULL DEFAULT 0`, log);
  await H.addColumn(db, 'payment_records', 'reversal_of_id', 'VARCHAR(60) NULL', log);
  await H.addIndex(db, 'payment_records', 'uq_pay_idem', 'idempotency_key', { unique: true }, log);
  await H.addIndex(db, 'payment_records', 'idx_pay_supplier', 'supplier_id, status', {}, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 8. NEW: supplier_invoice_matches (3-way match rows)
  // ─────────────────────────────────────────────────────────────────────────
  await H.createTable(db, 'supplier_invoice_matches', `
    CREATE TABLE supplier_invoice_matches (
      id VARCHAR(60) PRIMARY KEY,
      invoice_id VARCHAR(40) NOT NULL,
      invoice_line_id VARCHAR(40) NOT NULL,
      po_line_id VARCHAR(50) NULL,
      receipt_line_id VARCHAR(60) NULL,
      matched_qty ${QTY} NOT NULL DEFAULT 0,
      matched_amount ${MONEY} NOT NULL DEFAULT 0,
      price_variance ${MONEY} NOT NULL DEFAULT 0,
      qty_variance ${QTY} NOT NULL DEFAULT 0,
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sim_invoice (invoice_id),
      INDEX idx_sim_po_line (po_line_id),
      INDEX idx_sim_receipt_line (receipt_line_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 9. NEW: payment_allocations
  // ─────────────────────────────────────────────────────────────────────────
  await H.createTable(db, 'payment_allocations', `
    CREATE TABLE payment_allocations (
      id VARCHAR(60) PRIMARY KEY,
      payment_id VARCHAR(60) NOT NULL,
      supplier_invoice_id VARCHAR(40) NOT NULL,
      allocated_amount ${MONEY} NOT NULL,
      allocation_date DATE NOT NULL,
      actor VARCHAR(100) NULL,
      reversed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_alloc (payment_id, supplier_invoice_id),
      INDEX idx_alloc_invoice (supplier_invoice_id),
      INDEX idx_alloc_payment (payment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 10. NEW: purchase_returns + purchase_return_lines
  // ─────────────────────────────────────────────────────────────────────────
  await H.createTable(db, 'purchase_returns', `
    CREATE TABLE purchase_returns (
      id VARCHAR(50) PRIMARY KEY,
      return_number VARCHAR(30) UNIQUE,
      supplier_id VARCHAR(50) NULL,
      supplier_name_snapshot VARCHAR(200) NULL,
      receipt_id VARCHAR(50) NULL,
      invoice_id VARCHAR(40) NULL,
      return_date DATE NOT NULL,
      warehouse_id VARCHAR(50) NULL,
      brand_id VARCHAR(50) NULL,
      branch_id VARCHAR(50) NULL,
      cost_center_id VARCHAR(50) NULL,
      phase ENUM('before_invoice','after_invoice') NOT NULL,
      reason VARCHAR(400) NULL,
      subtotal ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      total ${MONEY} NOT NULL DEFAULT 0,
      status ENUM('draft','approved','posted','settled','cancelled') NOT NULL DEFAULT 'draft',
      version INT NOT NULL DEFAULT 1,
      gl_journal_id VARCHAR(60) NULL,
      credit_note_no VARCHAR(80) NULL,
      idempotency_key VARCHAR(80) NULL,
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_by VARCHAR(100) NULL,
      approved_at DATETIME NULL,
      posted_by VARCHAR(100) NULL,
      posted_at DATETIME NULL,
      UNIQUE KEY uq_ret_idem (idempotency_key),
      INDEX idx_ret_supplier (supplier_id),
      INDEX idx_ret_receipt (receipt_id),
      INDEX idx_ret_invoice (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, log);

  await H.createTable(db, 'purchase_return_lines', `
    CREATE TABLE purchase_return_lines (
      id VARCHAR(60) PRIMARY KEY,
      return_id VARCHAR(50) NOT NULL,
      receipt_line_id VARCHAR(60) NULL,
      invoice_line_id VARCHAR(40) NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name_snapshot VARCHAR(200) NULL,
      purchase_lot_id INT NULL,
      base_qty ${QTY} NOT NULL,
      base_unit_cost ${FACTOR} NOT NULL,
      vat_rate DECIMAL(5,2) NULL,
      tax_code VARCHAR(10) NULL,
      line_total ${MONEY} NOT NULL,
      INDEX idx_retl_return (return_id),
      INDEX idx_retl_lot (purchase_lot_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 11. NEW: procurement_events (domain audit + idempotency replay guard)
  // ─────────────────────────────────────────────────────────────────────────
  await H.createTable(db, 'procurement_events', `
    CREATE TABLE procurement_events (
      id VARCHAR(60) PRIMARY KEY,
      document_type ENUM('po','grn','supplier_invoice','payment','return') NOT NULL,
      document_id VARCHAR(60) NOT NULL,
      action VARCHAR(40) NOT NULL,
      from_status VARCHAR(30) NULL,
      to_status VARCHAR(30) NULL,
      actor VARCHAR(100) NULL,
      idempotency_key VARCHAR(80) NULL,
      payload JSON NULL,
      gl_journal_id VARCHAR(60) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pe_doc (document_type, document_id, created_at),
      INDEX idx_pe_action (action, created_at),
      UNIQUE KEY uq_pe_idem (document_type, idempotency_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, log);

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Derived supplier AP balance (single source of truth for balances)
  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: explicit COLLATE on every join predicate — the base tables carry a
  // mix of utf8mb4_unicode_ci / utf8mb4_general_ci id columns, and an un-forced
  // JOIN raises "Illegal mix of collations" on MySQL 8 / MariaDB.
  const C = 'COLLATE utf8mb4_unicode_ci';
  await H.run(db, `
    CREATE OR REPLACE VIEW v_supplier_ap_balance AS
    SELECT s.id AS supplier_id,
           s.name AS supplier_name,
           COALESCE(inv.total, 0)  AS invoiced_total,
           COALESCE(al.allocated, 0) AS paid_total,
           COALESCE(inv.total, 0) - COALESCE(al.allocated, 0) AS ap_balance
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_id, SUM(total_amount) AS total
          FROM supplier_invoices
         WHERE status NOT IN ('cancelled','draft')
         GROUP BY supplier_id
      ) inv ON inv.supplier_id ${C} = s.id ${C}
      LEFT JOIN (
        SELECT si.supplier_id, SUM(pa.allocated_amount) AS allocated
          FROM payment_allocations pa
          JOIN supplier_invoices si ON si.id ${C} = pa.supplier_invoice_id ${C}
         WHERE pa.reversed = 0
         GROUP BY si.supplier_id
      ) al ON al.supplier_id ${C} = s.id ${C}
  `, log, 'view v_supplier_ap_balance');

  return true;
}

module.exports = { apply };
