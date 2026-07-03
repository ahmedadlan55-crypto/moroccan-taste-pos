/**
 * Unit tests for lib/negativeStockPolicy (W2). Pure, no DB.
 * Run: node tests/negativeStockPolicy.test.js
 */
'use strict';
const N = require('../lib/negativeStockPolicy');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name, '\n     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

console.log('\n═══ negative-stock policy (W2) — unit ═══\n');

console.log('─── resolvePolicy: level precedence + tracked lockdown ───');
test('no config anywhere → default block', () => {
  const r = N.resolvePolicy({ item: { tracking_mode: 'none' } });
  eq(r.effectivePolicy, 'block');
  eq(r.effectiveMaxNegative, 0);
});
test('tracked item ignores every level, always block', () => {
  const r = N.resolvePolicy({ item: { tracking_mode: 'lot' }, globalCfg: { policy: 'allow', is_enabled: 1, max_negative_qty: 10 }, itemCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 5 } });
  eq(r.effectivePolicy, 'block');
  eq(r.reason, 'tracked-item');
});
test('most restrictive wins (block > controlled > allow)', () => {
  eq(N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 5 }, whCfg: { policy: 'block', is_enabled: 1, max_negative_qty: 999 } }).effectivePolicy, 'block');
  eq(N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'allow', is_enabled: 1, max_negative_qty: 100 }, itemCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 5 } }).effectivePolicy, 'controlled');
});
test('disabled config row is ignored', () => {
  const r = N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'controlled', is_enabled: 0, max_negative_qty: 10 } });
  eq(r.effectivePolicy, 'block');
});
test('effective maxNegative = smallest defined in winning tier', () => {
  const r = N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 20 }, whCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 5 } });
  eq(r.effectivePolicy, 'controlled');
  eq(r.effectiveMaxNegative, 5);
});
test('allow without env flag degrades to controlled + sets allowGated', () => {
  delete process.env.NEGATIVE_STOCK_ALLOW_ENABLED;
  const r = N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'allow', is_enabled: 1, max_negative_qty: 100 } });
  eq(r.effectivePolicy, 'controlled');
  eq(r.allowGated, true);
});
test('allow WITH env flag stays allow', () => {
  process.env.NEGATIVE_STOCK_ALLOW_ENABLED = '1';
  const r = N.resolvePolicy({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'allow', is_enabled: 1, max_negative_qty: 100 } });
  eq(r.effectivePolicy, 'allow');
  eq(r.allowGated, false);
  delete process.env.NEGATIVE_STOCK_ALLOW_ENABLED;
});

console.log('\n─── evaluateIssue: gates ───');
const anyResolved = (policy, max) => ({ effectivePolicy: policy, effectiveMaxNegative: max, reason: 'resolved', allowGated: false });
const REQ = (over) => Object.assign({ oldQty: 5, qtyDelta: -10, newQty: -5, user: { role: 'manager' }, reason: 'شطب', acknowledgeNegative: true }, over || {});

test('newQty≥0 → proceed regardless of policy', () => {
  eq(N.evaluateIssue({ resolved: anyResolved('block', 0), request: REQ({ newQty: 3 }) }).verdict, 'proceed');
  eq(N.evaluateIssue({ resolved: anyResolved('controlled', 5), request: REQ({ newQty: 0 }) }).verdict, 'proceed');
});
test('block: any newQty<0 → deny INSUFFICIENT_STOCK', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('block', 0), request: REQ({ newQty: -1 }) });
  eq(r.verdict, 'deny'); eq(r.code, 'INSUFFICIENT_STOCK');
});
test('controlled: missing role → forbidden_role', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 100), request: REQ({ user: { role: 'cashier' } }) });
  eq(r.code, 'forbidden_role');
});
test('controlled: missing reason → REASON_REQUIRED', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 100), request: REQ({ reason: '   ' }) });
  eq(r.code, 'REASON_REQUIRED');
});
test('controlled: no ack → NEGATIVE_CONFIRMATION_REQUIRED', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 100), request: REQ({ acknowledgeNegative: false }) });
  eq(r.code, 'NEGATIVE_CONFIRMATION_REQUIRED');
});
test('controlled: exceeds max → NEGATIVE_LIMIT_EXCEEDED', () => {
  // newQty=-30, max=25 → deny
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 25), request: REQ({ newQty: -30 }) });
  eq(r.code, 'NEGATIVE_LIMIT_EXCEEDED');
});
test('controlled: within max → deficit', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 100), request: REQ({ newQty: -50 }) });
  eq(r.verdict, 'deficit');
});
test('allow: non-developer → ALLOW_REQUIRES_DEVELOPER', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('allow', Infinity), request: REQ({ user: { role: 'admin', isDeveloper: false } }) });
  eq(r.code, 'ALLOW_REQUIRES_DEVELOPER');
});
test('allow with developer → deficit (no limit)', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('allow', Infinity), request: REQ({ user: { role: 'developer', isDeveloper: true }, newQty: -9999 }) });
  eq(r.verdict, 'deficit');
});
test('maker=checker (Maker-Checker enabled) → deny', () => {
  const r = N.evaluateIssue({ resolved: anyResolved('controlled', 100), request: REQ({ user: { role: 'manager' }, makerChecker: { creator: 'u1', poster: 'u1' } }) });
  eq(r.code, 'MAKER_CHECKER_SELF_APPROVAL');
});

console.log('\n─── decide: end-to-end resolve+evaluate ───');
test('lot item + controlled config → block (BR-1) → INSUFFICIENT_STOCK', () => {
  const r = N.decide({ item: { tracking_mode: 'lot' }, globalCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 999 }, request: REQ({ user: { role: 'admin' }, newQty: -1 }) });
  eq(r.outcome.code, 'INSUFFICIENT_STOCK');
});
test('untracked + controlled(5) + admin + ack + reason + newQty=-3 → deficit', () => {
  const r = N.decide({ item: { tracking_mode: 'none' }, globalCfg: { policy: 'controlled', is_enabled: 1, max_negative_qty: 5 }, request: REQ({ user: { role: 'admin' }, newQty: -3 }) });
  eq(r.outcome.verdict, 'deficit');
});

console.log(`\n${_f === 0 ? '✅' : '❌'} negativeStockPolicy: ${_p} passed, ${_f} failed\n`);
if (_f > 0) process.exit(1);
