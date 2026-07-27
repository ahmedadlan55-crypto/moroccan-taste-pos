/**
 * English labels for the POS-only print builders in `lib/receipt.ts`
 * (kitchen ticket + shift X/Z report). Same key shape as
 * `i18n/dictionaries/ar/receipt.ts` — keep both in sync.
 */
export const receipt = {
  kitchen: {
    docTitle: "Kitchen Ticket",
    heading: "Kitchen",
    table: "Table",
    orderType: {
      dine_in: "Dine-in",
      delivery: "Delivery",
      takeaway: "Takeaway",
    },
  },
  shift: {
    titleX: "Mid-Shift Report · X",
    titleZ: "Shift Close Report · Z",
    shift: "Shift:",
    cashier: "Cashier:",
    start: "Start:",
    end: "Closed:",
    printed: "Printed:",
    orderCount: "Order count",
    itemsCount: "Items sold",
    openingFloat: "Opening float",
    paymentMethod: "Payment method",
    expected: "Expected",
    counted: "Counted",
    variance: "Variance",
    expectedTotal: "Total expected",
    countedTotal: "Total counted",
    difference: "Difference",
    unmatched: "Unmatched to any method",
    denomFace: "Denomination",
    count: "Count",
    total: "Total",
    // W2-A — till cash movements (pay-in / pay-out) on the X/Z report. Printed
    // only when the shift has any, so an untouched drawer's report is unchanged.
    tillMovements: "Till cash movements",
    movementReason: "Reason",
    movementIn: "In",
    movementOut: "Out",
    movementNet: "Net movements",
    item: "Item",
    qty: "Qty",
    itemTotal: "Total",
    footerX: "X Report — shift still open",
    footerZ: "End of shift report",
    halala: "halalas",
    currency: "SAR",
    dash: "—",
  },
} as const;
