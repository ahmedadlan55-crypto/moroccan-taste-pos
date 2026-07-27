/**
 * Preset discounts (خصومات جاهزة) — close/w25-sell-ui.
 *
 * Legacy loaded GET /api/settings/discounts-v2-full once per boot
 * (public/pos/app.js:4996 → state.discountsV3) and offered the rows as one-tap
 * cards inside the line/invoice discount modals (app.js:5343-5500). This module
 * mirrors that read through a PLAIN fetch with the POS Bearer token — lib/api.ts
 * belongs to a parallel stream and is not touched. Rows are cached for the
 * session; any failure degrades to [] so manual discount entry keeps working
 * exactly as today (an old server without the endpoint behaves the same).
 *
 * ── W2-B: the dropped campaign fields ───────────────────────────────────────
 * routes/settings.js:371 has ALWAYS shipped `requireCode`, `code`,
 * `requireApproval`, `minRole`, `validFrom`, `validTo`, `maxPerInvoice` and
 * `applyOn`, and this mapper threw every one of them away. An owner who
 * configured a promo code, a weekend-only campaign, or an approval-gated staff
 * discount got a card that behaved like an unconditional one-tap discount —
 * the configuration silently did nothing at the register.
 *
 * They are now carried through and ENFORCED here (the pure rules) + at the two
 * call sites (the prompts/gates):
 *   validFrom / validTo  → `presetsForScope` never OFFERS an out-of-window row.
 *   requireCode + code   → `presetCodeMatches`; the card asks for the code first.
 *   requireApproval      → `presetNeedsApproval`; blocked without manager
 *   minRole                authority (see the note on that function).
 *   maxAmount            → caps BOTH the line amount and the invoice amount.
 *                          It used to cap only the line one — an invoice-scope
 *                          preset ignored its own ceiling completely.
 *   maxPerInvoice        → a second, invoice-wide ceiling on the same amount.
 */
import { useEffect, useState } from "react";
import { getToken } from "./auth";
import { round2 } from "./cartMath";
import type { DiscountType } from "./types";

/** A raw row from /api/settings/discounts-v2-full (legacy discountsV3 shape). */
interface DiscountPresetRow {
  id: number | string;
  name?: string;
  type?: string; // 'percentage' | 'fixed'
  value?: number | string;
  enabled?: boolean;
  showInPos?: boolean;
  discountScope?: string; // 'line' | 'invoice' | 'preset' | 'manual'
  minOrder?: number | string | null;
  maxAmount?: number | string | null;
  // ── fields this mapper used to discard ──
  maxPerInvoice?: number | string | null;
  requireCode?: boolean;
  code?: string | null;
  requireApproval?: boolean;
  minRole?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  applyOn?: string | null;
}

export interface DiscountPreset {
  id: number | string;
  name: string;
  /** Mapped to the React form's type: 'percentage' → PERCENT, else FIXED. */
  type: DiscountType;
  value: number;
  scope: string;
  minOrder: number | null;
  maxAmount: number | null;
  /** Invoice-wide ceiling on the ر.س this preset may take off ONE invoice. */
  maxPerInvoice: number | null;
  /** The cashier must type `code` before the preset can be applied. */
  requireCode: boolean;
  code: string | null;
  /** Needs manager authority regardless of role. */
  requireApproval: boolean;
  /** Lowest role allowed to apply it ('cashier' when the owner set nothing). */
  minRole: string;
  /** Inclusive YYYY-MM-DD campaign window; null = open-ended on that side. */
  validFrom: string | null;
  validTo: string | null;
  /** 'invoice' | 'item' | 'category' (server.js:2451 ENUM). Carried, not acted on. */
  applyOn: string;
}

const ENDPOINT = "/api/settings/discounts-v2-full";

let cache: Promise<DiscountPreset[]> | null = null;

/** A DATE column arrives as '2026-07-25' or a full ISO timestamp; keep the day. */
function toYmd(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local YYYY-MM-DD — the window is a calendar window, not an instant. */
export function localYmd(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Is `p` inside its campaign window today? Both bounds are INCLUSIVE. */
export function isPresetInWindow(p: DiscountPreset, now: Date = new Date()): boolean {
  const today = localYmd(now);
  if (p.validFrom && today < p.validFrom) return false;
  if (p.validTo && today > p.validTo) return false;
  return true;
}

async function fetchRows(): Promise<DiscountPreset[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(ENDPOINT, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as DiscountPresetRow[];
  if (!Array.isArray(rows)) return [];
  // Same visibility filter legacy applied at both modals (app.js:5346, 5440).
  return rows
    .filter((d) => d && d.enabled && d.showInPos !== false && (Number(d.value) || 0) > 0 && String(d.name ?? "").trim())
    .map((d) => ({
      id: d.id,
      name: String(d.name).trim(),
      type: (String(d.type).toLowerCase() === "percentage" ? "PERCENT" : "FIXED") as DiscountType,
      value: Number(d.value) || 0,
      scope: String(d.discountScope ?? ""),
      minOrder: d.minOrder != null && Number(d.minOrder) > 0 ? Number(d.minOrder) : null,
      maxAmount: d.maxAmount != null && Number(d.maxAmount) > 0 ? Number(d.maxAmount) : null,
      // 0 is the route's "unset" for both DECIMAL ceilings (Number(x||0)).
      maxPerInvoice: d.maxPerInvoice != null && Number(d.maxPerInvoice) > 0 ? Number(d.maxPerInvoice) : null,
      requireCode: d.requireCode === true,
      code: String(d.code ?? "").trim() || null,
      requireApproval: d.requireApproval === true,
      minRole: String(d.minRole ?? "cashier").trim().toLowerCase() || "cashier",
      validFrom: toYmd(d.validFrom),
      validTo: toYmd(d.validTo),
      applyOn: String(d.applyOn ?? "invoice").trim().toLowerCase() || "invoice",
    }));
}

/** Session-cached load; a failure resolves [] and clears the cache for retry. */
export function loadDiscountPresets(): Promise<DiscountPreset[]> {
  if (!cache) {
    cache = fetchRows().catch(() => {
      cache = null; // retry on the next open — outages should not stick
      return [];
    });
  }
  return cache;
}

/** Test hook — resets the session cache. */
export function _resetDiscountPresetsCache(): void {
  cache = null;
}

/** Legacy scope filter (app.js:5346/5440): the target scope + the shared
 *  'preset'/'manual' scopes appear in BOTH modals.
 *
 *  W2-B — a preset whose campaign window has not opened (or has closed) is not
 *  OFFERED at all. Showing it disabled would leak next week's promotion onto
 *  today's till; the owner's intent is that it does not exist yet. */
export function presetsForScope(
  all: DiscountPreset[],
  scope: "line" | "invoice",
  now: Date = new Date(),
): DiscountPreset[] {
  return all.filter(
    (p) => (p.scope === scope || p.scope === "preset" || p.scope === "manual") && isPresetInWindow(p, now),
  );
}

/** Case/whitespace-insensitive promo-code check. A preset that requires a code
 *  but carries none is UNUSABLE (misconfiguration fails closed, never open). */
export function presetCodeMatches(p: DiscountPreset, entered: string): boolean {
  if (!p.requireCode) return true;
  if (!p.code) return false;
  return String(entered ?? "").trim().toLowerCase() === p.code.trim().toLowerCase();
}

/** Role ladder for `minRole`. Anything unrecognised ranks with the cashier, so
 *  a typo in the settings screen never silently ELEVATES a preset. */
const ROLE_RANK: Record<string, number> = { cashier: 0, supervisor: 1, manager: 2, admin: 3 };
function rank(role: string): number {
  return ROLE_RANK[String(role ?? "").trim().toLowerCase()] ?? 0;
}

/**
 * Does applying `p` need manager authority?
 *
 * Two owner switches collapse into one question: `requireApproval` (explicit)
 * and `minRole` above the actor's role (implicit). Either one means a plain
 * cashier may not apply it alone.
 *
 * HOW IT IS ENFORCED — and why no password is collected here:
 * routes/sales.js `_verifyApproverCredentials` is the codebase's manager gate,
 * but it is reachable only through POST /api/sales/:orderId/{void,return}: it
 * reads `req.body.approverUsername/approverPassword` inside those two handlers.
 * There is NO endpoint that verifies an approver for a DISCOUNT — the checkout
 * write (POST /api/sales) does not read approver credentials at all, and does
 * not even re-check `maxCashierDiscountPct`. Popping the credential dialog and
 * then verifying nothing would be security theatre AND would put a manager's
 * password into a form for no benefit. So the gate here is the authority the
 * app can actually establish: the same `supervisor || pos.discount.override`
 * check CartPanel/DiscountDialog already use for the ceiling — mirroring
 * `_requireManagerApproval`, where a privileged actor short-circuits the second
 * factor. A cashier without it sees the card disabled with the reason stated.
 * (The missing server-side approver endpoint is reported to the merge owner.)
 */
export function presetNeedsApproval(p: DiscountPreset, actorRole: string): boolean {
  return p.requireApproval || rank(p.minRole) > rank(actorRole);
}

/** The effective ر.س ceiling for ONE application: the tighter of the two
 *  owner-configured caps. `null` when neither is set. */
export function presetCap(p: DiscountPreset): number | null {
  const caps = [p.maxAmount, p.maxPerInvoice].filter((c): c is number => c != null);
  return caps.length ? Math.min(...caps) : null;
}

/** The ر.س amount a preset yields on a line gross (legacy posApplyLineDiscount
 *  app.js:5405-5420: percentage of the gross, capped by maxAmount then the
 *  line total — the same clamp cartMath applies to manual entry).
 *
 *  `usedOnInvoice` is the ر.س this SAME preset has already taken off other
 *  lines of the current cart, so `maxPerInvoice` caps the invoice-wide total
 *  and not merely each line in isolation. */
export function presetLineAmount(p: DiscountPreset, lineGross: number, usedOnInvoice = 0): number {
  let amt = p.type === "PERCENT" ? (lineGross * p.value) / 100 : p.value;
  if (p.maxAmount != null && amt > p.maxAmount) amt = p.maxAmount;
  if (p.maxPerInvoice != null) {
    const remaining = Math.max(0, p.maxPerInvoice - (Number(usedOnInvoice) || 0));
    if (amt > remaining) amt = remaining;
  }
  if (amt > lineGross) amt = lineGross;
  return round2(Math.max(0, amt));
}

/**
 * What an invoice-scope preset should FILL into the discount form.
 *
 * THE ASYMMETRY THIS FIXES: `presetLineAmount` has always honoured `maxAmount`,
 * while the invoice dialog copied `{type, value}` straight into the form — so a
 * "20% off, max 50 ر.س" preset took 20% of a 900 ر.س basket (180 ر.س) with the
 * owner's own ceiling ignored. When the computed amount would break a ceiling
 * the fill switches to a FIXED amount pinned AT the ceiling, which is the only
 * representation the discount form can hold (it stores one type + one value).
 */
export interface PresetInvoiceFill {
  type: DiscountType;
  value: number;
  /** True when a ceiling rewrote the fill — the UI says so. */
  capped: boolean;
}
export function presetInvoiceFill(p: DiscountPreset, subtotal: number): PresetInvoiceFill {
  const base = Math.max(0, Number(subtotal) || 0);
  const raw = p.type === "PERCENT" ? (base * p.value) / 100 : p.value;
  const cap = presetCap(p);
  if (cap != null && raw > cap) return { type: "FIXED", value: round2(cap), capped: true };
  return { type: p.type, value: p.value, capped: false };
}

/** React hook: presets once `enabled` (dialog open / row expanded); [] until
 *  loaded and on any failure. */
export function useDiscountPresets(enabled: boolean): DiscountPreset[] {
  const [presets, setPresets] = useState<DiscountPreset[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadDiscountPresets().then((p) => {
      if (alive) setPresets(p);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return presets;
}
