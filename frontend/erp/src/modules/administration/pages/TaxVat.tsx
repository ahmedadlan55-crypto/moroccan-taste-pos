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
import { asArray, DeferredNote } from "../_common";

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
interface ZatcaStatus {
  success?: boolean;
  csidStatus: string;
  csidObtainedAt: string | null;
  requestId: string | null;
  sellerName: string;
  sellerVat: string;
  lastSubmittedAt: string | null;
  queueStats: { pending?: number; running?: number; done?: number; failed?: number };
}

const VAT_STATUS_AR: Record<string, string> = {
  submitted: "مُرسل",
  closed: "مغلق",
  draft: "مسودة",
  open: "قيد التنفيذ",
};
const CSID_AR: Record<string, string> = {
  none: "غير مُفعّل",
  compliance: "امتثال (تجريبي)",
  production: "إنتاج (مُفعّل)",
};

function VatReportsTab() {
  const query = useQuery({
    queryKey: ["erp", "vat-reports"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/vat/reports", { signal }),
  });
  const rows = asArray<VatReport>(query.data);

  const columns: ColumnDef<VatReport>[] = [
    {
      id: "period",
      header: "الفترة",
      accessor: (r) => r.periodStart,
      cell: (r) => `${formatDate(r.periodStart)} — ${formatDate(r.periodEnd)}`,
      sortable: true,
    },
    {
      id: "output",
      header: "ضريبة المخرجات",
      accessor: (r) => r.totalOutputVat,
      cell: (r) => formatCurrency(r.totalOutputVat),
      numeric: true,
    },
    {
      id: "input",
      header: "ضريبة المدخلات",
      accessor: (r) => r.totalInputVat,
      cell: (r) => formatCurrency(r.totalInputVat),
      numeric: true,
    },
    {
      id: "net",
      header: "صافي الضريبة",
      accessor: (r) => r.netVat,
      cell: (r) => formatCurrency(r.netVat),
      numeric: true,
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => VAT_STATUS_AR[r.status] ?? r.status,
      cell: (r) => <StatusBadge>{VAT_STATUS_AR[r.status] ?? r.status ?? "—"}</StatusBadge>,
    },
    { id: "createdBy", header: "أنشأها", accessor: (r) => r.createdBy || "—" },
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
      emptyTitle="لا توجد إقرارات ضريبية"
      emptyBody="ستظهر هنا إقرارات ضريبة القيمة المضافة بعد إقفال الفترات."
    />
  );
}

function ZatcaTab() {
  const query = useQuery({
    queryKey: ["erp", "zatca-status"],
    queryFn: ({ signal }) => apiClient.get<ZatcaStatus>("/erp/zatca/status", { signal }),
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const s = query.data;
  const q = s?.queueStats ?? {};
  const csid = s?.csidStatus ?? "none";
  const active = csid === "production";

  const stat = (label: string, value: string | number, tone?: "success" | "warning" | "danger") => (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-400">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-lg font-extrabold text-slate-900" dir="ltr">
          {value}
        </span>
        {tone && <Badge tone={tone}>{tone === "success" ? "سليم" : tone === "warning" ? "انتباه" : "خطأ"}</Badge>}
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
            <div className="text-base font-extrabold text-slate-900">حالة الربط مع هيئة الزكاة (ZATCA)</div>
            <div className="text-xs font-medium text-slate-500">
              {s?.sellerName || "—"} · الرقم الضريبي {s?.sellerVat || "—"}
            </div>
          </div>
        </div>
        <StatusBadge tone={active ? "success" : "warning"}>{CSID_AR[csid] ?? csid}</StatusBadge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stat("تاريخ إصدار الشهادة", s?.csidObtainedAt ? formatDate(s.csidObtainedAt) : "—")}
        {stat("آخر إرسال فاتورة", s?.lastSubmittedAt ? formatDate(s.lastSubmittedAt) : "—")}
        {stat("قيد الانتظار", q.pending ?? 0)}
        {stat("فشل", q.failed ?? 0, (q.failed ?? 0) > 0 ? "danger" : undefined)}
      </div>

      <DeferredNote
        eyebrow="ZATCA"
        title="تهيئة الربط (المرحلة الثانية)"
        body="خطوات التسجيل والحصول على شهادة الامتثال والإنتاج (Onboarding Phase 2) ما تزال تُدار من النظام الأصلي."
      />
    </div>
  );
}

export default function TaxVatPage() {
  const [tab, setTab] = useState("vat");
  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="الضرائب"
        subtitle="إقرارات ضريبة القيمة المضافة وحالة الربط مع هيئة الزكاة والضريبة."
      />
      <Tabs
        aria-label="أقسام الضرائب"
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          {
            value: "vat",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <FileBarChart className="h-4 w-4" /> إقرارات القيمة المضافة
              </span>
            ),
          },
          {
            value: "zatca",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" /> حالة ZATCA
              </span>
            ),
          },
        ]}
      />
      {tab === "vat" ? <VatReportsTab /> : <ZatcaTab />}
    </div>
  );
}
