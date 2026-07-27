/**
 * English dictionary — App shell (the single-screen POS scaffold in App.tsx:
 * category/products/cart landmarks, the sales-channel + price-list strip, the
 * mobile cart bar, background toasts, the legacy-drain report dialog, and the
 * post-hold kitchen-ticket dialog).
 * Arabic mirror: frontend/pos/src/i18n/dictionaries/ar/appShell.ts
 */
export const appShell = {
  currency: "SAR",

  aria: {
    categories: "Categories",
    products: "Items",
    cart: "Cart",
    closeCart: "Close cart",
  },

  channel: {
    label: "Sales channel",
    base: "Default",
  },

  priceList: {
    prefix: "Prices from list:",
  },

  mobileCart: {
    label: "Cart",
  },

  /** Suspense fallback while a lazily-loaded dialog's chunk arrives. */
  dialogLoading: "Opening…",

  /** Toast stack (components/Toasts.tsx) — the error-specific affordances. */
  toastStack: {
    region: "System notifications",
    errorPersists: "Stays until dismissed",
    showOlderErrors: "and {count} more errors — show",
    hideOlderErrors: "Hide older errors",
    dismissAllErrors: "Dismiss all errors ({count})",
  },

  /** Fallback reasons written to the durable failure log (lib/failureLog.ts)
   *  when the engine hands us no message of its own. */
  failureLog: {
    checkoutFailed: "The sale could not be completed",
    legacyDrainFailed: "An operation from the legacy till could not be synced",
  },

  toast: {
    legacySynced: "Synced {count} operations from the legacy version",
    noMatch: 'No item matches "{query}"',
    held: 'Order held — you can restore it from "Held orders"',
    voided: "Order voided",
    closeShiftFirst: "Close the current shift to complete the cashier switch",
    printBlocked: "The browser blocked the print window",
  },

  voidAction: {
    syncedOfflineDisabled: "Voiding a synced order is unavailable offline",
  },

  drain: {
    title: "Legacy version sync",
    pending:
      "{count} operations from the legacy till waiting to sync — will retry once a connection is available",
    noneQueued: "No pending operations from the legacy till",
    syncedPrefix: "Synced",
    syncedSuffix: "operations from the legacy version",
    notSyncedSuffix: " — {count} were not synced and remain saved",
    rowSucceeded: "Succeeded",
    invoiceRef: " — Invoice {id}",
    unknownId: "?",
  },

  kitchen: {
    title: "Order held",
    prompt: "Print a kitchen ticket now?",
    later: "Later",
    print: "Print to kitchen",
  },
} as const;
