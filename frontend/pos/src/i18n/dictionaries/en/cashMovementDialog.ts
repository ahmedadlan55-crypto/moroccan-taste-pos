// English strings for CashMovementDialog.tsx — till cash movements.
// Same key shape as i18n/dictionaries/ar/cashMovementDialog.ts. Keep both in
// sync (enforced by i18n/__tests__/dictionary.test.ts).
export const cashMovementDialog = {
  dialogTitle: "Till cash movement",
  currency: "SAR",

  kind: {
    label: "Movement type",
    payIn: "Cash in",
    payOut: "Cash out",
    payInHint: "Cash entering the drawer — a float top-up or a refund back in",
    payOutHint: "Cash leaving the drawer — a drop to the safe or petty cash",
  },

  form: {
    amountLabel: "Amount",
    reasonLabel: "Reason",
    reasonPlaceholder: "Why is this cash moving?",
    reasonRequired: "A reason is required",
    noteLabel: "Note (optional)",
    submitButton: "Continue to approval",
    amountRequired: "Enter an amount greater than zero",
  },

  presets: {
    heading: "Common reasons",
    floatTopUp: "Float top-up",
    safeDrop: "Drop to the safe",
    pettyCash: "Petty cash",
    supplierCod: "Cash paid to a supplier",
    changeFund: "Change fund",
    other: "Other",
  },

  approval: {
    heading: "Manager approval",
    summaryPrefix: "About to record",
    back: "Back",
    confirmButton: "Record and approve",
  },

  list: {
    heading: "Movements on this shift",
    empty: "No cash movements recorded on this shift",
    approvedByPrefix: "approved by",
    payInTotal: "Total cash in",
    payOutTotal: "Total cash out",
    netTotal: "Net (added to expected cash)",
    loadFailed: "Could not load this shift's movements",
  },

  successToast: "Cash movement recorded",
  offlineNote: "Recording a cash movement requires a server connection",
  closeButton: "Close",
} as const;
