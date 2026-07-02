/**
 * Phase 5B.1 — metrics contract unit tests (pure, no DB/server).
 * Run: node tests/metricsContract.test.js
 * Covers: route normalization (bounded cardinality — never raw ids/URLs) and
 * the trackRequest counter semantics (status classes via a fake req/res).
 */
'use strict';
const M = require('../routes/metrics');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

console.log('\n═══ metrics contract (5B.1) ═══\n');

console.log('─── normalizeRoute (bounded labels) ───');
test('doc numbers fold to :id', () => {
  eq(M._normalizeRoute('/api/inventory/v2/receipts/RCV-20260701-0001/post'), '/api/inventory/v2/receipts/:id/post');
  eq(M._normalizeRoute('/api/inventory/v2/lots/EV-1751415000-x7k2q/trace'), '/api/inventory/v2/lots/:id/trace');
});
test('numeric + uuid segments fold to :id', () => {
  eq(M._normalizeRoute('/api/users/12345'), '/api/users/:id');
  eq(M._normalizeRoute('/api/x/550e8400-e29b-41d4-a716-446655440000'), '/api/x/:id');
});
test('static routes unchanged + query stripped', () => {
  eq(M._normalizeRoute('/api/inventory/v2/lots?pageSize=50&q=abc'), '/api/inventory/v2/lots');
  eq(M._normalizeRoute('/api/inventory/warehouses-summary'), '/api/inventory/warehouses-summary');
});
test('depth capped at 7 segments', () => {
  eq(M._normalizeRoute('/a/b/c/d/e/f/g/h/i/j'), '/a/b/c/d/e/f/g');
});

console.log('\n─── trackRequest counts status classes ───');
function fakeReqRes(method, url, status) {
  const listeners = {};
  const req = { method, originalUrl: url, url };
  const res = { statusCode: status, on: (ev, cb) => { listeners[ev] = cb; } };
  return { req, res, finish: () => listeners.finish && listeners.finish() };
}
test('2xx / 4xx / 5xx are counted with normalized route label', () => {
  const before = JSON.parse(JSON.stringify(M._counters.byStatus));
  for (const [st, url] of [[200, '/api/inventory/v2/lots?x=1'], [404, '/api/nope/999'], [500, '/api/inventory/v2/lots/RCV-1-2/post']]) {
    const { req, res, finish } = fakeReqRes('GET', url, st);
    M._trackRequest(req, res, () => {});
    finish();
  }
  eq(M._counters.byStatus['2xx'] - before['2xx'], 1, '2xx');
  eq(M._counters.byStatus['4xx'] - before['4xx'], 1, '4xx');
  eq(M._counters.byStatus['5xx'] - before['5xx'], 1, '5xx');
  const snap = M._routeSnapshot();
  const lots = snap.find((r) => r.method === 'GET' && r.route === '/api/inventory/v2/lots');
  if (!lots || lots['2xx'] < 1) throw new Error('labelled route counter missing: ' + JSON.stringify(snap.slice(0, 3)));
  if (snap.some((r) => /RCV-1-2|pageSize|999/.test(r.route))) throw new Error('raw id/url leaked into labels');
});

console.log('\n═══ ' + _p + ' passed, ' + _f + ' failed ═══\n');
process.exit(_f ? 1 : 0);
