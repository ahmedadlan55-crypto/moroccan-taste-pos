/** App-shell UI copy (English) — English mirror of dictionaries/ar/shell.ts.
 *  Identical key shape (enforced by the dictionary parity test). */
export const shell = {
  brand: {
    name: "Moroccan Taste",
    tagline: "Unified Management",
  },
  identity: {
    guest: "Guest",
    unregistered: "Not signed in",
  },
  roles: {
    admin: "System Admin",
    developer: "Developer",
    manager: "Supervisor",
    employee: "Employee",
    custody: "Custodian",
    cashier: "Cashier",
    auditor: "Auditor",
    sales: "Sales Rep",
    accountant: "Accountant",
    finance: "Finance",
  },
  languageToggle: {
    ariaLabel: "Switch interface language",
    switchToEnglish: "English",
    switchToArabic: "عربي",
  },
  sidebar: {
    ariaLabel: "Sidebar",
    nav: "Main navigation",
    expandRail: "Expand sidebar",
    collapseRail: "Collapse sidebar",
    collapse: "Collapse menu",
    expandGroup: "Expand {group} pages",
    collapseGroup: "Collapse {group} pages",
  },
  topbar: {
    toolsOpen: "Open search and scope",
    toolsClose: "Close search and scope",
    toolsLabel: "Search & scope",
  },
  breadcrumbs: {
    ariaLabel: "Breadcrumb",
  },
  search: {
    open: "Search and quick navigation (Ctrl+K)",
    placeholder: "Search and quick navigation…",
  },
  commandPalette: {
    ariaLabel: "Command palette",
    inputPlaceholder: "Search for a screen or jump to it…",
    inputAriaLabel: "Search screens",
    noResults: "No matching results",
  },
  notifications: {
    label: "Notifications",
    heading: "Notifications",
    empty: "No new notifications",
  },
  approvals: {
    label: "Pending approvals",
    heading: "Pending approvals",
    empty: "No pending approvals",
    openInbox: "Open inbox",
  },
  userMenu: {
    label: "User account",
    selfService: "Self service",
    logout: "Sign out",
  },
  scope: {
    groupLabel: "Data scope",
    company: "Company",
    branch: "Branch",
    selectCompany: "Select company",
    selectBranch: "Select branch",
    allCompanies: "All companies",
    allBranches: "All branches",
  },
  appShell: {
    skipToContent: "Skip to content",
    mainContent: "Main content",
  },
  mobileNav: {
    ariaLabel: "Quick navigation",
  },
  notFound: {
    title: "Page not found",
    body: "There's no section at this path. Go back to Overview and continue from the sidebar.",
    back: "Back to Overview",
  },
} as const;
