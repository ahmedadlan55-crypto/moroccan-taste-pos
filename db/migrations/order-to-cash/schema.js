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

  // ── 7b. sales_orders — the (optional) order stage before invoicing
  await H.createTable(db, 'sales_orders', `
    CREATE TABLE sales_orders (
      id ${ID} PRIMARY KEY,
      order_number VARCHAR(48) NOT NULL,
      customer_id ${ID} NULL,
      customer_name VARCHAR(200) NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,
      warehouse_id ${ID} NULL,
      channel_id ${ID} NULL,
      order_date DATE NOT NULL,
      expected_date DATE NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'SAR',
      subtotal ${MONEY} NOT NULL DEFAULT 0,
      discount_amount ${MONEY} NOT NULL DEFAULT 0,
      vat_amount ${MONEY} NOT NULL DEFAULT 0,
      total_amount ${MONEY} NOT NULL DEFAULT 0,
      is_credit_sale TINYINT(1) NOT NULL DEFAULT 0,
      invoice_id ${ID} NULL,
      status ENUM('draft','confirmed','fulfilled','invoiced','closed','cancelled') NOT NULL DEFAULT 'draft',
      version INT NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(120) NULL,
      notes VARCHAR(500) NULL,
      created_by VARCHAR(80) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_by VARCHAR(80) NULL, confirmed_at DATETIME NULL,
      fulfilled_by VARCHAR(80) NULL, fulfilled_at DATETIME NULL,
      cancelled_by VARCHAR(80) NULL, cancelled_at DATETIME NULL,
      UNIQUE KEY uq_so_idem (idempotency_key),
      KEY ix_so_customer (customer_id),
      KEY ix_so_status (status),
      KEY ix_so_date (order_date)
    ) ${TBL}`, log);

  // ── 7c. sales_order_lines
  await H.createTable(db, 'sales_order_lines', `
    CREATE TABLE sales_order_lines (
      id ${ID} PRIMARY KEY,
      order_id ${ID} NOT NULL,
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
      revenue_account_code VARCHAR(40) NULL,
      warehouse_id ${ID} NULL,
      cost_snapshot ${MONEY} NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_sol_order (order_id),
      KEY ix_sol_item (item_id)
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

  // ── 10. eager POS→O2C line projection (additive; ar_document_lines EXISTS)
  // These MUST be addColumn/addIndex, not edits to the CREATE TABLE above:
  // H.createTable returns early when the table exists and never diffs columns,
  // so a CREATE-block edit is a silent no-op on every non-empty database.
  if (await H.tableExists(db, 'ar_document_lines')) {
    // Which version of the allocation algorithm produced this row's snapshot.
    // Line-grained because the algorithm is per-line: a future repair needs to
    // tell a v1 row from a v2 one without re-deriving it.
    await H.addColumn(db, 'ar_document_lines', 'projection_version', 'SMALLINT NOT NULL DEFAULT 1', log);
    // The replay guard for the projection. NOTE: this protects nothing while
    // source_line_id is NULL — MySQL treats NULLs as distinct — so the
    // projection must always populate it. Every pre-existing row is NULL
    // (manual invoices, which the POS path never touches), and NULLs cannot
    // collide, so building this on an existing table is safe.
    await H.addIndex(db, 'ar_document_lines', 'uq_arl_doc_srcline', 'document_id, source_line_id', { unique: true }, log);
  }

  // Per-line inventory component snapshot. A POS menu line explodes into N
  // recipe deductions, so reversing it needs the ORIGINAL components — the
  // recipe itself may have been reformulated by the time a return is filed,
  // and re-reading it then would restock quantities that were never deducted.
  // Kept as queryable rows rather than following the ar_document_lines
  // .lot_allocations_json TEXT-blob convention, because the return path has to
  // aggregate cost and quantity per component.
  await H.createTable(db, 'ar_document_line_components', `
    CREATE TABLE ar_document_line_components (
      id ${ID} PRIMARY KEY,
      document_id ${ID} NOT NULL,
      document_line_id ${ID} NOT NULL,
      component_seq INT NOT NULL,
      source ENUM('recipe','semi','imported','combo') NOT NULL DEFAULT 'recipe',
      inv_item_id ${ID} NULL,
      inv_item_name VARCHAR(200) NULL,
      warehouse_id ${ID} NULL,
      deducted_base_qty ${QTY} NOT NULL DEFAULT 0,
      unit_code VARCHAR(32) NULL,
      conversion_factor ${RATE} NULL,
      unit_cost_snapshot ${RATE} NOT NULL DEFAULT 0,
      total_cost ${MONEY} NOT NULL DEFAULT 0,
      projection_version SMALLINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_arlc_line_seq (document_line_id, component_seq),
      KEY ix_arlc_doc (document_id),
      KEY ix_arlc_line (document_line_id),
      KEY ix_arlc_item (inv_item_id)
    ) ${TBL}`, log);

  // ── 11. per-line restock decision (additive; sales_return_lines EXISTS)
  // Same rule as §10: the CREATE TABLE at §6 is a no-op on every live database,
  // so these must be addColumn.
  if (await H.tableExists(db, 'ar_documents')) {
    // The stamped Phase-1 QR. ZatcaDocumentService returns one and no caller
    // could persist it — there was no column — so every printed O2C document
    // would have to re-derive it and hope the inputs still agree. The legacy
    // credit_notes table has carried this since day one; ar_documents is the
    // replacement and must not lose the field.
    await H.addColumn(db, 'ar_documents', 'zatca_qr_base64', 'TEXT NULL', log);
  }

  if (await H.tableExists(db, 'sales_return_lines')) {
    // Whether this line's goods physically come back. NOT derivable: a sealed
    // drink is restockable, the identical-priced burger beside it is not, and
    // only the person holding the item knows which. DEFAULT 0 because 0 is the
    // only value that preserves what the already-posted returns actually did —
    // SalesReturnService skipped every line (it tested a column that has never
    // existed), so no return has ever moved stock. Defaulting to 1 would
    // silently redefine those rows and restock spoiled food.
    await H.addColumn(db, 'sales_return_lines', 'restock', 'TINYINT(1) NOT NULL DEFAULT 0', log);
    // create() computed a warehouseId and then dropped it on the floor — the
    // INSERT never listed the column. Same write-dead family as source_line_id.
    await H.addColumn(db, 'sales_return_lines', 'warehouse_id', `${ID} NULL`, log);
    // Who authorised putting these goods back on the shelf, why, and when.
    // (see §12 below for the users.role widening that makes the approver
    // roles storable at all)
    // `restock` alone records the OUTCOME but not the DECISION: it moves stock
    // and reverses COGS, so an auditor asking "who decided this returned meal
    // was resellable, and on what grounds" currently has nowhere to look —
    // created_by is the cashier who raised the return, not the manager who
    // ruled on it. Nullable because a no_restock line has no decision to record.
    await H.addColumn(db, 'sales_return_lines', 'restock_reason', 'VARCHAR(300) NULL', log);
    await H.addColumn(db, 'sales_return_lines', 'restock_by', 'VARCHAR(80) NULL', log);
    await H.addColumn(db, 'sales_return_lines', 'restock_at', 'DATETIME NULL', log);
  }

  // The return's own component snapshot, mirroring ar_document_line_components.
  // Copied at create() rather than read from the invoice at post(): the return
  // is a historical document that must print and re-post identically, and the
  // qty here is the RETURNED fraction, not the sold one. Also bounds the blast
  // radius — a second partial return re-reads the invoice, not this.
  await H.createTable(db, 'sales_return_line_components', `
    CREATE TABLE sales_return_line_components (
      id ${ID} PRIMARY KEY,
      return_id ${ID} NOT NULL,
      return_line_id ${ID} NOT NULL,
      component_seq INT NOT NULL,
      source ENUM('recipe','semi','imported','combo') NOT NULL DEFAULT 'recipe',
      inv_item_id ${ID} NULL,
      inv_item_name VARCHAR(200) NULL,
      warehouse_id ${ID} NULL,
      restored_base_qty ${QTY} NOT NULL DEFAULT 0,
      unit_code VARCHAR(32) NULL,
      conversion_factor ${RATE} NULL,
      unit_cost_snapshot ${RATE} NOT NULL DEFAULT 0,
      total_cost ${MONEY} NOT NULL DEFAULT 0,
      projection_version SMALLINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_srlc_line_seq (return_line_id, component_seq),
      KEY ix_srlc_ret (return_id),
      KEY ix_srlc_line (return_line_id),
      KEY ix_srlc_item (inv_item_id)
    ) ${TBL}`, log);

  // ── 12. assignable roles — widen users.role so the seeded grants are reachable
  // role_permissions has carried accountant(31)/finance(65)/sales(15) grants
  // since the O2C capability seed, but users.role was
  // enum('admin','cashier','manager','custody','employee') — no user could ever
  // HOLD those roles, so every one of those grants was dead. There is no
  // central roles table to migrate to (only role_permissions, free text), so
  // the ENUM is widened in place, append-only: existing rows keep their values
  // untouched. lib/roles.js is the single code-side catalog.
  //
  // Domain bleed, acknowledged: users is legacy schema, but THIS apply() is
  // the only migration runner that executes at boot (server.js calls it;
  // db/migrate.js NNNN-*.sql has no boot caller) — a widen parked there would
  // strand fresh deploys with grants that 403 until someone runs db:migrate.
  // Guarded on COLUMN_TYPE so reboots don't re-ALTER.
  if (await H.tableExists(db, 'users')) {
    const [rc] = await db.query(
      `SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`);
    if (rc.length && !/accountant/.test(String(rc[0].t))) {
      await H.modifyColumn(db, 'users', 'role',
        `ENUM('admin','cashier','manager','custody','employee','accountant','finance','sales') DEFAULT 'cashier'`, log);
    }
  }

  // ── 13. idempotency contract — scope + fingerprint on ar_events
  // The old UNIQUE was (entity_type, idempotency_key): one key per DOCUMENT
  // TYPE globally, so a key reused across approve→post silently replayed the
  // approve as the post (200, no side effects), and a key reused across two
  // documents replayed the first onto the second. event_scope pins a key to
  // (type, action, document) for transitions and (type, 'create') for creates;
  // request_hash lets replay tell "same request again" (replay it) from "same
  // key, different payload" (409 IDEMPOTENCY_KEY_REUSED) — without it the two
  // are indistinguishable after the fact.
  if (await H.tableExists(db, 'ar_events')) {
    await H.addColumn(db, 'ar_events', 'event_scope', "VARCHAR(180) NOT NULL DEFAULT ''", log);
    await H.addColumn(db, 'ar_events', 'request_hash', 'CHAR(64) NULL', log);
    // Backfill scope for keyed rows that predate scoping, so the new UNIQUE
    // can be created and old events keep replaying under the new lookup.
    await db.query(
      `UPDATE ar_events
          SET event_scope = CONCAT(entity_type, ':', event_type, ':',
                                   CASE WHEN event_type = 'create' THEN '' ELSE entity_id END)
        WHERE idempotency_key IS NOT NULL AND event_scope = ''`);
    await H.addIndex(db, 'ar_events', 'uq_are_scope', 'event_scope, idempotency_key', { unique: true }, log);
    if (await H.indexExists(db, 'ar_events', 'uq_are_idem')) {
      await db.query('ALTER TABLE ar_events DROP INDEX uq_are_idem');
      log('  - index ar_events.uq_are_idem (superseded by uq_are_scope)');
    }
  }
  if (await H.tableExists(db, 'sales_returns')) {
    // postCreditNote posts a SECOND journal (SalesReturnCOGS) whose id was
    // returned to nobody — sales_returns had no column for it, so the COGS
    // journal was unreferenced by the document that caused it.
    await H.addColumn(db, 'sales_returns', 'cogs_journal_id', `${ID} NULL`, log);
  }

  // ── 14. ZATCA hash chain — a real, lockable head for O2C documents
  // ZatcaDocumentService computed previousHash from MAX(created_at) over
  // ar_documents (1-second resolution — not a total order; FOR UPDATE over an
  // empty table locks nothing at genesis; an unlocked catch-fallback could
  // fork the chain; and linkPosSale's copied legacy-sale hashes were eligible
  // heads). The stamper then RETURNED previousHash and the QR — and issue()
  // dropped both on the floor: no column existed, so the chain link was
  // recomputed-and-hoped rather than stored, unverifiable after the fact.
  if (await H.tableExists(db, 'ar_documents')) {
    await H.addColumn(db, 'ar_documents', 'previous_invoice_hash', 'VARCHAR(128) NULL', log);
    // Persisted now, consumed at Phase-2 submission — the UBL worker still
    // reads legacy tables only and hardcodes ICV '1'; wiring it up is that
    // worker's migration, not this one.
    await H.addColumn(db, 'ar_documents', 'zatca_icv', 'INT NULL', log);
  }
  await H.createTable(db, 'zatca_chain_state', `
    CREATE TABLE zatca_chain_state (
      chain_id VARCHAR(64) PRIMARY KEY,
      last_hash VARCHAR(128) NOT NULL,
      last_icv INT NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${TBL}`, log);
  // Seed = CUTOVER, not genesis: stamped documents already exist, and seeding
  // zeros would declare a genesis PIH with chained predecessors standing.
  // Derive the head with the same source_type<>'pos' filter the runtime gets
  // structurally (POS-copied hashes are not chain links), fall back to an
  // onboarding seed setting, then to the conventional genesis. INSERT IGNORE:
  // reboots must never reset a live head.
  {
    const [head] = await db.query(
      `SELECT zatca_hash FROM ar_documents
        WHERE source_type <> 'pos' AND zatca_hash IS NOT NULL AND zatca_hash <> ''
        ORDER BY created_at DESC, id DESC LIMIT 1`);
    let seedHash = head.length ? head[0].zatca_hash : null;
    let seedIcv = 0;
    if (seedHash) {
      const [cnt] = await db.query(
        `SELECT COUNT(*) c FROM ar_documents
          WHERE source_type <> 'pos' AND zatca_hash IS NOT NULL AND zatca_hash <> ''`);
      seedIcv = Number(cnt[0].c) || 0;
    } else {
      const [s] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'zatca_pih_seed' LIMIT 1");
      seedHash = (s.length && s[0].setting_value) || '0'.repeat(64);
    }
    const [ins] = await db.query(
      'INSERT IGNORE INTO zatca_chain_state (chain_id, last_hash, last_icv) VALUES (?,?,?)',
      ['o2c:default', seedHash, seedIcv]);
    if (ins.affectedRows) log(`  + zatca_chain_state o2c:default (icv ${seedIcv})`);
  }

  return true;
}

module.exports = { apply };
