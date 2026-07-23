import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CalendarClock, ShieldAlert, CheckCircle2, Printer, Download } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { formatNumber, formatQty } from "@/shared/lib";
import { expiryClassToLabel } from "@/modules/inventory/lib/status-labels";
import { useExpiry, useExpirySummary } from "@/modules/inventory/lib/hooks/useExpiry";
import type { ExpiryRow } from "@/modules/inventory/lib/adapters/expiry.adapter";

function downloadCsv(rows: ExpiryRow[], t: TFunction) {
  const head = [
    t("inventoryRest.expiry.csvHead.item"),
    t("inventoryRest.expiry.csvHead.lot"),
    t("inventoryRest.expiry.csvHead.warehouse"),
    t("inventoryRest.expiry.csvHead.expiryDate"),
    t("inventoryRest.expiry.csvHead.daysLeft"),
    t("inventoryRest.expiry.csvHead.class"),
    t("inventoryRest.expiry.csvHead.qty"),
  ];
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n=+@]/.test(s) ? '"' + (/^[=+@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"' : s; };
  const body = rows.map((r) => [r.itemName, r.lotNumber, r.warehouseName, r.expiryDate ?? "", r.daysToExpiry ?? "", expiryClassToLabel(r.expiryClass), r.qty].map(esc).join(","));
  const csv = "﻿" + [head.join(","), ...body].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }); const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `expiry-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
}

export function ExpiryPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const warehouseId = params.get("wh") ?? "";
  const level = params.get("level") ?? "";
  const levelOptions = [
    { value: "", label: t("inventoryRest.filter.allLevels") },
    { value: "expired", label: t("status.expired") },
    { value: "critical", label: t("status.critical") },
    { value: "warning", label: t("status.warning") },
    { value: "safe", label: t("status.safe") },
  ];
  function patch(next: Record<string, string | null>) { const p = new URLSearchParams(params); for (const [k, v] of Object.entries(next)) { if (!v) p.delete(k); else p.set(k, v); } setParams(p, { replace: true }); }
  const list = useExpiry({ warehouseId, level, pageSize: 100 });
  const summary = useExpirySummary({ warehouseId });
  const whOptions = useMemo(() => allWarehousesAccess ? (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name })) : accessibleWarehouses.map((w) => ({ id: w.id, name: w.name })), [allWarehousesAccess, accessibleWarehouses, allWh.data]);
  const s = summary.data; const rows = list.data?.rows ?? [];

  return (
    <div>
      <PageHeader eyebrow={t("inventoryRest.expiry.eyebrow")} title={t("inventoryRest.expiry.title")} subtitle={t("inventoryRest.expiry.subtitle")}
        action={<div className="no-print flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(rows, t)}><Download className="h-4 w-4" /> {t("inventoryRest.ui.csv")}</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> {t("inventoryRest.ui.print")}</Button>
        </div>} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t("inventoryRest.expiry.kpi.expired")} value={formatNumber(s?.byClass.expired ?? 0)} note={t("inventoryRest.expiry.kpi.expiredNote")} icon={AlertTriangle} tone="rose" />
        <MetricCard label={t("inventoryRest.expiry.kpi.critical")} value={formatNumber(s?.byClass.critical ?? 0)} note={t("inventoryRest.expiry.kpi.criticalNote")} icon={ShieldAlert} tone="amber" />
        <MetricCard label={t("inventoryRest.expiry.kpi.warning")} value={formatNumber(s?.byClass.warning ?? 0)} note={t("inventoryRest.expiry.kpi.warningNote")} icon={CalendarClock} tone="amber" />
        <MetricCard label={t("inventoryRest.expiry.kpi.safe")} value={formatNumber(s?.byClass.safe ?? 0)} note={t("inventoryRest.expiry.kpi.safeNote")} icon={CheckCircle2} tone="teal" />
      </section>

      <section className="no-print surface mt-4 flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <select className="field lg:w-56" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label={t("inventoryRest.expiry.warehouseAria")}><option value="">{t("inventoryRest.filter.allWarehouses")}</option>{whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <select className="field lg:w-44" value={level} onChange={(e) => patch({ level: e.target.value })} aria-label={t("inventoryRest.expiry.levelAria")}>{levelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </section>

      <section className="mt-4">
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState title={t("inventoryRest.expiry.emptyTitle")} body={t("inventoryRest.expiry.emptyBody")} />
        ) : (
          <>
            <div className="surface hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-3 py-3 text-right">{t("inventoryRest.expiry.col.item")}</th><th className="px-3 py-3 text-right">{t("inventoryRest.expiry.col.lot")}</th><th className="px-3 py-3 text-right">{t("inventoryRest.expiry.col.warehouse")}</th>
                  <th className="px-3 py-3">{t("inventoryRest.expiry.col.expiryDate")}</th><th className="px-3 py-3">{t("inventoryRest.expiry.col.daysLeft")}</th><th className="px-3 py-3">{t("inventoryRest.expiry.col.qty")}</th><th className="px-3 py-3">{t("inventoryRest.expiry.col.class")}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.lotId + r.warehouseId} className={r.expiryClass === "expired" ? "bg-rose-50/50" : ""}>
                      <td className="px-3 py-2 font-bold text-slate-800">{r.itemName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600" dir="ltr">{r.lotNumber}</td>
                      <td className="px-3 py-2 text-slate-600">{r.warehouseName}</td>
                      <td className="px-3 py-2 text-center text-xs" dir="ltr">{r.expiryDate || "—"}</td>
                      <td className="px-3 py-2 text-center tabular-nums font-bold">{r.daysToExpiry == null ? "—" : formatNumber(r.daysToExpiry)}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{formatQty(r.qty)}</td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{expiryClassToLabel(r.expiryClass)}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 md:hidden">
              {rows.map((r) => (
                <div key={r.lotId + r.warehouseId} className="surface p-4">
                  <div className="flex items-center justify-between"><span className="font-extrabold text-slate-900">{r.itemName}</span><StatusBadge>{expiryClassToLabel(r.expiryClass)}</StatusBadge></div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-600"><span className="font-mono" dir="ltr">{r.lotNumber}</span><span>{r.warehouseName}</span><span>{t("inventoryRest.expiry.expiryLabel")}: {r.expiryDate || "—"}</span><span>{t("inventoryRest.expiry.remainingLabel")}: {r.daysToExpiry == null ? "—" : formatNumber(r.daysToExpiry)} {t("inventoryRest.expiry.daysUnit")}</span></div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
