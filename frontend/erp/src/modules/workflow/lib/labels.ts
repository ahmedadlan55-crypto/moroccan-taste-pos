// Semantic tones for the workflow domain + label lookups keyed by the STABLE
// backend code. Tones map onto the shared <StatusBadge>/<Badge> semantic tones
// (no colors defined here → zero hex). The visible label text lives in the i18n
// "workflow.*" namespace; each helper takes the active-language `t` and resolves
// t("workflow.status."+code) / t("workflow.importance."+code) / t("workflow.action."+code).

import type { StatusTone } from "@/shared/ui";
import type { TFunction } from "@/i18n";

interface Meta {
  label: string;
  tone: StatusTone;
}

// Transaction lifecycle statuses (transactions.status) → tone. The label is
// resolved through t("workflow.status."+code).
const STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  created: "info",
  pending: "warning",
  in_progress: "info",
  replied: "info",
  approved: "success",
  rejected: "danger",
  returned: "warning",
  closed: "neutral",
  cancelled: "neutral",
};

export function statusMeta(status: string | null | undefined, t: TFunction): Meta {
  const key = String(status || "").toLowerCase();
  const tone = STATUS_TONE[key] ?? "neutral";
  const label = STATUS_TONE[key] ? t(`workflow.status.${key}`) : status ? String(status) : "—";
  return { label, tone };
}

// Importance / priority (transactions.importance) → tone.
const IMPORTANCE_TONE: Record<string, StatusTone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

export function importanceMeta(importance: string | null | undefined, t: TFunction): Meta {
  const key = String(importance || "").toLowerCase();
  const tone = IMPORTANCE_TONE[key] ?? "neutral";
  const label = IMPORTANCE_TONE[key] ? t(`workflow.importance.${key}`) : importance ? String(importance) : "—";
  return { label, tone };
}

// Action-log verbs (transaction_steps_log.action_type — ENUM per routes/workflow.js).
// The raw verb and its past-tense twin collapse onto one dictionary key.
const ACTION_CODE: Record<string, string> = {
  create: "create",
  created: "create",
  approve: "approve",
  approved: "approve",
  reject: "reject",
  rejected: "reject",
  return: "return",
  returned: "return",
  forward: "forward",
  forwarded: "forward",
  close: "close",
  closed: "close",
  reply: "reply",
  replied: "reply",
};

export function actionTypeLabel(actionType: string | null | undefined, t: TFunction): string {
  const key = String(actionType || "").toLowerCase();
  const code = ACTION_CODE[key];
  if (code) return t(`workflow.action.${code}`);
  return actionType ? String(actionType) : t("workflow.action.fallback");
}
