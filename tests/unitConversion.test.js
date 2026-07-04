/**
 * Unit tests — lib/unitConversion.js (pure; no DB).
 * Run: node tests/unitConversion.test.js   (included in `npm test`)
 */
'use strict';
const U = require('../lib/unitConversion');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }
const eq = (a, b) => U.round(a, 6) === U.round(b, 6);

console.log('\n═══ unitConversion — core math ═══');
check('1 carton (factor 12) → 12 base', eq(U.toBase(1, 12), 12));
check('3 cartons → 36 base', eq(U.toBase(3, 12), 36));
check('base unit factor 1 is identity', eq(U.toBase(27, 1), 27));
check('composite 2 carton + 3 base (f12) → 27', eq(U.compositeToBase(2, 3, 12), 27));
check('composite 6 carton + 9 base (f12) → 81', eq(U.compositeToBase(6, 9, 12), 81));
check('fromBase 120 (f12) → 10 cartons', eq(U.fromBase(120, 12), 10));
check('decimal factor: 1 bag = 25 kg → 2 bags = 50', eq(U.toBase(2, 25), 50));
check('fractional factor 0.5 → 3 units = 1.5 base', eq(U.toBase(3, 0.5), 1.5));

console.log('\n═══ rounding / precision ═══');
check('no float drift: 0.1 carton f 3 = 0.3', eq(U.toBase(0.1, 3), 0.3));
check('round respects precision (2dp)', U.round(1.23456, 2) === 1.23);
check('precision cap at 6', U.round(1.123456789, 20) === 1.123457);

console.log('\n═══ describeBase (major+minor label) ═══');
const d = U.describeBase(125, 12, 'حبة', 'كرتون');
check('125 base f12 → 10 major + 5 minor', d.major === 10 && d.minor === 5, d);
check('describe text contains split', /125 حبة = 10 كرتون \+ 5 حبة/.test(d.text), d.text);
const d0 = U.describeBase(7, 12, 'حبة', 'كرتون');
check('7 base f12 → 0 major + 7 minor', d0.major === 0 && d0.minor === 7, d0);
const dNoMajor = U.describeBase(7, 1, 'حبة', null);
check('no major unit → base only text', dNoMajor.text === '7 حبة', dNoMajor);

console.log('\n═══ validators ═══');
check('invalid factor (0) throws', throws(() => U.toBase(1, 0)));
check('negative factor throws', throws(() => U.toBase(1, -2)));
check('negative composite qty throws', throws(() => U.compositeToBase(-1, 0, 12)));
check('single base + factor 1 → ok', U.validateItemUnitSet([
  { unitCode: 'PCS', isBase: true, conversionToBase: 1, isActive: true },
  { unitCode: 'CTN', isBase: false, conversionToBase: 12, isActive: true },
]).ok);
check('two base units → DUPLICATE_BASE_UNIT', U.validateItemUnitSet([
  { unitCode: 'PCS', isBase: true, conversionToBase: 1, isActive: true },
  { unitCode: 'KG', isBase: true, conversionToBase: 1, isActive: true },
]).code === 'DUPLICATE_BASE_UNIT');
check('no base → NO_BASE_UNIT', U.validateItemUnitSet([
  { unitCode: 'CTN', isBase: false, conversionToBase: 12, isActive: true },
]).code === 'NO_BASE_UNIT');
check('base factor ≠ 1 → BASE_FACTOR_NOT_ONE', U.validateItemUnitSet([
  { unitCode: 'PCS', isBase: true, conversionToBase: 2, isActive: true },
]).code === 'BASE_FACTOR_NOT_ONE');
check('duplicate unit code rejected', U.validateItemUnitSet([
  { unitCode: 'PCS', isBase: true, conversionToBase: 1, isActive: true },
  { unitCode: 'pcs', isBase: false, conversionToBase: 12, isActive: true },
]).code === 'DUPLICATE_UNIT_CODE');

console.log('\n═══ context allow gating ═══');
const baseRow = { unitCode: 'PCS', isBase: true, conversionToBase: 1, isActive: true };
const ctnSaleOnly = { unitCode: 'CTN', isBase: false, conversionToBase: 12, isActive: true, allowSale: true, allowIssue: false };
check('base always allowed for any context', U.isUnitAllowed(baseRow, 'issue') && U.isUnitAllowed(baseRow, 'sale'));
check('major unit gated by context flag: sale ok', U.isUnitAllowed(ctnSaleOnly, 'sale'));
check('major unit gated by context flag: issue denied', !U.isUnitAllowed(ctnSaleOnly, 'issue'));
check('inactive unit never allowed', !U.isUnitAllowed({ ...ctnSaleOnly, isActive: false }, 'sale'));

console.log(`\n${_f === 0 ? '✅' : '❌'} unitConversion: ${_p} passed, ${_f} failed`);
process.exit(_f === 0 ? 0 : 1);
