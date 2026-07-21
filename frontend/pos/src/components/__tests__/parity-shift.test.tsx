/**
 * Parity evidence — الوردية (shift) + حركة الصندوق (cash) domains of
 * docs/pos-parity-matrix.md. The store hook is mocked; the api layer runs
 * against a stubbed fetch so the REAL request/response contracts are asserted.
 *
 * Slugs proven here:
 *   shift-badge-indicator, shift-open, shift-open-commit (single-flight UI),
 *   shift-close-start, shift-close-comparison-panel, shift-close-general-notes,
 *   shift-close-confirm, shift-close-cancel, shift-report-modal-fallback,
 *   shift-close-electronic-methods, shift-close-recalc, shift-close-per-method-diff
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Header } from "../Header";
import { ShiftDialog } from "../dialogs/ShiftDialog";
// Header + ShiftDialog both resolve strings via useT()/useLang(), which throw
// without an ancestor I18nProvider (see i18n/I18nProvider.tsx) — every render()
// below needs the wrapper now that both components are i18n-migrated.
import { I18nProvider } from "@/i18n/I18nProvider";

const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ usePos: () => h.ctx }));

function baseCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { username: "c1", role: "cashier" },
    shiftId: "SH-77",
    shiftLoading: false,
    engineStatus: { online: true, syncing: false, queueCount: 0 },
    openShiftNow: vi.fn(),
    openingShift: false,
    onShiftClosed: vi.fn(),
    pushToast: vi.fn(),
    catalogStale: false,
    catalogAgeMs: null,
    refetchCatalog: vi.fn(),
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

const CLOSING = {
  methods: [
    { id: 1, name: "Cash", nameAr: "كاش", icon: null, color: null, groupType: "cash", expectedAmount: 100 },
    { id: 2, name: "Mada", nameAr: "شبكة", icon: null, color: null, groupType: "card", expectedAmount: 50 },
  ],
  expected: { "1": 100, "2": 50 },
  expectedTotal: 150,
  orderCount: 3,
  unmatchedTotal: 0,
};

const CLOSE_RESULT = {
  success: true,
  shiftId: "SH-1",
  variance: -10,
  breakdown: [
    { id: 1, name: "Cash", nameAr: "كاش", groupType: "cash", expected: 100, actual: 90, variance: -10 },
    { id: 2, name: "Mada", nameAr: "شبكة", groupType: "card", expected: 50, actual: 50, variance: 0 },
  ],
};

// A shift opened with a 25 SAR float: the server already folded it into the
// cash method's expectedAmount (125 = 100 sales + 25 float) and surfaces the
// raw float as `openingFloat` for a read-only display row.
const CLOSING_WITH_FLOAT = {
  methods: [
    { id: 1, name: "Cash", nameAr: "كاش", icon: null, color: null, groupType: "cash", expectedAmount: 125 },
    { id: 2, name: "Mada", nameAr: "شبكة", icon: null, color: null, groupType: "card", expectedAmount: 50 },
  ],
  expected: { "1": 125, "2": 50 },
  expectedTotal: 175,
  orderCount: 3,
  unmatchedTotal: 0,
  openingFloat: 25,
};

/** URL-routing fetch stub for the ShiftDialog's three endpoints. */
function stubShiftFetch() {
  const captured: { closeBody: Record<string, unknown> | null } = { closeBody: null };
  const fn = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("/api/pos/v2/shift-summary/")) {
      return jsonRes({ success: true, data: { byStatus: { completed: { count: 3, amount: 150 } }, completedByMethod: { cash: 100, card: 50 } } });
    }
    if (url.includes("/api/shifts/closing-data-v3/")) return jsonRes(CLOSING);
    if (url.includes("/api/shifts/close-v3")) {
      captured.closeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonRes(CLOSE_RESULT);
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return { fn, captured };
}

/** Same as stubShiftFetch but serves a caller-supplied closing-data fixture. */
function stubShiftFetchWith(closing: unknown) {
  const captured: { closeBody: Record<string, unknown> | null } = { closeBody: null };
  const fn = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("/api/pos/v2/shift-summary/")) {
      return jsonRes({ success: true, data: { byStatus: {}, completedByMethod: {} } });
    }
    if (url.includes("/api/shifts/closing-data-v3/")) return jsonRes(closing);
    if (url.includes("/api/shifts/close-v3")) {
      captured.closeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonRes(CLOSE_RESULT);
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return { fn, captured };
}

const HEADER_PROPS = {
  onOpenShiftDialog: vi.fn(),
  onOpenSyncReport: vi.fn(),
  onOpenMyInvoices: vi.fn(),
  onOpenStocktake: vi.fn(),
  onOpenRequisitions: vi.fn(),
};

afterEach(() => vi.unstubAllGlobals());

describe("shift-badge-indicator — شارة حالة الوردية في الترويسة", () => {
  it("an open shift renders the وردية chip with the shift number", () => {
    h.ctx = baseCtx({ shiftId: "SH-77" });
    render(
      <I18nProvider>
        <Header {...HEADER_PROPS} />
      </I18nProvider>,
    );
    const chip = screen.getByRole("button", { name: /وردية 77/ });
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(HEADER_PROPS.onOpenShiftDialog).toHaveBeenCalled();
  });

  it("no shift renders «لا وردية» plus an open-shift button", () => {
    h.ctx = baseCtx({ shiftId: null });
    render(
      <I18nProvider>
        <Header {...HEADER_PROPS} />
      </I18nProvider>,
    );
    expect(screen.getByText("لا وردية")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "فتح وردية" })).toBeInTheDocument();
  });
});

describe("shift-open / shift-open-commit — فتح وردية", () => {
  it("clicking «فتح وردية» in the header opens the ShiftDialog (float screen), never a quick-open", () => {
    // Redirecting the header button through the ShiftDialog is the anti-bypass:
    // a cashier must not be able to open a shift without the opening-float
    // screen, so the header must NOT call openShiftNow directly.
    const onOpenShiftDialog = vi.fn();
    const openShiftNow = vi.fn();
    h.ctx = baseCtx({ shiftId: null, openShiftNow });
    render(
      <I18nProvider>
        <Header {...HEADER_PROPS} onOpenShiftDialog={onOpenShiftDialog} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "فتح وردية" }));
    expect(onOpenShiftDialog).toHaveBeenCalledTimes(1);
    expect(openShiftNow).not.toHaveBeenCalled();
  });

  it("offline: the header فتح وردية button is disabled (open requires the server)", () => {
    h.ctx = baseCtx({ shiftId: null, engineStatus: { online: false, syncing: false, queueCount: 0 } });
    render(
      <I18nProvider>
        <Header {...HEADER_PROPS} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "فتح وردية" })).toBeDisabled();
  });

  it("ShiftDialog with no shift offers فتح وردية and blocks it offline", () => {
    h.ctx = baseCtx({ shiftId: null, engineStatus: { online: false, syncing: false, queueCount: 0 } });
    stubShiftFetch();
    render(
      <I18nProvider>
        <ShiftDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText("لا توجد وردية مفتوحة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "فتح وردية" })).toBeDisabled();
  });
});

describe("إغلاق الوردية — التدفّق الكامل (close-start → count → variance → confirm → report)", () => {
  it("runs the whole V3 close flow against the real request contracts", async () => {
    const onShiftClosed = vi.fn();
    const pushToast = vi.fn();
    h.ctx = baseCtx({ shiftId: "SH-1", onShiftClosed, pushToast });
    const { captured } = stubShiftFetch();
    render(
      <I18nProvider>
        <ShiftDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );

    // shift-close-start: the close button loads closing-data-v3 and shows the counting table
    fireEvent.click(await screen.findByRole("button", { name: "إغلاق الوردية" }));
    const cashInput = await screen.findByLabelText("المعدود — كاش");
    const madaInput = screen.getByLabelText("المعدود — شبكة");

    // shift-close-electronic-methods: one counted input per method (cash + electronic alike)
    expect(cashInput).toBeInTheDocument();
    expect(madaInput).toBeInTheDocument();

    // BLIND COUNT (close/b2-pos-daily): typing counted amounts must NOT show
    // expected/variance — they stay hidden until the cashier ticks «أنهيت العدّ»
    fireEvent.change(cashInput, { target: { value: "90" } });
    fireEvent.change(madaInput, { target: { value: "50" } });
    expect(screen.queryByText("-10.00")).not.toBeInTheDocument();
    expect(screen.queryByText("المتوقع")).not.toBeInTheDocument();

    // shift-close-recalc + shift-close-per-method-diff + shift-close-comparison-panel:
    // the reveal gate shows the live variance comparison
    fireEvent.click(screen.getByRole("checkbox"));
    // كاش row variance −10.00 AND the totals row −10.00
    expect(screen.getAllByText("-10.00").length).toBeGreaterThanOrEqual(2);
    // totals: counted 140.00 vs expected 150.00
    expect(screen.getByText("140.00")).toBeInTheDocument();

    // variance ≠ 0 ⇒ the close button stays LOCKED (its label becomes the
    // closeGate reason) until a ≥10-char explanation is typed
    expect(screen.getByRole("button", { name: /اشرح سبب الفرق/ })).toBeDisabled();

    // shift-close-general-notes: free-text notes ride in the close payload
    fireEvent.change(screen.getByLabelText(/ملاحظات الإغلاق/), { target: { value: "عجز عشرة ريالات — عدّ مسائي" } });

    // shift-close-confirm: POST /api/shifts/close-v3 with paymentTotals keyed by method id
    fireEvent.click(screen.getByRole("button", { name: "تأكيد إغلاق الوردية" }));
    await screen.findByText("أُغلقت الوردية");
    expect(captured.closeBody).toMatchObject({
      shiftId: "SH-1",
      openingFloat: 0,
      denominations: [],
      paymentTotals: { "1": 90, "2": 50 },
      notes: "عجز عشرة ريالات — عدّ مسائي",
    });

    // shift-report-modal-fallback: the close report renders inline — ALWAYS,
    // not only when thermal printing throws like the legacy fallback
    const report = screen.getByText("أُغلقت الوردية").closest("div") as HTMLElement;
    expect(within(report).getByText("كاش")).toBeInTheDocument();
    expect(within(report).getByText("90.00")).toBeInTheDocument();
    expect(onShiftClosed).toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith("success", expect.stringContaining("أُغلقت الوردية"));
  });

  it("shift-close-cancel — «رجوع» abandons the count and returns to the shift info", async () => {
    h.ctx = baseCtx({ shiftId: "SH-1" });
    stubShiftFetch();
    render(
      <I18nProvider>
        <ShiftDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "إغلاق الوردية" }));
    await screen.findByLabelText("المعدود — كاش");
    fireEvent.click(screen.getByRole("button", { name: "رجوع" }));
    expect(await screen.findByRole("button", { name: "إغلاق الوردية" })).toBeInTheDocument();
    expect(screen.queryByLabelText("المعدود — كاش")).not.toBeInTheDocument();
  });
});

describe("الرصيد الافتتاحي — opening float in the close flow", () => {
  it("renders the stored float READ-ONLY (no input) and still rides in the close payload", async () => {
    h.ctx = baseCtx({ shiftId: "SH-9" });
    const { captured } = stubShiftFetchWith(CLOSING_WITH_FLOAT);
    render(
      <I18nProvider>
        <ShiftDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "إغلاق الوردية" }));
    const cashInput = await screen.findByLabelText("المعدود — كاش");
    const madaInput = screen.getByLabelText("المعدود — شبكة");

    // The float shows as a plain read-only row — never an editable input the
    // cashier could tamper with (the server ignores client float values anyway).
    expect(screen.getByText("الرصيد الافتتاحي (ضمن المتوقع نقدًا)")).toBeInTheDocument();
    expect(screen.getByText("25.00 ر.س")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("25")).toBeNull();
    expect(screen.queryByDisplayValue("25.00")).toBeNull();

    // Count exactly the expected (cash 125 = 100 sales + 25 float, mada 50) →
    // zero variance → close unlocks with no note.
    fireEvent.change(cashInput, { target: { value: "125" } });
    fireEvent.change(madaInput, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "تأكيد إغلاق الوردية" }));
    await screen.findByText("أُغلقت الوردية");

    // The close payload echoes the stored float for request-shape parity even
    // though the server recomputes it authoritatively from the DB.
    expect(captured.closeBody).toMatchObject({
      shiftId: "SH-9",
      openingFloat: 25,
      paymentTotals: { "1": 125, "2": 50 },
    });
  });
});

describe("header-logout — تسجيل الخروج مستقل عن حالة الوردية", () => {
  it("logout button lives in the «more» menu and fires onLogout directly, even with an open shift", () => {
    const onLogout = vi.fn();
    const onSwitchCashier = vi.fn();
    h.ctx = baseCtx({ shiftId: "SH-42" });
    render(
      <I18nProvider>
        <Header {...HEADER_PROPS} onSwitchCashier={onSwitchCashier} onLogout={onLogout} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الخروج" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    // Logging out is not the same action as switching cashier — the shift-close
    // guard that onSwitchCashier routes through must never fire for logout.
    expect(onSwitchCashier).not.toHaveBeenCalled();
  });

  it("logout button renders with no shift open too, and is absent entirely without an onLogout handler", () => {
    h.ctx = baseCtx({ shiftId: null });
    const { rerender } = render(
      <I18nProvider>
        <Header {...HEADER_PROPS} onLogout={vi.fn()} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getByRole("button", { name: "تسجيل الخروج" })).toBeInTheDocument();

    rerender(
      <I18nProvider>
        <Header {...HEADER_PROPS} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "تسجيل الخروج" })).toBeNull();
  });
});
