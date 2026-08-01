/**
 * Unit tests — lib/recipeEngine.js (pure; no DB, no server).
 * Run: node tests/recipeEngine.test.js   (included in `npm test`)
 *
 * These pin the rules the three legacy BOM writers each got differently:
 * yield validation, duplicate folding, cycle detection, ONE cost formula, and
 * the joint-cost invariant Σ outputs + waste + variance === WIP relieved.
 */
'use strict';
const R = require('../lib/recipeEngine');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
function throws(fn, code) {
  try { fn(); return false; } catch (e) { return !code || e.code === code; }
}
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.0001 : tol); }

// ═══ header validation ═══
console.log('\n═══ recipeEngine — header validation ═══');
check('accepts a positive yield', R.validateHeader({ yieldQuantity: 4 }) === true);
check('rejects yield 0 (today both writers silently coerce it to 1)',
  throws(() => R.validateHeader({ yieldQuantity: 0 }), 'VALIDATION_ERROR'));
check('rejects negative yield', throws(() => R.validateHeader({ yieldQuantity: -2 }), 'VALIDATION_ERROR'));
check('rejects non-numeric yield', throws(() => R.validateHeader({ yieldQuantity: 'abc' }), 'VALIDATION_ERROR'));
check('rejects an unknown status', throws(() => R.validateHeader({ yieldQuantity: 1, status: 'live' }), 'VALIDATION_ERROR'));
check('rejects effectiveTo before effectiveFrom',
  throws(() => R.validateHeader({ yieldQuantity: 1, effectiveFrom: '2026-05-01', effectiveTo: '2026-04-01' }), 'VALIDATION_ERROR'));
check('accepts effectiveTo equal to effectiveFrom',
  R.validateHeader({ yieldQuantity: 1, effectiveFrom: '2026-05-01', effectiveTo: '2026-05-01' }) === true);

// ═══ line validation ═══
console.log('\n═══ recipeEngine — line validation ═══');
check('rejects a line with no component', throws(() => R.validateLine({ quantity: 1 }, 0), 'VALIDATION_ERROR'));
check('rejects quantity 0', throws(() => R.validateLine({ componentItemId: 'A', quantity: 0 }, 0), 'VALIDATION_ERROR'));
check('rejects negative quantity', throws(() => R.validateLine({ componentItemId: 'A', quantity: -1 }, 0), 'VALIDATION_ERROR'));
check('accepts wastePct 0', R.validateLine({ componentItemId: 'A', quantity: 1, wastePct: 0 }, 0) === true);
check('accepts wastePct 99.99', R.validateLine({ componentItemId: 'A', quantity: 1, wastePct: 99.99 }, 0) === true);
check('rejects wastePct 100 (boundary is exclusive)',
  throws(() => R.validateLine({ componentItemId: 'A', quantity: 1, wastePct: 100 }, 0), 'VALIDATION_ERROR'));
check('rejects wastePct > 100', throws(() => R.validateLine({ componentItemId: 'A', quantity: 1, wastePct: 150 }, 0), 'VALIDATION_ERROR'));
check('rejects negative wastePct', throws(() => R.validateLine({ componentItemId: 'A', quantity: 1, wastePct: -5 }, 0), 'VALIDATION_ERROR'));

// ═══ duplicate-component canonicalization ═══
console.log('\n═══ recipeEngine — duplicate fold ═══');
{
  const folded = R.canonicalizeLines([
    { componentItemId: 'A', quantity: 2, wastePct: 10 },
    { componentItemId: 'B', quantity: 1, wastePct: 0 },
    { componentItemId: 'A', quantity: 3, wastePct: 0 },
    { componentItemId: 'A', quantity: 5, wastePct: 20 },
  ]);
  check('folds three A lines into one', folded.length === 2, folded.map((l) => l.componentItemId));
  const a = folded.find((l) => l.componentItemId === 'A');
  check('summed net quantity is preserved (2+3+5)', near(a.quantity, 10), a.quantity);
  // gross before = 2*1.1 + 3*1.0 + 5*1.2 = 11.2 ; after = 10 * (1+12/100) = 11.2
  check('re-derived waste reproduces the SAME gross', near(a.wastePct, 12), a.wastePct);
  check('gross is byte-identical after the fold',
    near(a.quantity * (1 + a.wastePct / 100), 11.2), a.quantity * (1 + a.wastePct / 100));
  check('records how many lines were merged', a.mergedFrom === 3, a.mergedFrom);
  check('keeps the first-seen order', folded[0].componentItemId === 'A' && folded[1].componentItemId === 'B');
  check('assigns sequential lineNo', folded[0].lineNo === 0 && folded[1].lineNo === 1);
}
check('single occurrence keeps its waste unchanged',
  R.canonicalizeLines([{ componentItemId: 'A', quantity: 4, wastePct: 7.5 }])[0].wastePct === 7.5);
check('refuses to fold the same component across DIFFERENT units', throws(() => R.canonicalizeLines([
  { componentItemId: 'A', quantity: 2, enteredUnitId: 'U-KG', conversionFactor: 1000 },
  { componentItemId: 'A', quantity: 3, enteredUnitId: 'U-G', conversionFactor: 1 },
]), 'DUPLICATE_COMPONENT_UNIT_MISMATCH'));
check('folds correctly when both lines share a non-1 factor', (() => {
  const f = R.canonicalizeLines([
    { componentItemId: 'A', quantity: 2, conversionFactor: 1000, enteredUnitId: 'U-KG' },
    { componentItemId: 'A', quantity: 3, conversionFactor: 1000, enteredUnitId: 'U-KG' },
  ]);
  return f.length === 1 && near(f[0].quantity, 5) && near(f[0].baseQuantity, 5000);
})());
check('canonicalization still validates each line', throws(() => R.canonicalizeLines([{ componentItemId: 'A', quantity: 0 }]), 'VALIDATION_ERROR'));

// ═══ cycles ═══
console.log('\n═══ recipeEngine — cycle / self-reference ═══');
check('detects self reference on an inv product',
  throws(() => R.assertAcyclic('inv', 'ITM-A', ['ITM-B', 'ITM-A'], new Map()), 'RECIPE_SELF_REFERENCE'));
check('a menu product sharing an id with a component is NOT self reference',
  R.assertAcyclic('menu', 'ITM-A', ['ITM-A'], new Map()) === true);
{
  // ITM-B's recipe uses ITM-C; ITM-C's uses ITM-A. Saving ITM-A -> [ITM-B] closes A→B→C→A.
  const edges = new Map([['inv:ITM-B', ['ITM-C']], ['inv:ITM-C', ['ITM-A']]]);
  check('detects a 3-level cycle', throws(() => R.assertAcyclic('inv', 'ITM-A', ['ITM-B'], edges), 'RECIPE_CYCLE'));
  check('accepts the same graph without the closing edge',
    R.assertAcyclic('inv', 'ITM-A', ['ITM-D'], edges) === true);
}
check('a diamond (A->B, A->C, B->D, C->D) is NOT a cycle', (() => {
  const edges = new Map([['inv:B', ['D']], ['inv:C', ['D']], ['inv:D', []]]);
  return R.assertAcyclic('inv', 'A', ['B', 'C'], edges) === true;
})());
check('components that are not themselves recipes terminate the walk',
  R.assertAcyclic('inv', 'A', ['RAW-1', 'RAW-2'], new Map()) === true);

// ═══ cost ═══
console.log('\n═══ recipeEngine — cost ═══');
{
  // 2 units @ 10 with 10% waste = 22 ; 3 units @ 5 = 15 ; batch 37 over yield 4
  const c = R.computeRecipeCost([
    { componentItemId: 'A', baseQuantity: 2, wastePct: 10, unitCost: 10 },
    { componentItemId: 'B', baseQuantity: 3, wastePct: 0, unitCost: 5 },
  ], 4);
  check('batch cost capitalises expected waste', near(c.batchCost, 37), c.batchCost);
  check('unit cost divides the batch by yield', near(c.unitCost, 9.25), c.unitCost);
  check('per-line gross quantity is exposed', near(c.lines[0].grossQuantity, 2.2), c.lines[0].grossQuantity);
  check('per-line cost is exposed', near(c.lines[0].lineCost, 22), c.lines[0].lineCost);
}
check('cost rejects yield 0 rather than coercing it to 1',
  throws(() => R.computeRecipeCost([{ baseQuantity: 1, unitCost: 1 }], 0), 'VALIDATION_ERROR'));
check('a component with no cost contributes zero, not NaN',
  near(R.computeRecipeCost([{ baseQuantity: 2, unitCost: null }], 1).batchCost, 0));
check('foodCostPct', R.foodCostPct(3, 10) === 30);
check('foodCostPct is null with no price', R.foodCostPct(3, 0) === null);
check('marginPct', R.marginPct(3, 10) === 70);
check('marginPct is null with no price', R.marginPct(3, null) === null);
check('anomaly: zero cost', R.costAnomalies({ unitCost: 0, sellingPrice: 10 }).indexOf('ZERO_COST') !== -1);
check('anomaly: cost exceeds price', R.costAnomalies({ unitCost: 12, sellingPrice: 10 }).indexOf('COST_EXCEEDS_PRICE') !== -1);
check('anomaly: high food cost', R.costAnomalies({ unitCost: 7, sellingPrice: 10 }).indexOf('FOOD_COST_HIGH') !== -1);
check('anomaly: healthy recipe is clean', R.costAnomalies({ unitCost: 3, sellingPrice: 10 }).length === 0);
check('anomaly: stale cost', R.costAnomalies({ unitCost: 3, sellingPrice: 10, staleDays: 120 }).indexOf('COST_STALE') !== -1);

// ═══ joint cost allocation ═══
console.log('\n═══ recipeEngine — joint cost allocation ═══');
{
  const a = R.allocateJointCost([
    { id: 'o1', outputType: 'primary', baseQuantity: 10, allocMethod: 'weight', allocValue: 1 },
    { id: 'o2', outputType: 'co_product', baseQuantity: 30, allocMethod: 'weight', allocValue: 1 },
  ], 100);
  check('weight split 10:30 gives 25/75', near(a.outputs[0].value, 25) && near(a.outputs[1].value, 75),
    a.outputs.map((o) => o.value));
  check('INVARIANT: Σ allocated === pool', near(a.allocated, 100), a.allocated);
  check('shares sum to 1', near(a.outputs.reduce((s, o) => s + o.share, 0), 1));
}
{
  const a = R.allocateJointCost([
    { id: 'o1', outputType: 'primary', baseQuantity: 10, allocMethod: 'standard_cost', allocValue: 8 },
    { id: 'o2', outputType: 'co_product', baseQuantity: 5, allocMethod: 'standard_cost', allocValue: 4 },
  ], 100);
  // basis 80 : 20
  check('standard-cost basis splits 80/20', near(a.outputs[0].value, 80) && near(a.outputs[1].value, 20),
    a.outputs.map((o) => o.value));
  check('INVARIANT holds for standard_cost', near(a.allocated, 100));
}
{
  const a = R.allocateJointCost([
    { id: 'o1', outputType: 'primary', baseQuantity: 10, allocMethod: 'weight', allocValue: 1 },
    { id: 'by', outputType: 'by_product', baseQuantity: 4, allocMethod: 'nrv', allocValue: 2.5 },
  ], 100);
  const by = a.outputs.find((o) => o.id === 'by');
  const pri = a.outputs.find((o) => o.id === 'o1');
  check('by-product is credited at NRV (4 x 2.5 = 10)', near(by.value, 10), by.value);
  check('the primary absorbs the remainder (90)', near(pri.value, 90), pri.value);
  check('INVARIANT holds with an NRV by-product', near(a.allocated, 100));
}
{
  const a = R.allocateJointCost([
    { id: 'o1', outputType: 'primary', baseQuantity: 10, allocMethod: 'fixed_pct', allocValue: 70 },
    { id: 'o2', outputType: 'co_product', baseQuantity: 10, allocMethod: 'fixed_pct', allocValue: 30 },
  ], 100);
  check('fixed percentages are honoured exactly', near(a.outputs[0].value, 70) && near(a.outputs[1].value, 30));
  check('INVARIANT holds for fixed_pct with no residual row', near(a.allocated, 100), a.allocated);
}
check('rejects fixed percentages summing over 100', throws(() => R.allocateJointCost([
  { id: 'a', outputType: 'primary', baseQuantity: 1, allocMethod: 'fixed_pct', allocValue: 70 },
  { id: 'b', outputType: 'co_product', baseQuantity: 1, allocMethod: 'fixed_pct', allocValue: 50 },
], 100), 'ALLOCATION_PCT_OVERFLOW'));
check('rejects a non-positive output quantity', throws(() => R.allocateJointCost([
  { id: 'a', outputType: 'primary', baseQuantity: 0, allocMethod: 'weight', allocValue: 1 },
], 100), 'VALIDATION_ERROR'));
check('rejects an unknown output type', throws(() => R.allocateJointCost([
  { id: 'a', outputType: 'mystery', baseQuantity: 1 },
], 100), 'VALIDATION_ERROR'));
check('INVARIANT survives a pool that does not divide evenly (three-way 100/3)', (() => {
  const a = R.allocateJointCost([
    { id: 'a', outputType: 'primary', baseQuantity: 1, allocMethod: 'weight', allocValue: 1 },
    { id: 'b', outputType: 'co_product', baseQuantity: 1, allocMethod: 'weight', allocValue: 1 },
    { id: 'c', outputType: 'co_product', baseQuantity: 1, allocMethod: 'weight', allocValue: 1 },
  ], 100);
  return near(a.allocated, 100, 0.0001);
})());
check('a zero pool allocates zero everywhere without dividing by zero', (() => {
  const a = R.allocateJointCost([
    { id: 'a', outputType: 'primary', baseQuantity: 2, allocMethod: 'weight', allocValue: 1 },
    { id: 'b', outputType: 'co_product', baseQuantity: 3, allocMethod: 'weight', allocValue: 1 },
  ], 0);
  return near(a.allocated, 0) && a.outputs.every((o) => o.value === 0);
})());
check('zero total basis splits equally instead of NaN', (() => {
  const a = R.allocateJointCost([
    { id: 'a', outputType: 'primary', baseQuantity: 2, allocMethod: 'weight', allocValue: 0 },
    { id: 'b', outputType: 'co_product', baseQuantity: 3, allocMethod: 'weight', allocValue: 0 },
  ], 100);
  return near(a.allocated, 100) && near(a.outputs[0].value, 50);
})());

// ═══ the posting invariant ═══
console.log('\n═══ recipeEngine — allocation invariant guard ═══');
check('accepts a balanced relief',
  R.assertAllocationInvariant({ outputsTotal: 90, wasteTotal: 8, varianceTotal: 2, wipRelieved: 100 }) === true);
check('accepts sub-halala float noise',
  R.assertAllocationInvariant({ outputsTotal: 90.001, wasteTotal: 10, varianceTotal: 0, wipRelieved: 100 }) === true);
check('REFUSES an unbalanced relief', throws(() => R.assertAllocationInvariant({
  outputsTotal: 90, wasteTotal: 5, varianceTotal: 0, wipRelieved: 100,
}), 'ALLOCATION_INVARIANT_VIOLATION'));

// ═══ material allocation (partial-output genealogy) ═══
console.log('\n═══ recipeEngine — material allocation share ═══');
check('half of the expected output takes half the remaining material',
  near(R.outputAllocationShare({ plannedQty: 100, producedSoFar: 0, wasteSoFar: 0, goodQty: 50, wasteQty: 0 }), 0.5));
check('the second half then takes ALL of what is left',
  near(R.outputAllocationShare({ plannedQty: 100, producedSoFar: 50, wasteSoFar: 0, goodQty: 50, wasteQty: 0 }), 1));
check('the final event sweeps the remainder whatever the maths says',
  R.outputAllocationShare({ plannedQty: 100, producedSoFar: 0, wasteSoFar: 0, goodQty: 1, wasteQty: 0, isFinal: true }) === 1);
check('waste counts toward the event quantity',
  near(R.outputAllocationShare({ plannedQty: 100, producedSoFar: 0, wasteSoFar: 0, goodQty: 40, wasteQty: 10 }), 0.5));
check('over-production never exceeds a share of 1',
  R.outputAllocationShare({ plannedQty: 10, producedSoFar: 0, wasteSoFar: 0, goodQty: 50, wasteQty: 0 }) === 1);
check('a zero-quantity event is rejected',
  throws(() => R.outputAllocationShare({ plannedQty: 10, goodQty: 0, wasteQty: 0 }), 'VALIDATION_ERROR'));
{
  const remaining = [
    { issueLineId: 'L1', componentItemId: 'A', componentLotId: 'LOT-1', remainingQty: 100, unitCost: 2 },
    { issueLineId: 'L2', componentItemId: 'B', componentLotId: null, remainingQty: 50, unitCost: 3 },
  ];
  const first = R.planMaterialAllocation(remaining, 0.5);
  check('a 50% share allocates half of every remaining line',
    near(first[0].qty, 50) && near(first[1].qty, 25), first.map((r) => r.qty));
  const second = R.planMaterialAllocation(
    [{ issueLineId: 'L1', componentItemId: 'A', componentLotId: 'LOT-1', remainingQty: 50, unitCost: 2 }], 1);
  check('the final share sweeps the rest — total allocated equals total consumed',
    near(first[0].qty + second[0].qty, 100), first[0].qty + second[0].qty);
  check('exhausted lines are skipped entirely',
    R.planMaterialAllocation([{ issueLineId: 'L1', componentItemId: 'A', remainingQty: 0 }], 1).length === 0);
  check('a null lot is preserved as null (untracked components)', first[1].componentLotId === null);
}
check('over-allocation is refused', throws(() => R.assertAllocationWithinConsumption(100, 80, 30), 'ALLOCATION_EXCEEDS_CONSUMPTION'));
check('exact allocation is allowed', R.assertAllocationWithinConsumption(100, 80, 20) === true);
check('float dust does not trip the guard', R.assertAllocationWithinConsumption(100, 99.9999999, 0.0000001) === true);

// ═══ scrap allowance semantics ═══
console.log('\n═══ recipeEngine — scrap allowance (0 means ZERO) ═══');
check('null means "use the default policy", not zero', R.scrapAllowanceFor(null).explicit === false);
check('undefined means "use the default policy"', R.scrapAllowanceFor(undefined).explicit === false);
check('0 is an EXPLICIT zero-scrap policy', (() => {
  const a = R.scrapAllowanceFor(0);
  return a.explicit === true && a.pct === 0;
})());
check('allowedScrapPct=0 gates ANY waste (the old code never gated it)',
  R.wasteAllowanceExceeded(100, 0, 0.001, 0) === true);
check('allowedScrapPct=0 does not gate a zero-waste event',
  R.wasteAllowanceExceeded(100, 0, 0, 0) === false);
check('allowedScrapPct=5 permits waste up to 5% of planned',
  R.wasteAllowanceExceeded(100, 0, 5, 5) === false);
check('allowedScrapPct=5 gates waste above 5% of planned',
  R.wasteAllowanceExceeded(100, 0, 5.01, 5) === true);
check('the allowance is CUMULATIVE across partial outputs',
  R.wasteAllowanceExceeded(100, 4, 2, 5) === true);
check('null allowance does not gate ordinary waste',
  R.wasteAllowanceExceeded(100, 0, 10, null) === false);
check('a negative allowance is rejected outright',
  throws(() => R.scrapAllowanceFor(-1), 'VALIDATION_ERROR'));

// ═══ lifecycle ═══
console.log('\n═══ recipeEngine — lifecycle ═══');
check('a draft may be edited in place', R.canEditInPlace('draft') === true);
check('an active recipe may NOT be edited in place', R.canEditInPlace('active') === false);
check('an active recipe requires a revision', R.requiresRevision('active') === true);
check('a draft does not require a revision', R.requiresRevision('draft') === false);
check('productKey namespaces menu and inv separately',
  R.productKey('menu', 'X') === 'menu:X' && R.productKey('inv', 'X') === 'inv:X');
check('an unknown source normalizes to inv', R.normalizeSource('weird') === 'inv');

console.log(`\n${_f === 0 ? '✅' : '❌'} recipeEngine: ${_p} passed, ${_f} failed\n`);
process.exit(_f === 0 ? 0 : 1);
