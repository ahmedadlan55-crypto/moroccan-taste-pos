import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { ReactNode } from "react";
import { RegisterPage } from "../pages/RegisterPage";
import type { PaymentMethod } from "../lib/types";

const METHODS: PaymentMethod[] = [
  { id: 1, name: "Cash", nameAr: "نقدًا", isActive: true, groupType: "cash", sortOrder: 1, serviceFeeType: "none" },
  { id: 2, name: "Mada", nameAr: "مدى", isActive: true, groupType: "electronic", sortOrder: 2, serviceFeeType: "percent", serviceFeeValue: 1.5 },
];

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RegisterPage — payment methods", () => {
  it("loads payment methods from the mocked apiClient and lists them", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(METHODS as unknown as never);

    renderWithClient(<RegisterPage />);

    // Launcher renders synchronously.
    expect(screen.getByText("فتح شاشة الكاشير")).toBeInTheDocument();

    // Rows arrive from the (mocked) list endpoint. The DataTable renders both the
    // desktop table and the mobile stacked-card layout (jsdom doesn't apply the
    // responsive `md:` hiding), so each name appears more than once → findAllByText.
    expect((await screen.findAllByText("نقدًا", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("مدى")).length).toBeGreaterThan(0);

    // Called the exact BARE endpoint (the client prepends /api itself).
    expect(get).toHaveBeenCalledWith("/settings/payment-methods-full", expect.anything());
  });

  it("shows an error state when the list endpoint fails", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("boom"));

    renderWithClient(<RegisterPage />);

    await waitFor(() => expect(screen.getByText("تعذّر تحميل البيانات")).toBeInTheDocument());
  });
});
