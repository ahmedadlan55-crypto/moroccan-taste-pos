/**
 * Canonical movement semantics used by warehouse analytics.
 *
 * "No movement" / slow-moving stock is a demand-consumption question.  A
 * transfer, stocktake adjustment, waste write-off or reversal must not reset
 * the clock.  Modern writers carry a reference_type; the reason fallback is
 * intentionally narrow and exists only for legacy rows written before that
 * column was populated consistently.
 */
'use strict';

const OUTBOUND_CONSUMPTION_REFERENCE_TYPES = Object.freeze([
  'sale',
  'inv_issue',
  'prod_issue',
  'production',
  'production_consume',
]);

const LEGACY_REASON_PREFIXES = Object.freeze([
  'مبيعات',
  'صرف مستقل',
]);

const LEGACY_REASON_EXACT = Object.freeze([
  'إنتاج',
  'استهلاك إنتاج',
]);

function isOutboundConsumption(row) {
  const movement = row || {};
  if (String(movement.type || '').toLowerCase() !== 'out') return false;
  const referenceType = String(movement.reference_type || movement.referenceType || '').trim().toLowerCase();
  if (OUTBOUND_CONSUMPTION_REFERENCE_TYPES.includes(referenceType)) return true;
  if (referenceType) return false;
  const reason = String(movement.reason || '').trim();
  return LEGACY_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)) ||
    LEGACY_REASON_EXACT.includes(reason);
}

function outboundConsumptionSql(alias) {
  const a = String(alias || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error('Safe SQL alias required');
  const refs = OUTBOUND_CONSUMPTION_REFERENCE_TYPES.map(() => '?').join(',');
  const prefixes = LEGACY_REASON_PREFIXES.map(() => `${a}.reason LIKE ?`);
  const exact = LEGACY_REASON_EXACT.map(() => '?').join(',');
  return {
    sql: `(${a}.type='out' AND (` +
      `${a}.reference_type IN (${refs}) OR (` +
      `(${a}.reference_type IS NULL OR ${a}.reference_type='') AND (` +
      `${prefixes.join(' OR ')} OR ${a}.reason IN (${exact})` +
      '))))',
    params: OUTBOUND_CONSUMPTION_REFERENCE_TYPES.concat(
      LEGACY_REASON_PREFIXES.map((prefix) => prefix + '%'),
      LEGACY_REASON_EXACT,
    ),
  };
}

// SQL text places scalar-subquery placeholders before outer-WHERE
// placeholders. Keep that ordering explicit and unit-testable; reversing it
// can silently bind a warehouse id as a reference type.
function subqueryFirstParams(predicateParams, subqueryScopeParams, outerScopeParams, tailParams) {
  return [].concat(predicateParams || [], subqueryScopeParams || [], outerScopeParams || [], tailParams || []);
}

module.exports = {
  OUTBOUND_CONSUMPTION_REFERENCE_TYPES,
  LEGACY_REASON_PREFIXES,
  LEGACY_REASON_EXACT,
  isOutboundConsumption,
  outboundConsumptionSql,
  subqueryFirstParams,
};
