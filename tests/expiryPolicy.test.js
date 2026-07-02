/**
 * Phase 4B — expiry policy unit tests (pure, date-only, Asia/Riyadh).
 * Run: node tests/expiryPolicy.test.js
 */
'use strict';
const E = require('../lib/expiryPolicy');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

// Fixed "now": 2026-06-30 11:00 Riyadh (08:00 UTC).
const NOW = new Date('2026-06-30T08:00:00Z');
const TH = { critical: 7, warning: 30, receiptMin: 30 };

console.log('\n═══ Expiry policy ═══\n');

console.log('─── ymd + Riyadh calendar ───');
test('ymd passes through a date string', () => eq(E.ymd('2026-07-15'), '2026-07-15'));
test('ymd of a UTC instant → Riyadh date', () => eq(E.ymd(new Date('2026-06-30T22:30:00Z')), '2026-07-01')); // 01:30 Riyadh next day
test('todayYmd(NOW) → 2026-06-30', () => eq(E.todayYmd(NOW), '2026-06-30'));
test('ymd(null) → null', () => eq(E.ymd(null), null));

console.log('\n─── daysUntil (date-only, no clock dependence) ───');
test('10 days ahead', () => eq(E.daysUntil('2026-07-10', NOW), 10));
test('5 days past → negative', () => eq(E.daysUntil('2026-06-25', NOW), -5));
test('same day → 0', () => eq(E.daysUntil('2026-06-30', NOW), 0));
test('clock time does not shift the calendar day (23:00 Riyadh)', () => eq(E.daysUntil('2026-07-01', new Date('2026-06-30T20:00:00Z')), 1));
test('crossing Riyadh midnight rolls the day (00:30 Riyadh)', () => eq(E.daysUntil('2026-07-01', new Date('2026-06-30T21:30:00Z')), 0));

console.log('\n─── classify ───');
test('no expiry → none', () => eq(E.classify(null, NOW, { thresholds: TH }), 'none'));
test('past → expired', () => eq(E.classify('2026-06-29', NOW, { thresholds: TH }), 'expired'));
test('today → critical (not yet expired)', () => eq(E.classify('2026-06-30', NOW, { thresholds: TH }), 'critical'));
test('≤ critical days → critical', () => eq(E.classify('2026-07-07', NOW, { thresholds: TH }), 'critical'));
test('between critical and warning → warning', () => eq(E.classify('2026-07-20', NOW, { thresholds: TH }), 'warning'));
test('= warning boundary → warning', () => eq(E.classify('2026-07-30', NOW, { thresholds: TH }), 'warning'));
test('beyond warning → safe', () => eq(E.classify('2026-08-15', NOW, { thresholds: TH }), 'safe'));

console.log('\n─── receiptCheck ───');
test('already expired → blocked', () => eq(E.receiptCheck('2026-06-29', NOW, { thresholds: TH }), { ok: false, level: 'expired', daysUntil: -1 }));
test('near expiry (< receiptMin) → allowed but flagged', () => eq(E.receiptCheck('2026-07-10', NOW, { thresholds: TH }), { ok: true, level: 'near', daysUntil: 10 }));
test('comfortable expiry → ok', () => eq(E.receiptCheck('2026-08-15', NOW, { thresholds: TH }), { ok: true, level: 'ok', daysUntil: 46 }));
test('no expiry → ok (lot mode optional)', () => eq(E.receiptCheck(null, NOW, { thresholds: TH }), { ok: true, level: 'ok', daysUntil: null }));

console.log('\n─── isExpired ───');
test('past → true', () => eq(E.isExpired('2026-06-01', NOW), true));
test('future → false', () => eq(E.isExpired('2026-07-01', NOW), false));
test('no expiry → false', () => eq(E.isExpired(null, NOW), false));

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
