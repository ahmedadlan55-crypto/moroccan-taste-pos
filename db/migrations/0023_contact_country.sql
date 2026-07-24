-- ─── Contact country (customers + suppliers) ────────────────────────────────
-- Additive only. ISO 3166-1 alpha-2 `country` code for the searchable
-- country/city pickers on the customer + supplier forms (paired with the
-- server.js boot-path addColumnIfMissing for defence-in-depth). Same idempotent
-- INFORMATION_SCHEMA + PREPARE/EXECUTE guard pattern as 0013_contact_master_data.sql
-- (MySQL 8 has no `ADD COLUMN IF NOT EXISTS`).
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'country');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN country VARCHAR(2) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers' AND COLUMN_NAME = 'country');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE suppliers ADD COLUMN country VARCHAR(2) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
