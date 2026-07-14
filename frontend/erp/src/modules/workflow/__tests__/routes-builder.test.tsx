import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the API client (keep the real ApiError so <ErrorState> instanceof checks
// still work). apiClient.get/post branch on the request path so the RoutesDslTab
// list, its type/position pickers, the create POST and the dry-run POST all
// resolve deterministically — mirroring the fixture style of inbox.test.tsx.
const ROUTE = {
  id: "WFR-1",
  transactionTypeId: null,
  initiatorPositionId: null,
  routeName: "قاعدة تجريبية",
  isDefault: true,
  isActive: true,
  conditions: {},
  steps: [
    { id: "s1", name: "المحاسب" },
    { id: "s2", name: "المدير" },
  ],
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn((path: string) => {
        if (path === "/workflow-routes") return Promise.resolve([ROUTE]);
        if (path === "/workflow/transaction-types")
          return Promise.resolve([{ id: "TT-1", name: "طلب صرف", code: "EXP" }]);
        if (path === "/workflow/positions")
          return Promise.resolve([{ id: "P-1", name: "محاسب", level: 1 }]);
        return Promise.resolve([]);
      }),
      post: vi.fn((path: string) => {
        if (path.endsWith("/test"))
          return Promise.resolve({
            success: true,
            path: [
              { id: "s1", name: "المحاسب", position: "P-1" },
              { id: "s2", name: "المدير المالي" },
            ],
          });
        return Promise.resolve({ success: true, id: "WFR-2" });
      }),
      put: vi.fn(() => Promise.resolve({ success: true })),
      delete: vi.fn(() => Promise.resolve({ success: true })),
    },
  };
});

import { apiClient } from "@/shared/api";
import { ToastProvider } from "@/shared/ui";
import { RoutesDslTab } from "../builder/RoutesDslTab";

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RoutesDslTab />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("workflow RoutesDslTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a route via POST /workflow-routes", async () => {
    renderTab();
    // Wait for the routes list to load from the mocked apiClient.
    await screen.findAllByText("قاعدة تجريبية");

    // Open the create dialog and fill the required name (steps default to a valid
    // sample template, conditions default to "{}").
    fireEvent.click(screen.getByRole("button", { name: "قاعدة جديدة" }));
    const nameInput = await screen.findByPlaceholderText("مثال: صرف يتجاوز 50 ألف");
    fireEvent.change(nameInput, { target: { value: "قاعدة جديدة للاختبار" } });

    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        "/workflow-routes",
        expect.objectContaining({ routeName: "قاعدة جديدة للاختبار" }),
      ),
    );
  });

  it("runs a dry-run and renders the resolved path", async () => {
    renderTab();
    await screen.findAllByText("قاعدة تجريبية");

    // Open the tester for the first row (DataTable renders desktop + mobile, so
    // the icon action can appear more than once — take the first).
    fireEvent.click(screen.getAllByRole("button", { name: "اختبار" })[0]);

    // The txn textarea is prefilled with a valid sample; run the dry-run.
    fireEvent.click(screen.getByRole("button", { name: /dry-run/ }));

    // The resolved path (from the mocked /test response) renders its step names.
    expect(await screen.findByText("المدير المالي")).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/workflow-routes/WFR-1/test",
      expect.objectContaining({ txn: expect.any(Object) }),
    );
  });
});
