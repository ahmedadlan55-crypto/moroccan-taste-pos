// The Reports center is a HUB: it does not duplicate report pages, it links to
// the canonical routes owned by the domain modules. Each section below maps to a
// /reports/* manifest path and lists the real destination routes.
import type { ComponentType } from "react";
import {
  BarChart3,
  Banknote,
  Boxes,
  CalendarCheck,
  ClipboardCheck,
  HandCoins,
  Layers,
  LineChart,
  PiggyBank,
  Plane,
  Receipt,
  Scale,
  ScrollText,
  TrendingUp,
  Users,
  Building2,
  Clock,
  BookOpenCheck,
  Gauge,
  Landmark,
  Network,
  BriefcaseBusiness,
  ShieldCheck,
} from "lucide-react";
import type { Capability } from "@/shared/permissions";
import type { ReportDirectoryTone } from "./components/ReportDirectory";

// NOTE: `title` / `subtitle` / `label` / `description` hold i18n KEY PATHS
// (misc.reports.*), not display text — ReportsHub resolves them via t(), the
// same pattern the nav manifest + Sidebar use for `label`. This keeps the config
// static while the copy stays translatable.
export interface ReportLink {
  id: string;
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ReportDirectoryTone;
  cap?: Capability;
}
export interface ReportGroup {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  links: ReportLink[];
}
export interface ReportSection {
  path: string;
  title: string;
  subtitle: string;
  groups: ReportGroup[];
}

export const REPORT_SECTIONS: Record<string, ReportSection> = {
  // "/reports/sales" carries NO link section: the Sales Analytics Hub owns that
  // whole subtree (modules/reports/index.tsx routes it to SalesAnalyticsHub
  // before this table is ever consulted).
  "/reports/financial": {
    path: "/reports/financial",
    title: "misc.reports.sections.financial.title",
    subtitle: "misc.reports.sections.financial.subtitle",
    groups: [
      {
        id: "financial-statements", title: "misc.reports.groups.financialStatements.title", description: "misc.reports.groups.financialStatements.description", icon: Landmark,
        links: [
          { id: "gl-income-statement", to: "/accounting/income-statement", label: "misc.reports.links.glIncomeStatement.label", description: "misc.reports.links.glIncomeStatement.description", icon: TrendingUp, tone: "lime", cap: "accounting.reports.view" },
          { id: "gl-balance-sheet", to: "/accounting/balance-sheet", label: "misc.reports.links.glBalanceSheet.label", description: "misc.reports.links.glBalanceSheet.description", icon: Building2, tone: "blue", cap: "accounting.reports.view" },
          { id: "gl-cash-flow", to: "/accounting/cash-flow", label: "misc.reports.links.glCashFlow.label", description: "misc.reports.links.glCashFlow.description", icon: LineChart, tone: "teal", cap: "accounting.reports.view" },
          { id: "gl-equity", to: "/accounting/equity-changes", label: "misc.reports.links.glEquityChanges.label", description: "misc.reports.links.glEquityChanges.description", icon: Landmark, tone: "violet", cap: "accounting.reports.view" },
          { id: "gl-ratios", to: "/accounting/financial-ratios", label: "misc.reports.links.glFinancialRatios.label", description: "misc.reports.links.glFinancialRatios.description", icon: Gauge, tone: "amber", cap: "accounting.reports.view" },
        ],
      },
      {
        id: "ledger-control", title: "misc.reports.groups.ledgerControl.title", description: "misc.reports.groups.ledgerControl.description", icon: BookOpenCheck,
        links: [
          { id: "gl-general-ledger", to: "/accounting/general-ledger", label: "misc.reports.links.glGeneralLedger.label", description: "misc.reports.links.glGeneralLedger.description", icon: Layers, tone: "teal", cap: "accounting.reports.view" },
          { id: "gl-trial-balance", to: "/accounting/trial-balance", label: "misc.reports.links.glTrialBalance.label", description: "misc.reports.links.glTrialBalance.description", icon: Scale, tone: "rose", cap: "finance.reports.view" },
          { id: "gl-sales-posting", to: "/accounting/sales-posting", label: "misc.reports.links.glSalesPosting.label", description: "misc.reports.links.glSalesPosting.description", icon: ClipboardCheck, tone: "blue", cap: "finance.reports.view" },
        ],
      },
      {
        id: "receivables-payables", title: "misc.reports.groups.receivablesPayables.title", description: "misc.reports.groups.receivablesPayables.description", icon: HandCoins,
        links: [
          { id: "gl-ar-aging", to: "/accounting/ar-aging", label: "misc.reports.links.glArAging.label", description: "misc.reports.links.glArAging.description", icon: HandCoins, tone: "amber", cap: "accounting.reports.view" },
          { id: "gl-ap-aging", to: "/accounting/ap-aging", label: "misc.reports.links.glApAging.label", description: "misc.reports.links.glApAging.description", icon: PiggyBank, tone: "violet", cap: "accounting.reports.view" },
          { id: "gl-profitability", to: "/accounting/profitability", label: "misc.reports.links.glProfitability.label", description: "misc.reports.links.glProfitability.description", icon: TrendingUp, tone: "lime", cap: "accounting.reports.view" },
          { id: "gl-inventory-valuation", to: "/accounting/inventory-valuation", label: "misc.reports.links.glInventoryValuation.label", description: "misc.reports.links.glInventoryValuation.description", icon: Boxes, tone: "blue", cap: "accounting.reports.view" },
        ],
      },
    ],
  },
  "/reports/people": {
    path: "/reports/people",
    title: "misc.reports.sections.people.title",
    subtitle: "misc.reports.sections.people.subtitle",
    groups: [
      { id: "workforce", title: "misc.reports.groups.workforce.title", description: "misc.reports.groups.workforce.description", icon: Users, links: [
        { id: "ppl-employees", to: "/people/employees", label: "misc.reports.links.pplEmployees.label", description: "misc.reports.links.pplEmployees.description", icon: Users, tone: "teal", cap: "people.employees.view" },
        { id: "ppl-org", to: "/people/org-tree", label: "misc.reports.links.pplOrgTree.label", description: "misc.reports.links.pplOrgTree.description", icon: Network, tone: "blue", cap: "workflow.view" },
        { id: "ppl-custody", to: "/people/custody", label: "misc.reports.links.pplCustody.label", description: "misc.reports.links.pplCustody.description", icon: BriefcaseBusiness, tone: "violet", cap: "people.custody.view" },
      ] },
      { id: "time-attendance", title: "misc.reports.groups.timeAttendance.title", description: "misc.reports.groups.timeAttendance.description", icon: CalendarCheck, links: [
        { id: "ppl-attendance", to: "/people/attendance", label: "misc.reports.links.pplAttendance.label", description: "misc.reports.links.pplAttendance.description", icon: CalendarCheck, tone: "blue", cap: "people.attendance.view" },
        { id: "ppl-leaves", to: "/people/leaves", label: "misc.reports.links.pplLeaves.label", description: "misc.reports.links.pplLeaves.description", icon: Plane, tone: "amber", cap: "people.leaves.view" },
        { id: "ppl-payroll", to: "/people/payroll", label: "misc.reports.links.pplPayroll.label", description: "misc.reports.links.pplPayroll.description", icon: Banknote, tone: "lime", cap: "people.payroll.view" },
      ] },
    ],
  },
  "/reports/operations": {
    path: "/reports/operations",
    title: "misc.reports.sections.operations.title",
    subtitle: "misc.reports.sections.operations.subtitle",
    groups: [
      { id: "pos-control", title: "misc.reports.groups.posControl.title", description: "misc.reports.groups.posControl.description", icon: Receipt, links: [
        { id: "ops-shifts", to: "/pos-admin/shifts", label: "misc.reports.links.opsShifts.label", description: "misc.reports.links.opsShifts.description", icon: Clock, tone: "blue", cap: "pos.shifts.view" },
        { id: "ops-pos-reports", to: "/reports/sales/operations?view=shifts", label: "misc.reports.links.opsPosReports.label", description: "misc.reports.links.opsPosReports.description", icon: Receipt, tone: "teal", cap: "analytics.view" },
      ] },
      { id: "operations-control", title: "misc.reports.groups.operationsControl.title", description: "misc.reports.groups.operationsControl.description", icon: ShieldCheck, links: [
        { id: "ops-action-log", to: "/workflow/action-log", label: "misc.reports.links.opsActionLog.label", description: "misc.reports.links.opsActionLog.description", icon: ScrollText, tone: "violet", cap: "workflow.audit.view" },
        { id: "ops-inventory", to: "/inventory", label: "misc.reports.links.opsInventoryOverview.label", description: "misc.reports.links.opsInventoryOverview.description", icon: BarChart3, tone: "lime", cap: "inventory.view" },
      ] },
    ],
  },
};
