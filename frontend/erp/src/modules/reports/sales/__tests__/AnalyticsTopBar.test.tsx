// Sales Analytics Hub — AnalyticsTopBar behavior: segmented basis toggles,
// codec-derived active-filter chips (add/remove/clear-all). The bar is a
// controlled component: it never mutates state itself, it calls patch()/reset().
//
// WAVE-4 UPDATE: the bar now derives its segment from the URL (save-view /
// export controls), so renders are wrapped in a MemoryRouter and the
// permission hook is mocked (export stays hidden: cap not granted here).
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import { AnalyticsTopBar } from "../components/AnalyticsTopBar";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import { apiClient } from "@/shared/api";

vi.mock("@/shared/permissions", () => ({
  useCan: () => false,
  usePermissions: () => ({ can: () => false }),
  Can: ({ fallback = null }: { children?: React.ReactNode; fallback?: React.ReactNode }) => <>{fallback}</>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path.includes("/erp/brands")) return [{ id: "B1", name: "براند تجريبي" }];
        if (path.includes("/erp/branches-full")) return [{ id: "BR1", name: "فرع الرياض" }];
        return [];
      }),
    },
  };
});

const DEFAULTS: AnalyticsFilters = analyticsFilterCodec.parse(new URLSearchParams());

function renderBar(overrides: Partial<AnalyticsFilters> = {}) {
  const patch = vi.fn();
  const reset = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/sales/executive"]}>
          <AnalyticsTopBar filters={{ ...DEFAULTS, ...overrides }} patch={patch} reset={reset} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { patch, reset };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The basis toggles now live in the inline "more filters" area, and every
 *  control edits a DRAFT — «تطبيق» is what reaches patch(). The assertions
 *  below are unchanged: the commit still carries exactly the one key the
 *  analyst touched (see filterDiff). */
function openMoreFilters() {
  fireEvent.click(screen.getByRole("button", { name: "المزيد من الفلاتر" }));
}

function applyFilters() {
  fireEvent.click(screen.getByRole("button", { name: "تطبيق" }));
}

describe("AnalyticsTopBar — segmented toggles", () => {
  it("patches businessDay=false when the calendar-day segment is picked", () => {
    const { patch } = renderBar();
    openMoreFilters();
    fireEvent.click(screen.getByRole("radio", { name: "اليوم التقويمي" }));
    applyFilters();
    expect(patch).toHaveBeenCalledWith({ businessDay: false });
  });

  it("patches taxIncl=true when the tax-inclusive segment is picked", () => {
    const { patch } = renderBar();
    openMoreFilters();
    fireEvent.click(screen.getByRole("radio", { name: "شامل الضريبة" }));
    applyFilters();
    expect(patch).toHaveBeenCalledWith({ taxIncl: true });
  });

  it("marks the current basis as checked", () => {
    renderBar({ taxIncl: true });
    // A deep link stays compact; its committed scope remains visible in the
    // chip summary until the reader chooses to edit it.
    expect(screen.queryByTestId("more-filters")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-filter-chips")).toHaveTextContent("شامل الضريبة");
    openMoreFilters();
    expect(screen.getByRole("radio", { name: "شامل الضريبة" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "يوم العمل" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not offer the unsupported custom comparison window", () => {
    renderBar();
    expect(screen.queryByRole("option", { name: /مخصص/ })).not.toBeInTheDocument();
  });
});

describe("AnalyticsTopBar — lookup performance", () => {
  it("defers secondary lookup requests until the advanced filters are opened", async () => {
    renderBar();

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith("/erp/branches-full", expect.any(Object)),
    );
    expect(apiClient.get).not.toHaveBeenCalledWith("/erp/brands", expect.any(Object));
    expect(apiClient.get).not.toHaveBeenCalledWith("/erp/menu-options", expect.any(Object));
    expect(apiClient.get).not.toHaveBeenCalledWith("/sales-channels");

    openMoreFilters();

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith("/erp/brands", expect.any(Object));
      expect(apiClient.get).toHaveBeenCalledWith("/erp/menu-options", expect.any(Object));
      expect(apiClient.get).toHaveBeenCalledWith("/sales-channels");
    });
  });
});

describe("AnalyticsTopBar — active-filter chips", () => {
  it("shows NO chip row while every filter sits on its default", () => {
    renderBar();
    expect(screen.queryByTestId("active-filter-chips")).not.toBeInTheDocument();
  });

  it("adds a chip for a non-default filter and removes it via its X", () => {
    const { patch } = renderBar({ channel: ["pos"] });
    const chips = screen.getByTestId("active-filter-chips");
    expect(chips).toHaveTextContent("قناة البيع: pos");
    fireEvent.click(screen.getByRole("button", { name: "إزالة الفلتر: قناة البيع: pos" }));
    expect(patch).toHaveBeenCalledWith({ channel: [] });
  });

  it("collapses from/to/preset into ONE period chip that restores the default range", () => {
    const { patch } = renderBar({ from: "2026-01-01", to: "2026-01-31", preset: "custom" });
    expect(screen.getByTestId("active-filter-chips")).toBeInTheDocument();
    const removeButtons = screen
      .getAllByRole("button")
      .filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("إزالة الفلتر: الفترة"));
    expect(removeButtons).toHaveLength(1);
    fireEvent.click(removeButtons[0]);
    expect(patch).toHaveBeenCalledWith({
      from: DEFAULTS.from,
      to: DEFAULTS.to,
      preset: DEFAULTS.preset,
    });
  });

  it("clear-all calls reset()", () => {
    const { reset } = renderBar({ taxIncl: true, brandId: ["B1"] });
    fireEvent.click(screen.getByRole("button", { name: "مسح الكل" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
