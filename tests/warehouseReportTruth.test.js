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
check('browser printing uses one complete repeatable-read snapshot instead of a paged screen result',
  source.includes("router.get('/reports/:reportType/print', READ") &&
  source.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') &&
  source.includes('_withConsistentReportSnapshot(req, () => builder.run') &&
  source.includes('pagination: null'));
check('oversized print snapshots fail explicitly instead of truncating silently',
  source.includes('const PRINT_MAX_ROWS = 5000') &&
  source.includes("code: 'PRINT_LIMIT'") &&
  source.includes('PRINT_MAX_ROWS + 1'));
check('data-quality rows expose stable metric codes so the bilingual UI never depends on Arabic labels',
  source.includes("one('movementsWithoutWarehouse'") &&
  source.includes("one('activeCanonicalLots'") &&
  source.includes('measurementFailed: true'));
check('transfer in-transit total is aggregated across the full filtered result, not the visible page',
  source.includes("SELECT COALESCE(SUM(' + rem + '),0) AS remaining") &&
  source.includes("si.status IN ('issued','partially_received')") &&
  !source.includes('inTransitRemaining += remaining'));
check('report failures return a safe code instead of raw driver messages',
  source.includes("code: 'SERVER_ERROR'") &&
  !/res\.status\(500\)\.json\(\{[^}]*error:\s*e\.message/.test(source));
check('the export contract selects language-specific headers and localized row values',
  source.includes("lang === 'en' ? CSV_HEADERS_EN[type] : builder.headers") &&
  source.includes('_csvLocalizedDto(type, row, lang)'));

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

async function runtimeChecks() {
  const db = require('../db/connection');
  const router = require('../routes/warehouse-reports');
  const hooks = router.__test;

  const warehouses = [
    { id: 'w1', code: 'B', name: 'Beta', totalValue: 40, totalQty: 9, itemCount: 2 },
    { id: 'w2', code: 'A', name: 'Alpha', totalValue: 90, totalQty: 3, itemCount: 7 },
    { id: 'w3', code: 'C', name: 'Gamma', totalValue: 60, totalQty: 5, itemCount: 4 },
  ];
  const page = hooks.warehouseRowsPage(warehouses, {
    sort: { key: 'value', dir: 'DESC' }, offset: 1, pageSize: 1,
  }, false);
  check('warehouse valuation/compare sorting and pagination are applied to the requested page',
    page.length === 1 && page[0].id === 'w3');
  const exported = hooks.warehouseRowsPage(warehouses, {
    sort: { key: 'name', dir: 'ASC' }, offset: 2, pageSize: 1,
  }, true);
  check('warehouse print/export ordering is complete and never sliced by screen pagination',
    exported.map((row) => row.id).join(',') === 'w2,w1,w3');

  const englishWarehouse = hooks.csvLocalizedDto('warehouse-compare', { type: 'production' }, 'en');
  const arabicStock = hooks.csvLocalizedDto('stock-balance', { status: 'low', costEstimated: true }, 'ar');
  const englishQuality = hooks.csvLocalizedDto('data-quality', {
    metric: 'itemsWithoutMinimum', label: 'نص خادم', note: 'نص خادم', measurementFailed: false,
  }, 'en');
  check('CSV values are localized from stable codes rather than server-language labels',
    englishWarehouse.type === 'Production warehouse' &&
    arabicStock.status === 'منخفض' && arabicStock.costEstimatedLabel === 'نعم' &&
    englishQuality.label === 'Items without a minimum');
  check('every warehouse report has a complete English CSV header set',
    Object.keys(hooks.csvHeadersEn).length === 12 &&
    hooks.csvHeadersEn['stock-balance'][0] === 'Item');

  const events = [];
  const fake = {
    query: async (sql) => { events.push(String(sql)); return [[]]; },
    beginTransaction: async () => { events.push('BEGIN'); },
    commit: async () => { events.push('COMMIT'); },
    rollback: async () => { events.push('ROLLBACK'); },
    release: () => { events.push('RELEASE'); },
  };
  const originalGetConnection = db.getConnection;
  db.getConnection = async () => fake;
  try {
    const req = {};
    await hooks.withConsistentReportSnapshot(req, async () => {
      assert.strictEqual(req._reportDb, fake, 'builder did not receive the pinned connection');
      await req._reportDb.query('SELECT totals');
      await req._reportDb.query('SELECT rows');
      return 'ok';
    });
    check('print totals and rows execute on one repeatable-read connection and commit before release',
      events.join('|') === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ|BEGIN|SELECT totals|SELECT rows|COMMIT|RELEASE' && !req._reportDb);
  } finally {
    db.getConnection = originalGetConnection;
  }

  console.log(`\n${passed}/${passed} warehouse reporting truth tests passed`);
}

runtimeChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
