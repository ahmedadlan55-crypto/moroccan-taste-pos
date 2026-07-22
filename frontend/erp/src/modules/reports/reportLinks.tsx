// The Reports center is a HUB: it does not duplicate report pages, it links to
// the canonical routes owned by the domain modules. Each section below maps to a
// /reports/* manifest path and lists the real destination routes.
import type { ComponentType } from "react";
import {
  BarChart3,
  Banknote,
  Boxes,
  CalendarClock,
  CalendarCheck,
  ClipboardCheck,
  CornerUpLeft,
  FileText,
  HandCoins,
  Layers,
  LineChart,
  PiggyBank,
  Plane,
  Receipt,
  RefreshCcw,
  Scale,
  ScrollText,
  ShoppingBag,
  ShoppingCart,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  Building2,
  Clock,
} from "lucide-react";

// NOTE: `title` / `subtitle` / `label` / `description` hold i18n KEY PATHS
// (misc.reports.*), not display text — ReportsHub resolves them via t(), the
// same pattern the nav manifest + Sidebar use for `label`. This keeps the config
// static while the copy stays translatable.
export interface ReportLink {
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}
export interface ReportSection {
  path: string;
  title: string;
  subtitle: string;
  links: ReportLink[];
}

export const REPORT_SECTIONS: Record<string, ReportSection> = {
  "/reports/sales": {
    path: "/reports/sales",
    title: "misc.reports.sections.sales.title",
    subtitle: "misc.reports.sections.sales.subtitle",
    links: [
      { to: "/sales/orders", label: "misc.reports.links.salesOrders.label", description: "misc.reports.links.salesOrders.description", icon: ShoppingCart },
      { to: "/sales/invoices", label: "misc.reports.links.salesInvoices.label", description: "misc.reports.links.salesInvoices.description", icon: FileText },
      { to: "/sales/returns", label: "misc.reports.links.salesReturns.label", description: "misc.reports.links.salesReturns.description", icon: Undo2 },
      { to: "/sales/payments", label: "misc.reports.links.salesPayments.label", description: "misc.reports.links.salesPayments.description", icon: Banknote },
      { to: "/sales/pricing", label: "misc.reports.links.salesPricing.label", description: "misc.reports.links.salesPricing.description", icon: Tags },
      { to: "/pos-admin/reports", label: "misc.reports.links.posReports.label", description: "misc.reports.links.posReports.description", icon: Receipt },
    ],
  },
  "/reports/inventory": {
    path: "/reports/inventory",
    title: "misc.reports.sections.inventory.title",
    subtitle: "misc.reports.sections.inventory.subtitle",
    links: [
      { to: "/inventory/balances", label: "misc.reports.links.invBalances.label", description: "misc.reports.links.invBalances.description", icon: Boxes },
      { to: "/inventory/transfers", label: "misc.reports.links.invTransfers.label", description: "misc.reports.links.invTransfers.description", icon: Truck },
      { to: "/inventory/stocktakes", label: "misc.reports.links.invStocktakes.label", description: "misc.reports.links.invStocktakes.description", icon: ClipboardCheck },
      { to: "/inventory/lots-expiry", label: "misc.reports.links.invLotsExpiry.label", description: "misc.reports.links.invLotsExpiry.description", icon: CalendarClock },
      { to: "/inventory/replenishment", label: "misc.reports.links.invReplenishment.label", description: "misc.reports.links.invReplenishment.description", icon: RefreshCcw },
    ],
  },
  "/reports/purchasing": {
    path: "/reports/purchasing",
    title: "misc.reports.sections.purchasing.title",
    subtitle: "misc.reports.sections.purchasing.subtitle",
    links: [
      { to: "/purchasing/orders", label: "misc.reports.links.purOrders.label", description: "misc.reports.links.purOrders.description", icon: ShoppingBag },
      { to: "/purchasing/invoices", label: "misc.reports.links.purInvoices.label", description: "misc.reports.links.purInvoices.description", icon: FileText },
      { to: "/purchasing/payments", label: "misc.reports.links.purPayments.label", description: "misc.reports.links.purPayments.description", icon: Wallet },
      { to: "/purchasing/returns", label: "misc.reports.links.purReturns.label", description: "misc.reports.links.purReturns.description", icon: CornerUpLeft },
      { to: "/purchasing/suppliers", label: "misc.reports.links.purSuppliers.label", description: "misc.reports.links.purSuppliers.description", icon: Users },
    ],
  },
  "/reports/financial": {
    path: "/reports/financial",
    title: "misc.reports.sections.financial.title",
    subtitle: "misc.reports.sections.financial.subtitle",
    links: [
      { to: "/accounting/general-ledger", label: "misc.reports.links.glGeneralLedger.label", description: "misc.reports.links.glGeneralLedger.description", icon: Layers },
      { to: "/accounting/trial-balance", label: "misc.reports.links.glTrialBalance.label", description: "misc.reports.links.glTrialBalance.description", icon: Scale },
      { to: "/accounting/income-statement", label: "misc.reports.links.glIncomeStatement.label", description: "misc.reports.links.glIncomeStatement.description", icon: TrendingUp },
      { to: "/accounting/balance-sheet", label: "misc.reports.links.glBalanceSheet.label", description: "misc.reports.links.glBalanceSheet.description", icon: Building2 },
      { to: "/accounting/cash-flow", label: "misc.reports.links.glCashFlow.label", description: "misc.reports.links.glCashFlow.description", icon: LineChart },
      { to: "/accounting/ar-aging", label: "misc.reports.links.glArAging.label", description: "misc.reports.links.glArAging.description", icon: HandCoins },
      { to: "/accounting/ap-aging", label: "misc.reports.links.glApAging.label", description: "misc.reports.links.glApAging.description", icon: PiggyBank },
    ],
  },
  "/reports/people": {
    path: "/reports/people",
    title: "misc.reports.sections.people.title",
    subtitle: "misc.reports.sections.people.subtitle",
    links: [
      { to: "/people/employees", label: "misc.reports.links.pplEmployees.label", description: "misc.reports.links.pplEmployees.description", icon: Users },
      { to: "/people/attendance", label: "misc.reports.links.pplAttendance.label", description: "misc.reports.links.pplAttendance.description", icon: CalendarCheck },
      { to: "/people/payroll", label: "misc.reports.links.pplPayroll.label", description: "misc.reports.links.pplPayroll.description", icon: Banknote },
      { to: "/people/leaves", label: "misc.reports.links.pplLeaves.label", description: "misc.reports.links.pplLeaves.description", icon: Plane },
    ],
  },
  "/reports/operations": {
    path: "/reports/operations",
    title: "misc.reports.sections.operations.title",
    subtitle: "misc.reports.sections.operations.subtitle",
    links: [
      { to: "/pos-admin/shifts", label: "misc.reports.links.opsShifts.label", description: "misc.reports.links.opsShifts.description", icon: Clock },
      { to: "/pos-admin/reports", label: "misc.reports.links.opsPosReports.label", description: "misc.reports.links.opsPosReports.description", icon: Receipt },
      { to: "/workflow/action-log", label: "misc.reports.links.opsActionLog.label", description: "misc.reports.links.opsActionLog.description", icon: ScrollText },
      { to: "/inventory", label: "misc.reports.links.opsInventoryOverview.label", description: "misc.reports.links.opsInventoryOverview.description", icon: BarChart3 },
    ],
  },
};
