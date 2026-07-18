import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the API client (keep the real ApiError so <ErrorState> instanceof checks
// work). The factory is hoisted above module scope, so the fixture is inlined.
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn().mockResolvedValue([
        {
          id: "T-1",
          txnNumber: "TX-1001",
          typeName: "طلب صرف",
          subject: "شراء مستلزمات",
          creatorName: "أحمد",
          createdBy: "ahmed",
          importance: "high",
          status: "pending",
          isRead: false,
          dueDate: "2025-01-01T09:00:00Z",
          isOverdue: true,
          currentStepName: "اعتماد المدير",
          createdAt: "2026-01-01T09:00:00Z",
        },
        {
          id: "T-2",
          txnNumber: "TX-1002",
          typeName: "مذكرة",
          subject: "تعميم إداري",
          creatorName: "سارة",
          createdBy: "sara",
          importance: "medium",
          status: "in_progress",
          isRead: true,
          currentStepName: "مراجعة المالية",
          createdAt: "2026-01-02T09:00:00Z",
        },
      ]),
    },
  };
});

// Mock the session so the list query is enabled with a known username.
// FC-P3: the detail drawer now gates its actions on useCan — provide it here.
vi.mock("@/app/providers", () => ({
  useAuth: () => ({ user: { username: "tester", role: "admin", isDeveloper: false }, isAuthenticated: true }),
  useCan: () => true,
}));

import { apiClient } from "@/shared/api";
import { InboxPage } from "../pages/InboxPage";

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("workflow InboxPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders incoming transactions from the mocked apiClient", async () => {
    renderInbox();
    // The DataTable renders a desktop table + a mobile card list (both in the DOM
    // under jsdom), so each value can appear more than once — assert ≥ 1.
    expect((await screen.findAllByText("شراء مستلزمات")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("تعميم إداري").length).toBeGreaterThan(0);
  });

  it("reads the read-only /workflow/incoming endpoint scoped to the current user", async () => {
    renderInbox();
    await screen.findAllByText("شراء مستلزمات");
    expect(apiClient.get).toHaveBeenCalledWith(
      "/workflow/incoming",
      expect.objectContaining({ params: { username: "tester" } }),
    );
  });

  it("shows operational KPIs and the current SLA/step context", async () => {
    renderInbox();
    await screen.findAllByText("شراء مستلزمات");
    expect(screen.getAllByText("غير مقروءة").length).toBeGreaterThan(0);
    expect(screen.getAllByText("اعتماد المدير").length).toBeGreaterThan(0);
    expect(screen.getAllByText("متأخرة").length).toBeGreaterThan(0);
    expect(screen.getByText("متأخرة عن SLA")).toBeInTheDocument();
  });

  it("filters the queue by unread transactions without losing the named subject", async () => {
    renderInbox();
    await screen.findAllByText("شراء مستلزمات");
    fireEvent.click(screen.getByRole("button", { name: /غير مقروءة 1/ }));
    expect(screen.getAllByText("شراء مستلزمات").length).toBeGreaterThan(0);
    expect(screen.queryByText("تعميم إداري")).not.toBeInTheDocument();
  });
});
