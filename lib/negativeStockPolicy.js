'use strict';
/**
 * ─── Negative-stock policy resolver (Phase W2) ──────────────────────────────
 *
 * Pure, DB-free resolver + guards used by the inventory engine.
 *
 * Policies:
 *   • block       — reject any outbound that would take qty below 0
 *   • controlled  — allow ONLY for `tracking_mode='none'` items when the caller
 *                   is a manager/admin, supplies a reason, ACKs the deficit,
 *                   and the resulting negative respects `maxNegativeQty`.
 *   • allow       — open door for developer/admin only, GATED by a global env
 *                   flag `NEGATIVE_STOCK_ALLOW_ENABLED=1`. Otherwise degrades
 *                   to `controlled`.
 *
 * Hard rules (BR-1..BR-7 in the design doc):
 *   BR-1  Items with `tracking_mode !== 'none'`  → block always. FEFO makes
 *         allocation impossible without inventing lots.
 *   BR-2  The invariant Σ(lot balances) = warehouse_stock.qty is never
 *         weakened by this module — the engine still runs assertInvariant.
 *   BR-3  Positive movements (receipts / adjustments+) are never gated by
 *         this policy — they can only reduce deficits, never create them.
 *   BR-4  Level precedence (most-restrictive-wins): block > controlled > allow.
 *   BR-5  All settings mutations are governed by the ordinary
 *         RBAC + expectedVersion + Audit pattern the routes already use.
 *   BR-6  Backend-authoritative — the client `allowNegative` field is a
 *         REQUEST (ACK), never a decision.
 *   BR-7  Idempotency: the caller passes the doc key; the engine ensures
 *         deficit rows are not double-created on replay.
 */

const P_RANK = { block: 0, controlled: 1, allow: 2 }; // lower is stricter
const ALLOW_ENABLED = () => /^(1|true|on|yes)$/i.test(String(process.env.NEGATIVE_STOCK_ALLOW_ENABLED || '').trim());
const POLICY_ENABLED = () => /^(1|true|on|yes)$/i.test(String(process.env.NEGATIVE_STOCK_POLICY_ENABLED || '').trim());

function normPolicy(p) {
  const s = String(p == null ? '' : p).toLowerCase();
  return P_RANK[s] === undefined ? null : s;
}

// Pure: resolve the effective policy + max negative from the three levels.
// Inputs are plain objects (or null) so the resolver never touches the DB.
//   item     : { tracking_mode: 'none' | 'lot' | 'expiry' }
//   globalCfg: { policy, max_negative_qty, is_enabled } | null
//   whCfg    : { policy, max_negative_qty, is_enabled } | null
//   itemCfg  : { policy, max_negative_qty, is_enabled } | null
// Returns    : { effectivePolicy, effectiveMaxNegative, reason, allowGated }
function resolvePolicy({ item, globalCfg, whCfg, itemCfg }) {
  if (item && item.tracking_mode && item.tracking_mode !== 'none') {
    return { effectivePolicy: 'block', effectiveMaxNegative: 0, reason: 'tracked-item', allowGated: false };
  }
  const rows = [globalCfg, whCfg, itemCfg]
    .filter((r) => r && r.is_enabled !== 0 && r.is_enabled !== false && normPolicy(r.policy))
    .map((r) => ({ policy: normPolicy(r.policy), max: Number(r.max_negative_qty) || 0 }));
  if (!rows.length) return { effectivePolicy: 'block', effectiveMaxNegative: 0, reason: 'default-block', allowGated: false };
  // pick strictest policy
  let winner = rows[0];
  for (const r of rows.slice(1)) if (P_RANK[r.policy] < P_RANK[winner.policy]) winner = r;
  // if allow but env gate is off → degrade to controlled
  let allowGated = false;
  if (winner.policy === 'allow' && !ALLOW_ENABLED()) { winner = { policy: 'controlled', max: winner.max }; allowGated = true; }
  // effective max = smallest defined max_negative across the winning-tier rows
  const winningRows = rows.filter((r) => r.policy === winner.policy && r.max > 0);
  const effMax = winningRows.length ? Math.min(...winningRows.map((r) => r.max)) : (winner.policy === 'allow' ? Number.POSITIVE_INFINITY : 0);
  return { effectivePolicy: winner.policy, effectiveMaxNegative: effMax, reason: 'resolved', allowGated };
}

// Pure: given the resolved policy + the request, decide the outcome.
//   request: {
//     oldQty, qtyDelta, newQty,
//     user: { role, isDeveloper },
//     reason, acknowledgeNegative,
//     makerChecker: { creator, poster }  // optional; if creator==poster, deny
//   }
// Returns : { verdict, code, reason }
//   verdict = 'proceed' | 'deficit' | 'deny'
//   code    = INSUFFICIENT_STOCK | NEGATIVE_CONFIRMATION_REQUIRED
//           | NEGATIVE_LIMIT_EXCEEDED | REASON_REQUIRED | forbidden_role
//           | MAKER_CHECKER_SELF_APPROVAL | ALLOW_REQUIRES_DEVELOPER
function evaluateIssue({ resolved, request }) {
  const { effectivePolicy, effectiveMaxNegative } = resolved;
  const { newQty, user, reason, acknowledgeNegative, makerChecker } = request;
  // If newQty ≥ 0 the guard has nothing to say.
  if (Number(newQty) >= 0) return { verdict: 'proceed' };
  // From here on, we're going negative.
  if (effectivePolicy === 'block') return { verdict: 'deny', code: 'INSUFFICIENT_STOCK', reason: 'block' };
  // controlled + allow share the same gates below.
  if (effectivePolicy === 'allow' && !(user && user.isDeveloper)) return { verdict: 'deny', code: 'ALLOW_REQUIRES_DEVELOPER', reason: 'allow-needs-dev' };
  const role = (user && String(user.role || '').toLowerCase()) || '';
  if (!['manager', 'admin', 'developer'].includes(role)) return { verdict: 'deny', code: 'forbidden_role', reason: 'role' };
  if (!reason || !String(reason).trim()) return { verdict: 'deny', code: 'REASON_REQUIRED', reason: 'no-reason' };
  if (!acknowledgeNegative) return { verdict: 'deny', code: 'NEGATIVE_CONFIRMATION_REQUIRED', reason: 'no-ack' };
  const deficit = Math.abs(Number(newQty));
  if (effectivePolicy === 'controlled' && deficit > (Number(effectiveMaxNegative) || 0)) {
    return { verdict: 'deny', code: 'NEGATIVE_LIMIT_EXCEEDED', reason: 'limit' };
  }
  if (makerChecker && makerChecker.creator && makerChecker.poster && makerChecker.creator === makerChecker.poster) {
    return { verdict: 'deny', code: 'MAKER_CHECKER_SELF_APPROVAL', reason: 'maker=checker' };
  }
  return { verdict: 'deficit' };
}

// Convenience: compose resolve + evaluate. Kept pure.
function decide({ item, globalCfg, whCfg, itemCfg, request }) {
  const resolved = resolvePolicy({ item, globalCfg, whCfg, itemCfg });
  const outcome = evaluateIssue({ resolved, request });
  return { resolved, outcome };
}

module.exports = { resolvePolicy, evaluateIssue, decide, POLICY_ENABLED, ALLOW_ENABLED, P_RANK };
