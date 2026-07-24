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
