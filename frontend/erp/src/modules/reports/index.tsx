// modules/reports — the Reports center. A HUB that links to canonical report
// routes owned by the domain modules (it never duplicates those pages), plus a
// localStorage-backed saved-views list. Dispatches by pathname because each
// /reports/* manifest path is its own route pointing at this module.
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import ReportsHub from "./pages/ReportsHub";
import SavedReportsPage from "./pages/SavedReports";
import { REPORT_SECTIONS } from "./reportLinks";

export default function ReportsModule() {
  const { pathname } = useLocation();
  const key = normalizeRoutePath(pathname);
  if (key === "/reports/saved") return <SavedReportsPage />;
  const section = REPORT_SECTIONS[key];
  if (section) return <ReportsHub section={section} />;
  return <NotFound />;
}
