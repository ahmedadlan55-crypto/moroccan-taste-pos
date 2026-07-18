import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/app/providers", () => ({
  useAuth: () => ({ user: { username: "maker", name: "منشئ الطلب", role: "manager" }, isAuthenticated: true }),
}));

vi.mock("@/shared/permissions", () => ({
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn((path: string) => {
        if (path === "/workflow/transaction-types") {
          return Promise.resolve([{ id: "TT-1", name: "طلب شراء", code: "PUR", isActive: true }]);
        }
        if (path === "/workflow/routable-users") {
          return Promise.resolve({
            groups: [{ key: "management", label: "الإدارة", users: [{ username: "manager", fullName: "مدير الفرع", position: "مدير" }] }],
          });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn(() => Promise.resolve({ success: true, id: "TXN-1", txnNumber: "BR-DEP-PUR-0001" })),
    },
  };
});

import { apiClient } from "@/shared/api";
import { ToastProvider } from "@/shared/ui";
import { CreateTransactionPage } from "../pages/CreateTransactionPage";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/workflow/new"]}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CreateTransactionPage />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("CreateTransactionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("autosaves locally and submits the typed workflow payload", async () => {
    renderPage();
    await screen.findByRole("option", { name: "طلب شراء" });

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "TT-1" } });
    fireEvent.change(screen.getByPlaceholderText("مثال: اعتماد شراء معدات الفرع"), { target: { value: "اعتماد شراء أجهزة جديدة" } });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("adlan.workflow.new-transaction.maker") || "{}");
      expect(stored.title).toBe("اعتماد شراء أجهزة جديدة");
      expect(stored.transactionTypeId).toBe("TT-1");
    });

    fireEvent.click(screen.getByRole("button", { name: /التالي/ }));
    expect(await screen.findByRole("heading", { name: "التوجيه" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /التالي/ }));

    fireEvent.change(screen.getByPlaceholderText("اشرح خلفية الطلب والقرار المطلوب والمبررات…"), {
      target: { value: "نحتاج الأجهزة لتجهيز موقع العمل الجديد." },
    });
    fireEvent.click(screen.getByRole("button", { name: /التالي/ }));
    fireEvent.click(screen.getByRole("button", { name: /إرسال المعاملة/ }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      "/workflow/transactions",
      expect.objectContaining({
        transactionTypeId: "TT-1",
        title: "اعتماد شراء أجهزة جديدة",
        username: "maker",
        saveAsDraft: false,
      }),
    ));
  });

  it("creates an explicit server draft without requiring full content", async () => {
    renderPage();
    await screen.findByRole("option", { name: "طلب شراء" });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "TT-1" } });
    fireEvent.change(screen.getByPlaceholderText("مثال: اعتماد شراء معدات الفرع"), { target: { value: "مسودة طلب شراء" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ كمسودة/ }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      "/workflow/transactions",
      expect.objectContaining({ saveAsDraft: true, username: "maker" }),
    ));
  });
});
