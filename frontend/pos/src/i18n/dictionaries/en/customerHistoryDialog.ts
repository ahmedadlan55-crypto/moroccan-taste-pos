export const customerHistoryDialog = {
  title: "Customer history",
  titleWithName: "Customer history — {name}",
  loadError: "Failed to load history",
  currency: "SAR",

  // KPI strip
  kpi: {
    totalSpentLabel: "Total purchases",
    orderCountLabel: "Invoices",
    orderCountUnit: "invoice",
    avgInvoiceLabel: "Average invoice",
    lastVisitLabel: "Last visit",
  },

  // Meta line
  meta: {
    firstVisitLabel: "First visit:",
  },

  // سند قبض — collection on account (draft only)
  collect: {
    open: "Collect on account",
    title: "Customer collection",
    amountLabel: "Amount (SAR)",
    destinationLabel: "Collected into",
    destinationCash: "Cash",
    destinationBank: "Bank",
    referenceLabel: "Reference",
    referencePlaceholder: "Receipt or transfer number",
    notesLabel: "Notes",
    submit: "Record collection",
    cancel: "Cancel",
    another: "Another collection",
    doneTitle: "Collection recorded as a draft",
    documentNumberLabel: "Document number:",
    draftNote: "A draft awaiting the manager's approval and posting — no balances have moved yet.",
    unavailable: "Recording collections is not available from this screen.",
    failed: "Couldn't record the collection",
  },

  // Empty state
  empty: {
    title: "No previous invoices for this customer",
    hint: "Complete a sale now to record the first invoice.",
  },

  // Recent purchases table headers
  table: {
    date: "Date",
    invoiceNumber: "Invoice number",
    total: "Total",
    payment: "Payment",
    status: "Status",
  },

  // Invoice status badges (invoiceBadge → labelKey)
  badge: {
    cancelled: "Cancelled",
    returned: "Returned",
    adjusted: "Adjusted",
    partiallyReturned: "Partially returned",
    completed: "Completed",
  },
} as const;
