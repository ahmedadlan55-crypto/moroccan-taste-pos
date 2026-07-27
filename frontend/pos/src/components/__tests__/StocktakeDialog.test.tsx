import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { StocktakeDialog, dualUnitTotal, normalizeArabic } from "../dialogs/StocktakeDialog";
// StocktakeDialog resolves strings via useT(), which throws without an
// ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";
import { IDLE_ENGINE_STATUS } from "./parityTestkit";

// ── usePos mock (user + online flag + toasts only — the dialog needs no more) ─
const mocks = vi.hoisted(() => ({
  online: { value: true },
  pushToast: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  usePos: () => ({
    user: { username: "cashier1", role: "cashier" },
    engineStatus: { ...IDLE_ENGINE_STATUS, online: mocks.online.value },
    pushToast: mocks.pushToast,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ITEMS = [
  // dual-unit item: 1 كيس = 12 كيلو, system stock 37 (must stay INVISIBLE always)
  { id: "INV-1", name: "أرز بسمتي", category: "مواد جافة", kind: "raw", cost: 10, stock: 37, minStock: 5, unit: "كيلو", bigUnit: "كيس", convRate: 12, active: 1 },
  // single-unit item (no big unit)
  { id: "INV-2", name: "زيت زيتون", category: "زيوت", kind: "raw", cost: 20, stock: 4, minStock: 5, unit: "لتر", bigUnit: "", convRate: 1, active: 1 },
];

const ST_ID = "STK-abc123";
const ST_NUMBER = "STK-0007";

/** base64url of a UTF-8 string (matches api.ts decodeTokenPayload). */
function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A fake pos_token whose payload carries the given claims (signature ignored). */
function setToken(payload: Record<string, unknown>) {
  localStorage.setItem("pos_token", `h.${b64url(JSON.stringify(payload))}.s`);
}

type FetchCall = { url: string; init?: RequestInit };
type Handler = (init?: RequestInit) => unknown;

/** A handler may return a plain body (→ 200) or { __status, __body } to control
 *  the HTTP status (for the 422 / error paths). */
function httpError(status: number, body: unknown) {
  return { __status: status, __body: body };
}

function installFetch(overrides: Record<string, Handler> = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const routes: Record<string, Handler> = {
    "GET /api/inventory/items": () => ITEMS,
    "POST /api/inventory/v2/stocktakes": () => ({
      success: true,
      id: ST_ID,
      number: ST_NUMBER,
      data: { id: ST_ID },
      documentNumber: ST_NUMBER,
      status: "draft",
      version: 1,
    }),
    [`POST /api/inventory/v2/stocktakes/${ST_ID}/start`]: () => ({
      success: true,
      data: { id: ST_ID, lines: 1 },
      documentNumber: ST_NUMBER,
      status: "counting",
      version: 2,
    }),
    [`PUT /api/inventory/v2/stocktakes/${ST_ID}/counts`]: () => ({
      success: true,
      data: { id: ST_ID },
      status: "counting",
      applied: 1,
      conflicts: [],
    }),
    [`POST /api/inventory/v2/stocktakes/${ST_ID}/submit`]: () => ({
      success: true,
      data: { id: ST_ID },
      documentNumber: ST_NUMBER,
      status: "submitted",
      version: 3,
    }),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).split("?")[0]}`;
      const handler = routes[key];
      if (!handler) throw new Error(`unmocked route: ${key}`);
      const out = handler(init) as { __status?: number; __body?: unknown };
      const status = out && out.__status ? out.__status : 200;
      const body = out && out.__status ? out.__body : out;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
      };
    }) as unknown as typeof fetch,
  );
  return calls;
}

async function addRiceToCart() {
  render(
    <I18nProvider>
      <StocktakeDialog open onClose={vi.fn()} />
    </I18nProvider>,
  );
  const search = await screen.findByLabelText("البحث عن مادة");
  await waitFor(() => expect(search).not.toBeDisabled()); // items loaded
  fireEvent.change(search, { target: { value: "أرز" } });
  fireEvent.click(await screen.findByText("أرز بسمتي"));
}

function keyOf(c: FetchCall): string {
  return `${(c.init?.method ?? "GET").toUpperCase()} ${String(c.url).split("?")[0]}`;
}

beforeEach(() => {
  localStorage.clear();
  mocks.online.value = true;
  mocks.pushToast.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

// ── Pure dual-unit math (port of legacy updateCstDual, app.js:3817) ──────────
describe("dualUnitTotal", () => {
  it("total = big×convRate + small for dual-unit items", () => {
    expect(dualUnitTotal(2, 3, 12, true)).toBe(27);
    expect(dualUnitTotal(2, "", 12, true)).toBe(24); // big only
    expect(dualUnitTotal("", 5, 12, true)).toBe(5); // small only
  });
  it("ignores the big input when the item has no big unit", () => {
    expect(dualUnitTotal(2, 7, 1, false)).toBe(7);
  });
  it('both inputs empty ⇒ "" (not counted — excluded from the payload)', () => {
    expect(dualUnitTotal("", "", 12, true)).toBe("");
  });
});

describe("normalizeArabic (fuzzy search parity)", () => {
  it("matches alif/ta-marbuta/ya variants symmetrically", () => {
    expect(normalizeArabic("أرز")).toBe(normalizeArabic("ارز"));
    expect(normalizeArabic("طماطة")).toBe(normalizeArabic("طماطه"));
    expect(normalizeArabic("شاى")).toBe(normalizeArabic("شاي"));
  });
});

// ── Dialog behavior ───────────────────────────────────────────────────────────
describe("StocktakeDialog", () => {
  it("BLIND COUNT: system qty and variance stay hidden after adding an item", async () => {
    installFetch();
    await addRiceToCart();

    // The النظام + الفرق cells render a dash — never the number.
    expect(screen.getByTestId("cst-sys-INV-1")).toHaveTextContent("—");
    expect(screen.getByTestId("cst-diff-INV-1")).toHaveTextContent("—");
    // The system stock (37) appears NOWHERE in the dialog.
    expect(screen.queryByText(/37/)).toBeNull();
  });

  it("dual-unit entry converts big+small into the base-unit actual qty (2×12+3=27)", async () => {
    installFetch();
    await addRiceToCart();

    fireEvent.change(screen.getByLabelText("الكمية الكبيرة — أرز بسمتي"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "3" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));

    // Review step shows the converted total in the base unit — still blind.
    expect(await screen.findByText("27")).toBeInTheDocument();
    expect(screen.queryByText(/37/)).toBeNull();
  });

  it("submit runs the v2 lifecycle (create→start→counts→submit) against the cashier's OWN warehouse", async () => {
    setToken({ username: "cashier1", role: "cashier", default_warehouse_id: "WH-CASHIER" });
    const calls = installFetch();
    await addRiceToCart();

    fireEvent.change(screen.getByLabelText("الكمية الكبيرة — أرز بسمتي"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "3" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));
    fireEvent.click(await screen.findByText("إرسال للاعتماد"));

    // Success view shows the server's document number + the approval-handoff copy.
    expect(await screen.findByText(ST_NUMBER)).toBeInTheDocument();
    await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith("success", "أُرسل محضر الجرد للاعتماد"));

    // The four v2 calls fired, in order.
    const seq = calls.map(keyOf).filter((k) => k.includes("/v2/stocktakes"));
    expect(seq).toEqual([
      "POST /api/inventory/v2/stocktakes",
      `POST /api/inventory/v2/stocktakes/${ST_ID}/start`,
      `PUT /api/inventory/v2/stocktakes/${ST_ID}/counts`,
      `POST /api/inventory/v2/stocktakes/${ST_ID}/submit`,
    ]);

    // create: warehouseId is the cashier's own (NEVER empty), scoped to the counted
    // item, blind + includeZero, and it carries an Idempotency-Key.
    const create = calls.find((c) => keyOf(c) === "POST /api/inventory/v2/stocktakes")!;
    const createBody = JSON.parse(String(create.init?.body));
    expect(createBody.warehouseId).toBe("WH-CASHIER");
    expect(createBody.warehouseId).not.toBe("");
    expect(createBody.scopeType).toBe("items");
    expect(createBody.itemIds).toEqual(["INV-1"]);
    expect(createBody.includeZero).toBe(true);
    expect(createBody.blindCount).toBe(true);
    expect((create.init?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();

    // counts: the pre-summed dual-unit total (2×12+3 = 27) lands as the base qty.
    const countsCall = calls.find((c) => keyOf(c) === `PUT /api/inventory/v2/stocktakes/${ST_ID}/counts`)!;
    const countsBody = JSON.parse(String(countsCall.init?.body));
    expect(countsBody.counts).toEqual([{ itemId: "INV-1", countedQty: 27 }]);

    // start + submit thread the version returned by the previous step.
    const startCall = calls.find((c) => keyOf(c) === `POST /api/inventory/v2/stocktakes/${ST_ID}/start`)!;
    expect(JSON.parse(String(startCall.init?.body)).expectedVersion).toBe(1);
    const submitCall = calls.find((c) => keyOf(c) === `POST /api/inventory/v2/stocktakes/${ST_ID}/submit`)!;
    expect(JSON.parse(String(submitCall.init?.body)).expectedVersion).toBe(2);

    // Draft cart cleared after a successful submit.
    expect(localStorage.getItem("pos_stocktake_cart")).toBeNull();
  });

  it("NEVER sends an empty warehouseId: an unresolvable warehouse surfaces a clear error and creates nothing", async () => {
    setToken({ username: "cashier1", role: "cashier" }); // no default_warehouse_id
    const calls = installFetch({
      // access-scope fallback returns NO single warehouse → unresolvable.
      "GET /api/inventory/access-scope": () => ({ success: true, allWarehousesAccess: false, accessibleWarehouses: [] }),
    });
    await addRiceToCart();
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "5" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));
    fireEvent.click(await screen.findByText("إرسال للاعتماد"));

    await waitFor(() =>
      expect(mocks.pushToast).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("تعذّر تحديد مستودع الكاشير"),
      ),
    );
    // No stocktake was created — the guard fired before any write.
    expect(calls.some((c) => keyOf(c) === "POST /api/inventory/v2/stocktakes")).toBe(false);
  });

  it("surfaces a 422 missing-warehouse server error verbatim (no silent failure)", async () => {
    setToken({ username: "cashier1", role: "cashier", default_warehouse_id: "WH-CASHIER" });
    installFetch({
      "POST /api/inventory/v2/stocktakes": () =>
        httpError(422, { success: false, code: "VALIDATION_ERROR", error: "المستودع مطلوب" }),
    });
    await addRiceToCart();
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "5" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));
    fireEvent.click(await screen.findByText("إرسال للاعتماد"));
    await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith("error", "المستودع مطلوب"));
  });

  it("offline: shows «الجرد يتطلب اتصالًا» and fetches nothing", () => {
    const calls = installFetch();
    mocks.online.value = false;
    render(
      <I18nProvider>
        <StocktakeDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText("الجرد يتطلب اتصالًا")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("keeps the draft cart across close/reopen (localStorage pos_stocktake_cart)", async () => {
    installFetch();
    await addRiceToCart();
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "5" } });
    const stored = JSON.parse(localStorage.getItem("pos_stocktake_cart") || "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "INV-1", actualQty: 5 });
  });

  it("picking a search result keeps it visible+toggleable in the list (not removed); a second click un-picks it", async () => {
    installFetch();
    render(
      <I18nProvider>
        <StocktakeDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );
    const search = await screen.findByLabelText("البحث عن مادة");
    await waitFor(() => expect(search).not.toBeDisabled());
    fireEvent.change(search, { target: { value: "أرز" } });

    const listbox = await screen.findByRole("listbox");
    const row = within(listbox).getByText("أرز بسمتي").closest("button")!;
    expect(row).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(row);

    // Added to the cart table…
    expect(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي")).toBeInTheDocument();
    // …search text is NOT reset, and the row stays in the results, now checked.
    expect(search).toHaveValue("أرز");
    expect(within(listbox).getByText("أرز بسمتي")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "true");

    // Clicking the same row again removes it (toggle-off), mirroring ComboDialog.
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("الكمية الصغيرة — أرز بسمتي")).toBeNull();
  });

  it("notes are cleared after closing without submitting, then reopening", async () => {
    installFetch();
    const onClose = vi.fn();
    const { rerender } = render(
      <I18nProvider>
        <StocktakeDialog open onClose={onClose} />
      </I18nProvider>,
    );
    const search = await screen.findByLabelText("البحث عن مادة");
    await waitFor(() => expect(search).not.toBeDisabled());

    const notesInput = screen.getByLabelText("ملاحظات الجرد") as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "ملاحظة مؤقتة" } });
    expect(notesInput.value).toBe("ملاحظة مؤقتة");

    // Close WITHOUT submitting.
    rerender(
      <I18nProvider>
        <StocktakeDialog open={false} onClose={onClose} />
      </I18nProvider>,
    );
    // Reopen.
    rerender(
      <I18nProvider>
        <StocktakeDialog open onClose={onClose} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("البحث عن مادة")).not.toBeDisabled());
    expect((screen.getByLabelText("ملاحظات الجرد") as HTMLInputElement).value).toBe("");
  });
});
