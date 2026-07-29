#!/usr/bin/env node
'use strict';
/**
 * tests/accountingDate.test.js — journal dates are Riyadh calendar dates.
 *
 * THE BUG: every `journalDate` in the system was `new Date().toISOString()
 * .slice(0, 10)` — UTC. Riyadh is UTC+3, so a sale rung between 00:00 and
 * 02:59 local was posted to the ledger under the PREVIOUS calendar day, while
 * the same sale's invoice number (local getters) and its ZATCA stamp (Intl)
 * both said today. One sale, two dates.
 *
 * The same expression drove `assertPeriodOpen`, so a 01:00 sale on the 1st was
 * checked against the previous month — refused when that month was closed, and
 * waved through into a month that was supposed to be finished when it wasn't.
 *
 * This file pins the fix AND the two ways it can silently regress:
 *   • a `require` landing inside a comment block (already happened three times
 *     in this codebase — it survives `node --check` AND module load, then
 *     throws at request time into a catch that returns HTTP 200)
 *   • a new `journalDate:` site reintroducing toISOString()
 *
 * Run: node tests/accountingDate.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const acct = require('../lib/accountingDate');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

// ── 1. The bug itself ────────────────────────────────────────────────────
{
  // 2026-07-29 01:30 Riyadh === 2026-07-28 22:30 UTC. The old code said the
  // 28th; the invoice said the 29th.
  const lateNight = new Date('2026-07-28T22:30:00Z');
  check('a 01:30 Riyadh sale is dated to that same local day',
    acct.journalDate(lateNight) === '2026-07-29', acct.journalDate(lateNight));
  check('…which is exactly what the old UTC expression got wrong',
    lateNight.toISOString().slice(0, 10) === '2026-07-28');

  // Month boundary — the case that made period locks reject a valid sale.
  const firstOfMonth = new Date('2026-07-31T21:15:00Z');   // 2026-08-01 00:15 Riyadh
  check('a 00:15 sale on the 1st belongs to the NEW month',
    acct.journalDate(firstOfMonth) === '2026-08-01', acct.journalDate(firstOfMonth));

  // Year boundary.
  check('a 00:30 sale on Jan 1 belongs to the new YEAR',
    acct.journalDate(new Date('2025-12-31T21:30:00Z')) === '2026-01-01');

  // Daytime is unaffected — the fix must not move the other 21 hours.
  check('a midday sale is unchanged',
    acct.journalDate(new Date('2026-07-29T09:00:00Z')) === '2026-07-29');
  check('23:59 Riyadh stays on its own day',
    acct.journalDate(new Date('2026-07-29T20:59:00Z')) === '2026-07-29');
}

// ── 2. It must not read process.env.TZ ───────────────────────────────────
// server.js defaults TZ to Asia/Riyadh, but a deployment that overrode it
// would have silently re-dated the entire ledger.
{
  // Comment-strip before asserting: the module's own docs explain WHY it does
  // not read process.env.TZ, and a naive scan matches that prose. Same class
  // of mistake as a require landing inside a comment block.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'accountingDate.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check('the module never reads process.env', !/process\.env/.test(src), src.match(/.*process\.env.*/));
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    check('the answer does not change when TZ is hostile',
      acct.journalDate(new Date('2026-07-28T22:30:00Z')) === '2026-07-29');
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  check('an explicit zone is honoured',
    acct.journalDate(new Date('2026-07-28T22:30:00Z'), 'UTC') === '2026-07-28');
}

// ── 3. toAccountingDate normalises without re-introducing the shift ──────
{
  check('a Date goes through the local-calendar path',
    acct.toAccountingDate(new Date('2026-07-28T22:30:00Z')) === '2026-07-29');
  // A string that ALREADY carries a date is truncated, never re-parsed —
  // running '2026-07-29' back through Date() would shift it to the 28th.
  check('a plain date string is truncated, not re-parsed',
    acct.toAccountingDate('2026-07-29') === '2026-07-29');
  check('a DATETIME string keeps its own day',
    acct.toAccountingDate('2026-07-29 01:30:00') === '2026-07-29');
  check('null means now', /^\d{4}-\d{2}-\d{2}$/.test(acct.toAccountingDate(null)));
  check('an invalid date throws rather than posting to NaN', (() => {
    try { acct.journalDate('not a date'); return false; } catch (_) { return true; }
  })());
}

// ── 4. No journalDate site may go back to UTC ────────────────────────────
{
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'routes'));
  ['lib', 'services'].forEach((d) => (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, d)));

  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/journalDate\s*:/.test(line) && /toISOString/.test(line)) {
        offenders.push(path.relative(ROOT, f) + ':' + (i + 1));
      }
    });
  }
  check('no journalDate is computed from toISOString()', offenders.length === 0, offenders);
  check('the sweep actually scanned the tree', files.length > 50, files.length);
}

// ── 5. Every `require` of accountingDate is real code, not a comment ─────
// This exact failure has shipped three times: an inserted require landing
// inside a /** */ block passes `node --check`, passes module load, and then
// throws `x is not defined` at request time — into a catch that returns
// HTTP 200 with an empty body. Comment-strip first, THEN look for it.
{
  const consumers = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/\bacctDate\s*\./.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) consumers.push(p);
      }
    }
  })(ROOT === path.join(ROOT) ? path.join(ROOT, 'routes') : ROOT);
  ['lib', 'services'].forEach((d) => (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/\bacctDate\s*\./.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) consumers.push(p);
      }
    }
  })(path.join(ROOT, d)));

  check('at least the known consumers were found', consumers.length >= 7, consumers.length);
  const broken = [];
  for (const f of consumers) {
    const stripped = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    if (!/(?:const|let|var)\s+acctDate\s*=\s*require\(/.test(stripped)) broken.push(path.relative(ROOT, f));
  }
  check('every file that USES acctDate has a real require statement for it',
    broken.length === 0, broken);

  // And the modules must actually load with the symbol bound.
  for (const m of ['../lib/glPosting', '../routes/erp/periods']) {
    let ok = true;
    try { require(m); } catch (e) { ok = false; failures.push(`${m} failed to load: ${e.message}`); }
    check(`${m} loads`, ok);
  }
}

// ── 6. A void must reverse the channel-commission journal too ────────────
// A delivery-channel sale posts TWO journals: 'Sale' (revenue/VAT/COGS) and
// 'ChannelCommission' (Dr 5500 commission / Cr 2320 payable). The void swept
// only 'Sale', so voiding an aggregator order left a permanent expense and a
// permanent payable behind — for an order that no longer exists, and whose
// `sales` row the same function can hard-delete.
{
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'sales.js'), 'utf8');
  const commitTypes = src.match(/reference_type IN \(\?, \?\) AND reference_id = \?'[\s\S]{0,120}?\]\);/);
  check('the void query selects both reference types',
    /reference_type IN \(\?, \?\) AND reference_id = \?/.test(src));
  check('…and names ChannelCommission explicitly',
    commitTypes && /'Sale', 'ChannelCommission'/.test(commitTypes[0]), commitTypes && commitTypes[0]);
  check('the commission journal is still posted under that exact type',
    /referenceType: 'ChannelCommission'/.test(src));
  // Guard against the reverse regression: a single-type query coming back.
  check('no single-type Sale-only journal sweep remains',
    !/reference_type = \?[\s\S]{0,80}\['Sale', orderId\]/.test(src));
}

// ── 7. One definition of «the period is closed» ──────────────────────────
// assertPeriodOpen blocked only {closed, locked} while glPosting also blocks
// {soft_close, soft_closed}. A sale into a soft-closed period passed the front
// guard, ran the whole checkout, then died inside postJournal with a generic
// GL_POSTING_FAILED — the cashier saw an unexplained failure, not a reason.
{
  const gl = require('../lib/glPosting');
  const periodsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'erp', 'periods.js'), 'utf8');
  check('glPosting still exports the list', Array.isArray(gl.PERIOD_CLOSED_STATUSES));
  check('…and it covers both soft spellings',
    ['closed', 'locked', 'soft_close', 'soft_closed'].every((s) => gl.PERIOD_CLOSED_STATUSES.includes(s)),
    gl.PERIOD_CLOSED_STATUSES);
  check('assertPeriodOpen uses that list rather than its own',
    /glPosting\.PERIOD_CLOSED_STATUSES\.includes/.test(periodsSrc));
  check('…and no hand-written status comparison survives',
    !/status === 'closed' \|\| status === 'locked'/.test(periodsSrc));

  // The fail DIRECTIONS must stay opposite — availability for the till,
  // integrity for the ledger. Collapsing them either way is a real hazard.
  check('_statusAt still degrades to open (a broken table must not stop the till)',
    /return 'open';[\s\S]{0,40}\}\s*\n\}/.test(periodsSrc) || /degraded to open/.test(periodsSrc));
  const glSrc = fs.readFileSync(path.join(ROOT, 'lib', 'glPosting.js'), 'utf8');
  check('isPeriodClosed still fails closed (a broken table must not leak into a closed book)',
    /refusing to post \(fail-closed\)[\s\S]{0,80}return true;/.test(glSrc));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ journal dates are Riyadh calendar dates, and every acctDate require is real code');
