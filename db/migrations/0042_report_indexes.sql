-- Indexes for the predicates every dated report actually uses.
--
-- ─── WHAT IS MISSING, AND WHY IT MATTERS ────────────────────────────────────
-- `gl_journals.journal_date` is not indexed. At all. Verified against the live
-- production schema: the table carries six indexes — PRIMARY, journal_number,
-- (reference_type, reference_id), reversed_by, reverses, and the four-column
-- dimension index — and not one of them leads with the date or mentions status.
--
-- Every financial statement in the product filters
--     journal_date BETWEEN ? AND ?  AND  status = 'posted'
-- so the trial balance, income statement, balance sheet, cash flow, GL ledger
-- and equity statement each begin with a full scan of `gl_journals`, then a
-- nested loop into `gl_entries`. That is the whole reporting surface sharing
-- one missing index.
--
-- ─── HONEST NOTE ON MEASUREMENT ─────────────────────────────────────────────
-- The house rule (db/migrations/analytics/schema.js) is that an index arrives
-- with an EXPLAIN behind it. That is not possible here and it would be dishonest
-- to claim otherwise: production currently holds 36 journals and 168 entries, so
-- the optimizer correctly full-scans whatever exists and no plan improves.
--
-- These are justified by the ACCESS PATTERN, not by a measurement on today's
-- data — the composite matches the predicate exactly, leading with the ranged
-- column and carrying the equality that always accompanies it. The cost of
-- adding them now is a few kilobytes; the cost of discovering the gap at
-- 500,000 journals is every report timing out at once, on the day the business
-- is large enough to care.
--
-- ─── IDEMPOTENCE ────────────────────────────────────────────────────────────
-- MySQL has no `CREATE INDEX IF NOT EXISTS`, and a migration that errors on a
-- re-run leaves the version unrecorded, so the release chain retries it forever
-- and the server never starts. Each block therefore probes INFORMATION_SCHEMA
-- and prepares either the ALTER or a no-op. Re-running is silent.

-- ── 1. gl_journals (journal_date, status) ───────────────────────────────────
-- Date leads because it is the RANGE; status is the equality that rides along.
-- Reversing them would leave the range unable to use the second column.
SET @has := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'gl_journals'
                AND INDEX_NAME = 'ix_glj_date_status');
SET @tbl := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_journals');
SET @sql := IF(@has = 0 AND @tbl = 1,
  'ALTER TABLE gl_journals ADD INDEX ix_glj_date_status (journal_date, status)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 2. supplier_invoices (issue_date) ───────────────────────────────────────
-- A/P by period scans today: the table indexes due_date and status, but the
-- period an AP ageing or a purchases-by-month report filters on is issue_date.
SET @has := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'supplier_invoices'
                AND INDEX_NAME = 'ix_sinv_issue_date');
SET @tbl := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_invoices');
SET @col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'supplier_invoices' AND COLUMN_NAME = 'issue_date');
SET @sql := IF(@has = 0 AND @tbl = 1 AND @col = 1,
  'ALTER TABLE supplier_invoices ADD INDEX ix_sinv_issue_date (issue_date)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 3. inventory_movements (movement_date) ──────────────────────────────────
-- The table already has (item_id, warehouse_id, movement_date) and
-- (warehouse_id, movement_date). Both need their leading column pinned to an
-- equality, so a report asking "everything that moved last month" — no item, no
-- warehouse — can use neither and scans. This one leads with the date.
SET @has := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'inventory_movements'
                AND INDEX_NAME = 'ix_invmov_date');
SET @tbl := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_movements');
SET @sql := IF(@has = 0 AND @tbl = 1,
  'ALTER TABLE inventory_movements ADD INDEX ix_invmov_date (movement_date, type)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
