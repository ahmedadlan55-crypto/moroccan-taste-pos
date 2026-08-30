-- The immutable valued movement ledger.
--
-- ─── WHAT IT IS FOR ─────────────────────────────────────────────────────────
-- Historical inventory valuation, the valued stock card, the value roll-forward
-- and NRV all need one thing this system has never had: the COST of a movement
-- as it stood WHEN THE MOVEMENT HAPPENED. `inventory_movements` records
-- quantity only, and `warehouse_stock.avg_cost` is today's average — so a
-- quantity that moved in March cannot be priced at March's cost, and every
-- "historical" valuation was really today's cost applied to an old quantity.
-- That is why those reports were kept out of the catalogue rather than shipped
-- wrong.
--
-- ─── WHY IT IS PROJECTED, NOT WRITTEN BY THE CALLERS ────────────────────────
-- `INSERT INTO inventory_movements` appears at THIRTY-SIX sites across ten
-- files. There is no choke point. A ledger wired into each of them would be
-- complete only for as long as every future contributor remembered — and a
-- valued ledger with silent holes is worse than no ledger at all, because the
-- reports built on it are trusted precisely when they are wrong.
--
-- So the ledger is PROJECTED from `inventory_movements.seq`, a monotonic
-- auto-increment. Completeness becomes structural: whatever path wrote the
-- movement, the projector sees it. The watermark below is the only state.
--
-- ─── FORWARD-ONLY, AND HONEST ABOUT IT ──────────────────────────────────────
-- Rows before activation are NOT back-filled. Their cost at the time is not
-- recoverable — inventing it would be exactly the fabrication this ledger
-- exists to end. `activated_seq` records where truth begins, and reports refuse
-- a date earlier than `activated_at` instead of quietly reporting a partial
-- period as if it were whole.
--
-- ─── IMMUTABILITY ───────────────────────────────────────────────────────────
-- Rows are inserted, never updated or deleted. A correction is a NEW row that
-- points at what it reverses (`reverses_ledger_id`) — the same «لا حذف — بل
-- عكس» rule the general ledger follows. `uq_ivl_movement_seq` makes the
-- projector idempotent: replaying a batch cannot double-count.

CREATE TABLE IF NOT EXISTS inventory_value_ledger (
  id                VARCHAR(64)  NOT NULL,
  -- The source watermark. UNIQUE: this is what makes the projector safe to
  -- re-run, and re-running is the normal recovery path.
  movement_seq      BIGINT       NOT NULL,
  movement_id       VARCHAR(50)  NOT NULL,
  movement_at       DATETIME     NOT NULL,
  -- The period the value belongs to, frozen at projection time. Deriving it at
  -- read time from movement_at would silently re-file rows if the period
  -- calendar ever changed.
  accounting_period CHAR(7)      NOT NULL,
  item_id           VARCHAR(50)  NOT NULL,
  warehouse_id      VARCHAR(50)  NULL,
  direction         ENUM('in','out') NOT NULL,
  quantity          DECIMAL(18,4) NOT NULL,
  unit_cost         DECIMAL(18,6) NOT NULL,
  extended_value    DECIMAL(18,2) NOT NULL,
  -- HOW the unit cost was determined, stored per row. A ledger that records a
  -- number without recording where it came from cannot be audited, and the two
  -- bases are not equally strong.
  cost_basis        VARCHAR(32)  NOT NULL,
  source_type       VARCHAR(50)  NULL,
  source_id         VARCHAR(100) NULL,
  reverses_ledger_id VARCHAR(64) NULL,
  actor             VARCHAR(100) NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ivl_movement_seq (movement_seq),
  KEY ix_ivl_period (accounting_period),
  KEY ix_ivl_item_wh_at (item_id, warehouse_id, movement_at),
  KEY ix_ivl_at (movement_at),
  KEY ix_ivl_reverses (reverses_ledger_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row, id = 'default'. Keeping the watermark in its own table rather than
-- in `settings` means the projector's cursor cannot be edited by a settings
-- screen that has no idea what it is.
CREATE TABLE IF NOT EXISTS inventory_value_ledger_state (
  id            VARCHAR(20)  NOT NULL,
  -- Where truth begins. Movements at or below this seq predate the ledger and
  -- are deliberately absent.
  activated_seq BIGINT       NOT NULL,
  activated_at  DATETIME     NOT NULL,
  -- How far the projector has read. Never goes backwards.
  cursor_seq    BIGINT       NOT NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activate at the CURRENT high-water mark, so the ledger starts empty and
-- honest rather than back-filled with today's costs wearing old dates.
-- COALESCE(MAX(seq),0) handles a fresh database with no movements at all.
INSERT INTO inventory_value_ledger_state (id, activated_seq, activated_at, cursor_seq)
SELECT 'default', COALESCE(MAX(seq), 0), NOW(), COALESCE(MAX(seq), 0)
  FROM inventory_movements
 WHERE NOT EXISTS (SELECT 1 FROM inventory_value_ledger_state WHERE id = 'default');
