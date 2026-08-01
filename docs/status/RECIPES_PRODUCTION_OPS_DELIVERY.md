# Recipes · Production · Inventory Operations — delivery report

Branch `feat/recipes-production-ops`, worktree `Downloads/wt-recipes-prod`,
baseline `origin/main` @ `e4a1d83`.

Nothing is pushed. `wt-sales-hub` (`release/sales-reports-final`) was never
touched; every commit stages explicit paths and no `git add -A` was ever run.

---

## 1. Equivalence table — nothing that worked was lost

The rule applied throughout: an old surface is only retired once its replacement
is proven, and every retired path either delegates or redirects.

| Capability (before) | Where it lived | Now | Status |
|---|---|---|---|
| Read a menu item's recipe | `GET /api/menu/:id/recipe-bom` | unchanged, still mounted | **kept** |
| Save a menu item's recipe | `POST /api/menu/:id/recipe-bom` (owned its own rules) | same URL, now **delegates** to `saveRecipe()` | **kept + hardened** |
| Read/Save any BOM | `GET/POST /api/erp/bom` | same URLs, `POST` now **delegates** | **kept + hardened** |
| BOM list | `GET /api/erp/bom` (`catch → res.json([])`) | same URL, real error + `requestId` on failure | **kept + fixed** |
| BOM product picker | `GET /api/erp/bom/product-pool` (unpaged, ≤3000 rows) | kept; new paged `GET /api/recipes/products` | **kept + superseded** |
| BOM lines | `GET /api/erp/bom/:id/lines` (`catch → []`) | same URL, real error on failure | **kept + fixed** |
| Where-used | `GET /api/erp/inventory/usage/:itemId` | kept; new `GET /api/recipes/where-used/:itemId` also covers the legacy `recipe` table | **kept + superseded** |
| Clone a BOM | `POST /api/erp/bom/:id/clone` | kept; new `POST /api/recipes/bom/:bomId/clone` mints a versioned draft | **kept + superseded** |
| Menu availability from a recipe | `GET /api/menu/:id/availability` | unchanged | **kept** |
| Recipes screen | `/menu/recipes-bom` | `/menu/recipes` + redirect carrying `?item=` → `?productId=` | **moved, links alive** |
| Single production order | `POST /api/inventory/v2/production-orders` | unchanged | **kept** |
| Several orders at once | `POST /api/erp/production-orders` with `items[]` — no transaction, silent `continue`, `success:true` on partial | **410 Gone**, naming `POST /api/inventory/v2/production-batches` | **replaced (deliberate)** |
| Single legacy production order | `POST /api/erp/production-orders` without `items[]` | unchanged | **kept** |
| Production create UI | `/inventory/production?new=1` | `/inventory/production/new` (old query form redirects) | **moved, links alive** |
| Transfer detail | `?view=<id>` panel on the transfers list | `/inventory/operations/transfer/:id` page (old query form redirects) | **moved, links alive** |
| Inventory-transaction detail | `?view=<id>` panel | `/inventory/operations/:type/:id` page (old query form redirects) | **moved, links alive** |

---

## 2. Migrations

Applied by `db/migrate.js`, step 2/3 of `scripts/release-start.js`. All four are
`INFORMATION_SCHEMA`-guarded per `db/migrations/README.md` rule 3 and were
verified **re-runnable** by replaying every statement a second time against an
already-migrated database.

| File | What it adds | Backfill |
|---|---|---|
| `0024_bom_recipe_domain.sql` | `bom`: status, revision_of, row_version, needs_review, cost cache, yield_unit_id, authorship. `bom_lines`: line_no, registered unit + snapshotted conversion_factor + base_quantity, notes. Indexes. | status from `is_active`; `base_quantity = quantity`, factor 1 (reproduces today's expansion exactly); duplicate same-unit lines folded preserving net **and** gross; UNIQUE key added **conditionally** so dirty data cannot fail a release |
| `0025_bom_outputs.sql` | `bom_outputs` — primary / co_product / by_product / rework / scrap, per-output allocation method | one synthesised `primary` row per existing BOM |
| `0026_production_batches.sql` | `production_batches` + counter; `production_orders.batch_id`, `batch_line_no`, `bom_version`; indexes incl. output warehouse | `bom_version` from the linked recipe |
| `0027_production_allocation_ledger.sql` | `production_material_allocations`; joint-output + waste-override columns on `production_output`; `allowed_scrap_pct` default → NULL | existing `output_group_id = id`, `alloc_share = 1`; **every `allowed_scrap_pct = 0` → NULL**, which preserves each historical order's behaviour exactly |

### The one migration decision worth re-reading

`allowed_scrap_pct = 0 → NULL`. Under the old rule (`Number(pct) || 0;
if (pct <= 0) return false`) zero meant *no gate*, and zero was also the column
default and what both create routes wrote when the field was omitted — so the
gate never fired on any order that existed. Rewriting those rows to NULL keeps
their observed behaviour identical while freeing `0` to start meaning zero for
orders created from now on, where someone actually chose it.

---

## 3. Test results

| Suite | Result |
|---|---|
| `tests/recipeEngine.test.js` (pure) | 95/95 |
| `tests/inventoryOperations.test.js` (pure) | 96/96 |
| `tests/productionEngine.test.js` (pure) | 33/33 |
| `npm test` (whole backend unit chain) | green end to end |
| `npm run test:recipes-api` | 60/60 |
| `npm run test:production-integrity` | 44/44 |
| `npm run test:operations-api` | 32/32 |
| `npm run test:mutation:full` | **12 mutants, 0 survived** |
| ERP `tsc --noEmit` | clean |
| ERP vitest | 573/573 across 80 files |
| `npm run tokens:check` | pass, no new hex |
| `npm run check:rtl-literals` | pass (POS at zero, ERP ratcheted) |
| `build:erp` / `build:pos` | both green |
| `schema:release-chain` / `release-sequence` / `migration-concurrency` | 3/3 — the release chain runs against an EMPTY database |

Every integration suite asserts the DATABASE effect after a write, not the HTTP
status. The genealogy fix, for instance, is proven by reading
`production_material_allocations` back: 6 units consumed, **6** attributed across
three partial outputs, where the old code recorded 18.

### Responsive / bilingual verification (live, against a running server)

Measured in a real browser at 390 / 768 / 1024 / 1440 on `/menu/recipes`,
`/inventory/operations`, `/inventory/production` and `/inventory/production/new`:
**body horizontal overflow = 0 px at every size**, and zero elements wider than
the viewport that are not inside their own `overflow-x-auto` container (the wide
tables scroll themselves, which is the intended behaviour). Arabic renders
`dir="rtl"`, English `dir="ltr"`; no untranslated i18n keys leak; zero console
errors; every `/api/` request returned 200.

### Full gate

25/37 steps ran before it stopped at the first failure, and **every step this
work added or touched passed**: `static:design-tokens`, `static:rtl-literals`,
`erp:tsc`, `erp:vitest`, `root:tests`, `backend:recipes-api`,
`backend:production-integrity`, `backend:operations-api`,
`audit:mutation-guards`, plus all three `schema:*` steps and both builds.

TWO GATE STEPS FAIL, and BOTH ARE PRE-EXISTING — verified, not assumed:

* `backend:sales-fixes` → `dashboardPayments.api.test.js`, 18 passed / 2 failed
  on `marginBasis` expecting `cogs` but getting `proxy`. Reproduced **identically
  on an untouched `origin/main` worktree** (same 18/2, same two assertions).
* `audit:retired-surfaces` → `e2e/erp/sales-hub-redirects.spec.ts` references the
  retired `/accounting/sales-analytics` and `/pos-admin/reports` paths but is not
  on the audit's allow-list. That file is untouched by this branch and was
  introduced by `origin/main`'s own commit `c05a66a3`; the audit and the spec
  disagree in the baseline.

Neither is fixed here: both sit in the sales-reports area, which is exactly the
work in flight on `release/sales-reports-final`, and touching it from this branch
would collide with it.

## 4. Risks and open items

Stated plainly rather than buried.

1. **The conditional UNIQUE key.** `uq_bom_lines_component` is added only when
   the fold leaves zero duplicate groups. A production database holding
   *cross-unit* duplicates (same component, two different units — which the fold
   deliberately does not merge, because summing 2 kg into 3 g is nonsense) will
   not get the index. The API canonicalises on every write regardless, and
   `_expandBom` collapses on every read, so the behaviour is correct either way;
   the index is defence in depth. **Check after deploying** whether the index
   exists in production, and resolve any remaining cross-unit duplicates by hand.

2. **Seven `res.json([])` sites remain in `routes/erp-core.js`** (lines 66, 121,
   165, 172, 215, 327, 400) on non-BOM routes — companies, categories, price
   lists. They are the same false-empty defect and were left alone as out of
   scope for this sprint.

3. **The legacy production surface has no warehouse scoping at all.**
   `routes/warehouse-ops.js` lines 1223–1865 (legacy list, detail, create,
   release, complete, reverse) never call `guardWh`/`whScopeClause`, even though
   the router inherits `loadWarehouseScope`. Only the V2 surface was in scope
   here. This is a live authorisation gap on the legacy path.

4. **Legacy serial allocation is not atomic.** `warehouse-ops.js` `_nextSerial`
   does an upsert then a *separate* SELECT, so two concurrent legacy creates can
   mint duplicate `PRD-` numbers — and it shares `production_counter` with the
   V2 path, so it can collide with V2 numbers too. Out of scope; not introduced
   here.

5. **Idempotency remains opt-in.** A client that omits `Idempotency-Key` gets no
   replay protection on any of these endpoints. Unchanged from before.

6. **`CapGuard` is inert in dev** (`import.meta.env.DEV` returns children
   unconditionally), so capability gating on the new pages can only be verified
   against a production build.
