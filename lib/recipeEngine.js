/**
 * lib/recipeEngine.js — the PURE recipe/BOM domain. No I/O, no DB, no express.
 *
 * Every rule the unified recipe API enforces lives here so it can be unit
 * tested without a database, and so the SAME rule cannot drift between the
 * three write paths that exist today:
 *
 *   routes/menu.js      POST /api/menu/:id/recipe-bom   (divides cost by yield)
 *   routes/erp-core.js  POST /api/erp/bom               (does NOT divide by
 *                                                        yield, and trusts a
 *                                                        `recomputedCost` sent
 *                                                        by the browser)
 *   routes/menu.js      POST /api/menu/recipes/:menuId  (legacy `recipe` table)
 *
 * Those three disagree about the cost of the same recipe. From here on there
 * is one implementation — `computeRecipeCost` — and the HTTP layers are thin.
 *
 * Unit-tested in tests/recipeEngine.test.js.
 */
'use strict';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

function _err(code, message, detail) {
  const e = new Error(message || code);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

// ── Product identity ─────────────────────────────────────────────────────────
// A recipe's product may live in `menu` OR in `inv_items`; a COMPONENT is
// always an inv_item. One key space spans both so the cycle walker does not
// need to care which table a node came from.
const SOURCES = ['menu', 'inv'];
function productKey(source, productId) {
  return (source === 'menu' ? 'menu' : 'inv') + ':' + String(productId);
}
function componentKey(itemId) { return 'inv:' + String(itemId); }
function normalizeSource(s) { return s === 'menu' ? 'menu' : 'inv'; }

// ── Recipe lifecycle ─────────────────────────────────────────────────────────
const STATUSES = ['draft', 'active', 'archived'];
// An `active` recipe is in use by production and by the sale-time deduction
// engine. Editing one in place would silently restate the plan of every open
// production order and the cost of every historical costing — so an edit to an
// active recipe MUST mint a revision instead.
function requiresRevision(status) { return status === 'active'; }
function canEditInPlace(status) { return status === 'draft'; }

const OUTPUT_TYPES = ['primary', 'co_product', 'by_product', 'rework', 'scrap'];
const ALLOC_METHODS = ['fixed_pct', 'standard_cost', 'weight', 'nrv'];

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Header rules. `yield_quantity` divides the batch cost, so a zero or negative
 * yield is not a cosmetic problem — today both writers coerce it with
 * `Number(b.yieldQuantity) || 1`, which turns a user's "0" into a silent 1 and
 * reports a unit cost that was never asked for.
 */
function validateHeader(h) {
  const y = Number(h && h.yieldQuantity);
  if (!Number.isFinite(y) || y <= 0) {
    throw _err('VALIDATION_ERROR', 'كمية الإنتاج (yield) يجب أن تكون أكبر من صفر');
  }
  if (h.status != null && STATUSES.indexOf(String(h.status)) === -1) {
    throw _err('VALIDATION_ERROR', 'حالة وصفة غير معروفة: ' + h.status);
  }
  if (h.effectiveFrom && h.effectiveTo && String(h.effectiveTo) < String(h.effectiveFrom)) {
    throw _err('VALIDATION_ERROR', 'تاريخ نهاية السريان قبل تاريخ البداية');
  }
  return true;
}

/**
 * Line rules. wastePct is a PERCENTAGE OF THE NET quantity, so 100 would mean
 * "half of everything issued is waste" — expressible — but >= 100 makes the
 * gross unbounded relative to net and is always a data-entry error (someone
 * typing a factor instead of a percentage).
 */
function validateLine(l, index) {
  const at = { index, componentItemId: l && l.componentItemId };
  if (!l || !l.componentItemId) throw _err('VALIDATION_ERROR', 'كل سطر يحتاج مكوّنًا', at);
  const q = Number(l.quantity);
  if (!Number.isFinite(q) || q <= 0) throw _err('VALIDATION_ERROR', 'كمية المكوّن يجب أن تكون أكبر من صفر', at);
  const w = l.wastePct == null ? 0 : Number(l.wastePct);
  if (!Number.isFinite(w) || w < 0 || w >= 100) {
    throw _err('VALIDATION_ERROR', 'نسبة الهدر يجب أن تكون بين 0 و 100 (غير شاملة)', at);
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// CANONICALIZATION — the duplicate-component fold
// ════════════════════════════════════════════════════════════════════════════
/**
 * Collapse repeated components into ONE line per component, preserving BOTH
 * quantities that matter downstream:
 *
 *   net   = Σ quantity                       (what the user typed, summed)
 *   gross = Σ quantity × (1 + wastePct/100)  (what production actually issues)
 *
 * The surviving line keeps the summed net and gets a re-derived wastePct so
 * gross is unchanged. Refusing duplicates outright was the alternative, but a
 * recipe legitimately gets edited by adding the same component twice, and
 * silently keeping only the last one (which is what the production issue-plan
 * Map does today at routes/inventory-production.js:527) loses material.
 *
 * Lines are folded ONLY when they share the same base unit. Two entries for
 * the same component in genuinely different units cannot be summed
 * arithmetically, so that is a validation error the user must resolve — never
 * a silent merge of 2 kg into 3 g.
 */
function canonicalizeLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const byComponent = new Map();
  const order = [];

  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    validateLine(l, i);
    const id = String(l.componentItemId);
    const factor = l.conversionFactor == null ? 1 : Number(l.conversionFactor);
    const net = Number(l.quantity);
    const waste = l.wastePct == null ? 0 : Number(l.wastePct);

    const prev = byComponent.get(id);
    if (!prev) {
      byComponent.set(id, {
        componentItemId: id,
        quantity: net,
        wastePct: waste,
        conversionFactor: factor,
        enteredUnitId: l.enteredUnitId == null ? null : String(l.enteredUnitId),
        enteredUnitCode: l.enteredUnitCode == null ? null : String(l.enteredUnitCode),
        notes: l.notes == null ? null : String(l.notes),
        _grossBase: net * factor * (1 + waste / 100),
        _netBase: net * factor,
        _mergedFrom: 1,
      });
      order.push(id);
      continue;
    }
    // Same component again — the units must agree or the sum is meaningless.
    const sameUnit = (prev.enteredUnitId || null) === (l.enteredUnitId == null ? null : String(l.enteredUnitId))
      && round6(prev.conversionFactor) === round6(factor);
    if (!sameUnit) {
      throw _err('DUPLICATE_COMPONENT_UNIT_MISMATCH',
        'المكوّن مكرر بوحدتين مختلفتين — وحّد الوحدة قبل الحفظ',
        { componentItemId: id });
    }
    prev.quantity = round6(prev.quantity + net);
    prev._netBase = round6(prev._netBase + net * factor);
    prev._grossBase = round6(prev._grossBase + net * factor * (1 + waste / 100));
    prev.notes = prev.notes || (l.notes == null ? null : String(l.notes));
    prev._mergedFrom += 1;
  }

  const out = [];
  for (let i = 0; i < order.length; i++) {
    const r = byComponent.get(order[i]);
    // Re-derive the waste that reproduces the SAME gross from the summed net.
    let waste = r._netBase > 0 ? (r._grossBase / r._netBase - 1) * 100 : 0;
    waste = Math.max(0, Math.min(99.99, Math.round(waste * 100) / 100));
    out.push({
      componentItemId: r.componentItemId,
      quantity: round6(r.quantity),
      wastePct: waste,
      conversionFactor: round6(r.conversionFactor),
      baseQuantity: round6(r._netBase),
      enteredUnitId: r.enteredUnitId,
      enteredUnitCode: r.enteredUnitCode,
      notes: r.notes,
      lineNo: i,
      mergedFrom: r._mergedFrom,
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// CYCLE DETECTION
// ════════════════════════════════════════════════════════════════════════════
/**
 * A semi-finished item can itself have a recipe, so recipes form a directed
 * graph and a cycle makes cost computation and BOM explosion non-terminating.
 * Nothing checks for one today — a recipe may list its own product, and A→B→A
 * is entirely constructible through the UI.
 *
 * @param startKey        productKey() of the recipe being saved
 * @param proposedChildren component item ids the save is proposing
 * @param edges           Map<productKey, string[] componentItemIds> for every
 *                        OTHER active recipe (the one being saved is excluded
 *                        by the caller, so the proposal is what gets tested)
 * @returns null when acyclic, else the offending path as productKey[]
 */
function findCycle(startKey, proposedChildren, edges) {
  const graph = edges instanceof Map ? edges : new Map(Object.entries(edges || {}));
  const childrenOf = (key) => (key === startKey ? (proposedChildren || []) : (graph.get(key) || []));

  const state = new Map(); // key -> 1 visiting, 2 done
  const stack = [];

  function walk(key) {
    if (state.get(key) === 2) return null;
    if (state.get(key) === 1) return stack.slice(stack.indexOf(key)).concat([key]);
    state.set(key, 1);
    stack.push(key);
    for (const childItemId of childrenOf(key)) {
      const childKey = componentKey(childItemId);
      // A component only continues the walk when it is itself a recipe product.
      if (childKey !== startKey && !graph.has(childKey)) continue;
      const found = walk(childKey);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  }
  return walk(startKey);
}

/** Self-reference is the degenerate 1-node cycle; named separately for a clearer error. */
function findSelfReference(source, productId, componentItemIds) {
  if (normalizeSource(source) !== 'inv') return null; // a menu product is never an inv component
  const pid = String(productId);
  return (componentItemIds || []).some((c) => String(c) === pid) ? pid : null;
}

function assertAcyclic(source, productId, componentItemIds, edges) {
  const self = findSelfReference(source, productId, componentItemIds);
  if (self) {
    throw _err('RECIPE_SELF_REFERENCE', 'لا يمكن أن تحتوي الوصفة على منتجها نفسه كمكوّن', { componentItemId: self });
  }
  const key = productKey(source, productId);
  const cycle = findCycle(key, componentItemIds, edges);
  if (cycle) {
    throw _err('RECIPE_CYCLE', 'دورة في الوصفات: ' + cycle.join(' → '), { cycle });
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// COST — the single implementation
// ════════════════════════════════════════════════════════════════════════════
/**
 * @param lines  canonicalized lines, each with baseQuantity, wastePct and a
 *               SERVER-RESOLVED unitCost (WAC/standard). A cost sent by the
 *               browser is never an input here.
 * @param yieldQuantity  batch output in the product's own unit (> 0)
 * @returns { batchCost, unitCost, lines: [{..., grossQuantity, lineCost}] }
 *
 * lineCost = baseQuantity × (1 + wastePct/100) × unitCost — i.e. the EXPECTED
 * recipe loss is capitalised into the product's cost, exactly as production's
 * `_expandBom` expands it. Actual production scrap is a different number and
 * is expensed at output time (productionEngine.priceOutputEvent); the two are
 * deliberately not the same figure and must never be added together.
 */
function computeRecipeCost(lines, yieldQuantity) {
  const y = Number(yieldQuantity);
  if (!Number.isFinite(y) || y <= 0) throw _err('VALIDATION_ERROR', 'كمية الإنتاج (yield) يجب أن تكون أكبر من صفر');
  const priced = [];
  let batch = 0;
  for (const l of (lines || [])) {
    const base = Number(l.baseQuantity != null ? l.baseQuantity : l.quantity) || 0;
    const waste = Number(l.wastePct) || 0;
    const unitCost = Number(l.unitCost) || 0;
    const gross = round6(base * (1 + waste / 100));
    const lineCost = round4(gross * unitCost);
    batch += lineCost;
    priced.push(Object.assign({}, l, { grossQuantity: gross, unitCost: round6(unitCost), lineCost }));
  }
  const batchCost = round4(batch);
  return { batchCost, unitCost: round6(batchCost / y), lines: priced };
}

/** Food cost % = cost of goods / selling price. Null when there is no price. */
function foodCostPct(unitCost, sellingPrice) {
  const p = Number(sellingPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  return round2((Number(unitCost) || 0) / p * 100);
}
/** Gross margin % = (price − cost) / price. Null when there is no price. */
function marginPct(unitCost, sellingPrice) {
  const p = Number(sellingPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  return round2((p - (Number(unitCost) || 0)) / p * 100);
}

/**
 * Cost anomaly flags for the catalog filter. Deliberately conservative — these
 * mark a recipe for a HUMAN to look at, they never block a save.
 */
function costAnomalies(o) {
  const flags = [];
  const unitCost = Number(o.unitCost);
  const price = Number(o.sellingPrice);
  if (!(unitCost > 0)) flags.push('ZERO_COST');
  if (o.missingComponentCost) flags.push('COMPONENT_WITHOUT_COST');
  if (Number.isFinite(price) && price > 0) {
    const fc = foodCostPct(unitCost, price);
    if (fc != null && fc >= 100) flags.push('COST_EXCEEDS_PRICE');
    else if (fc != null && fc >= 60) flags.push('FOOD_COST_HIGH');
  }
  if (o.staleDays != null && Number(o.staleDays) > 90) flags.push('COST_STALE');
  return flags;
}

// ════════════════════════════════════════════════════════════════════════════
// JOINT PRODUCTION — allocating ONE pool of WIP across several outputs
// ════════════════════════════════════════════════════════════════════════════
/**
 * THE INVARIANT, enforced by construction rather than by hope:
 *
 *     Σ allocated(output) === pool          (to the last stored halala)
 *
 * The last allocated row absorbs the rounding remainder, so no float dust can
 * leave WIP un-relieved or over-relieved. `assertAllocationInvariant` re-checks
 * it and the caller refuses to post if it ever fails.
 *
 * ORDER OF OPERATIONS (standard joint-costing, made explicit):
 *   1. fixed_pct rows take exactly their stated share of the ORIGINAL pool.
 *   2. by_product rows priced at NRV are CREDITED at net realisable value and
 *      removed from the pool — the classic by-product treatment: they do not
 *      carry margin, they reduce the cost borne by the main products. Capped so
 *      they can never consume more than what is left.
 *   3. whatever remains is split across the rest in proportion to
 *      basis = baseQuantity × unitBasis, where unitBasis comes from the method
 *      (standard unit cost / weight / NRV). Zero total basis → split equally
 *      rather than divide by zero.
 *
 * @param outputs [{ id, outputType, baseQuantity, allocMethod, allocValue }]
 * @param pool    the WIP amount being relieved by this output event
 */
function allocateJointCost(outputs, pool) {
  const list = (outputs || []).filter(Boolean);
  const P = round4(Math.max(0, Number(pool) || 0));
  if (!list.length) throw _err('VALIDATION_ERROR', 'لا توجد مخرجات لتوزيع التكلفة عليها');

  for (const o of list) {
    if (OUTPUT_TYPES.indexOf(String(o.outputType || 'primary')) === -1) {
      throw _err('VALIDATION_ERROR', 'نوع مخرج غير معروف: ' + o.outputType, { id: o.id });
    }
    if (o.allocMethod != null && ALLOC_METHODS.indexOf(String(o.allocMethod)) === -1) {
      throw _err('VALIDATION_ERROR', 'أسلوب توزيع تكلفة غير معروف: ' + o.allocMethod, { id: o.id });
    }
    if (!(Number(o.baseQuantity) > 0)) {
      throw _err('VALIDATION_ERROR', 'كمية المخرج يجب أن تكون موجبة', { id: o.id });
    }
  }

  const fixedPctTotal = list
    .filter((o) => o.allocMethod === 'fixed_pct')
    .reduce((s, o) => s + (Number(o.allocValue) || 0), 0);
  if (fixedPctTotal > 100 + 1e-9) {
    throw _err('ALLOCATION_PCT_OVERFLOW', 'مجموع النسب الثابتة يتجاوز 100%', { total: round4(fixedPctTotal) });
  }

  const result = list.map((o) => ({
    id: o.id,
    outputType: String(o.outputType || 'primary'),
    allocMethod: String(o.allocMethod || 'standard_cost'),
    baseQuantity: Number(o.baseQuantity),
    basis: 0,
    share: 0,
    value: 0,
  }));

  let remaining = P;

  // 1. fixed percentages, off the ORIGINAL pool
  for (let i = 0; i < list.length; i++) {
    if (result[i].allocMethod !== 'fixed_pct') continue;
    const v = round4(Math.min(remaining, P * (Number(list[i].allocValue) || 0) / 100));
    result[i].value = v;
    result[i].basis = v;
    remaining = round4(remaining - v);
  }

  // 2. by-products at NRV — credited, never margin-bearing
  for (let i = 0; i < list.length; i++) {
    const r = result[i];
    if (r.outputType !== 'by_product' || r.allocMethod !== 'nrv') continue;
    const nrv = Number(list[i].allocValue) || 0;
    const v = round4(Math.max(0, Math.min(remaining, r.baseQuantity * nrv)));
    r.value = v;
    r.basis = v;
    remaining = round4(remaining - v);
  }

  // 3. the rest, in proportion to basis
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const r = result[i];
    if (r.allocMethod === 'fixed_pct') continue;
    if (r.outputType === 'by_product' && r.allocMethod === 'nrv') continue;
    const unitBasis = list[i].allocValue == null ? 1 : Number(list[i].allocValue);
    r.basis = round6(r.baseQuantity * (Number.isFinite(unitBasis) ? unitBasis : 1));
    rest.push(r);
  }
  const basisTotal = rest.reduce((s, r) => s + r.basis, 0);
  let handedOut = 0;
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i];
    const frac = basisTotal > 0 ? r.basis / basisTotal : 1 / rest.length;
    if (i === rest.length - 1) r.value = round4(remaining - handedOut); // absorbs the remainder
    else { r.value = round4(remaining * frac); handedOut = round4(handedOut + r.value); }
  }
  // No rows in step 3 (everything was fixed_pct / NRV): any residue would leave
  // WIP un-relieved, so the last row of the whole set absorbs it.
  if (!rest.length && Math.abs(remaining) > 0.0001) {
    result[result.length - 1].value = round4(result[result.length - 1].value + remaining);
  }

  for (const r of result) r.share = P > 0 ? round6(r.value / P) : 0;
  return { pool: P, outputs: result, allocated: round4(result.reduce((s, r) => s + r.value, 0)) };
}

/**
 * The invariant the caller must not post without:
 *   Σ output cost + waste + variance === WIP relieved
 * Tolerance is half a halala — the smallest stored money unit — so this catches
 * a real accounting error while ignoring representable float noise.
 */
function assertAllocationInvariant(o) {
  const relieved = round2(o.wipRelieved);
  const total = round2((Number(o.outputsTotal) || 0) + (Number(o.wasteTotal) || 0) + (Number(o.varianceTotal) || 0));
  if (Math.abs(total - relieved) > 0.005) {
    throw _err('ALLOCATION_INVARIANT_VIOLATION',
      'مجموع تكلفة المخرجات + الهدر + الفروقات (' + total + ') لا يساوي WIP المخفَّض (' + relieved + ')',
      { outputsTotal: o.outputsTotal, wasteTotal: o.wasteTotal, varianceTotal: o.varianceTotal, wipRelieved: relieved });
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// MATERIAL ALLOCATION SHARE (partial-output genealogy)
// ════════════════════════════════════════════════════════════════════════════
/**
 * How much of the still-unattributed consumed material this output event owns.
 *
 * The denominator is deliberately IDENTICAL to the one the cost engine uses in
 * productionEngine.priceOutputEvent — `remainingExpected` — so genealogy and
 * money can never tell different stories about the same event. `isFinal` (the
 * event that completes/closes the order) sweeps the whole remainder so no
 * consumed unit is ever left unattributed.
 */
function outputAllocationShare(o) {
  const planned = Number(o.plannedQty) || 0;
  const producedSoFar = (Number(o.producedSoFar) || 0) + (Number(o.wasteSoFar) || 0);
  const eventQty = (Number(o.goodQty) || 0) + (Number(o.wasteQty) || 0);
  if (eventQty <= 0) throw _err('VALIDATION_ERROR', 'كمية الحدث يجب أن تكون موجبة');
  if (o.isFinal) return 1;
  const remainingExpected = Math.max(round4(planned - producedSoFar), eventQty);
  return remainingExpected > 0 ? Math.min(1, round6(eventQty / remainingExpected)) : 1;
}

/**
 * Split a share across the remaining-unallocated pool per (issue line, lot).
 * `remaining` entries are what is left after every EARLIER output event, so a
 * replayed or repeated call can never allocate the same material twice.
 */
function planMaterialAllocation(remaining, share) {
  const s = Math.max(0, Math.min(1, Number(share) || 0));
  const out = [];
  for (const r of (remaining || [])) {
    const avail = round6(Number(r.remainingQty) || 0);
    if (avail <= 0) continue;
    const qty = s >= 1 ? avail : round6(Math.min(avail, avail * s));
    if (qty <= 0) continue;
    out.push({
      issueLineId: r.issueLineId,
      issueEventId: r.issueEventId || null,
      componentItemId: r.componentItemId,
      componentLotId: r.componentLotId == null ? null : r.componentLotId,
      warehouseId: r.warehouseId == null ? null : r.warehouseId,
      unitCost: round6(Number(r.unitCost) || 0),
      qty,
    });
  }
  return out;
}

/** Total allocated for a (line, lot) may never exceed what was consumed. */
function assertAllocationWithinConsumption(consumedQty, alreadyAllocated, adding) {
  const total = round6((Number(alreadyAllocated) || 0) + (Number(adding) || 0));
  if (total > round6(Number(consumedQty) || 0) + 1e-6) {
    throw _err('ALLOCATION_EXCEEDS_CONSUMPTION',
      'التخصيص (' + total + ') يتجاوز المستهلك (' + consumedQty + ')',
      { consumedQty, alreadyAllocated, adding });
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// SCRAP ALLOWANCE — 0 means ZERO, null means "use the default policy"
// ════════════════════════════════════════════════════════════════════════════
const DEFAULT_SCRAP_ALLOWANCE_PCT = 100; // no explicit policy → not gated here

/**
 * Replaces productionEngine.wasteAllowanceExceeded's `Number(pct) || 0;
 * if (pct <= 0) return false`, under which an order configured for ZERO scrap
 * was indistinguishable from one with no policy and was never gated at all.
 *
 *   allowedScrapPct === null/undefined → the default policy applies
 *   allowedScrapPct === 0              → ZERO scrap permitted; ANY waste needs
 *                                        a manager override with a reason
 *   allowedScrapPct === n              → cumulative waste above n% of planned
 *                                        needs a manager override with a reason
 */
function scrapAllowanceFor(allowedScrapPct) {
  if (allowedScrapPct == null || allowedScrapPct === '') return { pct: DEFAULT_SCRAP_ALLOWANCE_PCT, explicit: false };
  const n = Number(allowedScrapPct);
  if (!Number.isFinite(n) || n < 0) throw _err('VALIDATION_ERROR', 'نسبة الهدر المسموحة يجب أن تكون صفرًا أو أكثر');
  return { pct: n, explicit: true };
}

function wasteAllowanceExceeded(plannedQty, wasteSoFar, addWaste, allowedScrapPct) {
  const { pct } = scrapAllowanceFor(allowedScrapPct);
  const adding = Number(addWaste) || 0;
  const cumulative = round4((Number(wasteSoFar) || 0) + adding);
  if (cumulative <= 0) return false;                    // no waste, nothing to gate
  const cap = round4((Number(plannedQty) || 0) * (pct / 100));
  return cumulative > cap + 1e-9;
}

module.exports = {
  round2, round4, round6,
  SOURCES, STATUSES, OUTPUT_TYPES, ALLOC_METHODS, DEFAULT_SCRAP_ALLOWANCE_PCT,
  productKey, componentKey, normalizeSource,
  requiresRevision, canEditInPlace,
  validateHeader, validateLine, canonicalizeLines,
  findCycle, findSelfReference, assertAcyclic,
  computeRecipeCost, foodCostPct, marginPct, costAnomalies,
  allocateJointCost, assertAllocationInvariant,
  outputAllocationShare, planMaterialAllocation, assertAllocationWithinConsumption,
  scrapAllowanceFor, wasteAllowanceExceeded,
};
