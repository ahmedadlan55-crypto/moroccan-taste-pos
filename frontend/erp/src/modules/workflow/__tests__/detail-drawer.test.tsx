import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn((path: string) => {
        if (path.endsWith("/permissions")) {
          return Promise.resolve({ permissions: {}, currentVersion: 4 });
        }
        return Promise.resolve({
          id: "T-9",
          txnNumber: "TX-900",
          subject: "طلب اعتماد عقد",
          status: "pending",
          importance: "high",
          typeName: "عقد",
          createdByName: "أحمد عدلان",
          currentAssigneeName: "مدير الإدارة",
          currentStepName: "مراجعة المدير",
          createdAt: "2026-07-18T09:00:00Z",
          dueDate: "2026-07-19T09:00:00Z",
          isRead: false,
          description: "ملخص الطلب",
          contentHtml: "<p>النص الكامل للمعاملة</p>",
          contentSecrecy: "confidential",
          attachmentsSecrecy: "normal",
          attachments: [{ id: "A-1", fileName: "العقد.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,AA==", uploadedBy: "ahmed", uploadedAt: "2026-07-18T09:00:00Z" }],
          replies: [{ id: "R-1", replyText: "تمت مراجعة البنود", authorName: "سارة", authorPosition: "المستشار القانوني", createdAt: "2026-07-18T10:00:00Z" }],
          workflowPath: [{ id: "S-1", stepName: "مراجعة المدير", isCurrent: true }],
          logs: [{ id: "L-1", actionBy: "ahmed", actorFullName: "أحمد عدلان", actionType: "create", createdAt: "2026-07-18T09:00:00Z" }],
        });
      }),
      post: vi.fn().mockResolvedValue({ success: true }),
    },
  };
});

vi.mock("@/app/providers", () => ({ useCan: () => true }));

import { apiClient } from "@/shared/api";
import { TxnDetailDrawer } from "../components/TxnDetailDrawer";

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TxnDetailDrawer txnId="T-9" open onClose={vi.fn()} username="tester" canAct />
    </QueryClientProvider>,
  );
}

describe("workflow transaction detail drawer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks an unread transaction and exposes the full content safely as text", async () => {
    renderDrawer();
    expect(await screen.findByText("طلب اعتماد عقد")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "المحتوى" }));
    expect(screen.getByText("النص الكامل للمعاملة")).toBeInTheDocument();
    expect(screen.queryByText("<p>النص الكامل للمعاملة</p>")).not.toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith("/workflow/transactions/T-9/mark-read");
  });

  it("shows attachment and conversation data returned by full-bundle", async () => {
    renderDrawer();
    await screen.findByText("طلب اعتماد عقد");
    fireEvent.click(screen.getByRole("tab", { name: /المرفقات/ }));
    expect(screen.getByText("العقد.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /المحادثة/ }));
    expect(screen.getByText("تمت مراجعة البنود")).toBeInTheDocument();
    expect(screen.getByText("المستشار القانوني")).toBeInTheDocument();
  });

  it("keeps action buttons hidden when server permissions deny them even if capabilities exist", async () => {
    renderDrawer();
    await screen.findByText("طلب اعتماد عقد");
    expect(screen.queryByRole("button", { name: "اعتماد" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "رفض" })).not.toBeInTheDocument();
  });
});
