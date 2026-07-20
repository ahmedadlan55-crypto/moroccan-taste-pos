/**
 * capabilities.ts — frontend capability awareness (Owner J).
 *
 * The POS has always role-gated a handful of actions client-side via
 * isSupervisor() (admin OR manager) — see lib/auth.ts. This module lets those
 * same actions ALSO be granted through the real capability system the O2C/ERP
 * side already enforces server-side (GET /api/auth/permissions/me), without
 * requiring any backend change:
 *   - caps.isAdmin (isPrimaryAdmin / isDeveloper / the '*' wildcard) always
 *     passes.
 *   - once caps are loaded, an explicit granted permission for the capId
 *     passes.
 *   - otherwise (caps not loaded yet, offline, older server without the
 *     endpoint, or the permission simply isn't granted) posCan() falls back
 *     to the SAME role check the app already performs today
 *     (POS_ROLE_FALLBACK), so behavior is IDENTICAL to today until/unless a
 *     backend seed ever grants one of these capIds to a wider set of roles.
 *   - a capId with no fallback entry defaults to allowed — posCan() never
 *     invents a NEW restriction that doesn't already exist in the app.
 *
 * The "pos.*" capability ids below are CLIENT-SIDE PLACEHOLDERS: there are no
 * matching capability rows seeded on the backend yet. That's fine — posCan()
 * is fully functional with zero live capability rows (it just falls back to
 * the role table every time), so shipping this needs no backend coordination.
 */
import { request } from "./api";

export interface EffectiveCaps {
  permissions: Set<string>;
  role: string;
  isAdmin: boolean;
  loaded: boolean;
}

interface PermissionsMeResponse {
  permissions?: string[];
  role?: string;
  isPrimaryAdmin?: boolean;
  isDeveloper?: boolean;
}

/** GET /api/auth/permissions/me — the caller's effective capability set. */
export async function fetchEffectiveCaps(): Promise<EffectiveCaps> {
  const body = await request<PermissionsMeResponse>("/api/auth/permissions/me");
  return {
    permissions: new Set(body.permissions ?? []),
    role: body.role ?? "",
    isAdmin: !!(body.isPrimaryAdmin || body.isDeveloper) || (body.permissions ?? []).includes("*"),
    loaded: true,
  };
}

/**
 * Role fallback for the exact actions this app already role-gates via
 * isSupervisor() — confirmed by reading (not guessed):
 *   - "pos.discount.override"  → CartPanel.tsx + DiscountDialog.tsx: bypass
 *     the cashier discount-ceiling warning (catalog.maxCashierDiscountPct).
 *   - "pos.sale.credit"        → PaymentDialog.tsx: البيع الآجل — enable the
 *     credit tab / the split tab's آجل leg.
 *   - "pos.sale.void.override" → MyInvoicesDialog.tsx: skip the
 *     manager-approval dialog before voiding/returning an already-synced
 *     sale (needsApprovalGate's `privileged` flag). The server re-authorizes
 *     every void/return regardless — this only decides whether to SHOW a
 *     dialog the server would wave through anyway.
 * A capId absent from this table defaults to allowed in posCan() below.
 */
export const POS_ROLE_FALLBACK: Record<string, Array<"admin" | "manager" | "cashier">> = {
  "pos.discount.override": ["admin", "manager"],
  "pos.sale.credit": ["admin", "manager"],
  "pos.sale.void.override": ["admin", "manager"],
};

/**
 * Can the current user perform `capId`?
 *   1. caps.isAdmin                              → true
 *   2. caps loaded AND capId is a granted perm    → true
 *   3. else fall back to POS_ROLE_FALLBACK[capId] → role membership
 *   4. capId not in the fallback table at all     → true (never invent a
 *      new restriction that doesn't already exist client-side)
 */
export function posCan(caps: EffectiveCaps | null, role: string, capId: string): boolean {
  if (caps?.isAdmin) return true;
  if (caps?.loaded && caps.permissions.has(capId)) return true;
  const fallback = POS_ROLE_FALLBACK[capId];
  if (!fallback) return true;
  const roleLower = String(role ?? "").toLowerCase();
  return (fallback as string[]).includes(roleLower);
}
