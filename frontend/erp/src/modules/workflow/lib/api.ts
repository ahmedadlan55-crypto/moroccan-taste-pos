// Typed, read-only fetchers over the legacy workflow endpoints. BARE paths (the
// shared apiClient prepends /api and attaches the Bearer token). `username` is
// passed explicitly — exactly as the legacy employee client does — so the box
// scoping is correct even when the backend can't resolve req.user for these
// "public, auth-checked-inside" routes. Shapes are preserved verbatim.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { TxnBundle, TxnListFilters, TxnListItem } from "./types";

interface Opts {
  signal?: AbortSignal;
}

/** صندوق الوارد — transactions awaiting my action (received from others). */
function listParams(username: string, filters?: TxnListFilters) {
  return { username, ...(filters ?? {}) };
}

export function fetchIncoming(username: string, opts?: Opts & { filters?: TxnListFilters }) {
  return apiClient.get<TxnListItem[]>("/workflow/incoming", {
    params: listParams(username, opts?.filters),
    signal: opts?.signal,
  });
}

/** صندوق الصادر — transactions I created/sent. */
export function fetchOutbox(username: string, opts?: Opts & { filters?: TxnListFilters }) {
  return apiClient.get<TxnListItem[]>("/workflow/outbox", {
    params: listParams(username, opts?.filters),
    signal: opts?.signal,
  });
}

/** طلباتي — my submitted transactions (created_by = me). */
export function fetchMyTransactions(username: string, opts?: Opts) {
  return apiClient.get<TxnListItem[]>("/workflow/my-transactions", {
    params: { username },
    signal: opts?.signal,
  });
}

/** One-shot read bundle for the detail drawer (txn + workflow path + logs). */
export function fetchBundle(id: string, username: string, opts?: Opts) {
  return apiClient.get<TxnBundle>(`/workflow/transactions/${id}/full-bundle`, {
    params: { username },
    signal: opts?.signal,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// FC-P3 — WRITE layer for the Workflow module (inbox ACTIONS + approval BUILDER).
// The engine (state machine, permissions, SoD, routing) lives server-side; these
// hooks are the thin, typed React front to it. Every mutation endpoint answers
// with { success:false, error } (HTTP 200) OR a proper 4xx that the shared
// apiClient turns into a thrown ApiError — callers handle BOTH.
// ════════════════════════════════════════════════════════════════════════════

// ── Query-key namespace (all under "workflow" so an action can invalidate the
//    read boxes + drawer in one shot, exactly like lib/query-keys `qk.all`). ──
const bk = {
  permissions: (id: string, username: string) =>
    ["workflow", "permissions", id, username] as const,
  routable: (username: string) => ["workflow", "routable", username] as const,
  positions: () => ["workflow", "builder", "positions"] as const,
  types: () => ["workflow", "builder", "types"] as const,
  definitions: (typeId: string) => ["workflow", "builder", "definitions", typeId] as const,
  pwSummary: () => ["workflow", "builder", "pw-summary"] as const,
  pw: (initiatorId: string, pathKey: string) =>
    ["workflow", "builder", "pw", initiatorId, pathKey] as const,
  routes: () => ["workflow", "builder", "routes"] as const,
  slaOverdue: (username: string) => ["workflow", "sla", "overdue", username] as const,
  slaStats: () => ["workflow", "sla", "stats"] as const,
};

export interface CreateTransactionInput {
  transactionTypeId: string;
  title: string;
  subject: string;
  username: string;
  description?: string;
  contentHtml?: string;
  amount?: number;
  importance: "low" | "medium" | "high" | "critical";
  scope: "internal" | "external";
  recipientUsername?: string;
  dueDate?: string;
  contentSecrecy?: "normal" | "confidential" | "secret" | "top_secret";
  attachmentsSecrecy?: "normal" | "confidential" | "secret" | "top_secret";
  attachment?: string;
  saveAsDraft?: boolean;
}

export interface MarkReadResult {
  success: boolean;
  error?: string;
}

export function useMarkTxnRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<MarkReadResult>(`/workflow/transactions/${id}/mark-read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow"] }),
  });
}

export interface CreateTransactionResult extends MutationEnvelope {
  txnNumber?: string;
  currentAssignee?: string;
}

/** Creates a routed transaction or an explicit server-side draft. */
export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionInput) =>
      apiClient.post<CreateTransactionResult>("/workflow/transactions", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow"] }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// (A) INBOX ACTIONS
// ════════════════════════════════════════════════════════════════════════════

/** Server-computed, per-txn per-user permission flags (lib/transactionPermissions). */
export interface TxnPermissionFlags {
  canView?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canForceDelete?: boolean;
  canOpen?: boolean;
  canApprove?: boolean;
  canReject?: boolean;
  canReturn?: boolean;
  canForward?: boolean;
  canReply?: boolean;
  canResubmit?: boolean;
  canClose?: boolean;
  canRecordPayment?: boolean;
}
export interface TxnPermissionsResponse {
  permissions: TxnPermissionFlags;
  /** Optimistic-concurrency token — pass back as expectedVersion on the action. */
  currentVersion?: number;
  txnStatus?: string;
  isMyTurn?: boolean;
  isCreator?: boolean;
  iAlreadyActed?: boolean;
  iAlreadyReplied?: boolean;
  error?: string;
}

/** GET /workflow/transactions/:id/permissions — drives which action buttons render. */
export function useTxnPermissions(id: string | null, username: string, enabled: boolean) {
  return useQuery({
    queryKey: bk.permissions(id ?? "", username),
    enabled: enabled && !!id && !!username,
    queryFn: ({ signal }) =>
      apiClient.get<TxnPermissionsResponse>(`/workflow/transactions/${id}/permissions`, {
        params: { username },
        signal,
      }),
  });
}

export type TxnActionKind = "approve" | "reject" | "return" | "forward";

export interface TxnActionInput {
  id: string;
  action: TxnActionKind;
  username: string;
  note?: string;
  forwardTo?: string;
  /** The txn version the UI last saw; server 409s if it moved (VERSION_CONFLICT). */
  expectedVersion?: number;
}
export interface TxnActionResult {
  success: boolean;
  error?: string;
  code?: string;
  newStatus?: string;
  newAssignee?: string;
  newVersion?: number;
  currentVersion?: number;
}

/**
 * POST /workflow/transactions/:id/action. `username` is REQUIRED by the server
 * schema (ACTION_SCHEMA.required = ['action','username']). A stale expectedVersion
 * throws an ApiError with `.isConflict` (HTTP 409) — the caller refetches + retries.
 * On success we invalidate the whole "workflow" namespace so the inbox boxes and
 * the open drawer both reflect the new state.
 */
export function useTxnAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, username, note, forwardTo, expectedVersion }: TxnActionInput) =>
      apiClient.post<TxnActionResult>(`/workflow/transactions/${id}/action`, {
        action,
        username,
        note,
        forwardTo,
        expectedVersion,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow"] }),
  });
}

// ── Forward target picker (GET /workflow/routable-users) — grouped by relation. ──
export interface RoutableUser {
  username: string;
  fullName?: string;
  position?: string;
  branch?: string;
  role?: string;
  level?: number;
}
export interface RoutableGroup {
  key: string;
  label: string;
  icon?: string;
  users: RoutableUser[];
}
export interface RoutableUsersResponse {
  groups: RoutableGroup[];
  totalUsers?: number;
  error?: string;
}
export function useRoutableUsers(username: string, enabled: boolean) {
  return useQuery({
    queryKey: bk.routable(username),
    enabled: enabled && !!username,
    queryFn: ({ signal }) =>
      apiClient.get<RoutableUsersResponse>("/workflow/routable-users", {
        params: { username },
        signal,
      }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// (B) BUILDER
// ════════════════════════════════════════════════════════════════════════════

export type AssignmentStrategy = "least_busy" | "first";

// Small helper: legacy mutation envelopes are { success:false, error } at HTTP 200.
export interface MutationEnvelope {
  success: boolean;
  id?: string;
  error?: string;
}

// ── Positions (المناصب) — /workflow/positions ───────────────────────────────
export interface Position {
  id: string;
  name: string;
  level: number;
  isActive?: boolean;
}
export interface PositionInput {
  id?: string;
  name: string;
  level: number;
}
export function usePositions() {
  return useQuery({
    queryKey: bk.positions(),
    queryFn: () => apiClient.get<Position[]>("/workflow/positions"),
  });
}
export function useSavePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PositionInput) =>
      apiClient.post<MutationEnvelope>("/workflow/positions", input),
    // Positions feed the summary + step editors → refresh the whole builder tree.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}
export function useDeletePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<MutationEnvelope>(`/workflow/positions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}

// ── Transaction types (أنواع المعاملات) — /workflow/transaction-types ────────
export interface WfTransactionType {
  id: string;
  name: string;
  code: string;
  isActive?: boolean;
  category?: string;
  requiresPayment?: boolean;
}
export interface TransactionTypeInput {
  id?: string;
  name: string;
  code: string;
}
export function useTransactionTypes() {
  return useQuery({
    queryKey: bk.types(),
    queryFn: () => apiClient.get<WfTransactionType[]>("/workflow/transaction-types"),
  });
}
export function useSaveTransactionType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransactionTypeInput) =>
      apiClient.post<MutationEnvelope>("/workflow/transaction-types", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}
export function useDeleteTransactionType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<MutationEnvelope>(`/workflow/transaction-types/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}

// ── Approval steps (خطوات الاعتماد) — /workflow/workflow-definitions ─────────
// NOTE (deferred, honest): a definition carries NO full version history — the
// backend keeps only a light row that the latest save overwrites in place. There
// is no per-revision audit here; editing a step replaces it.
export interface WorkflowDefinition {
  id: string;
  stepOrder: number;
  stepName?: string;
  positionId: string | null;
  positionName?: string;
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  isFinal: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
  assignmentStrategy: string;
}
export interface WorkflowDefinitionInput {
  id?: string;
  transactionTypeId: string;
  stepOrder: number;
  stepName?: string;
  positionId: string | null;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
  assignmentStrategy: AssignmentStrategy;
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  isFinal: boolean;
}
export function useWorkflowDefinitions(typeId: string | null) {
  return useQuery({
    queryKey: bk.definitions(typeId ?? ""),
    enabled: !!typeId,
    queryFn: () =>
      apiClient.get<WorkflowDefinition[]>(`/workflow/workflow-definitions/${typeId}`),
  });
}
export function useSaveWorkflowDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowDefinitionInput) =>
      apiClient.post<MutationEnvelope>("/workflow/workflow-definitions", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "definitions"] }),
  });
}
export function useDeleteWorkflowDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<MutationEnvelope>(`/workflow/workflow-definitions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "definitions"] }),
  });
}

// ── Position paths (مسارات المناصب) — /workflow/position-workflow[s] ─────────
export interface PositionWorkflowSummary {
  id: string;
  name: string;
  level: number;
  stepCount: number;
}
export function usePositionWorkflowsSummary() {
  return useQuery({
    queryKey: bk.pwSummary(),
    queryFn: () =>
      apiClient.get<PositionWorkflowSummary[]>("/workflow/position-workflows-summary"),
  });
}
export interface PositionWorkflowStep {
  id: string;
  initiatorPositionId: string;
  pathKey: string;
  pathName: string;
  description?: string;
  stepOrder: number;
  stepName?: string;
  positionId: string | null;
  positionName?: string;
  isFinal: boolean;
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
  assignmentStrategy: string;
}
export function usePositionWorkflow(
  initiatorPositionId: string | null,
  pathKey = "default",
  enabled = true,
) {
  return useQuery({
    queryKey: bk.pw(initiatorPositionId ?? "", pathKey),
    enabled: enabled && !!initiatorPositionId,
    queryFn: () =>
      apiClient.get<PositionWorkflowStep[]>(
        `/workflow/position-workflow/${initiatorPositionId}`,
        { params: { pathKey } },
      ),
  });
}
export interface PositionWorkflowBulkStep {
  positionId: string | null;
  stepOrder?: number;
  stepName?: string;
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
  assignmentStrategy: AssignmentStrategy;
  isFinal: boolean;
}
export interface PositionWorkflowBulkInput {
  initiatorPositionId: string;
  pathKey?: string;
  pathName?: string;
  description?: string;
  steps: PositionWorkflowBulkStep[];
}
/**
 * Replace the whole chain for one (initiator, pathKey) atomically. The route is
 * POST /workflow/position-workflow/BULK — the plain `.../position-workflow`
 * verb from the loose spec does not exist; `/bulk` is the real replace-set API.
 */
export function useSavePositionWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PositionWorkflowBulkInput) =>
      apiClient.post<MutationEnvelope & { count?: number }>(
        "/workflow/position-workflow/bulk",
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}

// ── Routing rules (قواعد التوجيه) — JSON-DSL, mounted at /api/workflow-routes ─
// NOTE (deferred, honest): amount-threshold / conditional routing exists ONLY as
// far as this routes-DSL expresses it (a linear resolver over `branches[].if`
// string conditions). We surface the list + a dry-run tester; authoring the raw
// DSL stays admin/server territory and is NOT faked with a richer UI here.
export interface WorkflowRoute {
  id: string;
  transactionTypeId: string | null;
  initiatorPositionId: string | null;
  routeName: string;
  isDefault: boolean;
  isActive: boolean;
  conditions: unknown;
  steps: unknown;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}
export function useWorkflowRoutes() {
  return useQuery({
    queryKey: bk.routes(),
    queryFn: async () => {
      // The list endpoint lives at /api/workflow-routes (its own router), NOT
      // under /api/workflow. On failure it answers { error } instead of an array.
      const res = await apiClient.get<WorkflowRoute[] | { error?: string }>("/workflow-routes");
      if (Array.isArray(res)) return res;
      // The caller (RoutesDslTab) renders a translated <ErrorState> body for this
      // failure; surface the server's error text when present, else an empty
      // Error so the shared state falls back to its localized generic message.
      throw new Error((res as { error?: string })?.error || "");
    },
  });
}
export interface RouteTestStep {
  id: string;
  name: string;
  position?: string;
}
export interface RouteTestResult {
  success: boolean;
  path?: RouteTestStep[];
  error?: string;
}
/** POST /workflow-routes/:id/test — admin-only dry-run of a sample txn. */
export function useTestWorkflowRoute() {
  return useMutation({
    mutationFn: ({ id, txn }: { id: string; txn: Record<string, unknown> }) =>
      apiClient.post<RouteTestResult>(`/workflow-routes/${id}/test`, { txn }),
  });
}

// ── SLA (read-only health cards) — /api/sla ──────────────────────────────────
export interface SlaOverdueItem {
  id: string;
  txnNumber?: string;
  subject?: string;
  status?: string;
  amount?: number;
  importance?: string;
  typeName?: string;
  createdBy?: string;
  currentAssignee?: string;
  dueDate?: string | null;
  hoursOverdue: number;
  escalationCount: number;
}
/** Pass an empty username to get the SYSTEM-WIDE overdue list (admin view). */
export function useSlaOverdue(username: string) {
  return useQuery({
    queryKey: bk.slaOverdue(username),
    queryFn: () =>
      apiClient.get<SlaOverdueItem[]>("/sla/overdue", {
        params: { username: username || undefined },
      }),
  });
}
export interface SlaStats {
  totalOpen: number;
  overdueCount: number;
  due24h: number;
  avgCloseHours: number;
  overdueByPriority?: Record<string, number>;
  error?: string;
}
export function useSlaStats() {
  return useQuery({
    queryKey: bk.slaStats(),
    queryFn: () => apiClient.get<SlaStats>("/sla/stats"),
  });
}
export interface EscalateResult {
  checked?: number;
  escalated?: number;
  errors?: number;
  success?: boolean;
  error?: string;
}
/** POST /sla/escalate-now — admin-only manual escalation sweep. */
export function useEscalateNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      apiClient.post<EscalateResult>("/sla/escalate-now", { username }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "sla"] }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// (B-cont.) BUILDER — the 4 heavier tabs (steps · position-paths · routes · SLA).
// APPEND-ONLY extension of the write layer above; nothing here removes/rewrites
// an existing export. Field names verified against routes/workflow.js,
// routes/workflowRoutes.js and routes/sla.js.
// ════════════════════════════════════════════════════════════════════════════

// ── Approval steps — bulk replace-set for a type ─────────────────────────────
// POST /workflow/workflow-definitions/bulk wipes then re-inserts the whole chain
// for one transaction type (or ALL types when applyToAllTypes). Individual-step
// CRUD stays on useSaveWorkflowDefinition / useDeleteWorkflowDefinition above.
export interface WorkflowDefinitionBulkStep {
  positionId: string | null;
  stepOrder?: number;
  stepName?: string;
  canApprove: boolean;
  canReject: boolean;
  canReturn: boolean;
  canEdit: boolean;
  canEditAmount: boolean;
  requireSameBranch: boolean;
  requireSameDepartment: boolean;
  assignmentStrategy: AssignmentStrategy;
  isFinal: boolean;
}
export interface WorkflowDefinitionBulkInput {
  transactionTypeId?: string;
  applyToAllTypes?: boolean;
  steps: WorkflowDefinitionBulkStep[];
}
export function useSaveWorkflowDefinitionsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowDefinitionBulkInput) =>
      apiClient.post<MutationEnvelope & { count?: number; typesAffected?: number }>(
        "/workflow/workflow-definitions/bulk",
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "definitions"] }),
  });
}

// ── Position paths — list the paths of one initiator, and delete one path ─────
export interface PositionWorkflowPath {
  pathKey: string;
  pathName: string;
  description: string;
  stepCount: number;
}
/** GET /workflow/position-workflow/:initiatorPositionId/paths — one row per path. */
export function usePositionWorkflowPaths(initiatorPositionId: string | null) {
  return useQuery({
    queryKey: ["workflow", "builder", "pw-paths", initiatorPositionId ?? ""] as const,
    enabled: !!initiatorPositionId,
    queryFn: () =>
      apiClient.get<PositionWorkflowPath[]>(
        `/workflow/position-workflow/${initiatorPositionId}/paths`,
      ),
  });
}
/** DELETE /workflow/position-workflow/:initiatorPositionId/path/:pathKey. */
export function useDeletePositionWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      initiatorPositionId,
      pathKey,
    }: {
      initiatorPositionId: string;
      pathKey: string;
    }) =>
      apiClient.delete<MutationEnvelope>(
        `/workflow/position-workflow/${initiatorPositionId}/path/${encodeURIComponent(pathKey)}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder"] }),
  });
}

// ── Routing rules (JSON-DSL) — full CRUD at /api/workflow-routes (admin only) ─
// The list/test hooks live above (useWorkflowRoutes / useTestWorkflowRoute). The
// backend guards writes with `admin only` (403) — the shared apiClient turns that
// into a thrown ApiError the caller surfaces; 200-envelope { success:false } too.
export interface WorkflowRouteInput {
  transactionTypeId?: string | null;
  initiatorPositionId?: string | null;
  routeName: string;
  isDefault?: boolean;
  conditions: unknown;
  steps: unknown;
}
export function useSaveWorkflowRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowRouteInput) =>
      apiClient.post<MutationEnvelope>("/workflow-routes", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "routes"] }),
  });
}
export interface WorkflowRouteUpdate {
  id: string;
  routeName?: string;
  isDefault?: boolean;
  isActive?: boolean;
  conditions?: unknown;
  steps?: unknown;
}
export function useUpdateWorkflowRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: WorkflowRouteUpdate) =>
      apiClient.put<MutationEnvelope>(`/workflow-routes/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "routes"] }),
  });
}
export function useDeleteWorkflowRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<MutationEnvelope>(`/workflow-routes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", "builder", "routes"] }),
  });
}
