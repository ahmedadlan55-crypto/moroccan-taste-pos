import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { RequisitionsDialog, extractRejectionReason, splitDualQty } from "../dialogs/RequisitionsDialog";
// RequisitionsDialog resolves strings via useT(), which throws without an
// ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";
import { IDLE_ENGINE_STATUS } from "./parityTestkit";

// ── usePos mock ───────────────────────────────────────────────────────────────
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
  { id: "INV-1", name: "أرز بسمتي", category: "مواد جافة", kind: "raw", cost: 10, stock: 37, minStock: 5, unit: "كيلو", bigUnit: "كيس", convRate: 12, active: 1 },
  { id: "INV-2", name: "زيت زيتون", category: "زيوت", kind: "raw", cost: 20, stock: 4, minStock: 5, unit: "لتر", bigUnit: "", convRate: 1, active: 1 },
];

const HISTORY = [
  { id: "SHR-1", requestNumber: "SHR-00001", requestDate: "2026-07-01T10:00:00Z", username: "cashier1", notes: "", status: "pending", totalItems: 2, poId: null },
  // ANOTHER cashier's request — must NOT appear (legacy filters client-side, app.js:4536)
  { id: "SHR-2", requestNumber: "SHR-00002", requestDate: "2026-07-02T10:00:00Z", username: "other-user", notes: "", status: "pending", totalItems: 1, poId: null },
  { id: "SHR-3", requestNumber: "SHR-00003", requestDate: "2026-06-20T10:00:00Z", username: "cashier1", notes: "طلب توابل\n[رفض: نفدت الميزانية]", status: "rejected", totalItems: 1, poId: null },
  { id: "SHR-4", requestNumber: "SHR-00004", requestDate: "2026-06-25T10:00:00Z", username: "cashier1", notes: "", status: "converted", totalItems: 1, poId: "PO-9" },
];

const SHR4_DETAIL = {
  id: "SHR-4",
  requestNumber: "SHR-00004",
  requestDate: "2026-06-25T10:00:00Z",
  username: "cashier1",
  notes: "",
  status: "converted",
  totalItems: 1,
  poId: "PO-9",
  items: [{ id: "SHRI-1", invItemId: "INV-1", invItemName: "أرز بسمتي", unit: "كيلو", currentQty: 37, minQty: 5, requestedQty: 24, unitPrice: 10 }],
};

const PURCHASES = [
  { id: "PUR-77", poId: "PO-9", supplierName: "مورد الرياض", items: [{ id: "INV-1", name: "أرز بسمتي", unit: "كيلو", qty: 24, unitPrice: 10 }] },
];

type FetchCall = { url: string; init?: RequestInit };

function installFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const routes: Record<string, (init?: RequestInit) => unknown> = {
    "GET /api/inventory/items": () => ITEMS,
    "GET /api/inventory/shortage-requests": () => HISTORY,
    "GET /api/inventory/shortage-requests/SHR-4": () => SHR4_DETAIL,
    "GET /api/purchases": () => PURCHASES,
    "POST /api/inventory/shortage-requests": () => ({ success: true, id: "SHR-9", requestNumber: "SHR-00009" }),
    "POST /api/inventory/receive-request": () => ({ success: true }),
    "DELETE /api/inventory/shortage-requests/SHR-1": () => ({ success: true }),
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

async function openDialog() {
  render(
    <I18nProvider>
      <RequisitionsDialog open onClose={vi.fn()} />
    </I18nProvider>,
  );
  const search = await screen.findByLabelText("البحث عن مادة");
  await waitFor(() => expect(search).not.toBeDisabled());
  return search;
}

beforeEach(() => {
  localStorage.clear();
  mocks.online.value = true;
  mocks.pushToast.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

// ── Pure helpers ──────────────────────────────────────────────────────────────
describe("splitDualQty (edit-mode reverse conversion, app.js:4594)", () => {
  it("splits a total back into big + small (27 @ rate 12 → 2 كيس + 3)", () => {
    expect(splitDualQty(27, 12, true)).toEqual({ big: 2, small: 3 });
  });
  it("exact cartons hide the zero small input (24 @ 12 → 2 + '')", () => {
    expect(splitDualQty(24, 12, true)).toEqual({ big: 2, small: "" });
  });
  it("no big unit → everything in small", () => {
    expect(splitDualQty(7, 1, false)).toEqual({ big: "", small: 7 });
  });
});

describe("extractRejectionReason", () => {
  it("extracts the bracketed reason from the notes", () => {
    expect(extractRejectionReason("abc\n[رفض: نفدت الميزانية]")).toBe("نفدت الميزانية");
  });
  it("falls back to the raw notes when no bracket marker exists", () => {
    expect(extractRejectionReason("سبب حر")).toBe("سبب حر");
  });
});

// ── Dialog behavior ───────────────────────────────────────────────────────────
describe("RequisitionsDialog — طلب نواقص", () => {
  it("dual-unit qty (1×12+5=17) flows into POST /api/inventory/shortage-requests", async () => {
    const calls = installFetch();
    const search = await openDialog();

    fireEvent.change(search, { target: { value: "أرز" } });
    fireEvent.click(await screen.findByText("أرز بسمتي"));
    fireEvent.change(screen.getByLabelText("الكمية الكبرى — أرز بسمتي"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("الكمية الصغرى — أرز بسمتي"), { target: { value: "5" } });
    fireEvent.click(screen.getByText(/إرسال الطلب/));

    await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith("success", "تم إرسال طلب النواقص: SHR-00009"));

    const post = calls.find((c) => c.url === "/api/inventory/shortage-requests" && (c.init?.method ?? "") === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post!.init?.body));
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      invItemId: "INV-1",
      invItemName: "أرز بسمتي",
      unit: "كيلو",
      currentQty: 37,
      minQty: 5,
      requestedQty: 17, // 1 كيس × 12 + 5
      unitPrice: 10,
    });
    expect(body.username).toBe("cashier1");
    expect(body.warehouseId).toBe(""); // server resolves from the HR profile
    // Draft cart cleared after success.
    expect(localStorage.getItem("pos_shortage_cart")).toBeNull();
  });

  it("lines with qty 0 are excluded and submit stays disabled until a qty exists", async () => {
    installFetch();
    const search = await openDialog();
    fireEvent.change(search, { target: { value: "زيت" } });
    fireEvent.click(await screen.findByText("زيت زيتون"));
    // No qty entered yet → the submit button is disabled.
    const submitBtn = screen.getByText(/إرسال الطلب/).closest("button")!;
    expect(submitBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("الكمية الصغرى — زيت زيتون"), { target: { value: "3" } });
    expect(submitBtn).not.toBeDisabled();
  });

  it("picking a search result keeps it visible+toggleable in the list (not removed); a second click un-picks it", async () => {
    installFetch();
    const search = await openDialog();
    fireEvent.change(search, { target: { value: "أرز" } });
    const listbox = await screen.findByRole("listbox");
    const row = within(listbox).getByText("أرز بسمتي").closest("button")!;
    expect(row).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(row);

    // Added to the cart table…
    expect(screen.getByLabelText("الكمية الصغرى — أرز بسمتي")).toBeInTheDocument();
    // …search text is NOT reset, and the row stays in the results, now checked.
    expect(search).toHaveValue("أرز");
    expect(within(listbox).getByText("أرز بسمتي")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "true");

    // Clicking the same row again removes it (toggle-off), mirroring ComboDialog.
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("الكمية الصغرى — أرز بسمتي")).toBeNull();
  });

  it("notes are cleared after closing without submitting, then reopening", async () => {
    installFetch();
    const onClose = vi.fn();
    const { rerender } = render(
      <I18nProvider>
        <RequisitionsDialog open onClose={onClose} />
      </I18nProvider>,
    );
    const search = await screen.findByLabelText("البحث عن مادة");
    await waitFor(() => expect(search).not.toBeDisabled());

    const notesInput = screen.getByLabelText("ملاحظات الطلب") as HTMLInputElement;
    fireEvent.change(notesInput, { target: { value: "ملاحظة مؤقتة" } });
    expect(notesInput.value).toBe("ملاحظة مؤقتة");

    // Close WITHOUT submitting.
    rerender(
      <I18nProvider>
        <RequisitionsDialog open={false} onClose={onClose} />
      </I18nProvider>,
    );
    // Reopen.
    rerender(
      <I18nProvider>
        <RequisitionsDialog open onClose={onClose} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("البحث عن مادة")).not.toBeDisabled());
    expect((screen.getByLabelText("ملاحظات الطلب") as HTMLInputElement).value).toBe("");
  });
});

describe("RequisitionsDialog — طلباتي والاستلام", () => {
  it("lists ONLY my requests with status pills and the rejection reason", async () => {
    installFetch();
    await openDialog();
    fireEvent.click(screen.getByText("طلباتي والاستلام"));

    expect(await screen.findByText("SHR-00001")).toBeInTheDocument();
    expect(screen.getByText("SHR-00003")).toBeInTheDocument();
    expect(screen.getByText("SHR-00004")).toBeInTheDocument();
    // Another cashier's request never renders (client-side filter, legacy parity).
    expect(screen.queryByText("SHR-00002")).toBeNull();
    // 7-status pill labels.
    expect(screen.getByText("بانتظار")).toBeInTheDocument();
    expect(screen.getByText("مرفوض")).toBeInTheDocument();
    expect(screen.getByText("تم التحويل لـ PO")).toBeInTheDocument();
    // Rejection reason extracted from [رفض: …].
    expect(screen.getByText(/نفدت الميزانية/)).toBeInTheDocument();
    // Pending row exposes edit + delete; converted row exposes receive.
    expect(screen.getByText("تعديل")).toBeInTheDocument();
    expect(screen.getByText("استلام المواد")).toBeInTheDocument();
  });

  it("receive flow posts confirmed quantities to /api/inventory/receive-request", async () => {
    const calls = installFetch();
    await openDialog();
    fireEvent.click(screen.getByText("طلباتي والاستلام"));
    fireEvent.click(await screen.findByText("استلام المواد"));

    // Receive table opens with orderedQty prefilled (24) — confirm 20 instead.
    const qtyInput = await screen.findByLabelText("المستلم فعلياً — أرز بسمتي");
    expect((qtyInput as HTMLInputElement).value).toBe("24");
    fireEvent.change(qtyInput, { target: { value: "20" } });
    fireEvent.click(screen.getByText("إرسال طلب الاستلام"));

    await waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith("success", "تم إرسال طلب الاستلام للاعتماد"));

    const post = calls.find((c) => c.url === "/api/inventory/receive-request");
    expect(post).toBeTruthy();
    expect((post!.init?.method ?? "").toUpperCase()).toBe("POST");
    const body = JSON.parse(String(post!.init?.body));
    expect(body.purchaseId).toBe("PUR-77");
    expect(body.username).toBe("cashier1");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      invItemId: "INV-1",
      invItemName: "أرز بسمتي",
      unit: "كيلو",
      orderedQty: 24,
      receivedQty: 20,
      unitPrice: 10,
    });
  });

  it("deleting a pending request asks for confirmation then calls DELETE", async () => {
    const calls = installFetch();
    await openDialog();
    fireEvent.click(screen.getByText("طلباتي والاستلام"));
    await screen.findByText("SHR-00001");

    fireEvent.click(screen.getByLabelText("حذف الطلب SHR-00001"));
    fireEvent.click(await screen.findByText("تأكيد الحذف"));

    await waitFor(() => {
      const del = calls.find((c) => (c.init?.method ?? "") === "DELETE");
      expect(del?.url).toBe("/api/inventory/shortage-requests/SHR-1");
    });
  });

  it("offline: shows «طلب النواقص والاستلام يتطلب اتصالًا» and fetches nothing", () => {
    const calls = installFetch();
    mocks.online.value = false;
    render(
      <I18nProvider>
        <RequisitionsDialog open onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText("طلب النواقص والاستلام يتطلب اتصالًا")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
