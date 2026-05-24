-- ════════════════════════════════════════════════════════════════════
-- 0002_sales_numbering.sql
-- ────────────────────────────────────────────────────────────────────
-- v6.11.0 — Standard invoice / void / return numbering for POS sales.
--
-- WHY:
--   The legacy `sales.id` (e.g. SH-1779529770642-1779587680432) is fine
--   as a primary key but unfit to display to customers — it is long,
--   technical, and tied to the shift internals. Saudi (ZATCA) and most
--   accounting workflows expect a human-readable invoice number.
--
--   Additionally, voids and returns (refunds) need their own sequential
--   serials so they can be quoted in support tickets, dispute resolutions,
--   and reconciliation reports.
--
-- WHAT THIS MIGRATION DOES:
--   1. Adds three nullable columns to `sales`:
--        invoice_number (INV-YYYYMMDD-NNNN) for every NEW sale
--        void_serial    (VOI-YYYYMMDD-NNNN) populated when sale is voided
--        return_serial  (RET-YYYYMMDD-NNNN) populated when sale is returned
--   2. Adds matching indexes for fast lookup.
--   3. Creates `sales_daily_counter` — atomic per-day counter table
--      using the same LAST_INSERT_ID(expr) pattern as txn_daily_counter
--      (see routes/workflow.js:nextDailySerial).
--
--   All columns are NULLABLE so existing rows stay valid and any
--   pre-migration code paths keep working.
--
-- BACKWARD COMPATIBILITY:
--   • Existing sales rows have NULL invoice_number → UI falls back to
--     displaying the legacy `id` field.
--   • The new sales counter is independent of txn_daily_counter so the
--     two domains don't fight over the same keys.
-- ════════════════════════════════════════════════════════════════════

-- MySQL 8+ supports IF NOT EXISTS on ALTER TABLE ADD COLUMN. Older
-- versions ignore the clause syntax — we wrap each ADD in its own
-- statement so a single failure doesn't abort the rest of the migration.

ALTER TABLE sales ADD COLUMN invoice_number VARCHAR(40) NULL AFTER id;

ALTER TABLE sales ADD COLUMN void_serial VARCHAR(40) NULL AFTER invoice_number;

ALTER TABLE sales ADD COLUMN return_serial VARCHAR(40) NULL AFTER void_serial;

CREATE INDEX idx_sales_invoice_number ON sales (invoice_number);

CREATE INDEX idx_sales_void_serial ON sales (void_serial);

CREATE INDEX idx_sales_return_serial ON sales (return_serial);

CREATE TABLE IF NOT EXISTS sales_daily_counter (
  counter_key VARCHAR(80) NOT NULL PRIMARY KEY,
  last_serial INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
