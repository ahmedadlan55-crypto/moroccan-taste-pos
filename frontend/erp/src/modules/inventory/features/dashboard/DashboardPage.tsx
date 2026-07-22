import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  CircleDollarSign,
  Gauge,
  Hourglass,
  PackageMinus,
  PackageX,
  RefreshCw,
  Truck,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader, PanelTitle } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { formatCurrency, formatNumber, formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useWarehouseDashboard } from "@/modules/inventory/lib/hooks/useDashboard";
import { warehouseHealth, alertCount } from "@/modules/inventory/lib/status-labels";

// Read-only command center wired to GET /api/inventory/dashboard-summary.
// Honors the warehouse scope (?wh) — "all" shows the company aggregate, a
// warehouse id narrows to it. Changing scope aborts the previous request.
export function DashboardPage() {
  const t = useT();
  const navigate = useNavigate();
  const { scope } = useWarehouseScope();
  const { data, isLoading, isError, error, refetch, isFetching } = useWarehouseDashboard(scope);

  const subtitle =
    scope === ALL_WAREHOUSES
      ? t("inventoryRest.dashboard.subtitleAll")
      : t("inventoryRest.dashboard.subtitleScoped");

  const header = (
    <PageHeader
      eyebrow={t("inventoryRest.dashboard.eyebrow")}
      title={t("inventoryRest.dashboard.title")}
      subtitle={subtitle}
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> {t("inventoryRest.ui.refresh")}
        </Button>
      }
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }
  if (isError || !data) {
    return (
      <>
        {header}
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }

  const k = data.kpis;
  const warehouses = data.warehouses;

  return (
    <>
      {header}

      {/* Background-refresh hint (data already shown). */}
      {isFetching && (
        <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400" aria-live="polite">
          <Spinner className="h-3.5 w-3.5" /> {t("inventoryRest.ui.updating")}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("inventoryRest.dashboard.kpi.inventoryValue")} value={formatCurrency(k.inventoryValue)} note={t("inventoryRest.dashboard.kpi.inventoryValueNote")} icon={CircleDollarSign} />
        <MetricCard label={t("inventoryRest.dashboard.kpi.itemCount")} value={formatNumber(k.itemCount)} note={t("inventoryRest.dashboard.kpi.itemCountNote")} icon={Boxes} tone="blue" onClick={() => navigate("/inventory/balances")} />
        <MetricCard label={t("inventoryRest.dashboard.kpi.low")} value={formatNumber(k.lowCount)} note={t("inventoryRest.dashboard.kpi.lowNote")} icon={PackageMinus} tone="amber" onClick={() => navigate("/inventory/balances?status=low")} />
        <MetricCard label={t("inventoryRest.dashboard.kpi.out")} value={formatNumber(k.outCount)} note={t("inventoryRest.dashboard.kpi.outNote")} icon={PackageX} tone="rose" onClick={() => navigate("/inventory/balances?status=out")} />
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("inventoryRest.dashboard.kpi.transfersPending")} value={formatNumber(data.transfers.pending)} note={t("inventoryRest.dashboard.kpi.transfersPendingNote")} icon={Truck} tone="amber" onClick={() => navigate("/inventory/transfers")} />
        <MetricCard label={t("inventoryRest.dashboard.kpi.transfersInTransit")} value={formatNumber(data.transfers.inTransit)} note={t("inventoryRest.dashboard.kpi.transfersInTransitNote")} icon={Truck} tone="blue" onClick={() => navigate("/inventory/transfers")} />
        <MetricCard label={t("inventoryRest.dashboard.kpi.activeWarehouses")} value={formatNumber(k.activeWarehouses)} note={t("inventoryRest.dashboard.kpi.activeWarehousesNote", { count: formatNumber(warehouses.length) })} icon={WarehouseIcon} onClick={() => navigate("/inventory/warehouses")} />
        <MetricCard
          label={t("inventoryRest.dashboard.kpi.expirySoon")}
          value={data.expiry.available ? formatNumber(data.expiry.count) : t("inventoryRest.dashboard.kpi.expiryUnavailable")}
          note={data.expiry.available ? t("inventoryRest.dashboard.kpi.expirySoonNote", { value: formatCurrency(data.expiry.atRiskValue), days: data.expiry.days }) : t("inventoryRest.dashboard.kpi.expiryNoData")}
          icon={Hourglass}
          tone="violet"
          onClick={data.expiry.available ? () => navigate("/inventory") : undefined}
        />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <article className="surface overflow-hidden">
          <PanelTitle
            icon={Gauge}
            title={t("inventoryRest.dashboard.healthTitle")}
            subtitle={t("inventoryRest.dashboard.healthSubtitle")}
            action={<Button variant="ghost" onClick={() => navigate("/inventory/warehouses")}>{t("inventoryRest.dashboard.viewAll")}</Button>}
          />
          {warehouses.length === 0 ? (
            <div className="p-10 text-center text-sm font-bold text-slate-400">{t("inventoryRest.dashboard.healthEmpty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-right">
                <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                  <tr>
                    <th className="px-5 py-3">{t("inventoryRest.dashboard.col.warehouse")}</th>
                    <th className="px-4 py-3">{t("inventoryRest.dashboard.col.value")}</th>
                    <th className="px-4 py-3">{t("inventoryRest.dashboard.col.qty")}</th>
                    <th className="px-4 py-3">{t("inventoryRest.dashboard.col.alerts")}</th>
                    <th className="px-5 py-3">{t("inventoryRest.dashboard.col.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map((w) => {
                    const alerts = alertCount(w);
                    return (
                      <tr key={w.id} className="table-row cursor-pointer" onClick={() => navigate("/inventory/warehouses")}>
                        <td className="px-5 py-4">
                          <div className="font-extrabold text-slate-800">{w.name}</div>
                          <div className="mt-1 text-xs font-bold text-slate-400">{w.code}</div>
                        </td>
                        <td className="px-4 py-4 text-sm font-extrabold text-slate-700 tabular-nums">{formatCurrency(w.totalValue)}</td>
                        <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.totalQty)}</td>
                        <td className="px-4 py-4">
                          <span className={`font-extrabold ${alerts > 0 ? "text-rose-600" : "text-slate-400"}`}>{formatNumber(alerts)}</span>
                        </td>
                        <td className="px-5 py-4"><StatusBadge>{warehouseHealth(w)}</StatusBadge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="surface overflow-hidden">
          <PanelTitle icon={Activity} title={t("inventoryRest.dashboard.recentTitle")} subtitle={t("inventoryRest.dashboard.recentSubtitle")} />
          <div className="p-5">
            {data.recentMovements.length === 0 ? (
              <div className="py-8 text-center text-sm font-bold text-slate-400">{t("inventoryRest.dashboard.recentEmpty")}</div>
            ) : (
              data.recentMovements.map((m, index) => {
                const positive = m.type === "in";
                return (
                  <div key={m.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {index < data.recentMovements.length - 1 && <span className="absolute right-[17px] top-9 h-[calc(100%-26px)] w-px bg-slate-200" />}
                    <span className={`z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border-4 border-white ${positive ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}>
                      {positive ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-3">
                        <span className="truncate text-sm font-extrabold text-slate-800">{m.itemName || m.reason || m.itemId}</span>
                        <span className="shrink-0 text-xs font-bold text-slate-400">{formatDateTime(m.date)}</span>
                      </div>
                      <div className="mt-1 flex justify-between gap-3 text-xs">
                        <span className="truncate font-bold text-slate-400">{m.reason}{m.warehouseName ? ` · ${m.warehouseName}` : ""}</span>
                        <span className={`shrink-0 font-extrabold tabular-nums ${positive ? "text-emerald-600" : "text-sky-600"}`}>
                          {positive ? "+" : "−"}{formatNumber(m.qty)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </article>
      </section>

      {data.kpis.negativeCount > 0 && (
        <div className="surface mt-4 flex items-center gap-3 border-rose-200 bg-rose-50/60 p-4 text-sm font-bold text-rose-700">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          {t("inventoryRest.dashboard.negativeBanner", { count: formatNumber(data.kpis.negativeCount) })}
        </div>
      )}
    </>
  );
}
