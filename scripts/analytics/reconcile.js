#!/usr/bin/env node
/**
 * scripts/analytics/reconcile.js — three-way reconciliation of the sales truth:
 *
 *   (1) sales                         — the operational register (total_final)
 *   (2) ar_documents                  — the AR subledger (pos invoices)
 *   (3) analytics_order_facts ⋈ sales — the analytics projection
 *
 * Prints a per business_day × branch drift table (facts grouped by their
 * business_day; the raw register grouped by DATE(order_date) — the two can
 * legitimately differ around the day-close boundary, which is why the HARD
 * check is on totals, not the per-day rows).
 *
 * Exit code:
 *   0 — |sales − facts| ≤ 0.01 and counts match
 *   1 — drift beyond 0.01 between sales and the projected facts
 *  (2 — fatal error / fact tables missing)
 *
 * The sales↔ar_documents comparison is printed but only WARNS: history written
 * while ORDER_TO_CASH_ENABLE was off legitimately has sales with no ar_document
 * (the backfill's orphan pass B projects them into facts regardless).
 *
 * Usage: node scripts/analytics/reconcile.js [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Consistent exclusions on all three sides: voided sales (zatca_type
 * 'cancellation' / fact status 'voided' / cancelled documents) are OUT;
 * credit notes are OUT of all three (they are their own documents).
 */
'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const args = process.argv.slice(2);
function _opt(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const FROM = _opt('from', null);
const TO = _opt('to', null);
const EPS = 0.01;

function range(col) {
  const parts = [], params = [];
  if (FROM) { parts.push(`DATE(${col}) >= ?`); params.push(FROM); }
  if (TO) { parts.push(`DATE(${col}) <= ?`); params.push(TO); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (n == null ? '—' : r2(n).toFixed(2));

async function main() {
  const db = require('../../db/connection');
  console.log('reconcile — sales vs ar_documents vs analytics_order_facts'
    + (FROM ? ` from=${FROM}` : '') + (TO ? ` to=${TO}` : ''));

  // ── (1) the register ──
  const rs = range('s.order_date');
  const [[sales]] = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(s.total_final),0) AS total
       FROM sales s
      WHERE (s.zatca_type IS NULL OR s.zatca_type <> 'cancellation')${rs.sql}`, rs.params);

  // ── (2) the AR subledger (pos invoices) ──
  let ar = { cnt: null, total: null };
  try {
    const rd = range('d.issue_date');
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(d.total_amount),0) AS total
         FROM ar_documents d
        WHERE d.source_type='pos' AND d.document_type='invoice' AND d.status <> 'cancelled'${rd.sql}`,
      rd.params);
    ar = row;
  } catch (_) { /* ar_documents absent on legacy deploys */ }

  // ── (3) the projection (sale facts only — source='pos' excludes CN facts,
  //        which share sale_id with their original sale) ──
  let facts;
  const rf = range('s.order_date');
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(s.total_final),0) AS total
         FROM analytics_order_facts f
         JOIN sales s ON s.id = f.sale_id
        WHERE f.source = 'pos' AND f.status <> 'voided'${rf.sql}`, rf.params);
    facts = row;
  } catch (e) {
    console.error('FATAL: analytics_order_facts unavailable —', e.code || e.message);
    process.exit(2);
  }

  // ── per business_day × branch drift table ──
  console.log('\nper business_day × branch (facts side) vs DATE(order_date) (register side):');
  console.log('  day        | branch          |   register Σ | cnt |      facts Σ | cnt |   drift');
  console.log('  ' + '-'.repeat(88));
  const dayMap = new Map(); // 'day|branch' → { regT, regC, facT, facC }
  const get = (k) => { if (!dayMap.has(k)) dayMap.set(k, { regT: 0, regC: 0, facT: 0, facC: 0 }); return dayMap.get(k); };
  {
    const rr = range('s.order_date');
    const [regRows] = await db.query(
      `SELECT DATE_FORMAT(s.order_date, '%Y-%m-%d') AS d, COALESCE(s.branch_id,'UNASSIGNED') AS b,
              COUNT(*) AS c, COALESCE(SUM(s.total_final),0) AS t
         FROM sales s
        WHERE (s.zatca_type IS NULL OR s.zatca_type <> 'cancellation')${rr.sql}
        GROUP BY d, b`, rr.params);
    regRows.forEach((r) => { const e = get(r.d + '|' + r.b); e.regT = Number(r.t); e.regC = Number(r.c); });
    const rb = range('f.business_day');
    const [facRows] = await db.query(
      `SELECT DATE_FORMAT(f.business_day, '%Y-%m-%d') AS d, f.branch_id AS b,
              COUNT(*) AS c, COALESCE(SUM(s.total_final),0) AS t
         FROM analytics_order_facts f JOIN sales s ON s.id = f.sale_id
        WHERE f.source = 'pos' AND f.status <> 'voided'${rb.sql}
        GROUP BY d, b`, rb.params);
    facRows.forEach((r) => { const e = get(r.d + '|' + r.b); e.facT = Number(r.t); e.facC = Number(r.c); });
  }
  const keys = [...dayMap.keys()].sort();
  let flaggedDays = 0;
  for (const k of keys) {
    const [d, b] = k.split('|');
    const e = dayMap.get(k);
    const drift = r2(e.facT - e.regT);
    const flag = Math.abs(drift) > EPS ? '  ← drift' : '';
    if (flag) flaggedDays++;
    console.log(`  ${d} | ${b.padEnd(15).slice(0, 15)} | ${fmt(e.regT).padStart(12)} | ${String(e.regC).padStart(3)} | ${fmt(e.facT).padStart(12)} | ${String(e.facC).padStart(3)} | ${fmt(drift).padStart(8)}${flag}`);
  }
  if (flaggedDays) {
    console.log(`  (${flaggedDays} day×branch cell(s) differ — expected near the day-close boundary;` +
      ' only the TOTALS below gate the exit code)');
  }

  // ── totals + verdict ──
  console.log('\n═══ totals ═══');
  console.log(`  register (sales):            cnt=${sales.cnt}  Σ=${fmt(sales.total)}`);
  console.log(`  AR subledger (pos invoices): cnt=${ar.cnt == null ? 'n/a' : ar.cnt}  Σ=${fmt(ar.total)}`);
  console.log(`  analytics facts (⋈ sales):   cnt=${facts.cnt}  Σ=${fmt(facts.total)}`);

  if (ar.cnt != null) {
    const arDrift = r2(Number(sales.total) - Number(ar.total));
    if (Math.abs(arDrift) > EPS || Number(ar.cnt) !== Number(sales.cnt)) {
      console.log(`  WARN: sales↔ar_documents drift Σ=${fmt(arDrift)} cnt Δ=${Number(sales.cnt) - Number(ar.cnt)}`
        + ' (legitimate for pre-O2C history; informational only)');
    }
  }

  const drift = r2(Number(facts.total) - Number(sales.total));
  const cntDelta = Number(facts.cnt) - Number(sales.cnt);
  if (Math.abs(drift) > EPS || cntDelta !== 0) {
    console.log(`\nFAIL: sales↔facts drift Σ=${fmt(drift)} cnt Δ=${cntDelta} — run the backfill / drain analytics_projection_repair.`);
    process.exit(1);
  }
  console.log('\nOK: facts tie to the register within 0.01.');
  process.exit(0);
}

main().catch((e) => { console.error('reconcile FATAL:', e); process.exit(2); });
