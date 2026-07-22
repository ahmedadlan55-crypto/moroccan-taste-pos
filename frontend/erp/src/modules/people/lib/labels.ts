import type { StatusTone } from "@/shared/ui";
import type { TFunction } from "@/i18n";

// Semantic tone for every People / HR status CODE. The tone maps onto the shared
// <StatusBadge> semantic tones (never a raw color). The user-facing LABEL is
// localized via t("people.status.<code>") — see statusMeta below — so no Arabic
// text lives in this file anymore.

interface Meta {
  label: string;
  tone: StatusTone;
}

const STATUS_TONE: Record<string, StatusTone> = {
  // employees
  active: "success",
  suspended: "warning",
  terminated: "danger",
  on_leave: "info",
  // leave requests
  pending: "warning",
  branch_approved: "info",
  hr_approved: "success",
  approved: "success",
  rejected: "danger",
  // advances / custody / attendance
  paid: "success",
  partially_paid: "warning",
  open: "info",
  closed: "neutral",
  posted: "success",
  present: "success",
  absent: "danger",
  late: "warning",
  leave: "info",
  // custody lifecycle
  close_pending: "warning",
  override_pending: "warning",
  returned: "info",
};

/** Localized label + semantic tone for a People / HR status code. Unknown codes
 *  pass through as their raw value (business data), neutral tone. */
export function statusMeta(status: string | null | undefined, t: TFunction): Meta {
  const key = String(status || "").toLowerCase();
  const tone = STATUS_TONE[key];
  if (!tone) return { label: status ? String(status) : "—", tone: "neutral" };
  return { label: t(`people.status.${key}`), tone };
}

/** Localized employment-type label; unknown types pass through as their raw value. */
export function employmentTypeLabel(type: string | null | undefined, t: TFunction): string {
  const key = String(type || "");
  if (!key) return "—";
  const label = t(`people.employmentType.${key}`);
  return label === `people.employmentType.${key}` ? key : label;
}

/** Localized HR-exception-type label; unknown types pass through as their raw value. */
export function exceptionTypeLabel(type: string | null | undefined, t: TFunction): string {
  const key = String(type || "");
  if (!key) return "—";
  const label = t(`people.exceptionType.${key}`);
  return label === `people.exceptionType.${key}` ? key : label;
}

/** Map a CSV / array of weekday indices (0..6) to localized day names. */
export function weekdayLabels(days: number[] | string, t: TFunction): string {
  const arr = Array.isArray(days)
    ? days
    : String(days || "")
        .split(",")
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n));
  const names = arr.filter((n) => n >= 0 && n <= 6).map((n) => t(`people.day.${n}`));
  return names.length ? names.join(t("people.field.listSep")) : "—";
}
