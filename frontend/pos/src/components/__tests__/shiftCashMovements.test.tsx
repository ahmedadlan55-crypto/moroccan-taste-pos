/**
 * ShiftDialog ↔ CashMovementDialog wiring — the cashier's route to recording a
 * drawer movement, and the ± term it puts inside the expected-cash figure.
 *
 * WHY THIS FILE EXISTS SEPARATELY from parity-shift.test.tsx: that file pins
 * the historical legacy-parity behaviour of the close flow. This one pins the
 * NEW surface, so a regression in either is attributable on sight.
 *
 * What matters:
 *   · the movement dialog is reachable FROM the shift screen (no App.tsx flag —
 *     ShiftDialog is already an overlay and opens it as a sibling);
 *   · it is disabled offline, like every other shift server-write;
 *   · the net movement is shown on the shift screen AND on the close screen, so
 *     the cashier can reconcile «المتوقع» line by line instead of watching it
 *     move for no visible reason;
 *   · the close screen's expected figure is the SERVER's — the client never
 *     re-adds the movements on top of a number that already contains them.
 *
 * vitest MODE=test → Arabic dictionary.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShiftDialog } from "../dialogs/ShiftDialog";
import { I18nProvider } from "@/i18n/I18nProvider";
import { ar } from "@/i18n/dictionaries/ar";
import { IDLE_ENGINE_STATUS } from "./parityTestkit";

const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ usePos: () => h.ctx }));

const SHIFT = "SH-4242";

function baseCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { username: "c1", role: "cashier" },
    shiftId: SHIFT,
    shiftLoading: false,
    engineStatus: { ...IDLE_ENGINE_STATUS },
    openShiftNow: vi.fn(),
    openingShift: false,
    onShiftClosed: vi.fn(),
    pushToast: vi.fn(),
    catalog: null,
    ...over,
  };
}

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

const MOVEMENTS = {
  success: true,
  shiftId: SHIFT,
  movements: [
    {
      id: "REC-1", kind: "pay_in", number: "REC-00001", amount: 150, reason: "تعزيز عهدة الدرج",
      note: "", createdBy: "c1", approvedBy: "m1", approvedAt: null, journalId: "J1", date: null,
    },
    {
      id: "PAY-1", kind: "pay_out", number: "PAY-00001", amount: 90, reason: "إيداع في الخزنة",
      note: "", createdBy: "c1", approvedBy: "m1", approvedAt: null, journalId: "J2", date: null,
    },
  ],
  totals: { payIn: 150, payOut: 90, net: 60, count: 2 },
};

/** closing-data-v3 as the SERVER answers it once movements exist: the cash
 *  method's expectedAmount ALREADY contains 200 float + 150 in − 90 out. */
const CLOSING_WITH_MOVEMENTS = {
  methods: [{ id: 1, name: "Cash", nameAr: "كاش", icon: null, color: null, groupType: "cash", expectedAmount: 260 }],
  expected: { "1": 260 },
  expectedTotal: 260,
  orderCount: 0,
  unmatchedTotal: 0,
  openingFloat: 200,
  movements: MOVEMENTS.movements,
  movementTotals: MOVEMENTS.totals,
};

function installFetch(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    [`/api/shifts/${SHIFT}/movements`]: MOVEMENTS,
    [`/api/pos/v2/shift-summary/${SHIFT}`]: { success: true, data: { byStatus: {}, completedByMethod: {} } },
    [`/api/shifts/closing-data-v3/${SHIFT}`]: CLOSING_WITH_MOVEMENTS,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url).split("?")[0];
      if (key in routes) return jsonRes(routes[key]);
      return jsonRes({ success: false, error: "no route " + key }, 404);
    }),
  );
}

function renderShift() {
  return render(
    <I18nProvider>
      <ShiftDialog open onClose={vi.fn()} />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the drawer-movement entry point on the shift screen", () => {
  it("offers the cash-movement button and shows the net so far", async () => {
    h.ctx = baseCtx();
    installFetch();
    renderShift();
    const btn = await screen.findByRole("button", { name: ar.shiftDialog.info.cashMovementButton });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(screen.getByText(ar.shiftDialog.info.cashMovementNetLabel)).toBeTruthy());
    expect(screen.getByText(/\+60\.00/)).toBeTruthy();
  });

  it("is disabled offline — a movement is a server write, never queued", async () => {
    h.ctx = baseCtx({ engineStatus: { ...IDLE_ENGINE_STATUS, online: false } });
    installFetch();
    renderShift();
    const btn = await screen.findByRole("button", { name: ar.shiftDialog.info.cashMovementButton });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens CashMovementDialog for THIS shift", async () => {
    h.ctx = baseCtx();
    installFetch();
    renderShift();
    fireEvent.click(await screen.findByRole("button", { name: ar.shiftDialog.info.cashMovementButton }));
    expect(await screen.findByText(ar.cashMovementDialog.dialogTitle)).toBeTruthy();
    // the dialog loaded the same shift's movements
    expect(await screen.findByTestId("movement-list")).toBeTruthy();
  });
});

describe("the close screen shows the movement adjustment", () => {
  it("lists the ± term next to the opening float, and trusts the server's expected total", async () => {
    h.ctx = baseCtx();
    installFetch();
    renderShift();
    fireEvent.click(await screen.findByRole("button", { name: ar.shiftDialog.info.closeShiftButton }));

    await waitFor(() => expect(screen.getByText(ar.shiftDialog.closing.openingFloatInClosing)).toBeTruthy());
    expect(screen.getByText(ar.shiftDialog.closing.movementsInClosing)).toBeTruthy();
    // in 150 · out 90 — the breakdown behind the net, and the net itself
    expect(screen.getByText(/150\.00/)).toBeTruthy();
    expect(screen.getByText(/90\.00/)).toBeTruthy();
    expect(screen.getByText(/\+60\.00/)).toBeTruthy();

    // The expected column stays HIDDEN until the blind-count reveal (an
    // anti-anchoring rule this feature must not weaken) — tick it, then the
    // server's 260 (= 200 float + 150 − 90) appears verbatim. The client never
    // re-adds the movements on top of a figure that already contains them.
    expect(screen.queryByText("260.00")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getAllByText("260.00").length).toBeGreaterThan(0);
  });
});
