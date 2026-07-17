/**
 * Parity — auth domain (docs/pos-parity-matrix.md):
 *   auth-get-current-user  — decodeUser/currentUser read the JWT payload
 *   auth-role-helpers      — isSupervisor === legacy isAdmin() (admin OR manager)
 *   hard-auth-gate         — no/garbage token ⇒ null user (App then renders LoginRequired)
 *   auth-token-attach-fetch — every api call carries Authorization: Bearer <pos_token>
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY, currentUser, decodeUser, getToken, isSupervisor } from "../auth";
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
    expect(u).toEqual({ username: "kashier1", role: "cashier" });
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
    expect(currentUser()).toEqual({ username: "kashier1", role: "cashier" });
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
