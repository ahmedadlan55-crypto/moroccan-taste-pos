export const syncReportDialog = {
  title: "Sync report",

  /** Two tabs inside the SAME overlay — no new entry in App's overlayOpen union. */
  tabs: {
    ariaLabel: "Sync report sections",
    sync: "Sync",
    failures: "Failure log",
  },

  /** Durable failure log (lib/failureLog.ts) — survives reloads, unlike the
   *  engine's in-memory lastReport shown on the first tab. */
  failures: {
    heading: "Permanently failed operations",
    hint: "A local log on this device that survives a reload — last {max} entries",
    countLabel: "recorded entries",
    empty: {
      title: "No failures recorded",
      hint: "Every operation sent to the server either succeeded or is still queued",
    },
    kind: {
      checkout: "Sale",
      sync: "Sync",
      "legacy-drain": "Legacy till",
      other: "Other",
    },
    order: "Order",
    reference: "Ref",
    cashier: "Cashier",
    currency: "SAR",
    clear: "Clear log",
    clearTitle: "Delete every recorded entry",
    clearNotAllowed: "Clearing the log requires supervisor permission",
    clearConfirm: "Confirm clear",
    clearCancel: "Cancel",
  },

  status: {
    online: "Connected to server",
    offline: "Offline",
    queueLabel: "operations awaiting sync",
  },
  sync: {
    now: "Sync now",
  },
  queue: {
    heading: "Queue",
  },
  /** The withheld-ops explanation. Deliberately says what will release them
   *  instead of offering a button — no action available to this cashier can. */
  orphans: {
    // Templates, not arrow functions. t() calls a FUNCTION leaf with a plain
    // NUMBER (I18nProvider makeT → leaf(resolvePluralArg(vars))), so a leaf
    // declared `(p: { count, who })` receives 5, not the object — and renders
    // "undefined". Only a single-number plural may be a function here.
    heading: "Held for {who} — {count} pending",
    sales: "Completed sales among them: {count}. They are stored on this device and will not be lost.",
    howTo: "They cannot be sent under your account — the server only accepts an order from the cashier who made it. Ask that cashier to sign in on this device, or sign in as a manager, and they will sync on their own.",
    byTag: "· {who}",
  },
  order: "Order",
  lastSync: "Last sync",
  empty: {
    title: "No sync yet",
    hint: "Results will appear here after the first batch",
  },
  result: {
    replayed: "Replayed",
    succeeded: "Succeeded",
    failed: "Failed",
  },
  opLabels: {
    upsert: "Save order",
    hold: "Hold",
    resume: "Resume",
    reopen: "Reopen",
    void: "Void",
    complete: "Complete",
    submitAndSale: "Pay + invoice",
  },
} as const;
