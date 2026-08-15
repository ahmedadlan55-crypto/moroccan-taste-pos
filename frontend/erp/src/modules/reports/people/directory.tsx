// The /reports/people catalogue — the shared grouped-card renderer, driven by
// the registry so a row and the page it opens can never disagree.
import ReportsHub from "../pages/ReportsHub";
import { toReportSection } from "../engine";
import { PEOPLE_REPORTS_SECTION } from "./registry";

/** The catalogue this section renders — derived, never hand-written. */
export const PEOPLE_REPORT_LINKS = toReportSection(PEOPLE_REPORTS_SECTION);

export function PeopleReportsDirectory() {
  return <ReportsHub section={PEOPLE_REPORT_LINKS} />;
}
