#!/usr/bin/env node
'use strict';
/**
 * tests/pricing.test.js — lib/pricing.js, the module its own header calls
 * "THE SINGLE SOURCE OF TRUTH for VAT calculations".
 *
 * It had NO unit test at all, and its EXCLUSIVE branch — the one that runs in
 * production for every menu row (server.js's v7.1 migration set
 * is_tax_inclusive = 0 everywhere) — was therefore completely uncovered while
 * the whole POS test suite asserted the opposite convention. That is how a
 * 16.00 item came to be shown as 16.00 by the register, computed as 18.40 by
 * the server, and rejected as a mismatch.
 *
 * The owner's requirement, asserted here as arithmetic:
 *     price before tax + tax === the number on the invoice.
 */
const assert = require('assert');
const pricing = require('../lib/pricing');

let pass = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; return; }
  failures.push(name);
  console.error('  ✗ ' + name);
}
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// ── EXCLUSIVE (every current menu row) — VAT is ADDED on top ───────────────
{
  const s = pricing.splitLinePrice(16, false, 15);
  check('exclusive 16 @15% → net 16.00', eq(s.net, 16));
  check('exclusive 16 @15% → vat 2.40', eq(Math.round(s.vat * 100) / 100, 2.4));
  check('exclusive 16 @15% → gross 18.40 (the owner\'s example)', eq(Math.round(s.grossPrecise * 100) / 100, 18.4));
  check('exclusive: net + vat === gross EXACTLY', eq(s.net + s.vat, s.grossPrecise));
}
{
  const s = pricing.splitLinePrice(20, false, 15);
  check('exclusive 20 @15% → 20.00 + 3.00 = 23.00', eq(s.net, 20) && eq(s.vat, 3) && eq(s.grossPrecise, 23));
}
{
  // A zero-rated line must never invent VAT, whatever the convention.
  const s = pricing.splitLinePrice(16, false, 0);
  check('exclusive @0% → vat 0 and gross === net', eq(s.vat, 0) && eq(s.grossPrecise, 16));
}

// ── INCLUSIVE (an item the owner explicitly flags) — VAT is EXTRACTED ──────
{
  const s = pricing.splitLinePrice(23, true, 15);
  check('inclusive 23 @15% → net 20.00', eq(Math.round(s.net * 100) / 100, 20));
  check('inclusive 23 @15% → vat 3.00', eq(Math.round(s.vat * 100) / 100, 3));
  check('inclusive: gross is the price itself', eq(s.grossPrecise, 23));
  check('inclusive: net + vat === gross EXACTLY', eq(s.net + s.vat, s.grossPrecise));
}

// ── The two conventions are genuinely different — a regression that ignored
//    the flag would make these equal, which is the whole bug. ───────────────
{
  const inc = pricing.splitLinePrice(16, true, 15);
  const exc = pricing.splitLinePrice(16, false, 15);
  check('the flag CHANGES the customer-facing amount (16 → 16.00 vs 18.40)',
    !eq(inc.grossPrecise, exc.grossPrecise));
  check('inclusive keeps the price; exclusive raises it',
    eq(inc.grossPrecise, 16) && exc.grossPrecise > 16);
}

// ── The rate is a parameter, not a constant ───────────────────────────────
{
  const s5 = pricing.splitLinePrice(100, false, 5);
  check('a 5% rate is honoured (100 → 105.00)', eq(s5.vat, 5) && eq(s5.grossPrecise, 105));
  const s0 = pricing.splitLinePrice(100, false, 0);
  check('a 0% rate is honoured (100 → 100.00)', eq(s0.vat, 0) && eq(s0.grossPrecise, 100));
}

// ── Degenerate inputs must not produce NaN money ──────────────────────────
{
  const s = pricing.splitLinePrice(0, false, 15);
  check('a zero price yields zero money, not NaN',
    eq(s.net, 0) && eq(s.vat, 0) && eq(s.grossPrecise, 0));
  const bad = pricing.splitLinePrice(10, false, NaN);
  check('a non-numeric rate falls back to the default instead of NaN',
    Number.isFinite(bad.vat) && Number.isFinite(bad.grossPrecise));
}

// ── getVatRateFromDb: the setting governs, with a safe fallback ────────────
(async () => {
  const fakeDb = { query: async () => [[{ setting_value: '5' }]] };
  check('reads settings.VATRate', (await pricing.getVatRateFromDb(fakeDb, 15)) === 5);

  const emptyDb = { query: async () => [[]] };
  check('falls back when the setting row is missing',
    (await pricing.getVatRateFromDb(emptyDb, 15)) === 15);

  const brokenDb = { query: async () => { throw new Error('db down'); } };
  check('falls back (never throws) when the DB read fails',
    (await pricing.getVatRateFromDb(brokenDb, 15)) === 15);

  check('no db at all → fallback', (await pricing.getVatRateFromDb(null, 15)) === 15);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  assert.ok(pass >= 20, 'expected the full matrix to run');
  console.log('✅ pricing: both tax conventions correct — net + vat === total exactly');
})();
