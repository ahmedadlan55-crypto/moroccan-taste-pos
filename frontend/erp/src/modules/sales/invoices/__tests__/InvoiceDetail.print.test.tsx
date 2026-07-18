/**
 * The ERP invoice "print" button now builds a self-contained document via the
 * SHARED renderer (buildSaleReceiptHtml) and hands it to printHtml — it no longer
 * calls window.print() on the React page. This proves: the adapter maps the
 * fetched invoice into the shared shape, printHtml receives THAT document (seller
 * + document number + QR reach paper), and a blocked popup surfaces a toast.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import type { Invoice } from "@/modules/sales/lib";
import { InvoiceDetail } from "../InvoiceDetail";

// Spy printHtml; keep the real buildSaleReceiptHtml so we assert the ACTUAL
// document text. The specifier must resolve to the same module the component
// imports (../../../../../shared/invoiceTemplate from InvoiceDetail.tsx).
vi.mock("../../../../../../shared/invoiceTemplate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../shared/invoiceTemplate")>();
  return { ...actual, printHtml: vi.fn(() => true) };
});
import { printHtml } from "../../../../../../shared/invoiceTemplate";

const INVOICE: Invoice = {
  id: "inv-1",
  document_number: "INV-TEST-001",
  document_type: "invoice",
  source_type: "manual",
  customer_id: "c1",
  customer_name: "متجر الأمل",
  issue_date: "2026-01-05",
  due_date: "2026-02-05",
  subtotal: 100,
  vat_amount: 15,
  total_amount: 115,
  paid_amount: 0,
  balance_amount: 115,
  status: "issued",
  zatca_status: "accepted",
  zatca_uuid: "uuid-1",
  zatca_qr_data_url: "data:image/png;base64,iVBORwINVOICEQR",
  seller: { sellerName: "مطاعم الأصالة", vatNumber: "310122393500003" },
  version: 2,
  lines: [
    {
      id: "l1", description: "برجر", entered_qty: 5, base_qty: 5, unit_price: 23,
      discount_amount: 0, vat_category: "S", vat_rate: 15, net_amount: 100, vat_amount: 15, gross_amount: 115,
    },
  ],
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: vi.fn(async () => ({ success: true, data: INVOICE })) },
  };
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <InvoiceDetail id="inv-1" onBack={() => {}} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("InvoiceDetail — print wiring", () => {
  it("builds the shared document and prints it (seller + number + QR reach paper)", async () => {
    vi.mocked(printHtml).mockReturnValue(true);
    renderDetail();
    const btn = await screen.findByRole("button", { name: /طباعة/ });
    fireEvent.click(btn);

    expect(printHtml).toHaveBeenCalledTimes(1);
    const html = vi.mocked(printHtml).mock.calls[0][0];
    expect(html).toContain("INV-TEST-001"); // document number
    expect(html).toContain("مطاعم الأصالة"); // frozen TLV seller name
    expect(html).toContain("310122393500003"); // frozen VAT number
    expect(html).toContain("data:image/png;base64,iVBORwINVOICEQR"); // stamped QR
    expect(html).toContain("115.00"); // recorded total reaches paper
  });

  it("surfaces a toast when the popup is blocked (printHtml returns false)", async () => {
    vi.mocked(printHtml).mockReturnValue(false);
    renderDetail();
    const btn = await screen.findByRole("button", { name: /طباعة/ });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/منع نافذة الطباعة/)).toBeInTheDocument());
  });
});
