export const returnRequestDialog = {
  dialog: {
    titleForm: "Sales Return",
    titleDone: "Return request created",
  },
  done: {
    status: {
      draft: "Return request created — awaiting manager approval",
      approved: "Return created and approved — awaiting posting",
      posted: "Return created and posted",
      fallback: "Return request created (status: {status})",
      unknownStatus: "unknown",
    },
    documentNumberLabel: "Return number:",
    statusLabel: "Status:",
    noPayoutNote: "— no amount is paid out until a manager approves and posts the return.",
  },
  errors: {
    overReturn: "The requested quantity exceeds what is available to return",
    sodViolation: "You can't approve a return you created yourself.",
    createFailed: "Couldn't create the return request",
    loadInvoiceFailed: "Couldn't load the invoice details",
  },
  invoice: {
    originalLabel: "Original invoice:",
  },
  empty: {
    noReturnable: "No returnable items on this invoice",
  },
  table: {
    item: "Item",
    sold: "Sold",
    price: "Price",
    returnQty: "Return qty",
  },
  line: {
    qtyAriaLabel: "Return quantity for {name}",
    overSold: "Quantity exceeds sold",
  },
  reason: {
    label: "Return reason",
    ariaLabel: "Return reason",
    placeholder: "e.g. wrong item, customer requested cancellation…",
    requiredToast: "Return reason is required",
  },
  proportionalNote:
    "Amounts (price/tax/cost) are calculated proportionally on the server from the original invoice, and a manager approves the return before any amount is paid out.",
  actions: {
    close: "Close",
    cancel: "Cancel",
    submit: "Create return request",
  },
} as const;
