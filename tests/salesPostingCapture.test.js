#!/usr/bin/env node
'use strict';
/**
 * tests/salesPostingCapture.test.js — «ترحيل المبيعات», phase A: capture.
 *
 * The owner's complaint: «كل عملية بيع ترحل بقيد وهذا ليس جيدا». The fix is
 * that a sale ENQUEUES an economic event instead of posting a journal, and a
 * human later posts one aggregated journal per day / month / invoice.
 *
 * Phase A ships the queue and the capture ONLY — no behaviour changes yet.
 * That ordering is deliberate: the risky write is exercised under real
 * production load, and the invariant "no sale escapes the queue" is PROVEN,
 * before any accounting behaviour depends on it.
 *
 * What this file pins is mostly placement and structure, because that is where
 * this design can fail silently.
 *
 * Run: node tests/salesPostingCapture.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cap = require('../lib/salesPosting/capture');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

// ── 1. The two dates, and why they differ ────────────────────────────────
// business_day rolls at the branch close time (04:00) — the trading night, and
// the grain every sales report already uses. calendar_date is the Riyadh
// calendar date, because the journal must carry the same date as the
// ZATCA-stamped invoice. For after-midnight trade they differ by one day, and
// both are right for their own question.
{
  const lateNight = new Date('2026-07-28T22:30:00Z');    // 2026-07-29 01:30 Riyadh
  const r = cap.buildQueueRow({ sourceType: 'sale', sourceId: 'S-1', occurredAt: lateNight,
    net: 100, tax: 15, gross: 115, cogs: 40 });
  check('the trading night is the previous day', r.business_day === '2026-07-28', r.business_day);
  check('the journal/ZATCA date is the calendar day', r.calendar_date === '2026-07-29', r.calendar_date);
  check('…so they legitimately differ for after-midnight trade', r.business_day !== r.calendar_date);

  const midday = new Date('2026-07-29T09:00:00Z');
  const m = cap.buildQueueRow({ sourceType: 'sale', sourceId: 'S-2', occurredAt: midday, net: 1, tax: 0, gross: 1 });
  check('and they agree for daytime trade', m.business_day === m.calendar_date && m.business_day === '2026-07-29', m);
}

// ── 2. A return is a negative event, not a netting-off ───────────────────
// Carrying the sign here lets the aggregator add rows without knowing what
// each one was, while the owner still sees sales and returns as separate
// lines rather than one silently-reduced number.
{
  const sale = cap.buildQueueRow({ sourceType: 'sale', sourceId: 'S', net: 100, tax: 15, gross: 115, cogs: 40 });
  const ret = cap.buildQueueRow({ sourceType: 'return', sourceId: 'R', net: 100, tax: 15, gross: 115, cogs: 40 });
  check('a sale is positive', sale.net_amount === 100 && sale.gross_amount === 115);
  check('a return is negative on every money column',
    ret.net_amount === -100 && ret.tax_amount === -15 && ret.gross_amount === -115 && ret.cogs_amount === -40, ret);
  check('a void is negative too', cap.buildQueueRow({ sourceType: 'void', sourceId: 'V', net: 50 }).net_amount === -50);
  check('the sign is recorded in the payload', JSON.parse(ret.payload_json).sign === -1);
}

// ── 3. Rejects what it cannot post ───────────────────────────────────────
{
  const threw = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  check('an unknown source type is refused', threw(() => cap.buildQueueRow({ sourceType: 'nonsense', sourceId: 'X' })));
  check('a missing source id is refused', threw(() => cap.buildQueueRow({ sourceType: 'sale' })));
  check('the accepted types are exactly sale/return/void',
    JSON.stringify(cap.SOURCE_TYPES) === JSON.stringify(['sale', 'return', 'void']), cap.SOURCE_TYPES);
}

// ── 4. Money is rounded to halalas at capture ────────────────────────────
{
  const r = cap.buildQueueRow({ sourceType: 'sale', sourceId: 'S', net: 33.333333, tax: 5.005, gross: 38.338333 });
  check('net is rounded to 2dp', r.net_amount === 33.33, r.net_amount);
  check('tax is rounded to 2dp', r.tax_amount === 5.01, r.tax_amount);
  check('gross is rounded to 2dp', r.gross_amount === 38.34, r.gross_amount);
}

// ── 5. The splits four totals cannot reconstruct ─────────────────────────
{
  const r = cap.buildQueueRow({
    sourceType: 'sale', sourceId: 'S',
    net: 100, tax: 15, gross: 115, cogs: 40,
    payments: [{ code: '1110', amount: 60 }, { code: '1120', amount: 55 }],
    revenue: [{ code: '4100', amount: 100 }],
    cogsByWarehouse: [{ warehouseId: 'WH-1', amount: 40 }],
  });
  const p = JSON.parse(r.payload_json);
  check('payment split is carried', p.payments.length === 2 && p.payments[0].code === '1110', p.payments);
  check('revenue split is carried', p.revenue.length === 1, p.revenue);
  check('COGS by warehouse is carried', p.cogsByWarehouse[0].warehouseId === 'WH-1', p.cogsByWarehouse);
  // Absent splits must be arrays, never undefined — the aggregator iterates them.
  const bare = JSON.parse(cap.buildQueueRow({ sourceType: 'sale', sourceId: 'B' }).payload_json);
  check('absent splits default to empty arrays',
    Array.isArray(bare.payments) && Array.isArray(bare.revenue) && Array.isArray(bare.cogsByWarehouse), bare);
}

// ── 6. PLACEMENT — the trap this design fails on ─────────────────────────
// routes/sales.js commits at one point and has THREE rollbacks, and the
// idempotent-replay path returns HTTP 200 without reaching the post-commit
// region. A capture placed after the commit is therefore skipped on exactly
// the cases that produce a sale with no posting record — reproducing the hole
// the queue exists to close.
{
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'sales.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

  check('sales.js has a REAL require for the capture module (not one inside a comment)',
    /const salesPostingCapture = require\('\.\.\/lib\/salesPosting\/capture'\)/.test(code));
  check('…and actually calls it', /salesPostingCapture\.capture\(/.test(code));

  const capIdx = code.indexOf('salesPostingCapture.capture(');
  const commitIdx = code.indexOf('await _conn.commit();');
  check('capture runs BEFORE the commit', capIdx > 0 && commitIdx > 0 && capIdx < commitIdx, { capIdx, commitIdx });
  check('capture runs on the TRANSACTION connection, not the pool',
    /salesPostingCapture\.capture\(db,/.test(code));
  check('capture is NOT handed the pool', !/salesPostingCapture\.capture\(_pool/.test(code));

  // It must not be able to take the till down.
  const around = code.slice(Math.max(0, capIdx - 400), capIdx + 900);
  check('the call is wrapped so a queue failure cannot lose a paid sale',
    /try \{[\s\S]*salesPostingCapture\.capture\([\s\S]*?\} catch/.test(around));
}

// ── 7. The capture module may not open its own connection ────────────────
// It runs inside the sale's transaction; taking a second connection would
// deadlock against the row locks that transaction already holds.
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'salesPosting', 'capture.js'), 'utf8');
  check('it never requires the pool', !/require\(.*db\/connection/.test(src));
  check('it never calls getConnection', !/getConnection/.test(src));
  check('it never opens a transaction', !/beginTransaction/.test(src));
  check('it only ever writes the queue table',
    (src.match(/INSERT INTO (\w+)/g) || []).every((s) => /sales_posting_queue/.test(s)),
    src.match(/INSERT INTO (\w+)/g));
  check('it never writes the sales table', !/UPDATE sales\b|DELETE FROM sales\b/.test(src));
}

// ── 8. A posted row is immutable ─────────────────────────────────────────
// Re-capture (a retried checkout, a re-run backfill) refreshes a PENDING
// snapshot but must never disturb one already posted or mid-flight —
// otherwise a re-run would silently rewrite numbers that are already in the
// ledger and already reported.
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'salesPosting', 'capture.js'), 'utf8');
  check('the upsert guards on status', /ON DUPLICATE KEY UPDATE[\s\S]*IF\(status IN \(/.test(src));
  check('the immutable set covers posting, posted and posted_legacy',
    JSON.stringify(cap.IMMUTABLE_STATUSES) === JSON.stringify(['posting', 'posted', 'posted_legacy']),
    cap.IMMUTABLE_STATUSES);
  check('every money column is guarded, not just some',
    ['net_amount', 'tax_amount', 'gross_amount', 'cogs_amount', 'payload_json', 'business_day', 'calendar_date']
      .every((c) => new RegExp(c + '\\s*=\\s*IF\\(status IN').test(src)));
}

// ── 9. The schema makes double-posting unrepresentable ───────────────────
// Nothing in the GL core is idempotent: postJournal never looks for an
// existing journal by reference, and ix_glj_ref is deliberately non-unique. So
// the ledger will not stop a double post — the queue has to.
{
  const src = fs.readFileSync(path.join(ROOT, 'db', 'migrations', 'sales-posting', 'schema.js'), 'utf8');
  check('one queue row per economic event is a UNIQUE KEY',
    /UNIQUE KEY uq_spq_source \(source_type, source_id\)/.test(src));
  check('a batch cannot be double-submitted', /UNIQUE KEY uq_spb_idem \(idempotency_key\)/.test(src));
  check('batch membership is its own append-only table',
    /CREATE TABLE sales_posting_batch_items/.test(src));
  check('the queue carries both dates', /business_day DATE NOT NULL/.test(src) && /calendar_date DATE NOT NULL/.test(src));
  check('the posted journal is snapshotted on the batch', /legs_json JSON NULL/.test(src));
  // Additive only — this must not touch an existing table.
  check('the migration creates tables and alters nothing',
    !/ALTER TABLE/.test(src) && !/DROP /.test(src));
  check('it only creates its own three tables',
    (src.match(/CREATE TABLE (\w+)/g) || []).every((s) => /sales_posting_/.test(s)),
    src.match(/CREATE TABLE (\w+)/g));
}

// ── 10. The invariant is measured, not asserted ──────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'salesPosting', 'capture.js'), 'utf8');
  check('a standing health query exists', typeof cap.countUnqueuedSales === 'function');
  check('…and it LEFT JOINs sales against the queue',
    /LEFT JOIN sales_posting_queue[\s\S]*WHERE q\.id IS NULL/.test(src));

  const boot = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('history is backfilled so the invariant covers all sales',
    /INSERT IGNORE INTO sales_posting_queue/.test(boot));
  check('…as posted_legacy, so it can never be re-posted', /'posted_legacy'/.test(boot));
  check('…and the backfill is resumable rather than one giant statement',
    /LIMIT 2000/.test(boot) && /if \(!r\.affectedRows\) break;/.test(boot));
  check('the schema is applied at boot',
    /db\/migrations\/sales-posting\/schema'\)\.apply/.test(boot));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ sales-posting capture: in-transaction, signed, snapshotted, and double-post-proof by key');
