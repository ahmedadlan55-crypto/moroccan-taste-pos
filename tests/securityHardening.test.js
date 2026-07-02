/**
 * Phase 5A (RC) — security hardening unit tests (pure, no DB).
 * Run: node tests/securityHardening.test.js
 * Covers: logger secret redaction, the v2 mutation rate-limit window, and the
 * FEFO planner's exclusion of quarantined/recalled/expired lots (chokepoint lock).
 */
'use strict';
const logger = require('../lib/logger');
const rl = require('../lib/v2RateLimit');
const L = require('../lib/lotLedger');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

console.log('\n═══ RC security hardening ═══\n');

console.log('─── logger.redact (secrets never reach logs) ───');
test('redacts authorization / token / password / jwt / secret / totp keys', () => {
  const out = logger.redact({
    authorization: 'Bearer abc.def.ghi', token: 't', password: 'p', jwt: 'x',
    secret: 's', totp: '123456', refresh_token: 'r', apiKey: 'k', keep: 'visible',
  });
  eq(out.authorization, '[REDACTED]'); eq(out.token, '[REDACTED]'); eq(out.password, '[REDACTED]');
  eq(out.jwt, '[REDACTED]'); eq(out.secret, '[REDACTED]'); eq(out.totp, '[REDACTED]');
  eq(out.refresh_token, '[REDACTED]'); eq(out.apiKey, '[REDACTED]'); eq(out.keep, 'visible');
});
test('redacts nested + array structures', () => {
  const out = logger.redact({ a: { b: { password: 'p', ok: 1 } }, list: [{ token: 't' }] });
  eq(out.a.b.password, '[REDACTED]'); eq(out.a.b.ok, 1); eq(out.list[0].token, '[REDACTED]');
});
test('scrubs Bearer tokens + JWT blobs inside string values', () => {
  const out = logger.redact({ msg: 'auth=Bearer aaa.bbb.ccc done', blob: 'eyJhbGciOiJ' + 'A'.repeat(40) });
  ok(out.msg.indexOf('[REDACTED]') !== -1 && out.msg.indexOf('aaa.bbb.ccc') === -1, 'bearer not scrubbed');
  ok(out.blob.indexOf('[REDACTED_JWT]') !== -1, 'jwt blob not scrubbed');
});
test('preserves Error shape (message+stack) while scrubbing', () => {
  const e = new Error('login failed token=Bearer zzz.yyy.xxx'); e.code = 'X';
  const out = logger.redact({ err: e });
  eq(out.err.name, 'Error'); eq(out.err.code, 'X');
  ok(out.err.message.indexOf('zzz.yyy.xxx') === -1, 'error message not scrubbed');
  ok(typeof out.err.stack === 'string', 'stack preserved');
});
test('logger.info does not throw with redaction wrapper (string + object)', () => {
  logger.info('plain message');
  logger.info({ event: 'test', password: 'p' }, 'with ctx');
  const child = logger.child({ module: 'rc-test', secret: 's' });
  child.warn({ x: 1 }, 'child ok');
  ok(true);
});

console.log('\n─── v2RateLimit.check (sliding window) ───');
test('allows up to max then limits', () => {
  const store = new Map();
  const now = 1000;
  for (let i = 1; i <= 3; i++) { const v = rl.check(store, 'u', now, 60000, 3); ok(!v.limited, 'call ' + i + ' should pass'); }
  const v4 = rl.check(store, 'u', now, 60000, 3);
  ok(v4.limited, '4th should be limited'); ok(v4.retryAfterMs > 0, 'retryAfter set');
});
test('window reset re-allows after windowMs', () => {
  const store = new Map();
  rl.check(store, 'u', 0, 1000, 1);
  ok(rl.check(store, 'u', 500, 1000, 1).limited, 'still in window → limited');
  ok(!rl.check(store, 'u', 1500, 1000, 1).limited, 'after window → allowed');
});
test('per-user isolation (different keys do not share budget)', () => {
  const store = new Map();
  rl.check(store, 'a', 0, 60000, 1);
  ok(!rl.check(store, 'b', 0, 60000, 1).limited, 'user b independent');
});
test('max<=0 disables limiting', () => {
  const store = new Map();
  for (let i = 0; i < 50; i++) ok(!rl.check(store, 'u', 0, 60000, 0).limited);
});

console.log('\n─── planFefo excludes quarantined / recalled / expired (chokepoint) ───');
const NOW = new Date('2026-06-30T12:00:00+03:00');
const lots = [
  { lotId: 'A', qty: 10, expiryDate: '2026-07-10', receivedAt: '2026-06-01', lifecycleStatus: 'active' },
  { lotId: 'Q', qty: 99, expiryDate: '2026-07-05', receivedAt: '2026-06-02', lifecycleStatus: 'quarantined' },
  { lotId: 'R', qty: 99, expiryDate: '2026-07-06', receivedAt: '2026-06-02', lifecycleStatus: 'recalled' },
  { lotId: 'X', qty: 99, expiryDate: '2020-01-01', receivedAt: '2026-06-03', lifecycleStatus: 'active' }, // expired
  { lotId: 'B', qty: 5, expiryDate: '2026-08-01', receivedAt: '2026-06-04', lifecycleStatus: 'active' },
];
test('FEFO picks only active+unexpired, earliest-expiry first', () => {
  const plan = L.planFefo(lots, 12, { mode: 'expiry', now: NOW });
  eq(plan.allocations.length, 2, 'two lots allocated');
  eq(plan.allocations[0].lotId, 'A'); eq(plan.allocations[0].qty, 10);
  eq(plan.allocations[1].lotId, 'B'); eq(plan.allocations[1].qty, 2);
  eq(plan.shortfall, 0);
  ok(plan.skipped.blocked >= 198, 'quarantined+recalled counted as blocked');
  ok(plan.skipped.expired >= 99, 'expired counted as skipped');
});
test('quarantined/recalled/expired never appear in allocation', () => {
  const plan = L.planFefo(lots, 999, { mode: 'expiry', now: NOW });
  const ids = plan.allocations.map((a) => a.lotId);
  ok(ids.indexOf('Q') === -1 && ids.indexOf('R') === -1 && ids.indexOf('X') === -1, 'blocked lot leaked into allocation');
  eq(plan.totalAvailable, 15, 'only active+unexpired counted as available');
});

console.log('\n═══ ' + _p + ' passed, ' + _f + ' failed ═══\n');
process.exit(_f ? 1 : 0);
