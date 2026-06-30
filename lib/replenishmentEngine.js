/**
 * Replenishment engine — Phase 4A.
 *
 * Pure rule-validation + recommendation math for the per-(warehouse, item)
 * replenishment rules (warehouse_item_rules). The route feeds it onHand (from
 * warehouse_stock) + the average daily outbound (SUM of `out` movement qty over a
 * lookback window / days) + the rule, and gets back days-of-cover, a reorder
 * status, a stockout risk, and a RECOMMENDED order quantity.
 *
 *   onHand     = warehouse_stock.qty (0 if no row)
 *   available  = onHand               (reserved stock is not tracked — documented)
 *   daysOfCover = avgDailyOut > 0 ? onHand / avgDailyOut : null   (never /0)
 *   if onHand <= reorderPoint:
 *     target          = maxStock > 0 ? maxStock : reorderPoint + reorderQty
 *     recommendedQty  = max(reorderQty, target - onHand)
 *   else recommendedQty = 0
 *
 * ADVISORY ONLY — this never creates a purchase order. No COGS / turnover (the
 * data does not support it). Unit-tested in tests/replenishmentEngine.test.js.
 */
'use strict';

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function nn(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _v(msg) { const e = new Error(msg); e.code = 'VALIDATION_ERROR'; return e; }

// Validate + normalize a warehouse-item rule. Throws { code:'VALIDATION_ERROR' }.
function validateRule(input) {
  const r = input || {};
  const rule = {
    minQty: nn(r.minQty), reorderPoint: nn(r.reorderPoint), reorderQty: nn(r.reorderQty),
    maxStock: nn(r.maxStock), safetyStock: nn(r.safetyStock), leadTimeDays: nn(r.leadTimeDays),
    isEnabled: r.isEnabled === undefined ? true : !!r.isEnabled,
  };
  for (const k of ['minQty', 'reorderPoint', 'reorderQty', 'maxStock', 'safetyStock', 'leadTimeDays']) {
    if (rule[k] < 0) throw _v('القيمة "' + k + '" لا يمكن أن تكون سالبة');
  }
  if (rule.isEnabled && rule.reorderQty <= 0) throw _v('كمية إعادة الطلب يجب أن تكون أكبر من صفر عند تفعيل القاعدة');
  if (rule.maxStock > 0 && rule.maxStock < rule.reorderPoint) throw _v('الحد الأقصى يجب أن يكون ≥ نقطة إعادة الطلب');
  if (rule.reorderPoint < rule.safetyStock) throw _v('نقطة إعادة الطلب يجب أن تكون ≥ مخزون الأمان');
  return rule;
}

function avgDailyOut(totalOut, days) {
  const d = nn(days);
  if (d <= 0) return 0;
  return Math.max(0, nn(totalOut)) / d;
}

function daysOfCover(onHand, avgDaily) {
  const a = nn(avgDaily);
  if (a <= 0) return null; // not enough outbound history → unknown, never divide by 0
  return round3(nn(onHand) / a);
}

function reorderStatus(onHand, rule) {
  const oh = nn(onHand);
  if (oh < 0) return 'negative';
  if (oh <= nn(rule.safetyStock) && nn(rule.safetyStock) > 0) return 'critical';
  if (oh <= nn(rule.reorderPoint)) return 'reorder';
  if (oh <= nn(rule.reorderPoint) * 1.25) return 'watch';
  return 'ok';
}

function recommendedQty(onHand, rule) {
  const oh = nn(onHand);
  const rp = nn(rule.reorderPoint);
  if (oh > rp) return 0;
  const target = nn(rule.maxStock) > 0 ? nn(rule.maxStock) : rp + nn(rule.reorderQty);
  return round3(Math.max(nn(rule.reorderQty), target - oh));
}

function stockoutRisk(cover, leadTimeDays) {
  if (cover === null || cover === undefined) return 'unknown';
  const lt = nn(leadTimeDays);
  if (lt <= 0) return cover <= 0 ? 'high' : 'low';
  if (cover < lt) return 'high';
  if (cover < lt * 2) return 'medium';
  return 'low';
}

// The full per-(warehouse, item) recommendation row.
function computeReplenishment(o) {
  const onHand = round3(o.onHand);
  const rule = o.rule || {};
  const ado = nn(o.avgDailyOut);
  const cover = daysOfCover(onHand, ado);
  return {
    onHand,
    available: onHand, // reserved not tracked
    avgDailyOutbound: round3(ado),
    daysOfCover: cover,
    reorderStatus: reorderStatus(onHand, rule),
    recommendedQty: recommendedQty(onHand, rule),
    stockoutRisk: stockoutRisk(cover, rule.leadTimeDays),
    hasRule: !!o.hasRule,
  };
}

module.exports = { round3, validateRule, avgDailyOut, daysOfCover, reorderStatus, recommendedQty, stockoutRisk, computeReplenishment };
