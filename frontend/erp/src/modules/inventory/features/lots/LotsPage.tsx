import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Boxes, AlertTriangle, CalendarClock, ShieldAlert, Printer, Download } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { getToken } from "@/shared/api";
import { formatNumber, formatQty } from "@/shared/lib";
import { lotStatusToLabel, expiryClassToLabel, LOT_STATUS_OPTIONS, EXPIRY_CLASS_OPTIONS } from "@/modules/inventory/lib/status-labels";
import { useLotList } from "@/modules/inventory/lib/hooks/useLots";
import { useExpirySummary } from "@/modules/inventory/lib/hooks/useExpiry";
import { useLotIntegrity } from "@/modules/inventory/lib/hooks/useLotIntegrity";
import { LotDetailDrawer } from "./LotDetailDrawer";

const PAGE_SIZES = [25, 50, 100];

async function exportIntegrityCsv(warehouseId: string) {
  const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : "";
  const token = getToken();
  const res = await fetch(`/api/inventory/v2/lot-integrity/export${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new Error("تعذّر التصدير");
  const blob = await res.blob(); const href = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = href; a.download = `lot-integrity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
}

export function LotsPage() {
  const [params, setParams] = useSearchParams();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const q = params.get("q") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const status = params.get("status") ?? "";
  const risk = params.get("risk") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const view = params.get("view");
  const tab = params.get("tab") === "integrity" ? "integrity" : "lots";
  const [expErr, setExpErr] = useState<string | null>(null);

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }
  const list = useLotList({ q, warehouseId, status, risk, page, pageSize });
  const summary = useExpirySummary({ warehouseId });
  const integrity = useLotIntegrity({ warehouseId, driftOnly: false });
  const whOptions = useMemo(() => allWarehousesAccess ? (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name })) : accessibleWarehouses.map((w) => ({ id: w.id, name: w.name })), [allWarehousesAccess, accessibleWarehouses, allWh.data]);
  const pg = list.data?.pagination; const totalPages = pg?.totalPages ?? 1; const s = summary.data; const drift = integrity.data?.summary.drifting ?? 0;

  return (
    <div>
      <PageHeader eyebrow="ذكاء المخزون" title="كتالوج الدفعات" subtitle="الدفعات والصلاحية وتتبّع المصدر والحجر والاستدعاء — مع فحص ثبات أرصدة الدفعات مقابل المخزون."
        action={<div className="no-print flex gap-2">
          {tab === "integrity" && <Button variant="secondary" onClick={() => exportIntegrityCsv(warehouseId).catch(() => setExpErr("تعذّر التصدير"))}><Download className="h-4 w-4" /> CSV</Button>}
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> طباعة</Button>
        </div>} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="إجمالي الدفعات" value={formatNumber(pg?.total ?? 0)} note="ضمن النطاق" icon={Boxes} tone="blue" />
        <MetricCard label="قريبة الانتهاء" value={formatNumber((s?.byClass.critical ?? 0) + (s?.byClass.warning ?? 0))} note="حرجة + تحذير" icon={CalendarClock} tone="amber" />
        <MetricCard label="منتهية الصلاحية" value={formatNumber(s?.byClass.expired ?? 0)} note="لا تُصرف" icon={AlertTriangle} tone="rose" />
        <MetricCard label="انحراف السلامة" value={formatNumber(drift)} note="Σ دفعات ≠ رصيد" icon={ShieldAlert} tone={drift > 0 ? "rose" : "teal"} onClick={() => patch({ tab: "integrity" })} />
      </section>

      <section className="no-print mt-4 flex flex-wrap gap-1">
        {[{ v: "lots", l: "الدفعات" }, { v: "integrity", l: "تكامل الدفعات" }].map((t) => (
          <button key={t.v} type="button" onClick={() => patch({ tab: t.v === "lots" ? null : t.v })}
            className={`min-h-10 rounded-xl border px-4 text-xs font-extrabold transition ${tab === t.v ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{t.l}</button>
        ))}
      </section>

      {tab === "lots" ? (
        <>
          <section className="no-print surface mt-4 flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative flex-1"><Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="field w-full pr-10" placeholder="بحث برقم الدفعة أو الصنف…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" /></label>
              <select className="field lg:w-48" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label="المستودع"><option value="">كل المستودعات</option>{whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              <select className="field lg:w-40" value={status} onChange={(e) => patch({ status: e.target.value })} aria-label="الحالة">{LOT_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              <select className="field lg:w-40" value={risk} onChange={(e) => patch({ risk: e.target.value })} aria-label="مستوى الصلاحية">{EXPIRY_CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </div>
            {expErr && <p className="text-xs font-bold text-rose-600">{expErr}</p>}
          </section>

          <section className="mt-4">
            {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data || list.data.rows.length === 0 ? (
              <EmptyState title="لا توجد دفعات" body="لا توجد دفعات تطابق عوامل التصفية ضمن نطاقك." />
            ) : (
              <>
                <div className="surface hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                      <th className="px-3 py-3 text-right">الدفعة</th><th className="px-3 py-3 text-right">الصنف</th><th className="px-3 py-3">الرصيد</th>
                      <th className="px-3 py-3">الصلاحية</th><th className="px-3 py-3">أيام متبقية</th><th className="px-3 py-3">تصنيف</th><th className="px-3 py-3">الحالة</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {list.data.rows.map((r) => (
                        <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => patch({ view: r.id }, false)}>
                          <td className="px-3 py-2 font-mono text-xs font-bold text-slate-800">{r.lotNumber}{r.isImported && <span className="mr-1 text-[10px] text-amber-600">·مُرحّلة</span>}</td>
                          <td className="px-3 py-2 text-slate-700">{r.itemName}</td>
                          <td className="px-3 py-2 text-center tabular-nums">{formatQty(r.totalQty)}</td>
                          <td className="px-3 py-2 text-center text-xs text-slate-500">{r.expiryDate || "—"}</td>
                          <td className="px-3 py-2 text-center tabular-nums">{r.daysToExpiry == null ? "—" : formatNumber(r.daysToExpiry)}</td>
                          <td className="px-3 py-2 text-center"><StatusBadge>{expiryClassToLabel(r.expiryClass)}</StatusBadge></td>
                          <td className="px-3 py-2 text-center"><StatusBadge>{lotStatusToLabel(r.lifecycleStatus)}</StatusBadge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 md:hidden">
                  {list.data.rows.map((r) => (
                    <button key={r.id} type="button" onClick={() => patch({ view: r.id }, false)} className="surface block w-full p-4 text-right">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono font-extrabold text-slate-900">{r.lotNumber}</span><StatusBadge>{lotStatusToLabel(r.lifecycleStatus)}</StatusBadge></div>
                      <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-600"><span>{r.itemName}</span><span>الرصيد: {formatQty(r.totalQty)}</span><span>صلاحية: {r.expiryDate || "—"}</span><StatusBadge>{expiryClassToLabel(r.expiryClass)}</StatusBadge></div>
                    </button>
                  ))}
                </div>
                <div className="no-print mt-4 flex items-center justify-between gap-3 text-xs font-medium text-slate-500">
                  <span>{formatNumber(pg?.total ?? 0)} دفعة {list.isFetching && <span className="text-teal-600">· تحديث…</span>}</span>
                  <div className="flex items-center gap-2">
                    <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">{PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / صفحة</option>)}</select>
                    <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}>‹</Button>
                    <span className="font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                    <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}>›</Button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      ) : (
        <section className="mt-4">
          {integrity.isLoading ? <LoadingState /> : integrity.isError ? <ErrorState error={integrity.error} onRetry={() => integrity.refetch()} /> : (
            <div className="surface overflow-x-auto">
              <div className="border-b border-slate-100 p-3 text-xs font-bold text-slate-500">القيد: Σ(أرصدة الدفعات) = رصيد المستودع لكل صنف مُتتبع. أي اختلاف يعني انحرافًا يلزم تصحيحه بجرد.</div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-3 py-3 text-right">المستودع</th><th className="px-3 py-3 text-right">الصنف</th><th className="px-3 py-3">رصيد المستودع</th><th className="px-3 py-3">Σ الدفعات</th><th className="px-3 py-3">الفرق</th><th className="px-3 py-3">الحالة</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {(integrity.data?.rows ?? []).map((r, i) => (
                    <tr key={i} className={r.ok ? "" : "bg-rose-50/50"}>
                      <td className="px-3 py-2 text-slate-700">{r.warehouseName}</td><td className="px-3 py-2 font-bold text-slate-800">{r.itemName}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{formatQty(r.stockQty)}</td><td className="px-3 py-2 text-center tabular-nums">{formatQty(r.lotQty)}</td>
                      <td className={`px-3 py-2 text-center tabular-nums font-bold ${r.ok ? "text-slate-400" : "text-rose-700"}`}>{formatQty(r.drift)}</td>
                      <td className="px-3 py-2 text-center"><StatusBadge>{r.ok ? "متطابق" : "انحراف"}</StatusBadge></td>
                    </tr>
                  ))}
                  {(integrity.data?.rows ?? []).length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">لا توجد أصناف مُتتبعة ضمن النطاق.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <LotDetailDrawer id={view} onClose={() => patch({ view: null }, false)} />
    </div>
  );
}
