import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { Sidebar } from "./Sidebar";

// The mock manifest carries the same translation KEYS the real manifest now
// uses; the real I18nProvider (default "ar") resolves them, so the assertions
// below expect the translated Arabic output.
vi.mock("@/app/navigation/manifest", () => ({
  NAV: [
    {
      id: "overview",
      label: "nav.groups.overview",
      items: [
        {
          id: "overview-home",
          path: "/overview",
          label: "nav.items.ov-overview",
          icon: "LayoutDashboard",
          module: "overview",
        },
      ],
    },
    {
      id: "sales",
      label: "nav.groups.sales",
      items: [
        {
          id: "sales-invoices",
          path: "/sales/invoices",
          label: "nav.items.sl-invoices",
          icon: "FileText",
          module: "sales",
        },
      ],
    },
  ],
}));

vi.mock("@/app/providers", () => ({
  useAuth: () => ({ user: { name: "مدير الاختبار", role: "admin" } }),
  usePermissions: () => ({ can: () => true }),
}));

vi.mock("@/app/server-flags", () => ({
  useServerFlags: () => ({}),
}));

vi.mock("./shell-context", () => ({
  useShell: () => ({ collapsed: false, toggleCollapsed: vi.fn() }),
}));

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("Sidebar section navigation", () => {
  it("opens a selected section and navigates from its heading", async () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/overview"]}>
          <Sidebar />
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "طي صفحات الرئيسية" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "فتح صفحات المبيعات" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "طي صفحات المبيعات" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    expect(screen.getByRole("link", { name: "الفواتير" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "المبيعات" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sales/invoices"));
  });
});
