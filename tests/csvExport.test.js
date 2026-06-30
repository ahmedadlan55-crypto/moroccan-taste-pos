/**
 * Phase 2B — CSV export unit tests. Pure; no DB. Run: node tests/csvExport.test.js
 */
'use strict';

const CSV = require('../lib/csvExport');

let _p = 0, _f = 0, _t = 0;
function test(name, fn) { _t++; try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function throwsCode(fn, code) { try { fn(); } catch (e) { if (code && e.code !== code) throw new Error('expected ' + code + ', got ' + e.code); return; } throw new Error('expected throw ' + code); }

console.log('\n═══ CSV export ═══');

console.log('\n─── BOM + structure ───');
test('starts with UTF-8 BOM', () => ok(CSV.toCsv(['a'], [['1']]).charCodeAt(0) === 0xFEFF));
test('header + rows joined with CRLF', () => {
  const out = CSV.toCsv(['h1', 'h2'], [['a', 'b'], ['c', 'd']]);
  eq(out.slice(1), 'h1,h2\r\na,b\r\nc,d\r\n');
});

console.log('\n─── RFC-4180 quoting ───');
test('comma forces quoting', () => eq(CSV.quoteCell('a,b'), '"a,b"'));
test('inner quotes doubled', () => eq(CSV.quoteCell('he said "hi"'), '"he said ""hi"""'));
test('newline forces quoting', () => eq(CSV.quoteCell('a\nb'), '"a\nb"'));
test('plain value unquoted', () => eq(CSV.quoteCell('plain'), 'plain'));

console.log('\n─── formula-injection guard ───');
test('=cmd neutralized', () => eq(CSV.sanitizeCell('=cmd'), "'=cmd"));
test('+1+1 neutralized', () => eq(CSV.sanitizeCell('+1+1'), "'+1+1"));
test('@SUM neutralized', () => eq(CSV.sanitizeCell('@SUM(A1)'), "'@SUM(A1)"));
test('-cmd (non-number) neutralized', () => eq(CSV.sanitizeCell('-cmd'), "'-cmd"));
test('negative NUMBER kept intact (not a formula)', () => eq(CSV.sanitizeCell('-5.5'), '-5.5'));
test('positive number intact', () => eq(CSV.sanitizeCell('42'), '42'));
test('injected cell is quoted AND prefixed when needed', () => eq(CSV.quoteCell('=1,2'), '"\'=1,2"'));

console.log('\n─── export cap ───');
test('over MAX_EXPORT_ROWS throws EXPORT_LIMIT', () => {
  const big = new Array(CSV.MAX_EXPORT_ROWS + 1).fill(['x']);
  throwsCode(() => CSV.toCsv(['h'], big), 'EXPORT_LIMIT');
});
test('exactly MAX_EXPORT_ROWS is allowed', () => {
  const rows = new Array(CSV.MAX_EXPORT_ROWS).fill(['x']);
  ok(CSV.toCsv(['h'], rows).length > 0);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('Total: ' + _t + ' | Passed: ' + _p + ' | Failed: ' + _f);
console.log('═══════════════════════════════════════════════════════════');
process.exit(_f > 0 ? 1 : 0);
