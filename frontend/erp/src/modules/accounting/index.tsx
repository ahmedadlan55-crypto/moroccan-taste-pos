// ── modules/accounting — routed accounting pages (SD5 conversion) ───────────
// The router registers the SAME lazy module component for every accounting nav
// path, so this entry switches on the current pathname and renders the matching
// page. Read-heavy reports were converted 1:1 against the legacy report loaders
// (server owns all the math); the two HEAVY editors (COA manager + journal
// editor) render a clean deferred placeholder that links to the legacy app.

import { useLocation } from "react-router-dom";
import { TrialBalancePage } from "./pages/TrialBalance";
import { IncomeStatementPage } from "./pages/IncomeStatement";
import { BalanceSheetPage } from "./pages/BalanceSheet";
import { CashFlowPage } from "./pages/CashFlow";
import { GeneralLedgerPage } from "./pages/GeneralLedger";
import { ArAgingPage, ApAgingPage } from "./pages/Aging";
import { CostCentersPage } from "./pages/CostCenters";
import { DimensionsPage } from "./pages/Dimensions";
import { DeferredScreen } from "./components";

const ROUTES: Record<string, () => JSX.Element> = {
  "/accounting/trial-balance": TrialBalancePage,
  "/accounting/income-statement": IncomeStatementPage,
  "/accounting/balance-sheet": BalanceSheetPage,
  "/accounting/cash-flow": CashFlowPage,
  "/accounting/general-ledger": GeneralLedgerPage,
  "/accounting/ar-aging": ArAgingPage,
  "/accounting/ap-aging": ApAgingPage,
  "/accounting/cost-centers": CostCentersPage,
  "/accounting/dimensions": DimensionsPage,
};

export default function AccountingModule() {
  const { pathname } = useLocation();
  const Page = ROUTES[pathname];
  if (Page) return <Page />;
  // /accounting/chart-of-accounts + /accounting/journals — HEAVY, deferred.
  return <DeferredScreen pathname={pathname} />;
}
