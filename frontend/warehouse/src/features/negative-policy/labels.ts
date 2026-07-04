// Phase W2 — Arabic labels + tone maps for the negative-stock policy feature.
// Kept local to the feature (status-labels.ts is owned by the coordinator).

import type { DeficitStatus, PolicyMode, PolicyScope } from "@/lib/adapters/negative-policy.adapter";

export const POLICY_LABELS: Record<PolicyMode, string> = {
  block: "منع (block)",
  controlled: "مقيّد (controlled)",
  allow: "سماح (allow)",
};

export const POLICY_HINTS: Record<PolicyMode, string> = {
  block: "يرفض أي صرف يجعل رصيد الصنف سالبًا — الوضع الافتراضي والأكثر أمانًا، ولا يحتاج أي إعداد.",
  controlled: "يسمح بعجز محدود وبشروط: دور مدير/أدمن، سبب إلزامي، إقرار صريح بالسالب، وحد أقصى للعجز لا يُتجاوز.",
  allow: "باب مفتوح للمطوّر فقط وخلف بوابة بيئة (NEGATIVE_STOCK_ALLOW_ENABLED) — عند إيقاف البوابة يتخفّض تلقائيًا إلى «مقيّد».",
};

export const POLICY_BADGE_CLASS: Record<PolicyMode, string> = {
  block: "border-rose-200 bg-rose-50 text-rose-700",
  controlled: "border-amber-200 bg-amber-50 text-amber-700",
  allow: "border-violet-200 bg-violet-50 text-violet-700",
};

export const SCOPE_LABELS: Record<PolicyScope, string> = {
  global: "عام",
  warehouse: "مستودع",
  item: "صنف",
};

export const DEFICIT_STATUS_LABELS: Record<DeficitStatus, string> = {
  open: "مفتوح",
  partial: "مغطّى جزئيًا",
  covered: "مغطّى",
  adjusted: "مسوّى",
};

export const DEFICIT_STATUS_BADGE: Record<DeficitStatus, string> = {
  open: "border-rose-200 bg-rose-50 text-rose-700",
  partial: "border-amber-200 bg-amber-50 text-amber-700",
  covered: "border-emerald-200 bg-emerald-50 text-emerald-700",
  adjusted: "border-slate-200 bg-slate-100 text-slate-600",
};

export const DEFICIT_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "الكل" },
  { value: "open", label: "مفتوح" },
  { value: "partial", label: "مغطّى جزئيًا" },
  { value: "covered", label: "مغطّى" },
  { value: "adjusted", label: "مسوّى" },
];

const ORIGIN_DOC_LABELS: Record<string, string> = {
  issue: "أمر صرف",
  transfer: "تحويل",
  adjustment: "تسوية مخزنية",
  stocktake: "جرد",
  production: "أمر إنتاج",
  production_order: "أمر إنتاج",
  waste: "هدر",
  receipt: "استلام",
  pos: "مبيعات",
};

export function originDocLabel(docType: string): string {
  return ORIGIN_DOC_LABELS[docType] ?? (docType || "—");
}
