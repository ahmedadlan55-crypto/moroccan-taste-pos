// Shift computation helpers + a react-query hook for the operational Shifts
// screen (+ its detail drawer). The arithmetic mirrors the legacy
// renderShiftsTable / _v3RenderShiftClose exactly (actual = cash + card + kita;
// diff = actual − theo). The retired Cashier-reports screen's client-side
// summarizeShifts aggregate was deleted with it — shift ANALYTICS now live in
// /reports/sales/shifts with server-computed totals.
import { useQuery } from "@tanstack/react-query";
import { posAdminApi } from "./api";
import type { Shift, ShiftFilters } from "./types";

export function shiftActual(s: Shift): number {
  return (Number(s.actualCash) || 0) + (Number(s.actualCard) || 0) + (Number(s.actualKita) || 0);
}

export function shiftTheoretical(s: Shift): number {
  if (s.totalTheoretical != null) return Number(s.totalTheoretical) || 0;
  return (
    (Number(s.theoreticalCash) || 0) +
    (Number(s.theoreticalCard) || 0) +
    (Number(s.theoreticalKita) || 0)
  );
}

export function shiftDiff(s: Shift): number {
  // Prefer the per-method diffs the backend already computed; fall back to
  // actual − theoretical when they are absent.
  const hasMethodDiffs = s.diffCash != null || s.diffCard != null || s.diffKita != null;
  if (hasMethodDiffs) {
    return (Number(s.diffCash) || 0) + (Number(s.diffCard) || 0) + (Number(s.diffKita) || 0);
  }
  return shiftActual(s) - shiftTheoretical(s);
}

export function isShiftOpen(s: Shift): boolean {
  return (s.status || "").toUpperCase() === "OPEN" || !s.endTime;
}

/** Distinct cashier usernames present in the loaded rows (for the filter). */
export function cashierOptions(rows: Shift[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of rows) {
    if (s.username && !seen.has(s.username)) seen.set(s.username, s.displayName || s.username);
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

export const posAdminKeys = {
  paymentMethods: ["pos-admin", "payment-methods"] as const,
  shifts: (filters: ShiftFilters) => ["pos-admin", "shifts", filters] as const,
  shiftClosing: (id: string | number) => ["pos-admin", "shift-closing", String(id)] as const,
};

/** Server-filtered shifts list. Returns a normalized array (never undefined). */
export function useShifts(filters: ShiftFilters) {
  const query = useQuery({
    queryKey: posAdminKeys.shifts(filters),
    queryFn: ({ signal }) => posAdminApi.shifts(filters, signal),
    staleTime: 15_000,
  });
  const rows: Shift[] = Array.isArray(query.data) ? query.data : [];
  return { query, rows };
}
