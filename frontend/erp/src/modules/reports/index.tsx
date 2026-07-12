// modules/reports — the Reports center. A HUB that links to canonical report
// routes owned by the domain modules (it never duplicates those pages), plus a
// localStorage-backed saved-views list. Dispatches by pathname because each
// /reports/* manifest path is its own route pointing at this module.
import { useLocation } from "react-router-dom";
import { ModulePlaceholder } from "@/app/shell/ModulePlaceholder";
import ReportsHub from "./pages/ReportsHub";
import SavedReportsPage from "./pages/SavedReports";
import { REPORT_SECTIONS } from "./reportLinks";

export default function ReportsModule() {
  const { pathname } = useLocation();
  if (pathname === "/reports/saved") return <SavedReportsPage />;
  const section = REPORT_SECTIONS[pathname];
  if (section) return <ReportsHub section={section} />;
  return <ModulePlaceholder />;
}
