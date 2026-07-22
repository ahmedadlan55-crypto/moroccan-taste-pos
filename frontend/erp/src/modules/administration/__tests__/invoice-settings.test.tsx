import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import { apiClient } from "@/shared/api";
import InvoiceSettingsPage from "../pages/InvoiceSettings";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

const IDENTITY = {
  sellerName: "متجر الاختبار", legalName: "", taxNumber: "310000000000003", crNumber: "1010000000",
  address: "الموقع القديم", nationalAddress: "", phone: "", email: "",
  logo: "data:image/png;base64,abc", currency: "SAR", vatRate: 15, salesTaxName: "",
  header: "", footer: "", thankYou: "", returnPolicy: "",
  language: "ar", branchName: "", branchCompanyName: "", brandName: "",
};

const RESPONSE = {
  success: true,
  identity: IDENTITY,
  sources: { sellerName: "settings.CompanyName", logo: "settings.logo" },
  branches: [{ id: "BR-1", name: "فرع العليا" }],
  brands: [{ id: "BD-1", name: "براند الاختبار" }],
  showFields: { logo: true, taxNumber: true, crNumber: true, nationalAddress: true, phone: true, email: true, cashier: true, customer: true, qr: true },
  showFieldsRaw: null,
  receiptSettings: { paperWidth: "80", autoPrint: "1" },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <InvoiceSettingsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("InvoiceSettingsPage", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset();
    (apiClient.put as unknown as Mock).mockReset();
    (apiClient.get as unknown as Mock).mockResolvedValue(RESPONSE);
    (apiClient.put as unknown as Mock).mockResolvedValue({ success: true });
  });

  it("renders the 9 show-field switches and saving a flip writes ReceiptShowFields JSON", async () => {
    renderPage();

    const qr = await screen.findByRole("switch", { name: "رمز QR" });
    expect(qr).toHaveAttribute("aria-checked", "true");
    fireEvent.click(qr);
    expect(screen.getByRole("switch", { name: "رمز QR" })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());

    const [path, payload] = (apiClient.put as unknown as Mock).mock.calls[0] as [string, Record<string, string>];
    expect(path).toBe("/settings");
    const parsed = JSON.parse(payload.ReceiptShowFields) as Record<string, boolean>;
    expect(parsed.qr).toBe(false);
    expect(parsed.logo).toBe(true); // the untouched toggles ride along explicitly

    // exactly the 9 documented switches
    expect(screen.getAllByRole("switch")).toHaveLength(9 + 1); // +1 = the auto-print toggle
  });

  it("saves the paper width and auto-print keys from the الطباعة panel", async () => {
    renderPage();

    const narrow = await screen.findByRole("radio", { name: "58مم (حراري ضيّق)" });
    fireEvent.click(narrow);
    fireEvent.click(screen.getByRole("switch", { name: "طباعة تلقائية" }));
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({ ReceiptPaperWidth: "58", ReceiptAutoPrint: "0" }),
      ),
    );
  });

  it("offers Arabic and keeps the unsupported languages honestly disabled", async () => {
    renderPage();
    await screen.findByLabelText("لغة الفاتورة");

    expect((screen.getByRole("option", { name: "العربية" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: /English/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("option", { name: /ثنائية اللغة/ }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("selecting a branch reveals scoped overrides that save via /settings/invoice-identity-scope", async () => {
    renderPage();

    const branchSelect = await screen.findByLabelText("الفرع");
    fireEvent.change(branchSelect, { target: { value: "BR-1" } });

    const address = await screen.findByLabelText("عنوان الفرع");
    fireEvent.change(address, { target: { value: "شارع التخصيص 12" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ التخصيص" }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith("/settings/invoice-identity-scope", {
        branchId: "BR-1",
        brandId: undefined,
        fields: { address: "شارع التخصيص 12" },
      }),
    );
  });

  it("«إزالة» clears the logo through the global settings PUT", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "إزالة" }));
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith("/settings", expect.objectContaining({ logo: "" })),
    );
  });
});
