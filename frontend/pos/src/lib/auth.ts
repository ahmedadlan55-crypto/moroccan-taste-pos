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

/**
 * Roles whose home is بوابة الموظف (/employee) rather than the back office.
 *
 * `custody` belongs here because the standalone custody portal is now a TAB in
 * the employee portal — its own app was retired and folded in.
 */
const PORTAL_ROLES = ["employee", "custody"] as const;

/**
 * Which app a role that the till refuses should be sent to instead.
 *
 * The role gate is correct to refuse — but refusing is only half an answer.
 * Before this, a cook who typed their number into the cashier screen got
 * "contact your administrator" and one link, to the back office: an app they
 * cannot use either. Now the refusal names the door that fits.
 *
 * Returns null for a role the till ADMITS (nothing to redirect) so the caller
 * cannot accidentally render this for someone who is already in the right app.
 */
export function homeAppForRole(role: string | null | undefined): "portal" | "office" | null {
  const r = String(role ?? "").toLowerCase();
  if (isPosRole(r)) return null;
  return (PORTAL_ROLES as readonly string[]).includes(r) ? "portal" : "office";
}

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  // UTF-8 decode (usernames can be Arabic).
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Decode the session token into the user the app renders and PRINTS.
 *
 * `name` is the cashier's real name and is the ONLY place the till can learn
 * it: the store re-derives its user from this token on every mount
 * (state/store.tsx:530) and an OFFLINE sale cannot ask the server. The server
 * puts it in the `displayName` claim (routes/auth.js), already resolved through
 * users.full_name → settings.user_meta[u].name → username by lib/displayName.js.
 *
 * THE DEPLOY CASE, not a theory: every token sitting in localStorage the moment
 * this ships was minted WITHOUT the claim and stays valid for up to 24h. Those
 * sessions must keep working, so a missing/blank/whitespace-only claim falls
 * back to the username — the same login id the receipt printed before. Nothing
 * regresses; the name simply arrives on the next login or token refresh.
 *
 * The claim is read from `displayName`, deliberately NOT `name`: the username
 * line below already treats a bare `name` claim as a username fallback, and
 * reusing that key would let a display name masquerade as a login id.
 */
export function decodeUser(token: string | null): AuthUser | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const username = String(payload.username ?? payload.name ?? "");
    if (!username) return null;
    const claimed = typeof payload.displayName === "string" ? payload.displayName.trim() : "";
    const stableId = payload.id == null ? "" : String(payload.id).trim();
    return {
      ...(stableId ? { id: stableId } : {}),
      username,
      role: String(payload.role ?? "cashier"),
      name: claimed || username,
    };
  } catch {
    return null;
  }
}

/** The name to show a HUMAN for this user — never a login id when a real name
 *  is known, never blank. One helper so no screen re-invents the fallback. */
export function displayNameOf(user: AuthUser | null | undefined): string {
  return (user?.name ?? "").trim() || (user?.username ?? "").trim();
}

export function currentUser(): AuthUser | null {
  return decodeUser(getToken());
}

export function isSupervisor(user: AuthUser | null): boolean {
  const role = (user?.role ?? "").toLowerCase();
  return role === "admin" || role === "manager";
}

/** Roles whose only home is this app — they have no back office at all.
 *  Mirrors POS_ONLY_ROLES in middleware/posPortalScope.js, which is the real
 *  boundary (it 403s every back-office path for these roles). Used here only
 *  to avoid rendering links that would dead-end. */
export const POS_ONLY_ROLES = ["cashier"] as const;

export function isPosOnlyRole(role: string | null | undefined): boolean {
  return POS_ONLY_ROLES.includes(String(role ?? "").toLowerCase() as (typeof POS_ONLY_ROLES)[number]);
}
