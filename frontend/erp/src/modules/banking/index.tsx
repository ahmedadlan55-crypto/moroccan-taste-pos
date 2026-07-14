// ── modules/banking — routed Cash & Banking pages (SD5 conversion) ──────────
// Switches on the current pathname (the router maps every banking nav path to
// this one lazy module). CRUD screens (cashboxes, bank accounts, transfers) and
// the receipt/payment registers (list + approve/cancel lifecycle) are converted
// against the cash management API (/api/cash/*). Bank reconciliation and cash
// closing are real screens too (FC-P3) — every banking path maps to a page, so
// the fallback below is an unreachable safety net.

import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import { CashboxesPage } from "./pages/Cashboxes";
import { BankAccountsPage } from "./pages/BankAccounts";
import { ReceiptsPage, PaymentsPage } from "./pages/Vouchers";
import { TransfersPage } from "./pages/Transfers";
import { ReconciliationPage } from "./reconciliation/ReconciliationPage";
import { CashClosingPage } from "./cash-closing/CashClosingPage";

const ROUTES: Record<string, () => JSX.Element> = {
  "/banking/cashboxes": CashboxesPage,
  "/banking/bank-accounts": BankAccountsPage,
  "/banking/receipts": ReceiptsPage,
  "/banking/payments": PaymentsPage,
  "/banking/transfers": TransfersPage,
  "/banking/reconciliation": ReconciliationPage,
  "/banking/cash-closing": CashClosingPage,
};

export default function BankingModule() {
  const { pathname } = useLocation();
  const Page = ROUTES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}
