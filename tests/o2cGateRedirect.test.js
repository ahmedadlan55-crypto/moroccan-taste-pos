'use strict';
/*
 * o2cGateRedirect.test.js — the 409 gate must point at a screen that can
 * actually perform the reversal.
 *
 * Regression guard: server.js mounts saleReverseGate('/sales'), a pre-cutover
 * path. The standalone Sales SPA was retired and /sales/* now 302s to
 * /app/sales/orders — the ORDERS list, which cannot reverse anything. A cashier
 * whose void was refused was therefore sent to a dead end. The gate heals the
 * retired value to the real returns route.
 *
 * Run: node tests/o2cGateRedirect.test.js   (no DB, no server)
 */
const { _dest, RETURNS_ROUTE } = require('../middleware/o2cLegacyGate');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

console.log('\n═══ O2C legacy gate — redirect destination ═══\n');

check('the retired /sales heals to the returns route', _dest('/sales') === RETURNS_ROUTE, _dest('/sales'));
check('RETURNS_ROUTE points at the live ERP returns screen', RETURNS_ROUTE === '/app/sales/returns', RETURNS_ROUTE);
check('it never resolves to the orders list', _dest('/sales') !== '/app/sales/orders', _dest('/sales'));
check('the retired /sales/invoices also heals', _dest('/sales/invoices') === RETURNS_ROUTE, _dest('/sales/invoices'));
check('empty / missing destination heals', _dest('') === RETURNS_ROUTE && _dest(undefined) === RETURNS_ROUTE);
check('an explicit live destination is respected, not overridden',
  _dest('/app/sales/credit-notes') === '/app/sales/credit-notes', _dest('/app/sales/credit-notes'));
check('whitespace is tolerated', _dest('  /sales  ') === RETURNS_ROUTE, _dest('  /sales  '));

console.log(`\no2cGateRedirect: ${_p} passed, ${_f} failed\n`);
process.exit(_f ? 1 : 0);
