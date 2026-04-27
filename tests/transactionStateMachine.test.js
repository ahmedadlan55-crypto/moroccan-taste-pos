/**
 * V4 — Transaction State Machine tests
 * Pure-function tests; no DB required. Run with: node tests/transactionStateMachine.test.js
 */
'use strict';

const SM = require('../lib/transactionStateMachine');

let _passed = 0, _failed = 0, _total = 0;

function test(name, fn) {
  _total++;
  try {
    fn();
    _passed++;
    console.log('  ✅', name);
  } catch (e) {
    _failed++;
    console.log('  ❌', name);
    console.log('     ', e.message);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertThrows(fn, expectedCode) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (expectedCode && e.code !== expectedCode) {
      throw new Error('Expected throw with code ' + expectedCode + ', got code ' + e.code);
    }
  }
  if (!threw) throw new Error('Expected function to throw');
}

console.log('\n═══ Transaction State Machine ═══');

test('STATES has 8 entries', () => {
  assertEqual(Object.keys(SM.STATES).length, 8);
});

test('TERMINAL contains rejected + closed', () => {
  assertEqual(SM.isTerminal('rejected'), true);
  assertEqual(SM.isTerminal('closed'), true);
  assertEqual(SM.isTerminal('in_progress'), false);
});

console.log('\n─── Lifecycle transitions ───');

test('draft → submit → created', () => {
  const next = SM.transition('draft', 'submit');
  assertEqual(next, 'created');
});

test('created → open → in_progress', () => {
  const next = SM.transition('created', 'open');
  assertEqual(next, 'in_progress');
});

test('in_progress → approve (with next step) → in_progress', () => {
  const next = SM.transition('in_progress', 'approve', { txn: { hasNextStep: true } });
  assertEqual(next, 'in_progress');
});

test('in_progress → approve (no next step, final) → approved', () => {
  const next = SM.transition('in_progress', 'approve', { txn: { hasNextStep: false } });
  assertEqual(next, 'approved');
});

test('in_progress → reject → rejected', () => {
  const next = SM.transition('in_progress', 'reject');
  assertEqual(next, 'rejected');
});

test('in_progress → return → returned', () => {
  const next = SM.transition('in_progress', 'return');
  assertEqual(next, 'returned');
});

test('in_progress → reply → replied', () => {
  const next = SM.transition('in_progress', 'reply');
  assertEqual(next, 'replied');
});

test('returned → resubmit → in_progress', () => {
  const next = SM.transition('returned', 'resubmit');
  assertEqual(next, 'in_progress');
});

test('returned → edit → returned (self-loop)', () => {
  const next = SM.transition('returned', 'edit');
  assertEqual(next, 'returned');
});

test('approved → close → closed', () => {
  const next = SM.transition('approved', 'close');
  assertEqual(next, 'closed');
});

test('approved → record_payment → closed', () => {
  const next = SM.transition('approved', 'record_payment');
  assertEqual(next, 'closed');
});

console.log('\n─── Forbidden transitions ───');

test('closed → approve throws INVALID_TRANSITION', () => {
  assertThrows(() => SM.transition('closed', 'approve'), 'INVALID_TRANSITION');
});

test('rejected → approve throws INVALID_TRANSITION', () => {
  assertThrows(() => SM.transition('rejected', 'approve'), 'INVALID_TRANSITION');
});

test('draft → approve throws INVALID_TRANSITION', () => {
  assertThrows(() => SM.transition('draft', 'approve'), 'INVALID_TRANSITION');
});

test('replied → reply throws INVALID_TRANSITION (cannot reply twice)', () => {
  // The state machine doesn't allow REPLY from REPLIED (actor already acted)
  assertThrows(() => SM.transition('replied', 'reply'), 'INVALID_TRANSITION');
});

test('returned → approve throws INVALID_TRANSITION (only resubmit/edit/cancel)', () => {
  assertThrows(() => SM.transition('returned', 'approve'), 'INVALID_TRANSITION');
});

console.log('\n─── Invariants ───');

test('Terminal state with assignee fails invariant', () => {
  const txn = { status: 'closed', current_assignee: 'someone', created_by: 'creator', return_count: 0 };
  const violations = SM.checkInvariants(txn);
  if (!violations.some(v => v.includes('TERMINAL_HAS_NO_ASSIGNEE'))) {
    throw new Error('Expected TERMINAL_HAS_NO_ASSIGNEE violation, got: ' + violations.join(' | '));
  }
});

test('Returned state with non-creator assignee fails invariant', () => {
  const txn = { status: 'returned', current_assignee: 'someoneElse', created_by: 'creator', return_count: 1, returned_at: new Date() };
  const violations = SM.checkInvariants(txn);
  if (!violations.some(v => v.includes('RETURNED_GOES_TO_CREATOR'))) {
    throw new Error('Expected RETURNED_GOES_TO_CREATOR violation, got: ' + violations.join(' | '));
  }
});

test('In-progress state with empty assignee fails invariant', () => {
  const txn = { status: 'in_progress', current_assignee: '', created_by: 'creator', return_count: 0 };
  const violations = SM.checkInvariants(txn);
  if (!violations.some(v => v.includes('IN_PROGRESS_HAS_ASSIGNEE'))) {
    throw new Error('Expected IN_PROGRESS_HAS_ASSIGNEE violation, got: ' + violations.join(' | '));
  }
});

test('Negative return_count fails invariant', () => {
  const txn = { status: 'in_progress', current_assignee: 'a', created_by: 'b', return_count: -1 };
  const violations = SM.checkInvariants(txn);
  if (!violations.some(v => v.includes('RETURN_COUNT_NON_NEGATIVE'))) {
    throw new Error('Expected RETURN_COUNT_NON_NEGATIVE violation');
  }
});

test('Returned status without returned_at fails invariant', () => {
  const txn = { status: 'returned', current_assignee: 'creator', created_by: 'creator', return_count: 1, returned_at: null };
  const violations = SM.checkInvariants(txn);
  if (!violations.some(v => v.includes('RETURNED_FIELDS_CONSISTENT'))) {
    throw new Error('Expected RETURNED_FIELDS_CONSISTENT violation');
  }
});

test('Valid in_progress txn passes all invariants', () => {
  const txn = { status: 'in_progress', current_assignee: 'reviewer1', created_by: 'creator', return_count: 0, version: 5 };
  const violations = SM.checkInvariants(txn);
  if (violations.length) throw new Error('Expected zero violations, got: ' + violations.join(' | '));
});

console.log('\n─── Available actions ───');

test('availableActions(draft) returns [edit, submit, cancel]', () => {
  const actions = SM.availableActions('draft').sort();
  const expected = ['cancel','edit','submit'].sort();
  assertEqual(JSON.stringify(actions), JSON.stringify(expected));
});

test('availableActions(closed) returns just [reply]', () => {
  const actions = SM.availableActions('closed');
  assertEqual(JSON.stringify(actions), JSON.stringify(['reply']));
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_total} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(_failed > 0 ? 1 : 0);
