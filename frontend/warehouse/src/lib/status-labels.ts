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

// Movement `type` ('in'/'out') → Arabic, for the rare case a movement row has
// no Arabic reason text to show.
export function movementTypeLabel(type: string | null | undefined): string {
  const t = String(type ?? "").toLowerCase().trim();
  if (t === "in") return "وارد";
  if (t === "out") return "صادر";
  return type || "—";
}
