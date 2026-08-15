// /reports/financial — the catalogue of the eleven financial reports.
//
// Every `to` points INSIDE /reports/. That is the whole point of this page:
// the section it replaced listed the same reports but linked out to
// /accounting/*, so opening a report from the Reports centre threw the user
// into a different top-level section of the app and left them there.
//
// Rendered through the shared `ReportDirectory`, the same renderer the sales,
// inventory and purchasing catalogues use, so all four stay one thing. Nothing
// here is a note, a hint or a caption: a catalogue row is an icon, a name and
// the link that opens it.
import {
  Boxes,
  Building2,
  Calculator,
  Gauge,
  HandCoins,
  Landmark,
  Layers,
  LineChart,
  PiggyBank,
  Scale,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { usePermissions } from "@/shared/permissions";
import { useT } from "@/i18n";
import {
  ReportDirectory,
  type ReportDirectoryGroup,
  type ReportDirectoryTone,
} from "../components/ReportDirectory";
import {
  FINANCIAL_REPORT_BY_ID,
  financialReportPath,
  type FinancialReportId,
} from "./registry";

const REPORT_ICONS: Record<FinancialReportId, LucideIcon> = {
  "income-statement": TrendingUp,
  "balance-sheet": Building2,
  "cash-flow": LineChart,
  "equity-changes": Landmark,
  "general-ledger": Layers,
  "trial-balance": Scale,
  "financial-ratios": Gauge,
  "ar-aging": HandCoins,
  "ap-aging": PiggyBank,
  profitability: Calculator,
  "inventory-valuation": Boxes,
};

/**
 * The three families, in reading order.
 *
 * The split is by what the reader is holding, not by which module wrote it:
 * the four IFRS statements first, then the ledger and the balances that prove
 * them, then what is owed and what is held. `financial-ratios` sits with the
 * ledger rather than with the statements because it is a derived reading of
 * balances, not a statement anyone signs.
 */
const GROUPS: Array<{
  id: string;
  titleKey: string;
  icon: LucideIcon;
  tone: ReportDirectoryTone;
  reports: FinancialReportId[];
}> = [
  {
    id: "financial-statements",
    titleKey: "misc.reports.groups.financialStatements.title",
    icon: Landmark,
    tone: "teal",
    reports: ["income-statement", "balance-sheet", "cash-flow", "equity-changes"],
  },
  {
    id: "ledger-control",
    titleKey: "misc.reports.groups.ledgerControl.title",
    icon: Layers,
    tone: "blue",
    reports: ["general-ledger", "trial-balance", "financial-ratios"],
  },
  {
    id: "receivables-payables",
    titleKey: "misc.reports.groups.receivablesPayables.title",
    icon: HandCoins,
    tone: "amber",
    reports: ["ar-aging", "ap-aging", "profitability", "inventory-valuation"],
  },
];

export default function FinancialReportsDirectory() {
  const t = useT();
  const { can } = usePermissions();

  const groups: ReportDirectoryGroup[] = GROUPS.map((group) => ({
    id: group.id,
    title: t(group.titleKey),
    icon: group.icon,
    items: group.reports
      // A report the reader cannot open is not shown. The capability is the
      // one the report already carried — see registry.ts.
      .map((id) => FINANCIAL_REPORT_BY_ID[id])
      .filter((report): report is NonNullable<typeof report> => !!report && can(report.cap))
      .map((report) => ({
        id: report.id,
        title: t(report.labelKey),
        to: financialReportPath(report.id),
        icon: REPORT_ICONS[report.id],
        tone: group.tone,
      })),
  })).filter((group) => group.items.length > 0);

  return (
    <div>
      <PageHeader title={t("misc.reports.sections.financial.title")} />
      <ReportDirectory
        groups={groups}
        openLabel={t("misc.reports.directory.open")}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </div>
  );
}
