-- ════════════════════════════════════════════════════════════════════
-- 0014_brand_branch_scope.sql
-- ────────────────────────────────────────────────────────────────────
-- Owner A — bilingual-i18n-images. Brand/branch scope fix: branch-level
-- SNAPSHOT columns that let the cashier and shift APIs scope supervisors
-- to their own brand instead of showing every branch's data by default.
--
--   pos_orders.branch_id — populated at order CREATION time (INSERT) via
--     _cashierBranchId(), never rewritten on later edits — same convention
--     as pos_orders.name_snapshot / channel_name. Powers the brand-scoped
--     GET /api/pos/v2/orders (+ GET /orders/:id) for supervisors.
--
--   shifts.branch_id — populated at shift OPEN time via
--     COALESCE(users.branch_id, users.default_branch_id), never rewritten on
--     close/reconciliation. Powers the brand-scoped GET /api/shifts for
--     supervisors. Shifts are branch-level facts (a cashier doesn't change
--     branch mid-shift), so this is resolved directly from the user's own
--     branch — NOT via the two-hop brand lookup pos_orders/catalog use.
--
-- Both are NULLable: rows written before this migration keep branch_id NULL
-- and are treated as visible to every brand-scoped supervisor (see
-- routes/pos-v2.js GET /orders and routes/shifts.js GET /) — the same
-- "unscoped = global" rule menu.brand_id IS NULL already uses.
--
-- WIRING NOTES for the server.js migration-wiring stage — copy verbatim:
--
--   await addColumnIfMissing('pos_orders', 'branch_id', "VARCHAR(50) NULL");
--   await addColumnIfMissing('shifts',     'branch_id', "VARCHAR(50) NULL");
--
-- Until the wiring stage lands, routes/pos-v2.js and routes/shifts.js each
-- ensure their OWN column at startup/first-request (INFORMATION_SCHEMA-
-- guarded — routes/pos-v2.js's existing `_ensureSchema()`, and the new
-- `_ensureShiftsSchema()` added to routes/shifts.js following the same
-- pattern).
--
-- Tier A.2 corrective gate, Section 6 — this file's own header claimed it
-- is "NOT the live migration path", but db/migrate.js's real runner picks
-- it up regardless (same false-claim pattern as 0013/0017). Worse, on a
-- real boot server.js's own legacy wiring (the "copy verbatim" block above,
-- now correctly ordered after pos_orders' CREATE TABLE — see the Tier A.2
-- Section 6 comment near that block) ALSO adds these same columns/indexes,
-- so plain ALTER/CREATE INDEX here would hit "Duplicate column"/"Duplicate
-- key" the moment both paths run against the same DB. Same
-- INFORMATION_SCHEMA + PREPARE/EXECUTE guard pattern as
-- 0002_sales_numbering.sql for genuine idempotency either way.
-- ════════════════════════════════════════════════════════════════════

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_orders' AND COLUMN_NAME = 'branch_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE pos_orders ADD COLUMN branch_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts' AND COLUMN_NAME = 'branch_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE shifts ADD COLUMN branch_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_orders' AND INDEX_NAME = 'idx_pos_orders_branch');
SET @stmt = IF(@idx_exists = 0, 'CREATE INDEX idx_pos_orders_branch ON pos_orders(branch_id)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts' AND INDEX_NAME = 'idx_shifts_branch');
SET @stmt = IF(@idx_exists = 0, 'CREATE INDEX idx_shifts_branch ON shifts(branch_id)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
