// ── modules/accounting — routed accounting pages (SD5 conversion) ───────────
// The router registers the SAME lazy module component for every accounting nav
// path, so this entry switches on the current pathname and renders the matching
// page. Read-heavy reports were converted 1:1 against the legacy report loaders
// (server owns all the math). Every accounting screen — including the two HEAVY
// editors (Chart of Accounts + Journal editor) — is real React; the fallback is
// an unreachable safety net (the router only registers the exact manifest paths).

import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import { PeriodsPage } from "./pages/Periods";
import { RoyaltiesPage } from "./pages/Royalties";
import { CostCentersPage } from "./pages/CostCenters";
import { DimensionsPage } from "./pages/Dimensions";
import { ChartOfAccountsPage } from "./pages/ChartOfAccounts";
import { JournalsPage } from "./pages/Journals";
import { SalesPostingPage } from "./pages/SalesPosting";

// The eleven REPORT pages are no longer routed from here. They still live in
// ./pages — modules/reports/financial/registry.ts lazy-loads them — but their
// one address is /reports/financial/<id>, and a second table pointing at the
// same components under /accounting/<id> is exactly how two homes are born.
// Old links keep working through REDIRECTS in app/router.tsx.
const ROUTES: Record<string, () => JSX.Element> = {
  "/accounting/chart-of-accounts": ChartOfAccountsPage,
  "/accounting/journals": JournalsPage,
  "/accounting/periods": PeriodsPage,
  "/accounting/sales-posting": SalesPostingPage,
  // (The sales-analytics accounting page was retired → /reports/sales/executive; router redirect.)
  "/accounting/royalties": RoyaltiesPage,
  "/accounting/cost-centers": CostCentersPage,
  "/accounting/dimensions": DimensionsPage,
};

/**
 * Manifest leaves that OWN their subtree (subRoutes:true) and therefore must be
 * matched by PREFIX, before the exact-path table below. The table is a lookup
 * keyed on the full pathname, so `/accounting/chart-of-accounts/new` misses it
 * entirely and used to render NotFound — every deep link and every hard refresh
 * inside the chart of accounts died there. Prefix first, exact second.
 */
const SUBTREES: Array<{ base: string; Page: () => JSX.Element }> = [
  { base: "/accounting/chart-of-accounts", Page: ChartOfAccountsPage },
];

export default function AccountingModule() {
  const { pathname } = useLocation();
  const normalized = normalizeRoutePath(pathname);

  for (const { base, Page } of SUBTREES) {
    // `=== base` covers the bare route; the trailing slash keeps a future
    // `/accounting/chart-of-accounts-archive` from being swallowed by it.
    if (normalized === base || normalized.startsWith(`${base}/`)) return <Page />;
  }

  const Page = ROUTES[normalized];
  return Page ? <Page /> : <NotFound />;
}
