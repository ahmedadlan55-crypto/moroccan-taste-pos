-- ─── Contact master data (ZATCA-style) ──────────────────────────────────────
-- Additive only. Structured address + explicit VAT-registration flag + default
-- GL account/cost-center dimensions for customers (sales side) and suppliers
-- (purchase side), plus a new supplier_beneficiaries table (the supplier's OWN
-- bank details for direct-transfer payment — distinct from `bank_accounts`,
-- which holds the company's own accounts under GL 1102).
--
-- Tier A.2 corrective gate, Section 6 — the claim below that this file "is
-- not executed by a standalone runner" was FALSE: db/migrate.js's
-- _listMigrationFiles() matches any `NNNN_name.sql` directly under
-- db/migrations/ (this file included) and WILL attempt to run it. `ADD
-- COLUMN IF NOT EXISTS` is also not valid MySQL 8 syntax (a parse error,
-- not silently tolerated — verified directly, and empirically via
-- tests/integration/migrationLifecycle.test.js's real-runner scenario,
-- which is exactly what caught this). Rewritten with the same
-- INFORMATION_SCHEMA + PREPARE/EXECUTE guard pattern as
-- 0002_sales_numbering.sql — genuinely idempotent whether server.js's
-- legacy boot path already created these columns or not.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'vat_registered');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN vat_registered TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'street');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN street VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'building_number');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN building_number VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'district');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN district VARCHAR(120) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'additional_no');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN additional_no VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'postal_code');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN postal_code VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'default_revenue_account_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN default_revenue_account_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'default_revenue_cost_center_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN default_revenue_cost_center_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'vat_registered');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN vat_registered TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'street');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN street VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'building_number');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN building_number VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'district');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN district VARCHAR(120) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'additional_no');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN additional_no VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'postal_code');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN postal_code VARCHAR(10) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'default_expense_account_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN default_expense_account_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'default_expense_cost_center_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN default_expense_cost_center_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS supplier_beneficiaries (
  id             VARCHAR(50) NOT NULL PRIMARY KEY,
  supplier_id    VARCHAR(50) NOT NULL,
  bank_name      VARCHAR(150) NOT NULL,
  account_name   VARCHAR(150) NULL,
  account_number VARCHAR(50) NULL,
  iban           VARCHAR(34) NULL,
  is_primary     TINYINT(1) NOT NULL DEFAULT 0,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_by     VARCHAR(64) NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_supplier (supplier_id),
  CONSTRAINT fk_sb_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
