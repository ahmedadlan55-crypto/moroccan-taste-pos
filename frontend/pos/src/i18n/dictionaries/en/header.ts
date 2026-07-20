/**
 * English dictionary — Header (brand, cashier identity, shift chip,
 * connection status, quick-action buttons, and the collapsible «More» panel).
 * Arabic mirror: frontend/pos/src/i18n/dictionaries/ar/header.ts
 */
export const header = {
  roles: {
    admin: "System Admin",
    manager: "Manager",
    cashier: "Cashier",
    custody: "Custodian",
    employee: "Employee",
    accountant: "Accountant",
    finance: "Finance",
    sales: "Sales",
  },
  roleFallback: "Cashier",
  brandFallback: "Moroccan Taste",
  unknownUser: "Unknown user",

  connection: {
    syncing: "Syncing",
    online: "Online",
    offline: "Offline",
    queueTitle: "Operations waiting to sync",
    reportTitle: "View sync report",
  },

  /** English mirror of ar/header.ts staleAge — see that file for the
   *  bucketing contract (receives whole hours; owns the day branch). */
  staleAge: (h: number): string => {
    if (h < 1) return "less than an hour";
    if (h < 24) return h === 1 ? "1 hour" : `${h} hours`;
    const d = Math.floor(h / 24);
    return d === 1 ? "1 day" : `${d} days`;
  },

  staleCatalog: {
    unknownAge: "unknown",
    titleOnline: "Item list unconfirmed — tap to reload",
    titleOffline: "Item list saved locally and unconfirmed — will refresh once back online",
    label: "Stale list",
  },

  pwa: {
    drainTitle: "Operations from the legacy till waiting to sync",
    legacyLabel: "Legacy",
    updateTitle: "A new app version is available",
    updateAction: "New version — Update",
    installTitle: "Install the till as an app on this device",
    installAction: "Install app",
  },

  shift: {
    loading: "Shift…",
    detailsTitle: "Shift details / close",
    chipLabel: "Shift",
    none: "No shift",
    openTitle: "Open a new shift",
    openTitleOffline: "Opening a shift requires a server connection",
    openAction: "Open shift",
  },

  quickActions: {
    ariaLabel: "Cashier quick actions",
    myInvoices: "My invoices",
    myInvoicesTitle: "Current shift's invoices",
    stocktake: "Stocktake",
    requisitions: "Requisitions",
    requisitionsTitle: "Request missing stock & receive",
  },

  more: {
    label: "More",
    systemStatusHeading: "Device & system status",
    switchCashier: "Switch cashier",
    switchCashierTitle: "Switch cashier — requires closing the open shift first",
    backToSystem: "Back to main system",
  },

  languageToggle: {
    ariaLabel: "Change interface language",
    switchToEnglish: "EN",
    switchToArabic: "عربي",
  },
};
