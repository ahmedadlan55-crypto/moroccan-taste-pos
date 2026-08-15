// One report page for the whole People catalogue.
//
// `PeopleReportsSection` is the single mount point for the `/reports/people`
// subtree: the catalogue at the root, a report at `/reports/people/<id>`, and
// the catalogue's own "unknown report" state for anything else. It exists so
// wiring the subtree is one route, not seven.
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { GenericReportPage } from "../engine";
import { PEOPLE_REPORTS_SECTION } from "./registry";
import { PeopleReportsDirectory } from "./directory";

export function PeopleReportPage({ reportId }: { reportId: string }) {
  return <GenericReportPage section={PEOPLE_REPORTS_SECTION} reportId={reportId} />;
}

export function PeopleReportsSection() {
  const { pathname } = useLocation();
  const key = normalizeRoutePath(pathname);
  const base = PEOPLE_REPORTS_SECTION.path;
  if (key === base) return <PeopleReportsDirectory />;
  const reportId = key.slice(`${base}/`.length).split("/")[0] ?? "";
  return <PeopleReportPage reportId={reportId} />;
}
