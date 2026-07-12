import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/shared/ui";
import { apiClient } from "@/shared/api";
import AuditLogPage from "../pages/AuditLog";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

const ROWS = [
  {
    id: 1,
    action: "create",
    entityType: "invoice",
    entityId: "INV-001",
    username: "admin",
    details: "إنشاء فاتورة مبيعات",
    ipAddress: "10.0.0.1",
    createdAt: "2026-07-01T10:00:00Z",
  },
  {
    id: 2,
    action: "delete",
    entityType: "customer",
    entityId: "CU-9",
    username: "manager",
    details: "حذف عميل مكرر",
    ipAddress: "10.0.0.2",
    createdAt: "2026-07-02T12:00:00Z",
  },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/administration/audit-log"]}>
          <AuditLogPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AuditLogPage", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset();
    (apiClient.get as unknown as Mock).mockImplementation((path: string) => {
      if (path === "/erp/audit-logs") return Promise.resolve(ROWS);
      if (path === "/auth/users-list") return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it("renders audit rows and filters them via the quick search box", async () => {
    renderPage();

    // both rows present initially (text appears in the desktop table + mobile card)
    expect((await screen.findAllByText("إنشاء فاتورة مبيعات")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("حذف عميل مكرر").length).toBeGreaterThan(0);

    // the client-side quick search filters the DataTable in-memory
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "حذف عميل" } });

    expect(screen.queryByText("إنشاء فاتورة مبيعات")).not.toBeInTheDocument();
    expect(screen.getAllByText("حذف عميل مكرر").length).toBeGreaterThan(0);
  });

  it("exposes an entity filter derived from the loaded rows", async () => {
    renderPage();
    await screen.findAllByText("إنشاء فاتورة مبيعات");

    // the "الكيان" filter select should carry the two distinct entity types
    const entityGroups = screen.getAllByText("الكيان");
    // header cell + filter label both match; assert the derived options exist
    expect(entityGroups.length).toBeGreaterThan(0);
    const options = screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain("invoice");
    expect(options).toContain("customer");
  });
});
