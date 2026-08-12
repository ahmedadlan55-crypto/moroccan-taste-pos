'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'warehouse-intelligence.js'), 'utf8');
function routeBody(pathname) {
  const marker = `router.get('${pathname}'`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, marker + ' is missing');
  const next = source.indexOf('\nrouter.get(', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}
const inventoryRoute = routeBody('/accounting-reconciliation');
const grniRoute = routeBody('/grni-reconciliation');
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ok - ' + name);
}

check('inventory accounting reconciliation is finance-only',
  /router\.get\('\/accounting-reconciliation', FINANCE_READ/.test(source));
check('GRNI reconciliation is finance-only',
  /router\.get\('\/grni-reconciliation', FINANCE_READ/.test(source));
check('historical valuation fails closed without a valued movement ledger',
  source.includes('HISTORICAL_VALUE_LEDGER_REQUIRED') && source.includes('guardCurrentValuationOnly'));
check('inventory subledger values warehouse WAC before the disclosed master-cost fallback',
  source.includes("COALESCE(NULLIF(ws.avg_cost,0), NULLIF(i.cost,0))"));
check('orphan warehouse stock is retained and disclosed instead of disappearing through an inner join',
  inventoryRoute.includes('LEFT JOIN inv_items i ON i.id=ws.item_id') &&
  inventoryRoute.includes('AS orphan_stock_positions'));
check('negative effective cost is counted explicitly',
  inventoryRoute.includes('AS negative_cost_positions'));
check('inventory GL uses only the single control account contract',
  inventoryRoute.includes('resolveLedgerRole(IAR.INVENTORY_ROLE)') && !inventoryRoute.includes("'113100'"));
check('the GRNI account is resolved through the governed role registry',
  grniRoute.includes('resolveLedgerRole(IAR.GRNI_ROLE)') && !grniRoute.includes("'211200'"));
check('missing or invalid governed roles fail as readiness 503, not generic 500',
  source.includes('error instanceof AccountRoleError') && source.includes("readiness.code = 'ACCOUNT_ROLE_READINESS_MISSING'") && source.includes('readiness.status = 503'));
check('schema readiness explicitly requires the account role registry',
  inventoryRoute.includes("account_roles: ['role_key', 'company_id', 'account_id', 'is_active']") &&
  grniRoute.includes("account_roles: ['role_key', 'company_id', 'account_id', 'is_active']"));
check('only posted journals enter inventory reconciliation',
  inventoryRoute.includes("gj.status='posted'"));
check('only posted journals enter GRNI reconciliation',
  grniRoute.includes("gj.status='posted'"));
check('recoverable VAT is explicitly excluded from inventory carrying amount',
  source.includes('includesRecoverableVat: false'));
check('NRV, write-down and pledge disclosures are not fabricated',
  source.includes('NRV_TEST_AND_WRITE_DOWN_LEDGER_MISSING') && source.includes('PLEDGE_REGISTER_MISSING'));
check('periodic inventory cannot be presented as a ready perpetual reconciliation',
  inventoryRoute.includes('periodic_close_required') &&
  inventoryRoute.includes('perpetualReconciliationReady') &&
  inventoryRoute.includes('IAR.isCarryingAmountReady(summary, inventoryMethod)'));
check('GRNI clears only approved/currently-posted supplier invoice matches',
  source.includes("si.status IN ('approved','partially_paid','paid','overdue','closed')"));
check('before-invoice returns reduce GRNI using net subtotal only',
  source.includes("phase='before_invoice'") && source.includes('SUM(subtotal) AS returned_value'));
check('warehouse/supplier slices do not claim company-level GRNI to GL reconciliation',
  source.includes('canReconcileCompanyGl') && source.includes('GRNI_GL_NOT_WAREHOUSE_DIMENSIONED'));
check('GRNI aging and reconciliation aggregate the full open population outside the detail limit',
  grniRoute.includes('FROM (${grniOpenSql}) grni_open') &&
  grniRoute.includes('population: \'uncapped_all_open_receipts\'') &&
  grniRoute.includes('LIMIT ?') && grniRoute.includes('IAR.GRNI_DETAIL_LIMIT'));
check('a truncated GRNI detail response is disclosed instead of silently reconciling 2000 rows',
  grniRoute.includes('detailTruncated') && grniRoute.includes('GRNI_DETAIL_TRUNCATED') &&
  grniRoute.includes('totalOpenReceipts: openCount'));

console.log(`\n${passed}/${passed} inventory accounting route tests passed`);
