/**
 * Stocktake reconciliation math — Phase 3C.
 *
 * The professional stocktake (routes/inventory-stocktakes.js) reconciles a count
 * against the THEORETICAL balance *at the moment each item was counted*, not the
 * snapshot taken when the count started — so movements that happen DURING the
 * count don't masquerade as variance, and movements AFTER the count aren't lost
 * when the variance is posted to the CURRENT balance.
 *
 *   theoreticalQtyAtCount = snapshotQty + netMovementsUntilCountedAt
 *   variance              = countedQty − theoreticalQtyAtCount
 *
 * Value / percent / flag are delegated to the SINGLE professional variance source
 * (lib/stocktakeWorkflow.computeVariance) — fed systemQty = theoretical so the
 * one formula serves both the legacy stocktake-pro and the new v2 stocktake.
 *
 * countedQty === null/undefined ⇒ NOT counted yet (excluded at post; never zeroed).
 * countedQty === 0              ⇒ counted and found empty (a real variance).
 *
 * Pure — no DB, no I/O. Unit-tested in tests/stocktakeReconcile.test.js.
 */
'use strict';
const STK = require('./stocktakeWorkflow');

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

// Theoretical on-hand at the instant the line was counted.
function theoreticalQtyAtCount(snapshotQty, netMovements) {
  return round3(Number(snapshotQty || 0) + Number(netMovements || 0));
}

// Variance the count revealed (signed): counted − theoretical-at-count.
function variance(countedQty, theoreticalQty) {
  return round3(Number(countedQty || 0) - Number(theoreticalQty || 0));
}

// Whether a counted_qty value means "counted" (a number, incl. 0) vs "uncounted".
function isCounted(countedQty) {
  return !(countedQty === null || countedQty === undefined || countedQty === '');
}

// Full per-line reconciliation snapshot used by the route + the variance UI.
function reconcileLine(opts) {
  const o = opts || {};
  const snapshotQty = Number(o.snapshotQty || 0);
  const netMovements = Number(o.netMovements || 0);
  const theoreticalQty = theoreticalQtyAtCount(snapshotQty, netMovements);
  if (!isCounted(o.countedQty)) {
    return { snapshotQty: round3(snapshotQty), netMovements: round3(netMovements), theoreticalQty, countedQty: null, counted: false, variance: null, varianceValue: 0, variancePct: 0, isFlagged: false };
  }
  const counted = Number(o.countedQty);
  const v = STK.computeVariance({ systemQty: theoreticalQty, actualQty: counted, unitCost: Number(o.unitCost || 0), thresholdPct: Number(o.thresholdPct != null ? o.thresholdPct : 10) });
  return { snapshotQty: round3(snapshotQty), netMovements: round3(netMovements), theoreticalQty, countedQty: round3(counted), counted: true, variance: v.variance, varianceValue: v.varianceValue, variancePct: v.variancePct, isFlagged: v.isFlagged };
}

module.exports = { round3, theoreticalQtyAtCount, variance, isCounted, reconcileLine };
