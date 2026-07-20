/**
 * CategoryTranslations (Fix D) — render + save smoke, modeled on
 * imageManager.test.tsx's conventions (mocked apiClient, controllable
 * @/shared/permissions gate via a shared `capAllowed` spy).
 *
 * The fixture below uses category names that appear in NO other fixture in
 * this __tests__ folder — the point of the first test is proving the page
 * renders whatever GET /menu/categories actually returns, not a hardcoded
 * list baked into the component.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ToastProvider } from "@/shared/ui";
import { CategoryTranslations } from "../CategoryTranslations";

// Controllable capability gate — CategoryTranslations imports BOTH Can and
// useCan from the shared permissions surface; both must honor the same flag
// so the outer menu.view gate and the inner menu.catalog.manage gate are
// independently testable (exactly like ImageManager's test).
const capAllowed = vi.fn((_cap: string) => true);
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => capAllowed(cap),
  Can: ({ cap, children, fallback = null, showDenied = false }: {
    cap: string;
    children: React.ReactNode;
    fallback?: React.ReactNode;
    showDenied?: boolean;
  }) => {
    if (capAllowed(cap)) return children;
    if (showDenied) return <div data-testid="permission-denied">denied</div>;
    return fallback;
  },
}));

const CATEGORIES = [
  { categoryAr: "مقبلات", categoryEn: "", itemCount: 3 },
  { categoryAr: "مشروبات ساخنة", categoryEn: "Hot Drinks", itemCount: 7 },
];

// vi.mock factories below are hoisted above this file's top-level `const`s, so
// a directly-referenced spy (`put: putSpy`, not wrapped in a closure) must
// itself be declared via vi.hoisted() to dodge the temporal-dead-zone error.
const { putSpy } = vi.hoisted(() => ({
  putSpy: vi.fn(async (_path: string, body: unknown) => ({
    success: true,
    categoryAr: "مقبلات",
    categoryEn: (body as { categoryEn: string }).categoryEn,
  })),
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (p: string) => {
        if (p.includes("/menu/categories")) return CATEGORIES;
        return [];
      }),
      put: putSpy,
    },
  };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/menu/categories"]}>
          <CategoryTranslations />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CategoryTranslations — render + save", () => {
  beforeEach(() => {
    putSpy.mockClear();
    capAllowed.mockReset();
    capAllowed.mockReturnValue(true);
  });

  it("renders a LIVE list of categories from GET /menu/categories, not a hardcoded list", async () => {
    renderPage();
    expect(screen.getByText("ترجمة أسماء الأقسام")).toBeInTheDocument();
    expect(await screen.findByText("مقبلات")).toBeInTheDocument();
    expect(screen.getByText("مشروبات ساخنة")).toBeInTheDocument();
    // The already-translated row's Input defaults to the current categoryEn.
    expect(screen.getByDisplayValue("Hot Drinks")).toBeInTheDocument();
  });

  it("typing an English name and saving calls the mutation with the right payload", async () => {
    renderPage();
    await screen.findByText("مقبلات");

    const input = screen.getByLabelText("الاسم الإنجليزي لقسم مقبلات");
    fireEvent.change(input, { target: { value: "Appetizers" } });

    const row = input.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "حفظ" }));

    await waitFor(() =>
      expect(putSpy).toHaveBeenCalledWith(
        `/menu/categories/${encodeURIComponent("مقبلات")}`,
        { categoryEn: "Appetizers" },
      ),
    );
  });

  it("the save button stays disabled until the draft differs from the saved value", async () => {
    renderPage();
    await screen.findByText("مشروبات ساخنة");

    const input = screen.getByLabelText("الاسم الإنجليزي لقسم مشروبات ساخنة");
    const row = input.closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "حفظ" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Hot Beverages" } });
    expect(within(row).getByRole("button", { name: "حفظ" })).toBeEnabled();
  });

  it("is read-only without menu.catalog.manage — no input, no save button", async () => {
    capAllowed.mockImplementation((cap: string) => cap === "menu.view");
    renderPage();
    await screen.findByText("مقبلات");

    expect(screen.queryByLabelText("الاسم الإنجليزي لقسم مقبلات")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "حفظ" })).not.toBeInTheDocument();
    expect(screen.getByText("Hot Drinks")).toBeInTheDocument();
  });

  it("renders the permission-denied panel without menu.view", async () => {
    capAllowed.mockReturnValue(false);
    renderPage();
    expect(await screen.findByTestId("permission-denied")).toBeInTheDocument();
    expect(screen.queryByText("ترجمة أسماء الأقسام")).not.toBeInTheDocument();
  });
});
