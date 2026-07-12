// Phase W2 — effective-policy tester: pick a warehouse (and optionally an
// item) → GET /effective → show the computed decision + the three-level chain
// with the winning level highlighted. Resolution is backend-authoritative
// (lib/negativeStockPolicy.resolvePolicy): the most-SPECIFIC enabled level
// wins (صنف > مستودع > عام), tracked items are always block, and `allow`
// degrades to `controlled` while the env gate is off.

import { useState } from "react";
import { FlaskConical, Info } from "lucide-react";
import { PanelTitle } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { cn } from "@/shared/lib";
import { formatQty } from "@/shared/lib";
import { useEffectivePolicy } from "@/modules/inventory/lib/hooks/useNegativePolicy";
import type { EffectivePolicy, PolicyMode } from "@/modules/inventory/lib/adapters/negative-policy.adapter";
import { POLICY_LABELS } from "./labels";
import { PolicyBadge } from "./shared";
import { ItemSearchSelect, type ItemOption } from "./ItemSearchSelect";

function winningLevel(d: EffectivePolicy): "item" | "warehouse" | "global" | "none" {
  if (d.reason === "tracked-item") return "none";
  if (d.levels.item) return "item";
  if (d.levels.warehouse) return "warehouse";
  if (d.levels.global) return "global";
  return "none";
}

function LevelBox({ label, policy, winner }: { label: string; policy: PolicyMode | null; winner: boolean }) {
  return (
    <div
      className={cn(
        "flex-1 rounded-xl border p-3 text-center",
        winner ? "border-teal-500 bg-teal-50/60 ring-2 ring-teal-100" : "border-slate-200 bg-slate-50",
      )}
    >
      <div className="text-[10px] font-bold text-slate-400">{label}</div>
      <div className={cn("mt-1 text-sm font-extrabold", policy ? "text-slate-800" : "text-slate-400")}>
        {policy ? POLICY_LABELS[policy] : "غير محدد"}
      </div>
      {winner && <div className="mt-1 text-[10px] font-extrabold text-teal-700">المستوى الحاسم</div>}
    </div>
  );
}

export function EffectiveTester({ warehouseOptions }: { warehouseOptions: Array<{ id: string; name: string }> }) {
  const [warehouseId, setWarehouseId] = useState("");
  const [item, setItem] = useState<ItemOption | null>(null);

  const { data, isFetching, isError, error } = useEffectivePolicy(warehouseId, item?.id ?? "");

  return (
    <section className="surface mt-4 overflow-hidden">
      <PanelTitle
        icon={FlaskConical}
        title="اختبار السياسة الفعلية"
        subtitle="اختر مستودعًا (وصنفًا اختياريًا) لمعاينة القرار الذي سيطبّقه المحرك عند الصرف."
      />
      <div className="grid gap-3 p-5 lg:grid-cols-2">
        <label className="block">
          <span className="text-xs font-bold text-slate-600">المستودع</span>
          <select
            className="field mt-1"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            aria-label="مستودع الاختبار"
          >
            <option value="">اختر المستودع…</option>
            {warehouseOptions.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>
        <div>
          <span className="text-xs font-bold text-slate-600">الصنف (اختياري)</span>
          <div className="mt-1">
            <ItemSearchSelect value={item} onChange={setItem} />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 p-5">
        {!warehouseId ? (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-400">
            <Info className="h-4 w-4 shrink-0" />
            اختر مستودعًا لبدء الاختبار — بدون صنف يُحسم القرار من مستويي المستودع والعام.
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error instanceof Error ? error.message : "تعذّر حساب السياسة الفعلية"}
          </div>
        ) : !data ? (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-400">
            <Spinner className="h-4 w-4" /> جارٍ الحساب…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold text-slate-500">القرار الفعلي:</span>
              <PolicyBadge policy={data.effectivePolicy} />
              <span className="text-xs font-bold text-slate-500">
                الحد الأقصى للعجز:{" "}
                <span className="font-extrabold text-slate-800 tabular-nums">
                  {data.effectiveMaxNegative == null ? "غير محدود" : formatQty(data.effectiveMaxNegative)}
                </span>
              </span>
              {isFetching && <span className="text-xs font-bold text-teal-600">تحديث…</span>}
            </div>

            {data.reason === "tracked-item" && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                صنف متتبَّع ({data.trackingMode === "expiry" ? "صلاحية" : "دفعات"}) — يُمنع السالب دائمًا مهما كانت السياسات المضبوطة.
              </div>
            )}
            {data.reason === "default-block" && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
                لا توجد سياسة مفعّلة على أي مستوى — يسري الافتراضي: منع (block).
              </div>
            )}
            {data.allowGated && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                السياسة المخزّنة «سماح» لكنها مخفّضة إلى «مقيّد» لأن بوابة NEGATIVE_STOCK_ALLOW_ENABLED معطّلة.
              </div>
            )}

            <div>
              <div className="mb-2 text-xs font-bold text-slate-500">
                سلسلة الحسم — الأكثر تحديدًا يفوز (صنف ← مستودع ← عام):
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <LevelBox label="مستوى الصنف" policy={data.levels.item} winner={winningLevel(data) === "item"} />
                <LevelBox label="مستوى المستودع" policy={data.levels.warehouse} winner={winningLevel(data) === "warehouse"} />
                <LevelBox label="المستوى العام" policy={data.levels.global} winner={winningLevel(data) === "global"} />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
