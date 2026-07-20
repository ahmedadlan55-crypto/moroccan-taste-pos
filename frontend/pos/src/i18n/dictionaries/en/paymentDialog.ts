// English strings for PaymentDialog.tsx — method tabs, cash/split tender,
// owner-method notes, checkout progress, timeout/success screens.
export const paymentDialog = {
  title: "Payment",
  currency: "SAR",

  totalDue: "Total due",
  noShiftOpen: "Payment requires an open shift — open a shift first from the top bar",

  methodTablistLabel: "Payment method",
  methodCash: "Cash",
  methodCard: "Card",
  methodSplit: "Split",
  methodCredit: "Credit",
  cardOfflineTip: "Card payment is unavailable offline",
  splitOfflineTip: "Split payment is unavailable offline",
  creditOfflineTip: "Credit sales are unavailable offline",
  creditNeedsSupervisorTip: "Credit sales require a supervisor/manager",
  ownerMethodOfflineTip: "Additional payment methods are unavailable offline",

  offlineBanner: "You're offline — cash only, the sale will sync when the connection returns",

  exactAmount: "Exact amount",
  tenderedLabel: "Received from customer (SAR)",
  insufficientAmount: "Insufficient amount",
  changeDueLabel: "Change due",
  changeDueLabelColon: "Change due:",

  splitSumMatches: "Total matches",

  cardCollectInfoPrefix: "Collect",
  cardCollectInfoSuffix: "via the card terminal, then confirm",

  creditInfoPrefix: "Credit sale of",
  creditInfoSuffix: "— recorded to the customer's account (requires supervisor permission)",

  ownerCollectInfoMiddle: 'via "',
  ownerCollectInfoSuffix: '", then confirm',

  ownerNoteLabelPrefix: 'Payment notes — reason for choosing "',
  ownerNoteLabelSuffix: '" (required)',
  ownerNotePlaceholder: "e.g. Bank transfer — receipt no. 123",
  paymentNotesAriaLabel: "Payment notes",
  noteTooShortWarning: "Write at least 3 characters describing the payment — the server rejects \"other\" without a note",

  creditBlockedWarning: "Credit sales require a customer — pick a customer from the cart first",

  confirmButtonPrefix: "Confirm payment —",

  stageSubmit: "Submitting order…",
  stageSale: "Recording invoice…",
  stageComplete: "Completing order…",

  timeoutTitle: "Request timed out — check your connection then retry",
  timeoutBody:
    "The order was not cancelled — the sale may have reached the server despite the missing response. Retrying is safe: if the sale already went through it won't be duplicated (guarded against duplicates), and you can also check \"My Invoices\".",
  // closeButton / retryButton intentionally omitted — reuse common.close /
  // common.retry (exact same text), per the i18n contract's dedup rule.

  queuedTitle: "Order saved — will sync when the connection returns",
  localRefLabel: "Local reference:",
  successTitle: "Payment successful",
  invoiceLabel: "Invoice:",

  printReceiptButton: "Print receipt",
  printKitchenButton: "Print for kitchen",
  newOrderButton: "New order",
  printBlockedFull: "The browser blocked the print window — allow pop-ups",
  printBlockedShort: "The browser blocked the print window",

  failedDefault: "Payment failed",
} as const;
