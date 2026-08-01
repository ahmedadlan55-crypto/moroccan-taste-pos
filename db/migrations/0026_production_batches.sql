-- ════════════════════════════════════════════════════════════════════
-- 0026_production_batches.sql
-- ────────────────────────────────────────────────────────────────────
-- ONE production document that covers a day's / a run's worth of SEVERAL
-- INDEPENDENT products.
--
-- What exists today (routes/warehouse-ops.js POST /production-orders,
-- lines 1364-1419) accepts an `items` array and, for each entry, runs an
-- unwrapped `db.query` INSERT in a bare `for` loop. There is no
-- transaction, malformed entries are silently `continue`d, and the handler
-- then returns `{ success: true, orders, count }`. So "create 5 orders"
-- can persist 2, skip 3 without naming them, and report success. That is
-- the partial-success path this table replaces.
--
-- MODEL — and the distinction that the whole design turns on:
--
--   production_batches  ONE header. A batch groups N production_orders
--                       that are INDEPENDENT: each child keeps its own
--                       bom_id + version, its own qty, its own source and
--                       output warehouse, and CRUCIALLY its own
--                       wip_balance and its own cost. A batch never pools
--                       cost across children.
--
--   co-products         the opposite case, and NOT this table: outputs
--                       that genuinely share one pool of consumed material
--                       live in `bom_outputs` (0025) inside a SINGLE
--                       production order. Keeping the two apart is what
--                       stops unrelated products being averaged into one
--                       cost bucket.
--
-- ATOMICITY: batch approve/post is all-or-nothing across children. The
-- header carries its own `version` for optimistic locking so a second
-- approver gets VERSION_CONFLICT instead of double-posting, and
-- `posting_state` records where a run got to, so a crash between children
-- is observable rather than being silently reported as success.
--
-- The child link is a nullable column on production_orders: every existing
-- order (legacy and V2) simply has batch_id NULL and behaves exactly as
-- before. Nothing about the single-order path changes.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS production_batches (
  id                  VARCHAR(60)  NOT NULL PRIMARY KEY,
  batch_number        VARCHAR(40)  NOT NULL,
  batch_date          DATE         NULL,
  status              ENUM('draft','approved','in_progress','completed','closed','cancelled','reversed')
                        NOT NULL DEFAULT 'draft',
  warehouse_id        VARCHAR(50)  NULL,
  output_warehouse_id VARCHAR(50)  NULL,
  brand_id            VARCHAR(50)  NULL,
  branch_id           VARCHAR(50)  NULL,
  notes               TEXT         NULL,
  -- Optimistic lock for the header (expectedVersion / If-Match).
  version             INT          NOT NULL DEFAULT 1,
  -- Where a multi-child transition got to. 'idle' between operations;
  -- anything else at rest means a run did not finish and the document
  -- must NOT be reported as successful.
  posting_state       ENUM('idle','approving','posting','failed') NOT NULL DEFAULT 'idle',
  posting_error       VARCHAR(500) NULL,
  child_count         INT          NOT NULL DEFAULT 0,
  created_by          VARCHAR(100) NULL,
  created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  approved_by         VARCHAR(100) NULL,
  approved_at         DATETIME     NULL,
  completed_by        VARCHAR(100) NULL,
  completed_at        DATETIME     NULL,
  closed_by           VARCHAR(100) NULL,
  closed_at           DATETIME     NULL,
  cancelled_by        VARCHAR(100) NULL,
  cancelled_at        DATETIME     NULL,
  cancel_reason       VARCHAR(500) NULL,
  reversed_by         VARCHAR(100) NULL,
  reversed_at         DATETIME     NULL,
  reverse_reason      VARCHAR(500) NULL,
  UNIQUE KEY uq_production_batches_number (batch_number),
  KEY idx_production_batches_status_date (status, batch_date),
  KEY idx_production_batches_wh (warehouse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-day serial for PBT- numbers, mirroring `production_counter`.
CREATE TABLE IF NOT EXISTS production_batch_counter (
  ymd         CHAR(8) NOT NULL PRIMARY KEY,
  last_serial INT     NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Child link on production_orders ──────────────────────────────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_orders' AND COLUMN_NAME = 'batch_id');
SET @s = IF(@c = 0, 'ALTER TABLE production_orders ADD COLUMN batch_id VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_orders' AND COLUMN_NAME = 'batch_line_no');
SET @s = IF(@c = 0, 'ALTER TABLE production_orders ADD COLUMN batch_line_no INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The BOM version the order was expanded against. Without this an order
-- created from recipe v2 becomes indistinguishable from one created from
-- v3 the moment the recipe is revised, and the variance report silently
-- compares actuals to the WRONG plan.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_orders' AND COLUMN_NAME = 'bom_version');
SET @s = IF(@c = 0, 'ALTER TABLE production_orders ADD COLUMN bom_version INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_orders' AND INDEX_NAME = 'idx_production_orders_batch');
SET @s = IF(@i = 0, 'ALTER TABLE production_orders ADD KEY idx_production_orders_batch (batch_id, batch_line_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The operations centre and the production list both filter on
-- output warehouse, which had no index (only warehouse_id did).
SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_orders' AND INDEX_NAME = 'idx_production_orders_out_wh');
SET @s = IF(@i = 0, 'ALTER TABLE production_orders ADD KEY idx_production_orders_out_wh (output_warehouse_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill bom_version for existing orders from the recipe they point at,
-- so pre-existing documents report a version instead of NULL. WHERE-scoped
-- and therefore a no-op on re-run.
UPDATE production_orders po
JOIN bom b ON b.id = po.bom_id
SET po.bom_version = b.version
WHERE po.bom_version IS NULL;
