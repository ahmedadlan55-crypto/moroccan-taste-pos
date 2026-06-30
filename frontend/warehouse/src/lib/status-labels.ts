import type { WarehouseSummary } from "./adapters/dashboard.adapter";
import type { ItemStatus } from "./adapters/inventory.adapter";

// Total open alerts for a warehouse (low + out + negative).
export function alertCount(w: Pick<WarehouseSummary, "lowCount" | "outCount" | "negativeCount">): number {
  return (Number(w.lowCount) || 0) + (Number(w.outCount) || 0) + (Number(w.negativeCount) || 0);
}

// Derived health label (drives the StatusBadge tone). Inactive wins; then a
// real shortage (negative/out) is "حرج"; a low-stock flag is "مراقبة".
export function warehouseHealth(w: WarehouseSummary): string {
  if (!w.isActive) return "معطّل";
  if (w.negativeCount > 0 || w.outCount > 0) return "حرج";
  if (w.lowCount > 0) return "مراقبة";
  return "جيد";
}

// Canonical inventory status → Arabic label (StatusBadge styles these).
export const itemStatusLabel: Record<ItemStatus, string> = {
  available: "متوفر",
  low: "منخفض",
  out: "نافد",
  negative: "سالب",
};

export const ITEM_STATUS_OPTIONS: { value: ItemStatus | ""; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "available", label: "متوفر" },
  { value: "low", label: "منخفض" },
  { value: "out", label: "نافد" },
  { value: "negative", label: "سالب" },
];

// Backend warehouse `type` → Arabic. Falls back to the raw value (never a
// blank cell) so an unmapped type still reads, just untranslated.
const WAREHOUSE_TYPE: Record<string, string> = {
  main: "رئيسي",
  central: "مركزي",
  branch: "فرعي",
  sub: "فرعي",
  production: "إنتاج",
  transit: "في الطريق",
  virtual: "افتراضي",
  store: "مخزن",
};
export function warehouseTypeLabel(type: string | null | undefined): string {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) return "—";
  return WAREHOUSE_TYPE[t] ?? type ?? "—";
}

// Phase 3A — transfer (stock-issue) lifecycle status → Arabic label. The UI
// renames the backend `issued` to «قيد النقل» (the adapter maps it to
// `in_transit`). Drives the StatusBadge tone via the label text.
export const transferStatusLabel: Record<string, string> = {
  draft: "مسودة",
  submitted: "مُرسل",
  approved: "معتمد",
  in_transit: "قيد النقل",
  partially_received: "استلام جزئي",
  received: "مستلم",
  cancelled: "ملغى",
  reversed: "معكوس",
};
export function transferStatusToLabel(status: string | null | undefined): string {
  return transferStatusLabel[String(status ?? "")] ?? "—";
}

// Filter chips for the transfers list (status values match the adapter's UI
// status enum; the backend filter uses the raw `issued` for `in_transit`).
export const TRANSFER_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "approved", label: "معتمد" },
  { value: "issued", label: "قيد النقل" },
  { value: "partially_received", label: "استلام جزئي" },
  { value: "received", label: "مستلم" },
  { value: "cancelled", label: "ملغى" },
  { value: "reversed", label: "معكوس" },
];

// Phase 3B — independent inventory-transaction lifecycle status → Arabic.
// Unified for receipts / issues / adjustments (draft → approved → posted →
// reversed, + cancelled). Drives the StatusBadge label.
export const invTxStatusLabel: Record<string, string> = {
  draft: "مسودة",
  approved: "معتمد",
  posted: "مُرحّل",
  cancelled: "ملغى",
  reversed: "معكوس",
};
export function invTxStatusToLabel(status: string | null | undefined): string {
  return invTxStatusLabel[String(status ?? "")] ?? "—";
}
export const INVTX_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "approved", label: "معتمد" },
  { value: "posted", label: "مُرحّل" },
  { value: "cancelled", label: "ملغى" },
  { value: "reversed", label: "معكوس" },
];

// Phase 3C — professional stocktake lifecycle status → Arabic. Drives the
// StatusBadge label tone.
export const stocktakeStatusLabel: Record<string, string> = {
  draft: "مسودة",
  counting: "قيد العد",
  submitted: "بانتظار الاعتماد",
  approved: "معتمد",
  posted: "مُرحّل",
  cancelled: "ملغى",
};
export function stocktakeStatusToLabel(status: string | null | undefined): string {
  return stocktakeStatusLabel[String(status ?? "")] ?? "—";
}
export const STOCKTAKE_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "counting", label: "قيد العد" },
  { value: "submitted", label: "بانتظار الاعتماد" },
  { value: "approved", label: "معتمد" },
  { value: "posted", label: "مُرحّل" },
  { value: "cancelled", label: "ملغى" },
];

// Movement `type` ('in'/'out') → Arabic, for the rare case a movement row has
// no Arabic reason text to show.
export function movementTypeLabel(type: string | null | undefined): string {
  const t = String(type ?? "").toLowerCase().trim();
  if (t === "in") return "وارد";
  if (t === "out") return "صادر";
  return type || "—";
}
