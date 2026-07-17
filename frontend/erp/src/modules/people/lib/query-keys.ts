// Centralized TanStack Query keys for the People / HR domain. One namespace
// ("people") so invalidation stays precise and collision-free with the other
// unified-app modules.

export const qk = {
  all: ["people"] as const,

  employees: (params?: unknown) => [...qk.all, "employees", "list", params ?? {}] as const,
  employee: (id: string) => [...qk.all, "employees", "detail", id] as const,
  departments: () => [...qk.all, "departments"] as const,
  jobTitles: () => [...qk.all, "job-titles"] as const,
  advances: (params?: unknown) => [...qk.all, "advances", params ?? {}] as const,

  attendance: (params?: unknown) => [...qk.all, "attendance", params ?? {}] as const,
  exceptions: (params?: unknown) => [...qk.all, "exceptions", params ?? {}] as const,
  holidays: (year: number) => [...qk.all, "holidays", year] as const,
  weeklyOff: () => [...qk.all, "weekly-off"] as const,

  shifts: () => [...qk.all, "shifts"] as const,
  overtimeEntries: (params?: unknown) => [...qk.all, "overtime-entries", params ?? {}] as const,
  overtimeRules: () => [...qk.all, "overtime-rules"] as const,

  leaveRequests: (params?: unknown) => [...qk.all, "leave-requests", params ?? {}] as const,
  leaveTypes: () => [...qk.all, "leave-types"] as const,

  orgTree: () => [...qk.all, "org-tree"] as const,
  custodies: () => [...qk.all, "custody", "list"] as const,
  custody: (id: string) => [...qk.all, "custody", "detail", id] as const,
  custodyExpenses: (params?: unknown) => [...qk.all, "custody", "expenses", params ?? {}] as const,
  custodyUsers: () => [...qk.all, "custody", "users"] as const,
  custodyPending: () => [...qk.all, "custody", "pending"] as const,
  myCustody: () => [...qk.all, "custody", "mine"] as const,
  myCustodyHistory: () => [...qk.all, "custody", "mine", "history"] as const,
  glAccounts: () => [...qk.all, "gl-accounts"] as const,
  costCenters: () => [...qk.all, "cost-centers"] as const,

  myProfile: () => [...qk.all, "self", "profile"] as const,
  myAttendance: (params?: unknown) => [...qk.all, "self", "attendance", params ?? {}] as const,
  myLeaveBalances: () => [...qk.all, "self", "leave-balances"] as const,
  myLeaveRequests: () => [...qk.all, "self", "leave-requests"] as const,
};
