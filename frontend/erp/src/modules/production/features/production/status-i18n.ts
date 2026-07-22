import type { TFunction } from "@/i18n";

// Production lifecycle status CODE → i18n key. Reuses the shared status.* labels
// where the code exists there (draft / approved / in_progress→inProgress /
// closed / cancelled / reversed); the codes MISSING from status.* — completed
// and the two legacy statuses — fall back to the module namespace. Mirrors the
// plain-text output of productionStatusToLabel() (inventory/lib/status-labels)
// but resolves in the active UI language. The StatusBadge path is NOT routed
// through here: it localizes itself from the Arabic label via its reverse index.
const STATUS_KEY: Record<string, string> = {
  draft: "status.draft",
  approved: "status.approved",
  in_progress: "status.inProgress",
  completed: "production.status.completed",
  closed: "status.closed",
  cancelled: "status.cancelled",
  reversed: "status.reversed",
  planned: "production.status.planned",
  released: "production.status.released",
};

/** Localized production-status label; unknown/empty → "—" (matches the legacy
 *  productionStatusToLabel fallback). */
export function productionStatusLabel(t: TFunction, code: string | null | undefined): string {
  const key = STATUS_KEY[String(code ?? "").trim()];
  return key ? t(key) : "—";
}
