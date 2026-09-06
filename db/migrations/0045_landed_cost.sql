-- 0045_landed_cost.sql — landed cost on goods receipts
--
-- ─── WHY A NUMBERED MIGRATION AND NOT ONLY schema.js ───────────────────────
-- db/migrations/procurement/schema.js is applied by the manual
-- `npm run procurement:migrate` only. The release chain (scripts/release-start
-- .js) runs THIS directory; server.js's boot block never applies the
-- procurement schema. A column declared only in schema.js is green locally and
-- answers `Unknown column` in production (0044 documents the same trap).
-- schema.js keeps its idempotent declaration so the manual script stays
-- consistent; this file is what actually delivers the objects at deploy.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   purchase_receipt_charges        — import charges (freight/customs/insurance/
--                                     handling/other) accrued on a receipt; the
--                                     SINGLE source of truth for the allocation
--   purchase_receipt_lines.landed_* — the per-line allocated charge and the
--                                     landed unit cost that enters WAC/lot;
--                                     NULL (not 0) when the receipt carries no
--                                     charges
--   purchase_receipts.charges_total / landed_total
--   supplier_invoice_lines.receipt_charge_id — a charge vendor's invoice line
--                                     clears GRNI for that charge on approve
--
-- Guarded with INFORMATION_SCHEMA so re-running is a no-op — the same pattern
-- as 0013, 0042 and 0044. CREATE TABLE IF NOT EXISTS is idempotent on its own.

CREATE TABLE IF NOT EXISTS purchase_receipt_charges (
  id VARCHAR(50) NOT NULL PRIMARY KEY,
  receipt_id VARCHAR(50) NOT NULL,
  charge_type ENUM('freight','customs','insurance','handling','other') NOT NULL,
  description VARCHAR(200) NULL,
  supplier_id VARCHAR(50) NULL,
  supplier_name_snapshot VARCHAR(200) NULL,
  amount DECIMAL(14,4) NOT NULL,
  vat_amount DECIMAL(14,4) NOT NULL DEFAULT 0,
  allocation_method ENUM('value','qty') NOT NULL DEFAULT 'value',
  status ENUM('accrued','invoiced') NOT NULL DEFAULT 'accrued',
  supplier_invoice_id VARCHAR(50) NULL,
  created_by VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL,
  INDEX idx_prc_receipt (receipt_id),
  INDEX idx_prc_status (status),
  INDEX idx_prc_invoice (supplier_invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_receipt_lines' AND COLUMN_NAME = 'landed_charge_amount');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE purchase_receipt_lines ADD COLUMN landed_charge_amount DECIMAL(14,4) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_receipt_lines' AND COLUMN_NAME = 'landed_unit_cost');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE purchase_receipt_lines ADD COLUMN landed_unit_cost DECIMAL(14,6) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_receipts' AND COLUMN_NAME = 'charges_total');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE purchase_receipts ADD COLUMN charges_total DECIMAL(14,4) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_receipts' AND COLUMN_NAME = 'landed_total');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE purchase_receipts ADD COLUMN landed_total DECIMAL(14,4) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_invoice_lines' AND COLUMN_NAME = 'receipt_charge_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE supplier_invoice_lines ADD COLUMN receipt_charge_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Invoice approve looks a charge up by its invoice line; without this it scans.
SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_invoice_lines' AND INDEX_NAME = 'idx_sil_receipt_charge');
SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE supplier_invoice_lines ADD INDEX idx_sil_receipt_charge (receipt_charge_id)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
