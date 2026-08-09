'use strict';

/**
 * Stable POS-order ownership.
 *
 * `username` is a display/login key and can be renamed. `users.id` is the
 * durable account identity carried by every JWT. New orders therefore pin the
 * numeric owner id, while legacy rows (created before owner_user_id existed)
 * retain the old username fallback. Once a stable id is present it is
 * authoritative: a matching username must never let a different account take
 * over an order.
 */
function stableUserId(value) {
  if (value == null || value === '') return null;
  const id = String(value).trim();
  return id || null;
}

function normalizedUsername(value) {
  return String(value == null ? '' : value).trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function isSupervisor(user) {
  const role = String((user && user.role) || '').trim().toLowerCase();
  return role === 'admin' || role === 'manager' || !!(user && user.isDeveloper);
}

function isOwnedBy(order, user) {
  if (isSupervisor(user)) return true;
  if (!order || !user) return false;

  const storedId = stableUserId(order.owner_user_id != null ? order.owner_user_id : order.ownerUserId);
  const callerId = stableUserId(user.id);
  if (storedId != null) return callerId != null && storedId === callerId;

  // Compatibility only for pre-migration rows. MySQL's username uniqueness is
  // case-insensitive in the deployed utf8mb4 collation, so normalize here too.
  const storedName = normalizedUsername(order.username);
  const callerName = normalizedUsername(user.username || user.name);
  return !!storedName && !!callerName && storedName === callerName;
}

function ownershipMessage() {
  return 'هذا الطلب محفوظ لحساب كاشير آخر لحماية المبيعات. سجّل دخول صاحبه أو اطلب من المدير استئنافه · ' +
    'This order is protected under another cashier account. Sign in as its owner or ask a manager to resume it.';
}

module.exports = { stableUserId, normalizedUsername, isSupervisor, isOwnedBy, ownershipMessage };
