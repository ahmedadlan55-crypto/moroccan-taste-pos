import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowRight, Download, Printer, ArrowUpDown, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useReport } from "@/modules/inventory/lib/hooks/useReport";
import { downloadReportCsv } from "@/shared/lib";
import { formatCurrency, formatNumber, formatQty, formatDate, formatDateTime } from "@/shared/lib";
import { REPORTS, type ColFormat, type ReportColumn } from "@/modules/inventory/lib/reports-config";

const STATUS_OPTIONS: Record<string, { value: string; label: string }[]> = {
  "stock-balance": [
    { value: "available", label: "متوفر" }, { value: "low", label: "منخفض" },
    { value: "out", label: "نافد" }, { value: "negative", label: "سالب" },
  ],
  transfers: [
    { value: "approved", label: "معتمد" }, { value: "issued", label: "مُصدر" },
    { value: "partially_received", label: "استلام جزئي" }, { value: "received", label: "مستلم" },
    { value: "cancelled", label: "ملغى" }, { value: "reversed", label: "معكوس" },
  ],
  "receipts-issues": [
    { value: "approved", label: "معتمد" }, { value: "issued", label: "مُصدر" },
    { value: "received", label: "مستلم" }, { value: "cancelled", label: "ملغى" },
  ],
  adjustments: [{ value: "pending", label: "بانتظار" }, { value: "approved", label: "معتمد" }],
};

function fmt(v: unknown, format?: ColFormat): string {
  const numeric = format === "currency" || format === "qty" || format === "number";
  if (v == null || v === "") return numeric ? formatNumber(0) : "—";
  switch (format) {
    case "currency": return formatCurrency(Number(v));
    case "qty": return formatQty(Number(v));
    case "number": return formatNumber(Number(v));
    case "date": return formatDate(String(v));
    case "datetime": return formatDateTime(String(v));
    default: return String(v);
  }
}

function StatusPill({ label }: { label: string }) {
  const bad = /سالب|نافد|منتهٍ|حرج|مرفوض|ملغى/.test(label);
  const warn = /منخفض|قريب|جزئي|بانتظار/.test(label);
  const cls = bad ? "bg-rose-50 text-rose-700" : warn ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700";
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${cls}`}>{label || "—"}</span>;
}

export function ReportDetailPage() {
  const { reportType = "" } = useParams();
  const config = REPORTS[reportType];
  const { scope } = useWarehouseScope();
  const [params, setParams] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize")) || 25));
  const sort = params.get("sort") || config?.defaultSort?.sort || "";
  const dir = (params.get("dir") as "asc" | "desc") || config?.defaultSort?.dir || "desc";
  const filters = useMemo(() => ({
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    category: params.get("category") || undefined,
    status: params.get("status") || undefined,
    type: params.get("type") || undefined,
    q: params.get("q") || undefined,
    window: Number(params.get("window")) || undefined,
    page, pageSize, sort: sort || undefined, dir,
  }), [params, page, pageSize, sort, dir]);

  const { data, isLoading, isError, error, refetch, isFetching } = useReport(reportType, scope, filters);

  if (!config) {
    return (
      <div>
        <PageHeader eyebrow="التقارير" title="تقرير غير معروف" />
        <EmptyState title="تقرير غير معروف" body="لا يوجد تقرير بهذا الاسم." action={<Link className="text-sm font-bold text-teal-700" to="/reports">العودة لمركز التقارير</Link>} />
      </div>
    );
  }

  function patch(next: Record<string, string | number | undefined>, resetPage = true) {
    const sp = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => {
      if (v === undefined || v === "" || v === null) sp.delete(k);
      else sp.set(k, String(v));
    });
    if (resetPage) sp.delete("page");
    setParams(sp, { replace: true });
  }

  function toggleSort(col: ReportColumn) {
    if (!col.sortKey) return;
    const nextDir = sort === col.sortKey && dir === "desc" ? "asc" : "desc";
    patch({ sort: col.sortKey, dir: nextDir }, false);
  }

  async function onExport() {
    setExportError(null);
    setExporting(true);
    try {
      await downloadReportCsv(reportType, {
        warehouseId: scope && scope !== ALL_WAREHOUSES ? scope : undefined,
        from: filters.from, to: filters.to, category: filters.category, status: filters.status,
        type: filters.type, q: filters.q, window: filters.window, sort: filters.sort, dir,
      });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "تعذّر التصدير.");
    } finally {
      setExporting(false);
    }
  }

  const rows = data?.rows ?? [];
  const totals = data?.totals ?? {};
  const pagination = data?.pagination ?? null;
  const total = pagination?.total ?? rows.length;
  const totalPages = pagination?.totalPages ?? 1;
  const fromRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const toRow = Math.min(page * pageSize, total);
  const scopeLabel = data?.scope?.allWarehousesAccess && scope === ALL_WAREHOUSES ? "كل المستودعات المتاحة" : `مستودع: ${scope}`;
  const hasDateRange = config.filters.includes("dateRange");
  const statusOpts = STATUS_OPTIONS[reportType];

  const actions = (
    <div className="no-print flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={onExport} disabled={exporting}>
        <Download className="h-4 w-4" /> {exporting ? "جارٍ التصدير…" : "تصدير CSV"}
      </Button>
      <Button variant="secondary" onClick={() => window.print()}>
        <Printer className="h-4 w-4" /> طباعة
      </Button>
      <Link to="/reports" className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
        <ArrowRight className="h-4 w-4" /> التقارير
      </Link>
    </div>
  );

  return (
    <div>
      <PageHeader eyebrow="تقرير" title={config.label} subtitle={`${scopeLabel} · ${total} صف`} action={actions} />

      {/* Filters */}
      {(config.filters.length > 0) && (
        <div className="no-print surface mb-4 flex flex-wrap items-end gap-3 p-4">
          {hasDateRange && (
            <>
              <label className="text-xs font-bold text-slate-500">من
                <input type="date" className="field mt-1 block" value={filters.from ?? ""} onChange={(e) => patch({ from: e.target.value })} />
              </label>
              <label className="text-xs font-bold text-slate-500">إلى
                <input type="date" className="field mt-1 block" value={filters.to ?? ""} onChange={(e) => patch({ to: e.target.value })} />
              </label>
            </>
          )}
          {config.filters.includes("category") && (
            <label className="text-xs font-bold text-slate-500">الفئة
              <input type="text" className="field mt-1 block" placeholder="كل الفئات" value={filters.category ?? ""} onChange={(e) => patch({ category: e.target.value })} />
            </label>
          )}
          {config.filters.includes("type") && (
            <label className="text-xs font-bold text-slate-500">نوع الحركة
              <select className="field mt-1 block" value={filters.type ?? ""} onChange={(e) => patch({ type: e.target.value })}>
                <option value="">الكل</option><option value="in">وارد</option><option value="out">صادر</option>
              </select>
            </label>
          )}
          {config.filters.includes("status") && statusOpts && (
            <label className="text-xs font-bold text-slate-500">الحالة
              <select className="field mt-1 block" value={filters.status ?? ""} onChange={(e) => patch({ status: e.target.value })}>
                <option value="">الكل</option>
                {statusOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {config.filters.includes("window") && (
            <label className="text-xs font-bold text-slate-500">نافذة عدم الحركة
              <select className="field mt-1 block" value={filters.window ?? 90} onChange={(e) => patch({ window: e.target.value })}>
                {[30, 60, 90, 180].map((w) => <option key={w} value={w}>{w} يومًا</option>)}
              </select>
            </label>
          )}
          {config.filters.includes("q") && (
            <label className="text-xs font-bold text-slate-500">بحث
              <input type="text" className="field mt-1 block" placeholder="اسم الصنف…" value={filters.q ?? ""} onChange={(e) => patch({ q: e.target.value })} />
            </label>
          )}
        </div>
      )}

      {exportError && (
        <div className="no-print mb-4 flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          <AlertTriangle className="h-4 w-4" /> {exportError}
        </div>
      )}

      {/* Data-quality warnings */}
      {data?.warnings && data.warnings.length > 0 && (
        <div className="mb-4 space-y-2">
          {data.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading && <LoadingState />}
      {isError && <ErrorState error={error} onRetry={refetch} />}

      {data && !isError && (
        <article className="surface overflow-hidden">
          {/* Totals strip */}
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-slate-100 px-5 py-4">
            {config.totals.map((t) => (
              <div key={t.key}>
                <div className="text-xs font-bold text-slate-400">{t.label}</div>
                <div className="text-base font-extrabold text-slate-900 tabular-nums">{fmt(totals[t.key], t.format)}</div>
              </div>
            ))}
            <div className="ms-auto self-end text-xs font-medium text-slate-400">
              تم التوليد: {formatDateTime(data.generatedAt)} {isFetching && !isLoading ? "· جارٍ التحديث…" : ""}
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState title="لا توجد بيانات مطابقة" body="جرّب توسيع الفلاتر أو تغيير الفترة." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-start text-xs font-bold text-slate-500">
                    {config.columns.map((c) => (
                      <th key={c.key} className="px-4 py-3 text-start">
                        {c.sortKey ? (
                          <button type="button" onClick={() => toggleSort(c)} className="inline-flex items-center gap-1 hover:text-teal-700">
                            {c.label}
                            <ArrowUpDown className={`h-3 w-3 ${sort === c.sortKey ? "text-teal-600" : "text-slate-300"}`} />
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                      {config.columns.map((c) => {
                        const v = row[c.key];
                        const isNeg = (c.format === "currency" || c.format === "qty" || c.format === "number") && Number(v) < 0;
                        return (
                          <td key={c.key} className={`px-4 py-3 ${c.format === "currency" || c.format === "qty" || c.format === "number" ? "tabular-nums" : ""} ${isNeg ? "font-bold text-rose-600" : "text-slate-700"}`}>
                            {c.format === "status" ? <StatusPill label={String(v ?? "")} /> : fmt(v, c.format)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {pagination && total > 0 && (
            <div className="no-print flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-sm">
              <div className="font-medium text-slate-500">عرض {formatNumber(fromRow)}–{formatNumber(toRow)} من {formatNumber(total)}</div>
              <div className="flex items-center gap-2">
                <select className="field" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })}>
                  {[25, 50, 100, 200].map((s) => <option key={s} value={s}>{s} / صفحة</option>)}
                </select>
                <Button variant="secondary" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)} aria-label="السابق">السابق</Button>
                <span className="px-1 font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="secondary" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)} aria-label="التالي">التالي</Button>
              </div>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
