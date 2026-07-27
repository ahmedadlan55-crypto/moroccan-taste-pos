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
    /** Shown when base prices are being served while a channel is selected —
     *  this flag was computed and rendered nowhere, so the cashier rang up
     *  prices with no idea where they came from. */
    pricesUnavailable: "The selected channel's prices aren't available right now — items are ringing up at default prices",
    backToBase: "Back to default",
  },

  priceList: {
    prefix: "Prices from list:",
  },

  mobileCart: {
    label: "Cart",
  },

  /** Suspense fallback while a lazily-loaded dialog's chunk arrives. */
  dialogLoading: "Opening…",
  dialogLoadFailed: "Couldn't open that screen — check the connection and try again. Your cart is untouched.",
  dialogRetry: "Reload the page",
  dialogClose: "Close",

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
    /** A stored channel the server no longer lists — dropped, back to base.
     *  Said out loud because which price list rings up has just changed. */
    channelGone: "The saved sales channel is no longer available — prices are back to the default",
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
