// Phase W2 — code lists + tone maps for the negative-stock policy feature.
// Display strings live in the i18n dictionary (inventoryRest.negativePolicy.*)
// and are resolved at the render site via t(); this file keeps only the stable
// CODE lists, the color/tone maps (CSS, never translated), and thin t()-helpers.

import type { TFunction } from "@/i18n";
import type { DeficitStatus, PolicyMode, PolicyScope } from "@/modules/inventory/lib/adapters/negative-policy.adapter";

// PolicyMode code → label / explainer-card hint (resolved at render).
export const policyLabel = (t: TFunction, policy: PolicyMode): string =>
  t(`inventoryRest.negativePolicy.policy.${policy}`);
export const policyHint = (t: TFunction, policy: PolicyMode): string =>
  t(`inventoryRest.negativePolicy.policyHint.${policy}`);

// Policy badge tone (never color-only — the dot + label carry meaning; this is
// purely the chip's border/bg/text classes). CSS, not translated.
export const POLICY_BADGE_CLASS: Record<PolicyMode, string> = {
  block: "border-rose-200 bg-rose-50 text-rose-700",
  controlled: "border-amber-200 bg-amber-50 text-amber-700",
  allow: "border-violet-200 bg-violet-50 text-violet-700",
};

// PolicyScope code → label (used in the dialog eyebrow).
export const scopeLabel = (t: TFunction, scope: PolicyScope): string =>
  t(`inventoryRest.negativePolicy.scope.${scope}`);

// DeficitStatus code → label (resolved at render).
export const deficitStatusLabel = (t: TFunction, status: DeficitStatus): string =>
  t(`inventoryRest.negativePolicy.deficitStatus.${status}`);

export const DEFICIT_STATUS_BADGE: Record<DeficitStatus, string> = {
  open: "border-rose-200 bg-rose-50 text-rose-700",
  partial: "border-amber-200 bg-amber-50 text-amber-700",
  covered: "border-emerald-200 bg-emerald-50 text-emerald-700",
  adjusted: "border-slate-200 bg-slate-100 text-slate-600",
};

// Deficit-ledger filter chips: stable codes ("" = all). The label is resolved
// at render (common.all for "", else deficitStatusLabel).
export const DEFICIT_STATUS_FILTER_CODES = ["", "open", "partial", "covered", "adjusted"] as const;

// Origin-document type codes that carry a dedicated label; any other code is
// shown verbatim (never a blank cell).
const ORIGIN_DOC_CODES = new Set([
  "issue", "transfer", "adjustment", "stocktake", "production",
  "production_order", "waste", "receipt", "pos",
]);
export function originDocLabel(t: TFunction, docType: string): string {
  if (ORIGIN_DOC_CODES.has(docType)) return t(`inventoryRest.negativePolicy.originDoc.${docType}`);
  return docType || "—";
}
