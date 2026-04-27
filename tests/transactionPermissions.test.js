/**
 * V4 — Transaction Permissions tests
 * Pure-function tests; no DB required.
 */
'use strict';

const { can, computePermissions } = require('../lib/transactionPermissions');

let _passed = 0, _failed = 0;
function test(name, fn) {
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name, '-', e.message); }
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
function assertFalse(v, msg) { if (v) throw new Error(msg || 'expected false'); }

const creator = { username: 'creator1', role: 'employee', isDeveloper: false, isAdmin: false };
const reviewer = { username: 'reviewer1', role: 'employee', isDeveloper: false, isAdmin: false };
const otherUser = { username: 'other', role: 'employee', isDeveloper: false, isAdmin: false };
const admin = { username: 'admin', role: 'admin', isDeveloper: true, isAdmin: true };

console.log('\n═══ Transaction Permissions ═══');

console.log('\n─── View ───');
test('Creator can view their own', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: '', status: 'draft' };
  assertTrue(can(creator, 'txn.view', { txn }));
});
test('Other user cannot view', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: 'reviewer1', status: 'in_progress' };
  assertFalse(can(otherUser, 'txn.view', { txn }));
});
test('Assignee can view', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: 'reviewer1', status: 'in_progress' };
  assertTrue(can(reviewer, 'txn.view', { txn }));
});
test('Admin can view anything', () => {
  const txn = { id: 'T1', created_by: 'random', current_assignee: 'anyone', status: 'in_progress' };
  assertTrue(can(admin, 'txn.view', { txn }));
});

console.log('\n─── Edit ───');
test('Creator can edit draft', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'draft' };
  assertTrue(can(creator, 'txn.edit', { txn }));
});
test('Creator can edit returned', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'returned' };
  assertTrue(can(creator, 'txn.edit', { txn }));
});
test('Creator CANNOT edit in_progress (others might be reviewing)', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'in_progress' };
  assertFalse(can(creator, 'txn.edit', { txn }));
});
test('Reviewer CANNOT edit creator\'s txn', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'returned' };
  assertFalse(can(reviewer, 'txn.edit', { txn }));
});

console.log('\n─── Approve / One-reply-per-stage ───');
test('Assignee can approve fresh in_progress', () => {
  const txn = { id: 'T1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress' };
  const ctx = { txn, actionLog: [] };
  assertTrue(can(reviewer, 'txn.action.approve', ctx));
});
test('Assignee CANNOT approve twice on same stage', () => {
  const txn = { id: 'T1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress' };
  const ctx = {
    txn,
    actionLog: [{ action_type: 'approve', action_by: 'reviewer1', workflow_definition_id: 'S1' }]
  };
  assertFalse(can(reviewer, 'txn.action.approve', ctx));
});
test('Different reviewer at next step can approve (different stage)', () => {
  const txn = { id: 'T1', current_assignee: 'reviewer2', current_step_id: 'S2', status: 'in_progress' };
  const ctx = {
    txn,
    actionLog: [{ action_type: 'approve', action_by: 'reviewer1', workflow_definition_id: 'S1' }]
  };
  const reviewer2 = { username: 'reviewer2', role: 'employee', isDeveloper: false, isAdmin: false };
  assertTrue(can(reviewer2, 'txn.action.approve', ctx));
});

console.log('\n─── Reply (one per stage) ───');
test('Assignee can reply if hasn\'t replied yet', () => {
  const txn = { id: 'T1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress', created_by: 'creator1' };
  const ctx = { txn, replies: [], recipientUsernames: [] };
  assertTrue(can(reviewer, 'txn.reply', ctx));
});
test('Assignee CANNOT reply twice on same stage', () => {
  const txn = { id: 'T1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress', created_by: 'creator1' };
  const ctx = { txn, replies: [{ author_username: 'reviewer1', stage_step_id: 'S1' }], recipientUsernames: [] };
  assertFalse(can(reviewer, 'txn.reply', ctx));
});
test('Creator can reply on returned txn (clarification)', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: 'creator1', status: 'returned' };
  const ctx = { txn, replies: [], recipientUsernames: [] };
  assertTrue(can(creator, 'txn.reply', ctx));
});
test('Admin can always reply (override)', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress' };
  const ctx = { txn, replies: [{ author_username: 'admin', stage_step_id: 'S1' }], recipientUsernames: [] };
  assertTrue(can(admin, 'txn.reply', ctx));
});

console.log('\n─── Delete / Force Delete ───');
test('Creator can delete draft', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'draft' };
  assertTrue(can(creator, 'txn.delete', { txn }));
});
test('Creator CANNOT delete in_progress', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'in_progress' };
  assertFalse(can(creator, 'txn.delete', { txn }));
});
test('Force-delete is developer-only', () => {
  assertTrue(can(admin, 'txn.delete.force', {}));
  assertFalse(can(creator, 'txn.delete.force', {}));
});

console.log('\n─── Resubmit ───');
test('Creator can resubmit returned txn', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'returned' };
  assertTrue(can(creator, 'txn.action.resubmit', { txn }));
});
test('Non-creator cannot resubmit', () => {
  const txn = { id: 'T1', created_by: 'creator1', status: 'returned' };
  assertFalse(can(reviewer, 'txn.action.resubmit', { txn }));
});

console.log('\n─── Bulk computePermissions ───');
test('computePermissions returns full perms object', () => {
  const txn = { id: 'T1', created_by: 'creator1', current_assignee: 'reviewer1', current_step_id: 'S1', status: 'in_progress' };
  const perms = computePermissions(reviewer, txn, { actionLog: [], replies: [], recipientUsernames: [] });
  if (typeof perms.canApprove !== 'boolean') throw new Error('canApprove missing');
  if (typeof perms.canReply !== 'boolean') throw new Error('canReply missing');
  if (typeof perms.canForceDelete !== 'boolean') throw new Error('canForceDelete missing');
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_passed + _failed} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
