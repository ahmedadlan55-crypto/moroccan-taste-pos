// Shared step-permission metadata for the approval-step editors (StepsTab and
// PositionPathsTab both edit a step's boolean flags — keep the labels + defaults
// in one place so the two screens never drift). Field names mirror the backend
// (routes/workflow.js: can_approve / can_reject / can_return_to_previous /
// can_edit / can_edit_amount / require_same_branch / require_same_department).

export interface StepFlags {
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
}

/** The 6 action/scoping flags shown as checkboxes, in display order. */
export const FLAG_DEFS: { key: keyof StepFlags; label: string }[] = [
  { key: "canApprove", label: "اعتماد" },
  { key: "canReject", label: "رفض" },
  { key: "canReturn", label: "إرجاع لسابق" },
  { key: "canEdit", label: "تعديل" },
  { key: "canEditAmount", label: "تعديل المبلغ" },
  { key: "requireSameBranch", label: "نفس الفرع" },
  { key: "requireSameDepartment", label: "نفس القسم" },
];

/** Sensible defaults matching the backend's "unset → true" for the action flags. */
export const DEFAULT_FLAGS: StepFlags = {
  canApprove: true,
  canReject: true,
  canReturn: true,
  canEdit: false,
  canEditAmount: false,
  requireSameBranch: true,
  requireSameDepartment: false,
};

export const STRATEGY_OPTIONS = [
  { value: "least_busy", label: "الأقل انشغالًا" },
  { value: "first", label: "الأول" },
];
