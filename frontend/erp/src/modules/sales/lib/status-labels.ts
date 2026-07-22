// Status tone + localized label for every O2C document status. Ported from the
// standalone O2C app, then rewired for i18n: the tone stays here (mapped onto the
// shared <StatusBadge> semantic tones in ./format.tsx), while the visible label is
// resolved at render time via t("sales.status.<code>") so it follows the active
// UI language. Unknown codes fall back to the raw status string (data), never a
// dotted key.
import type { TFunction } from "@/i18n";

export type Tone = "slate" | "teal" | "amber" | "blue" | "green" | "rose" | "violet";

// status CODE → tone. Keys are the STABLE backend enum values (unchanged from the
// legacy MAP); the Arabic/English labels for these codes live under sales.status.*
// in the i18n dictionaries.
const TONE: Record<string, Tone> = {
  // shared
  draft: "slate",
  cancelled: "rose",
  reversed: "rose",
  // ar_document
  issued: "blue",
  partially_paid: "amber",
  paid: "green",
  credited: "violet",
  closed: "slate",
  // sales_order
  confirmed: "blue",
  fulfilled: "teal",
  invoiced: "green",
  // payment / return
  approved: "blue",
  posted: "green",
  // zatca
  pending: "amber",
  submitted: "blue",
  accepted: "green",
  rejected: "rose",
  not_required: "slate",
};

const KNOWN = new Set(Object.keys(TONE));

/** Semantic tone for a status code (defaults to neutral "slate"). */
export function statusTone(status: string | null | undefined): Tone {
  return TONE[String(status || "").toLowerCase()] || "slate";
}

/** Localized status label via t("sales.status.<code>"). A code we don't know is
 *  echoed back as-is (it's backend data), and null/empty renders "—". */
export function statusLabel(status: string | null | undefined, t: TFunction): string {
  const key = String(status || "").toLowerCase();
  if (KNOWN.has(key)) return t(`sales.status.${key}`);
  return status ? String(status) : "—";
}
