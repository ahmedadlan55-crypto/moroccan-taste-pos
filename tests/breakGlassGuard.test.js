#!/usr/bin/env node
/**
 * The break-glass guard on POST /gl/coa/wipe-and-seed.
 *
 * That endpoint DELETEs gl_entries, gl_journals, sales, sales_items,
 * purchases, expenses, inventory_movements, payments and vat_reports — the
 * whole ledger and the whole sales history — and it was reachable over HTTP
 * with a capability every accountant holds plus a confirm phrase sent in the
 * same request that does the deleting.
 *
 * These are behavioural tests on the guard itself plus a static test that the
 * route is actually wrapped in it. The static half matters: a perfectly good
 * guard protects nothing if a later edit drops it from the route.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { guardBreakGlass, isProductionRuntime } = require('../lib/transactionGuards');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✅ ' + name); passed++; }
  catch (e) { console.log('  ❌ ' + name + '\n       ' + e.message); failed++; }
}

// Minimal express-ish doubles.
function run(guard, req) {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let nexted = false;
  guard(req || {}, res, () => { nexted = true; });
  return { ...res, nexted };
}

const ENV_KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'ALLOW_COA_WIPE'];
const saved = {};
function withEnv(vars, fn) {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.entries(vars).forEach(([k, v]) => { process.env[k] = v; });
  try { return fn(); }
  finally {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

console.log('\n▶ production is refused, whatever the request says');

check('NODE_ENV=production → 410, never runs', () => {
  const r = withEnv({ NODE_ENV: 'production' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.statusCode, 410);
  assert.strictEqual(r.body.code, 'BREAK_GLASS_DISABLED_IN_PRODUCTION');
  assert.strictEqual(r.nexted, false, 'the handler must not be reached');
});

check('ALLOW_COA_WIPE=1 does NOT unlock production', () => {
  const r = withEnv({ NODE_ENV: 'production', ALLOW_COA_WIPE: '1' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.statusCode, 410, 'an env flag must not re-open production');
  assert.strictEqual(r.nexted, false);
});

check('no request-side override re-enables it — body, query or header', () => {
  // The whole point: anything the caller can send, an attacker can send too.
  const req = {
    body: { confirmPhrase: 'WIPE-COA-CONFIRMED', force: true, allowWipe: true, ALLOW_COA_WIPE: '1' },
    query: { force: '1', allowWipe: '1' },
    headers: { 'x-allow-coa-wipe': '1', 'x-force': 'true' },
    user: { username: 'admin', role: 'admin', isAdmin: true },
  };
  const r = withEnv({ NODE_ENV: 'production' }, () => run(guardBreakGlass('op'), req));
  assert.strictEqual(r.statusCode, 410);
  assert.strictEqual(r.nexted, false);
});

check('RAILWAY_ENVIRONMENT alone is enough, even with NODE_ENV unset', () => {
  // A missing NODE_ENV on the live host must not downgrade this to "dev".
  const r = withEnv({ RAILWAY_ENVIRONMENT: 'production' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.statusCode, 410);
});

check('RAILWAY_SERVICE_ID alone is enough', () => {
  const r = withEnv({ RAILWAY_SERVICE_ID: 'svc-123' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.statusCode, 410);
});

console.log('\n▶ outside production it is still armed, not open');

check('development without ALLOW_COA_WIPE → 403, not a silent pass', () => {
  const r = withEnv({ NODE_ENV: 'development' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(r.body.code, 'BREAK_GLASS_NOT_ARMED');
  assert.strictEqual(r.nexted, false);
});

check('ALLOW_COA_WIPE=0 / "true" / "yes" do not arm it — only "1"', () => {
  for (const v of ['0', 'true', 'yes', 'TRUE', '']) {
    const r = withEnv({ NODE_ENV: 'development', ALLOW_COA_WIPE: v }, () => run(guardBreakGlass('op')));
    assert.strictEqual(r.statusCode, 403, `ALLOW_COA_WIPE=${JSON.stringify(v)} must not arm it`);
  }
});

check('development WITH ALLOW_COA_WIPE=1 → passes through', () => {
  const r = withEnv({ NODE_ENV: 'development', ALLOW_COA_WIPE: '1' }, () => run(guardBreakGlass('op')));
  assert.strictEqual(r.nexted, true);
  assert.strictEqual(r.statusCode, null, 'no response should be written when it passes');
});

check('the op name reaches the caller so the error says what was blocked', () => {
  const r = withEnv({ NODE_ENV: 'production' }, () => run(guardBreakGlass('محو دليل الحسابات')));
  assert.ok(String(r.body.error).includes('محو دليل الحسابات'), r.body.error);
});

console.log('\n▶ the route is actually wrapped (a guard nobody applied protects nothing)');

const erpSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'erp.js'), 'utf8');

check('wipe-and-seed is registered with guardBreakGlass', () => {
  const m = erpSrc.match(/router\.post\(\s*'\/gl\/coa\/wipe-and-seed'[\s\S]{0,240}/);
  assert.ok(m, 'the wipe-and-seed route registration was not found at all');
  assert.ok(/guardBreakGlass\(/.test(m[0]),
    'wipe-and-seed no longer passes through guardBreakGlass:\n' + m[0]);
});

check('guardBreakGlass runs BEFORE the capability check', () => {
  // Ordering is the contract: production must answer 410 to everyone, not
  // "403 unless you happen to hold finance.accounts.manage".
  const m = erpSrc.match(/router\.post\(\s*'\/gl\/coa\/wipe-and-seed'[\s\S]{0,240}/);
  const g = m[0].indexOf('guardBreakGlass');
  const c = m[0].indexOf('requireCapability');
  assert.ok(g >= 0 && c >= 0, 'expected both guards on this route');
  assert.ok(g < c, 'guardBreakGlass must be the first middleware on the route');
});

check('routes/erp.js keeps no private copy of the guard', () => {
  // A local duplicate is how the audit-log helper drifted onto the wrong
  // column names once already; one definition, imported.
  assert.ok(!/function\s+guardBreakGlass\s*\(/.test(erpSrc),
    'routes/erp.js defines its own guardBreakGlass — import the shared one instead');
  assert.ok(/require\('\.\.\/lib\/transactionGuards'\)/.test(erpSrc));
});

console.log('\n' + (failed === 0 ? '✅ ALL PASS' : '❌ FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
