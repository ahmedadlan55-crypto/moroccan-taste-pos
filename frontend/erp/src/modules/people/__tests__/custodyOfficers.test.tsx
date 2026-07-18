import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/shared/ui";
import { ApiError, apiClient } from "@/shared/api";
import { CustodyOfficersPage } from "../pages/CustodyOfficers";

// Mock the API client (ApiError stays REAL so the 409 duplicate-link path is a
// genuine ApiError the component branches on).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

// The screen is admin/manager-only; drive it as a manager so the gate passes.
vi.mock("@/app/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/providers")>();
  return {
    ...actual,
    useAuth: () => ({ user: { username: "mgr", role: "manager" }, isAuthenticated: true }),
  };
});

const OFFICERS = [
  {
    id: "cu1",
    name: "أحمد العنزي",
    idNumber: "1012345678",
    phone: "0555000111",
    jobTitle: "مشرف",
    isActive: 1,
    linkedUsername: "ahmed",
  },
];

const ACCOUNTS = [
  { username: "ahmed", fullName: "أحمد العنزي" },
  { username: "sara", fullName: "سارة الحربي" },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/people/custody-officers"]}>
          <CustodyOfficersPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CustodyOfficersPage", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset();
    (apiClient.post as unknown as Mock).mockReset();
    (apiClient.get as unknown as Mock).mockImplementation((path: string) => {
      if (path === "/custody/users") return Promise.resolve(OFFICERS);
      if (path === "/auth/users-list") return Promise.resolve(ACCOUNTS);
      return Promise.resolve([]);
    });
  });

  it("lists custody officers from /custody/users", async () => {
    renderPage();
    expect((await screen.findAllByText("أحمد العنزي")).length).toBeGreaterThan(0);
    expect(apiClient.get).toHaveBeenCalledWith("/custody/users", expect.anything());
  });

  it("submits a new custodian via POST /custody/users", async () => {
    (apiClient.post as unknown as Mock).mockResolvedValue({ success: true, id: "cu2" });
    renderPage();
    await screen.findAllByText("أحمد العنزي");

    fireEvent.click(screen.getByRole("button", { name: "مسؤول عهدة جديد" }));
    fireEvent.change(await screen.findByLabelText("اسم مسؤول العهدة"), { target: { value: "خالد الشمري" } });
    fireEvent.click(screen.getByRole("button", { name: "إضافة المسؤول" }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        "/custody/users",
        expect.objectContaining({ name: "خالد الشمري" }),
      ),
    );
  });

  it("surfaces a 409 DUPLICATE_LINK as an inline field error, not a crash", async () => {
    (apiClient.post as unknown as Mock).mockRejectedValue(
      new ApiError({
        kind: "conflict",
        status: 409,
        message: "هذا الحساب مرتبط بالفعل بمسؤول عهدة آخر",
        code: "DUPLICATE_LINK",
      }),
    );
    renderPage();
    await screen.findAllByText("أحمد العنزي");

    fireEvent.click(screen.getByRole("button", { name: "مسؤول عهدة جديد" }));
    fireEvent.change(await screen.findByLabelText("اسم مسؤول العهدة"), { target: { value: "خالد الشمري" } });
    fireEvent.click(screen.getByRole("button", { name: "إضافة المسؤول" }));

    // The duplicate-link message renders inline (role="alert") and the dialog
    // stays open — no unhandled crash, no raw error toast swallowing the field.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("هذا الحساب مرتبط بالفعل بمسؤول عهدة آخر");
    expect(screen.getByRole("button", { name: "إضافة المسؤول" })).toBeInTheDocument();
  });
});
