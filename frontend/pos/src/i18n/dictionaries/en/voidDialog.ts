export const voidDialog = {
  title: "Void order",
  description: "The current order and all its lines will be voided. A void reason is required.",
  reason: {
    label: "Void reason",
    placeholder: "e.g. Customer requested cancellation before preparation",
  },
  actions: {
    cancel: "Back",
    confirm: "Confirm void",
  },
} as const;
