-- Corrective migration for account_roles (0018) scope design — Tier A.1
-- Corrective Gate, item 5. Read docs/adr/0002-chart-of-accounts-trial-balance.md
-- section 5 for the full reasoning. 0018 is already applied in every
-- environment that ran it, so this file ALTERs the existing tables rather
-- than silently editing 0018's file — migration history stays immutable.
--
-- Tier A.2 corrective gate, Section 6 — REWRITTEN for real resumability.
-- The original version of this file openly documented that it was NOT
-- safely re-runnable after a partial failure ("a human needs to inspect
-- SHOW CREATE TABLE ... and finish the remaining statements by hand") —
-- an honest admission, but not a fix. Every genuinely non-idempotent
-- statement below (ADD COLUMN, DROP INDEX, ADD UNIQUE KEY, ADD CONSTRAINT)
-- is now guarded by a real INFORMATION_SCHEMA check via PREPARE/EXECUTE
-- dynamic SQL — the same pattern 0002_sales_numbering.sql uses. MODIFY
-- COLUMN and a WHERE-scoped UPDATE are left unguarded deliberately: both
-- are idempotent BY NATURE (re-applying an identical column definition, or
-- re-running an UPDATE that matches zero rows the second time, are both
-- safe no-ops on real MySQL — verified directly, not assumed). MySQL DDL
-- is still not transactional (each statement below still commits on its
-- own), but now re-running the WHOLE file after a partial failure at any
-- point genuinely finishes the job instead of erroring on whatever already
-- succeeded.

-- 1. Optimistic-concurrency version column, used by the transactional writer
--    (lib/accountRoles.js#setAccountRole) to detect concurrent modification.
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_roles' AND COLUMN_NAME = 'version'
);
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE account_roles ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER is_active',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. company_id must be NOT NULL. MySQL treats every NULL as DISTINCT in a
--    unique index, so a (role_key, company_id) unique constraint with
--    company_id nullable would silently allow duplicate "global" mappings
--    for the same role — exactly the bug class this migration closes.
--    gl_accounts has no real company scoping yet (single implicit legal
--    entity, companies row CO-MAIN — see ADR 0002), so backfill any
--    existing NULL rows to CO-MAIN before tightening the column. Both
--    statements are idempotent by nature (see file header) — no guard needed.
UPDATE account_roles SET company_id = 'CO-MAIN' WHERE company_id IS NULL;
ALTER TABLE account_roles MODIFY COLUMN company_id VARCHAR(50) NOT NULL DEFAULT 'CO-MAIN';

-- 3. Replace 0018's single-tenant UNIQUE(role_key) with a real per-company
--    scope. Practically single-tenant today (only CO-MAIN exists), but the
--    constraint itself is now correct for when a second company lands.
SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_roles' AND INDEX_NAME = 'uq_role_key'
);
SET @stmt = IF(@idx_exists > 0,
  'ALTER TABLE account_roles DROP INDEX uq_role_key',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_roles' AND INDEX_NAME = 'uq_role_company'
);
SET @stmt = IF(@idx_exists = 0,
  'ALTER TABLE account_roles ADD UNIQUE KEY uq_role_company (role_key, company_id)',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. account_role_history: same company_id tightening, plus the columns and
--    FKs 0018 omitted. old_account_id stays nullable (a role's first-ever
--    assignment has no prior account) — MySQL FKs tolerate NULL values.
UPDATE account_role_history SET company_id = 'CO-MAIN' WHERE company_id IS NULL;
ALTER TABLE account_role_history MODIFY COLUMN company_id VARCHAR(50) NOT NULL DEFAULT 'CO-MAIN';

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_role_history' AND COLUMN_NAME = 'expected_version'
);
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE account_role_history ADD COLUMN expected_version INT NULL AFTER new_account_id',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_role_history'
    AND CONSTRAINT_NAME = 'fk_arh_company' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @stmt = IF(@fk_exists = 0,
  'ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_role_history'
    AND CONSTRAINT_NAME = 'fk_arh_old_account' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @stmt = IF(@fk_exists = 0,
  'ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_old_account FOREIGN KEY (old_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_role_history'
    AND CONSTRAINT_NAME = 'fk_arh_new_account' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @stmt = IF(@fk_exists = 0,
  'ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_new_account FOREIGN KEY (new_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
