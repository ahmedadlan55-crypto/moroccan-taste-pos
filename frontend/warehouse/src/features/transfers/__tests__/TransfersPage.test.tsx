import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { TransfersPage } from "../TransfersPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

function listEnvelope() {
  return {
    success: true,
    data: [
      {
        id: "SI-1", number: "ISS-1001", status: "issued", version: 3,
        issueDate: "2026-06-20", createdAt: "2026-06-20T08:00:00.000Z",
        fromWarehouse: { id: "A", name: "المستودع المركزي" },
        toWarehouse: { id: "B", name: "فرع الرياض" },
        totalCost: 1200, lineCount: 3, remainingQty: 25,
      },
    ],
    totals: { count: 1, draft: 2, approved: 1, issued: 1, partiallyReceived: 0, received: 4, cancelled: 0, reversed: 0, pending: 3, inTransit: 1, remainingQty: 25 },
    pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    filters: {}, scope: { allWarehousesAccess: true, warehouseId: null }, generatedAt: "2026-06-30T10:00:00.000Z",
  };
}

function render() {
  stubFetch((url) => {
    if (url.includes("/inventory/access-scope")) return { status: 200, body: { success: true, allWarehousesAccess: true, warehouses: [], capabilities: {} } };
    if (url.includes("/inventory/warehouses-summary")) return { status: 200, body: { warehouses: [], totals: {} } };
    if (url.includes("/inventory/transfers")) return { status: 200, body: listEnvelope() };
    return { status: 200, body: { success: true } };
  });
  return renderWithProviders(
    <Routes><Route path="transfers" element={<TransfersPage />} /></Routes>,
    { route: "/transfers" },
  );
}

describe("TransfersPage", () => {
  it("renders KPI cards, a transfer row and its route + status", async () => {
    render();
    // The number renders in BOTH the desktop table and the mobile cards.
    await waitFor(() => expect(screen.getAllByText("ISS-1001").length).toBeGreaterThan(0));
    // status badge maps backend 'issued' → «قيد النقل» (appears in KPI + badge)
    expect(screen.getAllByText(/قيد النقل/).length).toBeGreaterThan(0);
    // names sit inside a combined "from → to" span → match by substring.
    expect(screen.getAllByText(/فرع الرياض/).length).toBeGreaterThan(0);
    // KPI labels present (drafts + completed, each in its own card)
    expect(screen.getAllByText(/مكتمل/).length).toBeGreaterThan(0);
    expect(screen.getByText("مسودات")).toBeInTheDocument();
  });

  it("renders the status filter chips", async () => {
    render();
    await waitFor(() => expect(screen.getAllByText("ISS-1001").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "مستلم" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ملغى" })).toBeInTheDocument();
  });
});
