#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/warehouseIntelligenceScope');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { console.error('FAIL:', name); throw error; }
}

test('missing scope fails closed independently from rollout middleware', () => {
  assert.deepEqual(S.predicate(undefined, 'ws.warehouse_id'), { sql: ' AND 1=0', params: [] });
  assert.equal(S.canReadWarehouse(undefined, 'W1'), false);
  assert.deepEqual(S.publicScope(undefined), { all: false, warehouseIds: [] });
});

test('empty non-global scope returns no report rows', () => {
  assert.deepEqual(S.predicate({ all: false, warehouseIds: [] }, 'po.warehouse_id'), { sql: ' AND 1=0', params: [] });
});

test('allowed warehouses produce parameterized IN predicate', () => {
  assert.deepEqual(
    S.predicate({ all: false, warehouseIds: ['W1', 'W2'] }, 'm.warehouse_id'),
    { sql: ' AND m.warehouse_id IN (?,?)', params: ['W1', 'W2'] },
  );
  assert.equal(S.canReadWarehouse({ all: false, warehouseIds: ['W1'] }, 'W1'), true);
  assert.equal(S.canReadWarehouse({ all: false, warehouseIds: ['W1'] }, 'W2'), false);
});

test('global scope is the only unfiltered scope', () => {
  assert.deepEqual(S.predicate({ all: true, warehouseIds: [] }, 'we.warehouse_id'), { sql: '', params: [] });
});

test('requested warehouse narrows global scope and rejects an out-of-scope request', () => {
  assert.deepEqual(
    S.predicate({ all: true, warehouseIds: [] }, 'ws.warehouse_id', 'W9'),
    { sql: ' AND ws.warehouse_id = ?', params: ['W9'] },
  );
  assert.deepEqual(
    S.predicate({ all: false, warehouseIds: ['W1'] }, 'ws.warehouse_id', 'W9'),
    { sql: ' AND 1=0', params: [] },
  );
});

test('SQL expressions are allowlisted', () => {
  assert.throws(
    () => S.predicate({ all: true }, 'ws.warehouse_id OR 1=1'),
    (error) => error.code === 'WAREHOUSE_SCOPE_EXPRESSION_INVALID',
  );
});

test('append strips AND and preserves bind parameters', () => {
  const where = [], params = [];
  S.append({ all: false, warehouseIds: ['A'] }, 'COALESCE(prl.warehouse_id, pr.warehouse_id)', where, params);
  assert.deepEqual(where, ['COALESCE(prl.warehouse_id, pr.warehouse_id) IN (?)']);
  assert.deepEqual(params, ['A']);
});

test('access-scope publishes authoritative report grants including user overrides', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'inventory.js'), 'utf8');
  assert.match(source, /hasCapability\(user, id\)/);
  assert.match(source, /'finance\.reports\.view', 'procurement\.reports'/);
  assert.match(source, /capabilities:\s*\{\s*\.\.\._capabilitiesFor\(req\.user\),\s*\.\.\.reportCapabilities\s*\}/);
});

const legacyReportsSource = fs.readFileSync(require.resolve('../routes/warehouse-reports'), 'utf8');
const intelligenceSource = fs.readFileSync(require.resolve('../routes/warehouse-intelligence'), 'utf8');

test('all warehouse report, analytics, catalog and export routes require report RBAC', () => {
  assert.match(legacyReportsSource, /router\.get\('\/analytics\/summary', READ/);
  assert.match(legacyReportsSource, /router\.get\('\/reports\/catalog', READ/);
  assert.match(legacyReportsSource, /router\.get\('\/reports\/:reportType\/print', READ/);
  assert.match(legacyReportsSource, /router\.get\('\/reports\/:reportType', READ/);
  assert.match(legacyReportsSource, /router\.get\('\/reports\/:reportType\/export', READ/);
  assert.match(legacyReportsSource, /hasCapability\(req\.user, 'finance\.reports\.view'\)[\s\S]*hasCapability\(req\.user, 'procurement\.reports'\)/);
  assert.match(legacyReportsSource, /status\(403\).*PERMISSION_DENIED/s);
});

test('both warehouse report surfaces use strict scope and never rollout shadow helpers', () => {
  for (const source of [legacyReportsSource, intelligenceSource]) {
    assert.match(source, /STRICT_SCOPE/);
    assert.doesNotMatch(source, /req\.guardWh|req\.whScopeClause|WAREHOUSE_SCOPE_ENFORCE/);
  }
  assert.match(legacyReportsSource, /_guardRequestedWarehouse/);
  assert.match(intelligenceSource, /guardRequestedWarehouse/);
});

console.log(`warehouseIntelligenceScope: ${passed}/${passed} passed`);
