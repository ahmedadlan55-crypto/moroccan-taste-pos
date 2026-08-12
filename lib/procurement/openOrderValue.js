/** Shared SQL contract for the commercial value still open on a PO line. */
'use strict';

function expressions({ ordered, received, lineTotal, unitPrice }) {
  if (!ordered || !received) throw new Error('ordered and received SQL expressions are required');
  const remaining = `GREATEST((${ordered}) - (${received}), 0)`;
  if (lineTotal) {
    return {
      remaining,
      remainingValue: `(CASE WHEN (${ordered}) > 0 THEN (${remaining} / (${ordered})) * COALESCE((${lineTotal}), 0) ELSE 0 END)`,
      valueBasis: 'line_total_pro_rata_including_discount_and_vat',
    };
  }
  if (!unitPrice) throw new Error('unitPrice is required when lineTotal is unavailable');
  return {
    remaining,
    remainingValue: `((${remaining}) * (${unitPrice}))`,
    valueBasis: 'unit_price_fallback_ex_vat_discount_unknown',
  };
}

module.exports = { expressions };
