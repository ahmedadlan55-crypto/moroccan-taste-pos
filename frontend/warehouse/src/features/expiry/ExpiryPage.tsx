import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CalendarClock, ShieldAlert, CheckCircle2, Printer, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState, ErrorState } from "@/components/states/States";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { formatNumber, formatQty } from "@/lib/formatters";
import { expiryClassToLabel, EXPIRY_CLASS_OPTIONS } from "@/lib/status-labels";
import { useExpiry, useExpirySummary } from "@/lib/hooks/useExpiry";
import type { ExpiryRow } from "@/lib/adapters/expiry.adapter";

function downloadCsv(rows: ExpiryRow[]) {
  const head = ["الصنف", "الدفعة", "المستودع", "تاريخ الصلاحية", "أيام متبقية", "التصنيف", "الرصيد"];
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n=+@]/.test(s) ? '"' + (/^[=+@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"' : s; };
  const body = rows.map((r) => [r.itemName, r.lotNumber, r.warehouseName, r.expiryDate ?? "", r.daysToExpiry ?? "", expiryClassToLabel(r.expiryClass), r.qty].map(esc).join(","));
  const csv = "﻿" + [head.join(","), ...body].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }); const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `expiry-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
}

export function ExpiryPage() {
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const warehouseId = params.get("wh") ?? "";
  const level = params.get("level") ?? "";
  function patch(next: Record<string, string | null>) { const p = new URLSearchParams(params); for (const [k, v] of Object.entries(next)) { if (!v) p.delete(k); else p.set(k, v); } setParams(p, { replace: true }); }
  const list = useExpiry({ warehouseId, level, pageSize: 100 });
  const summary = useExpirySummary({ warehouseId });
  const whOptions = useMemo(() => allWarehousesAccess ? (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name })) : accessibleWarehouses.map((w) => ({ id: w.id, name: w.name })), [allWarehousesAccess, accessibleWarehouses, allWh.data]);
  const s = summary.data; const rows = list.data?.rows ?? [];

  return (
    <div>
      <PageHeader eyebrow="ذكاء المخزون" title="تحذيرات الصلاحية" subtitle="الدفعات حسب قرب انتهاء الصلاحية (احتساب باليوم بتوقيت الرياض). المنتهي لا يُصرف."
        action={<div className="no-print flex gap-2">
          <Button variant="secondary" onClick={() => downloadCsv(rows)}><Download className="h-4 w-4" /> CSV</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> طباعة</Button>
        </div>} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="منتهية" value={formatNumber(s?.byClass.expired ?? 0)} note="لا تُصرف" icon={AlertTriangle} tone="rose" />
        <MetricCard label="حرجة" value={formatNumber(s?.byClass.critical ?? 0)} note="≤ الحد الحرج" icon={ShieldAlert} tone="amber" />
        <MetricCard label="تحذير" value={formatNumber(s?.byClass.warning ?? 0)} note="≤ حد التحذير" icon={CalendarClock} tone="amber" />
        <MetricCard label="آمنة" value={formatNumber(s?.byClass.safe ?? 0)} note="بعيدة الانتهاء" icon={CheckCircle2} tone="teal" />
      </section>

      <section className="no-print surface mt-4 flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <select className="field lg:w-56" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label="المستودع"><option value="">كل المستودعات</option>{whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <select className="field lg:w-44" value={level} onChange={(e) => patch({ level: e.target.value })} aria-label="المستوى">{EXPIRY_CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </section>

      <section className="mt-4">
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="لا توجد دفعات بصلاحية" body="لا توجد دفعات ذات تاريخ صلاحية ضمن النطاق." />
        ) : (
          <>
            <div className="surface hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-3 py-3 text-right">الصنف</th><th className="px-3 py-3 text-right">الدفعة</th><th className="px-3 py-3 text-right">المستودع</th>
                  <th className="px-3 py-3">تاريخ الصلاحية</th><th className="px-3 py-3">أيام متبقية</th><th className="px-3 py-3">الرصيد</th><th className="px-3 py-3">التصنيف</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.lotId + r.warehouseId} className={r.expiryClass === "expired" ? "bg-rose-50/50" : ""}>
                      <td className="px-3 py-2 font-bold text-slate-800">{r.itemName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.lotNumber}</td>
                      <td className="px-3 py-2 text-slate-600">{r.warehouseName}</td>
                      <td className="px-3 py-2 text-center text-xs">{r.expiryDate || "—"}</td>
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
                  <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-600"><span className="font-mono">{r.lotNumber}</span><span>{r.warehouseName}</span><span>صلاحية: {r.expiryDate || "—"}</span><span>متبقٍ: {r.daysToExpiry == null ? "—" : formatNumber(r.daysToExpiry)} يوم</span></div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
