/**
 * Phase 5C — canary allow-list unit tests (pure, no DB/server).
 * Run: node tests/v2Canary.test.js
 * Covers: env-list parsing, the isAllowed verdict (unset=open, '*'=full open,
 * username/role matching case-insensitively, fail-closed on missing user),
 * and the middleware verdicts via a fake req/res.
 */
'use strict';
const C = require('../lib/v2Canary');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

console.log('\n═══ v2 canary allow-list (5C) ═══\n');

console.log('─── parseList ───');
test('splits, trims, lowercases, drops empties', () => {
  eq(JSON.stringify(C.parseList(' Admin, uat_Manager ,,  ')), JSON.stringify(['admin', 'uat_manager']));
  eq(JSON.stringify(C.parseList(undefined)), JSON.stringify([]));
  eq(JSON.stringify(C.parseList('')), JSON.stringify([]));
});

console.log('\n─── isAllowed verdicts ───');
const L = (users, roles) => ({ users: C.parseList(users), roles: C.parseList(roles) });
test('both lists empty → canary OFF → everyone allowed (even no user)', () => {
  eq(C.isAllowed({ username: 'x', role: 'cashier' }, L('', '')), true);
  eq(C.isAllowed(null, L('', '')), true);
});
test('"*" in either list → full open', () => {
  eq(C.isAllowed({ username: 'x', role: 'cashier' }, L('*', '')), true);
  eq(C.isAllowed({ username: 'x', role: 'cashier' }, L('', '*')), true);
  eq(C.isAllowed(null, L('*', '')), true);
});
test('username match is case-insensitive', () => {
  eq(C.isAllowed({ username: 'AdMiN', role: 'cashier' }, L('admin', '')), true);
  eq(C.isAllowed({ username: 'other', role: 'cashier' }, L('admin', '')), false);
});
test('role match is case-insensitive and OR-combined with users', () => {
  eq(C.isAllowed({ username: 'x', role: 'Manager' }, L('', 'manager')), true);
  eq(C.isAllowed({ username: 'x', role: 'cashier' }, L('admin', 'manager')), false);
  eq(C.isAllowed({ username: 'admin', role: 'cashier' }, L('admin', 'manager')), true);
});
test('active canary + missing/blank user → fail-closed', () => {
  eq(C.isAllowed(null, L('admin', '')), false);
  eq(C.isAllowed({}, L('admin', '')), false);
  eq(C.isAllowed({ username: '', role: '' }, L('admin', 'manager')), false);
});

console.log('\n─── middleware (env not set in this process → pass-through) ───');
test('module-level config reflects unset env → OFF, middleware calls next()', () => {
  eq(C.config.ACTIVE, false, 'canary must be OFF in the unit-test process');
  let nexted = false, statused = 0;
  const res = { status: (s) => { statused = s; return { json: () => {} }; } };
  C({ user: null }, res, () => { nexted = true; });
  eq(nexted, true); eq(statused, 0);
});

console.log(`\n${_f === 0 ? '✅' : '❌'} v2Canary: ${_p} passed, ${_f} failed\n`);
if (_f > 0) process.exit(1);
