// ── Chart of Accounts (دليل الحسابات) ────────────────────────────────────────
// The screen is no longer one page: it is a seven-route section (list, create,
// detail, edit, move, health, import), each a REAL URL that survives a refresh.
// The routing lives in ../coa/index.tsx; this file keeps the historical export
// name so the module dispatcher and existing imports are untouched.

export { ChartOfAccountsSection as ChartOfAccountsPage } from "../coa";
export { ChartOfAccountsSection as default } from "../coa";
