/**
 * POS-administration module namespace — English mirror (Sprint 3 · Phase C).
 *
 * Structural twin of frontend/erp/src/i18n/dictionaries/ar/posAdmin.ts: identical
 * key-set and leaf shape (enforced by i18n/__tests__/dictionary.test.ts). Only
 * the translations differ.
 */
export const posAdmin = {
  // ── Payment-method group codes (cash | electronic | …) ────────────────────
  pmGroup: {
    cash: "Cash",
    electronic: "Electronic",
    voucher: "Voucher",
    loyalty: "Loyalty",
    transfer: "Transfer",
    other: "Other",
  },
  // ── Service-fee type codes (none | percent | fixed) ───────────────────────
  feeType: {
    none: "No fee",
    percent: "Percentage %",
    fixed: "Fixed amount",
  },
  // ── Shift OPEN/CLOSED status + balance chips ──────────────────────────────
  shift: {
    open: "Open",
    closed: "Closed",
    balanced: "Balanced",
    diffAmount: "Diff {amount}",
  },
  // ── Repeated financial / table column headers ─────────────────────────────
  col: {
    order: "Order",
    name: "Name",
    group: "Group",
    fee: "Service fee",
    shiftClose: "Shift close",
    date: "Date",
    cashier: "Cashier",
    start: "Shift start",
    close: "Close",
    expected: "Expected",
    actual: "Actual",
    diff: "Difference",
    method: "Payment method",
  },
  // ── Register / payment-methods screen ─────────────────────────────────────
  register: {
    launcherTitle: "Open the register",
    launcherDesc:
      "The payment methods defined here appear directly on the cashier screen. To start selling, open the POS application.",
    launcherCta: "Open the cashier screen",
    heading: "Payment methods",
    subtitle: "Manage the payment methods that drive the cashier and shift close.",
    searchPlaceholder: "Search by name…",
    emptyTitle: "No payment methods",
    emptyBody: "Add the first payment method so it appears on the cashier screen.",
    groupAll: "All groups",
    newMethod: "New payment method",
    enabled: "Enabled",
    disabled: "Disabled",
    deleteTitle: "Delete payment method",
    deleteBody: "“{name}” will be deleted. Past sales will not be affected.",
    saveFailed: "Save failed",
    deleteFailed: "Delete failed",
  },
  // ── Create / edit payment-method dialog ───────────────────────────────────
  dialog: {
    editTitle: "Edit payment method",
    newTitle: "New payment method",
    desc: "Set the method's details, fees and properties — payment methods drive the cashier screen.",
    nameAr: "Name in Arabic",
    nameEn: "Name in English",
    sortOrder: "Display order",
    feeType: "Fee type",
    feeValue: "Fee value",
    flagsLegend: "Properties",
    description: "Description",
    flags: {
      isActive: "Enabled in the system",
      showInShiftClose: "Show in shift close",
      showInReports: "Show in reports",
      allowManualTotal: "Allow manual total",
      requireReference: "Requires a reference",
      requireTransactionNumber: "Requires a transaction number",
      requireTerminal: "Requires a terminal",
      allowRefund: "Allows refunds",
      allowCancel: "Allows cancellation",
    },
  },
  // ── Payment-method form validation ────────────────────────────────────────
  valid: {
    nameArRequired: "Name in Arabic is required",
    nameTooLong: "The name is too long",
    numberInvalid: "Enter a valid number",
    notNegative: "Cannot be negative",
    descTooLong: "The description is too long",
  },
  // ── Shifts review screen ──────────────────────────────────────────────────
  shifts: {
    subtitle:
      "Review cashier shifts — expected vs. actual and the differences. Click any shift to view its payment-method breakdown.",
    emptyTitle: "No shifts",
    emptyBody: "No shifts match the selected filters.",
  },
  // (The cashier shift-close reports screen was retired → /reports/sales/shifts;
  //  its reports.* keys went with it.)
  // ── Shift filter bar (date range / cashier / status) ──────────────────────
  filters: {
    from: "From",
    to: "To",
    fromDateAria: "From date",
    toDateAria: "To date",
    cashierAll: "All cashiers",
    statusAll: "All statuses",
  },
  // ── Per-shift detail drawer ───────────────────────────────────────────────
  drawer: {
    eyebrow: "Shift details",
    titleFallback: "Shift",
    orderCount: "Invoice count",
    endLabel: "Shift end",
    openingFloat: "Opening float",
    breakdownTitle: "Breakdown by payment method",
    emptyTitle: "No breakdown data",
    emptyBody: "The server recorded no payment-method breakdown for this shift.",
  },
  // ── "Managed from the cashier" deferred notices ───────────────────────────
  deferred: {
    parkedTitle: "Held orders are managed from the cashier",
    parkedBody:
      "Held orders (temporarily saved) are a runtime state that lives inside the POS application and have no back-office data source — complete them from the cashier screen.",
    deviceTitle: "Device sync is managed from the cashier",
    deviceBody:
      "POS device sync runs inside the cashier application on each device, and the back-office has no endpoint to control it — open the POS application to sync.",
    openPos: "Open the POS application",
  },
} as const;
