/**
 * Net realizable value — the arithmetic, over plain rows.
 *
 * ─── WHAT THIS MEASURES ─────────────────────────────────────────────────────
 * IAS 2 §9 carries inventory at the LOWER of cost and net realizable value,
 * where NRV = estimated selling price − estimated costs to sell. A raw
 * material has no selling price of its own; it realises value only through
 * the product it goes into. So the selling basis of an inventory item is a
 * menu product whose active recipe consumes it, and the item's NRV per unit
 * is that product's net price, less costs to sell, spread over the units of
 * the item one sale consumes.
 *
 * ─── THE RULES THE REPORT MUST NOT BEND ─────────────────────────────────────
 *   • VAT is stripped ONLY from a price that contains it: `is_tax_inclusive`
 *     (NULL counts as inclusive — that is the column's default) AND the
 *     standard category 'S'. Zero-rated, exempt and out-of-scope products
 *     carry no VAT to strip, and stripping it anyway would understate NRV.
 *   • The VAT rate is the caller's — from settings — never a literal 15.
 *     `parseVatRate` answers null for a missing setting so the caller can
 *     REFUSE with a code instead of guessing.
 *   • Prudence: when several products qualify, the one with the LOWEST net
 *     selling price is the basis, and it is named on the row.
 *   • No basis ⇒ NRV, write-down per unit and write-down are null and the
 *     row says 'no-basis'. Never 0: a zero write-down reads as "fully
 *     recoverable", which is the one thing an unpriced item cannot claim.
 *   • The write-down is clamped at 0. NRV above cost is not a write-UP;
 *     IAS 2 never revalues inventory upward.
 *
 * Pure functions over plain arrays, so every formula can be pinned without a
 * database. The SQL that produces the arrays lives in the route.
 */
'use strict';

/** Round to `dp` decimals and shed float noise; null passes through. */
function round(value, dp) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(dp));
}

/** A finite number, or null. Strings from the driver ('12.5000') are fine. */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * The standard VAT rate from `settings.VATRate`, or null when it is absent,
 * blank or not a number. Null is the caller's cue to refuse the report.
 */
function parseVatRate(raw) {
  const n = num(raw == null ? null : String(raw).trim());
  return n != null && n >= 0 ? n : null;
}

/**
 * `settings.NrvSellingCostPct`: the estimated costs to sell, as a percent of
 * the net selling price. ABSENT means 0 — a company that has not estimated
 * selling costs deducts none, and the basis block says so. A value that is
 * present but unusable (not a number, negative, ≥ 100) answers null so the
 * caller refuses rather than silently deducting nothing.
 */
function parseSellingCostPct(raw) {
  if (raw == null || String(raw).trim() === '') return 0;
  const n = num(String(raw).trim());
  return n != null && n >= 0 && n < 100 ? n : null;
}

// ── Per-unit formulas ───────────────────────────────────────────────────────

/**
 * The selling price with VAT stripped — but only when the price contains
 * VAT: tax-inclusive (NULL ⇒ inclusive) AND standard-rated ('S').
 */
function netSellingPrice(price, vatRatePct, flags) {
  const p = num(price);
  if (p == null) return null;
  const f = flags || {};
  const inclusive = f.isTaxInclusive == null ? true : !!Number(f.isTaxInclusive);
  const standard = String(f.taxCategory || '').toUpperCase() === 'S';
  if (inclusive && standard) return p / (1 + (num(vatRatePct) || 0) / 100);
  return p;
}

/**
 * Units of the component one sale consumes: the BOM line's base_quantity
 * (falling back to quantity when base_quantity was never computed), divided
 * by the recipe's yield (falling back to 1). Null when the line cannot say —
 * a zero or missing quantity is not "free", it is unknown.
 */
function unitsPerSale(line) {
  const l = line || {};
  const base = num(l.baseQuantity);
  const perBatch = base != null && base > 0 ? base : num(l.quantity);
  if (perBatch == null || perBatch <= 0) return null;
  const y = num(l.yieldQuantity);
  const yieldQ = y != null && y > 0 ? y : 1;
  return perBatch / yieldQ;
}

/** NRV per unit of the component = net price × (1 − costs to sell) ÷ units per sale. */
function nrvUnit(netPrice, sellingCostPct, units) {
  const p = num(netPrice);
  const u = num(units);
  if (p == null || u == null || u <= 0) return null;
  return (p * (1 - (num(sellingCostPct) || 0) / 100)) / u;
}

/** Write-down per unit = max(0, cost − NRV). Null when there is no NRV. */
function writeDownUnit(unitCost, nrv) {
  const n = num(nrv);
  if (n == null) return null;
  return Math.max(0, (num(unitCost) || 0) - n);
}

// ── Basis selection ─────────────────────────────────────────────────────────

/**
 * Prudence: of several qualifying products, the one with the LOWEST net
 * selling price is the basis. Ties break on the lower NRV per unit (the more
 * prudent figure), then on menuId so the answer is stable between runs.
 * Candidates must already carry `netSellingPrice` and `nrvUnit`.
 */
function selectBasis(candidates) {
  const usable = (candidates || []).filter((c) => c && c.netSellingPrice != null && c.nrvUnit != null);
  if (!usable.length) return null;
  return usable.slice().sort((a, b) =>
    (a.netSellingPrice - b.netSellingPrice)
    || (a.nrvUnit - b.nrvUnit)
    || String(a.menuId).localeCompare(String(b.menuId)))[0];
}

// ── The NRV report ──────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {Array}  input.items       [{ itemId, itemName, itemNameEn, unit, quantity, unitCost }]
 * @param {Array}  input.candidates  one per (item, product) pair whose active
 *   BOM has exactly ONE line for the item — the SQL enforces that count:
 *   [{ itemId, menuId, productName, productNameEn, price, isTaxInclusive,
 *      taxCategory, quantity, baseQuantity, yieldQuantity }]
 * @param {number} input.vatRatePct
 * @param {number} input.sellingCostPct
 * @returns {{ rows: Array, totals: object }}
 */
function buildNrvRows(input) {
  const vatRatePct = num(input.vatRatePct) || 0;
  const sellingCostPct = num(input.sellingCostPct) || 0;

  const byItem = new Map();
  for (const c of input.candidates || []) {
    const net = netSellingPrice(c.price, vatRatePct, c);
    const units = unitsPerSale(c);
    const nrv = nrvUnit(net, sellingCostPct, units);
    if (net == null || units == null || nrv == null) continue;
    if (!byItem.has(c.itemId)) byItem.set(c.itemId, []);
    byItem.get(c.itemId).push({
      menuId: c.menuId,
      productName: c.productName == null ? null : String(c.productName),
      productNameEn: c.productNameEn == null ? null : String(c.productNameEn),
      netSellingPrice: net,
      unitsPerSale: units,
      nrvUnit: nrv,
    });
  }

  const rows = (input.items || []).map((it) => {
    const quantity = num(it.quantity) || 0;
    const unitCost = num(it.unitCost) || 0;
    const basis = selectBasis(byItem.get(it.itemId));
    const row = {
      itemId: it.itemId,
      itemName: it.itemName == null ? null : String(it.itemName),
      itemNameEn: it.itemNameEn == null ? null : String(it.itemNameEn),
      unit: it.unit == null ? null : String(it.unit),
      quantity: round(quantity, 4),
      unitCost: round(unitCost, 4),
      inventoryValue: round(quantity * unitCost, 2),
      basisSource: null,
      basisProductName: null,
      basisProductNameEn: null,
      unitsPerSale: null,
      netSellingPrice: null,
      sellingCostPct,
      nrvUnit: null,
      writeDownUnit: null,
      writeDown: null,
      status: 'no-basis',
    };
    if (!basis) return row;
    const wdu = writeDownUnit(unitCost, basis.nrvUnit);
    row.basisSource = 'menu:' + basis.menuId;
    row.basisProductName = basis.productName;
    row.basisProductNameEn = basis.productNameEn;
    row.unitsPerSale = round(basis.unitsPerSale, 6);
    row.netSellingPrice = round(basis.netSellingPrice, 4);
    row.nrvUnit = round(basis.nrvUnit, 4);
    row.writeDownUnit = round(wdu, 4);
    row.writeDown = round(wdu * quantity, 2);
    row.status = row.writeDownUnit > 0 ? 'impaired' : 'ok';
    return row;
  });

  // Largest write-down first; rows that cannot be measured sink to the end
  // rather than hiding among the healthy ones.
  rows.sort((a, b) =>
    ((b.writeDown == null ? -1 : b.writeDown) - (a.writeDown == null ? -1 : a.writeDown))
    || (b.inventoryValue - a.inventoryValue)
    || String(a.itemId).localeCompare(String(b.itemId)));

  const withBasis = rows.filter((r) => r.basisSource != null);
  const totals = {
    items: rows.length,
    itemsWithBasis: withBasis.length,
    noBasisCount: rows.length - withBasis.length,
    impairedItems: rows.filter((r) => r.status === 'impaired').length,
    inventoryValue: round(rows.reduce((a, r) => a + r.inventoryValue, 0), 2),
    // Only rows WITH a basis: an unmeasured item contributes nothing, not 0 —
    // and the count beside it says how many were left out.
    writeDown: round(withBasis.reduce((a, r) => a + r.writeDown, 0), 2),
  };
  return { rows, totals };
}

// ── Products sold below cost ────────────────────────────────────────────────

/**
 * The cost a product is measured against, with its source named.
 * Precedence: menu.cost when it came from the recipe engine and is > 0,
 * else the active BOM's cost_per_unit when > 0. Neither ⇒ null: a product
 * whose cost nobody has established cannot be called "below cost" — nor
 * "above" it — so it is COUNTED, not listed.
 */
function resolveProductCost(p) {
  const menuCost = num(p.menuCost);
  if (String(p.menuCostSource || '') === 'recipe' && menuCost != null && menuCost > 0) {
    return { unitCost: menuCost, costSource: 'recipe' };
  }
  const bomCost = num(p.bomCostPerUnit);
  if (bomCost != null && bomCost > 0) return { unitCost: bomCost, costSource: 'bom' };
  return null;
}

/**
 * @param {object} input
 * @param {Array}  input.products  [{ menuId, productName, productNameEn, price,
 *   isTaxInclusive, taxCategory, menuCost, menuCostSource, bomCostPerUnit }]
 * @param {number} input.vatRatePct
 * @param {Map|null} input.sold  menuId → units sold in the window; NULL when
 *   this server has no sales source at all (then soldQty/exposure are null,
 *   never 0 — an absent table is not "nothing sold").
 * @returns {{ rows: Array, totals: object }}
 */
function buildBelowCostRows(input) {
  const vatRatePct = num(input.vatRatePct) || 0;
  const sold = input.sold instanceof Map ? input.sold : null;
  let noCostCount = 0;
  const rows = [];

  for (const p of input.products || []) {
    const cost = resolveProductCost(p);
    if (!cost) { noCostCount += 1; continue; }
    const net = netSellingPrice(p.price, vatRatePct, p);
    if (net == null || !(cost.unitCost > net)) continue;
    const shortfall = cost.unitCost - net;
    const soldQty = sold ? (num(sold.get(p.menuId)) || 0) : null;
    rows.push({
      menuId: p.menuId,
      productName: p.productName == null ? null : String(p.productName),
      productNameEn: p.productNameEn == null ? null : String(p.productNameEn),
      netSellingPrice: round(net, 4),
      unitCost: round(cost.unitCost, 4),
      costSource: cost.costSource,
      shortfallUnit: round(shortfall, 4),
      // Margin on a zero price is undefined, not −∞ and not 0.
      marginPct: net > 0 ? round(((net - cost.unitCost) / net) * 100, 2) : null,
      soldQty: soldQty == null ? null : round(soldQty, 3),
      exposure: soldQty == null ? null : round(shortfall * soldQty, 2),
      status: 'below-cost',
    });
  }

  rows.sort((a, b) =>
    ((b.exposure == null ? -1 : b.exposure) - (a.exposure == null ? -1 : a.exposure))
    || (b.shortfallUnit - a.shortfallUnit)
    || String(a.menuId).localeCompare(String(b.menuId)));

  const totals = {
    products: rows.length,
    noCostCount,
    exposure: sold ? round(rows.reduce((a, r) => a + (r.exposure || 0), 0), 2) : null,
  };
  return { rows, totals };
}

module.exports = {
  parseVatRate,
  parseSellingCostPct,
  netSellingPrice,
  unitsPerSale,
  nrvUnit,
  writeDownUnit,
  selectBasis,
  resolveProductCost,
  buildNrvRows,
  buildBelowCostRows,
};
