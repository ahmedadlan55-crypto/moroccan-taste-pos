-- ════════════════════════════════════════════════════════════════════
-- 0025_bom_outputs.sql
-- ────────────────────────────────────────────────────────────────────
-- JOINT PRODUCTION. Until now a recipe could yield exactly one product:
-- `bom.product_id` + `bom.yield_quantity`. That is false for every real
-- butchery/bakery/kitchen process — breaking down a lamb yields cuts,
-- trim, bone and fat simultaneously from ONE pool of cost.
--
-- `bom_outputs` makes the yield a LIST, and each entry declares what kind
-- of output it is:
--
--   primary     the main product. Every BOM has exactly one.
--   co_product  a second saleable product from the same run. Shares the
--               WIP pool and must be allocated a share of it.
--   by_product  a minor output, usually valued at NRV and credited AGAINST
--               the primary's cost rather than carrying its own margin.
--   rework      output that re-enters production as an input.
--   scrap       output with no value; its share of WIP is expensed.
--
-- ALLOCATION METHOD is per-output because a single run legitimately mixes
-- them (a by-product at NRV, two co-products split by weight):
--
--   fixed_pct       alloc_value = percentage of the WIP pool (0..100).
--   standard_cost   alloc_value = standard cost PER BASE UNIT; the output's
--                   basis is qty x alloc_value.
--   weight          alloc_value = weight per base unit; basis is qty x weight.
--   nrv             alloc_value = net realisable value per base unit;
--                   basis is qty x NRV.
--
-- In every case the engine computes basisᵢ, then shareᵢ = basisᵢ / Σbasis,
-- and relieves WIP by shareᵢ. That is what makes the invariant
--     Σ output cost + waste + variance == WIP relieved
-- hold by construction rather than by hope: the shares are normalised to
-- sum to 1 and the last output absorbs the rounding remainder.
--
-- WHY THIS IS SEPARATE FROM "several independent products in one document":
-- co-products come out of ONE pool of consumed material and MUST share it.
-- Two unrelated products made on the same day do NOT — they each own their
-- own materials and their own WIP. Mixing them into one cost bucket is
-- exactly the error this schema prevents: independent products are
-- `production_orders` children of a `production_batch` (0026), each with
-- its own wip_balance; co-products are `bom_outputs` rows inside ONE order.
--
-- BACKWARD COMPATIBILITY: every existing BOM gets a single `primary` row
-- synthesised from bom.product_id / yield_quantity / yield_unit, so the
-- unified reader can treat outputs as the only source of truth without a
-- second code path. `bom.product_id` is left in place and kept in sync by
-- the API (it is still the join key used by the production picker and by
-- routes/inventory-production.js `_expandBom`).
--
-- Guard style per db/migrations/README.md rule 3 + rule 5 (explicit
-- utf8mb4_unicode_ci so a later FK to bom/inv_items cannot hit
-- ER_FK_INCOMPATIBLE_COLUMNS).
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bom_outputs (
  id                VARCHAR(60)  NOT NULL PRIMARY KEY,
  bom_id            VARCHAR(50)  NOT NULL,
  output_type       ENUM('primary','co_product','by_product','rework','scrap') NOT NULL DEFAULT 'primary',
  product_id        VARCHAR(60)  NOT NULL,
  product_source    ENUM('menu','inv') NOT NULL DEFAULT 'inv',
  quantity          DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  entered_unit_id   VARCHAR(50)  NULL,
  entered_unit_code VARCHAR(30)  NULL,
  conversion_factor DECIMAL(18,6) NOT NULL DEFAULT 1.000000,
  base_quantity     DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
  warehouse_id      VARCHAR(50)  NULL,
  alloc_method      ENUM('fixed_pct','standard_cost','weight','nrv') NOT NULL DEFAULT 'standard_cost',
  -- Meaning depends on alloc_method (see header). NULL for standard_cost
  -- means "look the standard/WAC cost up at run time".
  alloc_value       DECIMAL(18,6) NULL,
  requires_lot      TINYINT(1)   NOT NULL DEFAULT 0,
  line_no           INT          NOT NULL DEFAULT 0,
  notes             VARCHAR(300) NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bom_outputs_bom (bom_id, line_no),
  KEY idx_bom_outputs_product (product_id, product_source),
  UNIQUE KEY uq_bom_outputs_product (bom_id, product_id, product_source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Backfill: one `primary` output per existing BOM ──────────────────
-- INSERT ... SELECT with a NOT EXISTS guard, so re-running the migration
-- (or running it after the API has already created outputs) inserts
-- nothing. The id is DERIVED from the bom id rather than random so the
-- guard and the row agree on identity across re-runs.
INSERT INTO bom_outputs
  (id, bom_id, output_type, product_id, product_source, quantity,
   entered_unit_code, conversion_factor, base_quantity, alloc_method, line_no, notes)
SELECT
  CONCAT('BOUT-P-', b.id),
  b.id,
  'primary',
  b.product_id,
  CASE WHEN COALESCE(b.product_source, 'inv') = 'menu' THEN 'menu' ELSE 'inv' END,
  GREATEST(COALESCE(b.yield_quantity, 1), 0.000001),
  b.yield_unit,
  1.000000,
  GREATEST(COALESCE(b.yield_quantity, 1), 0.000001),
  'standard_cost',
  0,
  NULL
FROM bom b
WHERE NOT EXISTS (
  SELECT 1 FROM bom_outputs o WHERE o.bom_id = b.id AND o.output_type = 'primary'
);
