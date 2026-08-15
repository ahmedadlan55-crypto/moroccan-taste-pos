// The purchasing report catalogue.
//
// Every row opens `/reports/purchasing/<id>` — its own page, in this section.
// Nothing here is a `?report=X#anchor` into a workspace any more, so no row can
// scroll you to the middle of a wall of other reports, and no two rows can point
// at the same destination under different names.
//
// The WORKSPACE (WarehouseIntelligenceHub) is still reachable, deliberately as
// a workspace and not as a catalogue row: it is a live control surface — KPIs,
// supplier and trend tables, cost coverage, GRNI reconciliation, the purchase
// ledger — and none of those is a report you can print or export as a document.
// It gets one entry above the catalogue, at `/reports/purchasing?workspace=1`,
// the same shape the inventory side already uses.
import { Link } from "react-router-dom";
import { LayoutDashboard } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { useT } from "@/i18n";
import { usePermissions } from "@/app/providers";
import { ReportDirectory, type ReportDirectoryGroup } from "../components/ReportDirectory";
import { PURCHASING_REPORTS, PURCHASING_REPORT_GROUPS, purchasingReportPath } from "./registry";

export const PURCHASING_WORKSPACE_PATH = "/reports/purchasing?workspace=1";

export function PurchasingReportsDirectory() {
  const t = useT();
  const { can } = usePermissions();

  const groups: ReportDirectoryGroup[] = PURCHASING_REPORT_GROUPS.map((group) => ({
    id: group.id,
    title: t(group.titleKey),
    icon: group.icon,
    items: group.reports
      .map((id) => PURCHASING_REPORTS[id])
      .filter((report) => report.capsAny.some((cap) => can(cap)))
      .map((report) => ({
        id: report.id,
        title: t(report.labelKey),
        to: purchasingReportPath(report.id),
        icon: report.icon,
        tone: report.tone,
      })),
  })).filter((group) => group.items.length > 0);

  return (
    <div data-testid="purchasing-reports-directory">
      <PageHeader title={t("warehouseIntelligence.purchases.directoryTitle")} />

      <Link
        to={PURCHASING_WORKSPACE_PATH}
        data-testid="purchasing-workspace-link"
        className="surface mb-4 flex min-h-16 items-center gap-3 px-4 py-3 transition hover:border-teal-200 hover:bg-teal-50/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-900 text-white">
          <LayoutDashboard className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.purchases.title")}</span>
      </Link>

      <ReportDirectory
        groups={groups}
        openLabel={t("misc.reports.directory.open")}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </div>
  );
}

export default PurchasingReportsDirectory;
