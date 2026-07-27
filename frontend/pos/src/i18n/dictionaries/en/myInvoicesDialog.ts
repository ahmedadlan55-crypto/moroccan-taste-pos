export const myInvoicesDialog = {
  title: "My Invoices",

  // View switch (O2C on only) — invoices vs the returns this till raised
  views: {
    aria: "View",
    invoices: "Invoices",
    returns: "My returns",
  },
  returns: {
    tableStatus: "Status",
    tableNumber: "Return number",
    tableOriginal: "Original invoice",
    tableTotal: "Total",
    emptyTitle: "You haven't raised any return yet",
    emptyHint: "Returns you raise from My Invoices appear here with their status.",
    unavailableTitle: "Return tracking isn't available from this screen",
    unavailableHint: "The Sales & Customers module is off, or outside the cashier portal's scope.",
    loadError: "Couldn't load return statuses",
    notInWindowHint: "This return is older than the current list window",
    status: {
      draft: "Awaiting manager approval",
      approved: "Approved — awaiting posting",
      posted: "Posted",
      reversed: "Reversed",
      cancelled: "Cancelled",
      unknown: "Unknown",
    },
  },

  // Stat strip
  statTotal: "Total",
  statActive: "Active",
  statCancelled: "Cancelled",
  statReturned: "Returned",
  statAmount: "SAR",
  refresh: "Refresh",

  // Search + filter chips
  searchPlaceholder: "Search by invoice number, customer, or item…",
  filterAll: "All",
  filterActive: "Active",
  filterCancelled: "Cancelled",
  filterReturned: "Returned",

  // Body states
  offlineBanner: "Viewing invoices requires a server connection — past invoices aren't stored on the device.",
  noShiftTitle: "No open shift",
  noShiftHint: "Open a shift to view its invoices.",
  emptyTitleNoRows: "No invoices in this shift yet",
  emptyTitleNoMatch: "No matching results",
  emptyHintNoRows: "Invoices will appear here as soon as the first sale is completed.",
  emptyHintNoMatch: "Try a different search or filter.",

  // Table headers
  tableStatus: "Status",
  tableTime: "Time",
  tableInvoiceNumber: "Invoice #",
  tableProducts: "Products",
  tableTotal: "Total",
  tablePayment: "Payment",
  tableActions: "Actions",

  // Status badge (StatusBadge component)
  badgeCancelled: "Cancelled",
  badgeReturned: "Returned",
  badgeActive: "Active",

  // Row actions
  printButton: "Print",
  printTooltip: "Reprint the invoice (with the stamped ZATCA code)",
  voidButton: "Void",
  returnButton: "Return",
  reversedNoActions: "Done — no actions",

  // Manager approval dialog wiring
  voidApprovalTitle: "Approve invoice void",
  returnApprovalTitle: "Approve return",
  returnReasonLabel: "Return reason",
  returnDefaultReason: "Customer return",

  // Toasts
  voidSuccessToast: "Invoice voided",
  returnSuccessToast: "Return recorded (credit note)",
  // See ar/myInvoicesDialog.ts for why this is its own key rather than
  // errors.O2C_MODULE_ACTIVE.
  o2cModuleActiveToast: "Void and return have moved to the Sales & Customers module — not available from the cashier right now.",
  popupBlocked: "The browser blocked the print window — allow pop-ups",
  reprintLoadFailed: "Couldn't load the invoice for printing",
  reprintFailed: "Couldn't print the invoice",

  // Reprint reversal stamps (reprintHtmlFromInvoice) — English-only here; the
  // Arabic dictionary keeps the bilingual legacy stamp for the printed receipt.
  stampVoided: "VOIDED",
  stampReturned: "RETURNED",
} as const;
