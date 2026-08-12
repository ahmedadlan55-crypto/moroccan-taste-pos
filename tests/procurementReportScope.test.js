/** Pure/static security gate for procurement report warehouse scoping. */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../lib/procurement/reportScope');
const reports = require('../routes/procurement/reports');
const procurementCaps = require('../db/migrations/procurement/capabilities');
const financeCaps = require('../db/migrations/finance/capabilities');

let passed = 0, failed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '\n     ', e.message); }
}
function ok(value, message) { if (!value) throw new Error(message || 'expected truthy'); }
function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function throws(fn, pattern) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error('expected function to throw');
  if (pattern && !pattern.test(String(caught.message))) throw caught;
}

console.log('\n═══ Procurement report warehouse scope ═══');

test('from/to aliases and warehouseId are normalized', () => {
  eq(S.parseReportFilters({ dateFrom: '2026-01-01', dateTo: '2026-01-31', warehouseId: ' W-1 ' }), {
    from: '2026-01-01', to: '2026-01-31', asOfDate: '', warehouseId: 'W-1',
  });
});
test('invalid calendar dates are rejected', () => {
  throws(() => S.parseReportFilters({ from: '2026-02-31' }), /valid date/);
});
test('reversed ranges are rejected', () => {
  throws(() => S.parseReportFilters({ from: '2026-02-01', to: '2026-01-01' }), /on or before/);
});
test('missing request scope fails closed', () => {
  eq(S.warehousePredicate(null, 'si.warehouse_id', ''), { sql: ' AND 1=0', params: [], denied: true });
});
test('non-global empty grants fail closed', () => {
  eq(S.warehousePredicate({ all: false, warehouseIds: [] }, 'po.warehouse_id', ''),
    { sql: ' AND 1=0', params: [], denied: true });
});
test('global scope without a requested warehouse remains global', () => {
  eq(S.warehousePredicate({ all: true }, 'si.warehouse_id', ''), { sql: '', params: [], denied: false });
});
test('global requested warehouse is parameterized', () => {
  eq(S.warehousePredicate({ all: true }, 'si.warehouse_id', "W' OR 1=1 --"),
    { sql: ' AND si.warehouse_id = ?', params: ["W' OR 1=1 --"], denied: false });
});
test('restricted scope uses deduplicated placeholders', () => {
  eq(S.warehousePredicate({ all: false, warehouseIds: ['W1', 'W1', 'W2'] }, 'po.warehouse_id', ''),
    { sql: ' AND po.warehouse_id IN (?,?)', params: ['W1', 'W2'], denied: false });
});
test('allowed explicit warehouse narrows to one parameter', () => {
  eq(S.warehousePredicate({ all: false, warehouseIds: ['W1', 'W2'] }, 'po.warehouse_id', 'W2'),
    { sql: ' AND po.warehouse_id = ?', params: ['W2'], denied: false });
});
test('forbidden warehouse fails closed without echoing its id', () => {
  const out = S.warehousePredicate({ all: false, warehouseIds: ['W1'] }, 'po.warehouse_id', 'SECRET-WH');
  eq(out, { sql: ' AND 1=0', params: [], denied: true });
  ok(!JSON.stringify(out).includes('SECRET-WH'));
});
test('warehouse SQL expressions are allow-listed', () => {
  throws(() => S.warehousePredicate({ all: true }, 'si.warehouse_id OR 1=1', ''), /Untrusted/);
});
test('date predicates are parameterized', () => {
  eq(S.datePredicate('si.issue_date', '2026-01-01', '2026-01-31'), {
    sql: ' AND si.issue_date >= ? AND si.issue_date <= ?',
    params: ['2026-01-01', '2026-01-31'],
  });
});
test('date columns are allow-listed', () => {
  throws(() => S.datePredicate('issue_date; DROP TABLE x', '2026-01-01', ''), /Untrusted/);
});
test('purchase analysis scopes inside aggregate and remains strict-group-safe', () => {
  const built = reports.buildPurchaseAnalysisQuery({
    query: { dateFrom: '2026-01-01', dateTo: '2026-01-31', warehouseId: 'W2' },
    warehouseScope: { all: false, warehouseIds: ['W1', 'W2'] },
  });
  ok(/FROM supplier_invoices si[\s\S]+si\.issue_date >= \?[\s\S]+si\.warehouse_id = \?[\s\S]+GROUP BY si\.supplier_id/.test(built.sql));
  eq(built.params, ['2026-01-01', '2026-01-31', 'W2']);
  ok(!built.sql.includes('W2'), 'warehouse value must never be interpolated');
});
test('match scope precedence is receipt line → receipt → PO → invoice', () => {
  ok(reports.MATCH_WAREHOUSE.startsWith('COALESCE(prl.warehouse_id COLLATE'));
  ok(reports.MATCH_WAREHOUSE.indexOf('prl.warehouse_id') < reports.MATCH_WAREHOUSE.indexOf('pr.warehouse_id'));
  ok(reports.MATCH_WAREHOUSE.indexOf('pr.warehouse_id') < reports.MATCH_WAREHOUSE.indexOf('po.warehouse_id'));
  ok(reports.MATCH_WAREHOUSE.indexOf('po.warehouse_id') < reports.MATCH_WAREHOUSE.indexOf('si.warehouse_id'));
});
test('report center finance readers and procurement readers are accepted by contract', () => {
  eq(reports.REPORT_READ_CAPS, ['finance.reports.view', 'procurement.reports']);
  eq(reports.DATA_QUALITY_READ_CAPS, ['finance.reports.view', 'procurement.data_quality']);
});
test('accountant/auditor have finance reports but cashier has neither report grant', () => {
  ok(financeCaps.ROLE_GRANTS.accountant.includes('finance.reports.view'));
  ok(financeCaps.ROLE_GRANTS.auditor.includes('finance.reports.view'));
  ok(procurementCaps.ROLE_GRANTS.purchasing.includes('procurement.reports'));
  ok(!Object.prototype.hasOwnProperty.call(financeCaps.ROLE_GRANTS, 'cashier'));
  ok(!Object.prototype.hasOwnProperty.call(procurementCaps.ROLE_GRANTS, 'cashier'));
});

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'procurement', 'reports.js'), 'utf8');
test('all nine report handlers are present', () => {
  const routes = [...source.matchAll(/router\.get\('([^']+)'/g)].map((m) => m[1]);
  eq(routes, ['/open-orders', '/receiving-variance', '/three-way-match', '/ap-aging',
    '/supplier-statement', '/purchase-analysis', '/price-variance', '/tax', '/data-quality']);
});
test('supplier statement no longer redirects to an unscoped endpoint', () => {
  ok(!/res\.redirect/.test(source));
  ok(/S\.warehousePredicate\(req\.warehouseScope, 'pret\.warehouse_id'/.test(source));
});
test('report scoping is independent of feature-flagged H.scopeClause', () => {
  ok(!/H\.scopeClause/.test(source));
  ok(/S\.warehousePredicate\(req\.warehouseScope/.test(source));
});
test('three-way match filters before grouping', () => {
  const start = source.indexOf("router.get('/three-way-match'");
  const end = source.indexOf("router.get('/ap-aging'", start);
  const body = source.slice(start, end);
  ok(body.indexOf('${sqlWhere(q.where)}') < body.indexOf('GROUP BY'));
});
test('data quality no longer reads global AP balance or global GL journals', () => {
  ok(!/v_supplier_ap_balance/.test(source));
  ok(/JOIN gl_journals gj[\s\S]+si\.gl_journal_id/.test(source));
});

console.log(`\nprocurementReportScope: ${passed}/${total} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
