'use strict';

const assert = require('assert');
const M = require('../lib/inventoryMovementSemantics');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok - ' + name);
}

test('sales, independent issues and production material issues are consumption', () => {
  for (const referenceType of ['sale', 'inv_issue', 'prod_issue', 'production', 'production_consume']) {
    assert.strictEqual(M.isOutboundConsumption({ type: 'out', reference_type: referenceType }), true, referenceType);
  }
});

test('inbound rows never count as consumption', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'in', reference_type: 'sale' }), false);
});

test('transfers do not reset the slow-moving clock', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reference_type: 'transfer', reason: 'تحويل صادر' }), false);
});

test('stock adjustments and stocktake variances do not reset the clock', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reference_type: 'inv_adjustment', reason: 'تسوية جرد' }), false);
});

test('waste and expiry disposal do not masquerade as customer demand', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reference_type: 'waste', reason: 'هدر' }), false);
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reason: 'إتلاف صلاحية' }), false);
});

test('narrow legacy fallbacks keep old sale, issue and production rows visible', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reason: 'مبيعات (نصف مصنع - legacy)' }), true);
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reason: 'صرف مستقل: مطبخ' }), true);
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reason: 'إنتاج' }), true);
});

test('a non-empty unknown reference type cannot enter through the legacy reason fallback', () => {
  assert.strictEqual(M.isOutboundConsumption({ type: 'out', reference_type: 'transfer', reason: 'مبيعات' }), false);
});

test('the SQL predicate is parameterized and excludes transfer/waste literals', () => {
  const built = M.outboundConsumptionSql('mm');
  assert.match(built.sql, /mm\.type='out'/);
  assert.ok(!built.sql.includes('transfer'));
  assert.ok(!built.sql.includes('waste'));
  assert.ok(built.params.includes('sale'));
  assert.throws(() => M.outboundConsumptionSql('mm; DROP TABLE x'));
});

test('scoped slow-moving SQL binds subquery values before outer warehouse values', () => {
  const ordered = M.subqueryFirstParams(['sale', 'inv_issue'], ['SUB-WH'], ['OUTER-WH'], [90]);
  assert.deepStrictEqual(ordered, ['sale', 'inv_issue', 'SUB-WH', 'OUTER-WH', 90]);
});

console.log(`\n${passed}/${passed} inventory movement semantic tests passed`);
