import {
  BarChart3,
  Boxes,
  Calculator,
  CalendarClock,
  CreditCard,
  FileSearch,
  GitCompareArrows,
  PackageSearch,
  ReceiptText,
  RotateCcw,
  SlidersHorizontal,
  Store,
  Tags,
  UserRoundSearch,
  WalletCards,
} from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { usePermissions } from "@/shared/permissions";
import { useT } from "@/i18n";
import { ReportDirectory, type ReportDirectoryGroup, type ReportDirectoryTone } from "../../components/ReportDirectory";
import { CENTERS, REPORT_BY_ID } from "../lib/reportRegistry";

const REPORT_ICONS = {
  executive: BarChart3,
  items: PackageSearch,
  profitability: Calculator,
  modifiers: Tags,
  payments: WalletCards,
  taxes: ReceiptText,
  discounts: CreditCard,
  reconciliation: GitCompareArrows,
  branches: Store,
  channels: Boxes,
  hours: CalendarClock,
  cashiers: UserRoundSearch,
  shifts: Store,
  voids: RotateCcw,
  orders: FileSearch,
  explorer: SlidersHorizontal,
  builder: SlidersHorizontal,
} as const;

const CENTER_ICONS = {
  executive: BarChart3,
  items: PackageSearch,
  payments: WalletCards,
  operations: Store,
  explorer: SlidersHorizontal,
} as const;

const CENTER_TONES: Record<string, ReportDirectoryTone> = {
  executive: "teal",
  items: "amber",
  payments: "blue",
  operations: "violet",
  explorer: "lime",
};

export default function SalesReportsDirectory() {
  const t = useT();
  const { can } = usePermissions();
  const groups: ReportDirectoryGroup[] = CENTERS.map((center) => ({
    id: center.id,
    title: t(`salesReports.centers.${center.id}.title`),
    description: t(`salesReports.centers.${center.id}.subtitle`),
    icon: CENTER_ICONS[center.id],
    items: center.views
      .map((id) => REPORT_BY_ID[id])
      .filter((report) => !!report && (!report.cap || can(report.cap)))
      .map((report) => ({
        id: report.id,
        title: t(`salesReports.pages.${report.id}.title`),
        description: t(`salesReports.pages.${report.id}.subtitle`),
        to: `/reports/sales/${report.center}?view=${report.id}`,
        icon: REPORT_ICONS[report.id as keyof typeof REPORT_ICONS] ?? BarChart3,
        tone: CENTER_TONES[center.id],
      })),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <PageHeader eyebrow={t("salesReports.hub.eyebrow")} title={t("salesReports.hub.title")} subtitle={t("salesReports.hub.subtitle")} />
      <ReportDirectory
        groups={groups}
        searchLabel={t("misc.reports.directory.searchLabel")}
        searchPlaceholder={t("misc.reports.directory.searchPlaceholder")}
        openLabel={t("misc.reports.directory.open")}
        countLabel={(count) => t("misc.reports.directory.count", { count })}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </>
  );
}
