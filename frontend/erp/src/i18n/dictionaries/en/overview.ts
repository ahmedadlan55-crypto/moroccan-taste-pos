/**
 * Overview (Home) module namespace — English mirror.
 *
 * Structural twin of frontend/erp/src/i18n/dictionaries/ar/overview.ts: identical
 * key-set and leaf shape (enforced by i18n/__tests__/dictionary.test.ts). Only
 * the translations differ.
 */
export const overview = {
  // Shared across every overview screen.
  eyebrow: "Home",
  opsHeading: "Operational balances",

  // Financial KPI tiles (KpiGrid — _common.tsx).
  kpi: {
    sales: "Sales",
    orders: "Orders",
    avgTicket: "Average ticket",
    netIncome: "Net income",
    expenses: "Expenses",
    purchases: "Purchases",
    grossMargin: "Gross margin",
  },
  // Operational balance tiles (OpsGrid — _common.tsx).
  ops: {
    pendingPayments: "Pending payments",
    arOutstanding: "Receivables outstanding",
    apOutstanding: "Payables outstanding",
  },

  // Overview (Home) screen.
  home: {
    title: "Overview",
    subtitle: "A summary of the group's financial and operational performance.",
    loadErrorTitle: "Couldn't load the dashboard",
    loadErrorBody: "We couldn't fetch the overview data right now.",
    // Quick-link card description (the label reuses tasks.title).
    quickTasksDesc: "The inbox and tasks that need your attention.",
  },

  // KPIs screen.
  kpis: {
    title: "Performance indicators",
    subtitle: "The key financial and operational indicators for the current period.",
    loadError: "Couldn't load the indicators",
  },

  // Tasks & Alerts screen.
  tasks: {
    title: "Tasks & alerts",
    subtitle: "Incoming transactions that need action from you.",
    openInbox: "Open inbox",
    emptyTitle: "No pending tasks",
    emptyBody: "The inbox is empty — nothing needs your attention right now.",
    overdueCount: "{count} overdue",
  },

  // Approvals screen.
  approvals: {
    title: "Required approvals",
    subtitle: "Transactions awaiting your approval.",
    openTxns: "Open transactions",
    awaitingCount: "{count} awaiting approval",
    emptyTitle: "No approvals required",
    emptyBody: "There are no transactions awaiting your approval right now.",
  },

  // Shared workflow-inbox list (incoming.tsx).
  inbox: {
    txnFallback: "Transaction",
    overdue: "Overdue",
  },
  // Transaction importance chips (Badge tone is set in the component).
  importance: {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
  // Workflow statuses with no canonical status.* code (rendered neutral).
  txnStatus: {
    created: "New",
    replied: "Replied",
    returned: "Returned",
  },
} as const;
