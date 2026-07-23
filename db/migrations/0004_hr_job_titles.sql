-- ════════════════════════════════════════════════════════════════════
-- 0004_hr_job_titles.sql
-- ────────────────────────────────────────────────────────────────────
-- v6.18.0 — HR job-titles taxonomy + the 4 mandatory people-record
-- columns on `users` (iqama_number, iban, job_title_code, full_name).
--
-- WHY THIS MIGRATION EXISTS:
--   Until now `hr_employees.job_title` was a free-text VARCHAR(100),
--   and the `users` table held only `username` + `role` + a soft
--   `full_name` runtime column.  The owner reported three symptoms:
--
--     1. No canonical list of restaurant job titles → admins typed
--        whatever string they wanted, breaking reports/permissions.
--     2. The "create user" flow never asked for iqama, iban, job
--        title, or full name — fields the business needs for HR.
--     3. The same person showed up twice in workflow transactions
--        (once as cashier-username, once as hr_employees full name)
--        because users and employees were unlinked.
--
--   This file lays the groundwork for fixing all three.  It's
--   intentionally **additive only** — no validation tightening, no
--   FK constraints, no data renames.  Existing rows are not touched.
--   Validation + linking arrive in 0005/0006 (Waves 2-3 in the plan).
--
-- WHAT THIS FILE DOES:
--   A. Creates `hr_job_titles` — the canonical list of restaurant
--      positions with rank (1 = Owner, 10 = Helper), category, and
--      the default `users.role` value to use when an admin creates
--      a user account from a given title.
--   B. Seeds it with 20 titles covering Saudi-restaurant operations
--      end-to-end (management → kitchen → support).
--   C. Adds 4 nullable columns to `users` so the HR-tier metadata
--      can attach directly to a user record even before that user
--      is linked to an hr_employees row.  All NULL by default so no
--      existing user blocks the migration.
--
-- BACKWARD COMPATIBILITY:
--   • Existing users are untouched (new columns NULL).
--   • Existing hr_employees.job_title (legacy free text) is NOT
--     removed; a later migration will map values to job_title_code.
--   • Re-running this migration is safe — `CREATE TABLE IF NOT
--     EXISTS`, `INSERT IGNORE`, and `ADD COLUMN IF NOT EXISTS`.
--
-- COORDINATED CHANGES:
--   • server.js runMigrations gets matching `addColumnIfMissing`
--     calls + `INSERT IGNORE` for the 20 seed rows so fresh installs
--     and pre-framework deployments end up in the same shape.
-- ════════════════════════════════════════════════════════════════════

-- ─── A. The canonical job-titles table ──────────────────────────────
CREATE TABLE IF NOT EXISTS hr_job_titles (
  id           VARCHAR(50)  NOT NULL PRIMARY KEY,
  code         VARCHAR(30)  NOT NULL UNIQUE,
  name_ar      VARCHAR(100) NOT NULL,
  name_en      VARCHAR(100) NOT NULL,
  rank_level   INT          NOT NULL DEFAULT 7,
  category     ENUM('management','operations','finance','support','kitchen','warehouse','hr','it')
               NOT NULL DEFAULT 'operations',
  default_role ENUM('admin','manager','cashier','custody','employee')
               NOT NULL DEFAULT 'employee',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_jt_rank     (rank_level),
  INDEX idx_jt_category (category),
  INDEX idx_jt_active   (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── B. Seed with 20 restaurant-industry titles ─────────────────────
-- Rank 1 = top of the org chart, 10 = entry-level.
-- default_role maps each title to one of the existing user ENUM roles
-- so the "create user from employee" flow has a sane default.
-- INSERT IGNORE = idempotent; re-running won't duplicate or fail.
INSERT IGNORE INTO hr_job_titles (id, code, name_ar, name_en, rank_level, category, default_role) VALUES
  ('jt-owner',        'OWNER',        'المالك',                'Owner',               1,  'management', 'admin'),
  ('jt-gm',           'GM',           'المدير العام',          'General Manager',     2,  'management', 'admin'),
  ('jt-ops-mgr',      'OPS_MGR',      'مدير العمليات',         'Operations Manager',  3,  'management', 'manager'),
  ('jt-branch-mgr',   'BRANCH_MGR',   'مدير فرع',              'Branch Manager',      4,  'management', 'manager'),
  ('jt-shift-sup',    'SHIFT_SUP',    'مشرف وردية',            'Shift Supervisor',    5,  'operations', 'manager'),
  ('jt-chef-head',    'CHEF_HEAD',    'رئيس الطباخين',         'Head Chef',           5,  'kitchen',    'manager'),
  ('jt-accountant',   'ACCOUNTANT',   'محاسب',                 'Accountant',          6,  'finance',    'custody'),
  ('jt-hr-officer',   'HR_OFFICER',   'مسؤول موارد بشرية',     'HR Officer',          6,  'hr',         'manager'),
  ('jt-sr-cashier',   'SR_CASHIER',   'كاشير أول',             'Senior Cashier',      6,  'operations', 'cashier'),
  ('jt-wh-keeper',    'WH_KEEPER',    'أمين مستودع',           'Warehouse Keeper',    6,  'warehouse',  'custody'),
  ('jt-cashier',      'CASHIER',      'كاشير',                 'Cashier',             7,  'operations', 'cashier'),
  ('jt-sr-server',    'SR_SERVER',    'نادل أول',              'Senior Server',       7,  'operations', 'employee'),
  ('jt-chef-sous',    'CHEF_SOUS',    'طاهٍ ثانٍ',             'Sous Chef',           7,  'kitchen',    'employee'),
  ('jt-it-tech',      'IT_TECH',      'فني تقنية',             'IT Technician',       7,  'it',         'employee'),
  ('jt-server',       'SERVER',       'نادل',                  'Server',              8,  'operations', 'employee'),
  ('jt-cook',         'COOK',         'طاهٍ',                  'Cook',                8,  'kitchen',    'employee'),
  ('jt-stocktaker',   'STOCKTAKER',   'جردة',                  'Stocktaker',          8,  'warehouse',  'employee'),
  ('jt-kitchen-help', 'KITCHEN_HELP', 'مساعد مطبخ',            'Kitchen Helper',      9,  'kitchen',    'employee'),
  ('jt-delivery',     'DELIVERY',     'سائق توصيل',            'Delivery Driver',     9,  'operations', 'employee'),
  ('jt-cleaner',      'CLEANER',      'عامل نظافة',            'Cleaner',             10, 'support',    'employee');

-- ─── C. People-record columns on `users` ────────────────────────────
-- All nullable so existing rows stay valid.  Wave 2 (0005) will start
-- enforcing presence on insert/update; Wave 3 (0006) will FK the
-- employee link.
--
-- Tier A.2 corrective gate, Section 6 — REWRITTEN for real idempotency.
-- `ADD COLUMN IF NOT EXISTS` is NOT valid MySQL 8 syntax (verified
-- directly against this repo's MySQL 8.4.9 — a MariaDB-ism, the comment
-- this replaced was wrong) — it fails with a parse error, not silently
-- tolerated. Discovered empirically via tests/integration/
-- migrationLifecycle.test.js's real-runner "existing DB" scenario. Every
-- ADD COLUMN / CREATE INDEX below is now guarded by a real
-- INFORMATION_SCHEMA check via PREPARE/EXECUTE dynamic SQL (same pattern
-- as db/migrations/0002_sales_numbering.sql) — genuinely idempotent and
-- resumable after a partial failure, not "ignore the duplicate-name error
-- by hand on rerun".
-- Tier A.3 Release Gate — `AFTER email` assumed `users.email` already
-- exists, but db/schema.sql's baseline `users` table (the ONLY schema a
-- genuinely fresh `db:init` produces, before server.js's legacy
-- runMigrations() ever runs) never had an `email` column — it's added only
-- by server.js's own addColumnIfMissing('users','email',...). On a database
-- that only ever went through db:init -> db:migrate (the real release
-- sequence, proven end-to-end for the first time by this gate), this AFTER
-- reference doesn't exist and the ALTER hard-fails. Made conditional: use
-- the nice positioning when `email` is already there (the common case,
-- almost every real environment), fall back to a plain ADD COLUMN otherwise
-- — purely cosmetic column ordering either way, never a functional change.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'iqama_number');
SET @email_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email');
SET @stmt = IF(@col_exists = 0,
  IF(@email_exists = 0, 'ALTER TABLE users ADD COLUMN iqama_number VARCHAR(30) NULL', 'ALTER TABLE users ADD COLUMN iqama_number VARCHAR(30) NULL AFTER email'),
  'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'iban');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN iban VARCHAR(50) NULL AFTER iqama_number', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'job_title_code');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN job_title_code VARCHAR(30) NULL AFTER iban', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'full_name');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN full_name VARCHAR(200) NULL AFTER job_title_code', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Indexes for the new columns — searched in the user-listing UI.
SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_iqama_number');
SET @stmt = IF(@idx_exists = 0, 'CREATE INDEX idx_users_iqama_number ON users (iqama_number)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_job_title_code');
SET @stmt = IF(@idx_exists = 0, 'CREATE INDEX idx_users_job_title_code ON users (job_title_code)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
