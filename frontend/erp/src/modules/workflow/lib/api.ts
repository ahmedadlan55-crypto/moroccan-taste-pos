// Typed, read-only fetchers over the legacy workflow endpoints. BARE paths (the
// shared apiClient prepends /api and attaches the Bearer token). `username` is
// passed explicitly — exactly as the legacy employee client does — so the box
// scoping is correct even when the backend can't resolve req.user for these
// "public, auth-checked-inside" routes. Shapes are preserved verbatim.

import { apiClient } from "@/shared/api";
import type { TxnBundle, TxnListItem } from "./types";

interface Opts {
  signal?: AbortSignal;
}

/** صندوق الوارد — transactions awaiting my action (received from others). */
export function fetchIncoming(username: string, opts?: Opts) {
  return apiClient.get<TxnListItem[]>("/workflow/incoming", {
    params: { username },
    signal: opts?.signal,
  });
}

/** صندوق الصادر — transactions I created/sent. */
export function fetchOutbox(username: string, opts?: Opts) {
  return apiClient.get<TxnListItem[]>("/workflow/outbox", {
    params: { username },
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
