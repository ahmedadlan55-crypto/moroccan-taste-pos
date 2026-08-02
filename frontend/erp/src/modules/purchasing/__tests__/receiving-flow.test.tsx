/**
 * DEFECT 2 — «لماذا لا يمكنني عمل استلام».
 *
 * The goods-receipt backend (POST /api/procurement/receipts) and the
 * `useCreateReceipt()` hook both existed, but NOTHING in the SPA ever called
 * the hook: `/purchasing/receiving` rendered a read-only list, and the PO
 * detail screen showed the receipts a PO already had with no way to make one.
 * The capability was fully built and never wired to a control.
 *
 * These tests drive the REAL pages through the REAL hooks (only the HTTP
 * client is faked, so the assertions are about the request that would reach
 * Express) and pin:
 *   1. an open PO offers «استلام» that routes to the receiving form;
 *   2. the form pre-fills each open line's REMAINING quantity;
 *   3. submitting posts to /procurement/receipts with the PO's line ids and
 *      WITHOUT a warehouseId — the server inherits it from the PO;
 *   4. a server refusal (OVER_RECEIPT) is surfaced verbatim, not swallowed;
 *   5. the receipts list has its own way in (pick an open PO).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useSearchParams } from "react-router-dom";
import { I18nProvider } from "@/i18n";

// ── fake transport ─────────────────────────────────────────────────────────
// One recorded call log; `get` answers by path so the real query hooks and the
// real adapters run unmodified.
const H = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: unknown }>,
  postImpl: null as null | ((path: string, body: unknown) => unknown),
  order: {} as Record<string, unknown>,
  // keyed by the ?status= the list hook asks for, so the picker's three
  // parallel queries answer independently (as the real endpoint does).
  orderRowsByStatus: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(async (path: string, opts?: { params?: Record<string, unknown> }) => {
        if (/\/procurement\/orders\/[^/]+$/.test(path) && !/timeline/.test(path)) return { data: H.order };
        if (/\/procurement\/orders$/.test(path)) {
          const rows = H.orderRowsByStatus[String(opts?.params?.status ?? "")] ?? [];
          return { data: rows, pagination: { page: 1, pageSize: 25, total: rows.length, totalPages: 1 } };
        }
        if (/timeline$/.test(path)) return { data: [] };
        return { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } };
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        H.posts.push({ path, body });
        if (H.postImpl) return H.postImpl(path, body);
        return { success: true, data: { id: "GRN-1" }, documentNumber: "GRN-0001", status: "draft", version: 1 };
      }),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    },
  };
});

// Every neighbouring procurement action is gated by the warehouse permission
// context; grant it so these tests are about wiring, not about RBAC.
vi.mock("@/modules/inventory/lib/permission-provider", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  WarehousePermissionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { apiClient } from "@/shared/api";
import { OrderDetailPage } from "@/modules/purchasing/features/procurement/DetailPages";
import { ReceiptsListPage } from "@/modules/purchasing/features/procurement/ProcurementPages";
import { ReceiveCreatePage, ReceivePickerPage } from "@/modules/purchasing/features/procurement/ReceivePages";

const PO_ID = "PO-TEST-1";
const LINE_ID = "POL-TEST-1";

function approvedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: PO_ID, po_number: "PO-0001", supplier_id: "SUP-1", supplier_name: "مورد اختبار",
    po_date: "2026-08-01", status: "approved", version: 2, warehouse_id: "WH-MAIN",
    total_before_vat: 1000, vat_amount: 150, total_after_vat: 1150, currency: "SAR",
    lines: [{
      id: LINE_ID, item_id: "ITEM-1", item_name: "مادة اختبار",
      entered_qty: 10, entered_unit_code: "كرتون", conversion_factor_snapshot: 12,
      base_qty: 120, base_received_qty: 36, unit_price_entered: 120, unit_price: 10, total: 1200,
    }],
    receipts: [], invoices: [],
    ...overrides,
  };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/purchasing/orders" element={<OrderDetailPage />} />
            <Route path="/purchasing/receiving" element={<ReceivingRoute />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}
/** How many GETs the fake transport has served — proves a refetch really ran. */
function apiGetCalls(): number {
  return (apiClient.get as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}
// Mirrors the switch in modules/purchasing/index.tsx for the receiving leaf.
function ReceivingRoute() {
  const [sp] = useSearchParams();
  if (sp.get("po")) return <ReceiveCreatePage />;
  if (sp.get("new") === "1") return <ReceivePickerPage />;
  return <ReceiptsListPage />;
}

beforeEach(() => {
  H.posts.length = 0;
  H.postImpl = null;
  H.order = approvedOrder();
  H.orderRowsByStatus = {
    approved: [{ id: PO_ID, po_number: "PO-0001", supplier_name: "مورد اختبار", po_date: "2026-08-01", status: "approved", version: 2, total_after_vat: 1150 }],
    sent: [],
    partially_received: [],
  };
});

describe("goods receiving is reachable from the UI", () => {
  it("an approved PO offers «استلام» pointing at the receiving form", async () => {
    renderAt(`/purchasing/orders?doc=${PO_ID}`);
    const link = await screen.findByRole("link", { name: /استلام/ });
    expect(link).toHaveAttribute("href", expect.stringContaining(`/purchasing/receiving?po=${PO_ID}`));
  });

  it("hides «استلام» once the PO is fully received", async () => {
    H.order = approvedOrder({ status: "fully_received" });
    renderAt(`/purchasing/orders?doc=${PO_ID}`);
    await screen.findAllByText("PO-0001");
    expect(screen.queryByRole("link", { name: /استلام/ })).toBeNull();
  });

  it("the receipts list offers a way in (pick an open PO)", async () => {
    renderAt("/purchasing/receiving");
    const link = await screen.findByRole("link", { name: /استلام/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/purchasing/receiving?new=1"));
  });

  it("the picker lists open POs and links each to its receiving form", async () => {
    renderAt("/purchasing/receiving?new=1");
    const link = await screen.findByRole("link", { name: "PO-0001" });
    expect(link).toHaveAttribute("href", expect.stringContaining(`/purchasing/receiving?po=${PO_ID}`));
  });
});

describe("the receiving form", () => {
  it("defaults each open line to its REMAINING quantity, in the PO's unit", async () => {
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    // ordered 120 base, received 36 base → remaining 84 base = 7 cartons (÷12)
    const qty = (await screen.findByLabelText(/الكمية المستلمة/)) as HTMLInputElement;
    expect(Number(qty.value)).toBe(7);
    // and the base-unit arithmetic is shown, not just implied
    expect(screen.getByText(/المتبقي\s*84/)).toBeInTheDocument();
  });

  it("posts poId + poLineId and NO warehouseId — the server inherits the PO's", async () => {
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    await screen.findByLabelText(/الكمية المستلمة/);
    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    const { path, body } = H.posts[0];
    expect(path).toBe("/procurement/receipts");
    const b = body as Record<string, unknown>;
    expect(b.poId).toBe(PO_ID);
    expect("warehouseId" in b).toBe(false);
    const lines = b.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0].poLineId).toBe(LINE_ID);
    expect(lines[0].enteredQty).toBe(7);
    expect(lines[0].factor).toBe(12);
    expect(lines[0].unitCost).toBe(120);
  });

  it("sends an explicit warehouseId when the PO carries none", async () => {
    H.order = approvedOrder({ warehouse_id: null });
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    const wh = await screen.findByLabelText(/المستودع/);
    fireEvent.change(wh, { target: { value: "WH-PICKED" } });
    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    expect((H.posts[0].body as Record<string, unknown>).warehouseId).toBe("WH-PICKED");
  });

  it("surfaces a server refusal (OVER_RECEIPT) instead of swallowing it", async () => {
    H.postImpl = () => {
      throw Object.assign(new Error("الكمية المستلمة (200) تتجاوز المتبقي من أمر الشراء (84)"), { code: "OVER_RECEIPT", status: 422 });
    };
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    await screen.findByLabelText(/الكمية المستلمة/);
    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    expect(await screen.findByText(/تتجاوز المتبقي من أمر الشراء/)).toBeInTheDocument();
  });

  it("keeps typed quantities across a background refetch of the PO", async () => {
    // The form seeds itself from the PO. If it re-seeded whenever fresh server
    // data arrived, a background refetch — window focus, an invalidation from a
    // sibling mutation, a colleague posting another receipt — would silently
    // replace what the user typed with the full remainder and receive more than
    // they meant to. That is a money bug, so pin it.
    //
    // The refetch must return CHANGED data to test anything: TanStack Query's
    // structural sharing keeps the previous object reference when the payload
    // is deep-equal, so an identical refetch never re-renders and would let a
    // re-seeding form pass.
    const { qc } = renderAt(`/purchasing/receiving?po=${PO_ID}`);
    const qty = (await screen.findByLabelText(/الكمية المستلمة/)) as HTMLInputElement;
    fireEvent.change(qty, { target: { value: "2" } });
    expect(Number(qty.value)).toBe(2);

    const before = apiGetCalls();
    H.order = approvedOrder({
      lines: [{ ...(approvedOrder().lines as Record<string, unknown>[])[0], base_received_qty: 48 }],
    });
    await act(async () => { await qc.invalidateQueries(); });
    await waitFor(() => expect(apiGetCalls()).toBeGreaterThan(before)); // the refetch really happened
    // the newly-remaining 72 base (= 6 cartons) must NOT overwrite the typed 2
    expect(Number((screen.getByLabelText(/الكمية المستلمة/) as HTMLInputElement).value)).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    expect(((H.posts[0].body as Record<string, unknown>).lines as Record<string, unknown>[])[0].enteredQty).toBe(2);
  });

  it("says so plainly when a PO has nothing left to receive", async () => {
    H.order = approvedOrder({
      lines: [{ id: LINE_ID, item_id: "ITEM-1", item_name: "مادة اختبار", entered_qty: 10, entered_unit_code: "كرتون", conversion_factor_snapshot: 12, base_qty: 120, base_received_qty: 120, unit_price_entered: 120 }],
    });
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    expect(await screen.findByText(/لا سطور مفتوحة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /تسجيل الاستلام/ })).toBeNull();
  });
});
