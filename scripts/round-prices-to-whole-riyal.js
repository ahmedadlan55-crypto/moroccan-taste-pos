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
 * THREE TABLES, NOT ONE
 *   A card's price can come from any of three places (routes/pos-v2.js
 *   _channelPriceFor resolves override > channel price list > base menu
 *   price). Tuning only `menu` would leave every channel-priced item showing
 *   halalas, which is precisely the "some cards right, some wrong" symptom
 *   that started this work.
 *
 * SAFETY
 *   • DRY-RUN BY DEFAULT. Prints a full before/after report and writes
 *     nothing. Pass --apply to write.
 *   • Every row's round-trip is VERIFIED (lib/pricing.snapToWholeRiyal
 *     recomputes the inclusive amount from the new stored price). A row that
 *     cannot be made exact is REPORTED and SKIPPED — never written with a
 *     near-miss.
 *   • Single transaction: either the whole sweep lands or none of it does.
 *   • Idempotent — a row already on a whole riyal is left untouched, so
 *     re-running after a VAT-rate change only fixes what drifted.
 *   • Never zeroes a sellable item: a price that would round to 0 is floored
 *     at 1 riyal and listed under "needs review".
 *
 * PREREQUISITE
 *   menu.price must be DECIMAL(10,4). At two decimals 537 of the first 5,000
 *   whole-riyal targets are mathematically unreachable (11.00 SAR @15% needs
 *   9.5652 — 9.57 gives 11.01, 9.56 gives 10.99). The widen runs on boot and
 *   in db/migrations/0023_whole_riyal_pricing.sql. This script checks the
 *   column and refuses to --apply against a narrow one rather than writing
 *   hundreds of near-misses.
 *
 *   node scripts/round-prices-to-whole-riyal.js            # dry-run report
 *   node scripts/round-prices-to-whole-riyal.js --apply    # write
 */
require('dotenv').config();
const db = require('../db/connection');
const { snapToWholeRiyal, getVatRateFromDb } = require('../lib/pricing');

const APPLY = process.argv.includes('--apply');

const fmt = (n) => Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const pad = (s, w) => String(s).padEnd(w);

/** Is menu.price wide enough to hold a 4-decimal net? */
async function priceColumnScale() {
  try {
    const [rows] = await db.query(
      "SELECT NUMERIC_SCALE AS s FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'price'");
    return rows.length ? Number(rows[0].s) : null;
  } catch (_) {
    return null; // unknown — treated as "cannot verify", reported below
  }
}

/**
 * Plan one table's changes. Returns { writes, review, unchanged }.
 * `rows` must carry: key, label, price, taxCategory, isInclusive.
 */
function planRows(rows, ratePct) {
  const writes = [], review = [];
  let unchanged = 0;
  for (const r of rows) {
    const before = Number(r.price) || 0;
    const snap = snapToWholeRiyal(before, {
      taxCategory: r.taxCategory,
      isInclusive: r.isInclusive,
      ratePct: ratePct
    });
    if (!snap.exact) {
      review.push({ ...r, before, after: snap.price, reason: 'round-trip not exact' });
      continue;
    }
    // A price that would have rounded to zero was floored at 1 riyal by the
    // snap. That is a real pricing decision, not a rounding — surface it.
    if (before > 0 && snap.inclusiveBefore < 0.5) {
      review.push({ ...r, before, after: snap.price, reason: 'would round to 0 — floored at 1 SAR' });
      continue;
    }
    if (!snap.changed) { unchanged++; continue; }
    writes.push({ ...r, before, after: snap.price, target: snap.target, inclusiveBefore: snap.inclusiveBefore });
  }
  return { writes, review, unchanged };
}

function report(title, plan) {
  console.log('\n── ' + title + ' ──');
  console.log('unchanged (already whole):', plan.unchanged, '| to change:', plan.writes.length, '| needs review:', plan.review.length);
  if (plan.writes.length) {
    console.log('\n  ' + pad('ITEM', 34) + pad('STORED', 12) + pad('SHOWS NOW', 12) + pad('NEW STORED', 12) + 'WILL SHOW');
    for (const w of plan.writes.slice(0, 60)) {
      console.log('  ' + pad(String(w.label).slice(0, 32), 34) + pad(fmt(w.before), 12) +
        pad(w.inclusiveBefore.toFixed(2), 12) + pad(fmt(w.after), 12) + String(w.target));
    }
    if (plan.writes.length > 60) console.log('  … and ' + (plan.writes.length - 60) + ' more');
  }
  if (plan.review.length) {
    console.log('\n  ⚠ NEEDS MANUAL REVIEW (skipped, never written):');
    for (const r of plan.review.slice(0, 30)) {
      console.log('  ' + pad(String(r.label).slice(0, 32), 34) + pad(fmt(r.before), 12) + r.reason);
    }
    if (plan.review.length > 30) console.log('  … and ' + (plan.review.length - 30) + ' more');
  }
}

(async () => {
  const ratePct = await getVatRateFromDb(db, 15);
  const scale = await priceColumnScale();

  console.log('═══ round-prices-to-whole-riyal (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ═══');
  console.log('VAT rate (settings.VATRate):', ratePct + '%');
  console.log('menu.price decimal scale:', scale == null ? 'unknown' : scale);

  if (scale != null && scale < 4) {
    console.error(
      '\nREFUSING TO RUN: menu.price is DECIMAL(_,' + scale + '). Whole-riyal targets are\n' +
      'not all reachable at that precision — 537 of the first 5,000 are impossible at\n' +
      '2 decimals. Start the server once (the boot migration widens it) or apply\n' +
      'db/migrations/0023_whole_riyal_pricing.sql, then re-run.');
    await db.end();
    process.exit(1);
  }

  // ── menu (includes combos: a combo IS a menu row with is_combo=1) ─────────
  const [menuRows] = await db.query(
    "SELECT id, name, price, COALESCE(tax_category,'S') AS tc, COALESCE(is_tax_inclusive,0) AS ti " +
    'FROM menu WHERE COALESCE(is_deleted,0)=0');
  const menuPlan = planRows(menuRows.map((m) => ({
    key: m.id, label: m.name, price: m.price, taxCategory: m.tc, isInclusive: Number(m.ti) === 1
  })), ratePct);

  // ── price_list_items — the channel price list that OVERRIDES the base price.
  // Tax treatment comes from the linked menu row: the price list stores an
  // amount, not a tax policy.
  let plPlan = { writes: [], review: [], unchanged: 0 };
  try {
    const [plRows] = await db.query(
      "SELECT pli.id, pli.price, pl.name AS list_name, m.name AS item_name, " +
      "COALESCE(m.tax_category,'S') AS tc, COALESCE(m.is_tax_inclusive,0) AS ti " +
      'FROM price_list_items pli ' +
      'JOIN menu m ON m.id = pli.item_id ' +
      'LEFT JOIN price_lists pl ON pl.id = pli.price_list_id');
    plPlan = planRows(plRows.map((r) => ({
      key: r.id, label: (r.list_name ? r.list_name + ' / ' : '') + r.item_name,
      price: r.price, taxCategory: r.tc, isInclusive: Number(r.ti) === 1
    })), ratePct);
  } catch (e) {
    console.error('price_list_items skipped:', e.message);
  }

  // ── channel_menu_items.override_price — the per-channel manual override.
  let chPlan = { writes: [], review: [], unchanged: 0 };
  try {
    const [chRows] = await db.query(
      "SELECT cmi.id, cmi.override_price AS price, sc.name AS channel_name, m.name AS item_name, " +
      "COALESCE(m.tax_category,'S') AS tc, COALESCE(m.is_tax_inclusive,0) AS ti " +
      'FROM channel_menu_items cmi ' +
      'JOIN menu m ON m.id = cmi.menu_item_id ' +
      'LEFT JOIN sales_channels sc ON sc.id = cmi.channel_id ' +
      'WHERE cmi.override_price IS NOT NULL');
    chPlan = planRows(chRows.map((r) => ({
      key: r.id, label: (r.channel_name ? r.channel_name + ' / ' : '') + r.item_name,
      price: r.price, taxCategory: r.tc, isInclusive: Number(r.ti) === 1
    })), ratePct);
  } catch (e) {
    console.error('channel_menu_items skipped:', e.message);
  }

  report('menu.price (' + menuRows.length + ' rows)', menuPlan);
  report('price_list_items.price', plPlan);
  report('channel_menu_items.override_price', chPlan);

  const totalWrites = menuPlan.writes.length + plPlan.writes.length + chPlan.writes.length;
  const totalReview = menuPlan.review.length + plPlan.review.length + chPlan.review.length;
  console.log('\n═══ TOTAL: ' + totalWrites + ' price(s) to change, ' + totalReview + ' need review ═══');
  console.log('NOTE: this changes per-unit revenue by up to 0.50 SAR. Review the table above.');

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply once the report looks right.');
    await db.end();
    return;
  }
  if (!totalWrites) {
    console.log('\nNothing to write — every price already lands on a whole riyal.');
    await db.end();
    return;
  }

  await db.withTransaction(async (conn) => {
    for (const w of menuPlan.writes) {
      await conn.query('UPDATE menu SET price = ? WHERE id = ?', [w.after, w.key]);
    }
    for (const w of plPlan.writes) {
      await conn.query('UPDATE price_list_items SET price = ? WHERE id = ?', [w.after, w.key]);
    }
    for (const w of chPlan.writes) {
      await conn.query('UPDATE channel_menu_items SET override_price = ? WHERE id = ?', [w.after, w.key]);
    }
  });

  // Audit trail — best-effort, exactly like the price routes in routes/menu.js.
  try {
    await db.query(
      "INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at) " +
      "VALUES (?, 'menu_price_whole_riyal_sweep', 'menu', ?, ?, NOW())",
      ['round-prices-to-whole-riyal', 'ALL', JSON.stringify({
        ratePct: ratePct,
        menu: menuPlan.writes.map((w) => ({ id: w.key, before: w.before, after: w.after, shows: w.target })),
        priceListItems: plPlan.writes.map((w) => ({ id: w.key, before: w.before, after: w.after, shows: w.target })),
        channelOverrides: chPlan.writes.map((w) => ({ id: w.key, before: w.before, after: w.after, shows: w.target })),
        needsReview: totalReview
      })]);
  } catch (e) {
    console.error('audit log write failed (prices WERE applied):', e.message);
  }

  console.log('\nApplied ' + totalWrites + ' price change(s).');
  if (totalReview) console.log(totalReview + ' row(s) still need a manual decision — see the ⚠ lists above.');
  await db.end();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
