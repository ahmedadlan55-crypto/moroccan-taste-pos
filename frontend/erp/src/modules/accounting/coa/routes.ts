// ── Chart-of-Accounts route + capability constants ──────────────────────────
// One place, because seven page files and the section router all need them and
// a typo in a base path is a NotFound that only shows up on a deep link.

import type { Capability } from "@/app/permissions";

export const COA_BASE = "/accounting/chart-of-accounts";

/**
 * READ gate. The server gates GET /erp/gl/accounts on `finance.gl.view`
 * (routes/erp.js:119) — NOT on `accounting.view`, which the nav used to
 * require. An auditor holds finance.gl.view server-side (db/migrations/finance/
 * capabilities.js) and could read the chart, while the sidebar hid the screen
 * from them: the UI was strictly narrower than the API it fronts. Both gates
 * now name the same capability.
 */
export const VIEW_CAP: Capability = "finance.gl.view";

/**
 * WRITE gate. Every mutation — POST /erp/gl/accounts, …/:id/folder,
 * …/:id/move, …/import, …/dedupe, DELETE …/:id — is gated server-side on
 * `finance.accounts.manage`. `accounting.accounts.manage` (the key this screen
 * used before) is enforced by NO backend route, so it could show buttons to a
 * user the server would 403, and hide them from one it would allow.
 */
export const MANAGE_CAP: Capability = "finance.accounts.manage";
