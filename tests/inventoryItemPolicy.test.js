/**
 * Phase 4B — inventory item lifecycle policy unit tests (pure).
 * Run: node tests/inventoryItemPolicy.test.js
 * Covers the central inactive-item policy: inflow blocked, liquidation outflow
 * allowed WITH a reason, reversal always allowed.
 */
'use strict';
const P = require('../lib/inventoryItemPolicy');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function throwsV(fn, msg) { let code = null; try { fn(); } catch (e) { code = e.code; } if (code !== 'VALIDATION_ERROR') throw new Error((msg || 'expected VALIDATION_ERROR') + ', got ' + code); }
function noThrow(fn, msg) { try { fn(); } catch (e) { throw new Error((msg || 'unexpected throw') + ': ' + e.message); } }

const active = { id: 'I1', name: 'صنف نشط', active: 1, deleted_at: null };
const inactive = { id: 'I2', name: 'صنف معطّل', active: 0, deleted_at: null };
const deleted = { id: 'I3', name: 'محذوف', active: 1, deleted_at: '2026-01-01' };

console.log('\n═══ inventory item policy ═══\n');

console.log('─── isInactive ───');
test('active item → not inactive', () => ok(P.isInactive(active) === false));
test('active=0 → inactive', () => ok(P.isInactive(inactive) === true));
test('soft-deleted → inactive', () => ok(P.isInactive(deleted) === true));
test('null item → treated inactive (defensive)', () => ok(P.isInactive(null) === true));

console.log('\n─── assertInflowAllowed ───');
test('active inflow allowed', () => noThrow(() => P.assertInflowAllowed(active)));
test('inactive inflow blocked', () => throwsV(() => P.assertInflowAllowed(inactive)));
test('soft-deleted inflow blocked', () => throwsV(() => P.assertInflowAllowed(deleted)));

console.log('\n─── assertOutflowAllowed ───');
test('active outflow allowed (no reason needed)', () => noThrow(() => P.assertOutflowAllowed(active, {})));
test('inactive outflow WITHOUT reason blocked', () => throwsV(() => P.assertOutflowAllowed(inactive, {})));
test('inactive outflow WITH reason allowed (liquidation)', () => noThrow(() => P.assertOutflowAllowed(inactive, { reason: 'تصفية رصيد' })));
test('inactive outflow as REVERSAL always allowed (no reason)', () => noThrow(() => P.assertOutflowAllowed(inactive, { isReversal: true })));

console.log('\n─── assertLegacyInbound (Phase 4B gate for legacy inbound) ───');
const trackedActive = { id: 'I4', name: 'مُتتبع', active: 1, deleted_at: null, tracking_mode: 'expiry' };
const lotActive = { id: 'I5', name: 'دفعة', active: 1, deleted_at: null, tracking_mode: 'lot' };
const plainActive = { id: 'I6', name: 'عادي', active: 1, deleted_at: null, tracking_mode: 'none' };
function throwsCode(fn, code) { let c = null; try { fn(); } catch (e) { c = e.code; } if (c !== code) throw new Error('expected ' + code + ', got ' + c); }
test('legacy inbound of a tracked (expiry) item → WRITER_NOT_LOT_AWARE', () => throwsCode(() => P.assertLegacyInbound(trackedActive), 'WRITER_NOT_LOT_AWARE'));
test('legacy inbound of a tracked (lot) item → WRITER_NOT_LOT_AWARE', () => throwsCode(() => P.assertLegacyInbound(lotActive), 'WRITER_NOT_LOT_AWARE'));
test('legacy inbound of an inactive item → VALIDATION_ERROR', () => throwsCode(() => P.assertLegacyInbound(inactive), 'VALIDATION_ERROR'));
test('legacy inbound of a plain active item → allowed', () => noThrow(() => P.assertLegacyInbound(plainActive)));

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
