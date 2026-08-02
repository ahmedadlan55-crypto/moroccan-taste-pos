// ── The Chart-of-Accounts section router ────────────────────────────────────
// The manifest leaf `ac-coa` sets subRoutes:true, so app/router.tsx registers
// BOTH `/accounting/chart-of-accounts` and `.../*` against the accounting
// module. That module prefix-dispatches into here, and here resolves the seven
// real URLs:
//
//   /accounting/chart-of-accounts             list (tree ⇄ table)
//   /accounting/chart-of-accounts/new         create        (full page)
//   /accounting/chart-of-accounts/health      diagnostics
//   /accounting/chart-of-accounts/import      bulk import
//   /accounting/chart-of-accounts/:id         detail
//   /accounting/chart-of-accounts/:id/edit    edit          (full page)
//   /accounting/chart-of-accounts/:id/move    reparent      (full page)
//
// Ids come from the RAW pathname, never a lower-cased copy: account ids look
// like `AC-1101` / uuids, and normalizing one would silently address a
// different account. Only the STATIC segments are compared case-insensitively.

import { useLocation } from "react-router-dom";
import { NotFound } from "@/app/shell/NotFound";
import { CoaListPage } from "./CoaListPage";
import { AccountDetailPage } from "./AccountDetailPage";
import { AccountFormPage } from "./AccountFormPage";
import { AccountMovePage } from "./AccountMovePage";
import { CoaHealthPage } from "./CoaHealthPage";
import { CoaImportPage } from "./CoaImportPage";
import { COA_BASE } from "./routes";

export { COA_BASE };

/** Segments AFTER `/accounting/chart-of-accounts`, with ids left untouched. */
export function coaSubSegments(pathname: string): string[] {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === "chart-of-accounts");
  return i < 0 ? [] : parts.slice(i + 1);
}

export function ChartOfAccountsSection() {
  const { pathname } = useLocation();
  const seg = coaSubSegments(pathname);

  if (seg.length === 0) return <CoaListPage />;

  const first = seg[0];
  const lower = first.toLowerCase();
  if (seg.length === 1) {
    if (lower === "new") return <AccountFormPage mode="new" />;
    if (lower === "health") return <CoaHealthPage />;
    if (lower === "import") return <CoaImportPage />;
    return <AccountDetailPage id={decodeURIComponent(first)} />;
  }

  if (seg.length === 2) {
    const id = decodeURIComponent(first);
    const action = seg[1].toLowerCase();
    if (action === "edit") return <AccountFormPage mode="edit" id={id} />;
    if (action === "move") return <AccountMovePage id={id} />;
  }

  return <NotFound />;
}

export default ChartOfAccountsSection;
