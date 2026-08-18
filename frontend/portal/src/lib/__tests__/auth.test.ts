// The two things about signing in that are contracts, not implementation.
//
//   1. The portal SENDS `portal: "employee"`. That single field is what makes
//      the `employee_portal` flag a real gate — routes/auth.js only checks it
//      when a portal id arrives. From the FC-W3 cutover until this portal
//      returned, nothing in the product sent one, so the toggle an admin flips
//      in the user dialog governed precisely nothing. Drop the field and it
//      goes back to governing nothing, silently, with every test still green.
//
//   2. The portal writes `emp_token`, NEVER `pos_token`. localStorage is keyed
//      by ORIGIN: /app, /pos and /employee share one store, and the ERP client
//      resolves its token from ["pos_token","token","jwt"]. Writing pos_token
//      here would mean an employee signing in on a shared floor tablet to punch
//      a fingerprint hands the next person to open /app a live back-office
//      session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login, logout } from "../auth";
import { getSession, getToken } from "../api";

const OK_BODY = {
  success: true,
  username: "sara",
  role: "employee",
  token: "jwt-abc",
  displayName: "سارة",
  custodyPortal: false,
};

function mockFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () => ({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the portal id is what arms the employee_portal flag", () => {
  it('sends portal: "employee" on every sign-in', async () => {
    const spy = mockFetch(OK_BODY);
    await login("sara", "pw");

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.portal, "without this the employee_portal flag gates nothing").toBe("employee");
    expect(sent.username).toBe("sara");
  });

  it("surfaces the server's portal refusal as an error, not a signed-in session", async () => {
    // routes/auth.js answers HTTP 200 with success:false for this refusal — a
    // client that reads only the status code would sign the person straight in.
    mockFetch({ success: false, error: "هذا الحساب لا يملك صلاحية الدخول إلى بوابة الموظف" });

    await expect(login("sara", "pw")).rejects.toThrow(/بوابة الموظف/);
    expect(getToken()).toBe("");
    expect(getSession()).toBeNull();
  });
});

describe("token namespace isolation", () => {
  it("writes emp_token and NEVER pos_token", async () => {
    mockFetch(OK_BODY);
    await login("sara", "pw");

    expect(localStorage.getItem("emp_token")).toBe("jwt-abc");
    expect(
      localStorage.getItem("pos_token"),
      "the ERP client reads pos_token — writing it here leaks a back-office session",
    ).toBeNull();
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("jwt")).toBeNull();
  });

  it("signing out clears the portal session and leaves an ERP session alone", async () => {
    localStorage.setItem("pos_token", "someone-elses-erp-session");
    mockFetch(OK_BODY);
    await login("sara", "pw");

    logout();

    expect(getToken()).toBe("");
    expect(getSession()).toBeNull();
    expect(localStorage.getItem("pos_token")).toBe("someone-elses-erp-session");
  });
});

describe("custody access comes from the server, never assumed", () => {
  it("is false when the server omits the flag (older backend)", async () => {
    mockFetch({ ...OK_BODY, custodyPortal: undefined });
    const session = await login("sara", "pw");
    // Defaulting to true would render a tab that 403s on first touch.
    expect(session.custodyPortal).toBe(false);
  });

  it("is true only when the server says so", async () => {
    mockFetch({ ...OK_BODY, custodyPortal: true });
    const session = await login("sara", "pw");
    expect(session.custodyPortal).toBe(true);
  });
});
