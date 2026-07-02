import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ReportsPage } from "../ReportsPage";
import { renderWithProviders, stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("ReportsPage (catalog)", () => {
  it("renders a card per report from the catalog", async () => {
    stubFetch((url) => {
      if (url.includes("/inventory/reports/catalog")) {
        return {
          status: 200,
          body: {
            success: true,
            data: [
              { type: "valuation", label: "تقييم المخزون", adminOnly: false },
              { type: "data-quality", label: "جودة البيانات", adminOnly: true },
            ],
          },
        };
      }
      return { status: 200, body: { success: true } };
    });
    renderWithProviders(<ReportsPage />);
    await waitFor(() => expect(screen.getByText("تقييم المخزون")).toBeInTheDocument());
    expect(screen.getByText("جودة البيانات")).toBeInTheDocument();
    expect(screen.getByText("للإدارة فقط")).toBeInTheDocument(); // adminOnly badge
  });
});
