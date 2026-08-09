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

  it("enables Arabic, English and bilingual receipts and previews the draft language", async () => {
    renderPage();
    const select = await screen.findByLabelText("لغة الفاتورة");

    expect((screen.getByRole("option", { name: "العربية" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: /^English$/ }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: /ثنائية اللغة/ }) as HTMLOptionElement).disabled).toBe(false);

    fireEvent.change(select, { target: { value: "both" } });
    const previewFrame = screen.getByTitle("معاينة الفاتورة — 80");
    expect(previewFrame).toHaveAttribute("srcdoc", expect.stringContaining('data-lang="both"'));
  });

  it("uses the real global editing baseline without pretending it overrides a stronger scope", async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      ...RESPONSE,
      identity: { ...IDENTITY, sellerName: "Scoped company identity" },
      sources: { ...RESPONSE.sources, sellerName: "companies.name" },
      globalIdentity: { ...IDENTITY, sellerName: "Global settings identity" },
      globalSources: { sellerName: "settings.CompanyName", logo: "settings.logo" },
    });
    renderPage();

    const inputs = await screen.findAllByRole("textbox");
    expect(inputs[0]).toHaveValue("Global settings identity");
    fireEvent.change(inputs[0], { target: { value: "Unsaved global identity" } });

    const frame = screen.getByTestId("invoice-live-preview").querySelector("iframe");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("Scoped company identity"));
    expect(frame).not.toHaveAttribute("srcdoc", expect.stringContaining("Unsaved global identity"));
  });

  it("keeps the preview draft-aware, VAT-zero-safe, QR-visible and focused on the selected paper", async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      ...RESPONSE,
      identity: { ...IDENTITY, vatRate: 0, phone: "0111111111" },
      sources: { ...RESPONSE.sources, phone: "settings.CompanyPhone", vatRate: "settings.VATRate" },
    });
    const { container } = renderPage();

    const inputs = await screen.findAllByRole("textbox");
    fireEvent.change(inputs[4], { target: { value: "0555555555" } });
    let frame = screen.getByTestId("invoice-live-preview").querySelector("iframe");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("0555555555"));
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("(0%"));
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining('alt="ZATCA QR"'));

    fireEvent.click(screen.getAllByRole("switch")[8]);
    frame = screen.getByTestId("invoice-live-preview").querySelector("iframe");
    expect(frame).not.toHaveAttribute("srcdoc", expect.stringContaining('alt="ZATCA QR"'));

    const narrow = container.querySelector<HTMLInputElement>('input[name="receipt-paper-width"][value="58"]');
    expect(narrow).not.toBeNull();
    fireEvent.click(narrow!);
    frame = screen.getByTestId("invoice-live-preview").querySelector("iframe");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining('data-paper="58"'));
    expect(screen.getByTestId("invoice-live-preview")).toHaveClass("max-w-[330px]");
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
