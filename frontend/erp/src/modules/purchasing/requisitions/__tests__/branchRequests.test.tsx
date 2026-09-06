/**
 * Branch (cashier) shortage requests in the back office.
 *
 * WHAT WAS BROKEN
 *   The POS files «طلبات النواقص» into `shortage_requests` through
 *   routes/inventory.js; that table has its own approve/reject/convert
 *   lifecycle — and NO back-office screen read it. A manager could not see,
 *   approve or convert what a branch asked for (two such requests sat in
 *   production, one pending for days).
 *
 * WHAT THIS PINS (real page, real hooks; only the HTTP client and the
 * permission gates are faked)
 *   1. `?source=branch` on the requisitions screen lists the cashier's
 *      requests with the branch, the requester and a TRANSLATED status —
 *      never the raw enum.
 *   2. Opening a request shows its items; approving posts to the shortage
 *      router (not the purchase-requisition router) with the chosen supply mode.
 *   3. A refusal the router answers with HTTP 200 + { success:false, error }
 *      is surfaced as an error, not swallowed as success.
 *   4. `?source=branch&doc=<id>` deep-links straight into the request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { I18nProvider } from "@/i18n";

const H = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: unknown }>,
  postImpl: null as null | ((path: string, body: unknown) => unknown),
  rows: [] as Array<Record<string, unknown>>,
  detail: {} as Record<string, unknown>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(async (path: string) => {
        if (/\/inventory\/shortage-requests\/[^/?]+$/.test(path)) return H.detail;
        if (/\/inventory\/shortage-requests(\?|$)/.test(path)) return H.rows;
        // branch picker, access scope, purchase requisitions — nothing needed here
        if (/\/procurement\/requisitions/.test(path)) return { data: [], pagination: { page: 1, pageSize: 200, total: 0, totalPages: 1 } };
        return [];
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        H.posts.push({ path, body });
        if (H.postImpl) return H.postImpl(path, body);
        return { success: true };
      }),
      put: vi.fn(async () => ({ success: true })),
      patch: vi.fn(),
      delete: vi.fn(async () => ({ success: true })),
    },
  };
});
vi.mock("@/app/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/providers")>();
  return { ...actual, useCan: () => true };
});
vi.mock("@/shared/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/permissions")>();
  return { ...actual, Can: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

import { RequisitionsPage } from "../RequisitionsPage";

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "SR-1", requestNumber: "SR-0001", requestDate: "2026-09-03", username: "cashier1",
    notes: "ناقص سكر", status: "pending", supplyMode: null, totalItems: 2,
    approvedBy: null, approvedAt: null, poId: null, poNumber: null,
    brandId: "B1", brandName: "اللقطة", branchId: "BR-1", branchName: "فرع العليا",
    warehouseId: "WH-1", warehouseName: "مستودع العليا",
    ...overrides,
  };
}
function detailOf(row: Record<string, unknown>) {
  return {
    ...row,
    items: [
      { id: "SI-1", invItemId: "SUGAR", invItemName: "سكر", unit: "كجم", currentQty: 2, minQty: 10, requestedQty: 25, unitPrice: 4 },
      { id: "SI-2", invItemId: "FLOUR", invItemName: "دقيق", unit: "كجم", currentQty: 0, minQty: 20, requestedQty: 50, unitPrice: 3 },
    ],
  };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/purchasing/requisitions" element={<RequisitionsPage />} /></Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  H.posts.length = 0;
  H.postImpl = null;
  H.rows = [pendingRow(), pendingRow({ id: "SR-2", requestNumber: "SR-0002", status: "converted", poId: "PO-9", poNumber: "PO-0009", username: "cashier2" })];
  H.detail = detailOf(pendingRow());
});

// The shared DataTable renders every row twice (desktop table + mobile cards),
// so row text is asserted with getAll*; the Drawer carries no dialog role, so
// its content is located by the texts only it renders (item names, eyebrow).
const first = (els: HTMLElement[]) => els[0];

describe("branch (cashier) shortage requests in the back office", () => {
  it("lists the cashier's requests with branch, requester and a translated status", async () => {
    renderAt("/purchasing/requisitions?source=branch");
    expect(first(await screen.findAllByText("SR-0001"))).toBeInTheDocument();
    expect(screen.getAllByText("SR-0002").length).toBeGreaterThan(0);
    expect(screen.getAllByText("فرع العليا").length).toBeGreaterThan(0);
    expect(screen.getAllByText("cashier1").length).toBeGreaterThan(0);
    // Translated, never the raw enum.
    expect(screen.getAllByText("بانتظار الاعتماد").length).toBeGreaterThan(0);
    expect(screen.getAllByText("حُوّل إلى أمر شراء").length).toBeGreaterThan(0);
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
    expect(screen.queryByText("converted")).not.toBeInTheDocument();
    // The converted one links to its order by NUMBER.
    expect(first(screen.getAllByRole("link", { name: /PO-0009/ }))).toHaveAttribute("href", expect.stringContaining("/purchasing/orders?doc=PO-9"));
  });

  it("opens a request, shows its items, and approves through the shortage router with the supply mode", async () => {
    renderAt("/purchasing/requisitions?source=branch");
    fireEvent.click(first(await screen.findAllByText("SR-0001")));
    // The drawer: its eyebrow and the request's items.
    expect(await screen.findByText("طلب نواقص فرع")).toBeInTheDocument();
    expect(await screen.findByText("سكر")).toBeInTheDocument();
    expect(screen.getByText("دقيق")).toBeInTheDocument();

    fireEvent.click(first(screen.getAllByRole("button", { name: "اعتماد" })));
    // The approve section carries the supply-mode choice.
    const select = await screen.findByLabelText("طريقة التوريد");
    fireEvent.change(select, { target: { value: "warehouse" } });
    // The confirm button lives in the approve section (the drawer's footer
    // button, which only opens that section, comes later in the DOM).
    const section = select.closest("section") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "اعتماد" }));

    await waitFor(() => expect(H.posts.length).toBe(1));
    expect(H.posts[0].path).toBe("/inventory/shortage-requests/SR-1/approve");
    expect(H.posts[0].body).toEqual({ supplyMode: "warehouse" });
    // NOT the purchase-requisition router.
    expect(H.posts[0].path).not.toContain("/procurement/requisitions");
  });

  it("deep-links into a request and surfaces a 200 + { success:false } refusal as an error", async () => {
    H.postImpl = () => ({ success: false, error: "الطلب غير موجود" });
    renderAt("/purchasing/requisitions?source=branch&doc=SR-1");
    // `?doc=` opens the drawer directly, without a row click.
    expect(await screen.findByText("سكر")).toBeInTheDocument();
    fireEvent.click(first(screen.getAllByRole("button", { name: "اعتماد" })));
    const select = await screen.findByLabelText("طريقة التوريد");
    const section = select.closest("section") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "اعتماد" }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    expect(await screen.findByText("الطلب غير موجود")).toBeInTheDocument();
    // A refusal is not a success: the drawer is still open on the same request.
    expect(screen.getByText("سكر")).toBeInTheDocument();
  });
});
