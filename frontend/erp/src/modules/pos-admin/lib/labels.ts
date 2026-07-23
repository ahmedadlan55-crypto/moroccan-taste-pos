// Payment-method label helpers + option lists for the POS-admin screens. The
// visible text is resolved through the i18n t() (posAdmin.pmGroup.* /
// posAdmin.feeType.* / posAdmin.shift.*) so it flips AR↔EN with the UI language;
// the group/fee/status CODES stay English (they are the stored contract values).
import type { SelectOption } from "@/shared/ui";
import type { TFunction } from "@/i18n";

/** Group codes in their canonical order (matches the legacy option list). */
export const PM_GROUP_CODES = ["cash", "electronic", "voucher", "loyalty", "transfer", "other"] as const;

/** Fee-type codes in their canonical order. */
export const PM_FEE_TYPE_CODES = ["none", "percent", "fixed"] as const;

/** Semantic Badge tone per payment-method group (no raw hex — tokens only). */
export const PM_GROUP_TONE: Record<string, "success" | "info" | "warning" | "teal" | "neutral"> = {
  cash: "success",
  electronic: "info",
  voucher: "warning",
  loyalty: "teal",
  transfer: "info",
  other: "neutral",
};

/** Localized label for a payment-method group code (defaults to cash). Unknown
 *  codes fall back to the raw code — same as the legacy PM_GROUP_LABELS lookup. */
export function pmGroupLabel(t: TFunction, code: string | undefined): string {
  const c = code || "cash";
  return (PM_GROUP_CODES as readonly string[]).includes(c) ? t(`posAdmin.pmGroup.${c}`) : c;
}

/** Localized <Select> options for the payment-method group. */
export function pmGroupOptions(t: TFunction): SelectOption[] {
  return PM_GROUP_CODES.map((value) => ({ value, label: t(`posAdmin.pmGroup.${value}`) }));
}

/** Localized <Select> options for the service-fee type. */
export function pmFeeTypeOptions(t: TFunction): SelectOption[] {
  return PM_FEE_TYPE_CODES.map((value) => ({ value, label: t(`posAdmin.feeType.${value}`) }));
}

/** Shift status → localized label (feminine — وردية). */
export function shiftStatusLabel(t: TFunction, isOpen: boolean): string {
  return isOpen ? t("posAdmin.shift.open") : t("posAdmin.shift.closed");
}
