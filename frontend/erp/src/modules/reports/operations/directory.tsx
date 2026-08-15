// The /reports/operations catalogue — the shared grouped-card renderer, driven
// by the registry so a row and the page it opens can never disagree.
import ReportsHub from "../pages/ReportsHub";
import { toReportSection } from "../engine";
import { OPERATIONS_REPORTS_SECTION } from "./registry";

/** The catalogue this section renders — derived, never hand-written. */
export const OPERATIONS_REPORT_LINKS = toReportSection(OPERATIONS_REPORTS_SECTION);

export function OperationsReportsDirectory() {
  return <ReportsHub section={OPERATIONS_REPORT_LINKS} />;
}
