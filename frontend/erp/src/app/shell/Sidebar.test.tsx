import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("@/app/navigation/manifest", () => ({
  NAV: [
    {
      id: "overview",
      label: "الرئيسية",
      items: [
        {
          id: "overview-home",
          path: "/overview",
          label: "نظرة عامة",
          icon: "LayoutDashboard",
          module: "overview",
        },
      ],
    },
    {
      id: "sales",
      label: "المبيعات",
      items: [
        {
          id: "sales-orders",
          path: "/sales/orders",
          label: "الطلبات",
          icon: "ShoppingCart",
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
  it("keeps a user-selected section open and lets its leaf navigate", async () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Sidebar />
        <LocationProbe />
      </MemoryRouter>,
    );

    const overview = screen.getByRole("button", { name: /الرئيسية/ });
    const sales = screen.getByRole("button", { name: /المبيعات/ });

    await waitFor(() => expect(overview).toHaveAttribute("aria-expanded", "true"));

    fireEvent.click(sales);

    await waitFor(() => expect(sales).toHaveAttribute("aria-expanded", "true"));
    expect(overview).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("link", { name: "الطلبات" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sales/orders"));
  });
});
