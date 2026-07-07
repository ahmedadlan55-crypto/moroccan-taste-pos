// Centralized TanStack Query keys for the Order-to-Cash app. One namespace
// ("orderToCash") so invalidation is precise and collision-free.

export const qk = {
  all: ["orderToCash"] as const,
  version: ["server-flags"] as const,
  dashboard: () => [...qk.all, "dashboard"] as const,

  customers: (params?: unknown) => [...qk.all, "customers", "list", params ?? {}] as const,
  customerSearch: (q?: string) => [...qk.all, "customers", "search", q ?? ""] as const,
  customer: (id: string) => [...qk.all, "customers", "detail", id] as const,
  customer360: (id: string) => [...qk.all, "customers", "360", id] as const,
  customerStatement: (id: string, from?: string, to?: string) => [...qk.all, "customers", "statement", id, from ?? "", to ?? ""] as const,
  customerExposure: (id: string) => [...qk.all, "customers", "exposure", id] as const,

  orders: (params?: unknown) => [...qk.all, "orders", "list", params ?? {}] as const,
  order: (id: string) => [...qk.all, "orders", "detail", id] as const,

  invoices: (params?: unknown) => [...qk.all, "invoices", "list", params ?? {}] as const,
  invoice: (id: string) => [...qk.all, "invoices", "detail", id] as const,
  invoiceSearch: (q?: string, customerId?: string) => [...qk.all, "invoices", "search", q ?? "", customerId ?? ""] as const,

  payments: (params?: unknown) => [...qk.all, "payments", "list", params ?? {}] as const,
  payment: (id: string) => [...qk.all, "payments", "detail", id] as const,

  returns: (params?: unknown) => [...qk.all, "returns", "list", params ?? {}] as const,
  return: (id: string) => [...qk.all, "returns", "detail", id] as const,

  reports: (type: string, params?: unknown) => [...qk.all, "reports", type, params ?? {}] as const,
  reportTypes: () => [...qk.all, "reports", "types"] as const,
  reconcile: () => [...qk.all, "reconcile"] as const,
};
