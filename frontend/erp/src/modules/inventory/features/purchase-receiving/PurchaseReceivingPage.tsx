import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search, PackageCheck, Truck, ClipboardList } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { Progress } from "@/shared/ui";
import { useT } from "@/i18n";
import { formatCurrency, formatNumber, formatDate, formatQty } from "@/shared/lib";
import { useOpenPurchases } from "@/modules/inventory/lib/hooks/usePurchaseReceiving";
import { PageCounter } from "@/shared/tables";

const PAGE_SIZES = [10, 25, 50];

// The purchase-receiving work queue: legacy purchases still receivable through
// the V2 receipts flow (requested / previously received / remaining per line).
export function PurchaseReceivingPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useOpenPurchases({ q, status, page, pageSize });

  const rows = data?.rows ?? [];
  const pg = data?.pagination;
  const totalPages = pg?.totalPages ?? 1;
  const notStarted = rows.filter((r) => r.v2ReceiveStatus === "none").length;
  const partial = rows.filter((r) => r.v2ReceiveStatus === "partial").length;
  const statusOptions = [
    { value: "", label: t("inventoryRest.purchaseReceiving.statusFilterAll") },
    { value: "none", label: t("inventoryRest.purchaseReceiving.statusFilterNone") },
    { value: "partial", label: t("inventoryRest.purchaseReceiving.statusFilterPartial") },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.purchaseReceiving.eyebrow")}
        title={t("inventoryRest.purchaseReceiving.title")}
        subtitle={t("inventoryRest.purchaseReceiving.subtitle")}
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label={t("inventoryRest.purchaseReceiving.kpi.open")} value={formatNumber(pg?.total ?? 0)} note={t("inventoryRest.purchaseReceiving.kpi.openNote")} icon={Truck} tone="amber" />
        <MetricCard label={t("inventoryRest.purchaseReceiving.kpi.notStarted")} value={formatNumber(notStarted)} note={t("inventoryRest.purchaseReceiving.kpi.notStartedNote")} icon={ClipboardList} tone="blue" />
        <MetricCard label={t("inventoryRest.purchaseReceiving.kpi.partial")} value={formatNumber(partial)} note={t("inventoryRest.purchaseReceiving.kpi.partialNote")} icon={PackageCheck} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full ps-10" placeholder={t("inventoryRest.purchaseReceiving.searchPlaceholder")} defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label={t("common.search")} />
        </label>
        <div className="flex gap-1">
          {statusOptions.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-11 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
          <EmptyState title={t("inventoryRest.purchaseReceiving.emptyTitle")} body={q || status ? t("inventoryRest.ui.fixFilters") : t("inventoryRest.purchaseReceiving.emptyBody")} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.po")}</th>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.supplier")}</th>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.warehouse")}</th>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.date")}</th>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.receiveStatus")}</th>
                    <th className="px-4 py-3 text-start">{t("inventoryRest.purchaseReceiving.col.progress")}</th>
                    <th className="px-4 py-3 text-end">{t("inventoryRest.purchaseReceiving.col.value")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const pct = r.orderedQty > 0 ? (r.receivedQty / r.orderedQty) * 100 : 0;
                    return (
                      <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => navigate(`/purchase-receiving/${r.id}`)}>
                        <td className="px-4 py-3">
                          <span className="font-extrabold text-slate-900">{r.id}</span>
                          {r.poId && <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">PO</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{r.supplierName || "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{r.warehouseName || "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{formatDate(r.purchaseDate)}</td>
                        <td className="px-4 py-3"><StatusBadge>{t(`inventoryRest.purchaseReceiving.receiveStatus.${r.v2ReceiveStatus}`)}</StatusBadge></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-24"><Progress value={pct} tone={pct >= 100 ? "teal" : "amber"} /></div>
                            <span className="text-xs tabular-nums text-slate-500">{formatQty(r.receivedQty)} / {formatQty(r.orderedQty)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-end font-bold tabular-nums text-slate-800">{formatCurrency(r.totalPrice)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => navigate(`/purchase-receiving/${r.id}`)} className="surface block w-full p-4 text-start">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-900">{r.id}</span>
                    <StatusBadge>{t(`inventoryRest.purchaseReceiving.receiveStatus.${r.v2ReceiveStatus}`)}</StatusBadge>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">{r.supplierName || "—"} · {r.warehouseName || "—"}</div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span className="tabular-nums">{formatQty(r.receivedQty)} / {formatQty(r.orderedQty)} · {formatDate(r.purchaseDate)}</span>
                    <span className="font-bold text-slate-800">{formatCurrency(r.totalPrice)}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>{t("inventoryRest.purchaseReceiving.totalLabel", { count: formatNumber(pg?.total ?? 0) })}</span>
                <select className="field min-h-11 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label={t("table.rowsPerPage")}>{PAGE_SIZES.map((s) => <option key={s} value={s}>{t("inventoryRest.ui.perPage", { count: s })}</option>)}</select>
                {isFetching && <span className="text-teal-600">{t("inventoryRest.ui.updatingShort")}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.prev")} disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4" /></Button>
                <PageCounter page={page} pageCount={totalPages} className="text-xs font-bold text-slate-600" />
                <Button variant="ghost" size="icon" aria-label={t("inventoryRest.ui.next")} disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
