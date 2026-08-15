// The financial reports section — one entry per accounting report that lives
// under /reports/financial/<id>.
//
// WHY THE PAGES CAN BE MOUNTED FROM HERE AT ALL
//   Every page in `modules/accounting/pages/*` imports only `@/shared/*`, its
//   own `../api` and `../components`. None of them reads a provider or a
//   context owned by the accounting module, and none of them reads the route
//   to decide what it is. So the component is portable: rendering it under
//   /reports/financial/<id> produces the identical screen it produced under
//   /accounting/<id>. That is the whole reason this section can exist without
//   duplicating a single report.
//
// WHY EACH ENTRY KEEPS ITS OWN CAPABILITY
//   These are NOT interchangeable. `trial-balance` is gated on
//   `finance.reports.view` because that is the capability its backend route
//   really enforces (routes/erp/reports/trial-balance.js), and
//   e2e/erp/trial-balance-rbac.spec.ts asserts a cashier is never offered it.
//   The rest carry `accounting.reports.view`, matching what the nav manifest
//   has always published for them. Flattening the two into one capability
//   would silently hand the trial balance to every role that can read an aging
//   report — so the per-report capability is copied here verbatim and this
//   file changes NO guard, it only restates the ones that already exist.
//
// WHAT IS DELIBERATELY ABSENT
//   /accounting/sales-posting. It is not a report: it POSTS and REVERSES
//   journals. A page that writes to the ledger does not belong in a reports
//   catalogue, where every other entry is safe to open and print.
import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";
import { LoadingState } from "@/shared/ui";
import type { Capability } from "@/shared/permissions";

export type FinancialReportId =
  | "income-statement"
  | "balance-sheet"
  | "cash-flow"
  | "equity-changes"
  | "general-ledger"
  | "trial-balance"
  | "financial-ratios"
  | "ar-aging"
  | "ap-aging"
  | "profitability"
  | "inventory-valuation";

export interface FinancialReport {
  id: FinancialReportId;
  /** i18n key path for the report's name. Resolved by the caller's `t()`. */
  labelKey: string;
  /** The capability the report already required. Never widened here. */
  cap: Capability;
  /** Lazy so opening the catalogue does not pull eleven report bundles. */
  Page: LazyExoticComponent<ComponentType>;
}

/** `lazy` over a NAMED page export, without repeating the shape eleven times. */
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): LazyExoticComponent<ComponentType> {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}

export const FINANCIAL_REPORTS: FinancialReport[] = [
  {
    id: "income-statement",
    labelKey: "misc.reports.links.glIncomeStatement.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/IncomeStatement"), "IncomeStatementPage"),
  },
  {
    id: "balance-sheet",
    labelKey: "misc.reports.links.glBalanceSheet.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/BalanceSheet"), "BalanceSheetPage"),
  },
  {
    id: "cash-flow",
    labelKey: "misc.reports.links.glCashFlow.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/CashFlow"), "CashFlowPage"),
  },
  {
    id: "equity-changes",
    labelKey: "misc.reports.links.glEquityChanges.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/EquityChanges"), "EquityChangesPage"),
  },
  {
    id: "general-ledger",
    labelKey: "misc.reports.links.glGeneralLedger.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/GeneralLedger"), "GeneralLedgerPage"),
  },
  {
    id: "trial-balance",
    labelKey: "misc.reports.links.glTrialBalance.label",
    // NOT accounting.reports.view — see the header note.
    cap: "finance.reports.view",
    Page: page(() => import("@/modules/accounting/pages/TrialBalance"), "TrialBalancePage"),
  },
  {
    id: "financial-ratios",
    labelKey: "misc.reports.links.glFinancialRatios.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/FinancialRatios"), "FinancialRatiosPage"),
  },
  {
    id: "ar-aging",
    labelKey: "misc.reports.links.glArAging.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/Aging"), "ArAgingPage"),
  },
  {
    id: "ap-aging",
    labelKey: "misc.reports.links.glApAging.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/Aging"), "ApAgingPage"),
  },
  {
    id: "profitability",
    labelKey: "misc.reports.links.glProfitability.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/Profitability"), "ProfitabilityPage"),
  },
  {
    id: "inventory-valuation",
    labelKey: "misc.reports.links.glInventoryValuation.label",
    cap: "accounting.reports.view",
    Page: page(() => import("@/modules/accounting/pages/InventoryValuation"), "InventoryValuationPage"),
  },
];

export const FINANCIAL_REPORT_BY_ID: Record<string, FinancialReport | undefined> =
  Object.fromEntries(FINANCIAL_REPORTS.map((report) => [report.id, report]));

/** The route a report is reached at. The ONE place that spelling lives. */
export function financialReportPath(id: FinancialReportId): string {
  return `/reports/financial/${id}`;
}

export function isFinancialReportId(id: string): id is FinancialReportId {
  return FINANCIAL_REPORT_BY_ID[id] !== undefined;
}

/**
 * Render the report `id` names, already wrapped in the Suspense boundary its
 * lazy chunk needs.
 *
 * Returns null — never a NotFound — for an unknown id, because what an
 * unmatched /reports/financial/* path should render is the ROUTER's decision,
 * not this module's.
 *
 * It deliberately performs NO capability check. Each report's `cap` is
 * published on the registry entry for the caller to gate on; deciding here
 * would put a second, competing authorization opinion next to the router's.
 */
export function renderFinancialReport(id: string): ReactElement | null {
  const report = FINANCIAL_REPORT_BY_ID[id];
  if (!report) return null;
  return createElement(
    Suspense,
    { fallback: createElement(LoadingState) },
    createElement(report.Page),
  );
}
