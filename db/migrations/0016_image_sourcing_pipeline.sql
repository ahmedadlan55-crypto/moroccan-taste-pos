-- ════════════════════════════════════════════════════════════════════
-- 0016_image_sourcing_pipeline.sql
-- ────────────────────────────────────────────────────────────────────
-- Owner D — bilingual-i18n-images. Schema for the SSRF-safe product
-- image sourcing pipeline (lib/image-sourcing-worker.js +
-- lib/safeImageFetch.js).
--
-- WHAT THIS MIGRATION DOES:
--   1) image_sourcing_jobs    — one row per sourcing run (dry-run or
--      real), with a running total/processed/matched/queued_for_review
--      counter set so progress can be polled without scanning the queue.
--   2) image_sourcing_queue   — one row per menu item being sourced for
--      a given job. Claimed by the worker via SELECT...FOR UPDATE SKIP
--      LOCKED, same shape as every other worker queue in this codebase.
--   3) image_candidates       — a found image is NEVER written straight
--      to menu.image_data. It lands here as a reviewable candidate with
--      full provenance (source, license, attribution, confidence,
--      sha256 + phash for de-duplication) and review_status='pending'.
--      A manager applies it via the existing product-images approval
--      endpoint (owned elsewhere) — this migration only supplies the
--      storage the worker writes to and that endpoint reads from.
--   4) image_sourcing_rollback — captures the PRE-existing image_data
--      for a menu row at the moment a candidate is applied, so an
--      approval can be undone. Written by the (separately owned) apply
--      endpoint, not by this worker.
--
-- WHY THIS IS SAFE:
--   • All four tables are new — nothing here touches `menu` or any
--     other existing table.
--   • uq_candidate_dedupe (menu_id, sha256) makes re-processing the same
--     item idempotent — refetching an identical image is a no-op insert
--     (caught before the INSERT by the worker, and belt-and-suspenders
--     enforced here too).
--   • The worker that populates image_candidates never writes to
--     menu.image_data — see lib/image-sourcing-worker.js.
--
-- WIRING NOTES for the server.js migration-wiring stage — same caveat as
-- 0015: server.js's own runMigrations() (ad-hoc createTableIfMissing
-- calls), not db/migrate.js's versioned runner, is what actually executes
-- on every boot today. Until this file is copied in there, this schema —
-- and therefore lib/image-sourcing-worker.js (which does not self-
-- migrate, matching lib/zatca-worker.js's own assumption that its queue
-- table already exists) — will not exist on a deployed instance. Copy
-- verbatim (createTableIfMissing already no-ops safely if the table
-- exists, so this is safe to run every boot):
--
--   await createTableIfMissing('image_sourcing_jobs', `CREATE TABLE image_sourcing_jobs (...)` /* body = this file's CREATE TABLE */);
--   await createTableIfMissing('image_sourcing_queue', `CREATE TABLE image_sourcing_queue (...)` /* body = this file's CREATE TABLE */);
--   await createTableIfMissing('image_candidates', `CREATE TABLE image_candidates (...)` /* body = this file's CREATE TABLE */);
--   await createTableIfMissing('image_sourcing_rollback', `CREATE TABLE image_sourcing_rollback (...)` /* body = this file's CREATE TABLE */);
--
-- ...and start the worker at boot (see server.js's existing
-- `require('./lib/zatca-worker').start()` right after `app.listen(...)`):
--
--   try { require('./lib/image-sourcing-worker').start(); }
--   catch (e) { console.warn('[image-sourcing-worker] failed to start:', e.message); }
--
-- This file is the readable reference / fresh-install supplement — NOT
-- the live migration path until one of the two wiring options above lands.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS image_sourcing_jobs (
  id                 VARCHAR(50) NOT NULL PRIMARY KEY,
  status             ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  dry_run            TINYINT(1) NOT NULL DEFAULT 1,
  filter_json        LONGTEXT NULL,
  total_items        INT NOT NULL DEFAULT 0,
  processed_items    INT NOT NULL DEFAULT 0,
  matched_items      INT NOT NULL DEFAULT 0,
  queued_for_review  INT NOT NULL DEFAULT 0,
  created_by         VARCHAR(100) NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at        DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS image_sourcing_queue (
  id                VARCHAR(50) NOT NULL PRIMARY KEY,
  job_id            VARCHAR(50) NOT NULL,
  menu_id           VARCHAR(50) NOT NULL,
  status            ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  attempt_count     INT NOT NULL DEFAULT 0,
  next_attempt_at   DATETIME NOT NULL,
  last_error        VARCHAR(1000) NULL,
  INDEX idx_isq_status (status, next_attempt_at),
  INDEX idx_isq_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS image_candidates (
  id               VARCHAR(50) NOT NULL PRIMARY KEY,
  menu_id          VARCHAR(50) NOT NULL,
  job_id           VARCHAR(50) NOT NULL,
  source_provider  VARCHAR(50) NOT NULL,
  source_url       VARCHAR(1000) NOT NULL,
  query_used       VARCHAR(300) NULL,
  license          VARCHAR(100) NULL,
  attribution      VARCHAR(500) NULL,
  author           VARCHAR(200) NULL,
  confidence       DECIMAL(5,4) NOT NULL DEFAULT 0,
  sha256           CHAR(64) NOT NULL,
  phash            CHAR(16) NOT NULL,
  mime             VARCHAR(30) NOT NULL,
  bytes            INT NOT NULL,
  review_status    ENUM('pending','approved','rejected','auto_applied') NOT NULL DEFAULT 'pending',
  reviewer         VARCHAR(100) NULL,
  reviewed_at      DATETIME NULL,
  applied_at       DATETIME NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_candidate_dedupe (menu_id, sha256),
  INDEX idx_ic_phash (phash),
  INDEX idx_ic_review (review_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS image_sourcing_rollback (
  id               VARCHAR(50) NOT NULL PRIMARY KEY,
  menu_id          VARCHAR(50) NOT NULL,
  job_id           VARCHAR(50) NOT NULL,
  prev_image_data  LONGTEXT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
