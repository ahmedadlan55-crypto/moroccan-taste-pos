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

### E2E — `e2e/erp/recipes-production-ops.spec.ts`

**24/24**, across all four viewport projects (390 / 768 / 1024 / 1440) in both
Arabic and English. It asserts the part a per-leaf sweep cannot: cold deep links
render and SURVIVE A REFRESH (these were `?item=` / `?new=1` / `?view=` query
params, which is exactly what a refresh discarded), a document opens as a full
page carrying the `print-document` wrapper and never as a pinned side panel,
`/menu/recipes-bom` still resolves with `?item=` mapped to `?productId=`, and a
stock inbound stays distinguishable from a purchase receipt.

Two real defects were found by this spec and are fixed:

1. **Every product thumbnail 401'd.** The catalog pointed an `<img src>` at
   `/api/recipes/product-image/…`, which is behind the JWT gate — and a browser
   image request cannot carry an `Authorization: Bearer` header. A failed image
   renders as an absent picture, not an error, so the grid merely looked
   image-less and no unit test could see it. `AuthedImage` now fetches the bytes
   with the token and hands the `<img>` an object URL, with a shared cache so N
   rows issue one request. Exempting the endpoint from auth was rejected — it
   would add a new unauthenticated surface.
2. **The document id was lower-cased in the route.** `normalizeRoutePath`
   lower-cases the whole pathname for matching, and the operations dispatch was
   also reading the id from that copy, so `STK-0a71624b4013` was fetched as
   `stk-…`. It resolved only because MySQL's default collation is
   case-insensitive; a binary/`_bin` collation would turn every deep link into a
   404 that looked like missing data.

---

## 4. The report failures — found pre-existing, then fixed

Seven checks failed when this branch was first gated. **Every one was reproduced
on an untouched `origin/main` worktree**, so none is caused by this work. They
were then fixed anyway, on request, because one of them was not a stale test at
all — it was a live financial defect.

### 4.1 The balance sheet was returning zeros in production. Silently.

This surfaced as a red E2E test. It is a shipped bug on `main` affecting every
request:

* `routes/erp/reports/balance-sheet.js:29` imports `coaTree` at module scope.
* `:543` opens a `try`; `:567` and `:577` use `coaTree`.
* `:911` declares `const coaTree` **inside that same block**. A `const` hoists to
  the top of its block without initialising, so the module import is in the
  temporal dead zone for the whole block — and `:567` throws `ReferenceError`
  before it ever reaches the line that would have defined it.
* A bare `catch` at `:931` swallowed it and returned **HTTP 200 with an
  all-zero balance sheet** and `isBalanced: false`, logging nothing.

A 200 with plausible-looking zeros is why this survived: nothing alerted, and the
screen looked like a company with no transactions rather than a broken endpoint.
`/accounting/balance-sheet` renders those zeros. `equity-changes.js` then calls
the balance sheet internally *without passing `req.user`*, so the capability
guard answered 401 and `equity-changes` returned 500 — that 500 was the visible
symptom of an invisible bug.

**Correction.** An earlier draft of this document, and the commit message it
quotes, also claimed the **financial-ratios** screen was reading the same zeroed
payload. That is wrong, and the blast radius is smaller than stated:
`FinancialRatios.tsx:28` calls `/erp/reports/balance-sheet` — a *different*
handler at `routes/erp-core.js:2316` that does its own `SUM(debit)/SUM(credit)`
aggregation, never requires `lib/coa/tree`, and has no `coaTree` shadow. Only the
`-ifrs` endpoint was affected, and only `/accounting/balance-sheet` consumes it.
**One screen was showing zeros, not two.**

Three changes, all required (fixing any one alone leaves the 500):

1. Rename the local at `:911` to `coaTreeView`. The JSON key stays `coaTree`, so
   the API contract does not change.
2. The `catch` now logs with the request id and marks the response
   `degraded: true`. Swallowing is how this hid for so long; the next failure in
   here will be visible.
3. `fetchBalanceSheetIfrs(asOfDate, user)` threads the caller's identity through.
   Safe because the caller already passed the *same* `finance.reports.view`
   capability the balance sheet demands — this forwards an
   already-authorised identity, it does not bypass the guard. The caller's guard
   also now rejects a `degraded` body instead of reporting zeros as fact.

**Verified live, not just by test**: `/api/erp/reports/balance-sheet-ifrs` returns
`totalAssets 5286.25` with `isBalanced: true`, and `/api/erp/reports/equity-changes`
returns 200 with a clean server log.

### 4.2 Four stale expectations that had outlived the code

| Check | Why it was wrong |
|---|---|
| `sales-hub-rbac.spec.ts` expected 15 sections | `SalesAnalyticsHub.tsx` has **17**, of which only 2 are gated; a manager holds one of those two capabilities, so a manager sees **16**. `hub.test.tsx` already derives 16 from the registry and passes. |
| `audit:retired-surfaces` | `sales-hub-redirects.spec.ts` **must** name the retired paths — that is what proves the redirects work. The allow-list was widened in `8e644768`; the file arrived later in `c05a66a3` and was never added. |
| `crud-writes.spec.ts` expected price 25 | Since `f83f39f9` a written price is rounded so the **customer-facing** amount is a whole riyal: `25 → ×1.15 = 28.75 → 29 → ÷1.15 = 25.2174`. The stored value is correct. 25 is unreachable under *either* reading, so no re-read of the form rescues it. |
| `dashboardPayments` `marginBasis` | The test seeds a row into `analytics_daily_branch`, a **derived** table, for a (branch, day) pair it had itself marked dirty — the worker then deletes and rebuilds it to `cogs = 0`. |

For `crud-writes` the magic number is gone: the test now asserts the invariant the
rounding guard actually promises — that the customer pays a whole riyal — instead
of pinning a literal that rots the next time the VAT rate moves.

For `dashboardPayments`, `ANALYTICS_DISABLE_WORKER=1` alone did **not** fix it,
and the reason is worth recording: the suite runs against the dev database
without pinning `_test`, so *any* other server process sharing that database
drains the dirty queue. A watcher showed the row appearing with `cogs=90` at
+8.4 s and being rebuilt to `cogs=0` at +13.7 s while the spawned server had
correctly logged `[analytics-worker] disabled via env` — two stray dev servers on
ports 3000/3061 were doing it. The fix seeds a date that was never enqueued as
dirty, so no worker in any process has a reason to touch it. Confirmed 20/20 on
three consecutive runs **with the stray servers still running**.

### 4.3 One genuine i18n gap, unmasked by the fix above

`rc-bilingual` reports the first problem it finds, so the equity-changes 500 was
hiding this: `/accounting/sales-posting` rendered an Arabic heading in English
chrome. `SalesPosting.tsx` does not use `useT` at all. The page **heading** — the
part the sweep inspects, and the first thing an English user reads — is now
translated through two new `accounting` keys present in both dictionaries. The
rest of that screen is deliberately left hardcoded: translating it fully is its
own task, and folding it into a report fix would hide it.

### 4.4 Left alone, deliberately

* **`sales-analytics.spec.ts` (expects 16, finds 17).** Already fixed on your
  `release/sales-reports-final` branch — 16 finished commits across 89 files.
  Fixing it here would duplicate your work and guarantee a conflict.
* **`MenuItemPage.tsx:227,258` was missed by `0b4d86e`.** The two sibling screens
  moved to customer-pays semantics; the product create/edit form still posts the
  raw number, so typing 25 there yields a 29.00 customer price — the exact trap
  that commit set out to remove. **This is a money-semantics change** and does not
  belong inside a test-fix commit.
* **`marginBasis: 'cogs'` may be unreachable in production.** All eight
  `analytics_daily_branch` rows in dev carry `cogs = 0.00`, sourced from
  `ar_document_lines.cost_snapshot`. Worth its own investigation.

### 4.5 Final gate: 34 of 37 steps pass

The gate stops at the first failure, so the remaining steps were run individually
with `--only=` to get a complete picture rather than a truncated one.

| | |
|---|---|
| **Passing** | all 3 `schema:*` (the release chain applies every migration to an EMPTY database and fails closed), both builds, `hygiene:test-residue`, `audit:retired-surfaces`, `audit:mutation-guards`, `backend:sales-fixes`, `e2e:rc-gate` **24/24**, and every static/tsc/vitest/backend step |
| **`test:mutation:full`** | **12 mutants, 0 survived** — including `genealogy-attributes-whole-order`, the original defect |

Three steps still fail. None is caused by this work, and each was traced to a
specific commit already on `main`:

1. **`audit:mutation-sales-math`** — `[mutation] FATAL: target file missing:
   …/reports/sales/lib/pivot.ts`. The pivot table was **deliberately deleted** by
   `390a5fdf` ("وداعًا للجدول المحوري"), which is on `main`; the audit still
   points 14 mutants at the removed file. The audit script is byte-identical
   between `main` and this branch — untouched here.

   **Not fixed on purpose.** The file's own doctrine (see the `EQ-05` comment)
   says to delete mutants whose subject is gone — but that removes 14 real
   guards, and the natural replacement targets (`grouping.ts`, `filters.ts`,
   `api.ts`) are being **rewritten on `release/sales-reports-final`**, where
   mutants pinned to verbatim source snippets would break your merge. Deleting
   guard coverage is your call, not something to slip into a test-fix commit.

2. **`e2e:erp` — 8 failures.** Four are `sales-analytics` expecting 16 hub
   sections and finding 17: already fixed on your branch. The other four are
   stale PNG baselines — `0b4d86e8` added the "Make them whole" button and the
   three price columns and never regenerated them. The pixel diff shows exactly
   that button and nothing else.

3. **`e2e:pos` — 9 `toHaveScreenshot` failures.** This branch does not touch
   `frontend/pos` at all (`git diff --stat` = empty). Run on an untouched
   `origin/main` worktree, POS fails a **superset** of these — the same
   `rtl-visual` snapshots plus `responsive`, `bilingual-flow` and
   `critical-cashier-shift`. The diff shows catalog *data* drift (item counts and
   names), not a UI change: the baseline is pinned to a seeded catalog that grows
   every time anyone runs the suite.

Regenerating those baselines is a one-command fix, but it permanently blesses
whatever is on screen. Doing that for someone else's UI change — and for a POS
snapshot whose instability is caused by mutable seed data — would convert a
visible problem into an invisible one.

---

## 5. Post-deploy audit: two defects this work shipped, and fixed

After the push, a verification pass re-derived every user-visible claim from the
code and checked it against the built bundle. It found two real defects that the
gate had not — both mine, both now fixed with tests that fail on the shipped code.

### 5.1 Lot genealogy rendered blank — on new orders AND old ones

Migration 0027 created `production_material_allocations` **empty**, and the
detail endpoint switched its genealogy source to it. Two separate failures:

* **Pre-deploy orders** showed "No genealogy links". The data was never lost —
  `production_output_lots` is still written today — it simply stopped being read.
* **New orders** rendered `— ← (5)`: blank lot numbers on every row. The ledger
  serialises **camelCase** and sends no row `id`, but
  `production.adapter.ts` still read **snake_case**. Only `qty` lined up. The
  adapter takes `any`, so TypeScript could not see it, and no test fed it the
  real server shape.

For a food business this is the recall question — "which lots went into this
batch" — so the fix restores the linkage rather than leaving it blank.
`loadGenealogy` now falls back to `production_output_lots` when the ledger has no
rows for an order, flagged `approximate: true`: the lot **linkage** there is
real, but the per-output **quantity** split is not (the old writer attributed the
whole order's consumption to every output lot — the exact defect the ledger
exists to fix). The UI shows a note and marks those quantities `≈`.

### 5.2 Saving a recipe left the product with NO active recipe

`saveRecipe`'s revise branch inserted the new version with `status` hardcoded to
`'draft'`/`is_active=0`, while the code below still archived the previous active
version and cascaded cost on `status === 'active'`. Both legacy writers
(`POST /api/erp/bom`, `POST /api/menu/:id/recipe-bom`) pass `activate: true`, and
migration 0024 marks **every** pre-existing recipe `'active'` — so the revise
branch is the normal path, not the rare one.

Net effect of one save: old version archived, new version a draft, product left
with no active recipe, and `menu.bom_id` pointing at that draft — while the
response reported success. The create and edit branches both honoured `status`
correctly; only revise ignored it. Fixed by honouring it there too. The
"never edit an active recipe in place" rule still holds: it is a new version row
either way.

The new ERP recipe page was never exposed to this (it saves a draft, then calls
the separate activate endpoint), so this hit API and legacy-shell callers.

### 5.3 Blast radius in the real database: nil, verified

Both defects above are real, but a read-only check against the **production**
database shows neither had actually bitten yet — the fixes are preventive, and no
data repair is needed:

| Checked in production | Result |
|---|---|
| `_migrations` | 0024, 0025, 0026, 0027 all recorded |
| `bom` | **112 recipes, all `active`**, `is_active = 1`; no drafts, no orphans |
| `bom_lines` | 492 lines, **0** remaining duplicate groups |
| `bom_outputs` | 112 rows — the Primary-output backfill landed, one per recipe |
| **Products whose `menu.bom_id` points at a non-active version** | **0** — the 5.2 defect never fired; nobody saved through a legacy writer between the two deploys |
| `production_output_lots` / `production_material_allocations` | **0 / 0** |
| `production_orders` | **0** |

The last three lines are why 5.1 had no visible effect either: the production
module has never been used in this database, so there was no historical genealogy
to lose. Both fixes matter the moment it *is* used — which is the point of
shipping them before that happens rather than after.

### Proof the tests have teeth

Both fixes were mutation-tested by restoring the exact shipped code:

| Reverted to shipped code | Result |
|---|---|
| revise branch hardcodes `'draft'` | 3 assertions fail — `the product is NOT left without an active recipe -> []` and `menu.bom_id ... -> bom_status: "draft"` |
| adapter reads snake_case only | 3 of 4 fail — `expected null to be 'IN-0004'`, and blank React keys |

## 6. Risks and open items

Stated plainly rather than buried.

1. ~~**The conditional UNIQUE key.**~~ **RESOLVED — verified against the
   production database (read-only) after the deploy.** `uq_bom_lines_component`
   exists on `bom_lines (bom_id, component_item_id)` with `NON_UNIQUE = 0`, and a
   `GROUP BY bom_id, component_item_id, unit HAVING COUNT(*) > 1` returns **zero**
   groups. The fold cleared every duplicate, including cross-unit ones, so the
   index applied. No manual cleanup needed.

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
