-- Corrective migration for account_roles (0018) scope design — Tier A.1
-- Corrective Gate, item 5. Read docs/adr/0002-chart-of-accounts-trial-balance.md
-- section 5 for the full reasoning. 0018 is already applied in every
-- environment that ran it, so this file ALTERs the existing tables rather
-- than silently editing 0018's file — migration history stays immutable.
--
-- MySQL DDL is NOT transactional: each statement below commits on its own
-- as it runs. If this file aborts partway through, db/migrate.js will
-- retry the WHOLE file on next start (0019 is not yet recorded as
-- applied) — and re-running an already-applied ADD COLUMN / ADD KEY /
-- ADD CONSTRAINT below will error ("Duplicate column name", "Duplicate key
-- name", "Duplicate foreign key constraint name"), NOT silently succeed.
-- `ADD COLUMN IF NOT EXISTS` / `DROP INDEX IF EXISTS` / `ADD ... KEY IF NOT
-- EXISTS` are NOT valid syntax on real MySQL (verified directly against
-- this project's MySQL 8.4.9 — that guidance in db/migrations/README.md is
-- wrong; a MariaDB-ism, not MySQL) so this file cannot lean on them for
-- idempotency the way 0012 leans on `CREATE TABLE IF NOT EXISTS`. A partial
-- failure here needs a human to inspect `SHOW CREATE TABLE account_roles` /
-- `account_role_history` and finish the remaining statements by hand (or
-- simply re-run — the already-applied statements' errors are self-
-- explanatory and safe to ignore, everything after them still needs to run).

-- 1. Optimistic-concurrency version column, used by the transactional writer
--    (lib/accountRoles.js#setAccountRole) to detect concurrent modification.
ALTER TABLE account_roles ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER is_active;

-- 2. company_id must be NOT NULL. MySQL treats every NULL as DISTINCT in a
--    unique index, so a (role_key, company_id) unique constraint with
--    company_id nullable would silently allow duplicate "global" mappings
--    for the same role — exactly the bug class this migration closes.
--    gl_accounts has no real company scoping yet (single implicit legal
--    entity, companies row CO-MAIN — see ADR 0002), so backfill any
--    existing NULL rows to CO-MAIN before tightening the column.
UPDATE account_roles SET company_id = 'CO-MAIN' WHERE company_id IS NULL;
ALTER TABLE account_roles MODIFY COLUMN company_id VARCHAR(50) NOT NULL DEFAULT 'CO-MAIN';

-- 3. Replace 0018's single-tenant UNIQUE(role_key) with a real per-company
--    scope. Practically single-tenant today (only CO-MAIN exists), but the
--    constraint itself is now correct for when a second company lands.
ALTER TABLE account_roles DROP INDEX uq_role_key;
ALTER TABLE account_roles ADD UNIQUE KEY uq_role_company (role_key, company_id);

-- 4. account_role_history: same company_id tightening, plus the columns and
--    FKs 0018 omitted. old_account_id stays nullable (a role's first-ever
--    assignment has no prior account) — MySQL FKs tolerate NULL values.
UPDATE account_role_history SET company_id = 'CO-MAIN' WHERE company_id IS NULL;
ALTER TABLE account_role_history MODIFY COLUMN company_id VARCHAR(50) NOT NULL DEFAULT 'CO-MAIN';
ALTER TABLE account_role_history ADD COLUMN expected_version INT NULL AFTER new_account_id;

ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_old_account FOREIGN KEY (old_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
ALTER TABLE account_role_history ADD CONSTRAINT fk_arh_new_account FOREIGN KEY (new_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
