/**
 * lib/analytics/registry/metrics.js — the metric dictionary.
 *
 * TWO KINDS:
 *   additive — bound to EXACTLY ONE fact (registry/facts.js), with a SQL
 *              aggregate expression whose aliases must belong to that fact's
 *              constant join graph. Additive metrics are what the planner
 *              actually runs; they re-aggregate safely across any dimension.
 *   derived  — a JS equation (lib/analytics/equations.js) over the values of
 *              other metrics. Never SQL, never a fourth rounding contract:
 *              the equation functions own the arithmetic.
 *
 * Every additive metric carries:
 *   { id, kind: 'additive', fact, sql, format, equationKey, version,
 *     requiresCap? }
 * Every derived metric carries:
 *   { id, kind: 'derived', equationKey, inputs: [metricId...], format,
 *     version, requiresCap? }
 *
 * equationKey names the equations.js function that defines the metric's
 * arithmetic ('sum' / 'count' for plain aggregates — those two are the only
 * keys with no equations.js function behind them).
 *
 * VAT DISCIPLINE: vat_amount sums the STORED d.vat_amount column. No metric
 * derives VAT from a rate, and no SQL string contains a tax constant — the
 * registry test and scripts/audit/analytics-no-vat-constant.js both enforce
 * this.
 *
 * growth is PARAMETERIZED: it applies equations.growth(current, previous) to
 * any base metric across two periods. Its `inputs` name no metric ids —
 * `takesMetricParam: true` tells the planner (and the registry test) that the
 * caller supplies the base metric.
 */
'use strict';

const CAP_COST = 'analytics.cost.view';

// ── TAX BASIS OF EVERY MONEY METRIC (verified against the writers) ──────────
// A statement may only add or subtract figures that sit on the SAME basis, so
// each money metric below states which one it is on. Established by reading the
// column and the code that writes it:
//
//   metric                column              writer                       basis
//   gross_product_sales   d.gross_amount      lineAllocation.js:263 /      INCL VAT,
//                                             calculations.js:138          post-discount
//   net_ex_vat            d.net_amount        routes/sales.js:1991/:836    EX VAT,
//                                                                          post-discount
//   vat_amount            d.vat_amount        routes/sales.js:1991/:837    (is the VAT)
//   discounts_total       f.discount_total    ProjectionService.js:284 ←   INCL VAT
//                                             sales.discount_amount ←
//                                             routes/sales.js:736
//                                             appliedDiscountTotal
//   discounts_line        d.discount_amount   lineAllocation.js:264        INCL VAT
//   invoice_total         doc.total_amount    InvoiceService.js:278 ←      INCL VAT,
//                                             sales.total_final            NO fees
//   returns_net           rl.net_amount       SalesReturnService.js:92     EX VAT
//   returns_value         rl.gross_amount     SalesReturnService.js:151    INCL VAT
//   returns_vat           rl.vat_amount       SalesReturnService.js:93     (is the VAT)
//   fees_total            f.fees_amount       ProjectionService.js:284 ←   OUTSIDE the
//                                             sales.kita_service_fee       invoice total
//   rounding_total        f.rounding_amount   ProjectionService.js:284     literal 0
//
// TWO IDENTITIES THE LADDER RELIES ON, both enforced by the writers:
//   gross_product_sales === net_ex_vat + vat_amount   (gross = net + vat/line)
//   gross_product_sales === invoice_total             (lineAllocation.js:242
//                                                      refuses to project a sale
//                                                      whose lines do not sum to
//                                                      total_final)
// The second is a CONTROL, not an assumption — statement_variance measures it.
const METRICS = Object.freeze([
  // ── additive: product money (line fact) ───────────────────────────────────
  // TAX-INCLUSIVE and POST-DISCOUNT — see the basis table above. The "gross" in
  // the id is historical and means "the whole line amount", NOT "before
  // discount" and NOT "before tax". Do not subtract discounts_total from it:
  // that money is already gone, and the two live in the same (gross) space, so
  // subtracting it a second time understates sales by the discount twice over.
  {
    id: 'gross_product_sales', kind: 'additive', fact: 'line',
    sql: 'SUM(d.gross_amount)', format: 'money',
    equationKey: 'grossProductSales', version: 1,
  },
  // The FULL discount applied to the sale — line discounts AND the order-level
  // discount (routes/sales.js:736 `lineDiscCapped + invDiscCapped`), recorded in
  // GROSS (tax-inclusive) space because that is the only space the POS ever
  // computes it in (frontend/pos/src/lib/cartMath.ts). No VAT split of this
  // figure exists anywhere in the data; dividing it by (1 + rate) would invent
  // one, and would be wrong outright on a cart with zero-rated lines.
  {
    id: 'discounts_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.discount_total)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // The SAME money as discounts_total, but allocated per LINE — the only way a
  // discount column can sit beside menu_item, category, or any other line-level
  // dimension. discounts_total lives on the `order` fact, so "discount by item"
  // returned 422 ANALYTICS_UNSUPPORTED_COMBINATION even though the data was
  // already there: ar_document_lines.discount_amount is written on every sale
  // (routes/sales.js) and even aggregated by RollupService, yet no metric read
  // it. Use discounts_total for order/day/payment views; use this one whenever
  // an item-level dimension is in play.
  {
    id: 'discounts_line', kind: 'additive', fact: 'line',
    sql: 'SUM(d.discount_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // EX-VAT — the ex-VAT twin of returns_value. Pair it with net_ex_vat, never
  // with gross_product_sales.
  {
    id: 'returns_net', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.net_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // EX-VAT and POST-DISCOUNT (both the line and the order discount are already
  // out: routes/sales.js:836 scales the reconciled buckets by discountRatio).
  {
    id: 'net_ex_vat', kind: 'additive', fact: 'line',
    sql: 'SUM(d.net_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'vat_amount', kind: 'additive', fact: 'line',
    sql: 'SUM(d.vat_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'invoice_total', kind: 'additive', fact: 'order',
    sql: 'SUM(doc.total_amount)', format: 'money',
    equationKey: 'invoiceTotal', version: 1,
  },

  // ── additive: counts (order fact) ─────────────────────────────────────────
  {
    id: 'orders', kind: 'additive', fact: 'order',
    sql: 'COUNT(*)', format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'guests', kind: 'additive', fact: 'order',
    sql: 'SUM(COALESCE(f.guests, 0))', format: 'count',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'discounted_orders', kind: 'additive', fact: 'order',
    sql: 'SUM(CASE WHEN f.discount_total > 0 THEN 1 ELSE 0 END)', format: 'count',
    equationKey: 'count', version: 1,
  },

  // ── additive: quantities ──────────────────────────────────────────────────
  {
    id: 'qty_sold', kind: 'additive', fact: 'line',
    sql: 'SUM(d.base_qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'qty_returned', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.base_qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },

  // ── additive: voids / returns ─────────────────────────────────────────────
  {
    id: 'voids_count', kind: 'additive', fact: 'order',
    sql: "SUM(CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END)", format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'voids_value', kind: 'additive', fact: 'order',
    sql: "SUM(CASE WHEN f.status = 'voided' THEN doc.total_amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'returns_count', kind: 'additive', fact: 'return',
    sql: 'COUNT(DISTINCT r.id)', format: 'count',
    equationKey: 'count', version: 1,
  },
  // TAX-INCLUSIVE (SalesReturnService.js:151 `gross: money(net + vat)`) — the
  // figure to subtract from gross_product_sales / invoice_total, never from
  // net_ex_vat.
  {
    id: 'returns_value', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.gross_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // The VAT that went back out with the returned goods. sales_return_lines
  // .vat_amount has been written on every return line since the O2C return path
  // shipped (SalesReturnService.js:93, persisted at :178-183) and nothing read
  // it — so the hub could show returns EX-VAT and returns INCL-VAT but had no
  // way to bridge between them, which is exactly the step an ex-VAT statement
  // needs to reach a tax-inclusive one. Never derived from a rate.
  {
    id: 'returns_vat', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.vat_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: cost (capability-gated) ─────────────────────────────────────
  {
    id: 'cogs', kind: 'additive', fact: 'line',
    sql: 'SUM(d.cost_snapshot)', format: 'money',
    equationKey: 'sum', version: 1, requiresCap: CAP_COST,
  },
  // Cost of what came BACK. sales_return_lines.cost_snapshot has always been
  // written (SalesReturnService) but nothing read it, so every profit figure
  // silently kept the COGS of returned goods on the books — overstating cost on
  // a returned sale and understating it nowhere. Same capability gate as cogs:
  // cost is not a number every role may see.
  {
    id: 'returns_cogs', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.cost_snapshot)', format: 'money',
    equationKey: 'sum', version: 1, requiresCap: CAP_COST,
  },
  // How much of the net revenue in this window carries NO cost at all.
  //
  // cost_snapshot is written on every line, so an item with neither a recipe/BOM
  // nor a manual cost snapshots 0.00 — indistinguishable from "costs nothing".
  // Summing it into `cogs` therefore understates cost and inflates gross_profit
  // and margin_pct by exactly this much, silently. A page that groups by
  // menu_item can spot a zero-cost row itself, but at ANY coarser grain a
  // partially-costed group sums to a non-zero cost and the gap disappears —
  // which is precisely the case for the executive summary. This measures it.
  //
  // Money, not quantity: the question an owner is asking is "how much of what I
  // sold do I not know the margin on", and that is answered in riyals.
  // Same capability gate as cogs — it is a statement about cost.
  {
    id: 'uncosted_net', kind: 'additive', fact: 'line',
    sql: 'SUM(CASE WHEN COALESCE(d.cost_snapshot, 0) = 0 THEN d.net_amount ELSE 0 END)',
    format: 'money', equationKey: 'sum', version: 1, requiresCap: CAP_COST,
  },

  // ── additive: payments ────────────────────────────────────────────────────
  {
    id: 'payments_in', kind: 'additive', fact: 'payment',
    sql: "SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'refunds_out', kind: 'additive', fact: 'payment',
    sql: "SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: order-header extras ─────────────────────────────────────────
  {
    id: 'tips_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.tips_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // OUTSIDE the invoice total. f.fees_amount is `sales.kita_service_fee`
  // (ProjectionService.js:284), a legacy column the checkout persists BESIDE
  // total_final and never inside it — routes/sales.js:753 builds invTotal from
  // the line buckets alone, and :801-810 rejects the sale if the cashier's
  // displayed total differs by more than two halalas, so a fee folded into the
  // total would have failed every sale that carried one. Adding fees_total to a
  // ladder that ends at invoice_total therefore OVERSTATES it. Report it as a
  // memo figure, never as a statement operand.
  {
    id: 'fees_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.fees_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  // Structurally 0 today: ProjectionService.js:284 writes rounding_amount as a
  // literal 0 for every projected sale, and the whole-SAR rounding that used to
  // create a residual was removed at routes/sales.js:745-753. Kept because the
  // column exists and a future writer may populate it — but it may not be a
  // ladder operand while it is a constant, and it is NOT part of
  // invoice_total either.
  {
    id: 'rounding_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.rounding_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: till ────────────────────────────────────────────────────────
  {
    id: 'till_expected_cash', kind: 'additive', fact: 'till',
    sql: "SUM(CASE t.movement_type " +
      "WHEN 'open_float' THEN t.amount " +
      "WHEN 'cash_sale' THEN t.amount " +
      "WHEN 'pay_in' THEN t.amount " +
      "WHEN 'cash_refund' THEN -t.amount " +
      "WHEN 'pay_out' THEN -t.amount " +
      "ELSE 0 END)",
    format: 'money', equationKey: 'expectedCash', version: 1,
  },
  {
    id: 'till_counted', kind: 'additive', fact: 'till',
    sql: "SUM(CASE WHEN t.movement_type = 'close_count' THEN t.amount ELSE 0 END)",
    format: 'money', equationKey: 'sum', version: 1,
  },

  // ── additive: modifiers ───────────────────────────────────────────────────
  {
    id: 'modifier_lines', kind: 'additive', fact: 'modifier',
    sql: 'COUNT(*)', format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'modifier_qty', kind: 'additive', fact: 'modifier',
    sql: 'SUM(m.qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },

  // ── additive: budget ──────────────────────────────────────────────────────
  {
    id: 'budget_amount', kind: 'additive', fact: 'budget',
    sql: 'SUM(b.amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── derived (equations.js owns the arithmetic) ────────────────────────────
  {
    id: 'net_incl_vat', kind: 'derived', equationKey: 'netInclVat',
    inputs: Object.freeze(['net_ex_vat', 'vat_amount']), format: 'money', version: 1,
  },

  // ── the sales-statement ladder (each metric names ITS basis) ──────────────
  //
  // v2 — net_product_sales USED to be
  //        gross_product_sales − discounts_total − returns_net
  // which added up three different bases: an INCL-VAT post-discount figure,
  // minus an INCL-VAT discount that had ALREADY been removed from it, minus an
  // EX-VAT return. The result was neither ex-VAT nor incl-VAT and matched no
  // number anyone could reconcile — the executive statement printed exactly
  // that subtraction and asserted net_ex_vat as its result. Redefined here to a
  // single-basis subtraction; the ex-VAT twin is net_product_sales_ex_vat.
  {
    id: 'net_product_sales', kind: 'derived', equationKey: 'netSalesInclVat',
    inputs: Object.freeze(['gross_product_sales', 'returns_value']),
    format: 'money', version: 2,
  },
  {
    id: 'net_product_sales_ex_vat', kind: 'derived', equationKey: 'netSalesExVat',
    inputs: Object.freeze(['net_ex_vat', 'returns_net']),
    format: 'money', version: 1,
  },
  // Reconstructed, not stored — see equations.salesBeforeDiscount. TAX-INCLUSIVE
  // because discounts_total is, and there is no ex-VAT split of a discount
  // anywhere in the facts.
  {
    id: 'sales_before_discount', kind: 'derived', equationKey: 'salesBeforeDiscount',
    inputs: Object.freeze(['gross_product_sales', 'discounts_total']),
    format: 'money', version: 1,
  },
  // The control line: invoice headers − invoice lines. 0.00 whenever the line
  // projection ran (lineAllocation.js:242 makes it so); non-zero for a header
  // that has no lines. Shown, never absorbed.
  {
    id: 'statement_variance', kind: 'derived', equationKey: 'statementVariance',
    inputs: Object.freeze(['invoice_total', 'gross_product_sales']),
    format: 'money', version: 1,
  },
  {
    id: 'qty_net', kind: 'derived', equationKey: 'netQuantity',
    inputs: Object.freeze(['qty_sold', 'qty_returned']), format: 'qty', version: 1,
  },
  {
    id: 'avg_ticket', kind: 'derived', equationKey: 'avgTicket',
    inputs: Object.freeze(['net_ex_vat', 'orders']), format: 'money', version: 1,
  },
  {
    id: 'avg_items_per_order', kind: 'derived', equationKey: 'avgItemsPerOrder',
    inputs: Object.freeze(['qty_sold', 'orders']), format: 'ratio', version: 1,
  },
  {
    id: 'discount_pct', kind: 'derived', equationKey: 'discountPct',
    inputs: Object.freeze(['discounts_total', 'gross_product_sales']), format: 'percent', version: 1,
  },
  {
    id: 'gross_profit', kind: 'derived', equationKey: 'grossProfit',
    inputs: Object.freeze(['net_ex_vat', 'cogs']), format: 'money', version: 1,
    requiresCap: CAP_COST,
  },
  {
    id: 'margin_pct', kind: 'derived', equationKey: 'marginPct',
    inputs: Object.freeze(['net_ex_vat', 'cogs']), format: 'percent', version: 1,
    requiresCap: CAP_COST,
  },
  {
    id: 'net_collections', kind: 'derived', equationKey: 'netCollections',
    inputs: Object.freeze(['payments_in', 'refunds_out']), format: 'money', version: 1,
  },
  {
    id: 'till_variance', kind: 'derived', equationKey: 'tillVariance',
    inputs: Object.freeze(['till_counted', 'till_expected_cash']), format: 'money', version: 1,
  },
  {
    id: 'item_contribution_pct', kind: 'derived', equationKey: 'contributionPct',
    inputs: Object.freeze(['net_ex_vat', 'net_ex_vat']), format: 'percent', version: 1,
    // part = the row's group value, whole = the ungrouped total of the same
    // metric — the planner evaluates the second input WITHOUT the group-by.
    scope: 'group_vs_total',
  },
  {
    id: 'attach_rate', kind: 'derived', equationKey: 'attachRate',
    inputs: Object.freeze(['modifier_lines', 'qty_sold']), format: 'percent', version: 1,
  },
  {
    id: 'modifiers_per_item', kind: 'derived', equationKey: 'avgModifiersPerItem',
    inputs: Object.freeze(['modifier_qty', 'qty_sold']), format: 'ratio', version: 1,
  },
  {
    id: 'growth', kind: 'derived', equationKey: 'growth',
    inputs: Object.freeze([]), takesMetricParam: true, format: 'percent', version: 1,
  },
  {
    id: 'discount_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['discounted_orders', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
  {
    id: 'void_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['voids_count', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
  {
    id: 'return_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['returns_count', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
]);

const byId = Object.freeze(Object.fromEntries(METRICS.map((m) => [m.id, m])));
const additive = Object.freeze(METRICS.filter((m) => m.kind === 'additive'));
const derived = Object.freeze(METRICS.filter((m) => m.kind === 'derived'));

module.exports = { METRICS, byId, additive, derived };
