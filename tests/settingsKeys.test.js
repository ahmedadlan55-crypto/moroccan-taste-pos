/** Unit — lib/settingsKeys.js (pure). Run: node tests/settingsKeys.test.js
 *
 * Regression guards for a live defect: the React admin wrote camelCase settings
 * ('name', 'taxNumber') while the receipt/ZATCA path reads PascalCase
 * ('CompanyName', 'TaxNumber'). Different rows in a flat key-value table → the
 * owner edited the tax number, saw a success toast, and the printed invoice and
 * its ZATCA QR kept the stale value. Booleans disagreed too: React wrote
 * "true"/"false" against readers comparing to '1'/'0', so
 * NewProductsTaxInclusive failed OPEN and RequireManagerApprovalForVoid failed
 * CLOSED.
 */
'use strict';
const S = require('../lib/settingsKeys');
let _p = 0, _f = 0;
const check = (n, c, x) => { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x) : ''); } };
const map = (payload) => new Map(S.normalizeSettingsWrite(payload));

console.log('\n═══ settingsKeys ═══');

// ── canonicalKey ──
check('camelCase name → CompanyName', S.canonicalKey('name') === 'CompanyName');
check('camelCase taxNumber → TaxNumber', S.canonicalKey('taxNumber') === 'TaxNumber');
check('camelCase currency → Currency', S.canonicalKey('currency') === 'Currency');
check('already-canonical key untouched', S.canonicalKey('CompanyName') === 'CompanyName');
check('unknown key untouched', S.canonicalKey('receiptFooter') === 'receiptFooter');

// ── isTruthy: accepts every spelling a writer has used ──
check("isTruthy('1')", S.isTruthy('1') === true);
check("isTruthy('true')", S.isTruthy('true') === true);
check("isTruthy('TRUE')", S.isTruthy('TRUE') === true);
check('isTruthy(true)', S.isTruthy(true) === true);
check("isTruthy('0')", S.isTruthy('0') === false);
check("isTruthy('false')", S.isTruthy('false') === false);
check('isTruthy(null)', S.isTruthy(null) === false);
check("isTruthy('')", S.isTruthy('') === false);
check("boolToSetting('true') === '1'", S.boolToSetting('true') === '1');
check("boolToSetting(false) === '0'", S.boolToSetting(false) === '0');

// ── normalizeSettingsWrite: the actual bug ──
const tax = map({ taxNumber: '311111111111113' });
check('camelCase taxNumber ALSO writes TaxNumber (the key the receipt reads)',
  tax.get('TaxNumber') === '311111111111113', Object.fromEntries(tax));
check('camelCase taxNumber still writes its own row (legacy readers)',
  tax.get('taxNumber') === '311111111111113');

const nm = map({ name: 'مطعم الاختبار' });
check('company name kept in sync across both spellings',
  nm.get('CompanyName') === 'مطعم الاختبار' && nm.get('name') === 'مطعم الاختبار');

const lg = map({ logo: 'data:image/png;base64,AAA' });
check('logo also written as CompanyLogo (routes/cash.js reads that)',
  lg.get('CompanyLogo') === 'data:image/png;base64,AAA');

const bools = map({ NewProductsTaxInclusive: 'true', RequireManagerApprovalForVoid: 'false' });
check("NewProductsTaxInclusive 'true' → '1' (menu.js compares === '1')",
  bools.get('NewProductsTaxInclusive') === '1', Object.fromEntries(bools));
check("RequireManagerApprovalForVoid 'false' → '0' (sales.js compares === '0')",
  bools.get('RequireManagerApprovalForVoid') === '0');

const both = map({ name: 'first', CompanyName: 'second' });
check('payload naming both spellings resolves to ONE value (no conflicting rows)',
  both.get('CompanyName') === both.get('name'));

const pass = map({ VATRate: '5', receiptFooter: 'شكرًا لزيارتكم' });
check('unrelated keys pass through unchanged',
  pass.get('VATRate') === '5' && pass.get('receiptFooter') === 'شكرًا لزيارتكم');

check(`${_f === 0 ? '✅' : '❌'} settingsKeys: ${_p} passed, ${_f} failed`, _f === 0);
process.exit(_f === 0 ? 0 : 1);
