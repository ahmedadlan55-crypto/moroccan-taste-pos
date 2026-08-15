// A section's catalogue is DERIVED from its registry, never written twice.
//
// `/reports/<section>` renders through the shared catalogue renderer
// (ReportsHub → ReportDirectory), while `/reports/<section>/<id>` renders
// through GenericReportPage off the same registry. Building the first from the
// second is what keeps a row in the catalogue and the page it opens from ever
// disagreeing about the report's name, its icon or the capability that hides it.
import type { ReportSection, ReportSectionDef } from "./types";

export function toReportSection(section: ReportSectionDef): ReportSection {
  return {
    path: section.path,
    title: section.titleKey,
    subtitle: section.subtitleKey,
    groups: section.groups.map((group) => ({
      id: group.id,
      title: group.titleKey,
      icon: group.icon,
      links: section.reports
        .filter((report) => report.groupId === group.id)
        .map((report) => ({
          id: report.id,
          // The single reason a report row can never leave /reports.
          to: `${section.path}/${report.id}`,
          label: report.labelKey,
          icon: report.icon,
          tone: report.tone,
          cap: report.cap,
        })),
    })),
  };
}
