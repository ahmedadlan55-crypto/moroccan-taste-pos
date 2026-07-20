/**
 * PosLogin — the POS's dedicated sign-in screen.
 *
 * Covers the mandatory-password-change gap this test was written to catch:
 * PosLogin stored the token and reloaded straight into the shell regardless
 * of `mustChangePassword`, while the ERP's own Login.tsx already redirected
 * to the shared /app/change-password screen. A cashier created with a
 * forced-change temp password could sign in through THIS screen and never
 * be prompted — the fix must redirect here too, before ever reloading into
 * the POS shell.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PosLogin } from "../PosLogin";
import { TOKEN_KEY } from "@/lib/auth";
// PosLogin now resolves strings via useT()/useLang()/useSetLang() (login-
// screen language toggle), which throw without an ancestor I18nProvider —
// see i18n/I18nProvider.tsx.
import { I18nProvider } from "@/i18n/I18nProvider";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

const assignMock = vi.fn();
const reloadMock = vi.fn();

beforeEach(() => {
  cleanup();
  localStorage.clear();
  assignMock.mockClear();
  reloadMock.mockClear();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: assignMock, reload: reloadMock },
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fillAndSubmit(username: string, password: string) {
  fireEvent.change(screen.getByLabelText("اسم المستخدم"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /تسجيل الدخول/ }));
}

describe("PosLogin", () => {
  it("a normal cashier login stores the token and reloads into the POS shell", async () => {
    const token = fakeJwt({ username: "test.cashier", role: "cashier" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, token, role: "cashier" }) }),
    );
    render(
      <I18nProvider>
        <PosLogin />
      </I18nProvider>,
    );
    fillAndSubmit("test.cashier", "RealPassw0rd!");

    await waitFor(() => expect(reloadMock).toHaveBeenCalled());
    expect(localStorage.getItem(TOKEN_KEY)).toBe(token);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("mustChangePassword redirects to the shared change-password screen instead of entering the shell", async () => {
    const token = fakeJwt({ username: "test.cashier", role: "cashier" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ success: true, token, role: "cashier", mustChangePassword: true }),
      }),
    );
    render(
      <I18nProvider>
        <PosLogin />
      </I18nProvider>,
    );
    fillAndSubmit("test.cashier", "TempPassw0rd!");

    await waitFor(() => expect(assignMock).toHaveBeenCalled());
    // The token IS stored first — the change-password screen needs it to
    // make its own authenticated call.
    expect(localStorage.getItem(TOKEN_KEY)).toBe(token);
    expect(assignMock).toHaveBeenCalledWith("/app/change-password?must=1&redirect=%2Fpos%2F");
    // Never reloads straight into the POS shell on a forced-change account.
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("rejects a non-POS role locally and never stores its token", async () => {
    const token = fakeJwt({ username: "acct1", role: "accountant" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, token, role: "accountant" }) }),
    );
    render(
      <I18nProvider>
        <PosLogin />
      </I18nProvider>,
    );
    fillAndSubmit("acct1", "Passw0rd!");

    expect(await screen.findByText(/لا يملك صلاحية الدخول إلى الكاشير/)).toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });
});
