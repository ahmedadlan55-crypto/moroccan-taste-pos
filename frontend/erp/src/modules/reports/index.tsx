// modules/reports — the Reports center. A HUB that links to canonical report
// routes owned by the domain modules (it never duplicates those pages), plus a
// localStorage-backed saved-views list. Dispatches by pathname because each
// /reports/* manifest path is its own route pointing at this module.
//
// /reports/sales/* is the exception: rp-sales OWNS its subtree (subRoutes:true)
// and mounts the Sales Analytics Hub, which dispatches its 16 segments
// internally. Lazy so the hub's charts/pivot code stays out of the plain
// reports-links chunk.
import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { LoadingState } from "@/shared/ui";
import { NotFound } from "@/app/shell/NotFound";
import ReportsHub from "./pages/ReportsHub";
import SavedReportsPage from "./pages/SavedReports";
import { REPORT_SECTIONS } from "./reportLinks";

const SalesAnalyticsHub = lazy(() => import("./sales/SalesAnalyticsHub"));

export default function ReportsModule() {
  const { pathname } = useLocation();
  const key = normalizeRoutePath(pathname);
  if (key === "/reports/sales" || key.startsWith("/reports/sales/")) {
    return (
      <Suspense fallback={<LoadingState />}>
        <SalesAnalyticsHub />
      </Suspense>
    );
  }
  if (key === "/reports/saved") return <SavedReportsPage />;
  const section = REPORT_SECTIONS[key];
  if (section) return <ReportsHub section={section} />;
  return <NotFound />;
}
