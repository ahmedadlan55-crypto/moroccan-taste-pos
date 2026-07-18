// Workflow / Transactions (نظام المعاملات) DTOs — the shapes returned by the
// legacy /api/workflow endpoints (routes/workflow.js `_mapTxn` + `full-bundle`).
// Kept minimal + permissive (optional fields) since the Express envelope is the
// source of truth and this session only READS it. No shapes are invented here.

/** A row in the list endpoints (/incoming, /outbox, /my-transactions, /transactions). */
export interface TxnListItem {
  id: string;
  txnNumber?: string;
  typeId?: string;
  typeName?: string;
  typeCode?: string;
  createdBy?: string;
  creatorName?: string;
  creatorJobTitle?: string;
  branchName?: string;
  deptName?: string;
  title?: string;
  subject?: string;
  amount?: number;
  importance?: string; // 'critical' | 'high' | 'medium' | 'low'
  status: string;
  currentStepName?: string;
  currentAssignee?: string;
  assigneeName?: string;
  assigneeJobTitle?: string;
  // enriched by /incoming, /outbox, /transactions (absent on /my-transactions)
  isRead?: boolean;
  readAt?: string | null;
  dueDate?: string | null;
  isOverdue?: boolean;
  expenseCategoryId?: string;
  expenseCategoryName?: string;
  scope?: "internal" | "external" | string;
  isReturnedForEdit?: boolean;
  returnReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TxnListFilters {
  status?: string;
  importance?: string;
  typeId?: string;
  readStatus?: "read" | "unread";
  overdue?: "1";
  subject?: string;
  txnNumber?: string;
  startDate?: string;
  endDate?: string;
}

/** One node of the transaction-type approval path (full-bundle `workflowPath`). */
export interface WorkflowPathStep {
  id: string;
  stepOrder?: number;
  stepName?: string;
  positionName?: string;
  isFinal?: boolean;
  isCurrent?: boolean;
  isPast?: boolean;
  state?: "current" | "done" | "pending";
}

/** One entry of the action log (full-bundle `logs`, table transaction_steps_log). */
export interface TxnLog {
  id: string | number;
  stepName?: string;
  positionName?: string;
  actionBy?: string;
  actorFullName?: string;
  actorRole?: string;
  actionType?: string; // ENUM(create, approve, reject, return, forward, close)
  note?: string | null;
  createdAt: string;
}

/** A recipient of the transaction (full-bundle `recipients`). */
export interface TxnRecipient {
  id: string | number;
  type?: string;
  username?: string;
  name?: string;
  position?: string;
  needsResponse?: boolean;
  responseReceived?: boolean;
}

export interface TxnAttachment {
  id: string | number;
  fileName?: string;
  mime?: string;
  dataUrl?: string;
  uploadedBy?: string;
  uploadedAt?: string;
  logId?: string | number | null;
}

export interface TxnReply {
  id: string | number;
  replyText?: string;
  attachment?: string;
  attachmentName?: string;
  attachmentMime?: string;
  authorUsername?: string;
  authorName?: string;
  authorRole?: string;
  authorPosition?: string;
  authorBranch?: string;
  receivedAt?: string;
  createdAt: string;
}

/**
 * The one-shot read bundle for the detail drawer
 * (GET /api/workflow/transactions/:id/full-bundle).
 */
export interface TxnBundle extends TxnListItem {
  description?: string;
  contentHtml?: string;
  contentSecrecy?: string;
  attachmentsSecrecy?: string;
  issuingEntityName?: string;
  hijriDate?: string;
  passedCeoAt?: string | null;
  passedCeoBy?: string | null;
  createdByName?: string;
  createdByPosition?: string;
  createdByBranch?: string;
  currentAssigneeName?: string;
  currentAssigneePosition?: string;
  currentAssigneeBranch?: string;
  recipients?: TxnRecipient[];
  workflowPath?: WorkflowPathStep[];
  logs?: TxnLog[];
  attachments?: TxnAttachment[];
  replies?: TxnReply[];
  /** Present on the error envelope some legacy handlers return with HTTP 200. */
  error?: string;
}
