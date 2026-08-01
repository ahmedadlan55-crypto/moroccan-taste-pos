'use strict';
/*
 * tests/wholeRiyalPricing.test.js — lib/pricing.snapToWholeRiyal.
 *
 * Pins the finding that forced db/migrations/0023: at DECIMAL(10,2) a large
 * fraction of whole-riyal targets are mathematically UNREACHABLE, and at
 * DECIMAL(10,4) none are. If menu.price ever narrows back to 2 decimals, or
 * someone "simplifies" the 4-decimal rounding inside snapToWholeRiyal, the
 * sweep below fails loudly instead of the register quietly showing 18.40s again.
 *
 * Pure — no DB, no network. Run via `npm test`.
 */
const assert = require('assert');
const { snapToWholeRiyal, DEFAULT_VAT_RATE } = require('../lib/pricing');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
let passed = 0;
function it(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('✗ ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// ── The core promise: the displayed amount is a whole riyal ─────────────────
it('turns a standard-rated net price into one whose inclusive amount is whole', () => {
  const r = snapToWholeRiyal(16, { taxCategory: 'S', isInclusive: false, ratePct: 15 });
  assert.strictEqual(r.inclusiveBefore, 18.4, 'was showing 18.40');
  assert.strictEqual(r.target, 18);
  assert.strictEqual(r.price, 15.6522);
  assert.strictEqual(r2(r.price * 1.15), 18, 'must display exactly 18.00');
  assert.strictEqual(r.exact, true);
  assert.strictEqual(r.changed, true);
});

it('leaves a zero-rated item alone — its stored price IS the customer-facing one', () => {
  const r = snapToWholeRiyal(18, { taxCategory: 'Z', isInclusive: false, ratePct: 15 });
  assert.strictEqual(r.price, 18);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.exact, true);
});

it('rounds a zero-rated fractional price to a whole riyal directly', () => {
  const r = snapToWholeRiyal(18.4, { taxCategory: 'Z', isInclusive: false, ratePct: 15 });
  assert.strictEqual(r.price, 18);
  assert.strictEqual(r.target, 18);
});

it('does not double-tax a price already stored inclusive', () => {
  const r = snapToWholeRiyal(18.4, { taxCategory: 'S', isInclusive: true, ratePct: 15 });
  assert.strictEqual(r.target, 18);
  assert.strictEqual(r.price, 18);
});

it('is IDEMPOTENT — a tuned price survives a second sweep untouched', () => {
  const once = snapToWholeRiyal(16, { taxCategory: 'S', ratePct: 15 });
  const twice = snapToWholeRiyal(once.price, { taxCategory: 'S', ratePct: 15 });
  assert.strictEqual(twice.price, once.price);
  assert.strictEqual(twice.changed, false, 're-running the script must be a no-op');
});

it('never zeroes a sellable item — a sub-half-riyal price floors at 1 SAR', () => {
  const r = snapToWholeRiyal(0.4, { taxCategory: 'S', ratePct: 15 });
  assert.strictEqual(r.target, 1, 'rounding to 0 would make the item free');
  assert.ok(r.price > 0);
});

it('leaves a zero price alone (free / not-yet-priced rows)', () => {
  const r = snapToWholeRiyal(0, { taxCategory: 'S', ratePct: 15 });
  assert.strictEqual(r.price, 0);
  assert.strictEqual(r.changed, false);
});

it('honours a non-default VAT rate rather than assuming 15', () => {
  const r = snapToWholeRiyal(100, { taxCategory: 'S', ratePct: 5 });
  assert.strictEqual(r.target, 105);
  assert.strictEqual(r2(r.price * 1.05), 105);
});

// ── THE MIGRATION-JUSTIFYING SWEEP ─────────────────────────────────────────
it('every whole-riyal target is reachable at 4 decimals, across every plausible rate', () => {
  for (const ratePct of [0, 5, 10, 15, DEFAULT_VAT_RATE]) {
    const rate = ratePct / 100;
    const misses = [];
    for (let target = 1; target <= 2000; target++) {
      const r = snapToWholeRiyal(target / (1 + rate), { taxCategory: 'S', ratePct: ratePct });
      if (!r.exact || r.target !== target) misses.push(target);
    }
    assert.strictEqual(misses.length, 0,
      'rate ' + ratePct + '% missed ' + misses.length + ' targets, e.g. ' + misses.slice(0, 5).join(', '));
  }
});

it('DOCUMENTS why the column had to widen: 2 decimals cannot hit every target', () => {
  // Not a behaviour assertion — a guard on the premise of migration 0023. If
  // this ever reports zero, the widen was unnecessary and the comment in
  // db/migrations/0023_whole_riyal_pricing.sql needs revisiting.
  const r2dp = (n) => Math.round(n * 100) / 100;
  let unreachable = 0;
  for (let target = 1; target <= 5000; target++) {
    if (r2(r2dp(target / 1.15) * 1.15) !== target) unreachable++;
  }
  assert.ok(unreachable > 500,
    'expected hundreds of unreachable targets at DECIMAL(_,2); got ' + unreachable);
  // The concrete example quoted in the migration file.
  assert.notStrictEqual(r2(r2dp(11 / 1.15) * 1.15), 11, '11.00 SAR must be unreachable at 2dp');
});

console.log('wholeRiyalPricing: ' + passed + ' passed');
