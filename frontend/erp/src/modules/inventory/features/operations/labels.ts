/**
 * Pure label + grouping helpers for the inventory operations centre.
 *
 * WHY the tab groups live here and not in the backend: the server has no
 * grouping concept — it publishes ELEVEN document types and their counts. The
 * grouping is a UI affordance, so it is declared once, in one place, and is
 * ALWAYS intersected with `/meta` before it reaches the wire: a type the
 * deployment does not have (or the caller may not see) is dropped from its tab,
 * and a type the server adds later that no rule claims falls into the catch-all
 * tab rather than becoming invisible.
 *
 * NAMING CONTRACT: `receipt` («وارد مخزني» / "Stock inbound") and
 * `purchase_receipt` («استلام مشتريات» / "Purchase receipt") are DIFFERENT
 * documents and get DIFFERENT tabs and different type labels in both languages.
 */
import type { TFunction } from "@/i18n";
import type { OperationsMetaType } from "@/modules/inventory/lib/hooks/useOperations";

export const ALL_TAB = "all";
/** Unclaimed document types land here so a new server type is never hidden. */
const CATCH_ALL_TAB = "issues";

interface TabRule {
  id: string;
  types: string[];
}

const TAB_RULES: TabRule[] = [
  // Stock IN with no supplier and no purchase order.
  { id: "inbound", types: ["receipt"] },
  // The procurement family: goods received against a supplier/PO, its return,
  // and the legacy purchases table that predates both.
  { id: "purchases", types: ["purchase_receipt", "purchase_legacy", "purchase_return"] },
  { id: "transfers", types: ["transfer"] },
  { id: "production", types: ["production", "production_legacy"] },
  // Stock OUT + corrections (the catch-all).
  { id: CATCH_ALL_TAB, types: ["issue", "adjustment", "adjustment_legacy", "stocktake"] },
];

export interface OperationsTab {
  id: string;
  /** i18n key for the tab label. */
  labelKey: string;
  /** Document types this tab requests; empty ⇒ every visible type ("all"). */
  types: string[];
}

/**
 * Build the tab strip from `/meta`. Only VISIBLE types (available on this
 * deployment AND permitted for the caller) participate, so a tab whose whole
 * family is missing simply does not render — the user never clicks a tab that
 * can only ever be empty.
 */
export function buildTabs(metaTypes: OperationsMetaType[]): OperationsTab[] {
  const visible = metaTypes.filter((t) => t.visible).map((t) => t.documentType);
  const claimed = new Set(TAB_RULES.flatMap((r) => r.types));

  const tabs: OperationsTab[] = [{ id: ALL_TAB, labelKey: "operations.hub.tab.all", types: [] }];
  for (const rule of TAB_RULES) {
    const types = rule.types.filter((t) => visible.includes(t));
    if (rule.id === CATCH_ALL_TAB) {
      // Anything the rules do not name still has to be reachable.
      types.push(...visible.filter((t) => !claimed.has(t)));
    }
    if (types.length) tabs.push({ id: rule.id, labelKey: `operations.hub.tab.${rule.id}`, types });
  }
  return tabs;
}

/** Sum the server's per-documentType counts for a tab. `all` sums everything. */
export function tabCount(tab: OperationsTab, counts: Record<string, number>): number {
  const keys = tab.types.length ? tab.types : Object.keys(counts);
  return keys.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
}

/** t() returns the dotted path itself on a miss — that is the fallback signal. */
function translated(t: TFunction, key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

/**
 * Document-type label. Falls back to the server's own label (`documentTypeLabel`
 * on a row, `label` in meta) for a type the dictionary does not know yet, so a
 * new backend document family reads as a name and never as `operations.type.x`.
 */
export function typeLabel(t: TFunction, documentType: string, serverLabel?: string | null): string {
  return translated(t, `operations.type.${documentType}`, serverLabel || documentType);
}

/**
 * Canonical status label. The server sends raw English-ish codes
 * (`pending_approval`, `partially_completed`, …); they MUST go through the
 * dictionary or English mode shows Arabic-only badges (and vice versa).
 */
export function statusLabel(t: TFunction, canonicalStatus: string): string {
  return translated(t, `operations.status.${canonicalStatus}`, canonicalStatus);
}

/** source.kind / destination.kind → a human word (warehouse, supplier, …). */
export function sideKindLabel(t: TFunction, kind: string): string {
  return translated(t, `operations.side.${kind}`, kind);
}

/** Timeline verb (create / approve / post / request-recount / …). */
export function timelineActionLabel(t: TFunction, action: string | null): string {
  if (!action) return "—";
  return translated(t, `operations.detail.timeline.action.${action}`, action);
}

// ── attachments ─────────────────────────────────────────────────────────────

export interface OperationAttachment {
  id: string;
  name: string;
  /** null ⇒ render as plain text; we never link to a scheme we did not vet. */
  url: string | null;
}

/** Header columns that may carry attachments across the eleven source tables. */
const ATTACHMENT_KEYS = [
  "attachments",
  "attachments_json",
  "attachment_json",
  "attachment_urls",
  "files",
  "files_json",
  "documents_json",
];

/** http(s) or a same-origin absolute path only — never `javascript:`/`data:`. */
function safeUrl(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * Pull attachments out of the verbatim header when the payload happens to carry
 * them. Nothing in the read model GUARANTEES an attachments column, so this is
 * tolerant by design: a missing/malformed blob yields an empty list, never a
 * crash and never a fabricated entry.
 */
export function extractAttachments(header: Record<string, unknown>): OperationAttachment[] {
  const out: OperationAttachment[] = [];
  for (const key of ATTACHMENT_KEYS) {
    if (!(key in header)) continue;
    let raw: unknown = header[key];
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) continue;
      if (text.startsWith("[") || text.startsWith("{")) {
        try {
          raw = JSON.parse(text);
        } catch {
          continue; // known-malformed legacy blob → no attachments, not a crash
        }
      } else {
        raw = [text];
      }
    }
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
    list.forEach((entry, i) => {
      if (typeof entry === "string") {
        const url = safeUrl(entry);
        out.push({ id: `${key}:${i}`, name: entry.split("/").pop() || entry, url });
        return;
      }
      if (!entry || typeof entry !== "object") return;
      const r = entry as Record<string, unknown>;
      const url = safeUrl(r.url ?? r.href ?? r.path ?? r.link);
      const name = String(r.name ?? r.filename ?? r.file_name ?? r.title ?? url ?? `#${i + 1}`);
      out.push({ id: `${key}:${i}`, name, url });
    });
  }
  return out;
}
