export const discountDialog = {
  title: "Order discount",
  presets: {
    label: "Quick discounts",
    minOrder: "Order minimum {amount} SAR",
    needsApproval: "This discount needs manager authority",
    codeLabel: "Promo code — {name}",
    codePlaceholder: "Type the code",
    codeApply: "Confirm code",
    codeCancel: "Cancel",
    codeWrong: "Wrong code",
    cappedNote: "Capped at {amount} SAR by the campaign settings",
  },
  type: {
    aria: "Discount type",
    percent: "Percentage %",
    fixed: "Amount SAR",
  },
  value: {
    percentLabel: "Percentage (0–100)",
    fixedLabel: "Amount (capped at {amount})",
    keypadHint: "The keypad types the discount value",
  },
  name: {
    label: "Discount name",
    placeholder: "Opening offer, staff…",
  },
  summary: {
    discountValue: "Discount value",
    totalAfter: "Total after discount",
  },
  overCeiling: {
    before: "Discount",
    between: "% exceeds the cashier limit (",
    after: "%) — the server will reject it at checkout without a manager",
  },
  actions: {
    remove: "Remove discount",
    apply: "Apply discount",
  },
} as const;
