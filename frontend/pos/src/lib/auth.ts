/**
 * Auth — the JWT lives in localStorage under "pos_token", shared with the
 * whole system (legacy POS + warehouse). There is no login screen here: if
 * the token is absent the app shows a "سجّل الدخول من النظام الرئيسي" state.
 * The payload is decoded client-side (base64 JSON, NO signature verification —
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
