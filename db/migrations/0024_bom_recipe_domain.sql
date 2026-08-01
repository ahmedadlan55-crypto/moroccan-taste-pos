-- ════════════════════════════════════════════════════════════════════
-- 0024_bom_recipe_domain.sql
-- ────────────────────────────────────────────────────────────────────
-- Turn `bom` + `bom_lines` into a real, versioned recipe domain so one
-- unified API can own them (today two endpoints write the same two tables
-- with different rules — routes/menu.js POST /:id/recipe-bom divides the
-- cost by yield, routes/erp-core.js POST /bom does not and additionally
-- TRUSTS a `recomputedCost` sent by the browser).
--
-- WHAT THIS ADDS AND WHY EACH COLUMN EXISTS
--
--   bom.status            draft | active | archived. `is_active` is a
--                         boolean and cannot express "superseded revision
--                         kept for history". Backfilled FROM is_active so
--                         no existing recipe changes meaning.
--   bom.revision_of       the BOM this row was cloned from. Approved
--                         recipes are never edited in place; editing one
--                         mints a new row with version+1 and this pointer,
--                         which is what makes "compare versions" possible.
--   bom.row_version       OPTIMISTIC LOCK, deliberately NOT the same thing
--                         as `bom.version`. `version` is the BUSINESS
--                         recipe version the user sees (v1, v2, v3);
--                         row_version increments on every write of a given
--                         row and is what expectedVersion is checked
--                         against. Conflating them would make a concurrent
--                         edit look like a new recipe revision.
--   bom.needs_review      drives the "وصفات تحتاج مراجعة" KPI + filter.
--   bom.cost_batch /      server-computed cost cache so the catalog list
--   bom.cost_per_unit /   can sort/filter on cost and Food-Cost% without
--   bom.cost_computed_at  recomputing N recipes per page. Never trusted as
--                         input — only ever written by the server after it
--                         recomputes from bom_lines.
--   bom.yield_unit_id     registered unit (item_units.id) for the yield,
--                         alongside the legacy free-text `yield_unit`.
--   bom.created_by/updated_by/updated_at/approved_by/approved_at
--                         the recipe had NO authorship trail at all.
--
--   bom_lines.line_no                 stable display order (there was none;
--                                     the UI order depended on row id).
--   bom_lines.entered_unit_id         registered unit the user actually
--   bom_lines.entered_unit_code       typed in (item_units), replacing the
--   bom_lines.conversion_factor       free-text `unit VARCHAR(20)`.
--   bom_lines.base_quantity           quantity in the component's BASE unit
--                                     = quantity x conversion_factor. All
--                                     costing/issuing reads base_quantity.
--                                     The factor is SNAPSHOTTED on the line
--                                     so re-defining a unit later can never
--                                     silently restate an existing recipe.
--   bom_lines.notes                   per-component preparation note.
--
-- DUPLICATE-COMPONENT CANONICALIZATION (the reason for the two DML
-- statements below): nothing ever stopped the same component being added
-- twice to one recipe. Downstream that is not cosmetic — routes/inventory-
-- production.js builds its issue plan with
--   `new Map(planRows.map(r => [r.item_id, r]))`
-- which keeps only the LAST row, so the first duplicate's planned quantity
-- silently vanishes from the over-issue check. Duplicates are folded here.
--
-- The fold is EXACT and preserves both quantities that matter:
--   net   = SUM(quantity)                               (kept as quantity)
--   gross = SUM(quantity * (1 + waste_pct/100))         (waste-inclusive)
--   waste_pct is then re-derived as (gross/net - 1)*100 so the expanded
--   material demand after the fold equals the demand before it, to the
--   stored precision. Folding is restricted to rows that share the SAME
--   `unit` string — summing "2 kg" into "3 g" would be arithmetic
--   nonsense, so cross-unit duplicates are deliberately left alone.
--
-- The UNIQUE key is therefore added CONDITIONALLY (only if zero duplicate
-- groups remain). A release must never fail closed on pre-existing dirty
-- data, and the unified API canonicalizes on EVERY write regardless — the
-- index is defence in depth, not the primary guarantee.
--
-- Guard style per db/migrations/README.md rule 3: INFORMATION_SCHEMA +
-- PREPARE/EXECUTE, because server.js's legacy runMigrations() boot path
-- adds columns to the same tables and unguarded DDL would collide.
-- ════════════════════════════════════════════════════════════════════

-- ─── bom: lifecycle + authorship + optimistic lock + cost cache ────────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'status');
SET @s = IF(@c = 0, "ALTER TABLE bom ADD COLUMN status ENUM('draft','active','archived') NOT NULL DEFAULT 'draft'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'revision_of');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN revision_of VARCHAR(50) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'row_version');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN row_version INT NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'needs_review');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN needs_review TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'cost_batch');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN cost_batch DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'cost_per_unit');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN cost_per_unit DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'cost_computed_at');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN cost_computed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'yield_unit_id');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN yield_unit_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'created_by');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN created_by VARCHAR(100) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'updated_by');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN updated_by VARCHAR(100) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'updated_at');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'approved_by');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN approved_by VARCHAR(100) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND COLUMN_NAME = 'approved_at');
SET @s = IF(@c = 0, 'ALTER TABLE bom ADD COLUMN approved_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─── bom_lines: registered units + saved conversion factor + order ─────

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'line_no');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN line_no INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'entered_unit_id');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN entered_unit_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'entered_unit_code');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN entered_unit_code VARCHAR(30) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'conversion_factor');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN conversion_factor DECIMAL(18,6) NOT NULL DEFAULT 1.000000', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'base_quantity');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN base_quantity DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND COLUMN_NAME = 'notes');
SET @s = IF(@c = 0, 'ALTER TABLE bom_lines ADD COLUMN notes VARCHAR(300) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─── Backfill (all WHERE-scoped, so re-running is a no-op) ─────────────

-- status mirrors the boolean it replaces: active recipes stay active,
-- inactive ones become archived (NOT draft — they were real, published
-- recipes that were switched off, and calling them drafts would resurrect
-- them into the "unfinished work" KPI).
UPDATE bom SET status = 'active'   WHERE status = 'draft' AND COALESCE(is_active, 1) = 1;
UPDATE bom SET status = 'archived' WHERE status = 'draft' AND COALESCE(is_active, 1) = 0;

-- Legacy lines were authored in a free-text unit with no factor. Factor 1
-- + base_quantity = quantity reproduces EXACTLY today's expansion maths
-- (`quantity * batches * (1 + waste_pct/100)`), so no existing production
-- order or recipe cost changes value. Re-entering the line through the new
-- UI is what upgrades it to a registered unit.
UPDATE bom_lines SET base_quantity = quantity WHERE base_quantity IS NULL;
UPDATE bom_lines SET entered_unit_code = unit WHERE entered_unit_code IS NULL AND unit IS NOT NULL AND unit <> '';

-- ─── Duplicate-component fold (same unit only — see header) ────────────
-- Both statements use a GROUP BY derived table, which MySQL cannot merge
-- into the outer query and therefore materializes; that is what makes
-- updating/deleting from the same table legal here (no ER_UPDATE_TABLE_USED).

UPDATE bom_lines bl
JOIN (
  SELECT MIN(id) AS keep_id,
         SUM(quantity) AS net_qty,
         SUM(quantity * (1 + COALESCE(waste_pct, 0) / 100)) AS gross_qty
  FROM bom_lines
  GROUP BY bom_id, component_item_id, unit
  HAVING COUNT(*) > 1
) d ON d.keep_id = bl.id
SET bl.quantity  = d.net_qty,
    bl.base_quantity = d.net_qty * bl.conversion_factor,
    bl.waste_pct = CASE WHEN d.net_qty > 0
                        THEN LEAST(99.99, GREATEST(0, ROUND((d.gross_qty / d.net_qty - 1) * 100, 2)))
                        ELSE 0 END;

DELETE bl FROM bom_lines bl
JOIN (
  SELECT bom_id, component_item_id, unit, MIN(id) AS keep_id
  FROM bom_lines
  GROUP BY bom_id, component_item_id, unit
  HAVING COUNT(*) > 1
) d
  ON  d.bom_id = bl.bom_id
  AND d.component_item_id = bl.component_item_id
  AND ((d.unit IS NULL AND bl.unit IS NULL) OR d.unit = bl.unit)
WHERE bl.id <> d.keep_id;

-- Stable display order for lines that predate line_no.
UPDATE bom_lines SET line_no = 0 WHERE line_no IS NULL;

-- ─── Indexes ──────────────────────────────────────────────────────────

-- The catalog list joins/filters on (product_id, product_source, status).
SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND INDEX_NAME = 'idx_bom_product_source_status');
SET @s = IF(@i = 0, 'ALTER TABLE bom ADD KEY idx_bom_product_source_status (product_id, product_source, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom' AND INDEX_NAME = 'idx_bom_revision_of');
SET @s = IF(@i = 0, 'ALTER TABLE bom ADD KEY idx_bom_revision_of (revision_of)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Where-used ("which recipes consume this item?") scans by component.
SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND INDEX_NAME = 'idx_bom_lines_component');
SET @s = IF(@i = 0, 'ALTER TABLE bom_lines ADD KEY idx_bom_lines_component (component_item_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- CONDITIONAL: only if the fold above left zero duplicate groups. Never
-- fails the release on dirty pre-existing data; the API canonicalizes on
-- every write either way.
SET @dups = (SELECT COUNT(*) FROM (SELECT 1 FROM bom_lines GROUP BY bom_id, component_item_id HAVING COUNT(*) > 1) x);
SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bom_lines' AND INDEX_NAME = 'uq_bom_lines_component');
SET @s = IF(@dups = 0 AND @i = 0, 'ALTER TABLE bom_lines ADD UNIQUE KEY uq_bom_lines_component (bom_id, component_item_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
