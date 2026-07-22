import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import { apiClient, ApiError } from "@/shared/api";
import { UserDialog } from "../users/UserDialog";

// Keep ApiError + everything else real; swap only the network client (same
// pattern as companies.test.tsx / invoice-settings.test.tsx).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

function renderCreate() {
  const onClose = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <UserDialog mode="create" open initial={null} onClose={onClose} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

function setField(label: string, value: string) {
  // Required fields render a trailing " *" inside the <label>, so match on the
  // label text with that asterisk stripped (keeps password vs. confirm distinct).
  const input = screen.getByLabelText((text: string) => text.replace(/\s*\*$/, "").trim() === label);
  fireEvent.change(input, { target: { value } });
}

function fillValid() {
  setField("اسم المستخدم", "cashier1");
  setField("الاسم الظاهر", "أمين الصندوق");
  setField("كلمة المرور", "Passw0rd!");
  setField("تأكيد كلمة المرور", "Passw0rd!");
}

describe("UserDialog — create", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset().mockResolvedValue([]);
    (apiClient.post as unknown as Mock).mockReset().mockResolvedValue({ success: true });
  });

  it("submits a valid new user to POST /auth/users and closes the dialog", async () => {
    const { onClose } = renderCreate();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "إنشاء المستخدم" }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [path, body] = (apiClient.post as unknown as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/auth/users");
    expect(body).toMatchObject({
      username: "cashier1",
      password: "Passw0rd!",
      displayName: "أمين الصندوق",
      role: "cashier",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("blocks a weak password client-side and never calls the API", async () => {
    renderCreate();
    setField("اسم المستخدم", "cashier1");
    setField("الاسم الظاهر", "أمين الصندوق");
    setField("كلمة المرور", "weak");
    setField("تأكيد كلمة المرور", "weak");
    fireEvent.click(screen.getByRole("button", { name: "إنشاء المستخدم" }));

    expect(
      await screen.findByText("كلمة المرور يجب أن تكون 6 أحرف على الأقل"),
    ).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("surfaces a 409 duplicate-username as an inline field error", async () => {
    (apiClient.post as unknown as Mock).mockRejectedValue(
      new ApiError({ kind: "conflict", status: 409, message: "اسم المستخدم مستخدم بالفعل" }),
    );
    renderCreate();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "إنشاء المستخدم" }));

    expect(await screen.findByText("اسم المستخدم مستخدم بالفعل")).toBeInTheDocument();
    // A field error, not a swallowed rejection — the dialog stays open.
    expect(screen.getByRole("button", { name: "إنشاء المستخدم" })).toBeInTheDocument();
  });
});
