// Portal sign-in.
//
// POST /api/auth/login answers HTTP 200 for BOTH outcomes and distinguishes
// them with `success` — including the portal-access refusal below — so every
// caller must read the body, not the status. `api.post` already raises an
// ApiError on `success:false`, which is why this file can read like it does.
//
// ─── portal: "employee" ──────────────────────────────────────────────────────
// routes/auth.js gates per-portal access: an account whose `employee_portal`
// flag is 0 is refused HERE and only here. That gate has been unreachable since
// the original PWA was deleted — nothing left in the product sent a portal id,
// so the flag an admin toggles in the user dialog silently governed nothing.
// Sending it restores the flag's meaning; see the matching backend test.

import { api, setSession, clearSession, type PortalSession } from "./api";
import { fallbackDevice, type DeviceInfo } from "./selfService";

export interface LoginResponse {
  success: true;
  username: string;
  role: string;
  token: string;
  displayName?: string;
  isDeveloper?: boolean;
  brandId?: string;
  branchId?: string;
  warehouseId?: string;
  employeeId?: string;
  mustChangePassword?: boolean;
  /** Whether this account may open the custody section (server-declared). */
  custodyPortal?: boolean;
  employeePortal?: boolean;
}

export async function login(username: string, password: string): Promise<PortalSession> {
  const device: DeviceInfo = fallbackDevice(
    typeof navigator !== "undefined" ? navigator.userAgent : "",
  );

  const res = await api.post<LoginResponse>(
    "/auth/login",
    // `portal` is what makes the employee_portal flag a real gate.
    { username, password, portal: "employee", device },
    { anonymous: true },
  );

  const session: PortalSession = {
    username: res.username,
    role: res.role,
    fullName: res.displayName || res.username,
    // The server is the authority on this. Absent (older backend) → false, so
    // the tab stays hidden rather than rendering a section that will 403.
    custodyPortal: res.custodyPortal === true,
  };
  setSession(res.token, session);
  return session;
}

export function logout(): void {
  clearSession();
}
