import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Info } from "lucide-react";
import { apiClient } from "@/shared/api";
import { ErrorState, LoadingState, PageHeader, PanelTitle, Tooltip } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { computeRatios, extractInputs, GROUP_LABEL, type Ratio, type RatioGroup } from "../lib/ratios";
import { todayISO } from "../api";

// /accounting/financial-ratios — converted from the legacy-only `erpLoadFinRatios`.
// Pure client-side math over the SAME two endpoints the React balance sheet and
// income statement already use; no new backend. The math lives in lib/ratios.ts
// so it is unit-tested rather than trusted.

function fmt(r: Ratio): string {
  if (r.value === null) return "—";
  return r.suffix === "%" ? `${r.value.toFixed(1)}%` : `${r.value.toFixed(2)}×`;
}

export function FinancialRatiosPage() {
  const [asOf, setAsOf] = useState(todayISO());
  const year = asOf.slice(0, 4);

  const bs = useQuery({
    queryKey: ["acc", "ratios", "bs", asOf],
    queryFn: ({ signal }) => apiClient.get<never>(`/erp/reports/balance-sheet`, { params: { asOf }, signal }),
  });
  const pnl = useQuery({
    queryKey: ["acc", "ratios", "pnl", year, asOf],
    queryFn: ({ signal }) => apiClient.get<never>(`/erp/reports/pnl`, { params: { from: `${year}-01-01`, to: asOf }, signal }),
  });

  const ratios = useMemo(() => computeRatios(extractInputs(bs.data, pnl.data)), [bs.data, pnl.data]);

  const isLoading = bs.isLoading || pnl.isLoading;
  const isError = bs.isError || pnl.isError;
  const unavailable = ratios.filter((r) => r.value === null && r.unavailableReason);

  const groups: RatioGroup[] = ["liquidity", "profit", "solvency", "efficiency"];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="المحاسبة"
        title="النسب والمؤشرات المالية"
        subtitle="محسوبة من الميزانية وقائمة الدخل حتى التاريخ المحدد."
      />

      <section className="surface">
        <PanelTitle icon={Gauge} title="الفترة" subtitle="قائمة الدخل من بداية السنة حتى التاريخ المحدد." />
        <div className="grid gap-4 p-5 sm:max-w-xs">
          <Field label="حتى تاريخ">
            {({ id }) => (
              <input id={id} type="date" className="field" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            )}
          </Field>
        </div>
      </section>

      {isError ? (
        <ErrorState error={bs.error ?? pnl.error} onRetry={() => { bs.refetch(); pnl.refetch(); }} />
      ) : isLoading ? (
        <LoadingState />
      ) : (
        <>
          {unavailable.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-bold">{unavailable.length} مؤشرًا غير متاح لعدم توفّر مدخلاته.</div>
                <div className="mt-1 font-medium">
                  تُعرض بعلامة «—» بدل تقدير تقريبي. أضف الحسابات الناقصة في دليل الحسابات لتظهر.
                </div>
              </div>
            </div>
          )}

          {groups.map((g) => {
            const rows = ratios.filter((r) => r.group === g);
            if (rows.length === 0) return null;
            return (
              <section key={g} className="surface">
                <PanelTitle icon={Gauge} title={GROUP_LABEL[g]} />
                <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
                  {rows.map((r) => (
                    <div key={r.key} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-bold text-slate-600">{r.name}</span>
                        <Tooltip content={r.explanation}>
                          <Info className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        </Tooltip>
                      </div>
                      <div className={`mt-2 text-2xl font-extrabold ${r.value === null ? "text-slate-300" : "text-slate-900"}`}>
                        {fmt(r)}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">{r.formula}</div>
                      {r.value === null && r.unavailableReason ? (
                        <div className="mt-2 text-[11px] font-bold text-amber-700">{r.unavailableReason}</div>
                      ) : (
                        <div className="mt-2 text-[11px] text-slate-500">{r.bench}</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

export default FinancialRatiosPage;
