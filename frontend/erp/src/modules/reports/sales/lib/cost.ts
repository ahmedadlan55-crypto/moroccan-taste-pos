// One definition of "this row sold something but nobody ever costed it".
//
// `ar_document_lines.cost_snapshot` is written on EVERY sale, so a menu item
// with neither a recipe/BOM nor a manual cost gets a snapshot of 0.00 — which
// is arithmetically indistinguishable from "this item genuinely costs nothing".
// Printing that zero makes gross_profit == net and margin_pct == 100% on an
// item whose real margin is simply unknown.
//
// That is not a cosmetic problem. The profitability page ranks items by margin
// and classifies them Star / Plowhorse / Puzzle / Dog: an uncosted item lands
// at the top of the margin axis and is labelled a STAR, telling the owner to
// push the one item the system understands least. So an uncosted row must be
// excluded from the medians and left unclassified, not merely annotated.
//
// The check is deliberately narrow — `qty > 0 && cost === 0`:
//   • qty > 0        → the row actually sold; an empty group is not "uncosted".
//   • cost === 0     → exactly zero. A real cost is never exactly 0.00 once an
//                      ingredient carries any price, so this does not swallow
//                      genuinely-costed rows.
//   • cost == null   → NOT flagged. Null means the server masked or omitted the
//                      metric (no analytics.cost.view), which is a different
//                      claim: "you may not see it", not "it does not exist".
//
// Grain matters: this is exact when the group is one menu item (the item-sales
// and profitability tables both group by menu_item), because every line in such
// a group shares one cost basis. On a coarser grouping a partially-costed group
// sums to a non-zero cost and will NOT be flagged — use the server-side
// `uncosted_net` metric for a window-level signal instead.
export function isCostUndefined(soldQty: number | null, cost: number | null): boolean {
  return (soldQty ?? 0) > 0 && cost === 0;
}
