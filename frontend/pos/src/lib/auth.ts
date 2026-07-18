/**
 * Auth — the JWT lives in localStorage under "pos_token", shared with the
 * whole system (legacy POS + warehouse). The POS now has its own login screen
 * (components/PosLogin) that posts to /api/auth/login and stores the token here;
 * the payload is decoded client-side (base64 JSON, NO signature verification —
 * the server verifies on every request; this is for display/role-gating only).
 */
import type { AuthUser } from "./types";

export const TOKEN_KEY = "pos_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persist the JWT after a successful login. */
export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — the session simply won't survive a reload */
  }
}

/** Clear the session (logout / cashier switch). */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing persisted to clear */
  }
}

/** Roles the POS server-side gate (routes/pos-v2.js requireRole) admits. A
 *  client-side pre-check gives a clear rejection message instead of a broken
 *  screen for anyone else — the server is still the real boundary. */
export const POS_ROLES = ["admin", "manager", "cashier"] as const;

export function isPosRole(role: string | null | undefined): boolean {
  return POS_ROLES.includes(String(role ?? "").toLowerCase() as (typeof POS_ROLES)[number]);
}

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  // UTF-8 decode (usernames can be Arabic).
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function decodeUser(token: string | null): AuthUser | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const username = String(payload.username ?? payload.name ?? "");
    if (!username) return null;
    return { username, role: String(payload.role ?? "cashier") };
  } catch {
    return null;
  }
}

export function currentUser(): AuthUser | null {
  return decodeUser(getToken());
}

export function isSupervisor(user: AuthUser | null): boolean {
  const role = (user?.role ?? "").toLowerCase();
  return role === "admin" || role === "manager";
}
