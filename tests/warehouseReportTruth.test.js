'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'warehouse-reports.js'), 'utf8');
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ok - ' + name);
}

check('both overview and detail slow-moving queries use outbound-consumption semantics',
  (source.match(/MOVEMENT\.outboundConsumptionSql\('mm'\)/g) || []).length === 2);
check('both scoped scalar subqueries bind predicate and subquery scope before the outer scope',
  (source.match(/MOVEMENT\.subqueryFirstParams\(/g) || []).length === 2);

const expiryStart = source.indexOf("'expiry': {");
const qualityStart = source.indexOf("'data-quality': {", expiryStart);
assert.ok(expiryStart >= 0 && qualityStart > expiryStart, 'expiry report body exists');
const expiry = source.slice(expiryStart, qualityStart);
check('expiry detail uses the canonical lot ledger',
  expiry.includes('warehouse_lot_balances b JOIN inventory_lots l'));
check('expiry detail does not silently fall back to the legacy purchase_lots estimate',
  !expiry.includes('FROM purchase_lots'));
check('expiry response exposes quantity coverage and authoritative state',
  expiry.includes('coverage') && expiry.includes('authoritative: sourceAvailable && coverage.complete'));

console.log(`\n${passed}/${passed} warehouse reporting truth tests passed`);
