#!/usr/bin/env node
/**
 * scripts/analytics/backfill-facts.js — backfill the Unified Sales Analytics
 * fact tables from historical operational data.
 *
 * Usage:
 *   node scripts/analytics/backfill-facts.js                 # DRY RUN (default): count candidates, write nothing
 *   node scripts/analytics/backfill-facts.js --apply         # actually project facts
 *   node scripts/analytics/backfill-facts.js --apply --batch=5000 --from=2026-01-01 --to=2026-06-30
 *   node scripts/analytics/backfill-facts.js --apply --reset # ignore + clear the saved cursor
 *
 * Passes (in order):
 *   A  ar_documents invoices (source_type='pos')      → order/payment/modifier facts (via projectPosSale)
 *   B  orphan pos sales (no ar_document — O2C was off) → same facts keyed by the sale id
 *   C  O2C sales_returns (posted)                      → CN order fact + 'refund' payment facts + cash_refund till
 *   D  legacy credit_notes                             → CN order fact + 'cn_refund' payment facts + cash_refund till
 *   E  shifts                                          → open_float / close_count till facts
 *   F  cash_receipts / cash_payments (posted, branch-scoped cash boxes) → pay_in / pay_out
 *   G  customer_payments (posted)                      → 'ar_receipt' payment facts
 *
 * All writes carry provenance 'backfilled'; combo modifier rows get price_delta
 * NULL (the historical price split is unknowable). Sales missing a branch land
 * on branch_id 'UNASSIGNED' (handled inside ProjectionService). Every write is
 * an upsert on the fact tables' unique keys → a re-run produces ZERO new rows.
 *
 * Resumable: cursor {pass, lastId} persisted in analytics_rollup_state under key
 * 'backfill_cursor' (best-effort — if that table/columns differ, the run simply
 * starts from the top; idempotency makes that safe). Dirty business days are
 * enqueued by the projection functions themselves (INSERT IGNORE).
 */
'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..', '..')); // repo root — .env + relative requires

const Projection = require('../../services/analytics/ProjectionService');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESET = args.includes('--reset');
function _opt(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const BATCH = Math.max(100, Number(_opt('batch', 5000)) || 5000);
const FROM = _opt('from', null); // YYYY-MM-DD inclusive
const TO = _opt('to', null);     // YYYY-MM-DD inclusive

function dateWhere(col) {
  const parts = [];
  const params = [];
  if (FROM) { parts.push(`DATE(${col}) >= ?`); params.push(FROM); }
  if (TO) { parts.push(`DATE(${col}) <= ?`); params.push(TO); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

// ── cursor persistence (best-effort, schema-tolerant) ───────────────────────
const CURSOR_KEY = 'backfill_cursor';
// analytics_rollup_state is (k VARCHAR(40) PK, v VARCHAR(200)) per the analytics
// migration; the other column-name guesses are kept as tolerant fallbacks.
async function loadCursor(db) {
  for (const cols of [['k', 'v'], ['state_key', 'state_value'], ['setting_key', 'setting_value']]) {
    try {
      const [r] = await db.query(
        `SELECT \`${cols[1]}\` AS v FROM analytics_rollup_state WHERE \`${cols[0]}\` = ? LIMIT 1`, [CURSOR_KEY]);
      if (r.length && r[0].v) return JSON.parse(r[0].v);
      return null;
    } catch (_) { /* try next column-name guess */ }
  }
  return null;
}
async function saveCursor(db, cursor) {
  const val = JSON.stringify(cursor);
  for (const cols of [['k', 'v'], ['state_key', 'state_value'], ['setting_key', 'setting_value']]) {
    try {
      await db.query(
        `INSERT INTO analytics_rollup_state (\`${cols[0]}\`, \`${cols[1]}\`) VALUES (?,?)
         ON DUPLICATE KEY UPDATE \`${cols[1]}\` = VALUES(\`${cols[1]}\`)`, [CURSOR_KEY, val]);
      return true;
    } catch (_) { /* try next */ }
  }
  return false; // no state table — still safe, everything is idempotent
}
async function clearCursor(db) {
  for (const col of ['k', 'state_key', 'setting_key']) {
    try { await db.query(`DELETE FROM analytics_rollup_state WHERE \`${col}\` = ?`, [CURSOR_KEY]); return; }
    catch (_) {}
  }
}

// ── counters ────────────────────────────────────────────────────────────────
const stats = { processed: {}, skipped: {}, failed: {} };
function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }

const FACT_TABLES = [
  'analytics_order_facts', 'analytics_payment_facts',
  'analytics_modifier_facts', 'analytics_till_facts', 'analytics_rollup_dirty',
];
async function factCounts(db) {
  const out = {};
  for (const t of FACT_TABLES) {
    try { const [r] = await db.query(`SELECT COUNT(*) AS c FROM \`${t}\``); out[t] = Number(r[0].c); }
    catch (_) { out[t] = null; } // table not created yet (BE-A migration pending)
  }
  return out;
}

/** Run one keyset-paginated pass. fetchBatch(lastId) → rows [{id, ...}]; handle(row). */
async function runPass(db, passName, startAfter, fetchBatch, handle) {
  let lastId = startAfter || '';
  let total = 0;
  for (;;) {
    const rows = await fetchBatch(lastId);
    if (!rows.length) break;
    for (const row of rows) {
      const res = await Projection.safeProject(db, 'backfill:' + passName, row.id, () => handle(row));
      if (res === null) bump(stats.failed, passName);
      else if (res && res.skipped) bump(stats.skipped, passName + ':' + res.skipped);
      else bump(stats.processed, passName);
      lastId = row.id;
    }
    total += rows.length;
    await saveCursor(db, { pass: passName, lastId });
    console.log(`  [${passName}] …processed ${total} (last id ${lastId})`);
    if (rows.length < BATCH) break;
  }
  return total;
}

async function main() {
  const db = require('../../db/connection');
  console.log(`backfill-facts — mode: ${APPLY ? 'APPLY' : 'DRY RUN (use --apply to write)'}; batch=${BATCH}`
    + (FROM ? `; from=${FROM}` : '') + (TO ? `; to=${TO}` : ''));

  // ── DRY RUN: count candidates only, write NOTHING ──
  if (!APPLY) {
    const q = async (label, sql, params) => {
      try { const [r] = await db.query(sql, params); console.log(`  ${label}: ${r[0].c}`); }
      catch (e) { console.log(`  ${label}: n/a (${e.code || e.message})`); }
    };
    const dIssue = dateWhere('d.issue_date');
    await q('A  pos invoices (ar_documents)',
      `SELECT COUNT(*) AS c FROM ar_documents d WHERE d.source_type='pos' AND d.document_type='invoice'${dIssue.sql}`, dIssue.params);
    const dSale = dateWhere('s.order_date');
    await q('B  orphan pos sales (no ar_document)',
      `SELECT COUNT(*) AS c FROM sales s LEFT JOIN ar_documents d ON d.source_type='pos' AND d.source_id = s.id
        WHERE d.id IS NULL${dSale.sql}`, dSale.params);
    const dRet = dateWhere('r.return_date');
    await q('C  posted sales_returns',
      `SELECT COUNT(*) AS c FROM sales_returns r WHERE r.status='posted'${dRet.sql}`, dRet.params);
    const dCn = dateWhere('c.issue_date');
    await q('D  legacy credit_notes',
      `SELECT COUNT(*) AS c FROM credit_notes c WHERE 1=1${dCn.sql}`, dCn.params);
    const dSh = dateWhere('sh.start_time');
    await q('E  shifts',
      `SELECT COUNT(*) AS c FROM shifts sh WHERE 1=1${dSh.sql}`, dSh.params);
    const dRc = dateWhere('r.receipt_date');
    await q('F1 posted cash receipts (cash box + branch)',
      `SELECT COUNT(*) AS c FROM cash_receipts r WHERE r.status='posted' AND r.destination_type='cash' AND r.branch_id IS NOT NULL${dRc.sql}`, dRc.params);
    const dPy = dateWhere('p.payment_date');
    await q('F2 posted cash payments (cash box + branch)',
      `SELECT COUNT(*) AS c FROM cash_payments p WHERE p.status='posted' AND p.source_type='cash' AND p.branch_id IS NOT NULL${dPy.sql}`, dPy.params);
    const dCp = dateWhere('p.payment_date');
    await q('G  posted customer_payments',
      `SELECT COUNT(*) AS c FROM customer_payments p WHERE p.status='posted'${dCp.sql}`, dCp.params);
    console.log('\nDry run complete — nothing written.');
    process.exit(0);
  }

  // ── APPLY ──
  const before = await factCounts(db);
  if (Object.values(before).every((v) => v === null)) {
    console.error('FATAL: none of the analytics fact tables exist — run the analytics migration (BE-A) first.');
    process.exit(2);
  }

  if (RESET) await clearCursor(db);
  const cursor = RESET ? null : await loadCursor(db);
  if (cursor) console.log(`resuming from saved cursor: pass=${cursor.pass} lastId=${cursor.lastId}`);
  const PASS_ORDER = ['A', 'B', 'C', 'D', 'E', 'F1', 'F2', 'G'];
  const startIdx = cursor ? Math.max(0, PASS_ORDER.indexOf(cursor.pass)) : 0;
  const startAfterFor = (p) => (cursor && cursor.pass === p ? cursor.lastId : '');
  const shouldRun = (p) => PASS_ORDER.indexOf(p) >= startIdx;
  const prov = { provenance: 'backfilled' };

  // A — pos invoices in ar_documents
  if (shouldRun('A')) {
    const d = dateWhere('d.issue_date');
    await runPass(db, 'A', startAfterFor('A'),
      async (lastId) => (await db.query(
        `SELECT d.id, d.source_id FROM ar_documents d
          WHERE d.source_type='pos' AND d.document_type='invoice' AND d.id > ?${d.sql}
          ORDER BY d.id LIMIT ${BATCH}`, [lastId, ...d.params]))[0],
      (row) => Projection.projectPosSale(db, row.source_id, prov));
  }

  // B — orphan pos sales (no ar_document; O2C flag was off when they sold)
  if (shouldRun('B')) {
    const d = dateWhere('s.order_date');
    await runPass(db, 'B', startAfterFor('B'),
      async (lastId) => (await db.query(
        `SELECT s.id FROM sales s
           LEFT JOIN ar_documents d ON d.source_type='pos' AND d.source_id = s.id
          WHERE d.id IS NULL AND s.id > ?${d.sql}
          ORDER BY s.id LIMIT ${BATCH}`, [lastId, ...d.params]))[0],
      (row) => Projection.projectPosSale(db, row.id, prov));
  }

  // C — posted O2C returns (their CN ar_document + refund facts)
  if (shouldRun('C')) {
    const d = dateWhere('r.return_date');
    await runPass(db, 'C', startAfterFor('C'),
      async (lastId) => (await db.query(
        `SELECT r.id FROM sales_returns r
          WHERE r.status='posted' AND r.id > ?${d.sql}
          ORDER BY r.id LIMIT ${BATCH}`, [lastId, ...d.params]))[0],
      (row) => Projection.projectReturn(db, { returnId: row.id, provenance: 'backfilled' }));
  }

  // D — legacy credit_notes (routes/sales.js /return path)
  if (shouldRun('D')) {
    const d = dateWhere('c.issue_date');
    await runPass(db, 'D', startAfterFor('D'),
      async (lastId) => (await db.query(
        `SELECT c.id FROM credit_notes c WHERE c.id > ?${d.sql} ORDER BY c.id LIMIT ${BATCH}`,
        [lastId, ...d.params]))[0],
      (row) => Projection.projectReturn(db, { creditNoteId: row.id, provenance: 'backfilled' }));
  }

  // E — shifts → open_float + close_count (close only when status='closed';
  //     projectTillMovement reads opening_float / actual_cash / payment_totals_json)
  if (shouldRun('E')) {
    const d = dateWhere('sh.start_time');
    await runPass(db, 'E', startAfterFor('E'),
      async (lastId) => (await db.query(
        `SELECT sh.id, sh.status FROM shifts sh WHERE sh.id > ?${d.sql} ORDER BY sh.id LIMIT ${BATCH}`,
        [lastId, ...d.params]))[0],
      async (row) => {
        const a = await Projection.projectTillMovement(db, { type: 'open_float', shiftId: row.id, provenance: 'backfilled' });
        if (String(row.status).toLowerCase() === 'closed') {
          await Projection.projectTillMovement(db, { type: 'close_count', shiftId: row.id, provenance: 'backfilled' });
        }
        return a;
      });
  }

  // F — branch-scoped cash-box vouchers → pay_in / pay_out
  if (shouldRun('F1')) {
    const d = dateWhere('r.receipt_date');
    await runPass(db, 'F1', startAfterFor('F1'),
      async (lastId) => (await db.query(
        `SELECT r.id FROM cash_receipts r
          WHERE r.status='posted' AND r.destination_type='cash' AND r.branch_id IS NOT NULL AND r.id > ?${d.sql}
          ORDER BY r.id LIMIT ${BATCH}`, [lastId, ...d.params]))[0],
      (row) => Projection.projectCashVoucher(db, 'cash_receipt', row.id, prov));
  }
  if (shouldRun('F2')) {
    const d = dateWhere('p.payment_date');
    await runPass(db, 'F2', startAfterFor('F2'),
      async (lastId) => (await db.query(
        `SELECT p.id FROM cash_payments p
          WHERE p.status='posted' AND p.source_type='cash' AND p.branch_id IS NOT NULL AND p.id > ?${d.sql}
          ORDER BY p.id LIMIT ${BATCH}`, [lastId, ...d.params]))[0],
      (row) => Projection.projectCashVoucher(db, 'cash_payment', row.id, prov));
  }

  // G — posted AR receipts
  if (shouldRun('G')) {
    const d = dateWhere('p.payment_date');
    await runPass(db, 'G', startAfterFor('G'),
      async (lastId) => (await db.query(
        `SELECT p.id FROM customer_payments p
          WHERE p.status='posted' AND p.id > ?${d.sql} ORDER BY p.id LIMIT ${BATCH}`,
        [lastId, ...d.params]))[0],
      (row) => Projection.projectArReceipt(db, row.id, prov));
  }

  await clearCursor(db); // full run finished — next invocation starts clean

  // ── summary ──
  const after = await factCounts(db);
  console.log('\n═══ backfill summary ═══');
  console.log('rows added per fact table:');
  for (const t of FACT_TABLES) {
    const b = before[t], a = after[t];
    console.log(`  ${t}: ${b == null || a == null ? 'n/a' : `+${a - b} (now ${a})`}`);
  }
  console.log('processed:', JSON.stringify(stats.processed));
  console.log('skipped:  ', JSON.stringify(stats.skipped));
  console.log('failed:   ', JSON.stringify(stats.failed),
    Object.keys(stats.failed).length ? '→ see analytics_projection_repair for details' : '');
  process.exit(Object.keys(stats.failed).length ? 1 : 0);
}

main().catch((e) => { console.error('backfill FATAL:', e); process.exit(2); });
