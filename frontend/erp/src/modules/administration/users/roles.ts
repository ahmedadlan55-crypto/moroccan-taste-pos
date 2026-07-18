// Assignable user roles — MIRRORS the backend catalog (lib/roles.js:
// ASSIGNABLE_ROLES + ROLE_LABELS_AR) exactly. The server 400s any role outside
// this set ("الدور غير صالح"), so `auditor`/`developer` (grant-only / not a role)
// are deliberately absent — the previous ROLE_OPTS listed both and every save
// with them was silently rejected. Labels are copied verbatim from
// ROLE_LABELS_AR — do not invent new Arabic copy here.
export interface RoleOption {
  value: string;
  label: string;
}

export const ROLE_OPTS: RoleOption[] = [
  { value: "admin", label: "مدير النظام" },
  { value: "manager", label: "مدير" },
  { value: "cashier", label: "كاشير" },
  { value: "custody", label: "أمين عهدة" },
  { value: "accountant", label: "محاسب" },
  { value: "finance", label: "مالية" },
  { value: "sales", label: "مبيعات" },
  { value: "employee", label: "موظف" },
];

/** The bare role values the server accepts (for zod enum + guards). */
export const ASSIGNABLE_ROLES = ROLE_OPTS.map((r) => r.value);

export const ROLE_LABEL = new Map(ROLE_OPTS.map((r) => [r.value, r.label]));
