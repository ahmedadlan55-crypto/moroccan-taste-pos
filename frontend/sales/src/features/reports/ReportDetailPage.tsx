import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download, Printer } from "lucide-react";
import { o2cApi } from "@/lib/api";
import { qk } from "@/lib/query-keys";
import { useCan } from "@/app/permission-provider";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { TableShell, Th, Td } from "@/features/_shared/ui";
import { formatNumber } from "@/lib/formatters";
import type { ReportColumn } from "@/lib/types";

const REPORT_LABEL: Record<string, string> = {
  "sales-summary": "ملخص المبيعات", "sales-by-customer": "المبيعات حسب العميل", "sales-by-product": "المبيعات حسب الصنف",
  "sales-by-channel": "المبيعات حسب القناة", "sales-by-cashier": "المبيعات حسب الكاشير", "ar-aging": "أعمار الذمم",
  "open-invoices": "الفواتير المفتوحة", collections: "التحصيلات", "unallocated-payments": "دفعات غير مخصّصة",
  "credit-exposure": "التعرّض الائتماني", returns: "المرتجعات", "zatca-status": "حالة زاتكا", "data-quality": "جودة البيانات",
};
const today = new Date().toISOString().slice(0, 10);
const firstOfMonth = today.slice(0, 8) + "01";

function cell(v: unknown): { text: string; num: boolean } {
  if (typeof v === "number") return { text: formatNumber(v), num: true };
  if (v == null) return { text: "—", num: false };
  return { text: String(v), num: false };
}

export function ReportDetailPage() {
  const { type = "" } = useParams();
  const canExport = useCan("o2c.export");
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);

  const params = useMemo(() => ({ from, to }), [from, to]);
  const q = useQuery({
    queryKey: qk.reports(type, params),
    queryFn: ({ signal }) => o2cApi.report(type, params, signal),
    enabled: !!type,
  });

  const columns: ReportColumn[] = q.data?.columns ?? [];
  const rows = q.data?.data ?? [];

  function exportCsv() {
    const head = columns.map((c) => csvCell(c.label)).join(",");
    const body = rows.map((r) => columns.map((c) => csvCell(String((r as Record<string, unknown>)[c.key] ?? ""))).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + head + "\r\n" + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `o2c-${type}-${today}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print"><ArrowRight className="h-4 w-4" /> رجوع للتقارير</Link>
      <PageHeader
        eyebrow="تقرير"
        title={REPORT_LABEL[type] || type}
        action={
          <div className="flex items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => window.print()}><Printer className="ml-1 h-4 w-4" /> طباعة</Button>
            {canExport && <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}><Download className="ml-1 h-4 w-4" /> CSV</Button>}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 no-print">
        <label className="block"><span className="mb-1 block text-[11px] font-bold text-slate-500">من</span><input dir="ltr" type="date" className="field tabular-nums" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="block"><span className="mb-1 block text-[11px] font-bold text-slate-500">إلى</span><input dir="ltr" type="date" className="field tabular-nums" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>

      {q.isLoading ? <LoadingState rows={8} />
        : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : rows.length === 0 ? <EmptyState title="لا توجد بيانات" body="جرّب تغيير نطاق التاريخ." />
        : (
          <TableShell head={<tr>{columns.map((c) => <Th key={c.key}>{c.label}</Th>)}</tr>}>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-slate-50/60">
                {columns.map((c) => {
                  const { text, num } = cell((r as Record<string, unknown>)[c.key]);
                  return <Td key={c.key}>{num ? <span dir="ltr" className="tabular-nums">{text}</span> : text}</Td>;
                })}
              </tr>
            ))}
          </TableShell>
        )}

      {q.data?.totals && Object.keys(q.data.totals).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {Object.entries(q.data.totals).map(([k, v]) => (
            <span key={k} className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-bold text-slate-600">
              {k}: <span dir="ltr" className="tabular-nums text-slate-900">{formatNumber(Number(v))}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function csvCell(v: string): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
