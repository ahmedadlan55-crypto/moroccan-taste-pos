'use strict';
/*
 * lib/wholeRiyalSweep.js — plan and apply the whole-riyal price sweep.
 *
 * WHY THIS IS A LIBRARY AND NOT JUST THE SCRIPT
 *   Two callers need this logic: the CLI tool
 *   (scripts/round-prices-to-whole-riyal.js) for whoever is on the server, and
 *   POST /api/menu/round-to-whole-riyal for the owner clicking a button in the
 *   ERP. Two copies of "which tables feed a card price, and how is each one
 *   snapped" would drift the first time one of them was touched — and drift
 *   here means the preview a human approved is not what actually got written.
 *
 * THREE TABLES, NOT ONE
 *   A cashier card's price comes from whichever of these wins in
 *   routes/pos-v2.js _channelPriceFor: channel override > channel price list >
 *   base menu price. Sweeping only `menu` leaves every channel-priced item
 *   showing halalas — the exact "some cards right, some wrong" symptom this
 *   work exists to remove. Combos need no special case: a combo IS a `menu` row
 *   with is_combo=1.
 *
 * THE VERIFY GATE
 *   snapToWholeRiyal recomputes its own round-trip and reports `exact`. A row
 *   that cannot be hit exactly is placed in `review` and NEVER written. A wrong
 *   price is worse than a fractional one — a near-miss would put the screen and
 *   the invoice back out of step, which is the whole defect being fixed.
 */
const { snapToWholeRiyal, getVatRateFromDb } = require('./pricing');

/**
 * PURE. Split rows into what to write, what a human must look at, and what is
 * already correct.
 *
 * @param {Array<{key, label, price, taxCategory, isInclusive}>} rows
 * @param {number} ratePct
 * @returns {{writes: Array, review: Array, unchanged: number}}
 */
function planRows(rows, ratePct) {
  const writes = [], review = [];
  let unchanged = 0;
  for (const r of rows || []) {
    const before = Number(r.price) || 0;
    const snap = snapToWholeRiyal(before, {
      taxCategory: r.taxCategory,
      isInclusive: r.isInclusive,
      ratePct: ratePct,
    });
    if (!snap.exact) {
      review.push({ ...r, before: before, after: snap.price, reason: 'round-trip not exact' });
      continue;
    }
    // A price that would have rounded to zero was floored at 1 riyal by the
    // snap. That is a pricing DECISION, not a rounding — a human decides it.
    if (before > 0 && snap.inclusiveBefore < 0.5) {
      review.push({ ...r, before: before, after: snap.price, reason: 'would round to 0 — floored at 1 SAR' });
      continue;
    }
    if (!snap.changed) { unchanged++; continue; }
    writes.push({
      ...r,
      before: before,
      after: snap.price,
      target: snap.target,
      inclusiveBefore: snap.inclusiveBefore,
    });
  }
  return { writes: writes, review: review, unchanged: unchanged };
}

/**
 * Is menu.price wide enough to hold a 4-decimal net? At DECIMAL(_,2) a large
 * share of whole-riyal targets are unreachable (11.00 SAR @15% needs 9.5652 —
 * 9.57 gives 11.01, 9.56 gives 10.99), so a sweep against a narrow column would
 * write hundreds of near-misses. Returns null when it cannot be determined.
 */
async function priceColumnScale(conn) {
  try {
    const [rows] = await conn.query(
      'SELECT NUMERIC_SCALE AS s FROM INFORMATION_SCHEMA.COLUMNS ' +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu' AND COLUMN_NAME = 'price'");
    return rows.length ? Number(rows[0].s) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Read every price that can reach a product card and plan the sweep.
 * READ-ONLY — writes nothing. Feeds both the CLI dry-run and the ERP preview.
 */
async function planSweep(conn) {
  const ratePct = await getVatRateFromDb(conn, 15);
  const columnScale = await priceColumnScale(conn);

  // menu — includes combos (a combo is a menu row with is_combo=1).
  const [menuRows] = await conn.query(
    "SELECT id, name, price, COALESCE(tax_category,'S') AS tc, COALESCE(is_tax_inclusive,0) AS ti " +
    'FROM menu WHERE COALESCE(is_deleted,0)=0');
  const menu = planRows(menuRows.map((m) => ({
    key: String(m.id), label: m.name, source: 'menu',
    price: m.price, taxCategory: m.tc, isInclusive: Number(m.ti) === 1,
  })), ratePct);

  // price_list_items — the channel price list. Tax treatment comes from the
  // linked menu row: a price list stores an amount, not a tax policy.
  let priceListItems = { writes: [], review: [], unchanged: 0 };
  try {
    const [rows] = await conn.query(
      'SELECT pli.id, pli.price, pl.name AS list_name, m.name AS item_name, ' +
      "COALESCE(m.tax_category,'S') AS tc, COALESCE(m.is_tax_inclusive,0) AS ti " +
      'FROM price_list_items pli ' +
      'JOIN menu m ON m.id = pli.item_id ' +
      'LEFT JOIN price_lists pl ON pl.id = pli.price_list_id');
    priceListItems = planRows(rows.map((r) => ({
      key: String(r.id), source: 'price_list_items',
      label: (r.list_name ? r.list_name + ' / ' : '') + r.item_name,
      price: r.price, taxCategory: r.tc, isInclusive: Number(r.ti) === 1,
    })), ratePct);
  } catch (e) {
    priceListItems.error = e.message; // table absent on an old deploy — never fatal
  }

  // channel_menu_items.override_price — the per-channel manual override.
  let channelOverrides = { writes: [], review: [], unchanged: 0 };
  try {
    const [rows] = await conn.query(
      'SELECT cmi.id, cmi.override_price AS price, sc.name AS channel_name, m.name AS item_name, ' +
      "COALESCE(m.tax_category,'S') AS tc, COALESCE(m.is_tax_inclusive,0) AS ti " +
      'FROM channel_menu_items cmi ' +
      'JOIN menu m ON m.id = cmi.menu_item_id ' +
      'LEFT JOIN sales_channels sc ON sc.id = cmi.channel_id ' +
      'WHERE cmi.override_price IS NOT NULL');
    channelOverrides = planRows(rows.map((r) => ({
      key: String(r.id), source: 'channel_menu_items',
      label: (r.channel_name ? r.channel_name + ' / ' : '') + r.item_name,
      price: r.price, taxCategory: r.tc, isInclusive: Number(r.ti) === 1,
    })), ratePct);
  } catch (e) {
    channelOverrides.error = e.message;
  }

  return {
    ratePct: ratePct,
    columnScale: columnScale,
    menu: menu,
    priceListItems: priceListItems,
    channelOverrides: channelOverrides,
  };
}

/** Every planned write across the three tables, newest-caller-friendly. */
function allWrites(plan) {
  return [].concat(plan.menu.writes, plan.priceListItems.writes, plan.channelOverrides.writes);
}

/** Every row a human still has to decide on. */
function allReview(plan) {
  return [].concat(plan.menu.review, plan.priceListItems.review, plan.channelOverrides.review);
}

/**
 * Write the plan. ONE transaction — either the whole sweep lands or none of it
 * does, so a half-swept menu can never be what the cashier sells from.
 *
 * `conn` must expose withTransaction (db/connection.js does).
 */
async function applySweep(conn, plan) {
  const writes = allWrites(plan);
  if (!writes.length) return 0;
  await conn.withTransaction(async (tx) => {
    for (const w of plan.menu.writes) {
      await tx.query('UPDATE menu SET price = ? WHERE id = ?', [w.after, w.key]);
    }
    for (const w of plan.priceListItems.writes) {
      await tx.query('UPDATE price_list_items SET price = ? WHERE id = ?', [w.after, w.key]);
    }
    for (const w of plan.channelOverrides.writes) {
      await tx.query('UPDATE channel_menu_items SET override_price = ? WHERE id = ?', [w.after, w.key]);
    }
  });
  return writes.length;
}

module.exports = {
  planRows: planRows,
  planSweep: planSweep,
  applySweep: applySweep,
  allWrites: allWrites,
  allReview: allReview,
  priceColumnScale: priceColumnScale,
};
