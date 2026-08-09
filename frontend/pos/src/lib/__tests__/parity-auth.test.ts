/**
 * Parity — auth domain (docs/pos-parity-matrix.md):
 *   auth-get-current-user  — decodeUser/currentUser read the JWT payload
 *   auth-role-helpers      — isSupervisor === legacy isAdmin() (admin OR manager)
 *   hard-auth-gate         — no/garbage token ⇒ null user (App then renders LoginRequired)
 *   auth-token-attach-fetch — every api call carries Authorization: Bearer <pos_token>
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY, currentUser, decodeUser, displayNameOf, getToken, isSupervisor } from "../auth";
import { getServerFlags } from "../api";

/** Build an unsigned JWT-shaped token with a UTF-8 JSON payload (base64url). */
function makeToken(payload: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("auth-get-current-user — decodeUser reads the shared pos_token", () => {
  it("decodes username + role from the payload", () => {
    const u = decodeUser(makeToken({ username: "kashier1", role: "cashier" }));
    expect(u).toEqual({ username: "kashier1", role: "cashier", name: "kashier1" });
  });

  it("carries the stable account id used by POS order ownership", () => {
    expect(decodeUser(makeToken({ id: 41, username: "cashier.renamed", role: "cashier" }))?.id).toBe("41");
  });

  it("decodes ARABIC usernames (UTF-8 payload)", () => {
    const u = decodeUser(makeToken({ username: "أحمد", role: "manager" }));
    expect(u?.username).toBe("أحمد");
  });

  it("defaults the role to cashier when the payload has none", () => {
    expect(decodeUser(makeToken({ username: "x" }))?.role).toBe("cashier");
  });

  it("hard gate: no token / garbage token / empty username ⇒ null user", () => {
    expect(decodeUser(null)).toBeNull();
    expect(decodeUser("not-a-jwt")).toBeNull();
    expect(decodeUser("a.b@@@.c")).toBeNull();
    expect(decodeUser(makeToken({ role: "cashier" }))).toBeNull();
  });

  it("currentUser reads localStorage pos_token (shared with the whole system)", () => {
    expect(TOKEN_KEY).toBe("pos_token");
    localStorage.setItem(TOKEN_KEY, makeToken({ username: "kashier1", role: "cashier" }));
    expect(getToken()).not.toBeNull();
    expect(currentUser()).toEqual({ username: "kashier1", role: "cashier", name: "kashier1" });
  });
});

/** The owner's complaint: the receipt named him "2004" — his login id — because
 *  the token carried no name and the till has no other source (it re-derives the
 *  user from the token on every mount, and an OFFLINE sale cannot ask the
 *  server). routes/auth.js now signs a `displayName` claim, already resolved
 *  server-side through users.full_name → settings.user_meta → username by
 *  lib/displayName.js. */
describe("cashier display name — the JWT displayName claim", () => {
  it("a token WITH a name: decodeUser keeps it, username stays the login id", () => {
    const u = decodeUser(makeToken({ username: "2004", role: "cashier", displayName: "أحمد عدلان" }));
    expect(u).toEqual({ username: "2004", role: "cashier", name: "أحمد عدلان" });
    expect(displayNameOf(u)).toBe("أحمد عدلان");
  });

  it("THE DEPLOY CASE — a token WITHOUT the claim falls back to the username", () => {
    // Every session live in localStorage the moment this ships was minted
    // without the claim and stays valid for up to 24h. It must keep working and
    // print exactly what it printed yesterday, never a blank "served by".
    const u = decodeUser(makeToken({ username: "2004", role: "cashier" }));
    expect(u?.name).toBe("2004");
    expect(displayNameOf(u)).toBe("2004");
  });

  it("an empty or whitespace-only claim falls back to the username too", () => {
    expect(decodeUser(makeToken({ username: "2004", role: "cashier", displayName: "" }))?.name).toBe("2004");
    expect(decodeUser(makeToken({ username: "2004", role: "cashier", displayName: "   " }))?.name).toBe("2004");
    expect(decodeUser(makeToken({ username: "2004", role: "cashier", displayName: "\t\n" }))?.name).toBe("2004");
  });

  it("a padded claim is trimmed — no leading spaces on thermal paper", () => {
    expect(
      decodeUser(makeToken({ username: "2004", role: "cashier", displayName: "  أحمد عدلان  " }))?.name,
    ).toBe("أحمد عدلان");
  });

  it("a non-string claim is ignored (never printed as [object Object])", () => {
    expect(decodeUser(makeToken({ username: "2004", displayName: { ar: "أحمد" } }))?.name).toBe("2004");
    expect(decodeUser(makeToken({ username: "2004", displayName: 42 }))?.name).toBe("2004");
  });

  it("the claim is read from `displayName`, NOT `name` — `name` is a USERNAME fallback", () => {
    // decodeUser treats a bare `name` claim as a username (legacy tokens), so
    // reusing that key for a display name would let it masquerade as a login id
    // and would then be what every API scopes on.
    const u = decodeUser(makeToken({ role: "cashier", name: "legacy-login-id" }));
    expect(u?.username).toBe("legacy-login-id");
  });

  it("displayNameOf never returns blank for a user with a username", () => {
    expect(displayNameOf({ username: "2004", role: "cashier" })).toBe("2004");
    expect(displayNameOf({ username: "2004", role: "cashier", name: "  " })).toBe("2004");
    expect(displayNameOf(null)).toBe("");
    expect(displayNameOf(undefined)).toBe("");
  });
});

describe("auth-role-helpers — isSupervisor is legacy isAdmin() (admin OR manager)", () => {
  it("admin and manager are supervisors (case-insensitive)", () => {
    expect(isSupervisor({ username: "a", role: "admin" })).toBe(true);
    expect(isSupervisor({ username: "m", role: "Manager" })).toBe(true);
  });
  it("cashier / others / no user are NOT", () => {
    expect(isSupervisor({ username: "c", role: "cashier" })).toBe(false);
    expect(isSupervisor({ username: "e", role: "employee" })).toBe(false);
    expect(isSupervisor(null)).toBe(false);
  });
});

describe("auth-token-attach-fetch — Bearer token on every api call", () => {
  it("request() sends Authorization: Bearer <pos_token>", async () => {
    const tok = makeToken({ username: "kashier1", role: "cashier" });
    localStorage.setItem(TOKEN_KEY, tok);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ orderToCash: true }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await getServerFlags();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${tok}`);
  });

  it("omits the header when no token exists (server then 401s — fail closed)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await getServerFlags();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
