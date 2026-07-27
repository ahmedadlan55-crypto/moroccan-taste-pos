/**
 * CashMovementDialog — till cash movements (حركات نقدية على الدرج).
 *
 * THE GAP UNDER TEST: a cashier could not record cash in or out during a shift
 * from any client, so a drop to the safe / float top-up / petty cash never
 * reached the till and the expected-cash figure at close was wrong by exactly
 * those amounts. The owner's rule is "the cashier records, a manager approves",
 * so what actually matters here is:
 *
 *   · the movement cannot be submitted without an amount AND a reason;
 *   · the approval step is UNSKIPPABLE — the POST only ever leaves this
 *     component carrying approver credentials, and the credentials never
 *     survive in state after the server has answered;
 *   · the amount comes from the SHARED <Numpad> (imported, not forked), so the
 *     money grammar (≤2 decimals, no leading-zero runs) is the same one the
 *     payment screen uses;
 *   · every preset reason resolves in BOTH dictionaries (a preset that renders
 *     its own dotted path is the classic i18n regression here);
 *   · already-approved movements are listed with the approver's name.
 *
 * vitest MODE=test → the I18nProvider default language is Arabic, so the
 * assertions below are against the ar dictionary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CashMovementDialog, movementGate, MOVEMENT_REASON_PRESETS } from "../dialogs/CashMovementDialog";
import { I18nProvider } from "@/i18n/I18nProvider";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";

const SHIFT = "SH-1780000000000";

const EXISTING = [
  {
    id: "REC-1",
    kind: "pay_in" as const,
    number: "REC-00001",
    amount: 150,
    reason: "تعزيز عهدة الدرج",
    note: "",
    createdBy: "cashier1",
    approvedBy: "manager1",
    approvedAt: "2026-07-27T08:00:00Z",
    journalId: "JRN-1",
    date: "2026-07-27",
  },
  {
    id: "PAY-1",
    kind: "pay_out" as const,
    number: "PAY-00001",
    amount: 90,
    reason: "إيداع في الخزنة",
    note: "",
    createdBy: "cashier1",
    approvedBy: "manager1",
    approvedAt: "2026-07-27T09:00:00Z",
    journalId: "JRN-2",
    date: "2026-07-27",
  },
];

type FetchCall = { url: string; init?: RequestInit };

function installFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const routes: Record<string, (init?: RequestInit) => unknown> = {
    [`GET /api/shifts/${SHIFT}/movements`]: () => ({
      success: true,
      shiftId: SHIFT,
      movements: EXISTING,
      totals: { payIn: 150, payOut: 90, net: 60, count: 2 },
    }),
    [`POST /api/shifts/${SHIFT}/movements`]: () => ({
      success: true,
      movement: { ...EXISTING[1], id: "PAY-2", amount: 25 },
      totals: { payIn: 150, payOut: 115, net: 35, count: 3 },
    }),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).split("?")[0]}`;
      const handler = routes[key];
      if (!handler) return { ok: false, status: 404, json: async () => ({ success: false, error: "no route: " + key }) };
      const body = handler(init);
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return calls;
}

function renderDialog(props: Partial<Parameters<typeof CashMovementDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onRecorded = vi.fn();
  const utils = render(
    <I18nProvider>
      <CashMovementDialog open shiftId={SHIFT} online onClose={onClose} onRecorded={onRecorded} {...props} />
    </I18nProvider>,
  );
  return { ...utils, onClose, onRecorded };
}

/** Type an amount on the SHARED Numpad — never by writing state directly, so
 *  the test fails if the pad is ever swapped for a fork or a plain input. */
function padPress(key: string) {
  const pad = screen.getByTestId("numpad");
  fireEvent.click(within(pad).getByText(key));
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("movementGate — the pure submit matrix", () => {
  it("refuses a zero / negative / non-finite amount", () => {
    expect(movementGate("form", 0, "سبب", "", "")).toBe(false);
    expect(movementGate("form", -5, "سبب", "", "")).toBe(false);
    expect(movementGate("form", Number.NaN, "سبب", "", "")).toBe(false);
  });

  it("refuses a missing or too-short reason", () => {
    expect(movementGate("form", 50, "", "", "")).toBe(false);
    expect(movementGate("form", 50, "  ", "", "")).toBe(false);
    expect(movementGate("form", 50, "x", "", "")).toBe(false);
  });

  it("passes step 1 with an amount and a reason", () => {
    expect(movementGate("form", 50, "إيداع في الخزنة", "", "")).toBe(true);
  });

  it("step 2 ALSO requires the approver's username AND password", () => {
    expect(movementGate("approve", 50, "إيداع في الخزنة", "", "")).toBe(false);
    expect(movementGate("approve", 50, "إيداع في الخزنة", "manager1", "")).toBe(false);
    expect(movementGate("approve", 50, "إيداع في الخزنة", "", "pw")).toBe(false);
    expect(movementGate("approve", 50, "إيداع في الخزنة", "manager1", "pw")).toBe(true);
  });
});

describe("preset reasons are real translations, not dotted paths", () => {
  const paths = [...new Set([...MOVEMENT_REASON_PRESETS.pay_in, ...MOVEMENT_REASON_PRESETS.pay_out])];
  const resolve = (dict: unknown, path: string) =>
    path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], dict);

  it.each(paths)("%s resolves in ar and en", (path) => {
    expect(typeof resolve(ar, path)).toBe("string");
    expect(typeof resolve(en, path)).toBe("string");
  });
});

describe("recording a movement", () => {
  it("lists the shift's already-approved movements with their approver", async () => {
    installFetch();
    renderDialog();
    const list = await screen.findByTestId("movement-list");
    expect(within(list).getByText("تعزيز عهدة الدرج")).toBeTruthy();
    expect(within(list).getByText("إيداع في الخزنة")).toBeTruthy();
    // the approver, not the cashier
    expect(within(list).getAllByText(/manager1/).length).toBe(2);
    expect(within(list).queryByText(/cashier1/)).toBeNull();
    // net = payIn − payOut, surfaced for the expected-cash reconciliation
    expect(screen.getByText("+60.00")).toBeTruthy();
  });

  it("cannot continue to approval without an amount and a reason", async () => {
    installFetch();
    renderDialog();
    await screen.findByTestId("movement-list");
    const cont = screen.getByRole("button", { name: ar.cashMovementDialog.form.submitButton });
    expect((cont as HTMLButtonElement).disabled).toBe(true);

    padPress("5");
    padPress("0");
    expect((cont as HTMLButtonElement).disabled).toBe(true); // amount alone is not enough

    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.presets.safeDrop }));
    expect((cont as HTMLButtonElement).disabled).toBe(false);
  });

  it("POSTs only after the approval step, carrying the approver's credentials", async () => {
    const calls = installFetch();
    const { onRecorded } = renderDialog();
    await screen.findByTestId("movement-list");

    padPress("2");
    padPress("5");
    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.presets.safeDrop }));

    // Nothing has been POSTed yet — the approval step is unskippable.
    expect(calls.filter((c) => (c.init?.method ?? "GET") === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.form.submitButton }));

    const confirm = await screen.findByRole("button", { name: ar.cashMovementDialog.approval.confirmButton });
    expect((confirm as HTMLButtonElement).disabled).toBe(true); // no credentials yet

    fireEvent.change(screen.getByLabelText(ar.managerApprovalDialog.fields.usernameLabel), { target: { value: "manager1" } });
    fireEvent.change(screen.getByLabelText(ar.managerApprovalDialog.fields.passwordLabel), { target: { value: "s3cret" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const post = calls.find((c) => (c.init?.method ?? "GET") === "POST");
    expect(post).toBeTruthy();
    expect(post!.url).toBe(`/api/shifts/${SHIFT}/movements`);
    const body = JSON.parse(String(post!.init!.body));
    expect(body).toMatchObject({
      kind: "pay_out",
      amount: 25,
      reason: ar.cashMovementDialog.presets.safeDrop,
      approverUsername: "manager1",
      approverPassword: "s3cret",
    });
    expect(onRecorded).toHaveBeenCalledWith({ payIn: 150, payOut: 115, net: 35, count: 3 });

    // The manager's password must not survive the round-trip.
    await waitFor(() =>
      expect((screen.getByLabelText(ar.cashMovementDialog.form.reasonLabel) as HTMLInputElement).value).toBe(""),
    );
    expect(screen.queryByRole("button", { name: ar.cashMovementDialog.approval.confirmButton })).toBeNull();
  });

  it("switching to cash-in swaps the preset reasons", async () => {
    installFetch();
    renderDialog();
    await screen.findByTestId("movement-list");
    // default is pay_out
    expect(screen.queryByRole("button", { name: ar.cashMovementDialog.presets.floatTopUp })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(ar.cashMovementDialog.kind.payIn) }));
    expect(screen.getByRole("button", { name: ar.cashMovementDialog.presets.floatTopUp })).toBeTruthy();
    expect(screen.queryByRole("button", { name: ar.cashMovementDialog.presets.safeDrop })).toBeNull();
  });

  it("a refused approval keeps the amount and reason and clears only the password", async () => {
    installFetch({
      [`POST /api/shifts/${SHIFT}/movements`]: () => ({
        success: false,
        code: "approval_invalid",
        error: "بيانات اعتماد المدير غير صحيحة · Invalid manager approval credentials",
      }),
    });
    const { onRecorded } = renderDialog();
    await screen.findByTestId("movement-list");

    padPress("4");
    padPress("0");
    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.presets.pettyCash }));
    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.form.submitButton }));
    fireEvent.change(await screen.findByLabelText(ar.managerApprovalDialog.fields.usernameLabel), { target: { value: "manager1" } });
    fireEvent.change(screen.getByLabelText(ar.managerApprovalDialog.fields.passwordLabel), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.approval.confirmButton }));

    // The server's message is shown (translateApiError falls through to it) and
    // the cashier stays on the approval step — nothing to re-type but the pw.
    await waitFor(() => expect(screen.getByText(/بيانات اعتماد المدير غير صحيحة/)).toBeTruthy());
    expect(onRecorded).not.toHaveBeenCalled();
    expect((screen.getByLabelText(ar.managerApprovalDialog.fields.passwordLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(ar.managerApprovalDialog.fields.usernameLabel) as HTMLInputElement).value).toBe("manager1");
  });

  it("offline: the whole flow is blocked (a movement is a server write)", async () => {
    installFetch();
    renderDialog({ online: false });
    expect(screen.getByText(ar.cashMovementDialog.offlineNote)).toBeTruthy();
    const cont = screen.getByRole("button", { name: ar.cashMovementDialog.form.submitButton });
    padPress("5");
    fireEvent.click(screen.getByRole("button", { name: ar.cashMovementDialog.presets.safeDrop }));
    expect((cont as HTMLButtonElement).disabled).toBe(true);
  });
});
