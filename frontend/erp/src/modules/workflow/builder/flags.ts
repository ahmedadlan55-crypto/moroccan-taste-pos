// Shared step-permission metadata for the approval-step editors (StepsTab and
// PositionPathsTab both edit a step's boolean flags — keep the field set + defaults
// in one place so the two screens never drift). Field names mirror the backend
// (routes/workflow.js: can_approve / can_reject / can_return_to_previous /
// can_edit / can_edit_amount / require_same_branch / require_same_department).
//
// Visible labels are NOT here — each flag key maps 1:1 to the i18n
// "workflow.flag.<key>" leaf, so consumers render t(`workflow.flag.${key}`).

export interface StepFlags {
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
}

/** The 6 action/scoping flags shown as checkboxes, in display order. Each key
 *  resolves its label via t(`workflow.flag.${key}`). */
export const FLAG_DEFS: { key: keyof StepFlags }[] = [
  { key: "canApprove" },
  { key: "canReject" },
  { key: "canReturn" },
  { key: "canEdit" },
  { key: "canEditAmount" },
  { key: "requireSameBranch" },
  { key: "requireSameDepartment" },
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

/** Assignment-strategy values; labels resolve via t(`workflow.strategy.${value}`). */
export const STRATEGY_OPTIONS: { value: string }[] = [
  { value: "least_busy" },
  { value: "first" },
];
