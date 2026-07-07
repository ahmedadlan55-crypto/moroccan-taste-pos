import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/app/auth-provider";
import { PermissionProvider } from "@/app/permission-provider";
import { stubFetch } from "@/test/test-utils";
import { CustomersPage } from "../CustomersPage";
import type { ReactElement } from "react";

function adminToken(): string {
  const body = btoa(JSON.stringify({ username: "admin", role: "admin", exp: 9999999999 })).replace(/\+/g, "-").replace(/\//g, "_");
  return `h.${body}.s`;
}

function renderPage(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <PermissionProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </PermissionProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const CUSTOMERS = {
  success: true,
  data: [
    { id: "C1", name: "شركة الأفق", phone: "0551234567", customerType: "B2B", creditLimit: 5000, balance: 0, derived: { arBalance: 1250.5, invoiced: 0, paid: 0 }, isActive: true, paymentTerms: "Net30", creditDays: 30 },
    { id: "C2", name: "أحمد التاجر", phone: "0509876543", customerType: "B2C", creditLimit: 0, balance: 0, derived: { arBalance: 0, invoiced: 0, paid: 0 }, isActive: true, paymentTerms: "Cash", creditDays: 0 },
  ],
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
};

describe("CustomersPage", () => {
  beforeEach(() => { localStorage.setItem("pos_token", adminToken()); });
  afterEach(() => { localStorage.clear(); });

  it("renders the customer list with English-digit balances (admin sees the create action)", async () => {
    stubFetch((url) => {
      if (url.includes("/api/order-to-cash/customers")) return { body: CUSTOMERS };
      return { body: { success: true, data: [] } };
    });
    renderPage(<CustomersPage />);

    expect(await screen.findByText("شركة الأفق")).toBeInTheDocument();
    expect(screen.getByText("أحمد التاجر")).toBeInTheDocument();
    // balance rendered with English digits + grouping
    const bal = await screen.findByText(/1,250\.50/);
    expect(bal).toBeInTheDocument();
    expect(/[٠-٩]/.test(bal.textContent || "")).toBe(false);
    // admin (bypasses all caps) sees the "new customer" action
    expect(screen.getAllByText(/عميل جديد/).length).toBeGreaterThan(0);
  });

  it("shows the empty state when no customers match", async () => {
    stubFetch(() => ({ body: { success: true, data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } } }));
    renderPage(<CustomersPage />);
    await waitFor(() => expect(screen.getByText(/لا يوجد عملاء مطابقون/)).toBeInTheDocument());
  });
});
