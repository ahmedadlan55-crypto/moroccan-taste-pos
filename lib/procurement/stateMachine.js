/**
 * lib/procurement/stateMachine.js — per-document state machines for the P2P
 * cycle. Pure + deterministic. Each document type has its own transition table;
 * `next(docType, fromStatus, action)` returns the target status or throws
 * INVALID_STATE_TRANSITION.
 *
 * Terminal/side-effecting transitions (post/reverse/approve/pay…) are enforced
 * here for the status graph only; RBAC, version, idempotency and GL are layered
 * on top by TransitionExecutor.
 */
'use strict';

const { err } = require('./errors');

// docType → { fromStatus → { action → toStatus } }
const MACHINES = {
  po: {
    draft:               { submit: 'submitted', cancel: 'cancelled', edit: 'draft' },
    submitted:           { approve: 'approved', reject: 'draft', cancel: 'cancelled' },
    approved:            { send: 'sent', cancel: 'cancelled', receive: 'partially_received', close: 'closed' },
    sent:                { receive: 'partially_received', cancel: 'cancelled', close: 'closed' },
    partially_received:  { receive: 'partially_received', complete: 'fully_received', close: 'closed' },
    fully_received:      { close: 'closed' },
    received:            { close: 'closed' }, // legacy alias
    closed:              {},
    cancelled:           {},
  },
  grn: {
    draft:     { approve: 'approved', cancel: 'cancelled', edit: 'draft' },
    approved:  { post: 'posted', cancel: 'cancelled' },
    posted:    { reverse: 'reversed' },
    reversed:  {},
    cancelled: {},
  },
  supplier_invoice: {
    draft:            { submit: 'pending_review', match: 'draft', cancel: 'cancelled', edit: 'draft' },
    pending_review:   { approve: 'approved', reject: 'draft', match: 'pending_review', cancel: 'cancelled' },
    pending_approval: { approve: 'approved', reject: 'draft', cancel: 'cancelled' },
    approved:         { pay: 'partially_paid', settle: 'paid', credit: 'approved', close: 'closed' },
    partially_paid:   { pay: 'partially_paid', settle: 'paid', credit: 'partially_paid' },
    paid:             { close: 'closed', credit: 'paid' },
    overdue:          { pay: 'partially_paid', settle: 'paid' },
    closed:           {},
    cancelled:        {},
  },
  payment: {
    requested:  { authorize: 'authorized', cancel: 'cancelled' },
    authorized: { pay: 'paid', cancel: 'cancelled' },
    paid:       { close: 'closed', reverse: 'reversed' },
    closed:     { reverse: 'reversed' },
    reversed:   {},
    cancelled:  {},
  },
  return: {
    draft:     { approve: 'approved', cancel: 'cancelled', edit: 'draft' },
    approved:  { post: 'posted', cancel: 'cancelled' },
    posted:    { settle: 'settled', reverse: 'draft' },
    settled:   {},
    cancelled: {},
  },
};

function next(docType, fromStatus, action) {
  const machine = MACHINES[docType];
  if (!machine) throw err('VALIDATION_ERROR', `نوع مستند غير معروف: ${docType}`);
  const from = machine[String(fromStatus)];
  if (!from) throw err('INVALID_STATE_TRANSITION', `حالة غير معروفة: ${fromStatus}`);
  const to = from[String(action)];
  if (to == null) {
    throw err('INVALID_STATE_TRANSITION', `لا يمكن تنفيذ «${action}» على مستند في حالة «${fromStatus}»`);
  }
  return to;
}

function can(docType, fromStatus, action) {
  try { next(docType, fromStatus, action); return true; } catch (_) { return false; }
}

/** Terminal statuses that forbid deletion/mutation. */
const TERMINAL = {
  po: ['closed', 'cancelled'],
  grn: ['posted', 'reversed'],
  supplier_invoice: ['approved', 'partially_paid', 'paid', 'closed'],
  payment: ['paid', 'closed', 'reversed'],
  return: ['posted', 'settled'],
};

function isDeletable(docType, status) {
  // Only drafts are deletable.
  return String(status) === 'draft';
}

module.exports = { MACHINES, next, can, TERMINAL, isDeletable };
