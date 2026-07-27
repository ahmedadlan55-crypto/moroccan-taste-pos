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
    /** Cart is NOT empty: one tap holds what's in the cart, then resumes this
     *  row. The label states both halves so nothing happens by surprise. */
    holdAndResumeLabel: "Hold current & resume",
    holdAndResumeTitle: "Holds the order currently in the cart, then resumes this one",
  },

  /** Banner above the list while the cart has lines. */
  cartBusyHint: "An order is in progress in the cart — “Hold current & resume” parks it automatically before resuming any order",
  void: {
    label: "Void",
    offlineTitle: "Voiding a synced order is unavailable offline",
    title: "Void order",
    reasonPlaceholder: "Void reason (required)",
    confirm: "Confirm void",
  },
  toast: {
    resumed: "Order restored to the cart",
    heldCurrentThenResumed: "Cart order held, then the selected order was resumed",
    holdCurrentFailed: "Could not hold the current order — nothing was resumed",
    voided: "Held order voided",
  },
} as const;
