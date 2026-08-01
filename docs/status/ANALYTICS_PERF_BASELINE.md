# Analytics perf baseline

**Run date:** 2026-08-01 · **Branch:** `release/sales-reports-final` · **Sandbox:** `mt_perf_sales_hub`
**MySQL:** local 8.4, `DB_TIME_ZONE=+03:00` · **Harness:** `scripts/analytics/perf-check.js`

**Headline: 9 of 22 scenarios pass. 8 of the 13 failures are not perf at all — they
are HTTP 500s from a live SQL defect in `lib/analytics/planner.js` that takes out
every time-series report in the hub.** See *Blocking defect* below.

## Volume measured at

| table | rows |
| --- | ---: |
| `analytics_order_facts` | 530,233 |
| `ar_documents` | 530,233 |
| `ar_document_lines` | 1,590,148 |
| `analytics_payment_facts` | 673,042 |
| `analytics_modifier_facts` | 237,587 |
| `analytics_till_facts` | 200,937 |
| `sales_returns` | 10,378 (9,562 `posted`) |
| `sales_return_lines` | 14,545 |
| `analytics_daily_branch` / `analytics_hourly_branch` | 4,400 / 179,216 |

Spread: **550 distinct business days**, **8 branches** across **2 brands**, 4 channels,
3 order types, 80 menu items over 8 categories, 40 cashiers, hours 0–23 (10 % of
orders late-night, i.e. calendar day ≠ business day), **8,008 voided orders**, ~15 %
zero-rated lines. Seeding + rollup drain: **13.6 min**.

## What this measures, and what it does not

`scripts/analytics/perf-check.js` boots a real `node server.js` against a
disposable sandbox and times **`POST /api/analytics/query`** — the whole path a
browser takes: HTTP, auth, `middleware/analyticsScope`, `planner.plan`,
`QueryService.run`, the cross-fact merge, the label lookups, the JSON envelope.
No hand-written SQL is timed anywhere. A number here is a number a user would feel.

Reproduce:

```
node scripts/analytics/seed-perf.js  --db=mt_perf_sales_hub     # once, ~14 min
node scripts/analytics/perf-check.js --db=mt_perf_sales_hub     # per measurement
```

(or `npm run analytics:perf:seed -- --db=…` / `npm run analytics:perf -- --db=…`)

### Measurement protocol

Four phases per scenario; phases 2 and 4 are sampled 3× and the **median** is what
is asserted and printed. A single wall-clock sample on a box that is also running
MySQL is noise, and a budget decided by noise flaps in the gate.

1. untimed warm-up, `noCache:true` — JIT + InnoDB buffer pool
2. **COLD** ×3, `noCache:true` — the pure SQL path, `QueryService`'s 60 s memo
   bypassed on read *and* write
3. untimed cache-populate (no `noCache`)
4. **WARM** ×3 — served from the memo

Budgets: **common cold < 2000 ms**, **complex cold < 5000 ms**, **warm < 250 ms**.

### Two identities

Most scenarios run as `admin`: global scope, every capability, no scope clause.
One runs as the sandbox's `perf_manager` — role `manager`, which `role_permissions`
grants `analytics.view` but **not** `analytics.cost.view`, with warehouse grants
covering every seeded branch. That is the only way to measure a capability-**masked**,
branch-**scoped** request at full volume: an admin token can never mask anything,
because `lib/warehouseScope.isGlobalScope` short-circuits `scope.loadCaps` to the
full capability set. The scenario **asserts** `meta.maskedMetrics` — a masked
request that quietly stopped masking would otherwise pass while measuring an
entirely different plan.

## Scenario results

`src` = `meta.freshness.source` as returned by the API. `n/a` = the request 500'd,
so there was no envelope to read it from and **the ms column is an error path, not
a measurement**.

| # | scenario | budget | cold ms (median) | cold range | warm ms | rows | src | result |
| ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- |
| 1 | daily net by branch 30d | common | — | — | — | — | n/a | **500** |
| 2 | top-20 items 30d | common | **3230** | 3059–3472 | 5 | 20 | live | **FAIL** |
| 3 | payment mix 30d | common | 453 | 434–482 | 4 | 4 | live | PASS |
| 4 | hourly heatmap 7d | common | 12 | 12–15 | 3 | 44 | rollup | PASS |
| 5 | cashier table 30d | common | **3487** | 3435–3732 | 4 | 40 | live | **FAIL** |
| 6 | branch compare prevPeriod 30d | common | 9 | 9–10 | 4 | 8 | rollup | PASS |
| 7 | executive KPIs 30d (dimensionless, 8 metrics) | common | 5 | 5–6 | 3 | totals | rollup | PASS |
| 8 | discounts by day 30d | common | — | — | — | — | n/a | **500** |
| 9 | till variance by shift 7d | common | 34 | 30–38 | 4 | 57 | live | PASS |
| 10 | orders by channel 30d | common | 895 | 872–903 | 4 | 4 | live | PASS |
| 11 | brand×branch×day 4-metric compare 90d | complex | — | — | — | — | n/a | **500** |
| 12 | category×item pivot 90d | complex | **14900** | 13946–14933 | 4 | 80 | live | **FAIL** |
| 13 | weekday×hour heatmap compare 90d | complex | — | — | — | — | n/a | **500** |
| 14 | cashier×day rates 60d | complex | — | — | — | — | n/a | **500** |
| 15 | method×day×branch 60d | complex | — | — | — | — | n/a | **500** |
| 16 | sales by day 30d | common | — | — | — | — | n/a | **500** |
| 17 | sales by branch 30d | common | 7 | 7–7 | 5 | 8 | rollup | PASS |
| 18 | returns & voids by branch 90d | common | **4614** | 4315–4661 | 4 | 8 | live | **FAIL** |
| 19 | drill-down items, 3 filters pinned 30d | common | 431 | 431–463 | 4 | 40 | live | PASS |
| 20 | masked cost metrics, scoped manager 30d | common | 8 | 7–9 | 4 | 8 | rollup | PASS |
| 21 | taxes by vat category×rate 90d | complex | **10419** | 10160–11318 | 3 | 2 | live | **FAIL** |
| 22 | full-window 400d branch×day | complex | — | — | — | — | n/a | **500** |

Scenarios 16–22 are the ones added in this pass (plain sales-by-day, sales-by-branch,
returns/voids, filtered drill-down, masked+scoped, taxes by category×rate, and the
400-day window). Scenarios 1–15 already existed.

### Budget verdict

* **warm < 250 ms — PASS, every scenario that returned 200.** Worst warm median
  among the 14 healthy scenarios is **5 ms**. The memo is doing its job.
* **common cold < 2000 ms — 3 breaches**: scenario 2 (3230 ms), 5 (3487 ms),
  18 (4614 ms).
* **complex cold < 5000 ms — 2 breaches**: scenario 12 (**14900 ms**, ~3× the
  budget), 21 (10419 ms, ~2× the budget).
* **8 scenarios could not be measured** — they 500. No budget claim is made about
  them either way; the numbers in the run log for those rows are the cost of
  producing an error and are excluded above rather than dressed up as timings.

Every breach came back `source=live`. Every scenario that came back `source=rollup`
passed with **5–12 ms**. The rollup path is not the problem; **which** requests
reach it is.

## Routing (`meta.freshness.source`)

Rollup routing **has landed** and is observable in the envelope — the earlier note
in `perf-check.js`'s header, that `lib/analytics/freshness.js` hard-codes `'live'`,
is now out of date.

| source | scenarios |
| --- | ---: |
| `rollup` | 5 — #4, #6, #7, #17, #20 |
| `live` | 9 — #2, #3, #5, #9, #10, #12, #18, #19, #21 |
| `n/a` (500, no envelope) | 8 |

The five routed scenarios are the five fastest in the suite. The gap worth acting
on: **#2 top-20 items, #5 cashier table, #12 category×item and #21 taxes by
category×rate all answered `live`** and all breached. Whether those shapes *can* be
served from a rollup is a routing question, not a SQL one.

## EXPLAIN: full-scan assertion

**13 failures.** Every scenario's live plan is now EXPLAINed under its own scope
(previously only 3 were), and the assertion actually fires — see *Harness defects
fixed* below.

| table scanned (`access_type=ALL`) | scenarios |
| --- | --- |
| `analytics_payment_facts` | #3, #7, #15 |
| `analytics_order_facts` | #11 (×2 facts), #12, #13 (×2), #14, #18, #21, #22 (×2) |

Measured crossover on `analytics_order_facts` (`business_day` basis, post-`ANALYZE`):

```
    7d ( 1% of window): range(ix_aof_day_branch) ~12,648r     48ms
   30d ( 5%)          : ALL                     ~484,709r    317ms
   45d ( 8%)          : ALL                     ~484,709r    958ms
   60d (11%)          : ALL                     ~484,709r   1106ms
   90d (16%)          : ALL                     ~484,709r   2077ms
  400d (73%)          : ALL                     ~484,709r   2463ms
```

**The `EXPLAIN_ALLOWLIST` in `perf-check.js` is deliberately EMPTY.** The obvious
candidate for "the optimizer is right" was the wide window — but forcing the
existing index at 90 days *beat* the optimizer's own choice:

```
  optimizer: f:ALL(-)~484,709r                        1104ms
  forced   : f:range(ix_aof_day_branch)~172,386r       656ms
```

So the scan is a cost mis-estimate, not a correct plan, and an allowlist entry
claiming otherwise would have been a false statement used to silence a true
failure. The proposed indexes below remove all 13 scans; if a genuinely
unavoidable scan appears later, add an entry with a written reason — the harness
refuses to honour one without it.

`analytics_till_facts:index(ix_atf_shift)` (scenario 9) is a full **index** scan,
not `ALL`. It is reported, not failed: the rule the brief sets is on `ALL`, and
widening it silently would be moving the goalposts in the other direction.

## PROPOSED INDEXES

**Not applied — no migration was written.** Every statement below was created on
the sandbox, measured, and dropped; the probe verified `information_schema` was
left clean (`leftover probe indexes: NONE`). Timings are medians of 3 on the
530 k-order sandbox, against SQL emitted by `planner.plan` itself.

### 1. Order fact — cover the planner's two default filters (highest value)

Every order/line statement carries `(f.status IS NULL OR f.status <> 'voided')`
and `(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))`
(`planner.js`, `excluded_voided` + `excluded_credit_note_docs`). Neither column is
in `ix_aof_day_branch`, so evaluating them costs a row lookup per candidate — which
is exactly why the optimizer abandons the index above ~5 % selectivity.

```sql
CREATE INDEX ix_aof_day_branch_status_src
  ON analytics_order_facts (business_day, branch_id, status, source);
-- ix_aof_day_branch is then a strict prefix of this index and can be dropped:
-- DROP INDEX ix_aof_day_branch ON analytics_order_facts;
```

| query | before | after |
| --- | --- | --- |
| order 90d × branch | `f:ALL ~484,709r` **1434 ms** | `f:range(new) ~166,866r` **679 ms** |
| line 90d category×item | `f:ALL ~484,709r` **4082 ms** | `f:range(new) ~166,866r` **3500 ms** |
| line 30d top items | `f:range(ix_aof_day_branch) ~58,134r` 1177 ms | `f:range(new) ~58,176r` 1004 ms |
| line 90d vat category×rate | `f:ALL ~484,709r` **3700 ms** | `f:range(new) ~166,866r` **3194 ms** |

This clears every `analytics_order_facts` EXPLAIN failure. It does **not** bring the
wide line-fact shapes under budget on its own — at 90 days the remaining cost is the
~167 k-row join into `ar_document_lines`, not the scan. Those shapes need rollup
routing (see *Routing*).

### 2. Payment fact — make the existing date index covering

```sql
CREATE INDEX ix_apf_day_branch_method_cov
  ON analytics_payment_facts (business_day, branch_id, method_norm, direction, amount);
-- ix_apf_day_branch_method becomes a strict prefix and can be dropped.
```

`payments_in` / `refunds_out` are `SUM(CASE WHEN p.direction=… THEN p.amount …)`;
neither column is indexed, so the range scan needs a row lookup per hit.

| query | before | after |
| --- | --- | --- |
| payment mix 30d | `p:range(ix_apf_day_branch_method) ~79,718r` 60 ms | `p:range(new) ~74,332r` **24 ms** |

### 3. Every `dateBasis` column the planner can actually be asked for

`planner.DATE_BASES` accepts `business_day`, `calendar_day`, `paid_at`, `closed_at`.
Only `business_day` was indexed on any fact. Each row below is a real before/after.

```sql
CREATE INDEX ix_aof_local_branch        ON analytics_order_facts   (occurred_at_local, branch_id);
CREATE INDEX ix_aof_paid_at             ON analytics_order_facts   (paid_at, branch_id);
CREATE INDEX ix_aof_closed_at           ON analytics_order_facts   (closed_at, branch_id);
CREATE INDEX ix_apf_local_branch_method ON analytics_payment_facts (occurred_at_local, branch_id, method_norm);
CREATE INDEX ix_atf_local_branch        ON analytics_till_facts    (occurred_at_local, branch_id);
```

| basis → fact | before | after | gain |
| --- | --- | --- | ---: |
| `calendar_day` → order | `f:ALL ~484,709r` 939 ms | `f:range ~56,490r` 201 ms | **4.7×** |
| `calendar_day` → line | `f:ALL ~484,709r` 1672 ms | `f:range ~56,490r` 657 ms | **2.5×** |
| `paid_at` → order | `f:ALL ~484,340r` 1010 ms | `f:range ~56,490r` 199 ms | **5.1×** |
| `closed_at` → order | `f:ALL ~510,511r` 730 ms | `f:range ~56,490r` 200 ms | **3.6×** |
| `calendar_day` → payment | `p:ALL ~665,441r` 496 ms | `p:range ~76,898r` 64 ms | **7.8×** |
| `calendar_day` → till | `t:ALL ~199,627r` 39 ms | `t:range ~20,390r` 20 ms | **2.0×** |

**Deliberately NOT proposed:** `analytics_payment_facts.settled_at` and
`analytics_order_facts.opened_at`. Both appear in `registry/facts.js` `dateBases`,
but `planner.DATE_BASES` does not accept `settled_at` or `opened_at`, so no request
can reach either column. Indexing them today would cost write throughput to serve a
basis the API rejects with a 422. Add the index in the same change that adds the
basis, not before.

### 4. Returns fact — its whole access path

The fact is `sales_return_lines rl JOIN sales_returns r ON … AND r.status='posted'`,
filtered on `r.return_date` and scoped on `r.branch_id`. `sales_returns` had an index
on `status` alone, so every posted return in history was examined regardless of the
window.

```sql
CREATE INDEX ix_ret_status_date_branch ON sales_returns (status, return_date, branch_id);
```

| query | before | after | gain |
| --- | --- | --- | ---: |
| returns by branch 90d | `r:ref(ix_ret_status) ~5,083r` 37 ms | `r:range(new) ~1,580r` 18 ms | **2.1×** |

Equality (`status`) first, range (`return_date`) second, scope (`branch_id`) last —
the only ordering that lets all three predicates use the index. Note the absolute
cost here is small at 10 k returns; the row-count reduction (5,083 → 1,580) is what
scales, and it is why scenario 18's 4614 ms sits in its **order-fact** statement, not
its return-fact one.

### 5. Budget fact

```sql
CREATE INDEX ix_asb_month_branch ON analytics_sales_budget (period_month, branch_id);
```

`uq_asb_branch_month_metric` leads with `branch_id`, so a month range cannot use it.
Structural only — the table is tiny, measured 1 ms → 0 ms. Include it for
correctness of the access path, not for a win.

## Blocking defect found by this run (NOT fixed here — file not owned)

**`lib/analytics/planner.js` — every request grouped by a time dimension returns
HTTP 500.**

`emitStatementSql` builds the totals statement's `HAVING` by repeating the dimension
expression inside `GROUPING(...)`:

```js
// planner.js, ~line 474
havingParts.push(`GROUPING(${selectWrap(d.id, dimExprs[i].sql)}) = 1`);
```

which emits

```sql
GROUP BY DATE_FORMAT(f.business_day, '%Y-%m-%d') WITH ROLLUP
HAVING (GROUPING(DATE_FORMAT(f.business_day, '%Y-%m-%d')) = 1)
```

MySQL 8.4 rejects this: `ER_BAD_FIELD_ERROR: Unknown column 'f.business_day' in
'having clause'`. `HAVING` resolves identifiers against grouped columns and select
aliases; the *expression* is grouped, the underlying column is not. A **bare-column**
dimension works, which is exactly why the failure looks selective. Verified against
the live schema, one dimension at a time:

```
business_day  500   calendar_day 500   week   500   month 500   quarter 500
year          500   hour         500   half_hour 500  weekday 500
branch  OK   channel OK   order_type OK   cashier OK
menu_item OK   category OK   payment_method OK   vat_category OK
```

**All 9 time dimensions are down; every non-time dimension is fine.** That is every
trend, every heatmap, every day/week/month report in the sales hub. It reaches the
client as `500 INTERNAL_ERROR` from `routes/analytics/query.js:41` via
`QueryService.executePlan`.

The fix is one line and belongs to whoever owns `planner.js`: reference the select
alias, which MySQL does permit in `HAVING` — `HAVING (g0 = 1 OR g1 = 1 …)` — instead
of restating the expression.

## Harness defects fixed in this pass

1. **The full-scan assertion could never fail.** `EXPLAIN FORMAT=JSON` reports
   `table_name` as the **alias** when the query aliases the table — and every fact's
   `FROM` does (`FROM analytics_order_facts f JOIN ar_documents doc …`). The old
   hard-coded `FACT_TABLES` set compared `"analytics_order_facts"` against `"f"` and
   never matched. It printed `f:ALL` on its own console line and reported
   `EXPLAIN assertions: ALL PASS` underneath. Both the alias map and the table set
   are now derived from the registry's own `FROM` strings, so they cannot drift, and
   a fact added later is covered the moment it is registered. Turning it on
   immediately surfaced 13 real scans.
2. **Only 3 of the scenarios were EXPLAINed.** Now all of them, each under its own
   scope (the manager plan carries a `f.branch_id IN (…)` the admin plan does not,
   and that changes index choice).
3. **Statistics were never refreshed after the bulk load.** InnoDB samples index
   cardinality in the background; a sandbox that goes 0 → 530 k rows carries whatever
   it happened to sample mid-load. The same 30-day order-fact query chose
   `range(ix_aof_day_branch)` before `ANALYZE` and a full scan after it. `seed-perf.js`
   now runs `ANALYZE TABLE` over all eight fact-graph tables before building rollups.
   Without it the baseline measures when the load was interrupted, and does not
   reproduce.
4. **Cold/warm were single samples.** Now median of 3 per phase, with the cold
   min–max printed beside it.
5. **`sales_returns` / `sales_return_lines` / `ar_documents` were not treated as fact
   tables** by the scan check, so an unindexed returns path was invisible to it.

## Seeder additions

`seed-perf.js` previously produced no returns and no voids ("returns tables exist
(empty)"), and no non-global user. Three scenarios could not be measured at all
against that fixture, so:

* **~2 % of orders now get a real `sales_returns` + `sales_return_lines`** (partial,
  1–2 lines of the order; ~8 % left `cancelled` so the fact's `AND r.status='posted'`
  predicate is exercised rather than trivially true) → 10,378 returns / 9,562 posted.
  No credit-note `ar_document` is written: the planner excludes
  `source IN ('sales_return','credit_note')` from every order/line statement by
  default, so one would be filtered straight back out of every measurement it could
  appear in.
* **~1.5 % of orders are `voided`**, keeping their lines and payment facts — that is
  what the projection actually leaves behind → 8,008 voided orders.
* **One warehouse per branch + a `perf_manager` user** (role `manager`, granted all
  8) so a capability-masked, branch-scoped request can be measured. Its password is
  a non-bcrypt marker; the account can only ever be reached by a harness-signed JWT.
* The seeder now **fails** if the returns or voids facts come out empty — a perf run
  that measured a structurally-empty fact is not a measurement.

## Gate wiring

`scripts/gate/run-full-gate.js` now carries a `perf:analytics` step (step 23 of 34),
after `audit:mutation-sales-math`.

It runs against an **existing** sandbox and never provisions one: seeding ~530 k
orders and draining 4,400 rollup pairs takes ~14 minutes, and a gate too slow to run
is a gate nobody runs.

**An absent sandbox is a FAILURE, not a skip.** `perf-check.js` exits 2 when the
database is missing or empty, and that exit code reaches the gate summary unchanged
— no `|| true`, no conditional skip. A step that silently passes when its fixture is
gone has stopped testing anything while still printing a tick. Verified: running the
step while the sandbox was mid-rebuild produced `❌ perf:analytics (exit 2)`.

Point it elsewhere with `ANALYTICS_PERF_DB=<name>`.

**The step is red today**, on both the budget breaches and the 13 EXPLAIN failures.
That is the intended state: the findings are real, and none of them should be
silenced to make the gate green.
