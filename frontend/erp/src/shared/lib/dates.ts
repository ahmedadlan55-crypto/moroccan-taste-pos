// Tier A.2 corrective gate — accounting/api.ts, banking/api.ts, and
// purchasing/requisitions/api.ts each defined their own todayISO() using
// `new Date().toISOString().slice(0, 10)`, which reads the UTC calendar
// date, not the local one. The DB connection (db/connection.js) pins every
// session to `+03:00` (Asia/Riyadh); for a user in that timezone between
// 00:00 and 02:59 local time, toISOString() still reports the PREVIOUS
// UTC day — a report or form silently defaulting to "today" would default
// to yesterday instead. frontend/pos/src/components/dialogs/
// MyInvoicesDialog.tsx already got this right with local Date components;
// this is that same pattern, centralized once instead of copied three times.

/** Local YYYY-MM-DD — never toISOString(), which reads the UTC calendar date. */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** January 1st of the current LOCAL year. */
export function startOfYearISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}
