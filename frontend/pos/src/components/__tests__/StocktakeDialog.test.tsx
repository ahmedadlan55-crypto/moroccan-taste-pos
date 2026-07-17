import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StocktakeDialog, dualUnitTotal, normalizeArabic } from "../dialogs/StocktakeDialog";

// ── usePos mock (user + online flag + toasts only — the dialog needs no more) ─
const mocks = vi.hoisted(() => ({
  online: { value: true },
  pushToast: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  usePos: () => ({
    user: { username: "cashier1", role: "cashier" },
    engineStatus: { online: mocks.online.value, syncing: false, queueCount: 0 },
    pushToast: mocks.pushToast,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ITEMS = [
  // dual-unit item: 1 كيس = 12 كيلو, system stock 37 (must stay INVISIBLE pre-submit)
  { id: "INV-1", name: "أرز بسمتي", category: "مواد جافة", kind: "raw", cost: 10, stock: 37, minStock: 5, unit: "كيلو", bigUnit: "كيس", convRate: 12, active: 1 },
  // single-unit item (no big unit)
  { id: "INV-2", name: "زيت زيتون", category: "زيوت", kind: "raw", cost: 20, stock: 4, minStock: 5, unit: "لتر", bigUnit: "", convRate: 1, active: 1 },
];

type FetchCall = { url: string; init?: RequestInit };

function installFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const routes: Record<string, (init?: RequestInit) => unknown> = {
    "GET /api/inventory/items": () => ITEMS,
    "POST /api/inventory/stocktakes": () => ({
      success: true,
      stocktakeId: "ST-1752700000000",
      adjustedCount: 1,
      totalGainCost: 0,
      totalLossCost: 0,
      postingWarning: null,
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
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => handler(init),
      };
    }) as unknown as typeof fetch,
  );
  return calls;
}

async function addRiceToCart() {
  render(<StocktakeDialog open onClose={vi.fn()} />);
  const search = await screen.findByLabelText("البحث عن مادة");
  await waitFor(() => expect(search).not.toBeDisabled()); // items loaded
  fireEvent.change(search, { target: { value: "أرز" } });
  fireEvent.click(await screen.findByText("أرز بسمتي"));
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
    // The system stock (37) appears NOWHERE in the dialog before submit.
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

  it("submit POSTs the legacy payload to /api/inventory/stocktakes and shows the stocktake number", async () => {
    const calls = installFetch();
    await addRiceToCart();

    fireEvent.change(screen.getByLabelText("الكمية الكبيرة — أرز بسمتي"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "3" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));
    fireEvent.click(await screen.findByText("حفظ وإرسال التقرير"));

    // Success view shows the server's stocktake number.
    expect(await screen.findByText("ST-1752700000000")).toBeInTheDocument();

    const post = calls.find((c) => c.url === "/api/inventory/stocktakes");
    expect(post).toBeTruthy();
    expect((post!.init?.method ?? "").toUpperCase()).toBe("POST");
    const body = JSON.parse(String(post!.init?.body));
    expect(body.items).toHaveLength(1);
    // Both legacy naming pairs + diff, computed against the fetched system qty.
    expect(body.items[0]).toMatchObject({
      id: "INV-1",
      unit: "كيلو",
      systemQty: 37,
      actualQty: 27,
      sys: 37,
      actual: 27,
      diff: -10,
    });
    expect(body.username).toBe("cashier1");
    expect(body.notes).toBe("جرد بواسطة cashier1"); // legacy default when notes empty
    expect(body.warehouseId).toBe(""); // server resolves from the user profile
    expect(body.branchId).toBe("");
    // Draft cart is cleared after a successful submit.
    expect(localStorage.getItem("pos_stocktake_cart")).toBeNull();
  });

  it("surfaces the server's error message verbatim on a failed submit", async () => {
    installFetch({
      "POST /api/inventory/stocktakes": () => ({ success: false, error: "تعذّر تحديد المستودع" }),
    });
    await addRiceToCart();
    fireEvent.change(screen.getByLabelText("الكمية الصغيرة — أرز بسمتي"), { target: { value: "5" } });
    fireEvent.click(screen.getByText(/مراجعة وإرسال/));
    fireEvent.click(await screen.findByText("حفظ وإرسال التقرير"));
    await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith("error", "تعذّر تحديد المستودع"));
  });

  it("offline: shows «الجرد يتطلب اتصالًا» and fetches nothing", () => {
    const calls = installFetch();
    mocks.online.value = false;
    render(<StocktakeDialog open onClose={vi.fn()} />);
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
});
