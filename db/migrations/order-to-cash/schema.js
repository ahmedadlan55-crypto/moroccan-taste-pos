/**
 * db/migrations/order-to-cash/schema.js — additive, idempotent Order-to-Cash
 * schema (spec §5). New tables only (never drops); the legacy `sales` /
 * `customer_invoices` / `credit_notes` / `cash_receipts` tables are untouched and
 * backfilled into `ar_documents` (the single AR source of truth). Every new table
 * is InnoDB / utf8mb4 / utf8mb4_unicode_ci (matches base tables → no "Illegal mix
 * of collations" on joins), DECIMAL money, version + idempotency_key for the
 * optimistic-concurrency / replay contract. Safe on empty / partial DBs + rerun.
 */
'use strict';

const H = require('./ddlHelpers');

const TBL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const ID = 'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
const MONEY = 'DECIMAL(14,2)';
const QTY = 'DECIMAL(16,4)';
const RATE = 'DECIMAL(18,6)';

async function apply(db, log = () => {}) {
  // ── 1. ar_documents — the single AR ledger (invoice | debit_note | credit_note)
  await H.createTable(db, 'ar_documents', `
    CREATE TABLE ar_documents (
      id ${ID} PRIMARY KEY,
      document_number VARCHAR(48) NOT NULL,
      document_type ENUM('invoice','debit_note','credit_note') NOT NULL DEFAULT 'invoice',
      source_type ENUM('pos','manual','contract','imported') NOT NULL DEFAULT 'manual',
      source_id ${ID} NULL,
      customer_id ${ID} NULL,
      customer_name VARCHAR(200) NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,
      warehouse_id ${ID} NULL,
      channel_id ${ID} NULL,
      issue_date DATE NOT NULL,
      due_date DATE NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'SAR',
      subtotal ${MONEY} NOT NULL DEFAULT 0,
      discount_amount ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      total_amount ${MONEY} NOT NULL DEFAULT 0,
      paid_amount ${MONEY} NOT NULL DEFAULT 0,
      balance_amount ${MONEY} NOT NULL DEFAULT 0,
      status ENUM('draft','issued','partially_paid','paid','credited','closed','cancelled') NOT NULL DEFAULT 'draft',
      zatca_status ENUM('pending','submitted','accepted','rejected','not_required') NOT NULL DEFAULT 'pending',
      zatca_uuid VARCHAR(64) NULL,
      zatca_hash VARCHAR(128) NULL,
      gl_journal_id ${ID} NULL,
      original_document_id ${ID} NULL,
      version INT NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(120) NULL,
      notes VARCHAR(500) NULL,
      created_by VARCHAR(80) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      issued_by VARCHAR(80) NULL, issued_at DATETIME NULL,
      cancelled_by VARCHAR(80) NULL, cancelled_at DATETIME NULL,
      reversed_by VARCHAR(80) NULL, reversed_at DATETIME NULL,
      UNIQUE KEY uq_ar_source (source_type, source_id),
      UNIQUE KEY uq_ar_idem (idempotency_key),
      KEY ix_ar_customer (customer_id),
      KEY ix_ar_status (status),
      KEY ix_ar_due (due_date),
      KEY ix_ar_scope (brand_id, branch_id),
      KEY ix_ar_source_id (source_id),
      KEY ix_ar_type (document_type)
    ) ${TBL}`, log);

  // ── 2. ar_document_lines
  await H.createTable(db, 'ar_document_lines', `
    CREATE TABLE ar_document_lines (
      id ${ID} PRIMARY KEY,
      document_id ${ID} NOT NULL,
      source_line_id ${ID} NULL,
      item_id ${ID} NULL,
      menu_id ${ID} NULL,
      description VARCHAR(300) NULL,
      entered_unit_id ${ID} NULL,
      entered_unit_code VARCHAR(40) NULL,
      entered_qty ${QTY} NOT NULL DEFAULT 0,
      conversion_factor_snapshot ${RATE} NOT NULL DEFAULT 1,
      base_qty ${QTY} NOT NULL DEFAULT 0,
      unit_price ${RATE} NOT NULL DEFAULT 0,
      discount_amount ${MONEY} NOT NULL DEFAULT 0,
      vat_category ENUM('S','Z','E','O') NOT NULL DEFAULT 'S',
      vat_rate DECIMAL(6,3) NULL,
      net_amount ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      gross_amount ${MONEY} NOT NULL DEFAULT 0,
      revenue_account_id ${ID} NULL,
      revenue_account_code VARCHAR(40) NULL,
      warehouse_id ${ID} NULL,
      cost_snapshot ${MONEY} NOT NULL DEFAULT 0,
      lot_allocations_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_arl_doc (document_id),
      KEY ix_arl_item (item_id)
    ) ${TBL}`, log);

  // ── 3. customer_payments (receipts / collections) — the ONLY paid-amount writer
  await H.createTable(db, 'customer_payments', `
    CREATE TABLE customer_payments (
      id ${ID} PRIMARY KEY,
      payment_number VARCHAR(48) NOT NULL,
      customer_id ${ID} NULL,
      customer_name VARCHAR(200) NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,
      payment_date DATE NOT NULL,
      payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
      destination_type ENUM('cash','bank') NOT NULL DEFAULT 'cash',
      destination_id ${ID} NULL,
      amount ${MONEY} NOT NULL DEFAULT 0,
      allocated_amount ${MONEY} NOT NULL DEFAULT 0,
      unapplied_amount ${MONEY} NOT NULL DEFAULT 0,
      status ENUM('draft','approved','posted','reversed','cancelled') NOT NULL DEFAULT 'draft',
      journal_id ${ID} NULL,
      reversal_journal_id ${ID} NULL,
      is_advance TINYINT(1) NOT NULL DEFAULT 0,
      reference VARCHAR(120) NULL,
      notes VARCHAR(500) NULL,
      version INT NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(120) NULL,
      created_by VARCHAR(80) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by VARCHAR(80) NULL, approved_at DATETIME NULL,
      posted_by VARCHAR(80) NULL, posted_at DATETIME NULL,
      reversed_by VARCHAR(80) NULL, reversed_at DATETIME NULL,
      UNIQUE KEY uq_pay_idem (idempotency_key),
      KEY ix_pay_customer (customer_id),
      KEY ix_pay_status (status),
      KEY ix_pay_date (payment_date)
    ) ${TBL}`, log);

  // ── 4. ar_payment_allocations (NB: `payment_allocations` is already a
  //        procurement table with a different shape — O2C uses a distinct name)
  await H.createTable(db, 'ar_payment_allocations', `
    CREATE TABLE ar_payment_allocations (
      id ${ID} PRIMARY KEY,
      payment_id ${ID} NOT NULL,
      ar_document_id ${ID} NOT NULL,
      customer_id ${ID} NULL,
      allocated_amount ${MONEY} NOT NULL DEFAULT 0,
      reversed TINYINT(1) NOT NULL DEFAULT 0,
      created_by VARCHAR(80) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_alloc (payment_id, ar_document_id),
      KEY ix_alloc_payment (payment_id),
      KEY ix_alloc_doc (ar_document_id),
      KEY ix_alloc_customer (customer_id)
    ) ${TBL}`, log);

  // ── 5. sales_returns
  await H.createTable(db, 'sales_returns', `
    CREATE TABLE sales_returns (
      id ${ID} PRIMARY KEY,
      return_number VARCHAR(48) NOT NULL,
      original_sale_id ${ID} NULL,
      original_ar_document_id ${ID} NULL,
      customer_id ${ID} NULL,
      customer_name VARCHAR(200) NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,
      warehouse_id ${ID} NULL,
      return_date DATE NOT NULL,
      reason VARCHAR(300) NULL,
      reason_code VARCHAR(40) NULL,
      refund_method ENUM('cash','bank','ar_reduction','customer_deposit') NOT NULL DEFAULT 'ar_reduction',
      refund_destination_id ${ID} NULL,
      subtotal ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      total_amount ${MONEY} NOT NULL DEFAULT 0,
      cost_total ${MONEY} NOT NULL DEFAULT 0,
      status ENUM('draft','approved','posted','reversed','cancelled') NOT NULL DEFAULT 'draft',
      credit_note_id ${ID} NULL,
      journal_id ${ID} NULL,
      reversal_journal_id ${ID} NULL,
      version INT NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(120) NULL,
      created_by VARCHAR(80) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by VARCHAR(80) NULL, approved_at DATETIME NULL,
      posted_by VARCHAR(80) NULL, posted_at DATETIME NULL,
      reversed_by VARCHAR(80) NULL, reversed_at DATETIME NULL,
      UNIQUE KEY uq_ret_idem (idempotency_key),
      KEY ix_ret_sale (original_sale_id),
      KEY ix_ret_ar (original_ar_document_id),
      KEY ix_ret_customer (customer_id),
      KEY ix_ret_status (status)
    ) ${TBL}`, log);

  // ── 6. sales_return_lines
  await H.createTable(db, 'sales_return_lines', `
    CREATE TABLE sales_return_lines (
      id ${ID} PRIMARY KEY,
      return_id ${ID} NOT NULL,
      original_line_id ${ID} NULL,
      item_id ${ID} NULL,
      menu_id ${ID} NULL,
      description VARCHAR(300) NULL,
      sold_qty ${QTY} NOT NULL DEFAULT 0,
      previously_returned_qty ${QTY} NOT NULL DEFAULT 0,
      return_qty ${QTY} NOT NULL DEFAULT 0,
      entered_unit_id ${ID} NULL,
      entered_unit_code VARCHAR(40) NULL,
      conversion_factor_snapshot ${RATE} NOT NULL DEFAULT 1,
      base_qty ${QTY} NOT NULL DEFAULT 0,
      unit_price_snapshot ${RATE} NOT NULL DEFAULT 0,
      discount_snapshot ${MONEY} NOT NULL DEFAULT 0,
      vat_category ENUM('S','Z','E','O') NOT NULL DEFAULT 'S',
      vat_rate DECIMAL(6,3) NULL,
      net_amount ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      gross_amount ${MONEY} NOT NULL DEFAULT 0,
      cost_snapshot ${MONEY} NOT NULL DEFAULT 0,
      lot_allocations_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_retl_ret (return_id),
      KEY ix_retl_item (item_id)
    ) ${TBL}`, log);

  // ── 7. ar_events — domain log + idempotency (UNIQUE(entity_type, idempotency_key))
  await H.createTable(db, 'ar_events', `
    CREATE TABLE ar_events (
      id ${ID} PRIMARY KEY,
      entity_type VARCHAR(40) NOT NULL,
      entity_id ${ID} NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      from_status VARCHAR(40) NULL,
      to_status VARCHAR(40) NULL,
      actor_id ${ID} NULL,
      actor_username VARCHAR(80) NULL,
      idempotency_key VARCHAR(120) NULL,
      payload_json TEXT NULL,
      gl_journal_id ${ID} NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_are_idem (entity_type, idempotency_key),
      KEY ix_are_entity (entity_type, entity_id),
      KEY ix_are_created (created_at)
    ) ${TBL}`, log);

  // ── 8. customers evolve (additive only; balance stays but is abandoned for the derived view)
  if (await H.tableExists(db, 'customers')) {
    await H.addColumn(db, 'customers', 'name_en', 'VARCHAR(200) NULL', log);
    await H.addColumn(db, 'customers', 'vat_number', 'VARCHAR(30) NULL', log);
    await H.addColumn(db, 'customers', 'email', 'VARCHAR(160) NULL', log);
    await H.addColumn(db, 'customers', 'address', 'VARCHAR(300) NULL', log);
    await H.addColumn(db, 'customers', 'city', 'VARCHAR(80) NULL', log);
    await H.addColumn(db, 'customers', 'payment_terms', "VARCHAR(40) NOT NULL DEFAULT 'Cash'", log);
    await H.addColumn(db, 'customers', 'credit_days', 'INT NOT NULL DEFAULT 0', log);
    await H.addColumn(db, 'customers', 'brand_id', `${ID} NULL`, log);
    await H.addColumn(db, 'customers', 'merged_into_id', `${ID} NULL`, log);
    await H.addIndex(db, 'customers', 'ix_cust_vat', 'vat_number', {}, log);
    await H.addIndex(db, 'customers', 'ix_cust_merged', 'merged_into_id', {}, log);
  }

  // ── 9. derived AR balance view (customer.balance is NOT the source of truth)
  const C = 'COLLATE utf8mb4_unicode_ci';
  await H.run(db, `
    CREATE OR REPLACE VIEW v_customer_ar_balance AS
    SELECT c.id AS customer_id,
           c.name AS customer_name,
           COALESCE(inv.invoiced, 0)  AS invoiced_total,
           COALESCE(al.allocated, 0)  AS paid_total,
           COALESCE(inv.invoiced, 0) - COALESCE(al.allocated, 0) AS ar_balance
      FROM customers c
      LEFT JOIN (
        SELECT customer_id,
               SUM(CASE WHEN document_type='credit_note' THEN -total_amount ELSE total_amount END) AS invoiced
          FROM ar_documents
         WHERE status NOT IN ('cancelled','draft')
         GROUP BY customer_id
      ) inv ON inv.customer_id ${C} = c.id ${C}
      LEFT JOIN (
        SELECT pa.customer_id, SUM(pa.allocated_amount) AS allocated
          FROM ar_payment_allocations pa
         WHERE pa.reversed = 0
         GROUP BY pa.customer_id
      ) al ON al.customer_id ${C} = c.id ${C}
  `, log, 'view v_customer_ar_balance');

  return true;
}

module.exports = { apply };
