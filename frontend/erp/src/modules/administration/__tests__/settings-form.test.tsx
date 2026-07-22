import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import { apiClient } from "@/shared/api";
import SettingsPage from "../pages/Settings";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});
// The settings form only renders its editable controls for privileged users.
vi.mock("@/app/providers", () => ({ useCan: () => true }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={["/administration/settings"]}>
            <SettingsPage />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("SettingsPage form validation", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset();
    (apiClient.put as unknown as Mock).mockReset();
    (apiClient.get as unknown as Mock).mockResolvedValue({});
    (apiClient.put as unknown as Mock).mockResolvedValue({ success: true });
  });

  it("blocks submit and shows an error for an invalid email", async () => {
    renderPage();

    const email = await screen.findByLabelText("البريد الإلكتروني");
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الإعدادات" }));

    expect(await screen.findByText("البريد الإلكتروني غير صحيح")).toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it("submits valid settings via apiClient.put", async () => {
    renderPage();

    const name = await screen.findByLabelText("اسم الشركة");
    fireEvent.change(name, { target: { value: "شركة صحيحة" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الإعدادات" }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith("/settings", expect.objectContaining({ name: "شركة صحيحة" })));
  });
});
