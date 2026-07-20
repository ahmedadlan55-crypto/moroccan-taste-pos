-- ─── Account Role Registry — additive only ──────────────────────────────────
-- Chart of Accounts / Trial Balance overhaul, Tier A (see docs/adr/0002-chart-
-- of-accounts-trial-balance.md and the audit at
-- docs/audits/COA_TRIAL_BALANCE_AUDIT_LOCAL_AR.md).
--
-- This migration creates ONE new table. It does not ALTER, UPDATE, or DELETE
-- anything on gl_accounts / gl_journals / gl_entries. No existing account_id,
-- journal number, or historical entry is touched (rules 2/4/5/6 in the
-- overhaul brief).
--
-- Purpose: replace hardcoded GL account codes (lib/glPosting.js CORE_ACCOUNTS,
-- lib/hrGLPosting.js SALARY_ACCOUNTS, and ~15 more literal-code call sites
-- across routes/sales.js, routes/purchases.js, routes/custody.js,
-- lib/order-to-cash/*, lib/procurement/* — see the audit report) with a
-- lookup by symbolic business role ("CASH_ON_HAND", "ACCOUNTS_RECEIVABLE",
-- ...) resolved through lib/accountRoles.js. Wiring those call sites to this
-- table is EXPLICITLY OUT OF SCOPE for this migration — it happens gradually,
-- one file at a time, in future governed changes. This migration only ships
-- the storage.
--
-- Scope note: company_id is NULLable and NOT YET enforced — gl_accounts has
-- no company_id column today (single implicit legal entity, companies row
-- CO-MAIN). uq_role_key below assumes single-tenant reality; when real
-- multi-company scoping lands on gl_accounts, this constraint must be widened
-- to (role_key, company_id) in a follow-up migration — do not just drop it.

CREATE TABLE IF NOT EXISTS account_roles (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  role_key      VARCHAR(60)  NOT NULL,                 -- e.g. 'CASH_ON_HAND', 'ACCOUNTS_RECEIVABLE'
  company_id    VARCHAR(50)  NULL,                      -- reserved for future multi-company scoping; unused today
  account_id    VARCHAR(50)  NOT NULL,                  -- FK to gl_accounts.id — the resolved target account
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,         -- soft revoke; never hard-delete a role mapping with history
  notes         VARCHAR(400) NULL,                       -- why this account was chosen for this role
  created_by    VARCHAR(64)  NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_by    VARCHAR(64)  NULL,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_key (role_key),
  KEY idx_account (account_id),
  KEY idx_company (company_id),
  CONSTRAINT fk_account_roles_account FOREIGN KEY (account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_roles_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for role reassignment (governance requirement — rule 5: any
-- future change of which account backs a role must be reviewable). Not
-- written to by anything yet in this Tier A round; the table exists so
-- lib/accountRoles.js can log into it once a write path is added.
CREATE TABLE IF NOT EXISTS account_role_history (
  id              VARCHAR(40)  NOT NULL PRIMARY KEY,
  role_key        VARCHAR(60)  NOT NULL,
  company_id      VARCHAR(50)  NULL,
  old_account_id  VARCHAR(50)  NULL,
  new_account_id  VARCHAR(50)  NOT NULL,
  reason          VARCHAR(400) NOT NULL,
  changed_by      VARCHAR(64)  NULL,
  changed_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  KEY idx_role (role_key),
  KEY idx_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
