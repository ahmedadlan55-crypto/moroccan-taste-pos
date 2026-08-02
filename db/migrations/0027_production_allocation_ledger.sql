-- ════════════════════════════════════════════════════════════════════
-- 0027_production_allocation_ledger.sql
-- ────────────────────────────────────────────────────────────────────
-- THE PARTIAL-OUTPUT GENEALOGY BUG, and the ledger that fixes it.
--
-- routes/inventory-production.js record-output does this, once per output
-- event (lines ~737-741 before this change):
--
--     const [comp] = await conn.query(
--       'SELECT lot_id, qty FROM work_order_lot_consumption WHERE work_order_id=?', [id]);
--     for (const cl of comp)
--       INSERT INTO production_output_lots (... output_lot_id, component_lot_id, qty)
--                                    VALUES (... rcv.lotId,    cl.lot_id,        cl.qty)
--
-- It reads the WHOLE order's consumption and stamps ALL of it against THIS
-- output's lot. Three partial outputs against one order therefore record
-- three times the material that was actually consumed, and every one of
-- them claims 100% of every component lot. Traceability inverts: a recall
-- on one component lot implicates every output lot, and the quantities in
-- production_output_lots no longer reconcile with
-- work_order_lot_consumption at all.
--
-- `production_material_allocations` is the missing ledger: it assigns each
-- consumed quantity to exactly ONE output event, exactly ONCE.
--
--   UNIQUE (output_event_id, issue_line_id, component_lot_id)
--     one row per (output, source line, lot) — a replayed request cannot
--     double-allocate.
--
--   SUM(qty) per (production_order_id, issue_line_id, component_lot_id)
--     can never exceed what that issue line actually consumed. That is the
--     invariant the engine enforces before inserting, and the one the
--     integration test asserts across several partial outputs.
--
-- ALLOCATION RULE (deliberately the SAME denominator the cost engine
-- already uses in productionEngine.priceOutputEvent, so genealogy and
-- money can never disagree):
--
--     remainingExpected = max(planned - producedSoFar - wasteSoFar, eventQty)
--     eventShare        = eventQty / remainingExpected            ∈ (0, 1]
--     allocateᵢ         = remainingUnallocatedᵢ x eventShare
--
-- and the FINAL output event of an order (completion/close) sweeps the
-- whole remainder, so no consumed unit is ever left unattributed.
--
-- `production_output_lots` (which the detail screen reads for the
-- genealogy tab) is kept, but is now written FROM this ledger — only the
-- allocated quantity, never the order-wide total.
--
-- ALSO IN THIS FILE, because they are the same write path:
--
--  • Joint-output columns on production_output. One output EVENT may now
--    emit several products (0025); rows sharing `output_group_id` are one
--    event, each carrying the bom_outputs row it came from and the share
--    of WIP it was allocated. Existing single-product rows get a group id
--    equal to their own id, so "group by output_group_id" is correct for
--    old and new data alike with no second code path.
--
--  • The waste-override trail. Exceeding the scrap allowance now requires
--    a manager capability AND a recorded reason; the reason has to live
--    somewhere queryable, not only in a free-text audit note.
--
--  • allowed_scrap_pct semantics. productionEngine.wasteAllowanceExceeded
--    reads `Number(allowedScrapPct) || 0; if (pct <= 0) return false` — so
--    0 currently means "NO gate, unlimited waste", which is the exact
--    opposite of what "allowed scrap = 0%" says. The column default
--    becomes NULL ("use the default policy") and every EXISTING row that
--    holds 0 is migrated to NULL. That mapping is not a guess: under the
--    old code 0 was unreachable as a real zero, so 0 has only ever meant
--    "no gate" — writing NULL preserves the observed behaviour of every
--    historical order EXACTLY, while freeing 0 to start meaning zero.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS production_material_allocations (
  id                  VARCHAR(60)  NOT NULL PRIMARY KEY,
  production_order_id VARCHAR(60)  NOT NULL,
  -- production_output.id — the output event this material is attributed to.
  output_event_id     VARCHAR(60)  NOT NULL,
  -- production_issue_events.id / production_issue_lines.id it came from.
  issue_event_id      VARCHAR(60)  NULL,
  issue_line_id       VARCHAR(60)  NOT NULL,
  component_item_id   VARCHAR(50)  NOT NULL,
  -- NULL for untracked components (no lot dimension).
  component_lot_id    VARCHAR(60)  NULL,
  -- inventory_lots.id of the FG lot this output produced, when tracked.
  output_lot_id       VARCHAR(60)  NULL,
  warehouse_id        VARCHAR(50)  NULL,
  qty                 DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  unit_cost           DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pma_order (production_order_id),
  KEY idx_pma_output (output_event_id),
  KEY idx_pma_line (issue_line_id),
  KEY idx_pma_component (component_item_id, component_lot_id),
  -- One row per (output, source line, lot): a replayed record-output can
  -- never allocate the same material twice.
  UNIQUE KEY uq_pma_alloc (output_event_id, issue_line_id, component_lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── production_output: joint outputs + waste-override trail ───────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'output_group_id');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN output_group_id VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'output_type');
SET @s = IF(@c = 0, "ALTER TABLE production_output ADD COLUMN output_type ENUM('primary','co_product','by_product','rework','scrap') NOT NULL DEFAULT 'primary'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'bom_output_id');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN bom_output_id VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'alloc_method');
SET @s = IF(@c = 0, "ALTER TABLE production_output ADD COLUMN alloc_method VARCHAR(20) NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The normalised share of the event's WIP relief this row received
-- (Σ alloc_share over an output_group_id is exactly 1).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'alloc_share');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN alloc_share DECIMAL(12,9) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'alloc_basis');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN alloc_basis DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'waste_reason');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN waste_reason VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'waste_override_by');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN waste_override_by VARCHAR(100) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'waste_override_at');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN waste_override_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The allowance in force when the event was recorded, so a later policy
-- change cannot retroactively make a compliant event look like a breach.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND COLUMN_NAME = 'allowed_scrap_pct_snapshot');
SET @s = IF(@c = 0, 'ALTER TABLE production_output ADD COLUMN allowed_scrap_pct_snapshot DECIMAL(6,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'production_output' AND INDEX_NAME = 'idx_production_output_group');
SET @s = IF(@i = 0, 'ALTER TABLE production_output ADD KEY idx_production_output_group (output_group_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Every pre-existing output row was a single-product event: its own id is
-- its group. "GROUP BY output_group_id" is then correct for old and new
-- rows with no branch anywhere in the reader.
UPDATE production_output SET output_group_id = id WHERE output_group_id IS NULL;
UPDATE production_output SET alloc_share = 1.000000000 WHERE alloc_share IS NULL;

-- ─── allowed_scrap_pct: NULL = default policy, 0 = zero allowed ────────
-- Order matters. Rewrite the DATA first (while the column still defaults
-- to 0 nothing can be inserted in between inside this single-statement
-- runner), then relax the DEFAULT. MODIFY COLUMN is idempotent by nature
-- (README rule 3) so no INFORMATION_SCHEMA guard is needed for it.
UPDATE production_orders SET allowed_scrap_pct = NULL WHERE allowed_scrap_pct = 0;

ALTER TABLE production_orders MODIFY allowed_scrap_pct DECIMAL(6,3) NULL DEFAULT NULL;
