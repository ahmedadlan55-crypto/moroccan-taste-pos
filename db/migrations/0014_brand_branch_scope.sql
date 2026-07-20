-- ════════════════════════════════════════════════════════════════════
-- 0014_brand_branch_scope.sql
-- ────────────────────────────────────────────────────────────────────
-- Owner A — bilingual-i18n-images. Brand/branch scope fix: branch-level
-- SNAPSHOT columns that let the cashier and shift APIs scope supervisors
-- to their own brand instead of showing every branch's data by default.
--
--   pos_orders.branch_id — populated at order CREATION time (INSERT) via
--     _cashierBranchId(), never rewritten on later edits — same convention
--     as pos_orders.name_snapshot / channel_name. Powers the brand-scoped
--     GET /api/pos/v2/orders (+ GET /orders/:id) for supervisors.
--
--   shifts.branch_id — populated at shift OPEN time via
--     COALESCE(users.branch_id, users.default_branch_id), never rewritten on
--     close/reconciliation. Powers the brand-scoped GET /api/shifts for
--     supervisors. Shifts are branch-level facts (a cashier doesn't change
--     branch mid-shift), so this is resolved directly from the user's own
--     branch — NOT via the two-hop brand lookup pos_orders/catalog use.
--
-- Both are NULLable: rows written before this migration keep branch_id NULL
-- and are treated as visible to every brand-scoped supervisor (see
-- routes/pos-v2.js GET /orders and routes/shifts.js GET /) — the same
-- "unscoped = global" rule menu.brand_id IS NULL already uses.
--
-- WIRING NOTES for the server.js migration-wiring stage — copy verbatim:
--
--   await addColumnIfMissing('pos_orders', 'branch_id', "VARCHAR(50) NULL");
--   await addColumnIfMissing('shifts',     'branch_id', "VARCHAR(50) NULL");
--
-- Until the wiring stage lands, routes/pos-v2.js and routes/shifts.js each
-- ensure their OWN column at startup/first-request (INFORMATION_SCHEMA-
-- guarded — routes/pos-v2.js's existing `_ensureSchema()`, and the new
-- `_ensureShiftsSchema()` added to routes/shifts.js following the same
-- pattern). This file is the readable reference / fresh-install supplement
-- — NOT the live migration path.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE pos_orders ADD COLUMN branch_id VARCHAR(50) NULL;
ALTER TABLE shifts     ADD COLUMN branch_id VARCHAR(50) NULL;

CREATE INDEX idx_pos_orders_branch ON pos_orders(branch_id);
CREATE INDEX idx_shifts_branch     ON shifts(branch_id);
