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
  it("opens a selected section and navigates from its heading", async () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Sidebar />
        <LocationProbe />
      </MemoryRouter>,
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
    expect(screen.getByRole("link", { name: "الطلبات" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "المبيعات" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sales/orders"));
  });
});
