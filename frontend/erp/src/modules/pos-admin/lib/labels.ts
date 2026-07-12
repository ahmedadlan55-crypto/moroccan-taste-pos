// Arabic label maps + option lists for the POS-admin screens. Values match the
// legacy keys (public/js/erp.js _pmGroupLabels / _discScopeLabels …) so the same
// stored records render with identical Arabic wording.
import type { SelectOption } from "@/shared/ui";

export const PM_GROUP_LABELS: Record<string, string> = {
  cash: "كاش",
  electronic: "إلكتروني",
  voucher: "قسيمة",
  loyalty: "ولاء",
  transfer: "تحويل",
  other: "أخرى",
};

/** Semantic Badge tone per payment-method group (no raw hex — tokens only). */
export const PM_GROUP_TONE: Record<string, "success" | "info" | "warning" | "teal" | "neutral"> = {
  cash: "success",
  electronic: "info",
  voucher: "warning",
  loyalty: "teal",
  transfer: "info",
  other: "neutral",
};

export const PM_GROUP_OPTIONS: SelectOption[] = Object.entries(PM_GROUP_LABELS).map(
  ([value, label]) => ({ value, label }),
);

export const PM_FEE_TYPE_LABELS: Record<string, string> = {
  none: "بدون رسوم",
  percent: "نسبة %",
  fixed: "مبلغ ثابت",
};

export const PM_FEE_TYPE_OPTIONS: SelectOption[] = Object.entries(PM_FEE_TYPE_LABELS).map(
  ([value, label]) => ({ value, label }),
);

/** Shift status → Arabic label. */
export function shiftStatusLabel(status: string | undefined, hasEnd: boolean): string {
  const isOpen = (status || "").toUpperCase() === "OPEN" || !hasEnd;
  return isOpen ? "مفتوحة" : "مغلقة";
}
