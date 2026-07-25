export const customerPicker = {
  currency: "SAR",
  fallbackName: "Customer",
  available: "Available {amount}",
  selected: {
    historyAria: "Customer history",
    clearAria: "Clear customer",
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
