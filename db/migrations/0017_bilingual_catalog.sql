-- ════════════════════════════════════════════════════════════════════
-- 0013_bilingual_catalog.sql
-- ────────────────────────────────────────────────────────────────────
-- Owner A — bilingual-i18n-images. Catalog bilingual (AR/EN) contract:
-- a category-name overlay table, plus nullable English names on
-- price_lists / brands / branches so the pricing + ERP identity layer
-- can carry an English name alongside the Arabic one, same as
-- customers.name_en / suppliers.name_en / gl_accounts.name_en / etc.
--
-- WIRING NOTES for the server.js migration-wiring stage — copy the
-- following verbatim into runMigrations() (see server.js's existing
-- addColumnIfMissing / createTableIfMissing calls, e.g. right next to
-- `addColumnIfMissing('menu', 'name_en', ...)`):
--
--   await addColumnIfMissing('price_lists', 'name_en', "VARCHAR(200) DEFAULT NULL");
--   await addColumnIfMissing('brands',      'name_en', "VARCHAR(200) DEFAULT NULL");
--   await addColumnIfMissing('branches',    'name_en', "VARCHAR(200) DEFAULT NULL");
--
--   await createTableIfMissing('menu_category_i18n', `
--     CREATE TABLE menu_category_i18n (
--       category_ar VARCHAR(100) PRIMARY KEY,
--       category_en VARCHAR(100) NULL,
--       updated_by VARCHAR(100) NULL,
--       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
--     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--   `);
--
-- NOT included above — already LIVE via existing server.js migrations,
-- verified against the running schema, no action needed:
--   menu.name_en            — addColumnIfMissing('menu', 'name_en', ...) already exists
--   sales_channels.name_en  — already part of the sales_channels CREATE TABLE
--   item_units.unit_id      — already part of the item_units CREATE TABLE
--                              (nullable, references units.id; units.name_en
--                              already exists on the `units` master table)
--
-- Until the wiring stage lands, routes/pos-v2.js stays self-sufficient: its
-- existing `_ensureSchema()` (INFORMATION_SCHEMA-guarded, same convention as
-- routes/sales-channels.js `_ensureUseFullMenuColumn`) also ensures
-- menu_category_i18n itself at startup/first-request. price_lists.name_en /
-- brands.name_en / branches.name_en are NOT self-migrated anywhere — until
-- this file (or the wiring stage) is applied, routes/erp/brands.js and
-- routes/erp/branches-full.js simply fall back to writing/reading without
-- those columns (see the try/catch-fallback-for-older-schema pattern already
-- in brands.js, now extended to name_en too).
--
-- This file is the readable reference / fresh-install supplement — NOT the
-- live migration path for the columns above.
-- ════════════════════════════════════════════════════════════════════

-- ─── menu_category_i18n — AR→EN category-name overlay. menu.category stays
--     the Arabic canonical key (free-text, no FK); this table is a sparse
--     lookup that only needs a row for categories an owner has translated. ───
CREATE TABLE IF NOT EXISTS menu_category_i18n (
  category_ar VARCHAR(100) PRIMARY KEY,
  category_en VARCHAR(100) NULL,
  updated_by VARCHAR(100) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── price_lists / brands / branches — nullable English names ───
-- Tier A.2 corrective gate, Section 6 — this file's own header claimed it
-- is "NOT the live migration path... a reference/fresh-install supplement",
-- but db/migrate.js's real runner does not know or care about that claim:
-- _listMigrationFiles() matches any NNNN_name.sql directly under
-- db/migrations/ (this file included) and WILL attempt to run it — and
-- WILL be re-run/collide if server.js's addColumnIfMissing() path or
-- routes/pos-v2.js's self-sufficient _ensureSchema() already added these
-- columns first, a real possible race depending on deployment order.
-- Discovered via the same real-runner test that caught 0002/0004/0005/0013.
-- Same INFORMATION_SCHEMA + PREPARE/EXECUTE guard pattern for consistency.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_lists' AND COLUMN_NAME = 'name_en');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE price_lists ADD COLUMN name_en VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'brands' AND COLUMN_NAME = 'name_en');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE brands ADD COLUMN name_en VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'name_en');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE branches ADD COLUMN name_en VARCHAR(200) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
