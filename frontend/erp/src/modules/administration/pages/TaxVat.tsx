import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileBarChart, ShieldCheck } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Badge,
  LoadingState,
  ErrorState,
  PageHeader,
  StatusBadge,
  Tabs,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import { asArray } from "../_common";
import { ZatcaOnboardingWizard } from "../zatca/OnboardingWizard";
import { useZatcaStatus } from "../zatca/api";

interface VatReport {
  id: string;
  periodStart: string;
  periodEnd: string;
  totalOutputVat: number;
  totalInputVat: number;
  netVat: number;
  status: string;
  createdBy: string;
}
// VAT report statuses map onto the shared record-status codes so <StatusBadge>
// localizes them (status.*). Unknown values fall through to the raw string.
const VAT_STATUS_CODE: Record<string, string> = {
  submitted: "sent",
  closed: "closed",
  draft: "draft",
  open: "inProgress",
};
const CSID_CODES = ["none", "compliance", "production", "revoked"];

function VatReportsTab() {
  const t = useT();
  const query = useQuery({
    queryKey: ["erp", "vat-reports"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/vat/reports", { signal }),
  });
  const rows = asArray<VatReport>(query.data);

  const statusLabel = (status: string): string => {
    const code = VAT_STATUS_CODE[status];
    return code ? t(`status.${code}`) : status || "—";
  };

  const columns: ColumnDef<VatReport>[] = [
    {
      id: "period",
      header: t("administration.tax.vat.col.period"),
      accessor: (r) => r.periodStart,
      cell: (r) => `${formatDate(r.periodStart)} — ${formatDate(r.periodEnd)}`,
      sortable: true,
    },
    {
      id: "output",
      header: t("administration.tax.vat.col.output"),
      accessor: (r) => r.totalOutputVat,
      cell: (r) => formatCurrency(r.totalOutputVat),
      numeric: true,
    },
    {
      id: "input",
      header: t("administration.tax.vat.col.input"),
      accessor: (r) => r.totalInputVat,
      cell: (r) => formatCurrency(r.totalInputVat),
      numeric: true,
    },
    {
      id: "net",
      header: t("administration.tax.vat.col.net"),
      accessor: (r) => r.netVat,
      cell: (r) => formatCurrency(r.netVat),
      numeric: true,
    },
    {
      id: "status",
      header: t("administration.tax.vat.col.status"),
      accessor: (r) => statusLabel(r.status),
      cell: (r) => <StatusBadge>{VAT_STATUS_CODE[r.status] ?? r.status ?? "—"}</StatusBadge>,
    },
    { id: "createdBy", header: t("administration.tax.vat.col.createdBy"), accessor: (r) => r.createdBy || "—" },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={(r) => String(r.id)}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => query.refetch()}
      exportFilename="vat-reports.csv"
      tableId="admin-vat-reports"
      initialSort={{ columnId: "period", dir: "desc" }}
      emptyTitle={t("administration.tax.vat.empty")}
      emptyBody={t("administration.tax.vat.emptyBody")}
    />
  );
}

function ZatcaTab() {
  const t = useT();
  const query = useZatcaStatus();

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const s = query.data;
  if (!s) return null;
  const q = s.queueStats ?? {};
  const csid = s.csidStatus ?? "none";
  const active = csid === "production";
  const csidLabel = CSID_CODES.includes(csid) ? t(`administration.tax.csid.${csid}`) : csid;

  const stat = (label: string, value: string | number, tone?: "success" | "warning" | "danger") => (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-400">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-lg font-extrabold text-slate-900" dir="ltr">
          {value}
        </span>
        {tone && (
          <Badge tone={tone}>
            {tone === "success"
              ? t("administration.tax.zatca.toneSuccess")
              : tone === "warning"
                ? t("administration.tax.zatca.toneWarning")
                : t("administration.tax.zatca.toneDanger")}
          </Badge>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="surface flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-50 text-teal-700">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <div className="text-base font-extrabold text-slate-900">{t("administration.tax.zatca.statusTitle")}</div>
            <div className="text-xs font-medium text-slate-500">
              {s?.sellerName || "—"} · {t("administration.tax.zatca.taxNumberLabel", { vat: s?.sellerVat || "—" })}
            </div>
          </div>
        </div>
        <StatusBadge tone={active ? "success" : "warning"}>{csidLabel}</StatusBadge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stat(t("administration.tax.zatca.certDate"), s?.csidObtainedAt ? formatDate(s.csidObtainedAt) : "—")}
        {stat(t("administration.tax.zatca.lastSubmit"), s?.lastSubmittedAt ? formatDate(s.lastSubmittedAt) : "—")}
        {stat(t("administration.tax.zatca.pending"), q.pending ?? 0)}
        {stat(t("administration.tax.zatca.failed"), q.failed ?? 0, (q.failed ?? 0) > 0 ? "danger" : undefined)}
      </div>

      <ZatcaOnboardingWizard status={s} />
    </div>
  );
}

export default function TaxVatPage() {
  const t = useT();
  const [tab, setTab] = useState("vat");
  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.tax.title")}
        subtitle={t("administration.tax.subtitle")}
      />
      <Tabs
        aria-label={t("administration.tax.tabsAria")}
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          {
            value: "vat",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <FileBarChart className="h-4 w-4" /> {t("administration.tax.tabVat")}
              </span>
            ),
          },
          {
            value: "zatca",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" /> {t("administration.tax.tabZatca")}
              </span>
            ),
          },
        ]}
      />
      {tab === "vat" ? <VatReportsTab /> : <ZatcaTab />}
    </div>
  );
}
