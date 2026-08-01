import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Printer, Download, AlertTriangle, ClipboardList, Wallet, Info } from "lucide-react";
import { PageHeader,
  PrintDocument,
} from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useT } from "@/i18n";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { getToken } from "@/shared/api";
import { formatCurrency, formatNumber, formatQty } from "@/shared/lib";
import { reorderStatusToLabel, stockoutRiskToLabel } from "@/modules/inventory/lib/status-labels";
import { useReplenishment, useReplenishmentSummary } from "@/modules/inventory/lib/hooks/useReplenishment";

const PAGE_SIZES = [25, 50, 100];

async function exportCsv(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const token = getToken();
  const res = await fetch(`/api/inventory/v2/replenishment/export${qs ? `?${qs}` : ""}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new Error("export_failed");
  const blob = await res.blob(); const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
}

export function ReplenishmentPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const q = params.get("q") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const status = params.get("status") ?? "";
  const risk = params.get("risk") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const [showHow, setShowHow] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);

  const statusOptions = [
    { value: "", label: t("inventoryRest.replenishment.statusFilter.all") },
    { value: "critical", label: t("inventoryRest.replenishment.statusFilter.critical") },
    { value: "reorder", label: t("inventoryRest.replenishment.statusFilter.reorder") },
    { value: "watch", label: t("inventoryRest.replenishment.statusFilter.watch") },
    { value: "ok", label: t("inventoryRest.replenishment.statusFilter.ok") },
  ];
  const riskOptions = [
    { value: "", label: t("inventoryRest.replenishment.riskFilter.all") },
    { value: "high", label: t("inventoryRest.replenishment.riskFilter.high") },
    { value: "medium", label: t("inventoryRest.replenishment.riskFilter.medium") },
    { value: "low", label: t("inventoryRest.replenishment.riskFilter.low") },
  ];

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }
  const { data, isLoading, isError, error, refetch, isFetching } = useReplenishment({ q, warehouseId, status, risk, page, pageSize });
  const summary = useReplenishmentSummary({ warehouseId });
  const whOptions = useMemo(() => allWarehousesAccess ? (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name })) : accessibleWarehouses.map((w) => ({ id: w.id, name: w.name })), [allWarehousesAccess, accessibleWarehouses, allWh.data]);
  const pg = data?.pagination; const totalPages = pg?.totalPages ?? 1; const s = summary.data;

  return (
    // Every report printed inside the system wears the same head and hides
    // the app chrome. Before this, the page printed the sidebar and the
    // buttons with it, and the sheet did not say what report it was.
    <PrintDocument title={t("inventoryRest.replenishment.title")}>
      <PageHeader eyebrow={t("inventoryRest.replenishment.eyebrow")} title={t("inventoryRest.replenishment.title")} subtitle={t("inventoryRest.replenishment.subtitle")}
        action={<div className="no-print flex gap-2">
          <Button variant="secondary" onClick={() => setShowHow((v) => !v)}><Info className="h-4 w-4" /> {t("inventoryRest.replenishment.howBtn")}</Button>
          <Button variant="secondary" onClick={() => exportCsv({ ...(warehouseId ? { warehouseId } : {}), ...(risk ? { risk } : {}), ...(q ? { q } : {}) }).catch(() => setExpErr(t("inventoryRest.replenishment.exportFailed")))}><Download className="h-4 w-4" /> {t("inventoryRest.ui.csv")}</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> {t("inventoryRest.ui.print")}</Button>
        </div>} />

      {showHow && (
        <div className="no-print mb-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
          <div className="mb-1 font-extrabold">{t("inventoryRest.replenishment.howTitle", { days: formatNumber(s?.lookbackDays ?? 30) })}</div>
          <ul className="list-disc space-y-1 pr-5 text-xs font-medium">
            <li>{t("inventoryRest.replenishment.how1")}</li>
            <li>{t("inventoryRest.replenishment.how2")}</li>
            <li>{t("inventoryRest.replenishment.how3")}</li>
            <li>{t("inventoryRest.replenishment.how4")}</li>
          </ul>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label={t("inventoryRest.replenishment.kpi.reorderItems")} value={formatNumber(s?.reorderItems ?? 0)} note={t("inventoryRest.replenishment.kpi.reorderItemsNote")} icon={AlertTriangle} tone="rose" />
        <MetricCard label={t("inventoryRest.replenishment.kpi.recommendedValue")} value={formatCurrency(s?.recommendedValue ?? 0)} note={t("inventoryRest.replenishment.kpi.recommendedValueNote")} icon={Wallet} tone="amber" />
        <MetricCard label={t("inventoryRest.replenishment.kpi.total")} value={formatNumber(s?.total ?? 0)} note={t("inventoryRest.replenishment.kpi.totalNote", { days: formatNumber(s?.lookbackDays ?? 30) })} icon={ClipboardList} tone="blue" />
      </section>

      <section className="no-print surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1"><Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder={t("inventoryRest.replenishment.searchPlaceholder")} defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label={t("common.search")} /></label>
          <select className="field lg:w-48" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label={t("inventoryRest.replenishment.warehouseAria")}><option value="">{t("inventoryRest.filter.allWarehouses")}</option>{whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <select className="field lg:w-40" value={status} onChange={(e) => patch({ status: e.target.value })} aria-label={t("inventoryRest.replenishment.statusAria")}>{statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <select className="field lg:w-36" value={risk} onChange={(e) => patch({ risk: e.target.value })} aria-label={t("inventoryRest.replenishment.riskAria")}>{riskOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </div>
        {expErr && <p className="text-xs font-bold text-rose-600">{expErr}</p>}
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
          <EmptyState title={t("inventoryRest.replenishment.emptyTitle")} body={t("inventoryRest.replenishment.emptyBody")} />
        ) : (
          <>
            <div className="surface hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-3 py-3 text-right">{t("inventoryRest.replenishment.col.item")}</th><th className="px-3 py-3 text-right">{t("inventoryRest.replenishment.col.warehouse")}</th><th className="px-3 py-3">{t("inventoryRest.replenishment.col.onHand")}</th><th className="px-3 py-3">{t("inventoryRest.replenishment.col.reorderPoint")}</th>
                  <th className="px-3 py-3">{t("inventoryRest.replenishment.col.recommended")}</th><th className="px-3 py-3">{t("inventoryRest.replenishment.col.coverage")}</th><th className="px-3 py-3">{t("inventoryRest.replenishment.col.risk")}</th><th className="px-3 py-3">{t("inventoryRest.replenishment.col.status")}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.itemId + r.warehouseId} className={r.recommendedQty > 0 ? "bg-rose-50/40" : ""}>
                      <td className="px-3 py-2 font-bold text-slate-800">{r.name}<span className="mr-2 font-mono text-[10px] text-slate-400" dir="ltr">{r.sku}</span></td>
                      <td className="px-3 py-2 text-slate-600">{r.warehouseName}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{formatQty(r.onHand)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-slate-500">{formatQty(r.reorderPoint)}</td>
                      <td className="px-3 py-2 text-center font-extrabold tabular-nums text-teal-700">{r.recommendedQty > 0 ? formatQty(r.recommendedQty) : "—"}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.daysOfCover === null ? "—" : formatNumber(r.daysOfCover)}</td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{stockoutRiskToLabel(r.stockoutRisk)}</StatusBadge></td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{reorderStatusToLabel(r.reorderStatus)}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <div key={r.itemId + r.warehouseId} className="surface p-4">
                  <div className="flex items-center justify-between"><span className="font-extrabold text-slate-900">{r.name}</span><StatusBadge>{reorderStatusToLabel(r.reorderStatus)}</StatusBadge></div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-600">
                    <span>{t("inventoryRest.replenishment.onHandLabel")}: {formatQty(r.onHand)}</span><span>{t("inventoryRest.replenishment.reorderPointLabel")}: {formatQty(r.reorderPoint)}</span>
                    <span className="font-bold text-teal-700">{t("inventoryRest.replenishment.recommendedLabel")}: {r.recommendedQty > 0 ? formatQty(r.recommendedQty) : "—"}</span><span>{t("inventoryRest.replenishment.coverageLabel")}: {r.daysOfCover === null ? "—" : formatNumber(r.daysOfCover)} {t("inventoryRest.replenishment.daysUnit")}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="no-print mt-4 flex items-center justify-between gap-3 text-xs font-medium text-slate-500">
              <span>{t("inventoryRest.replenishment.itemsTotal", { count: formatNumber(pg?.total ?? 0) })} {isFetching && <span className="text-teal-600">· {t("inventoryRest.ui.updatingShort")}</span>}</span>
              <div className="flex items-center gap-2">
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label={t("table.rowsPerPage")}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{t("inventoryRest.ui.perPage", { count: n })}</option>)}</select>
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.prev")} disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}>‹</Button>
                <span className="font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.next")} disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}>›</Button>
              </div>
            </div>
          </>
        )}
      </section>
    </PrintDocument>
  );
}
