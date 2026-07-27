export const customerPicker = {
  currency: "SAR",
  fallbackName: "Customer",
  available: "Available {amount}",
  selected: {
    historyAria: "Customer history",
    collectAria: "Collect on account",
    clearAria: "Clear customer",
  },
  credit: {
    aria: "Credit limit",
    limit: "Credit limit",
    used: "Used",
    available: "Available",
    loadError: "Couldn't read the credit limit.",
  },
  search: {
    placeholder: "Search by name, phone, or tax number…",
    loadError: "Couldn't load customers.",
    retry: "Retry",
    loading: "Searching…",
    empty: "No matching customers.",
    newCustomer: "New customer",
  },
} as const;
