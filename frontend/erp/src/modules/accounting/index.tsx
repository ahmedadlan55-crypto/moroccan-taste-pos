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
import { TrialBalancePage } from "./pages/TrialBalance";
import { IncomeStatementPage } from "./pages/IncomeStatement";
import { BalanceSheetPage } from "./pages/BalanceSheet";
import { CashFlowPage } from "./pages/CashFlow";
import { GeneralLedgerPage } from "./pages/GeneralLedger";
import { ArAgingPage, ApAgingPage } from "./pages/Aging";
import { PeriodsPage } from "./pages/Periods";
import { CostCentersPage } from "./pages/CostCenters";
import { DimensionsPage } from "./pages/Dimensions";
import { ChartOfAccountsPage } from "./pages/ChartOfAccounts";
import { JournalsPage } from "./pages/Journals";

const ROUTES: Record<string, () => JSX.Element> = {
  "/accounting/chart-of-accounts": ChartOfAccountsPage,
  "/accounting/journals": JournalsPage,
  "/accounting/trial-balance": TrialBalancePage,
  "/accounting/income-statement": IncomeStatementPage,
  "/accounting/balance-sheet": BalanceSheetPage,
  "/accounting/cash-flow": CashFlowPage,
  "/accounting/general-ledger": GeneralLedgerPage,
  "/accounting/ar-aging": ArAgingPage,
  "/accounting/ap-aging": ApAgingPage,
  "/accounting/periods": PeriodsPage,
  "/accounting/cost-centers": CostCentersPage,
  "/accounting/dimensions": DimensionsPage,
};

export default function AccountingModule() {
  const { pathname } = useLocation();
  const Page = ROUTES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}
