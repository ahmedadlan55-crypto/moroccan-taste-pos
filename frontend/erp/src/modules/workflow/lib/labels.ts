// Arabic labels + semantic tones for the workflow domain. Tones map onto the
// shared <StatusBadge>/<Badge> semantic tones (no colors defined here → zero hex).

import type { StatusTone } from "@/shared/ui";

interface Meta {
  label: string;
  tone: StatusTone;
}

// Transaction lifecycle statuses (transactions.status).
const STATUS: Record<string, Meta> = {
  draft: { label: "مسودة", tone: "neutral" },
  created: { label: "منشأة", tone: "info" },
  pending: { label: "قيد الانتظار", tone: "warning" },
  in_progress: { label: "قيد التنفيذ", tone: "info" },
  replied: { label: "تم الرد", tone: "info" },
  approved: { label: "معتمدة", tone: "success" },
  rejected: { label: "مرفوضة", tone: "danger" },
  returned: { label: "مُعادة للتعديل", tone: "warning" },
  closed: { label: "مغلقة", tone: "neutral" },
  cancelled: { label: "ملغاة", tone: "neutral" },
};

export function statusMeta(status: string | null | undefined): Meta {
  const key = String(status || "").toLowerCase();
  return STATUS[key] || { label: status ? String(status) : "—", tone: "neutral" };
}

// Importance / priority (transactions.importance).
const IMPORTANCE: Record<string, Meta> = {
  critical: { label: "حرجة", tone: "danger" },
  high: { label: "عالية", tone: "warning" },
  medium: { label: "متوسطة", tone: "info" },
  low: { label: "منخفضة", tone: "neutral" },
};

export function importanceMeta(importance: string | null | undefined): Meta {
  const key = String(importance || "").toLowerCase();
  return IMPORTANCE[key] || { label: importance ? String(importance) : "—", tone: "neutral" };
}

// Action-log verbs (transaction_steps_log.action_type — ENUM per routes/workflow.js).
const ACTION: Record<string, string> = {
  create: "إنشاء",
  created: "إنشاء",
  approve: "اعتماد",
  approved: "اعتماد",
  reject: "رفض",
  rejected: "رفض",
  return: "إرجاع للتعديل",
  returned: "إرجاع للتعديل",
  forward: "إحالة",
  forwarded: "إحالة",
  close: "إغلاق",
  closed: "إغلاق",
  reply: "رد",
  replied: "رد",
};

export function actionTypeLabel(actionType: string | null | undefined): string {
  const key = String(actionType || "").toLowerCase();
  return ACTION[key] || (actionType ? String(actionType) : "إجراء");
}
