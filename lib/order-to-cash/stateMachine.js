/**
 * lib/order-to-cash/stateMachine.js — per-document state machines for the O2C
 * cycle (spec §6). Pure + deterministic. `next(docType, fromStatus, action)`
 * returns the target status or throws INVALID_STATE_TRANSITION. RBAC, version,
 * idempotency and GL are layered on top by TransitionExecutor.
 *
 * An issued AR document is IMMUTABLE (no edit/delete) — cancellation after issue
 * is a credit note, never a mutation of the original.
 */
'use strict';

const { err } = require('./errors');

// docType → { fromStatus → { action → toStatus } }
const MACHINES = {
  sales_order: {
    draft:      { confirm: 'confirmed', cancel: 'cancelled', edit: 'draft' },
    confirmed:  { fulfill: 'fulfilled', cancel: 'cancelled' }, // cancel allowed only before fulfillment
    fulfilled:  { invoice: 'invoiced' },
    invoiced:   { close: 'closed' },
    closed:     {},
    cancelled:  {},
  },
  ar_document: {
    draft:          { issue: 'issued', cancel: 'cancelled', edit: 'draft' },
    issued:         { pay: 'partially_paid', settle: 'paid', credit: 'credited' },
    partially_paid: { pay: 'partially_paid', settle: 'paid', credit: 'credited' },
    paid:           { credit: 'credited', close: 'closed' },
    credited:       {},
    closed:         {},
    cancelled:      {},
  },
  customer_payment: {
    draft:     { approve: 'approved', cancel: 'cancelled', edit: 'draft' },
    approved:  { post: 'posted', cancel: 'cancelled' }, // cancel only before posting
    posted:    { reverse: 'reversed' },
    reversed:  {},
    cancelled: {},
  },
  sales_return: {
    draft:     { approve: 'approved', cancel: 'cancelled', edit: 'draft' },
    approved:  { post: 'posted', cancel: 'cancelled' }, // cancel only before posting
    posted:    { reverse: 'reversed' },
    reversed:  {},
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

/** An issued AR document can never be edited or deleted (immutability). */
function isDeletable(docType, status) {
  return String(status) === 'draft';
}

module.exports = { MACHINES, next, can, isDeletable };
