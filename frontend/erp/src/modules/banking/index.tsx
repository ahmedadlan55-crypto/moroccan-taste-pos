// ── modules/banking — routed Cash & Banking pages (SD5 conversion) ──────────
// Switches on the current pathname (the router maps every banking nav path to
// this one lazy module). CRUD screens (cashboxes, bank accounts, transfers) and
// the receipt/payment registers (list + approve/cancel lifecycle) are converted
// against the legacy cash management loaders (/api/cash/*). The two HEAVY
// screens (bank reconciliation + cash closing) render a deferred placeholder.

import { useLocation } from "react-router-dom";
import { CashboxesPage } from "./pages/Cashboxes";
import { BankAccountsPage } from "./pages/BankAccounts";
import { ReceiptsPage, PaymentsPage } from "./pages/Vouchers";
import { TransfersPage } from "./pages/Transfers";
import { ReconciliationPage } from "./reconciliation/ReconciliationPage";
import { CashClosingPage } from "./cash-closing/CashClosingPage";
import { DeferredScreen } from "./components";

const ROUTES: Record<string, () => JSX.Element> = {
  "/banking/cashboxes": CashboxesPage,
  "/banking/bank-accounts": BankAccountsPage,
  "/banking/receipts": ReceiptsPage,
  "/banking/payments": PaymentsPage,
  "/banking/transfers": TransfersPage,
  "/banking/reconciliation": ReconciliationPage, // FC-P3 (was deferred)
  "/banking/cash-closing": CashClosingPage, // FC-P3 (was deferred)
};

export default function BankingModule() {
  const { pathname } = useLocation();
  const Page = ROUTES[pathname];
  if (Page) return <Page />;
  return <DeferredScreen pathname={pathname} />;
}
