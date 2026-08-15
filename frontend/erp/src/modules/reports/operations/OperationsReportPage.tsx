// One report page for the whole Operations catalogue.
//
// `OperationsReportsSection` is the single mount point for the
// `/reports/operations` subtree: the catalogue at the root, a report at
// `/reports/operations/<id>`, and the catalogue's own "unknown report" state
// for anything else.
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { GenericReportPage } from "../engine";
import { OPERATIONS_REPORTS_SECTION } from "./registry";
import { OperationsReportsDirectory } from "./directory";

export function OperationsReportPage({ reportId }: { reportId: string }) {
  return <GenericReportPage section={OPERATIONS_REPORTS_SECTION} reportId={reportId} />;
}

export function OperationsReportsSection() {
  const { pathname } = useLocation();
  const key = normalizeRoutePath(pathname);
  const base = OPERATIONS_REPORTS_SECTION.path;
  if (key === base) return <OperationsReportsDirectory />;
  const reportId = key.slice(`${base}/`.length).split("/")[0] ?? "";
  return <OperationsReportPage reportId={reportId} />;
}
