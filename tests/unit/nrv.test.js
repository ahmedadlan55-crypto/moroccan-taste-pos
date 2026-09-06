#!/usr/bin/env node
'use strict';
/**
 * tests/unit/nrv.test.js — every NRV formula, pinned without a database.
 *
 * WHAT THIS FILE PINS (lib/nrv.js)
 *   1. VAT is stripped ONLY from a tax-inclusive, standard-rated price; NULL
 *      inclusive counts as inclusive; the rate is the caller's, never 15.
 *   2. unitsPerSale = base_quantity (fallback quantity) ÷ yield (fallback 1);
 *      a zero quantity is unknown (null), not free.
 *   3. Prudence: of several qualifying products the LOWEST net selling price
 *      is the basis, and it is named on the row.
 *   4. No basis ⇒ nrvUnit / writeDownUnit / writeDown are null and the row
 *      says 'no-basis'; the totals' write-down sums basis rows ONLY and the
 *      unmeasured rows are counted.
 *   5. The write-down is clamped at 0 — never a write-up.
 *   6. Products below cost: recipe cost wins over BOM cost only when it came
 *      from the recipe engine and is > 0; neither ⇒ counted in noCostCount,
 *      never listed; no sales source ⇒ soldQty/exposure null, never 0.
 */

const path = require('path');
const NRV = require(path.join(__dirname, '..', '..', 'lib', 'nrv.js'));

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }
function near(name, actual, expected, eps) {
  check(name, actual != null && Math.abs(actual - expected) <= (eps || 1e-9), { actual, expected });
}

// ── 1. VAT stripping ──────────────────────────────────────────────────────
{
  near('inclusive + S strips VAT at the CALLER\'s rate', NRV.netSellingPrice(23, 15, { isTaxInclusive: 1, taxCategory: 'S' }), 20);
  near('a different rate strips differently — nothing is hardcoded to 15', NRV.netSellingPrice(22, 10, { isTaxInclusive: 1, taxCategory: 'S' }), 20);
  near('NULL is_tax_inclusive counts as inclusive', NRV.netSellingPrice(23, 15, { isTaxInclusive: null, taxCategory: 'S' }), 20);
  near('a tax-EXCLUSIVE price is already net', NRV.netSellingPrice(23, 15, { isTaxInclusive: 0, taxCategory: 'S' }), 23);
  near('a zero-rated product has no VAT to strip', NRV.netSellingPrice(23, 15, { isTaxInclusive: 1, taxCategory: 'Z' }), 23);
  near('nor an exempt one', NRV.netSellingPrice(23, 15, { isTaxInclusive: 1, taxCategory: 'E' }), 23);
  eq('a missing price is null, not 0', NRV.netSellingPrice(null, 15, { isTaxInclusive: 1, taxCategory: 'S' }), null);
}

// ── Settings parsing ──────────────────────────────────────────────────────
{
  eq('an absent VATRate is null so the caller can REFUSE', NRV.parseVatRate(undefined), null);
  eq('a blank VATRate is null too', NRV.parseVatRate('  '), null);
  eq('a non-numeric VATRate is null', NRV.parseVatRate('fifteen'), null);
  eq('a stored "15" parses', NRV.parseVatRate('15'), 15);
  eq('an absent selling-cost pct is 0 (no estimate ⇒ nothing deducted)', NRV.parseSellingCostPct(undefined), 0);
  eq('a stored pct parses', NRV.parseSellingCostPct('12.5'), 12.5);
  eq('a pct of 100 or more is unusable (null), not silently 0', NRV.parseSellingCostPct('100'), null);
  eq('a negative pct is unusable', NRV.parseSellingCostPct('-1'), null);
}

// ── 2. units per sale ─────────────────────────────────────────────────────
{
  near('base_quantity ÷ yield', NRV.unitsPerSale({ baseQuantity: 2, quantity: 1, yieldQuantity: 4 }), 0.5);
  near('base_quantity wins over quantity', NRV.unitsPerSale({ baseQuantity: 3, quantity: 1, yieldQuantity: 1 }), 3);
  near('quantity is the fallback when base_quantity is NULL', NRV.unitsPerSale({ baseQuantity: null, quantity: 2, yieldQuantity: 1 }), 2);
  near('yield falls back to 1', NRV.unitsPerSale({ baseQuantity: 2, quantity: 2, yieldQuantity: null }), 2);
  near('a zero yield also falls back to 1', NRV.unitsPerSale({ baseQuantity: 2, quantity: 2, yieldQuantity: 0 }), 2);
  eq('a zero quantity is UNKNOWN, not free', NRV.unitsPerSale({ baseQuantity: 0, quantity: 0, yieldQuantity: 1 }), null);
}

// ── per-unit formulas ─────────────────────────────────────────────────────
{
  near('nrvUnit = net × (1 − pct) ÷ units', NRV.nrvUnit(20, 10, 2), 9);
  eq('no units ⇒ no NRV', NRV.nrvUnit(20, 0, null), null);
  near('write-down = cost − NRV', NRV.writeDownUnit(10, 4), 6);
  // ── 5. clamp ──
  eq('NRV above cost is NOT a write-up', NRV.writeDownUnit(10, 30), 0);
  eq('no NRV ⇒ null, not 0', NRV.writeDownUnit(10, null), null);
}

// ── 3 + 4 + 5. the report over rows ───────────────────────────────────────
{
  const items = [
    { itemId: 'FLOUR', itemName: 'دقيق', unit: 'كجم', quantity: 8, unitCost: 10 },
    { itemId: 'SALT', itemName: 'ملح', unit: 'كجم', quantity: 7, unitCost: 4 },      // no recipe uses it
    { itemId: 'OIL', itemName: 'زيت', unit: 'لتر', quantity: 3, unitCost: 5 },
  ];
  const candidates = [
    // FLOUR goes into two products. Prudence picks the LOWER net price
    // (11.5 incl. ⇒ 10 net), even though the other product's NRV per unit
    // would be far higher.
    { itemId: 'FLOUR', menuId: 'M-CHEAP', productName: 'خبز', price: 11.5, isTaxInclusive: 1, taxCategory: 'S', quantity: 2, baseQuantity: 2, yieldQuantity: 1 },
    { itemId: 'FLOUR', menuId: 'M-DEAR', productName: 'كعكة', price: 46, isTaxInclusive: 1, taxCategory: 'S', quantity: 1, baseQuantity: 1, yieldQuantity: 1 },
    // OIL: one product, NRV well above cost ⇒ 'ok' with a ZERO write-down.
    { itemId: 'OIL', menuId: 'M-FRY', productName: 'مقلي', price: 34.5, isTaxInclusive: 1, taxCategory: 'S', quantity: 1, baseQuantity: 1, yieldQuantity: 1 },
    // a candidate for an item that is NOT in the stocked list is ignored
    { itemId: 'GHOST', menuId: 'M-X', productName: 'x', price: 1, isTaxInclusive: 1, taxCategory: 'S', quantity: 1, baseQuantity: 1, yieldQuantity: 1 },
  ];
  const { rows, totals } = NRV.buildNrvRows({ items, candidates, vatRatePct: 15, sellingCostPct: 0 });
  const flour = rows.find((r) => r.itemId === 'FLOUR');
  const salt = rows.find((r) => r.itemId === 'SALT');
  const oil = rows.find((r) => r.itemId === 'OIL');

  eq('the prudent basis is the LOWEST net selling price', flour.basisSource, 'menu:M-CHEAP');
  eq('and it is named', flour.basisProductName, 'خبز');
  near('net price on the row is VAT-stripped', flour.netSellingPrice, 10);
  near('units per sale from the chosen line', flour.unitsPerSale, 2);
  near('NRV per unit = 10 ÷ 2', flour.nrvUnit, 5);
  near('write-down per unit = 10 − 5', flour.writeDownUnit, 5);
  near('write-down = 5 × 8', flour.writeDown, 40);
  eq('and the row is impaired', flour.status, 'impaired');

  eq('an unpriced item has NO basis', salt.basisSource, null);
  eq('its NRV is null, not 0', salt.nrvUnit, null);
  eq('its write-down per unit is null, not 0', salt.writeDownUnit, null);
  eq('its write-down is null, not 0', salt.writeDown, null);
  eq('and it says so', salt.status, 'no-basis');
  near('but its carrying value is still stated', salt.inventoryValue, 28);

  eq('NRV above cost is clamped to a zero write-down', oil.writeDownUnit, 0);
  eq('and the row is ok', oil.status, 'ok');

  eq('totals.items counts every row', totals.items, 3);
  eq('totals.itemsWithBasis', totals.itemsWithBasis, 2);
  eq('totals.noBasisCount counts the unmeasured', totals.noBasisCount, 1);
  eq('totals.impairedItems', totals.impairedItems, 1);
  near('totals.inventoryValue is over ALL rows', totals.inventoryValue, 80 + 28 + 15);
  near('totals.writeDown sums basis rows ONLY', totals.writeDown, 40);
  eq('largest write-down first, unmeasured last', rows.map((r) => r.itemId).join(','), 'FLOUR,OIL,SALT');
}

// selling-cost pct and the exclusive/zero-rated paths through the report
{
  const items = [{ itemId: 'A', itemName: 'a', unit: 'u', quantity: 1, unitCost: 10 }];
  const candidates = [{ itemId: 'A', menuId: 'M', productName: 'p', price: 20, isTaxInclusive: 0, taxCategory: 'S', quantity: 2, baseQuantity: null, yieldQuantity: 1 }];
  const { rows } = NRV.buildNrvRows({ items, candidates, vatRatePct: 15, sellingCostPct: 10 });
  near('exclusive price is not stripped; pct deducted; quantity fallback', rows[0].nrvUnit, (20 * 0.9) / 2);
  eq('the pct is carried on the row', rows[0].sellingCostPct, 10);
  near('write-down = 10 − 9', rows[0].writeDownUnit, 1);
}

// a candidate whose line cannot say how much it consumes is not a basis
{
  const items = [{ itemId: 'A', itemName: 'a', unit: 'u', quantity: 1, unitCost: 10 }];
  const candidates = [{ itemId: 'A', menuId: 'M', productName: 'p', price: 20, isTaxInclusive: 1, taxCategory: 'S', quantity: 0, baseQuantity: 0, yieldQuantity: 1 }];
  const { rows } = NRV.buildNrvRows({ items, candidates, vatRatePct: 15, sellingCostPct: 0 });
  eq('a zero-quantity line yields no basis, not a divide-by-zero', rows[0].status, 'no-basis');
}

// ── 6. products below cost ────────────────────────────────────────────────
{
  const products = [
    // recipe cost 12 > net 10 ⇒ listed under 'recipe' (BOM cost ignored)
    { menuId: 'P-RECIPE', productName: 'خبز', price: 11.5, isTaxInclusive: 1, taxCategory: 'S', menuCost: 12, menuCostSource: 'recipe', bomCostPerUnit: 8 },
    // manual menu cost is NOT a recipe cost ⇒ BOM cost 35 > net 30 ⇒ 'bom'
    { menuId: 'P-BOM', productName: 'كعكة', price: 34.5, isTaxInclusive: 1, taxCategory: 'S', menuCost: 50, menuCostSource: 'manual', bomCostPerUnit: 35 },
    // recipe source but a ZERO cost ⇒ falls through to BOM
    { menuId: 'P-ZERO', productName: 'صفر', price: 11.5, isTaxInclusive: 1, taxCategory: 'S', menuCost: 0, menuCostSource: 'recipe', bomCostPerUnit: 11 },
    // priced above cost ⇒ not a row
    { menuId: 'P-FINE', productName: 'بخير', price: 46, isTaxInclusive: 1, taxCategory: 'S', menuCost: 12, menuCostSource: 'recipe', bomCostPerUnit: null },
    // no cost anywhere ⇒ counted, never listed
    { menuId: 'P-NOCOST', productName: 'مجهول', price: 1.15, isTaxInclusive: 1, taxCategory: 'S', menuCost: 0, menuCostSource: null, bomCostPerUnit: null },
    // exclusive price ⇒ not stripped: 20 net vs cost 15 ⇒ fine
    { menuId: 'P-EXCL', productName: 'حصري', price: 20, isTaxInclusive: 0, taxCategory: 'S', menuCost: 15, menuCostSource: 'recipe', bomCostPerUnit: null },
  ];
  const sold = new Map([['P-RECIPE', 3], ['P-ZERO', 10]]);
  const { rows, totals } = NRV.buildBelowCostRows({ products, vatRatePct: 15, sold });
  const byId = new Map(rows.map((r) => [r.menuId, r]));

  eq('only products under cost are rows', rows.length, 3);
  eq('recipe cost wins when it came from the recipe engine', byId.get('P-RECIPE').costSource, 'recipe');
  near('and the BOM cost is ignored', byId.get('P-RECIPE').unitCost, 12);
  near('shortfall per unit', byId.get('P-RECIPE').shortfallUnit, 2);
  near('margin is negative', byId.get('P-RECIPE').marginPct, -20);
  near('soldQty from the window', byId.get('P-RECIPE').soldQty, 3);
  near('exposure = shortfall × sold', byId.get('P-RECIPE').exposure, 6);
  eq('a manual menu cost is not a recipe cost ⇒ BOM', byId.get('P-BOM').costSource, 'bom');
  near('with the BOM figure', byId.get('P-BOM').unitCost, 35);
  eq('a product with a source but no sales sold 0 (the table exists and says so)', byId.get('P-BOM').soldQty, 0);
  eq('a zero recipe cost falls through to the BOM', byId.get('P-ZERO').costSource, 'bom');
  eq('status is always below-cost', byId.get('P-ZERO').status, 'below-cost');
  eq('an unpriced product is counted', totals.noCostCount, 1);
  eq('totals.products', totals.products, 3);
  near('totals.exposure sums rows with soldQty', totals.exposure, 6 + 0 + 10 * (11 - 10));
  eq('biggest exposure first', rows[0].menuId, 'P-ZERO');
}

// no sales source on this server ⇒ null, never 0
{
  const products = [{ menuId: 'P', productName: 'p', price: 11.5, isTaxInclusive: 1, taxCategory: 'S', menuCost: 12, menuCostSource: 'recipe', bomCostPerUnit: null }];
  const { rows, totals } = NRV.buildBelowCostRows({ products, vatRatePct: 15, sold: null });
  eq('soldQty is null without a source', rows[0].soldQty, null);
  eq('exposure is null without a source', rows[0].exposure, null);
  eq('and so is the total', totals.exposure, null);
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ NRV: VAT stripped only when present; prudence picks the lowest net price; no basis is null, never 0; write-down clamped at 0');
console.log(pass + '/' + pass + ' passed');
