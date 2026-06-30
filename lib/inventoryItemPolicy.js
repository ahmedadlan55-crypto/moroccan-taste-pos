/**
 * Inventory item lifecycle policy — Phase 4B ("close 4A").
 *
 * ONE source of truth for what a deactivated (inactive / soft-deleted) item may
 * do, imported by EVERY stock writer — the warehouse-v2 documents (receipts /
 * issues / adjustments), transfers, production, sales, purchases, legacy
 * inventory and waste — so deactivation can never be silently bypassed.
 *
 * Rules (user-confirmed):
 *   • INFLOW  (receipt / positive adjustment / transfer-in / production output /
 *             purchase receive / opening balance) of an inactive item → BLOCKED.
 *   • OUTFLOW (issue / negative adjustment / transfer-out / consumption / sale)
 *             of an inactive item's REMAINING balance → ALLOWED to liquidate,
 *             but only with an explicit reason (the route already gates the role).
 *   • REVERSAL of an existing posted document → ALWAYS allowed (accounting
 *             integrity — a reversal must never be blocked by a later deactivation).
 *
 * Pure (no I/O): callers pass the already-loaded item row. Throws Errors carrying
 * a canonical `.code` so the route layer maps them to the unified error body.
 */
'use strict';

function _err(code, msg) { const e = new Error(msg); e.code = code; return e; }

function isInactive(item) {
  return !item || Number(item.active) === 0 || !!item.deleted_at;
}

function itemLabel(item) { return (item && (item.name || item.id)) || 'صنف'; }

// Throw if a NEW inbound movement is attempted for an inactive item.
function assertInflowAllowed(item) {
  if (isInactive(item)) {
    throw _err('VALIDATION_ERROR', 'الصنف "' + itemLabel(item) + '" غير نشط — لا يمكن إدخال مخزون جديد له');
  }
}

// Throw if an outbound (liquidation) movement of an inactive item lacks a reason.
// opts.isReversal bypasses entirely (accounting integrity). Active items pass freely.
function assertOutflowAllowed(item, opts) {
  const o = opts || {};
  if (o.isReversal) return;        // a reversal is always allowed
  if (!isInactive(item)) return;   // active items: no extra gate here
  const reason = String(o.reason || '').trim();
  if (!reason) {
    throw _err('VALIDATION_ERROR', 'الصنف "' + itemLabel(item) + '" غير نشط — صرف/تصفية الرصيد المتبقي يتطلب سببًا صريحًا');
  }
}

module.exports = { isInactive, itemLabel, assertInflowAllowed, assertOutflowAllowed };
