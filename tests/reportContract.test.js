/**
 * Phase 2B — Report contract unit tests. Pure; no DB. Run: node tests/reportContract.test.js
 */
'use strict';

const R = require('../lib/reportContract');

let _p = 0, _f = 0, _t = 0;
function test(name, fn) { _t++; try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\n═══ Report contract ═══');

console.log('\n─── report types allowlist ───');
test('valuation is a valid type', () => eq(R.isReportType('valuation'), true));
test('unknown type rejected', () => eq(R.isReportType('drop-tables'), false));
test('12 report types', () => eq(R.REPORT_TYPES.length, 12));

console.log('\n─── parseReportFilters (clamping) ───');
test('pageSize clamps to [1,200], default 25', () => {
  eq(R.parseReportFilters({ pageSize: '9999' }, 'movements').pageSize, 200);
  eq(R.parseReportFilters({ pageSize: '0' }, 'movements').pageSize, 1);
  eq(R.parseReportFilters({}, 'movements').pageSize, 25);
});
test('page floors at 1 + offset derived', () => {
  const f = R.parseReportFilters({ page: '3', pageSize: '10' }, 'movements');
  eq([f.page, f.offset], [3, 20]);
  eq(R.parseReportFilters({ page: '-5' }, 'movements').page, 1);
});
test('no-move window constrained to {30,60,90,180} else 90', () => {
  eq(R.parseReportFilters({ window: '60' }, 'no-movement').window, 60);
  eq(R.parseReportFilters({ window: '45' }, 'no-movement').window, 90);
});
test('invalid from/to dates → null', () => {
  eq(R.parseReportFilters({ from: 'not-a-date', to: '2026-01-31' }, 'movements').from, null);
  eq(R.parseReportFilters({ from: 'not-a-date', to: '2026-01-31' }, 'movements').to, '2026-01-31');
});
test('q is trimmed', () => eq(R.parseReportFilters({ q: '  apple  ' }, 'movements').q, 'apple'));

console.log('\n─── resolveSort (injection-safe) ───');
test('valid sort maps to whitelisted column', () => {
  const s = R.resolveSort('movements', 'qty', 'asc');
  eq([s.column, s.dir, s.key], ['m.qty', 'ASC', 'qty']);
});
test('malicious sort falls back to first column (never raw)', () => {
  const s = R.resolveSort('movements', 'qty; DROP TABLE x', 'desc');
  ok(Object.values(R.SORT_WHITELIST.movements).includes(s.column), 'column must be whitelisted');
  ok(!/DROP/.test(s.column));
});
test('dir constrained to ASC/DESC', () => {
  eq(R.resolveSort('valuation', 'value', 'garbage').dir, 'DESC');
  eq(R.resolveSort('valuation', 'value', 'ASC').dir, 'ASC');
});

console.log('\n─── riyadhDateRange ───');
test('from+to → half-open boundary with params', () => {
  const r = R.riyadhDateRange('m.movement_date', '2026-01-01', '2026-01-31');
  eq(r.sql, ' AND m.movement_date >= ? AND m.movement_date < DATE_ADD(?, INTERVAL 1 DAY)');
  eq(r.params, ['2026-01-01 00:00:00', '2026-01-31 00:00:00']);
});
test('no dates → empty clause', () => eq(R.riyadhDateRange('c', null, null), { sql: '', params: [] }));
test('only from', () => {
  const r = R.riyadhDateRange('c', '2026-02-01', null);
  eq(r.params, ['2026-02-01 00:00:00']);
});

console.log('\n─── envelope ───');
test('envelope has all contract keys', () => {
  const e = R.envelope({ data: [1], totals: { x: 1 }, generatedAt: 'T' });
  eq(Object.keys(e).sort(), ['data', 'dataQualityWarnings', 'filters', 'generatedAt', 'pagination', 'scope', 'success', 'totals']);
  eq(e.success, true);
});
test('pushWarning appends structured warning', () => {
  const w = []; R.pushWarning(w, 'EXPIRY_LOW_COVERAGE', 'تقديري', 'warning');
  eq(w, [{ code: 'EXPIRY_LOW_COVERAGE', message: 'تقديري', level: 'warning' }]);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('Total: ' + _t + ' | Passed: ' + _p + ' | Failed: ' + _f);
console.log('═══════════════════════════════════════════════════════════');
process.exit(_f > 0 ? 1 : 0);
