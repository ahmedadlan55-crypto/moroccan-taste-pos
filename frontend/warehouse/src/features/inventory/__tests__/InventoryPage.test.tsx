import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { InventoryPage } from "../InventoryPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

function gridPage(page: number) {
  return {
    success: true,
    rows: [
      { itemId: `IT-${page}`, sku: `IT-${page}`, name: `صنف ${page}`, category: "خام", unit: "كجم", warehouseId: "WH-1", warehouseName: "المركزي", qty: 10, reserved: null, available: 10, avgCost: 5, costEstimated: false, value: 50, reorderPoint: 0, status: "available", lastMovementAt: null },
    ],
    total: 60,
    page,
    pageSize: 25,
    totalPages: 3,
    sort: "name",
    dir: "ASC",
  };
}

function route(url: string, init?: RequestInit) {
  if (url.includes("/inventory/categories")) return { status: 200, body: { success: true, categories: ["خام", "تغليف"] } };
  // echo back the requested page
  const u = new URL(url, "http://localhost");
  return { status: 200, body: gridPage(Number(u.searchParams.get("page")) || 1) };
  void init;
}

describe("InventoryPage (real grid)", () => {
  it("renders rows + real pagination footer", async () => {
    stubFetch(route);
    renderWithProviders(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("صنف 1")).toBeInTheDocument());
    expect(screen.getByText(/من 60/)).toBeInTheDocument(); // "عرض 1–25 من 60" (أرقام إنجليزية)
  });

  it("paginates server-side: Next requests page 2", async () => {
    const mock = stubFetch(route);
    renderWithProviders(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("صنف 1")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("التالي"));
    await waitFor(() => expect(screen.getByText("صنف 2")).toBeInTheDocument());
    const calledPage2 = mock.mock.calls.some((c) => String(c[0]).includes("page=2"));
    expect(calledPage2).toBe(true);
  });

  it("status filter sends status=low to the server", async () => {
    const mock = stubFetch(route);
    renderWithProviders(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("صنف 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "منخفض" }));
    await waitFor(() => {
      const calledLow = mock.mock.calls.some((c) => String(c[0]).includes("status=low"));
      expect(calledLow).toBe(true);
    });
  });

  it("shows the error state when the grid API fails", async () => {
    stubFetch((url) =>
      url.includes("/inventory/categories")
        ? { status: 200, body: { categories: [] } }
        : { status: 500, body: { error: "boom" } },
    );
    renderWithProviders(<InventoryPage />);
    await waitFor(() => expect(screen.getByText(/تعذّر تحميل البيانات/)).toBeInTheDocument());
  });
});
