/**
 * Business-day computation — pure-function tests (no DB).
 * Run: node tests/analyticsBusinessDay.test.js
 *
 * The contract under test:
 *   - a DB DATETIME string is Riyadh WALL-CLOCK (+03:00 session, no DST) and
 *     is converted to a UTC instant before formatting in the target tz;
 *   - a Date input is an instant and is used as-is;
 *   - formatting is DST-correct via ICU (Europe/London spring/fall cases);
 *   - business_day = local date, minus 1 when local time is STRICTLY before
 *     day_close_time; exactly-at-close belongs to the new day; a 00:00 close
 *     means business day === calendar day always.
 *
 * DST reference facts (Europe/London 2026): BST begins 2026-03-29 01:00 UTC
 * (clocks jump 01:00→02:00 local), ends 2026-10-25 01:00 UTC (02:00 BST →
 * 01:00 GMT).
 */
'use strict';

const B = require('../lib/analytics/businessDay');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function throws(fn, msg) {
  let t = false;
  try { fn(); } catch (e) { t = true; }
  if (!t) throw new Error('expected throw: ' + (msg || ''));
}

console.log('\n── Riyadh wall-clock string input ──');
test('a DB string round-trips through the fixed +03:00 offset', () => {
  const r = B.computeLocal('2026-07-24 13:45:10', 'Asia/Riyadh', '04:00:00');
  eq(r.occurredAtLocal, '2026-07-24 13:45:10');
  eq(r.businessDay, '2026-07-24');
});
test('01:30 with a 04:00 close belongs to YESTERDAY', () => {
  const r = B.computeLocal('2026-07-24 01:30:00', 'Asia/Riyadh', '04:00:00');
  eq(r.occurredAtLocal, '2026-07-24 01:30:00');
  eq(r.businessDay, '2026-07-23');
});
test('one second before close → yesterday; exactly at close → today', () => {
  eq(B.computeLocal('2026-07-24 03:59:59', 'Asia/Riyadh', '04:00:00').businessDay, '2026-07-23');
  eq(B.computeLocal('2026-07-24 04:00:00', 'Asia/Riyadh', '04:00:00').businessDay, '2026-07-24');
});
test('day_close 00:00 → business day is always the calendar day', () => {
  eq(B.computeLocal('2026-07-24 00:00:00', 'Asia/Riyadh', '00:00:00').businessDay, '2026-07-24');
  eq(B.computeLocal('2026-07-24 23:59:59', 'Asia/Riyadh', '00:00:00').businessDay, '2026-07-24');
  eq(B.computeLocal('2026-07-24 00:00:01', 'Asia/Riyadh', '00:00:00').businessDay, '2026-07-24');
});
test('month boundary: 02:00 on March 1 rolls back to February 28 (2026 is not leap)', () => {
  eq(B.computeLocal('2026-03-01 02:00:00', 'Asia/Riyadh', '04:00:00').businessDay, '2026-02-28');
});
test('leap-year boundary: 02:00 on 2028-03-01 rolls back to February 29', () => {
  eq(B.computeLocal('2028-03-01 02:00:00', 'Asia/Riyadh', '04:00:00').businessDay, '2028-02-29');
});
test('year boundary: 01:00 on Jan 1 belongs to Dec 31', () => {
  eq(B.computeLocal('2026-01-01 01:00:00', 'Asia/Riyadh', '04:00:00').businessDay, '2025-12-31');
});

console.log('\n── Date (instant) input ──');
test('a UTC Date is shifted +03:00 for Riyadh', () => {
  const r = B.computeLocal(new Date('2026-07-23T22:30:00Z'), 'Asia/Riyadh', '04:00:00');
  eq(r.occurredAtLocal, '2026-07-24 01:30:00');
  eq(r.businessDay, '2026-07-23');
});
test('midnight UTC renders 03:00 Riyadh, still yesterday under 04:00 close', () => {
  const r = B.computeLocal(new Date('2026-07-24T00:00:00Z'), 'Asia/Riyadh', '04:00:00');
  eq(r.occurredAtLocal, '2026-07-24 03:00:00');
  eq(r.businessDay, '2026-07-23');
});

console.log('\n── Europe/London DST spring forward (2026-03-29 01:00 UTC) ──');
test('just before the jump: 00:59 UTC is 00:59 GMT local', () => {
  const r = B.computeLocal(new Date('2026-03-29T00:59:00Z'), 'Europe/London', '04:00:00');
  eq(r.occurredAtLocal, '2026-03-29 00:59:00');
  eq(r.businessDay, '2026-03-28');
});
test('inside the skipped hour: 01:30 UTC renders 02:30 BST', () => {
  const r = B.computeLocal(new Date('2026-03-29T01:30:00Z'), 'Europe/London', '04:00:00');
  eq(r.occurredAtLocal, '2026-03-29 02:30:00');
  eq(r.businessDay, '2026-03-28', 'still before the 04:00 close');
});
test('after close on the spring-forward day: 03:30 UTC = 04:30 BST → new day', () => {
  const r = B.computeLocal(new Date('2026-03-29T03:30:00Z'), 'Europe/London', '04:00:00');
  eq(r.occurredAtLocal, '2026-03-29 04:30:00');
  eq(r.businessDay, '2026-03-29');
});

console.log('\n── Europe/London DST fall back (2026-10-25 01:00 UTC) ──');
test('before the fold: 00:30 UTC is 01:30 BST', () => {
  const r = B.computeLocal(new Date('2026-10-25T00:30:00Z'), 'Europe/London', '04:00:00');
  eq(r.occurredAtLocal, '2026-10-25 01:30:00');
  eq(r.businessDay, '2026-10-24');
});
test('after the fold: 01:30 UTC is ALSO 01:30 local (now GMT) — same business day', () => {
  const r = B.computeLocal(new Date('2026-10-25T01:30:00Z'), 'Europe/London', '04:00:00');
  eq(r.occurredAtLocal, '2026-10-25 01:30:00');
  eq(r.businessDay, '2026-10-24');
});

console.log('\n── cross-timezone rendering of Riyadh-stored DATETIMEs ──');
test('winter: 12:00 Riyadh renders 09:00 in London (GMT)', () => {
  eq(B.computeLocal('2026-01-15 12:00:00', 'Europe/London', '04:00:00').occurredAtLocal, '2026-01-15 09:00:00');
});
test('summer: 12:00 Riyadh renders 10:00 in London (BST)', () => {
  eq(B.computeLocal('2026-07-15 12:00:00', 'Europe/London', '04:00:00').occurredAtLocal, '2026-07-15 10:00:00');
});

console.log('\n── input validation ──');
test('garbage input throws instead of poisoning downstream days', () => {
  throws(() => B.computeLocal('not a date', 'Asia/Riyadh', '04:00:00'));
  throws(() => B.computeLocal(new Date('invalid'), 'Asia/Riyadh', '04:00:00'));
  throws(() => B.computeLocal('2026-07-24 10:00:00', 'Asia/Riyadh', 'bogus'));
});

console.log('\n── nextRunAt ──');
test('daily: later today when the local fire time has not passed', () => {
  // now = 08:00 Riyadh; daily at 09:00 Riyadh = 06:00 UTC.
  const next = B.nextRunAt(
    { freq: 'daily', at_time: '09:00:00', timezone: 'Asia/Riyadh' },
    new Date('2026-07-24T05:00:00Z'));
  eq(next.toISOString(), '2026-07-24T06:00:00.000Z');
});
test('daily: exactly at the fire instant → strictly after → tomorrow', () => {
  const next = B.nextRunAt(
    { freq: 'daily', at_time: '09:00:00', timezone: 'Asia/Riyadh' },
    new Date('2026-07-24T06:00:00.000Z'));
  eq(next.toISOString(), '2026-07-25T06:00:00.000Z');
});
test('weekly: fires on the requested weekday (5 = Friday; 2026-07-24 is a Friday)', () => {
  const next = B.nextRunAt(
    { freq: 'weekly', at_time: '07:00:00', weekday: 5, timezone: 'Asia/Riyadh' },
    new Date('2026-07-24T00:00:00Z'));
  eq(next.toISOString(), '2026-07-24T04:00:00.000Z');
});
test('weekly: a passed fire time rolls to the SAME weekday next week', () => {
  const next = B.nextRunAt(
    { freq: 'weekly', at_time: '07:00:00', weekday: 5, timezone: 'Asia/Riyadh' },
    new Date('2026-07-24T05:00:00Z'));
  eq(next.toISOString(), '2026-07-31T04:00:00.000Z');
});
test('monthly: month_day 31 clamps to the last day of a short month', () => {
  const next = B.nextRunAt(
    { freq: 'monthly', at_time: '10:00:00', month_day: 31, timezone: 'Asia/Riyadh' },
    new Date('2026-02-10T00:00:00Z'));
  eq(next.toISOString(), '2026-02-28T07:00:00.000Z', '2026-02 has 28 days');
});
test('monthly: a passed month_day rolls to next month', () => {
  const next = B.nextRunAt(
    { freq: 'monthly', at_time: '10:00:00', month_day: 15, timezone: 'Asia/Riyadh' },
    new Date('2026-07-20T00:00:00Z'));
  eq(next.toISOString(), '2026-08-15T07:00:00.000Z');
});
test('daily across a London spring-forward: the UTC instant shifts with the offset', () => {
  // 09:00 London on 2026-03-28 is 09:00 UTC (GMT); on 2026-03-29 it is 08:00 UTC (BST).
  const next = B.nextRunAt(
    { freq: 'daily', at_time: '09:00:00', timezone: 'Europe/London' },
    new Date('2026-03-28T12:00:00Z'));
  eq(next.toISOString(), '2026-03-29T08:00:00.000Z');
});
test('nextRunAt validates its inputs', () => {
  throws(() => B.nextRunAt(null, new Date()));
  throws(() => B.nextRunAt({ freq: 'daily', at_time: '09:00' }, new Date('invalid')));
});

console.log(`\nBusiness day: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
