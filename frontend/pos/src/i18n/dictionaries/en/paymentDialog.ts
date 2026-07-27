// English strings for PaymentDialog.tsx — method tabs, cash/split tender,
// owner-method notes, checkout progress, timeout/success screens.
export const paymentDialog = {
  title: "Payment",
  currency: "SAR",

  totalDue: "Total due",
  noShiftOpen: "Payment requires an open shift — open a shift first from the top bar",
  openShiftButton: "Open a shift now",

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
  // Fill-remainder: the cashier used to compute «total − the other legs» in
  // their head and type it digit by digit while the banner flashed red.
  splitRemaining: "Remaining: {amount}",
  splitFillRemainderAria: "Fill the remaining amount into the highlighted field",

  // Reference/approval number — the pad drives this on Card and on owner
  // methods that come with a slip (bank/wallet/cheque…).
  referenceLabel: "Terminal / approval number (optional)",
  referencePlaceholder: "From the terminal slip",
  referenceNotePrefix: "Ref: ",

  // One-line hint under the ALWAYS-PRESENT keypad, saying what it types now.
  padHint: {
    cash: "The keypad types the amount received",
    split: "The keypad types into the highlighted field",
    reference: "The keypad types the reference number",
    inertCredit: "A credit sale posts the full total to the customer's account — no number to enter",
    inertNote: "This method needs the written note above — no numeric entry",
    inertFixed: "The amount is fixed at the invoice total — no number to enter",
  },

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
