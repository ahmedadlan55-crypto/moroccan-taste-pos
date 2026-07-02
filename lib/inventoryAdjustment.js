/**
 * Inventory Adjustment — canonical lifecycle guards.
 *
 * Phase 0 (Contracts & Safety). Pure rules shared by the HTTP route in
 * routes/inventory.js (/adjustments…) and the contract tests in
 * tests/inventoryAdjustment.test.js.
 *
 * Lifecycle:  pending → approved   (approval posts the stock + GL impact)
 *             pending → (deleted)   only a non-posted draft may be deleted
 *
 * Hard rules:
 *   • Only a `pending` adjustment can be approved (no double-post).
 *   • A `approved` (posted) adjustment can NEVER be hard-deleted — it must
 *     be reversed. Deleting a posted document silently strands the stock
 *     and GL it already moved (React blueprint §3.1.b).
 */
'use strict';

// Statuses that have already moved stock / posted GL.
const POSTED = ['approved'];

function _err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function isPosted(status) {
  return POSTED.indexOf(String(status)) !== -1;
}

function canApprove(status) {
  return status === 'pending';
}
function assertCanApprove(status) {
  if (!canApprove(status)) {
    throw _err(
      'ADJ_NOT_PENDING',
      'لا يمكن اعتماد تعديل ليس في حالة "بانتظار" (pending). الحالة الحالية: ' + status
    );
  }
}

// A pending draft (or a rejected one) may be deleted; a posted adjustment
// may not. Reverse it instead.
function canDelete(status) {
  return !isPosted(status);
}
function assertCanDelete(status) {
  if (!canDelete(status)) {
    throw _err(
      'ADJ_POSTED_NO_DELETE',
      'لا يمكن حذف تعديل معتمد — استخدم عكسًا موثقًا بدل الحذف للحفاظ على سجل التدقيق.'
    );
  }
}

module.exports = {
  POSTED,
  isPosted,
  canApprove,
  assertCanApprove,
  canDelete,
  assertCanDelete,
};
