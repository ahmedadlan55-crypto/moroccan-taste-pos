export const heldOrdersDialog = {
  title: "Held orders",
  // count-dependent noun shown after the count span
  heldCount: (n: number) => (n === 1 ? "held order" : "held orders"),
  offlineSuffix: " (local only — no connection)",
  loading: "Loading…",
  refresh: "Refresh",
  empty: {
    title: "No held orders",
    hint: "Hold an order from the cart for it to appear here",
  },
  row: {
    table: "Table",
    localBadge: "Local — not synced",
    // count-dependent noun shown after the item-count span
    itemCount: (n: number) => (n === 1 ? "item" : "items"),
    currency: "SAR",
  },
  resume: {
    label: "Resume",
    offlineTitle: "Resuming a server order requires a connection",
    title: "Resume to cart",
  },
  void: {
    label: "Void",
    offlineTitle: "Voiding a synced order is unavailable offline",
    title: "Void order",
    reasonPlaceholder: "Void reason (required)",
    confirm: "Confirm void",
  },
  toast: {
    resumeBlocked: "Hold or clear the current order before resuming another",
    resumed: "Order restored to the cart",
    voided: "Held order voided",
  },
} as const;
