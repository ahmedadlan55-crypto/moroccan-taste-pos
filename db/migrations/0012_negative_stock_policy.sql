-- ─── Phase W2: Negative-stock policy schema ────────────────────────────────
-- Additive only. Never touches existing tables. Behavioral guard is gated by
-- NEGATIVE_STOCK_POLICY_ENABLED at the engine level. This migration ships the
-- storage so the settings API and the deficit ledger work; behavior remains
-- `block` until the feature flag is flipped.

-- (1) Three-level policy: global / warehouse / item, most-restrictive-wins.
CREATE TABLE IF NOT EXISTS negative_stock_policy (
  id                VARCHAR(40)  NOT NULL PRIMARY KEY,
  scope             ENUM('global','warehouse','item') NOT NULL,
  warehouse_id      VARCHAR(50)  NULL,
  item_id           VARCHAR(50)  NULL,
  policy            ENUM('block','controlled','allow') NOT NULL DEFAULT 'block',
  max_negative_qty  DECIMAL(18,3) NOT NULL DEFAULT 0,
  require_reason    TINYINT(1) NOT NULL DEFAULT 1,
  is_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  version           INT NOT NULL DEFAULT 1,
  created_by        VARCHAR(64) NULL,
  updated_by        VARCHAR(64) NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scope (scope, warehouse_id, item_id),
  KEY idx_warehouse (warehouse_id),
  KEY idx_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the mandatory global-block row iff no global row exists yet.
-- Idempotent: won't insert twice because of uq_scope UNIQUE.
INSERT INTO negative_stock_policy (id, scope, warehouse_id, item_id, policy, max_negative_qty, require_reason, is_enabled, created_by)
SELECT 'NSP-GLOBAL', 'global', NULL, NULL, 'block', 0, 1, 1, 'bootstrap'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM negative_stock_policy WHERE scope='global' AND warehouse_id IS NULL AND item_id IS NULL);

-- (2) Deficit ledger: every controlled/allow issue that took a row negative
-- creates a row here. Lifecycle: open → partial → covered | adjusted.
CREATE TABLE IF NOT EXISTS stock_deficits (
  id                  VARCHAR(40)  NOT NULL PRIMARY KEY,
  warehouse_id        VARCHAR(50)  NOT NULL,
  item_id             VARCHAR(50)  NOT NULL,
  origin_doc_type     VARCHAR(24)  NOT NULL,
  origin_doc_id       VARCHAR(50)  NOT NULL,
  deficit_qty         DECIMAL(18,3) NOT NULL,     -- original size (positive)
  remaining_qty       DECIMAL(18,3) NOT NULL,     -- uncovered part
  unit_cost_at_issue  DECIMAL(18,4) NOT NULL DEFAULT 0,
  reason              VARCHAR(400) NOT NULL,
  status              ENUM('open','partial','covered','adjusted') NOT NULL DEFAULT 'open',
  created_by          VARCHAR(64)  NULL,
  approved_by         VARCHAR(64)  NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at           TIMESTAMP NULL,
  version             INT NOT NULL DEFAULT 1,
  KEY idx_open (status, warehouse_id, item_id),
  KEY idx_origin (origin_doc_type, origin_doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
