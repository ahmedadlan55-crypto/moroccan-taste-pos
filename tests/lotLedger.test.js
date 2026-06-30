/**
 * Phase 4B — lot ledger PURE-part unit tests (FEFO planner + helpers).
 * The DB-bound allocate/receive/reverse/invariant functions are covered by the
 * integration suite (tests/integration/lots.api.test.js). Run: node tests/lotLedger.test.js
 */
'use strict';
const L = require('../lib/lotLedger');

let _p = 0, _f = 0;
function test(name, fn) { try { fn(); _p++; console.log('  ✅', name); } catch (e) { _f++; console.log('  ❌', name); console.log('     ', e.message); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const NOW = new Date('2026-06-30T08:00:00Z'); // 2026-06-30 Riyadh

console.log('\n═══ Lot ledger (pure) ═══\n');

console.log('─── helpers ───');
test('lotNorm trims + uppercases', () => eq(L.lotNorm('  ab-1 '), 'AB-1'));
test('lotNorm of null → empty', () => eq(L.lotNorm(null), ''));
test('isTracked: lot/expiry true, none false', () => eq([L.isTracked('lot'), L.isTracked('expiry'), L.isTracked('none')], [true, true, false]));

console.log('\n─── planFefo: the mandatory E2E scenario ───');
test('A(exp 07-01,30) + B(exp 08-01,50), want 40 → A=30, B=10', () => {
  const lots = [
    { lotId: 'B', qty: 50, expiryDate: '2026-08-01', receivedAt: '2026-06-02', lifecycleStatus: 'active' },
    { lotId: 'A', qty: 30, expiryDate: '2026-07-01', receivedAt: '2026-06-10', lifecycleStatus: 'active' },
  ];
  const p = L.planFefo(lots, 40, { mode: 'expiry', now: NOW });
  eq(p.allocations, [{ lotId: 'A', qty: 30 }, { lotId: 'B', qty: 10 }]);
  eq(p.shortfall, 0);
});

console.log('\n─── planFefo: exclusions ───');
test('expired lot is skipped (counted in skipped.expired)', () => {
  const lots = [
    { lotId: 'X', qty: 100, expiryDate: '2026-06-01', receivedAt: '2026-05-01', lifecycleStatus: 'active' }, // expired
    { lotId: 'B', qty: 50, expiryDate: '2026-08-01', receivedAt: '2026-06-02', lifecycleStatus: 'active' },
  ];
  const p = L.planFefo(lots, 40, { mode: 'expiry', now: NOW });
  eq(p.allocations, [{ lotId: 'B', qty: 40 }]);
  eq(p.skipped.expired, 100);
});
test('quarantined + recalled lots are skipped (blocked)', () => {
  const lots = [
    { lotId: 'Q', qty: 100, expiryDate: '2026-07-15', receivedAt: '2026-06-01', lifecycleStatus: 'quarantined' },
    { lotId: 'R', qty: 100, expiryDate: '2026-07-16', receivedAt: '2026-06-01', lifecycleStatus: 'recalled' },
    { lotId: 'A', qty: 20, expiryDate: '2026-07-20', receivedAt: '2026-06-01', lifecycleStatus: 'active' },
  ];
  const p = L.planFefo(lots, 15, { mode: 'lot', now: NOW });
  eq(p.allocations, [{ lotId: 'A', qty: 15 }]);
  eq(p.skipped.blocked, 200);
});

console.log('\n─── planFefo: insufficient → shortfall (no throw) ───');
test('want 200 but only 80 available → shortfall 120', () => {
  const lots = [{ lotId: 'A', qty: 80, expiryDate: '2026-07-10', receivedAt: '2026-06-01', lifecycleStatus: 'active' }];
  const p = L.planFefo(lots, 200, { mode: 'lot', now: NOW });
  eq(p.shortfall, 120);
  eq(p.allocations, [{ lotId: 'A', qty: 80 }]);
});

console.log('\n─── planFefo: ordering rules ───');
test('null expiry allocated LAST (lot mode)', () => {
  const lots = [
    { lotId: 'N', qty: 10, expiryDate: null, receivedAt: '2026-05-01', lifecycleStatus: 'active' },
    { lotId: 'A', qty: 10, expiryDate: '2026-07-10', receivedAt: '2026-06-01', lifecycleStatus: 'active' },
  ];
  const p = L.planFefo(lots, 15, { mode: 'lot', now: NOW });
  eq(p.allocations, [{ lotId: 'A', qty: 10 }, { lotId: 'N', qty: 5 }]);
});
test('same expiry → tie-break by receivedAt then lotId', () => {
  const lots = [
    { lotId: 'Z', qty: 5, expiryDate: '2026-07-10', receivedAt: '2026-06-05', lifecycleStatus: 'active' },
    { lotId: 'A', qty: 5, expiryDate: '2026-07-10', receivedAt: '2026-06-01', lifecycleStatus: 'active' }, // earlier received → first
    { lotId: 'M', qty: 5, expiryDate: '2026-07-10', receivedAt: '2026-06-05', lifecycleStatus: 'active' }, // same as Z → lotId M < Z
  ];
  const p = L.planFefo(lots, 15, { mode: 'expiry', now: NOW });
  eq(p.allocations.map((a) => a.lotId), ['A', 'M', 'Z']);
});
test('zero-qty balances ignored', () => {
  const lots = [
    { lotId: 'A', qty: 0, expiryDate: '2026-07-01', receivedAt: '2026-06-01', lifecycleStatus: 'active' },
    { lotId: 'B', qty: 12, expiryDate: '2026-07-05', receivedAt: '2026-06-01', lifecycleStatus: 'active' },
  ];
  const p = L.planFefo(lots, 12, { mode: 'expiry', now: NOW });
  eq(p.allocations, [{ lotId: 'B', qty: 12 }]);
});
test('allowExpired=true issues from an expired lot', () => {
  const lots = [{ lotId: 'X', qty: 30, expiryDate: '2026-06-01', receivedAt: '2026-05-01', lifecycleStatus: 'active' }];
  const p = L.planFefo(lots, 10, { mode: 'expiry', now: NOW, allowExpired: true });
  eq(p.allocations, [{ lotId: 'X', qty: 10 }]);
});

console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
process.exit(_f > 0 ? 1 : 0);
