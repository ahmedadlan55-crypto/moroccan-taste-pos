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
import { DatePicker, PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState, PermissionDenied } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useDeficits, downloadDeficitsCsv } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import { formatCurrency, formatDateTime, formatNumber, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import type { DeficitRow } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { DEFICIT_STATUS_FILTER_CODES, deficitStatusLabel, originDocLabel } from "./labels";
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
  const t = useT();
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
      setExportError(e instanceof Error && e.message ? e.message : t("inventoryRest.negativePolicy.csvExportFailed"));
    } finally {
      setExporting(false);
    }
  }

  if (!canView) return <PermissionDenied />;

  const hasFilters = !!(q || status || warehouseId || dateFrom || dateTo);

  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.negativePolicy.deficits.eyebrow")}
        title={t("inventoryRest.negativePolicy.deficits.title")}
        subtitle={t("inventoryRest.negativePolicy.deficits.subtitle")}
        action={
          <Button variant="secondary" onClick={onExport} disabled={exporting || isLoading}>
            {exporting ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {t("inventoryRest.ui.exportCsv")}
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
              label={t("inventoryRest.negativePolicy.deficits.kpi.open")}
              value={formatNumber(kpis.openCount)}
              note={t("inventoryRest.negativePolicy.deficits.kpi.openNote")}
              icon={AlertTriangle}
              tone="rose"
            />
            <MetricCard
              label={t("inventoryRest.negativePolicy.deficits.kpi.remainingQty")}
              value={formatQty(kpis.remainingQty)}
              note={t("inventoryRest.negativePolicy.deficits.kpi.remainingQtyNote")}
              icon={Layers}
              tone="amber"
            />
            <MetricCard
              label={t("inventoryRest.negativePolicy.deficits.kpi.remainingValue")}
              value={formatCurrency(kpis.remainingValue)}
              note={t("inventoryRest.negativePolicy.deficits.kpi.remainingValueNote")}
              icon={Wallet}
              tone="violet"
            />
            <MetricCard
              label={t("inventoryRest.negativePolicy.deficits.kpi.settled")}
              value={formatNumber(kpis.settledCount)}
              note={t("inventoryRest.negativePolicy.deficits.kpi.settledNote")}
              icon={ShieldCheck}
              tone="teal"
            />
          </section>

          <section className="surface mt-4 flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="field w-full ps-10"
                  placeholder={t("inventoryRest.negativePolicy.deficits.searchPlaceholder")}
                  defaultValue={q}
                  onChange={(e) => patch({ q: e.target.value })}
                  aria-label={t("inventoryRest.negativePolicy.deficits.searchAria")}
                />
              </label>
              <select
                className="field lg:w-52"
                value={warehouseId}
                onChange={(e) => patch({ wh: e.target.value })}
                aria-label={t("inventoryRest.negativePolicy.col.warehouse")}
              >
                <option value="">{t("inventoryRest.filter.allWarehouses")}</option>
                {whOptions.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <DatePicker className="lg:w-40" value={dateFrom} onChange={(v) => patch({ dateFrom: v })} aria-label={t("inventoryRest.negativePolicy.deficits.dateFromAria")} />
              <DatePicker className="lg:w-40" value={dateTo} onChange={(v) => patch({ dateTo: v })} aria-label={t("inventoryRest.negativePolicy.deficits.dateToAria")} />
            </div>
            <div className="flex flex-wrap gap-1">
              {DEFICIT_STATUS_FILTER_CODES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => patch({ status: code })}
                  className={`min-h-11 rounded-xl border px-3 text-xs font-extrabold transition ${
                    status === code
                      ? "border-teal-600 bg-teal-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {code === "" ? t("common.all") : deficitStatusLabel(t, code)}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-4">
            {filtered.length === 0 ? (
              <EmptyState
                title={t("inventoryRest.negativePolicy.deficits.emptyTitle")}
                body={
                  hasFilters
                    ? t("inventoryRest.ui.fixFilters")
                    : t("inventoryRest.negativePolicy.deficits.emptyBody")
                }
              />
            ) : (
              <>
                {/* Desktop table */}
                <div className="surface hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.item")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.warehouse")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.originDoc")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.deficit")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.remaining")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.remainingValue")}</th>
                        <th className="px-4 py-3 text-start">{t("common.status")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.reason")}</th>
                        <th className="px-4 py-3 text-start">{t("inventoryRest.negativePolicy.col.date")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageRows.map((r) => (
                        <tr key={r.id} className="transition hover:bg-slate-50">
                          <td className="px-4 py-3 font-extrabold text-slate-900">{r.itemName}</td>
                          <td className="px-4 py-3 text-slate-600">{r.warehouseName}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-bold text-slate-700">{originDocLabel(t, r.originDocType)}</span>
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
                        {r.warehouseName} · {originDocLabel(t, r.originDocType)}{" "}
                        <span dir="ltr">{r.originDocId}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-500">
                        <span>{t("inventoryRest.negativePolicy.col.deficit")}: <span className="font-bold tabular-nums text-rose-700">{formatQty(r.deficitQty)}</span></span>
                        <span>{t("inventoryRest.negativePolicy.col.remaining")}: <span className="font-bold tabular-nums text-slate-800">{formatQty(r.remainingQty)}</span></span>
                        <span>{t("inventoryRest.negativePolicy.col.value")}: <span className="font-bold tabular-nums text-slate-800">{formatCurrency(r.remainingValue)}</span></span>
                      </div>
                      {r.reason && <div className="mt-2 text-xs font-medium text-slate-500">{t("inventoryRest.negativePolicy.col.reason")}: {r.reason}</div>}
                      <div className="mt-2 text-[11px] font-medium text-slate-400">
                        {formatDateTime(r.createdAt)} · {r.createdBy}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
                  <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                    <span>
                      {t("inventoryRest.ui.showingRange", { from: formatNumber(from), to: formatNumber(to), total: formatNumber(filtered.length) })}
                    </span>
                    <select
                      className="field min-h-11 py-1 text-xs"
                      value={pageSize}
                      onChange={(e) => patch({ pageSize: e.target.value })}
                      aria-label={t("inventoryRest.negativePolicy.deficits.pageSizeAria")}
                    >
                      {PAGE_SIZES.map((s) => (
                        <option key={s} value={s}>{t("inventoryRest.ui.perPage", { count: s })}</option>
                      ))}
                    </select>
                    {isFetching && <span className="text-teal-600">{t("inventoryRest.ui.updatingShort")}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.prev")} disabled={safePage <= 1} onClick={() => patch({ page: safePage - 1 }, false)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <span className="text-xs font-bold text-slate-600">
                      {t("inventoryRest.ui.pageOf", { page: formatNumber(safePage), total: formatNumber(totalPages) })}
                    </span>
                    <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.next")} disabled={safePage >= totalPages} onClick={() => patch({ page: safePage + 1 }, false)}>
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
