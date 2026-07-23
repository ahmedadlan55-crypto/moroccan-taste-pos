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
--
-- Tier A.2 corrective gate, Section 6 — REWRITTEN for real idempotency.
-- The original version of this file claimed "MySQL 8+ supports IF NOT
-- EXISTS on ALTER TABLE ADD COLUMN" and relied on that for safety — FALSE
-- (verified against this repo's actual MySQL 8.4.9: `ADD COLUMN IF NOT
-- EXISTS` / `DROP INDEX IF EXISTS` are MariaDB-only syntax, not real MySQL).
-- The plain `ALTER TABLE ... ADD COLUMN` statements below were NOT
-- idempotent at all: verified directly against this repo's real dev DB
-- that `sales.invoice_number` already exists (added via server.js's
-- legacy runMigrations()#addColumnIfMissing boot-time path, a completely
-- separate mechanism from this versioned runner) while this file was
-- NEVER recorded in `_migrations` — meaning `node db/migrate.js` would
-- hit this file as "pending" on its very next real run and fail outright
-- with "Duplicate column name 'invoice_number'". Safe to fix directly
-- (never pushed/applied through this runner as an approved version — see
-- docs/adr/0002-chart-of-accounts-trial-balance.md §7 for why that makes
-- an in-place edit acceptable rather than a follow-up migration).
--
-- Every ALTER/CREATE INDEX below is now guarded by a real
-- INFORMATION_SCHEMA check via PREPARE/EXECUTE dynamic SQL — genuinely
-- idempotent (safe to re-run against a DB that already has some or all of
-- these columns/indexes from any source), and resumable after a partial
-- failure (each guard re-checks the CURRENT schema state at execution
-- time, not a cached assumption). PREPARE/EXECUTE/DEALLOCATE are flat,
-- standalone statements — no stored-procedure/DELIMITER wrapper needed,
-- so db/migrate.js's existing top-level `;` statement splitter handles
-- this file exactly like any other.

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'invoice_number'
);
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE sales ADD COLUMN invoice_number VARCHAR(40) NULL AFTER id',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'void_serial'
);
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE sales ADD COLUMN void_serial VARCHAR(40) NULL AFTER invoice_number',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'return_serial'
);
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE sales ADD COLUMN return_serial VARCHAR(40) NULL AFTER void_serial',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND INDEX_NAME = 'idx_sales_invoice_number'
);
SET @stmt = IF(@idx_exists = 0,
  'CREATE INDEX idx_sales_invoice_number ON sales (invoice_number)',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND INDEX_NAME = 'idx_sales_void_serial'
);
SET @stmt = IF(@idx_exists = 0,
  'CREATE INDEX idx_sales_void_serial ON sales (void_serial)',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND INDEX_NAME = 'idx_sales_return_serial'
);
SET @stmt = IF(@idx_exists = 0,
  'CREATE INDEX idx_sales_return_serial ON sales (return_serial)',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS sales_daily_counter (
  counter_key VARCHAR(80) NOT NULL PRIMARY KEY,
  last_serial INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
