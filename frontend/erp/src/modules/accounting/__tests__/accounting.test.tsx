import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock the shared API client while keeping the real ApiError (states.tsx needs it).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { apiClient } from "@/shared/api";
import { TrialBalancePage } from "../pages/TrialBalance";
import { CostCentersPage } from "../pages/CostCenters";

const get = apiClient.get as Mock;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset();
});

describe("TrialBalance", () => {
  it("renders rows returned by the (mocked) apiClient", async () => {
    get.mockResolvedValue({
      success: true,
      rows: [
        {
          accountId: "a1",
          code: "1101",
          nameAr: "الصندوق",
          type: "asset",
          parentId: null,
          level: 1,
          hasChildren: false,
          opening: 100,
          periodDebit: 50,
          periodCredit: 20,
          net: 30,
          closing: 130,
          rowCount: 1,
        },
      ],
      totals: { opening: 100, periodDebit: 50, periodCredit: 20, closing: 130, isBalanced: true },
    });

    wrap(<TrialBalancePage />);
    expect(await screen.findByText("الصندوق")).toBeInTheDocument();
    // The trial-balance endpoint was hit with the exact legacy path.
    expect(get).toHaveBeenCalledWith("/erp/reports/trial-balance", expect.anything());
  });
});

describe("CostCenters", () => {
  it("renders the list and validates the required name in the form", async () => {
    get.mockResolvedValue([
      {
        id: "cc1",
        code: "C1",
        nameAr: "مركز الإنتاج",
        nameEn: "Production",
        branchId: "",
        branchName: "",
        parentId: "",
        parentName: "",
        isActive: true,
        notes: "",
        createdAt: "",
        createdBy: "",
      },
    ]);

    wrap(<CostCentersPage />);
    // DataTable renders a desktop table + a mobile card list; jsdom keeps both.
    expect((await screen.findAllByText("مركز الإنتاج")).length).toBeGreaterThan(0);

    // Open the create dialog and submit empty → the required-name error shows.
    fireEvent.click(screen.getByRole("button", { name: /مركز جديد/ }));
    fireEvent.click(screen.getByRole("button", { name: /^حفظ$/ }));
    await waitFor(() => expect(screen.getByText("الاسم بالعربية مطلوب.")).toBeInTheDocument());
  });
});
