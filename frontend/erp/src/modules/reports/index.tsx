// modules/reports — THE reports section, and the only place that decides which
// section owns a pathname.
//
// ONE HOME PER REPORT
//   /reports/<section>            → that section's catalogue
//   /reports/<section>/<id>       → the report itself, a real refreshable URL
//
// Every section leaf in the nav manifest carries `subRoutes: true`, so the
// router mounts THIS module for the whole `/reports/<section>/*` subtree and
// the dispatch below picks the page. That is what lets a catalogue row be an
// ordinary link to a real address instead of an anchor into the page it is
// already on, or a jump into a CRUD workspace in another top-level section.
//
// A section owns its own "unknown report" state (People, Operations, Purchasing
// and Receivables each render one, Financial returns null and defers to this
// file). Nothing here second-guesses a capability: the router's CapGuard gates
// the section, each catalogue hides the rows the reader cannot open, and the
// server refuses what is left.
import { lazy, Suspense, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { LoadingState } from "@/shared/ui";
import { NotFound } from "@/app/shell/NotFound";
import SavedReportsPage from "./pages/SavedReports";
import ReportsHome from "./pages/ReportsHome";
import { usePermissions } from "@/shared/permissions";
import { renderFinancialReport } from "./financial/registry";

const SalesAnalyticsHub = lazy(() => import("./sales/SalesAnalyticsHub"));
const InventoryIntelligencePage = lazy(() => import("./warehouse").then((module) => ({ default: module.InventoryIntelligencePage })));
const PurchasingIntelligencePage = lazy(() => import("./warehouse").then((module) => ({ default: module.PurchasingIntelligencePage })));
const PurchasingReportPage = lazy(() => import("./purchasing/PurchasingReportPage"));
const FinancialReportsDirectory = lazy(() => import("./financial/FinancialReportsDirectory"));
const ReceivablesReportsDirectory = lazy(() => import("./receivables/ReceivablesReportsDirectory"));
const ReceivablesReportPage = lazy(() => import("./receivables/ReceivablesReportPage"));
const PeopleReportsSection = lazy(() => import("./people/PeopleReportPage").then((module) => ({ default: module.PeopleReportsSection })));
const OperationsReportsSection = lazy(() => import("./operations/OperationsReportPage").then((module) => ({ default: module.OperationsReportsSection })));
const InventoryReportDetail = lazy(() => Promise.all([
  import("@/modules/inventory/features/reports/ReportDetailPage"),
  import("@/modules/inventory/lib/providers"),
]).then(([report, providers]) => ({
  default: ({ reportType }: { reportType: string }) => (
    <providers.WarehouseModuleProviders><report.ReportDetailPage reportType={reportType} /></providers.WarehouseModuleProviders>
  ),
})));

/** The `<id>` in `/reports/<section>/<id>` — "" when the path IS the section. */
function reportIdIn(key: string, base: string): string {
  return key.startsWith(`${base}/`) ? key.slice(base.length + 1).split("/")[0] ?? "" : "";
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

export default function ReportsModule() {
  const { pathname } = useLocation();
  const key = normalizeRoutePath(pathname);
  // The per-report capability. The SECTION guard (`reports.view`) is the
  // router's; this is the report's own, which nothing was asking.
  const { can } = usePermissions();

  // Sales owns its whole subtree: the hub dispatches its centres and views
  // internally (and keeps the retired-segment redirects that make old links work).
  if (key === "/reports/sales" || key.startsWith("/reports/sales/")) {
    return <Lazy><SalesAnalyticsHub /></Lazy>;
  }

  if (key === "/reports/inventory") return <Lazy><InventoryIntelligencePage /></Lazy>;
  if (key.startsWith("/reports/inventory/")) {
    return <Lazy><InventoryReportDetail reportType={reportIdIn(key, "/reports/inventory")} /></Lazy>;
  }

  // The purchasing catalogue is rendered BY the intelligence page (it is the
  // same route: bare path = catalogue, ?workspace=1 = the control centre).
  if (key === "/reports/purchasing") return <Lazy><PurchasingIntelligencePage /></Lazy>;
  if (key.startsWith("/reports/purchasing/")) {
    return <Lazy><PurchasingReportPage reportId={reportIdIn(key, "/reports/purchasing")} /></Lazy>;
  }

  if (key === "/reports/financial") return <Lazy><FinancialReportsDirectory /></Lazy>;
  if (key.startsWith("/reports/financial/")) {
    // The registry answers with the page or with null for an id it does not
    // know; the not-found decision stays here, with the router.
    return renderFinancialReport(reportIdIn(key, "/reports/financial"), can) ?? <NotFound />;
  }

  if (key === "/reports/receivables") return <Lazy><ReceivablesReportsDirectory /></Lazy>;
  if (key.startsWith("/reports/receivables/")) {
    return <Lazy><ReceivablesReportPage reportId={reportIdIn(key, "/reports/receivables")} /></Lazy>;
  }

  // People and Operations are registry-driven end to end: one component serves
  // the catalogue and every report under it.
  if (key === "/reports/people" || key.startsWith("/reports/people/")) {
    return <Lazy><PeopleReportsSection /></Lazy>;
  }
  if (key === "/reports/operations" || key.startsWith("/reports/operations/")) {
    return <Lazy><OperationsReportsSection /></Lazy>;
  }

  if (key === "/reports/saved") return <SavedReportsPage />;
  // The reports HOME. Every section had a home; the address they all hang
  // off answered NotFound, so nothing in the product could list what reports
  // exist. Kept last so no section prefix is shadowed by it.
  if (key === "/reports") return <ReportsHome />;
  return <NotFound />;
}
