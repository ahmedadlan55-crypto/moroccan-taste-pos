-- ════════════════════════════════════════════════════════════════════
-- 0015_name_en_backfill.sql
-- ────────────────────────────────────────────────────────────────────
-- Owner D — bilingual-i18n-images. Adds provenance tracking for
-- menu.name_en so the backfill worker (lib/name-en-backfill-worker.js)
-- can tell an owner-authored English name apart from a machine-derived
-- one, and gives a manager a queue to review/approve machine-derived
-- names.
--
-- WHAT THIS MIGRATION DOES:
--   1) menu.name_en_source        — NULL means "owner typed this via the
--      existing ERP field" (or never touched by the backfill pipeline).
--      Any non-NULL value means a worker wrote it and it needs the
--      provenance recorded. This NULL-vs-set distinction is the whole
--      safety mechanism: the worker refuses to overwrite a row whose
--      name_en is non-empty AND name_en_source IS NULL.
--   2) menu.name_en_needs_review  — set 1 whenever a machine-derived
--      name is written, so the admin UI can surface a review queue.
--   3) menu.name_en_reviewed_by / _at — left for the (separately owned)
--      review UI to stamp when a manager confirms/edits a machine name.
--   4) name_en_backfill_queue     — the worker's job queue. One row per
--      menu item awaiting (or having received) a name_en backfill
--      attempt. Populated by scripts/name-en-backfill-sweep.js.
--
-- WHY THIS IS SAFE:
--   • Purely additive — no existing menu column, table, or row is
--     touched. Every new menu column is NULLable or defaults to 0.
--   • The worker's UPDATE statement (see lib/name-en-backfill-worker.js)
--     only ever assigns name_en / name_en_source / name_en_needs_review
--     — it cannot reach price, stock, name, tax_category, category,
--     cost, or any recipe table by construction.
--
-- WIRING NOTES for the server.js migration-wiring stage — server.js's
-- own runMigrations() (its ad-hoc addColumnIfMissing/createTableIfMissing
-- calls), NOT db/migrate.js's versioned runner, is what actually executes
-- on every boot today (see the existing `addColumnIfMissing('menu',
-- 'name_en', ...)` call). Until this file is copied in there (or
-- db/migrate.js's runPendingMigrations() is wired into boot), this schema
-- — and therefore lib/name-en-backfill-worker.js and
-- scripts/name-en-backfill-sweep.js, neither of which self-migrate,
-- matching lib/zatca-worker.js's own assumption that its queue table
-- already exists — will not exist on a deployed instance. Copy verbatim:
--
--   await addColumnIfMissing('menu', 'name_en_source', "ENUM('owner','machine_translation','transliteration') NULL");
--   await addColumnIfMissing('menu', 'name_en_needs_review', "TINYINT(1) NOT NULL DEFAULT 0");
--   await addColumnIfMissing('menu', 'name_en_reviewed_by', "VARCHAR(100) NULL");
--   await addColumnIfMissing('menu', 'name_en_reviewed_at', "DATETIME NULL");
--   await createTableIfMissing('name_en_backfill_queue', `
--     CREATE TABLE name_en_backfill_queue (
--       id VARCHAR(50) PRIMARY KEY,
--       menu_id VARCHAR(50) NOT NULL,
--       status ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
--       attempt_count INT NOT NULL DEFAULT 0,
--       next_attempt_at DATETIME NOT NULL,
--       last_error VARCHAR(1000) NULL,
--       source_used ENUM('machine_translation','transliteration') NULL,
--       proposed_name_en VARCHAR(200) NULL,
--       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--       INDEX idx_nebq_status (status, next_attempt_at)
--     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
--   `);
--
-- ...and start the worker at boot (see server.js's existing
-- `require('./lib/zatca-worker').start()` right after `app.listen(...)`):
--
--   try { require('./lib/name-en-backfill-worker').start(); }
--   catch (e) { console.warn('[name-en-backfill-worker] failed to start:', e.message); }
--
-- Tier A.2 corrective gate, Section 6 — the claim above ("until this file
-- is copied in there") was FALSE: server.js's runMigrations() already has
-- all 4 addColumnIfMissing('menu', 'name_en_*', ...) calls wired in (same
-- stale-comment pattern found in 0013/0014/0017). Since `menu` is a
-- baseline-schema table (exists before runMigrations() runs), server.js's
-- boot reliably adds these columns first — so this file's plain multi-
-- clause ALTER TABLE would hit "Duplicate column name" the moment
-- db/migrate.js runs against a DB that already booted once. Same
-- INFORMATION_SCHEMA + PREPARE/EXECUTE guard pattern as
-- 0002_sales_numbering.sql, one guard per column since MySQL's dynamic SQL
-- can't parameterize a multi-clause ALTER conditionally in one PREPARE.
-- ════════════════════════════════════════════════════════════════════

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'name_en_source');
SET @stmt = IF(@col_exists = 0, "ALTER TABLE menu ADD COLUMN name_en_source ENUM('owner','machine_translation','transliteration') NULL", 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'name_en_needs_review');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE menu ADD COLUMN name_en_needs_review TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'name_en_reviewed_by');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE menu ADD COLUMN name_en_reviewed_by VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'name_en_reviewed_at');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE menu ADD COLUMN name_en_reviewed_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS name_en_backfill_queue (
  id                VARCHAR(50)  NOT NULL PRIMARY KEY,
  menu_id           VARCHAR(50)  NOT NULL,
  status            ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
  attempt_count     INT NOT NULL DEFAULT 0,
  next_attempt_at   DATETIME NOT NULL,
  last_error        VARCHAR(1000) NULL,
  source_used       ENUM('machine_translation','transliteration') NULL,
  proposed_name_en  VARCHAR(200) NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_nebq_status (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
