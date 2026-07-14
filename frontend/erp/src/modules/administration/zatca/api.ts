// ── ZATCA Phase-2 onboarding domain API adapter + React Query hooks ──────────
// Thin typed layer over @/shared/api for the fatoora / ZATCA CSID lifecycle.
// Every path mirrors routes/erp/zatca.js EXACTLY (mounted under /api/erp/zatca).
//
// SECURITY: the private key / binary token / secret live server-side, encrypted,
// and are NEVER returned to the browser. Only `status` (below) is read here — it
// exposes state flags, not credentials. The OTP is user-entered input sent once
// to the compliance endpoint; it is never persisted anywhere on the client.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

export type CsidStatus = "none" | "compliance" | "production" | "revoked" | (string & {});

// GET /erp/zatca/status — NO secrets, read-only state.
export interface ZatcaStatus {
  success?: boolean;
  csidStatus: CsidStatus;
  csidObtainedAt: string | null;
  requestId: string | null;
  sellerName: string;
  sellerVat: string;
  lastSubmittedAt: string | null;
  queueStats: { pending?: number; running?: number; done?: number; failed?: number };
}

// POST /erp/zatca/onboard/compliance body — mirrors the route exactly.
// `otp` + `vatNumber` are required by the server; the rest carry CSR defaults.
export interface ComplianceInput {
  otp: string;
  vatNumber: string;
  commonName?: string;
  organizationName?: string;
  organizationalUnitName?: string;
  invoiceType?: string;
  sellerLocation?: string;
  industryCode?: string;
  crNumber?: string;
}

interface Ack {
  success?: boolean;
  error?: string;
}
export interface ComplianceResult extends Ack {
  csidStatus?: CsidStatus;
  requestId?: string;
  message?: string;
}
export interface ProductionResult extends Ack {
  csidStatus?: CsidStatus;
  message?: string;
}
// The test endpoint reports the ZATCA compliance-check outcome; `success`
// reflects the upstream HTTP 200/202. `response` is the raw ZATCA body (diagnostic).
export interface TestResult extends Ack {
  httpStatus?: number;
  response?: unknown;
  invoiceUuid?: string;
  invoiceHash?: string;
}

// These endpoints answer HTTP 200 even on failure ({ success:false, error }),
// so a thrown Error is what drives react-query's onError path + the toast.
function ack<T extends Ack>(res: T): T {
  if (res && res.success === false) throw new Error(res.error || "تعذّرت العملية");
  return res;
}

export const ZATCA_STATUS_KEY = ["erp", "zatca-status"] as const;

export function useZatcaStatus() {
  return useQuery({
    queryKey: [...ZATCA_STATUS_KEY],
    queryFn: ({ signal }) => apiClient.get<ZatcaStatus>("/erp/zatca/status", { signal }),
  });
}

/** Step 1 — request a compliance CSID from the OTP + CSR fields. */
export function useOnboardCompliance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ComplianceInput) =>
      ack(await apiClient.post<ComplianceResult>("/erp/zatca/onboard/compliance", input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ZATCA_STATUS_KEY] }),
  });
}

/** Step 2 — submit a synthetic compliance invoice (does not change CSID state). */
export function useZatcaTest() {
  return useMutation({
    // Deliberately NOT wrapped in ack(): a non-2xx ZATCA outcome is surfaced to
    // the user (httpStatus + response) rather than thrown, since it's diagnostic.
    mutationFn: (_: void) => apiClient.post<TestResult>("/erp/zatca/test", {}),
  });
}

/** Step 3 — graduate compliance → production. */
export function useOnboardProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_: void) =>
      ack(await apiClient.post<ProductionResult>("/erp/zatca/onboard/production", {})),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ZATCA_STATUS_KEY] }),
  });
}

/** Revoke — clear all server-side credentials (ConfirmDialog, requireReason). */
export function useRevokeZatca() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_reason: string) =>
      ack(await apiClient.post<Ack>("/erp/zatca/revoke", {})),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ZATCA_STATUS_KEY] }),
  });
}
