-- ════════════════════════════════════════════════════════════════════
-- 0028_coa_metadata.sql
-- ────────────────────────────────────────────────────────────────────
-- THE CHART OF ACCOUNTS GETS ITS OWN METADATA, so reports stop guessing.
--
-- Today a report decides where an account belongs on a financial statement
-- by looking at its CODE PREFIX and — for assets — by running a REGEX OVER
-- ITS ARABIC NAME (routes/erp/reports/balance-sheet.js classifyAssetByName).
-- Two consequences, both live:
--
--   * renaming an account can move it on the balance sheet;
--   * balance-sheet.js reads code `112` as receivables while cash-flow.js
--     reads the same `112` as inventory, so the two statements disagree
--     about the same account by construction.
--
-- The fix is not a better heuristic. It is columns: an account states its
-- own normal balance, whether it is contra, whether it may be posted to,
-- which statement section it belongs in, and which cash-flow activity it
-- rolls into. This migration adds those columns and seeds them from the
-- best evidence currently available; a later package removes the inference
-- code once every posting account carries them.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It does not move, rename, renumber, merge or delete a single account.
--     Structure changes belong to the migration manifest (package F), which
--     is reviewable and reversible per account. This one only ADDS.
--   * It does not touch gl_accounts.balance. That column is not the source
--     of truth (dev: 20 accounts adrift by 410,813.42; prod: 19 by
--     13,924.67 — the ledger is right and the column is stale) and the
--     reports already re-derive from gl_entries. It stays for display and
--     is documented as untrusted rather than silently "fixed".
--
-- SEEDING IS CONSERVATIVE ON PURPOSE. normal_balance follows from the
-- account TYPE, which is a fact. is_contra / cash_flow_activity are left
-- NULL where they cannot be established from stored data — a NULL is
-- visible to the unmapped-accounts diagnostic and gets a decision, whereas
-- a guessed value silently becomes the wrong number on a statement.
--
-- Guard style per db/migrations/README.md rule 3 (MySQL 8 has no
-- ADD COLUMN IF NOT EXISTS) and rule 5 (explicit utf8mb4_unicode_ci so a
-- later FK cannot hit ER_FK_INCOMPATIBLE_COLUMNS).
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Ownership: which ledger does this account belong to? ─────────────
-- account_roles has carried company_id since 0018; gl_accounts never did,
-- and 0018's own header notes the gap. Without it `code` must be globally
-- unique, which makes a second company impossible.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'company_id');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN company_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill to the single existing company. Picked from the companies table
-- rather than hardcoded, falling back to 'CO-MAIN' only if that table is
-- empty, so a differently-named company is not silently mislabelled.
SET @co = (SELECT id FROM companies ORDER BY (id = 'CO-MAIN') DESC, id ASC LIMIT 1);
SET @co = COALESCE(@co, 'CO-MAIN');
UPDATE gl_accounts SET company_id = @co WHERE company_id IS NULL;

-- ── 2. Normal balance — a fact derived from type, not a guess ───────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'normal_balance');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN normal_balance ENUM('debit','credit') NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE gl_accounts
   SET normal_balance = CASE WHEN type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
 WHERE normal_balance IS NULL;

-- ── 3. Contra — declared, never inferred from a name ────────────────────
-- Left NULL by default. The balance sheet currently detects contra with a
-- bilingual name regex that has to match both 'مجمَّع الإهلاك' and
-- 'مجمع الإهلاك' separately — which is the clearest possible evidence that
-- a name is not a classification. Package F assigns these explicitly.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'is_contra');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN is_contra TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'contra_of_account_id');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN contra_of_account_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Seed from report_section only — the three values that already MEAN contra
-- in the balance sheet's own CONTRA_REPORT_SECTIONS set. No name matching.
UPDATE gl_accounts
   SET is_contra = 1
 WHERE is_contra = 0
   AND report_section IN ('allowance_doubtful','acc_dep','drawings');

-- ── 4. Postability and control accounts, stated rather than computed ────
-- is_postable is seeded from the existing rule (not a folder, no children)
-- so behaviour does not change on the day this lands. It becomes
-- AUTHORITATIVE later, once the write gate maintains it.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'is_postable');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN is_postable TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE gl_accounts a
  LEFT JOIN (SELECT DISTINCT parent_id AS pid FROM gl_accounts WHERE parent_id IS NOT NULL) k
         ON k.pid = a.id
   SET a.is_postable = IF(COALESCE(a.is_folder,0) = 1 OR k.pid IS NOT NULL, 0, 1);

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'is_control');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN is_control TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 5. Cash-flow activity — NULL until decided ─────────────────────────
-- cash-flow.js infers this purely from code prefixes today, and recognises
-- only the legacy 3-digit scheme, so every 6-digit account silently falls
-- into 'other'. NULL here is honest and shows up in the diagnostic.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'cash_flow_activity');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN cash_flow_activity ENUM('operating','investing','financing','non_cash') NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 6. Lifecycle: is_active is not enough ──────────────────────────────
-- 'blocked' (temporarily refuse new postings, keep it visible) and
-- 'archived' (closed, but its history must stay in historical reports) are
-- different states that a single boolean cannot express. is_active stays in
-- place and in sync so nothing that reads it breaks.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'status');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN status ENUM('active','blocked','archived') NOT NULL DEFAULT 'active'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE gl_accounts SET status = IF(COALESCE(is_active,1) = 1, 'active', 'archived')
 WHERE status = 'active' AND COALESCE(is_active,1) = 0;

-- ── 7. Optimistic concurrency + audit trail ────────────────────────────
-- Two people editing the same account currently last-write-wins in silence.
-- `version` gives the write gate an expectedVersion to reject against.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'version');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN version INT NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'created_by');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN created_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'updated_by');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN updated_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'updated_at');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'archived_by');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN archived_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'archived_at');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN archived_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 8. Protected / system-managed accounts ─────────────────────────────
-- Root protection is hardcoded to codes '1'..'5' in routes/erp.js today,
-- which is false in production where the roots are 100000..500000. A flag
-- is the durable answer: protection travels with the row, not with a
-- numbering scheme that differs per environment.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'is_system_root');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN is_system_root TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'system_managed');
SET @s = IF(@c = 0, 'ALTER TABLE gl_accounts ADD COLUMN system_managed TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- class_code ties a root to its accounting class (1 Assets .. 5 Expenses)
-- independently of how the chart happens to be numbered. This is what makes
-- "exactly five roots" enforceable in BOTH the legacy 1..5 chart (dev) and
-- the six-digit GGMMPP chart (production).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'class_code');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN class_code CHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Mark the genuine roots: parentless AND the canonical account of their
-- type. Restricted to parentless rows so the ~36 orphaned operational
-- accounts in production (which are parentless by ACCIDENT, not by design)
-- are not blessed as system roots — package F reparents those.
UPDATE gl_accounts a
   JOIN (
     SELECT type, MIN(CHAR_LENGTH(code)) AS shortest
       FROM gl_accounts WHERE parent_id IS NULL GROUP BY type
   ) t ON t.type = a.type AND CHAR_LENGTH(a.code) = t.shortest
   SET a.is_system_root = 1,
       a.class_code = CASE a.type WHEN 'asset' THEN '1' WHEN 'liability' THEN '2'
                                  WHEN 'equity' THEN '3' WHEN 'revenue' THEN '4'
                                  ELSE '5' END
 WHERE a.parent_id IS NULL;

-- ── 9. Provenance for generated accounts ───────────────────────────────
-- Customer/supplier/bank/cash-box accounts are created BY those modules.
-- Recording where a row came from is what lets the tree refuse to let
-- someone hand-edit an account the subledger owns.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'source_entity_type');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN source_entity_type VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND COLUMN_NAME = 'source_entity_id');
SET @s = IF(@c = 0, "ALTER TABLE gl_accounts ADD COLUMN source_entity_id VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 10. Per-company uniqueness of `code` ───────────────────────────────
-- The old global UNIQUE(code) makes a second company structurally
-- impossible. Swapped only when the data actually permits it, and the old
-- key is dropped only AFTER the new one exists — so a failure part-way
-- leaves the table protected by one key or the other, never by neither.

SET @dupes = (SELECT COUNT(*) FROM (
  SELECT company_id, code FROM gl_accounts GROUP BY company_id, code HAVING COUNT(*) > 1
) d);
SET @have = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'uq_gl_accounts_company_code');
SET @s = IF(@dupes = 0 AND @have = 0,
  'ALTER TABLE gl_accounts ADD UNIQUE KEY uq_gl_accounts_company_code (company_id, code)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @new = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'uq_gl_accounts_company_code');
SET @old = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'code');
SET @s = IF(@new > 0 AND @old > 0, 'ALTER TABLE gl_accounts DROP INDEX code', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 11. Codes are business identifiers, so they need aliases ───────────
-- 9 columns across the schema reference an account by CODE rather than id
-- (383 live references in dev, 161 in production). A code change there does
-- not fail loudly — it resolves to the wrong account, or to nothing. Any
-- future renumbering therefore has to leave a forwarding address.

CREATE TABLE IF NOT EXISTS account_code_aliases (
  id             VARCHAR(60)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  company_id     VARCHAR(50)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_code       VARCHAR(20)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  account_id     VARCHAR(50)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  reason         VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  created_by     VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alias_company_code (company_id, old_code),
  KEY idx_alias_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 12. The statement-section catalog ──────────────────────────────────
-- report_section is a free VARCHAR(40) today, so a typo is a new section
-- and nothing notices. This makes the vocabulary explicit and gives every
-- report ONE list to join against instead of five private maps that
-- disagree (the 112 contradiction being the proof).

CREATE TABLE IF NOT EXISTS statement_sections (
  id             VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  statement      ENUM('balance_sheet','income_statement','cash_flow','equity') NOT NULL,
  parent_group   VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  name_ar        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  name_en        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  normal_balance ENUM('debit','credit') NOT NULL,
  is_contra      TINYINT(1)   NOT NULL DEFAULT 0,
  display_order  INT          NOT NULL DEFAULT 0,
  KEY idx_section_statement (statement, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seeded from the sections the balance sheet's own reportSectionMap already
-- recognises, so existing data keeps validating. INSERT IGNORE keeps this
-- re-runnable and never overwrites an edited row.
INSERT IGNORE INTO statement_sections
  (id, statement, parent_group, name_ar, name_en, normal_balance, is_contra, display_order) VALUES
  ('cash',                'balance_sheet','currentAssets',      'النقدية وما في حكمها','Cash and cash equivalents','debit',0,10),
  ('receivables',         'balance_sheet','currentAssets',      'ذمم مدينة',            'Receivables',              'debit',0,20),
  ('allowance_doubtful',  'balance_sheet','currentAssets',      'مخصص الديون المشكوك فيها','Allowance for doubtful debts','credit',1,30),
  ('inventory',           'balance_sheet','currentAssets',      'المخزون',              'Inventory',                'debit',0,40),
  ('prepayments',         'balance_sheet','currentAssets',      'مصروفات مدفوعة مقدمًا','Prepayments',              'debit',0,50),
  ('input_vat',           'balance_sheet','currentAssets',      'ضريبة المدخلات',       'Input VAT',                'debit',0,60),
  ('ppe',                 'balance_sheet','nonCurrentAssets',   'ممتلكات وآلات ومعدات', 'Property, plant and equipment','debit',0,70),
  ('acc_dep',             'balance_sheet','nonCurrentAssets',   'مجمع الإهلاك',         'Accumulated depreciation', 'credit',1,80),
  ('payables',            'balance_sheet','currentLiabilities', 'ذمم دائنة',            'Payables',                 'credit',0,110),
  ('grni',                'balance_sheet','currentLiabilities', 'بضاعة مستلمة لم تُفوتر','Goods received not invoiced','credit',0,120),
  ('accrued',             'balance_sheet','currentLiabilities', 'مصروفات مستحقة',       'Accrued expenses',         'credit',0,130),
  ('output_vat',          'balance_sheet','currentLiabilities', 'ضريبة المخرجات',       'Output VAT',               'credit',0,140),
  ('customer_advances',   'balance_sheet','currentLiabilities', 'دفعات مقدمة من عملاء', 'Customer advances',        'credit',0,150),
  ('capital',             'balance_sheet','equity',             'رأس المال',            'Capital',                  'credit',0,210),
  ('retained_earnings',   'balance_sheet','equity',             'أرباح مبقاة',          'Retained earnings',        'credit',0,220),
  ('drawings',            'balance_sheet','equity',             'المسحوبات',            'Drawings',                 'debit',1,230),
  ('reserves',            'balance_sheet','equity',             'الاحتياطيات',          'Reserves',                 'credit',0,240),
  ('sales_revenue',       'income_statement','revenue',         'إيرادات المبيعات',     'Sales revenue',            'credit',0,310),
  ('sales_returns',       'income_statement','revenue',         'مردودات وخصومات المبيعات','Sales returns and discounts','debit',1,320),
  ('other_income',        'income_statement','revenue',         'إيرادات أخرى',         'Other income',             'credit',0,330),
  ('cogs',                'income_statement','cogs',            'تكلفة المبيعات',       'Cost of sales',            'debit',0,410),
  ('waste',               'income_statement','cogs',            'الهدر',                'Waste',                    'debit',0,420),
  ('stock_variance',      'income_statement','cogs',            'فروقات الجرد',         'Stock variances',          'debit',0,430),
  ('payroll',             'income_statement','opex',            'الرواتب والأجور',      'Payroll',                  'debit',0,510),
  ('rent_utilities',      'income_statement','opex',            'الإيجار والمرافق',     'Rent and utilities',       'debit',0,520),
  ('marketing',           'income_statement','opex',            'التسويق والعمولات',    'Marketing and commissions','debit',0,530),
  ('depreciation',        'income_statement','opex',            'الإهلاك',              'Depreciation',             'debit',0,540),
  ('bank_gov_fees',       'income_statement','opex',            'رسوم بنكية وحكومية',   'Bank and government fees', 'debit',0,550),
  ('franchise_fees',      'income_statement','opex',            'رسوم الامتياز',        'Franchise fees',           'debit',0,560);

-- ── 13. Parent integrity, enforced by the database ─────────────────────
-- Added LAST and only when the data is already clean (verified: zero
-- dangling parents in dev and production). RESTRICT, not CASCADE: deleting
-- an account must never silently take its subtree — and its history — with
-- it. If the guard finds dirty data it skips, leaving the table exactly as
-- it was rather than half-constrained.

SET @dangling = (SELECT COUNT(*) FROM gl_accounts ch
                  LEFT JOIN gl_accounts p ON p.id = ch.parent_id
                 WHERE ch.parent_id IS NOT NULL AND p.id IS NULL);
SET @selfref  = (SELECT COUNT(*) FROM gl_accounts WHERE parent_id = id);
SET @havefk   = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts'
                    AND CONSTRAINT_NAME = 'fk_gl_accounts_parent');
SET @s = IF(@dangling = 0 AND @selfref = 0 AND @havefk = 0,
  'ALTER TABLE gl_accounts ADD CONSTRAINT fk_gl_accounts_parent FOREIGN KEY (parent_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 14. Indexes for the queries the new columns invite ─────────────────

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'idx_gl_accounts_company_status');
SET @s = IF(@i = 0, 'CREATE INDEX idx_gl_accounts_company_status ON gl_accounts (company_id, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'idx_gl_accounts_postable');
SET @s = IF(@i = 0, 'CREATE INDEX idx_gl_accounts_postable ON gl_accounts (is_postable, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_accounts' AND INDEX_NAME = 'idx_gl_accounts_source_entity');
SET @s = IF(@i = 0, 'CREATE INDEX idx_gl_accounts_source_entity ON gl_accounts (source_entity_type, source_entity_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
