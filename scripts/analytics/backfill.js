#!/usr/bin/env node
'use strict';
/* ─── Analytics backfill ORCHESTRATOR ────────────────────────────────────────
 *
 * Every stage of the historical backfill already existed, as five programs that
 * had to be run by hand in the right order and whose combined result nobody
 * ever saw in one place:
 *
 *     backfill-facts.js          the facts
 *     RollupService.drainRepair  the repair queue
 *     RollupService.drainDirty   the rollups
 *     reconcile.js               the three-way check
 *     (nothing)                  completeness
 *
 * Run out of order they lie to you. Reconcile before the repair queue drains
 * and it reports drift that a drain would have removed; rebuild rollups before
 * the facts land and every rollup is authoritative and empty. This script runs
 * them in the ONE order in which each stage's inputs are already final:
 *
 *     1. PRE-FLIGHT   what exists, and what is structurally unrecoverable
 *     2. FACTS        backfill-facts.js, all passes
 *     3. REPAIR       drain analytics_projection_repair until it stops healing
 *     4. ROLLUPS      rebuild every business day the facts marked dirty
 *     5. RECONCILE    three-way: sales ↔ ar_documents ↔ facts
 *     6. COMPLETENESS per-day coverage, and what is missing on purpose
 *
 * IT IS A REPORT FIRST. Default is a dry run that writes nothing; `--apply`
 * runs it for real. Either way the final summary is the deliverable, and stage
 * 6 is the one that matters most, because it is the only stage that can tell
 * you the backfill SUCCEEDED and the data is still incomplete.
 *
 * WHAT IS STRUCTURALLY UNRECOVERABLE, STATED UP FRONT (stage 1 counts it)
 *   Sales written while ORDER_TO_CASH_ENABLE was off have no `ar_documents`
 *   row and therefore no `ar_document_lines`. Pass B projects them into ORDER
 *   facts, so headline revenue is right — but every LINE-level metric (qty,
 *   COGS, category, VAT breakdown) reads ar_document_lines and is genuinely
 *   zero for them. No backfill can invent those lines: the item breakdown was
 *   never persisted. Reporting that number is the honest alternative to a
 *   report that quietly shows a smaller basket than was actually sold.
 *
 * IDEMPOTENT / RESUMABLE / NON-DESTRUCTIVE: inherited, not re-implemented.
 * Every fact write is an upsert on a unique key, backfill-facts.js persists a
 * resume cursor, and the two snapshot columns are write-once
 * (ProjectionService: the modifier `cost_snapshot` COALESCE, and the
 * `category_name_snapshot IS NULL` guard). Re-running this script cannot
 * change a figure that a live projection already captured correctly.
 *
 * USAGE
 *   node scripts/analytics/backfill.js                       # dry run, writes nothing
 *   node scripts/analytics/backfill.js --apply
 *   node scripts/analytics/backfill.js --apply --from=2026-01-01 --to=2026-06-30
 *   node scripts/analytics/backfill.js --apply --batch=5000
 *
 * EXIT CODES
 *   0  every stage clean
 *   1  ran, but a stage reported a problem worth a human (drift, unhealed
 *      repair rows, or a completeness gap) — the numbers are in the summary
 *   2  fatal: could not run
 */

const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
function opt(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const FROM = opt('from', null);
const TO = opt('to', null);
const BATCH = opt('batch', null);

const money = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

/**
 * A DATE column comes back from mysql2 as a JS Date, and `String(date)` is
 * "Tue Jul 14 2026 00:00:00 GMT+0300 (…)" — which `.slice(0,10)` turns into
 * "Tue Jul 14". This printed a weekday where a date belonged, in a report whose
 * entire job is to tell you WHICH days are incomplete.
 * Local getters, not toISOString: the value is already a calendar day, and
 * converting through UTC would shift it backwards for any positive offset.
 */
function day(v) {
  if (v == null) return '—';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function head(n, title) {
  console.log(`\n${'═'.repeat(72)}\n${n}. ${title}\n${'═'.repeat(72)}`);
}

/** Run a child script inheriting stdio; returns its exit code. */
function run(script, extra = []) {
  const argv = [script, ...extra];
  if (FROM) argv.push('--from=' + FROM);
  if (TO) argv.push('--to=' + TO);
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  return r.status == null ? 2 : r.status;
}

const FACT_TABLES = [
  'analytics_order_facts', 'analytics_payment_facts',
  'analytics_modifier_facts', 'analytics_till_facts',
];

async function counts(db) {
  const out = {};
  for (const t of FACT_TABLES) {
    try { const [r] = await db.query(`SELECT COUNT(*) c FROM \`${t}\``); out[t] = Number(r[0].c); }
    catch (_) { out[t] = null; }
  }
  return out;
}

async function main() {
  const db = require('../../db/connection');
  const problems = [];

  console.log(`analytics backfill — ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written; pass --apply)'}`
    + (FROM ? `  from=${FROM}` : '') + (TO ? `  to=${TO}` : ''));

  /* ── 1. PRE-FLIGHT ─────────────────────────────────────────────────────── */
  head(1, 'PRE-FLIGHT — what exists, and what cannot be recovered');

  const before = await counts(db);
  for (const t of FACT_TABLES) console.log(`  ${pad(t, 30)} ${before[t] == null ? 'ABSENT' : before[t]}`);
  if (Object.values(before).every((v) => v === null)) {
    console.error('\nFATAL: no analytics fact table exists. Run the analytics migration first.');
    process.exit(2);
  }

  // The unrecoverable population, counted rather than glossed over.
  let orphan = { n: 0, total: 0 };
  try {
    const [r] = await db.query(
      `SELECT COUNT(*) n, COALESCE(SUM(s.total_final),0) t
         FROM sales s
         LEFT JOIN ar_documents d ON d.source_type='pos' AND d.source_id = s.id
        WHERE d.id IS NULL`);
    orphan = { n: Number(r[0].n), total: Number(r[0].t) };
  } catch (_) { /* table shape differs — reported as unknown below */ }

  if (orphan.n > 0) {
    console.log(`\n  ${orphan.n} sales (${money(orphan.total)}) have NO ar_document.`);
    console.log('  Their ORDER facts are projected by pass B, so revenue totals are correct.');
    console.log('  Their LINE detail — qty, COGS, category, VAT breakdown — does not exist and');
    console.log('  cannot be reconstructed: the item breakdown was never persisted for them.');
    console.log('  Item-level reports covering these days are incomplete BY CONSTRUCTION.');
  } else {
    console.log('\n  Every sale has an ar_document — line-level history is fully recoverable.');
  }

  if (!APPLY) {
    console.log('\n  — dry run: showing candidate counts from backfill-facts, then stopping —');
    run('scripts/analytics/backfill-facts.js');
    console.log('\nDry run complete. Nothing was written. Re-run with --apply.');
    process.exit(0);
  }

  /* ── 2. FACTS ──────────────────────────────────────────────────────────── */
  head(2, 'FACTS — project every historical source');
  const factsCode = run('scripts/analytics/backfill-facts.js', BATCH ? ['--apply', '--batch=' + BATCH] : ['--apply']);
  if (factsCode !== 0) problems.push(`fact projection exited ${factsCode} (some sources failed; see analytics_projection_repair)`);

  /* ── 3. REPAIR QUEUE ───────────────────────────────────────────────────── */
  // AFTER the facts: a source that failed during stage 2 is queued there, and
  // draining first would only drain yesterday's failures.
  head(3, 'REPAIR QUEUE — replay what failed');
  const Rollup = require('../../services/analytics/RollupService');
  const drain = { scanned: 0, healed: 0, failed: 0, unknown: 0 };
  // Loop until a pass heals nothing: one drain is capped at 200 rows, and a
  // healed row can be the reason the next one succeeds.
  for (let pass = 0; pass < 100; pass++) {
    const r = await Rollup.drainRepair(db, { limit: 200 });
    drain.scanned += r.scanned; drain.healed += r.healed;
    drain.failed = r.failed; drain.unknown = r.unknown;
    if (!r.scanned || !r.healed) break;
  }
  console.log(`  scanned ${drain.scanned}, healed ${drain.healed}, still failing ${drain.failed}, unmapped ${drain.unknown}`);
  let stuck = 0;
  try {
    const [r] = await db.query('SELECT COUNT(*) c FROM analytics_projection_repair');
    stuck = Number(r[0].c);
  } catch (_) {}
  if (stuck) {
    console.log(`  ${stuck} row(s) remain queued — inspect analytics_projection_repair.last_error`);
    problems.push(`${stuck} source(s) never projected and remain in the repair queue`);
  }

  /* ── 4. ROLLUPS ────────────────────────────────────────────────────────── */
  // AFTER repair: rollups aggregate the facts, so any fact healed in stage 3
  // must be in place before its day is rebuilt, or the rollup is authoritative
  // and wrong — the worst of the failure modes here, because the read path
  // trusts a rollup without re-checking it.
  head(4, 'ROLLUPS — rebuild every business day the facts marked dirty');
  let rolled = 0;
  try {
    for (let pass = 0; pass < 500; pass++) {
      const r = await Rollup.drainDirty(db, { limit: 200 });
      const done = Number((r && (r.rebuilt ?? r.done ?? r.pairs)) || 0);
      rolled += done;
      if (!done) break;
    }
    console.log(`  rebuilt ${rolled} (branch, business_day) pair(s)`);
  } catch (e) {
    console.log('  rollup rebuild failed: ' + (e.code || e.message));
    problems.push('rollup rebuild failed — reports may serve stale aggregates');
  }

  /* ── 5. RECONCILE ──────────────────────────────────────────────────────── */
  // LAST of the write stages' checks: only now are facts, repairs and rollups
  // all final, so drift reported here is real drift and not sequencing noise.
  head(5, 'RECONCILE — sales ↔ ar_documents ↔ facts');
  const reconCode = run('scripts/analytics/reconcile.js');
  if (reconCode === 1) problems.push('three-way reconciliation reported drift beyond 0.01');
  else if (reconCode !== 0) problems.push(`reconciliation exited ${reconCode}`);

  /* ── 6. COMPLETENESS ───────────────────────────────────────────────────── */
  head(6, 'COMPLETENESS — which days are covered, and which are not');
  try {
    const [days] = await db.query(
      `SELECT COUNT(DISTINCT business_day) d, MIN(business_day) lo, MAX(business_day) hi
         FROM analytics_order_facts`);
    const d = days[0];
    console.log(`  fact days: ${d.d} distinct, ${day(d.lo)} … ${day(d.hi)}`);

    // Orders with no ar_document_lines are the unrecoverable population above,
    // reported PER DAY and always WITH ITS DENOMINATOR.
    //
    // The first version printed only the thin count ("Mon Jul 27  15 order(s)")
    // which is unreadable as a severity: 15 of 15 is a blackout, 15 of 400 is a
    // footnote, and the line looked identical either way. A completeness report
    // that cannot be judged is not a completeness report.
    const [cov] = await db.query(
      `SELECT f.business_day AS bd,
              COUNT(*) AS orders,
              SUM(CASE WHEN l.document_id IS NULL THEN 1 ELSE 0 END) AS thin
         FROM analytics_order_facts f
         LEFT JOIN (SELECT DISTINCT document_id FROM ar_document_lines) l
                ON l.document_id = f.document_id
        GROUP BY f.business_day
        HAVING thin > 0
        ORDER BY f.business_day`);
    if (cov.length) {
      console.log(`\n  ${cov.length} business day(s) contain orders with NO line detail:`);
      for (const c of cov.slice(0, 20)) {
        const pct = Math.round((Number(c.thin) / Number(c.orders)) * 100);
        console.log(`    ${day(c.bd)}  ${c.thin} of ${c.orders} order(s)  (${pct}%)`);
      }
      if (cov.length > 20) console.log(`    … and ${cov.length - 20} more`);
      const totalThin = cov.reduce((s, c) => s + Number(c.thin), 0);
      problems.push(`${totalThin} order(s) across ${cov.length} day(s) have no line detail — item, COGS and VAT-breakdown reports are incomplete for them`);
    } else {
      console.log('  every order has line detail.');
    }
  } catch (e) {
    console.log('  completeness check failed: ' + (e.code || e.message));
    problems.push('completeness could not be computed');
  }

  /* ── SUMMARY ───────────────────────────────────────────────────────────── */
  head('', 'BEFORE / AFTER');
  const after = await counts(db);
  for (const t of FACT_TABLES) {
    const b = before[t], a = after[t];
    console.log(`  ${pad(t, 30)} ${b == null || a == null ? 'n/a' : `${b} → ${a}  (+${a - b})`}`);
  }

  if (problems.length) {
    console.log('\n── needs a human ──');
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    console.log('\nThe backfill RAN. These are findings, not crashes — but the data is not clean.');
    process.exit(1);
  }
  console.log('\nAll stages clean.');
  process.exit(0);
}

main().catch((e) => { console.error('backfill orchestrator FATAL:', e); process.exit(2); });
