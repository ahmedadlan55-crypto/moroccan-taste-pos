/**
 * Unit tests for lib/barcode (W4). Pure, no DB.
 * Run: node tests/barcode.test.js
 */
'use strict';
const B = require('../lib/barcode');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name, '\n     ', e.message); } }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function truthy(v, m) { if (!v) throw new Error(m || 'expected truthy'); }
function falsy(v, m) { if (v) throw new Error(m || 'expected falsy'); }

console.log('\n=== barcode (W4) - unit ===\n');

test('normalize trims, uppercases, strips inner whitespace', () => {
  eq(B.normalize('  abc-123 '), 'ABC-123');
  eq(B.normalize('62 900 111'), '62900111');
  eq(B.normalize('ean\t9501'), 'EAN9501');
  eq(B.normalize(null), '');
  eq(B.normalize(undefined), '');
});
test('isValid: length 3-80 + no control chars', () => {
  truthy(B.isValid('629001114567'));
  truthy(B.isValid('ABC-1'));
  falsy(B.isValid('ab'));
  falsy(B.isValid('  a b '));
  falsy(B.isValid('x'.repeat(81)));
  falsy(B.isValid('AB' + String.fromCharCode(1)));
});
test('requireValid returns normalized or throws VALIDATION_ERROR', () => {
  eq(B.requireValid(' 629-001 '), '629-001');
  let code = null; try { B.requireValid('x'); } catch (e) { code = e.code; }
  eq(code, 'VALIDATION_ERROR');
});
test('SKU-like and GTIN both pass (not digits-only restricted)', () => {
  truthy(B.isValid('SKU-COLA-2L'));
  truthy(B.isValid('04006381333931'));
});

console.log('\n' + (_f === 0 ? '✅' : '❌') + ' barcode: ' + _p + ' passed, ' + _f + ' failed\n');
if (_f > 0) process.exit(1);
