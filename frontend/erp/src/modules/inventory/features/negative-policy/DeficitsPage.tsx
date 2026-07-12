// Phase W2 — deficit ledger («عجز مخزني يجب تسويته»). KPI cards + filters +
// table/mobile cards + CSV export. Backend contract note: GET /deficits is NOT
// paginated server-side (it returns every row for status/warehouseId, already
// scoped to the caller's warehouses), so we fetch status=all once and do
// status/date/search filtering + pagination client-side; the KPIs therefore
// always reflect the full (warehouse-scoped) ledger, not the current filter.

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ChevronLeft, ChevronRight, Download, Layers, Search, ShieldCheck, Wallet,
} from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState, PermissionDenied } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useDeficits, downloadDeficitsCsv } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import { formatCurrency, formatDateTime, formatNumber, formatQty } from "@/shared/lib";
import type { DeficitRow } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { DEFICIT_STATUS_OPTIONS, originDocLabel } from "./labels";
import { DeficitStatusBadge } from "./shared";

const PAGE_SIZES = [10, 25, 50];

function inDateRange(createdAt: string | null, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return true;
  if (from) {
    const f = new Date(`${from}T00:00:00`).getTime();
    if (!Number.isNaN(f) && t < f) return false;
  }
  if (to) {
    const e = new Date(`${to}T23:59:59.999`).getTime();
    if (!Number.isNaN(e) && t > e) return false;
  }
  return true;
}

function matchesQuery(r: DeficitRow, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return [r.id, r.itemName, r.warehouseName, r.originDocId, r.originDocType, r.reason, r.createdBy]
    .some((v) => v.toLowerCase().includes(needle));
}

export function DeficitsPage() {
  const canView = useCan("negativePolicy.view");
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, String(v));
    }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  // One warehouse-scoped fetch of the whole ledger; the rest is client-side.
  const { data, isLoading, isError, error, refetch, isFetching } = useDeficits({
    status: "all",
    warehouseId: warehouseId || undefined,
  });

  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const allRows = useMemo(() => data?.rows ?? [], [data]);

  const kpis = useMemo(() => {
    const open = allRows.filter((r) => r.status === "open" || r.status === "partial");
    return {
      openCount: open.length,
      remainingQty: open.reduce((sum, r) => sum + r.remainingQty, 0),
      remainingValue: open.reduce((sum, r) => sum + r.remainingValue, 0),
      settledCount: allRows.filter((r) => r.status === "covered" || r.status === "adjusted").length,
    };
  }, [allRows]);

  const filtered = useMemo(
    () =>
      allRows.filter(
        (r) =>
          (!status || r.status === status) &&
          inDateRange(r.createdAt, dateFrom, dateTo) &&
          matchesQuery(r, q),
      ),
    [allRows, status, dateFrom, dateTo, q],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const from = filtered.length > 0 ? (safePage - 1) * pageSize + 1 : 0;
  const to = Math.min(safePage * pageSize, filtered.length);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  async function onExport() {
    setExporting(true);
    setExportError(null);
    try {
      // Server export honors status/warehouseId only (date/search are
      // client-side filters). Server 'open' = open+partial by contract.
      await downloadDeficitsCsv({ status: status || "all", warehouseId: warehouseId || undefined });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "تعذّر تصدير سجل العجوزات.");
    } finally {
      setExporting(false);
    }
  }

  if (!canView) return <PermissionDenied />;

  const hasFilters = !!(q || status || warehouseId || dateFrom || dateTo);

  return (
    <div>
      <PageHeader
        eyebrow="الرقابة المخزنية"
        title="سجل العجوزات المخزنية"
        subtitle="كل صرف تحت الصفر جرى السماح به وفق سياسة «مقيّد/سماح» يُقيَّد هنا كعجز بتكلفة لحظة الصرف — ويبقى مفتوحًا حتى تغطيه استلامات لاحقة أو تسوية."
        action={
          <Button variant="secondary" onClick={onExport} disabled={exporting || isLoading}>
            {exporting ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            تصدير CSV
          </Button>
        }
      />

      {exportError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {exportError}
        </div>
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="عجوزات بحاجة تسوية"
              value={formatNumber(kpis.openCount)}
              note="مفتوحة أو مغطّاة جزئيًا"
              icon={AlertTriangle}
              tone="rose"
            />
            <MetricCard
              label="كمية متبقية دون تغطية"
              value={formatQty(kpis.remainingQty)}
              note="مجموع المتبقي في العجوزات المفتوحة"
              icon={Layers}
              tone="amber"
            />
            <MetricCard
              label="قيمة العجز المتبقي"
              value={formatCurrency(kpis.remainingValue)}
              note="بتكلفة الوحدة لحظة الصرف"
              icon={Wallet}
              tone="violet"
            />
            <MetricCard
              label="مغطّى / مسوّى"
              value={formatNumber(kpis.settledCount)}
              note="عجوزات أُغلقت بالتغطية أو التسوية"
              icon={ShieldCheck}
              tone="teal"
            />
          </section>

          <section className="surface mt-4 flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="field w-full pr-10"
                  placeholder="بحث بالصنف أو المستند الأصل أو السبب…"
                  defaultValue={q}
                  onChange={(e) => patch({ q: e.target.value })}
                  aria-label="بحث في العجوزات"
                />
              </label>
              <select
                className="field lg:w-52"
                value={warehouseId}
                onChange={(e) => patch({ wh: e.target.value })}
                aria-label="المستودع"
              >
                <option value="">كل المستودعات</option>
                {whOptions.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <input type="date" className="field lg:w-40" value={dateFrom} onChange={(e) => patch({ dateFrom: e.target.value })} aria-label="من تاريخ" />
              <input type="date" className="field lg:w-40" value={dateTo} onChange={(e) => patch({ dateTo: e.target.value })} aria-label="إلى تاريخ" />
            </div>
            <div className="flex flex-wrap gap-1">
              {DEFICIT_STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => patch({ status: o.value })}
                  className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${
                    status === o.value
                      ? "border-teal-600 bg-teal-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-4">
            {filtered.length === 0 ? (
              <EmptyState
                title="لا توجد عجوزات مطابقة"
                body={
                  hasFilters
                    ? "جرّب تعديل عوامل التصفية."
                    : "لم يُسجَّل أي عجز مخزني بعد — كل الصرف يتم من رصيد متاح."
                }
              />
            ) : (
              <>
                {/* Desktop table */}
                <div className="surface hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-right">الصنف</th>
                        <th className="px-4 py-3 text-right">المستودع</th>
                        <th className="px-4 py-3 text-right">المستند الأصل</th>
                        <th className="px-4 py-3 text-right">العجز</th>
                        <th className="px-4 py-3 text-right">المتبقي</th>
                        <th className="px-4 py-3 text-right">القيمة المتبقية</th>
                        <th className="px-4 py-3 text-right">الحالة</th>
                        <th className="px-4 py-3 text-right">السبب</th>
                        <th className="px-4 py-3 text-right">التاريخ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageRows.map((r) => (
                        <tr key={r.id} className="transition hover:bg-slate-50">
                          <td className="px-4 py-3 font-extrabold text-slate-900">{r.itemName}</td>
                          <td className="px-4 py-3 text-slate-600">{r.warehouseName}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-bold text-slate-700">{originDocLabel(r.originDocType)}</span>
                            <span className="mr-1 text-[11px] font-medium text-slate-400" dir="ltr">{r.originDocId}</span>
                          </td>
                          <td className="px-4 py-3 tabular-nums text-rose-700">{formatQty(r.deficitQty)}</td>
                          <td className="px-4 py-3 font-bold tabular-nums text-slate-800">{formatQty(r.remainingQty)}</td>
                          <td className="px-4 py-3 tabular-nums text-slate-700">{formatCurrency(r.remainingValue)}</td>
                          <td className="px-4 py-3"><DeficitStatusBadge status={r.status} /></td>
                          <td className="max-w-48 truncate px-4 py-3 text-xs text-slate-500" title={r.reason}>
                            {r.reason || "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            {formatDateTime(r.createdAt)}
                            <span className="block text-[10px] text-slate-400">{r.createdBy}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="space-y-3 md:hidden">
                  {pageRows.map((r) => (
                    <div key={r.id} className="surface p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-extrabold text-slate-900">{r.itemName}</span>
                        <DeficitStatusBadge status={r.status} />
                      </div>
                      <div className="mt-1 text-xs font-medium text-slate-500">
                        {r.warehouseName} · {originDocLabel(r.originDocType)}{" "}
                        <span dir="ltr">{r.originDocId}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500">
                        <span>العجز: <span className="font-bold tabular-nums text-rose-700">{formatQty(r.deficitQty)}</span></span>
                        <span>المتبقي: <span className="font-bold tabular-nums text-slate-800">{formatQty(r.remainingQty)}</span></span>
                        <span>القيمة: <span className="font-bold tabular-nums text-slate-800">{formatCurrency(r.remainingValue)}</span></span>
                      </div>
                      {r.reason && <div className="mt-2 text-xs font-medium text-slate-500">السبب: {r.reason}</div>}
                      <div className="mt-2 text-[11px] font-medium text-slate-400">
                        {formatDateTime(r.createdAt)} · {r.createdBy}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
                  <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                    <span>
                      عرض {formatNumber(from)}–{formatNumber(to)} من {formatNumber(filtered.length)}
                    </span>
                    <select
                      className="field min-h-9 py-1 text-xs"
                      value={pageSize}
                      onChange={(e) => patch({ pageSize: e.target.value })}
                      aria-label="حجم الصفحة"
                    >
                      {PAGE_SIZES.map((s) => (
                        <option key={s} value={s}>{s} / صفحة</option>
                      ))}
                    </select>
                    {isFetching && <span className="text-teal-600">تحديث…</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" aria-label="السابق" disabled={safePage <= 1} onClick={() => patch({ page: safePage - 1 }, false)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <span className="text-xs font-bold text-slate-600">
                      {formatNumber(safePage)} / {formatNumber(totalPages)}
                    </span>
                    <Button variant="ghost" size="icon" aria-label="التالي" disabled={safePage >= totalPages} onClick={() => patch({ page: safePage + 1 }, false)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
