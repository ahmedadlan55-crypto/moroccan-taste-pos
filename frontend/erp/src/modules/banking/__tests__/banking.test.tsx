import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import type { ReactNode } from "react";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { apiClient } from "@/shared/api";
import { CashboxesPage } from "../pages/Cashboxes";

const get = apiClient.get as Mock;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => get.mockReset());

describe("Cashboxes", () => {
  it("lists cash boxes from the (mocked) /api/cash/cash-boxes endpoint", async () => {
    get.mockResolvedValue([
      {
        id: "CB-1",
        name: "الصندوق الرئيسي",
        code: "C-01",
        type: "main",
        branchId: null,
        branchName: "",
        brandId: null,
        brandName: "",
        keeperUsername: "admin",
        currency: "SAR",
        balance: 4200,
        isActive: true,
        glAccountId: "gl1",
        glAccountCode: "1101-01",
        glAccountName: "الصندوق",
      },
    ]);

    wrap(<CashboxesPage />);
    // DataTable renders a desktop table + a mobile card list; jsdom keeps both.
    expect((await screen.findAllByText("الصندوق الرئيسي")).length).toBeGreaterThan(0);
    expect(get).toHaveBeenCalledWith("/cash/cash-boxes");
  });
});
