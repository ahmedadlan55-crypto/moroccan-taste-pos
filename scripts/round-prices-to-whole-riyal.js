'use strict';
/*
 * scripts/round-prices-to-whole-riyal.js — tune stored prices so the
 * CUSTOMER-FACING (VAT-inclusive) amount lands on a whole riyal.
 *
 * WHY
 *   The cashier's product card advertises what the customer actually pays —
 *   the VAT-inclusive figure. Prices are stored NET (is_tax_inclusive=0 on
 *   every current menu row), so a 16.00 row displays 18.40. The owner wants
 *   those figures free of halalas, and wants it done by adjusting the PRICES
 *   rather than by rounding at display time — a display-only round would put
 *   the screen and the invoice back out of step, which is the exact bug this
 *   whole change set exists to remove.
 *
 *   So for each row: target = round(inclusive), and the stored net becomes
 *   target / (1 + rate). 16.00 -> displays 18.40 -> target 18 -> stores
 *   15.6522 -> displays 18. Zero-rated / exempt / out-of-scope rows carry no
 *   VAT, so their stored price IS the customer-facing one and simply rounds.
 *
 * THIS FILE IS A THIN WRAPPER.
 *   The planning and writing live in lib/wholeRiyalSweep.js because the ERP
 *   button (POST /api/menu/round-to-whole-riyal) runs the SAME sweep. Two
 *   copies would drift, and drift here means the preview a human approved is
 *   not what got written. Everything below is presentation + the --apply gate.
 *
 * SAFETY (enforced in the library, not here)
 *   • DRY-RUN BY DEFAULT — prints a full before/after report and writes nothing.
 *   • Every row's round-trip is VERIFIED; a row that cannot be made exact is
 *     reported under "needs review" and SKIPPED, never written as a near-miss.
 *   • Single transaction; idempotent; never zeroes a sellable item.
 *   • Covers all three tables that can feed a card price (menu,
 *     price_list_items, channel_menu_items).
 *
 * PREREQUISITE
 *   menu.price must be DECIMAL(10,4). At two decimals 537 of the first 5,000
 *   whole-riyal targets are mathematically unreachable (11.00 SAR @15% needs
 *   9.5652 — 9.57 gives 11.01, 9.56 gives 10.99). The widen runs on boot and in
 *   db/migrations/0023_whole_riyal_pricing.sql. This script checks the column
 *   and refuses to --apply against a narrow one.
 *
 *   node scripts/round-prices-to-whole-riyal.js            # dry-run report
 *   node scripts/round-prices-to-whole-riyal.js --apply    # write
 */
require('dotenv').config();
const db = require('../db/connection');
const { planSweep, applySweep, allWrites, allReview } = require('../lib/wholeRiyalSweep');

const APPLY = process.argv.includes('--apply');

const fmt = (n) => Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const pad = (s, w) => String(s).padEnd(w);

function report(title, group) {
  console.log('\n── ' + title + ' ──');
  if (group.error) { console.log('skipped:', group.error); return; }
  console.log('unchanged (already whole):', group.unchanged,
    '| to change:', group.writes.length, '| needs review:', group.review.length);
  if (group.writes.length) {
    console.log('\n  ' + pad('ITEM', 34) + pad('STORED', 12) + pad('SHOWS NOW', 12) + pad('NEW STORED', 12) + 'WILL SHOW');
    for (const w of group.writes.slice(0, 60)) {
      console.log('  ' + pad(String(w.label).slice(0, 32), 34) + pad(fmt(w.before), 12) +
        pad(w.inclusiveBefore.toFixed(2), 12) + pad(fmt(w.after), 12) + String(w.target));
    }
    if (group.writes.length > 60) console.log('  … and ' + (group.writes.length - 60) + ' more');
  }
  if (group.review.length) {
    console.log('\n  ⚠ NEEDS MANUAL REVIEW (skipped, never written):');
    for (const r of group.review.slice(0, 30)) {
      console.log('  ' + pad(String(r.label).slice(0, 32), 34) + pad(fmt(r.before), 12) + r.reason);
    }
    if (group.review.length > 30) console.log('  … and ' + (group.review.length - 30) + ' more');
  }
}

(async () => {
  const plan = await planSweep(db);

  console.log('═══ round-prices-to-whole-riyal (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ═══');
  console.log('VAT rate (settings.VATRate):', plan.ratePct + '%');
  console.log('menu.price decimal scale:', plan.columnScale == null ? 'unknown' : plan.columnScale);

  if (plan.columnScale != null && plan.columnScale < 4) {
    console.error(
      '\nREFUSING TO RUN: menu.price is DECIMAL(_,' + plan.columnScale + '). Whole-riyal targets are\n' +
      'not all reachable at that precision — 537 of the first 5,000 are impossible at\n' +
      '2 decimals. Start the server once (the boot migration widens it) or apply\n' +
      'db/migrations/0023_whole_riyal_pricing.sql, then re-run.');
    await db.end();
    process.exit(1);
  }

  report('menu.price', plan.menu);
  report('price_list_items.price', plan.priceListItems);
  report('channel_menu_items.override_price', plan.channelOverrides);

  const writes = allWrites(plan);
  const review = allReview(plan);
  console.log('\n═══ TOTAL: ' + writes.length + ' price(s) to change, ' + review.length + ' need review ═══');
  console.log('NOTE: this changes per-unit revenue by up to 0.50 SAR. Review the table above.');

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply once the report looks right.');
    await db.end();
    return;
  }
  if (!writes.length) {
    console.log('\nNothing to write — every price already lands on a whole riyal.');
    await db.end();
    return;
  }

  const written = await applySweep(db, plan);

  // Audit trail — best-effort, exactly like the price routes in routes/menu.js.
  try {
    await db.query(
      'INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at) ' +
      "VALUES (?, 'menu_price_whole_riyal_sweep', 'menu', ?, ?, NOW())",
      ['round-prices-to-whole-riyal', 'ALL', JSON.stringify({
        ratePct: plan.ratePct,
        changes: writes.map((w) => ({ source: w.source, id: w.key, before: w.before, after: w.after, shows: w.target })),
        needsReview: review.length,
      })]);
  } catch (e) {
    console.error('audit log write failed (prices WERE applied):', e.message);
  }

  console.log('\nApplied ' + written + ' price change(s).');
  if (review.length) console.log(review.length + ' row(s) still need a manual decision — see the ⚠ lists above.');
  await db.end();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
