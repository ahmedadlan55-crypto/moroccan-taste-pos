/**
 * Phase 4A — replenishment engine unit tests (pure). Run: node tests/replenishmentEngine.test.js
 * Covers rule validation, the recommendedQty formula, and the days-of-cover /0 guard.
 */
'use strict';
const R = require('../lib/replenishmentEngine');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function throwsV(fn, msg) { let code = null; try { fn(); } catch (e) { code = e.code; } if (code !== 'VALIDATION_ERROR') throw new Error((msg || 'expected VALIDATION_ERROR') + ', got ' + code); }

console.log('\n═══ Replenishment engine ═══\n');

console.log('─── validateRule ───');
test('accepts a valid rule', () => { const r = R.validateRule({ minQty: 5, reorderPoint: 10, reorderQty: 20, maxStock: 50, safetyStock: 5, leadTimeDays: 7 }); eq(r.reorderPoint, 10); });
test('rejects negative values', () => throwsV(() => R.validateRule({ reorderPoint: -1, reorderQty: 5 })));
test('rejects reorderQty 0 when enabled', () => throwsV(() => R.validateRule({ isEnabled: true, reorderQty: 0, reorderPoint: 10, safetyStock: 0 })));
test('rejects maxStock < reorderPoint', () => throwsV(() => R.validateRule({ reorderPoint: 30, reorderQty: 5, maxStock: 20, safetyStock: 0 })));
test('rejects reorderPoint < safetyStock', () => throwsV(() => R.validateRule({ reorderPoint: 5, reorderQty: 5, safetyStock: 10 })));
test('disabled rule may have reorderQty 0', () => { const r = R.validateRule({ isEnabled: false, reorderQty: 0, reorderPoint: 0, safetyStock: 0 }); eq(r.isEnabled, false); });

console.log('\n─── avgDailyOut + daysOfCover (no /0) ───');
test('avgDailyOut = totalOut / days', () => eq(R.avgDailyOut(300, 30), 10));
test('avgDailyOut 0 when days 0', () => eq(R.avgDailyOut(300, 0), 0));
test('daysOfCover = onHand / avgDaily', () => eq(R.daysOfCover(100, 10), 10));
test('daysOfCover NULL when no outbound (never divide by 0)', () => eq(R.daysOfCover(100, 0), null));

console.log('\n─── reorderStatus ───');
test('negative onHand → negative', () => eq(R.reorderStatus(-2, { safetyStock: 5, reorderPoint: 10 }), 'negative'));
test('<= safetyStock → critical', () => eq(R.reorderStatus(4, { safetyStock: 5, reorderPoint: 10 }), 'critical'));
test('<= reorderPoint → reorder', () => eq(R.reorderStatus(9, { safetyStock: 5, reorderPoint: 10 }), 'reorder'));
test('within 25% of reorderPoint → watch', () => eq(R.reorderStatus(12, { safetyStock: 5, reorderPoint: 10 }), 'watch'));
test('comfortable → ok', () => eq(R.reorderStatus(40, { safetyStock: 5, reorderPoint: 10 }), 'ok'));

console.log('\n─── recommendedQty formula ───');
test('below reorder WITH maxStock → max(reorderQty, maxStock − onHand)', () => eq(R.recommendedQty(5, { reorderPoint: 10, reorderQty: 20, maxStock: 50 }), 45));
test('below reorder WITHOUT maxStock → max(reorderQty, reorderPoint+reorderQty − onHand)', () => eq(R.recommendedQty(5, { reorderPoint: 10, reorderQty: 20, maxStock: 0 }), 25));
test('above reorder → 0', () => eq(R.recommendedQty(15, { reorderPoint: 10, reorderQty: 20, maxStock: 50 }), 0));
test('negative onHand brings target back above zero', () => eq(R.recommendedQty(-3, { reorderPoint: 10, reorderQty: 20, maxStock: 50 }), 53));
test('at reorderPoint exactly → recommends', () => eq(R.recommendedQty(10, { reorderPoint: 10, reorderQty: 20, maxStock: 50 }), 40));

console.log('\n─── stockoutRisk ───');
test('unknown when daysOfCover null', () => eq(R.stockoutRisk(null, 7), 'unknown'));
test('high when cover < leadTime', () => eq(R.stockoutRisk(3, 7), 'high'));
test('medium when cover < 2×leadTime', () => eq(R.stockoutRisk(10, 7), 'medium'));
test('low when cover >= 2×leadTime', () => eq(R.stockoutRisk(20, 7), 'low'));

console.log('\n─── computeReplenishment (integration) ───');
test('full row: onHand 5, reorder 10/20, max 50, ado 2, lead 7', () => {
  const r = R.computeReplenishment({ onHand: 5, avgDailyOut: 2, hasRule: true, rule: { reorderPoint: 10, reorderQty: 20, maxStock: 50, safetyStock: 5, leadTimeDays: 7 } });
  eq(r.recommendedQty, 45);
  eq(r.daysOfCover, 2.5);
  eq(r.reorderStatus, 'critical');
  eq(r.stockoutRisk, 'high');
  eq(r.available, 5);
});

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
