-- ════════════════════════════════════════════════════════════════════════
-- 0032_coa_company_scope_invariant.sql
-- Close the NULL-company uniqueness hole in gl_accounts.
--
-- 0028 introduced UNIQUE(company_id, code) but left company_id nullable.
-- MySQL treats NULL values as distinct inside a UNIQUE key, so two legacy
-- writers that omitted company_id could create the same account code twice.
-- Canonical accounting is currently a fixed CO-MAIN ledger (there is no
-- trusted company claim in JWT), therefore an omitted owner means CO-MAIN.
--
-- This is deliberately fail-closed: if NULL rows collide with each other or
-- with an existing CO-MAIN code, the UPDATE fails and deployment stops. It
-- never guesses which accounting account should survive.
-- ════════════════════════════════════════════════════════════════════════

UPDATE gl_accounts
   SET company_id = 'CO-MAIN'
 WHERE company_id IS NULL;

ALTER TABLE gl_accounts
  MODIFY COLUMN company_id VARCHAR(50)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  NOT NULL DEFAULT 'CO-MAIN';
