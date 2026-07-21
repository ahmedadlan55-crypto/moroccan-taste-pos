/** English mirror of the record-status labels. Keyed by the SAME stable status
 *  code as the Arabic twin (frontend/erp/src/i18n/dictionaries/ar/status.ts);
 *  <StatusBadge> renders t("status."+code). Keep the key set identical to ar
 *  (enforced by the dictionary parity test). */
export const status = {
  // healthy / done
  available: "Available",
  good: "Good",
  received: "Received",
  approved: "Approved",
  paid: "Paid",
  posted: "Posted",
  active: "Active",
  safe: "Safe",
  // warning / pending
  low: "Low",
  monitor: "Monitoring",
  pendingApproval: "Pending approval",
  underReview: "Under review",
  matchRequired: "Match required",
  due: "Due",
  sent: "Sent",
  quarantined: "Quarantined",
  warning: "Warning",
  // in-flight
  inTransit: "In transit",
  transferring: "In transfer",
  counting: "Counting",
  inProgress: "In progress",
  partiallyReceived: "Partially received",
  // danger / terminal
  outOfStock: "Out of stock",
  negative: "Negative",
  critical: "Critical",
  reversed: "Reversed",
  recalled: "Recalled",
  expired: "Expired",
  overdue: "Overdue",
  rejected: "Rejected",
  // neutral / inactive
  cancelled: "Cancelled",
  disabled: "Disabled",
  closed: "Closed",
  noPermission: "No access",
  draft: "Draft",
} as const;
