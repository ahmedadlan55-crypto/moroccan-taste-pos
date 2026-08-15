/** English mirror of the "misc" namespace (Reports center + Customers domain).
 *  Keep the key set identical to ar/misc.ts (enforced by the dictionary parity
 *  test). Business DATA is never here — only chrome/copy. */
export const misc = {
  reports: {
    eyebrow: "Reports",
    directory: {
      open: "Open report",
      empty: "No reports available",
    },
    // The financial report families — read by FinancialReportsDirectory.
    groups: {
      financialStatements: { title: "Financial statements" },
      ledgerControl: { title: "Ledger and balances" },
      receivablesPayables: { title: "Receivables and valuation" },
      // The People / Operations report families moved to
      // operationalReports.groups.*, alongside the registries that build them.
    },
    // Section headings. Inventory/purchasing/sales/receivables carry their own
    // (warehouseIntelligence.*, salesReports.*, receivablesReports.*).
    sections: {
      financial: {
        title: "Financial Reports",
      },
      people: {
        title: "Employee Reports",
        subtitle: "Employees, attendance, payroll, and leaves.",
      },
      operations: {
        title: "Operations Reports",
        subtitle: "Shifts, point of sale, and the action log.",
      },
    },
    // The eleven financial report names — read by the /reports/financial registry.
    // The inv*/pur*/ppl*/ops* links are gone: each opened a CRUD workspace
    // outside the reports section, and glSalesPosting went with them because
    // sales posting writes journals — it is not a report.
    links: {
      glGeneralLedger: { label: "General Ledger" },
      glTrialBalance: { label: "Trial Balance" },
      glIncomeStatement: { label: "Income Statement" },
      glBalanceSheet: { label: "Balance Sheet" },
      glCashFlow: { label: "Cash Flow" },
      glEquityChanges: { label: "Changes in Equity" },
      glFinancialRatios: { label: "Financial Ratios" },
      glArAging: { label: "AR Aging" },
      glApAging: { label: "AP Aging" },
      glProfitability: { label: "Profitability Analysis" },
      glInventoryValuation: { label: "Inventory Valuation" },
    },
    saved: {
      title: "Saved Reports",
      subtitle: "The views you saved from tables across the system.",
      emptyTitle: "No saved reports",
      emptyBody: "Save a view from any table (the “{menu}” button) to see it here.",
      badge: "Saved view",
      source: "Source",
      deleteView: "Delete {name}",
      tableLabels: {
        "admin-companies": "Companies",
        "admin-brands": "Brands",
        "admin-branches": "Branches",
        "admin-users": "Users",
        "admin-payment-methods": "Payment methods",
        "admin-audit-log": "Audit log",
        "admin-vat-reports": "VAT returns",
      },
    },
  },

  customers: {
    eyebrow: "Customers",
    types: { B2C: "Individuals", B2B: "Companies", B2G: "Government" },
    list: {
      title: "Customer Registry",
      subtitle: "Search and filter customers and manage credit limits.",
      newCustomer: "New customer",
      searchPlaceholder: "Search by name, phone, or VAT number…",
      emptyTitle: "No matching customers",
      emptyBody: "Try adjusting your search or add a new customer.",
      editAria: "Edit customer",
      filterByStatus: "Filter by status",
      filterByType: "Filter by type",
      filter: {
        active: "Active",
        inactive: "Inactive",
        allTypes: "All types",
      },
      col: {
        name: "Customer",
        phone: "Phone",
        type: "Type",
        creditLimit: "Credit limit",
        balance: "Balance",
      },
    },
    detail: {
      back: "Back to customers",
      eyebrow: "{type} customer",
      statement: "Statement",
      recordCollection: "Record collection",
      metric: {
        balance: "Balance (AR)",
        creditLimit: "Credit limit",
        exposure: "Credit exposure",
        utilization: "{pct}% used",
        available: "Available",
      },
      recentInvoices: "Recent invoices",
      invCol: {
        invoice: "Invoice",
        date: "Date",
        remaining: "Remaining",
      },
      agingTitle: "AR aging (by due date)",
      aging: { current: "Current" },
      total: "Total",
      summary: "Summary",
      stat: {
        openInvoices: "Open invoices",
        openBalance: "Open balance",
        collectionsCount: "Collections count",
        collectionsTotal: "Total collections",
        unappliedCredit: "Unapplied credit",
        paymentTerms: "Payment terms",
        firstDeal: "First deal",
        lastDeal: "Last deal",
      },
      daysValue: "{days} days",
      topProducts: "Top products (after returns)",
    },
    statement: {
      title: "Statement — {name}",
      opening: "Opening balance",
      closing: "Closing balance",
      print: "Print",
      col: {
        date: "Date",
        ref: "Reference",
        type: "Type",
        movement: "Movement",
        balance: "Balance",
      },
      kind: {
        payment: "Collection",
        creditNote: "Credit note",
        invoice: "Invoice",
      },
    },
    form: {
      newEyebrow: "New customer",
      editEyebrow: "Edit customer",
      addTitle: "Add customer",
      saveCustomer: "Save customer",
      saveChanges: "Save changes",
      selectNone: "None",
      section: {
        entity: "Entity & tax registration",
        address: "Address",
        salesDefaults: "Sales defaults (optional)",
      },
      field: {
        name: "Name",
        nameAria: "Customer name",
        nameEn: "English name",
        phone: "Phone",
        vatRegistration: "VAT registration",
        vatNumber: "VAT number",
        city: "City",
        district: "District",
        postalCode: "Postal code",
        street: "Street",
        buildingNumber: "Building number",
        additionalNo: "Additional number",
        revenueAccount: "Default revenue account",
        revenueCostCenter: "Default revenue cost center",
        email: "Email",
        customerType: "Customer type",
        creditLimit: "Credit limit",
        paymentTerms: "Payment terms",
        creditDays: "Credit days",
      },
      vat: {
        registered: "VAT registered",
        unregistered: "Not registered",
      },
      type: {
        b2c: "Individuals B2C",
        b2b: "Companies B2B",
        b2g: "Government B2G",
      },
      hint: {
        optional: "Optional",
        creditLimit: "0 = credit sales not allowed",
        paymentTerms: "Cash = cash only",
      },
      validation: {
        nameRequired: "Customer name is required",
        vatDigits: "VAT number must be 15 digits",
        emailInvalid: "Invalid email",
        notNegative: "Cannot be negative",
      },
    },
  },
} as const;
