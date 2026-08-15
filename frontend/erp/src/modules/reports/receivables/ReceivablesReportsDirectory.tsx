// The receivables & collections catalogue.
//
// Renders through the shared `ReportDirectory` like every other section, so the
// five groups here look and behave exactly like the inventory and purchasing
// libraries. Every destination is `/reports/receivables/<id>` — the section
// never links out of /reports and never uses a same-page anchor.
//
// A report whose extra capability the viewer lacks (`data-quality` needs
// `o2c.data_quality`) is simply not listed. No capability is added or widened
// here; the row is hidden, and the backend still refuses the request.
import { PageHeader } from "@/shared/ui";
import { usePermissions } from "@/shared/permissions";
import { useT } from "@/i18n";
import { ReportDirectory, type ReportDirectoryGroup } from "../components/ReportDirectory";
import { RECEIVABLES_GROUPS, RECEIVABLES_REPORT_BY_ID, receivablesReportPath } from "./registry";

export function ReceivablesReportsDirectory() {
  const t = useT();
  const { can } = usePermissions();

  const groups: ReportDirectoryGroup[] = RECEIVABLES_GROUPS.map((group) => ({
    id: group.id,
    title: t(`receivablesReports.groups.${group.id}.title`),
    icon: group.icon,
    items: group.reports
      .map((id) => RECEIVABLES_REPORT_BY_ID[id])
      .filter((report) => !!report && (!report.cap || can(report.cap)))
      .map((report) => ({
        id: report!.id,
        title: t(`receivablesReports.reports.${report!.i18nKey}.title`),
        to: receivablesReportPath(report!.id),
        icon: report!.icon,
        tone: group.tone,
      })),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <PageHeader title={t("receivablesReports.directoryTitle")} />
      <ReportDirectory
        groups={groups}
        openLabel={t("misc.reports.directory.open")}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </>
  );
}

export default ReceivablesReportsDirectory;
