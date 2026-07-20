// English strings for ShiftDialog.tsx — same key shape as
// i18n/dictionaries/ar/shiftDialog.ts. Keep both in sync.
export const shiftDialog = {
  dialogTitle: "Shift",
  currency: "SAR",
  halala: "halalas",

  status: {
    open: "Open",
    held: "Held",
    submitted: "Awaiting payment",
    completed: "Completed",
    voided: "Voided",
  },
  method: {
    cash: "Cash",
    card: "Card",
    credit: "Credit",
  },

  noShift: {
    title: "No open shift",
    subtitle: "Open a shift to start selling — payment requires an open shift",
    openingFloatLabel: "Opening float (starting cash)",
    amountLabel: "Amount",
    openButton: "Open shift",
    openOfflineTooltip: "Opening a shift requires a server connection",
    offlineNote: "Unavailable offline",
  },

  info: {
    currentShiftLabel: "Current shift",
    byStatusHeading: "V2 orders by status",
    noOrdersYet: "No orders yet",
    completedByMethodHeading: "Completed by payment method",
    noPaymentsYet: "No payments yet",
    xReportButton: "X Report — Print",
    xReportTooltip: "Mid-shift snapshot — expected amounts by payment method",
    xReportOfflineTooltip: "The X report requires a server connection",
    closeShiftButton: "Close shift",
    closeShiftTooltip: "Start closing the shift",
    closeShiftOfflineTooltip: "Closing the shift requires a server connection",
    closeOfflineNote: "Closing the shift is unavailable offline",
  },

  table: {
    method: "Method",
    counted: "Counted",
    expected: "Expected",
    variance: "Variance",
    actual: "Actual",
    total: "Total",
  },

  closing: {
    countInstructionsPrefix: "Enter the actual counted amounts for each payment method —",
    invoiceCountSuffix: "invoices in this shift",
    openingFloatInClosing: "Opening float (included in the expected cash)",
    cashDenomHeading: "Cash count by denomination",
    denomNote: "note",
    denomCoin: "coin",
    denomCountAriaLabel: "Count of {face}",
    cashDrivenBadge: "From denomination count",
    countedAriaLabelPrefix: "Counted —",
    notCountedBadge: "Not counted",
    revealLabel: "I finished counting and entered the amounts — show the system comparison",
    revealHint: "Expected amounts stay hidden while counting, so the physical count isn't influenced by them.",
    unmatchedWarningPrefix: "Amounts unmatched to any method:",
    unmatchedWarningSuffix: "— check with management",
    notesLabel: "Closing notes",
    varianceNoteHint: "— there is a variance: explain why (at least 10 characters)",
    confirmButton: "Confirm shift close",
  },

  closed: {
    title: "Shift closed",
    totalVarianceLabel: "Total variance:",
    printZButton: "Print Z report",
    shareWhatsAppButton: "Share on WhatsApp",
    doneButton: "Done",
  },

  gate: {
    needsReveal: "Finish counting, then enable “I finished counting” first",
    needsCount: "Enter the counted amounts first",
    needsNote: "Explain the variance first (at least 10 characters)",
  },

  whatsapp: {
    title: "Shift close report (Z) —",
    cashier: "Cashier:",
    orderCount: "Order count:",
    expected: "Expected:",
    counted: "Counted:",
    variance: "Variance:",
    lineExpectedPrefix: "expected",
  },

  printBlocked: "The browser blocked the print window — allow pop-ups",
  reportLoadFailed: "Could not load the shift report",
  closeFailed: "Could not close the shift",
  closeSuccessToast: "Shift closed successfully",
} as const;
