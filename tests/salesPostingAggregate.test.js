#!/usr/bin/env node
'use strict';
/**
 * tests/salesPostingAggregate.test.js — queue rows → ONE balanced journal.
 *
 * Rows are built through the REAL capture path, never hand-written, so the
 * sign convention is exercised end to end. Hand-written fixtures are how the
 * bug in section 2 got in: fixtures that state a shape the producer never
 * emits will happily prove the wrong thing.
 *
 * Run: node tests/salesPostingAggregate.test.js   (pure, no DB)
 */
const A = require('../lib/salesPosting/aggregate');
const cap = require('../lib/salesPosting/capture');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

const ACC = { revenue: '4100', outputVat: '2210', cogs: '5100', inventory: '1200', cashFallback: '1110' };

let seq = 0;
function row(type, occurred, { net, tax, gross, cogs = 0, pay = '1110', brand = null, branch = null } = {}) {
  seq += 1;
  const r = cap.buildQueueRow({
    sourceType: type, sourceId: 'SRC-' + seq, occurredAt: new Date(occurred),
    net, tax, gross, cogs, brandId: brand, branchId: branch, invoiceNumber: 'INV-' + seq,
    payments: [{ code: pay, amount: gross }],
    revenue: [{ code: '4100', amount: net }, { code: '2210', amount: tax, tax: true }],
    cogsByWarehouse: cogs ? [{ warehouseId: 'WH1', amount: cogs, cogsCode: '5100', inventoryCode: '1200' }] : [],
  });
  return { ...r, id: seq };
}
const leg = (b, code) => b.legs.find((l) => l.accountCode === code) || { debit: 0, credit: 0 };

// ── 1. A return posts the REVERSE of a sale ──────────────────────────────
// The bug this pins: queue money columns are signed, and an earlier version
// ALSO applied the sign to the payload splits inside the aggregator. Two
// negations cancelled, and a refund came out «Dr cash / Cr revenue» — the
// exact direction of a sale. A refund booking as a sale is the worst failure
// this subsystem can produce, and nothing in the row's shape revealed it.
{
  const sale = A.planBatches([row('sale', '2026-07-28T12:00:00Z', { net: 100, tax: 15, gross: 115, cogs: 40 })], 'invoice', ACC)[0];
  const ret = A.planBatches([row('return', '2026-07-28T14:00:00Z', { net: 100, tax: 15, gross: 115, cogs: 40 })], 'invoice', ACC)[0];

  check('a sale DEBITS cash', leg(sale, '1110').debit === 115 && leg(sale, '1110').credit === 0, sale.legs);
  check('a sale CREDITS revenue', leg(sale, '4100').credit === 100 && leg(sale, '4100').debit === 0);
  check('a sale CREDITS output VAT', leg(sale, '2210').credit === 15);
  check('a sale DEBITS COGS and CREDITS inventory',
    leg(sale, '5100').debit === 40 && leg(sale, '1200').credit === 40);

  check('a return CREDITS cash (money goes out)', leg(ret, '1110').credit === 115 && leg(ret, '1110').debit === 0, ret.legs);
  check('a return DEBITS revenue', leg(ret, '4100').debit === 100 && leg(ret, '4100').credit === 0);
  check('a return DEBITS output VAT', leg(ret, '2210').debit === 15);
  check('a return CREDITS COGS and DEBITS inventory (stock comes back)',
    leg(ret, '5100').credit === 40 && leg(ret, '1200').debit === 40);

  check('both balance', sale.balanced && ret.balanced);
  check('no leg ever carries a negative amount',
    [...sale.legs, ...ret.legs].every((l) => l.debit >= 0 && l.credit >= 0));
}

// ── 2. Returns are separate LINES, never a netting-off ───────────────────
// The owner must be able to tell a slow day from a heavy-refund day. A single
// quietly-reduced revenue figure hides exactly that.
{
  const rows = [
    row('sale', '2026-07-28T12:00:00Z', { net: 100, tax: 15, gross: 115, cogs: 40, pay: '1110' }),
    row('sale', '2026-07-28T13:00:00Z', { net: 200, tax: 30, gross: 230, cogs: 80, pay: '1120' }),
    row('return', '2026-07-28T14:00:00Z', { net: 50, tax: 7.5, gross: 57.5, cogs: 20, pay: '1110' }),
  ];
  const b = A.planBatches(rows, 'daily', ACC)[0];
  check('one daily batch for one day', b.itemCount === 3);
  check('sales and returns are counted separately', b.salesCount === 2 && b.returnCount === 1, b);
  check('net is the signed sum', b.net === 250, b.net);
  check('cash nets within its own account', leg(b, '1110').debit === 57.5, b.legs);
  check('a different payment method keeps its own leg', leg(b, '1120').debit === 230);
  check('revenue is the signed total', leg(b, '4100').credit === 250);
  check('COGS is the signed total', leg(b, '5100').debit === 100);
  check('the batch balances', b.balanced && b.postable, b.warnings);
}

// ── 3. Granularity reslices the SAME queue ───────────────────────────────
// Not three queues. Every mode must reach the same money and still enumerate
// its invoices — «مع رؤية التفصيل في كل الحالات».
{
  const rows = [
    row('sale', '2026-07-28T12:00:00Z', { net: 100, tax: 15, gross: 115, cogs: 40 }),
    row('sale', '2026-07-29T12:00:00Z', { net: 200, tax: 30, gross: 230, cogs: 80 }),
    row('sale', '2026-08-02T12:00:00Z', { net: 300, tax: 45, gross: 345, cogs: 120 }),
  ];
  const daily = A.planBatches(rows, 'daily', ACC);
  const monthly = A.planBatches(rows, 'monthly', ACC);
  const invoice = A.planBatches(rows, 'invoice', ACC);

  check('daily → 3 batches', daily.length === 3, daily.map((b) => b.label));
  check('monthly → 2 batches', monthly.length === 2, monthly.map((b) => b.label));
  check('invoice → 3 batches', invoice.length === 3);

  const sum = (bs) => bs.reduce((s, b) => s + Math.round(b.net * 100), 0);
  check('all three granularities carry identical money',
    sum(daily) === 60000 && sum(monthly) === 60000 && sum(invoice) === 60000,
    [sum(daily), sum(monthly), sum(invoice)]);
  check('every batch can still list its invoices',
    [...daily, ...monthly, ...invoice].every((b) => b.sources.length === b.itemCount));
  check('monthly labels are months', monthly.every((b) => /^\d{4}-\d{2}$/.test(b.label)), monthly.map((b) => b.label));
  check('the queue ids are carried for claiming',
    daily.every((b) => b.queueIds.length === b.itemCount));
}

// ── 4. Brand and branch never merge ──────────────────────────────────────
// Merging branches into one journal would destroy the only per-branch P&L the
// owner has, and make the dimension columns meaningless.
{
  const rows = [
    row('sale', '2026-07-28T12:00:00Z', { net: 100, tax: 15, gross: 115, branch: 'BR-1' }),
    row('sale', '2026-07-28T13:00:00Z', { net: 200, tax: 30, gross: 230, branch: 'BR-2' }),
  ];
  const b = A.planBatches(rows, 'daily', ACC);
  check('same day, two branches → two batches', b.length === 2, b.map((x) => x.branchId));
  check('each keeps its own branch', b.map((x) => x.branchId).sort().join() === 'BR-1,BR-2');

  // …but two NULL-branch rows must land together. With a raw null in a joined
  // key they would compare unequal and split into two batches.
  const nulls = A.planBatches([
    row('sale', '2026-07-28T12:00:00Z', { net: 10, tax: 0, gross: 10 }),
    row('sale', '2026-07-28T13:00:00Z', { net: 20, tax: 0, gross: 20 }),
  ], 'daily', ACC);
  check('two null-branch rows land in ONE batch', nulls.length === 1, nulls.length);
}

// ── 5. The journal date is the LATEST calendar date in the bucket ────────
// A batch dated earlier than an event it contains would post into a period
// that event was never allowed into.
{
  // Both are the same trading night; the second is after midnight, so its
  // calendar date is the next day.
  const rows = [
    row('sale', '2026-07-28T20:00:00Z', { net: 100, tax: 0, gross: 100 }),  // 23:00 Riyadh 07-28
    row('sale', '2026-07-28T22:30:00Z', { net: 100, tax: 0, gross: 100 }),  // 01:30 Riyadh 07-29
  ];
  const b = A.planBatches(rows, 'daily', ACC);
  check('one trading night → one batch', b.length === 1, b.map((x) => x.label));
  check('the batch is labelled by the trading night', b[0].label === '2026-07-28', b[0].label);
  check('but dated by the LATEST calendar date it contains', b[0].journalDate === '2026-07-29', b[0].journalDate);
}

// ── 6. Halalas, and the money check ──────────────────────────────────────
{
  // Thirds: 3 × 33.33 = 99.99 against a 100.00 total. Per-leg rounding, which
  // must be absorbed rather than reported.
  const rows = [1, 2, 3].map(() => row('sale', '2026-07-28T12:00:00Z', { net: 33.33, tax: 0, gross: 33.33 }));
  const b = A.planBatches(rows, 'daily', ACC)[0];
  check('a rounding residual still balances', b.balanced, b);
  check('…and is not reported as a mismatch',
    !b.warnings.some((w) => w.startsWith('PAYMENT_MISMATCH')), b.warnings);
  check('…and the batch stays postable', b.postable);

  // A real disagreement — the payment split does not match the totals — must
  // be REFUSED, not plugged.
  const bad = cap.buildQueueRow({
    sourceType: 'sale', sourceId: 'BAD', occurredAt: new Date('2026-07-28T12:00:00Z'),
    net: 100, tax: 15, gross: 115,
    payments: [{ code: '1110', amount: 999 }],
    revenue: [{ code: '4100', amount: 100 }, { code: '2210', amount: 15, tax: true }],
  });
  const bb = A.planBatches([{ ...bad, id: 99 }], 'invoice', ACC)[0];
  check('a real payment mismatch is reported',
    bb.warnings.some((w) => w.startsWith('PAYMENT_MISMATCH')), bb.warnings);
  check('…and the batch is NOT postable', bb.postable === false);
}

// ── 7. Degenerate input ──────────────────────────────────────────────────
{
  check('no rows → no batches', A.planBatches([], 'daily', ACC).length === 0);
  check('an unknown granularity throws', (() => {
    try { A.planBatches([], 'weekly', ACC); return false; } catch (_) { return true; }
  })());
  check('the granularities are exactly daily/monthly/invoice',
    JSON.stringify(A.GRANULARITIES) === JSON.stringify(['daily', 'monthly', 'invoice']));

  // A row with no payment split must still balance — via the fallback — and
  // must SAY it fell back rather than inventing a payment method silently.
  const bare = cap.buildQueueRow({ sourceType: 'sale', sourceId: 'BARE',
    occurredAt: new Date('2026-07-28T12:00:00Z'), net: 100, tax: 15, gross: 115 });
  const b = A.planBatches([{ ...bare, id: 1 }], 'invoice', ACC)[0];
  check('a split-less row still balances', b.balanced, b.legs);
  check('…on the fallback account', leg(b, '1110').debit === 115);
  check('…and says so', b.warnings.some((w) => /no payment split/.test(w)), b.warnings);
}

// ── 8. Purity — preview and post must come from one function ─────────────
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'salesPosting', 'aggregate.js'), 'utf8');
  check('the aggregator touches no database', !/require\(.*db\/connection/.test(src) && !/\.query\(/.test(src));
  check('…and no clock', !/Date\.now\(\)|new Date\(\)/.test(src));
  check('…and no randomness', !/Math\.random/.test(src));

  const rows = [row('sale', '2026-07-28T12:00:00Z', { net: 100, tax: 15, gross: 115, cogs: 40 })];
  check('two calls give an identical plan',
    JSON.stringify(A.planBatches(rows, 'daily', ACC)) === JSON.stringify(A.planBatches(rows, 'daily', ACC)));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ aggregation: returns reverse, granularity reslices one queue, halalas balance');
