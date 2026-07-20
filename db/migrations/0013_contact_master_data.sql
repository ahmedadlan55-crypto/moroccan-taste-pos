-- ─── Contact master data (ZATCA-style) ──────────────────────────────────────
-- Additive only. Structured address + explicit VAT-registration flag + default
-- GL account/cost-center dimensions for customers (sales side) and suppliers
-- (purchase side), plus a new supplier_beneficiaries table (the supplier's OWN
-- bank details for direct-transfer payment — distinct from `bank_accounts`,
-- which holds the company's own accounts under GL 1102).
--
-- Applied automatically at boot via addColumnIfMissing()/createTableIfMissing()
-- in server.js runMigrations() — this file documents the same shape for anyone
-- inspecting schema history manually; it is not executed by a standalone runner.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS vat_registered TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS street VARCHAR(200) NULL,
  ADD COLUMN IF NOT EXISTS building_number VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS district VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS additional_no VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS default_revenue_account_id VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS default_revenue_cost_center_id VARCHAR(50) NULL;

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS vat_registered TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS street VARCHAR(200) NULL,
  ADD COLUMN IF NOT EXISTS building_number VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS district VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS additional_no VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS default_expense_account_id VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS default_expense_cost_center_id VARCHAR(50) NULL;

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
