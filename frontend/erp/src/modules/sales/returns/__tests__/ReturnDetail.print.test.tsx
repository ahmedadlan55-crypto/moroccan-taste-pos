/**
 * The ERP credit-note "print" now builds a مرتجع / إشعار دائن document via the
 * SHARED renderer (buildCreditNoteHtml → printHtml) instead of window.print() on
 * the `.print-document` section. This proves: the adapter maps the fetched return
 * + its credit note into the shared shape, and printHtml receives a document that
 * carries the credit-note number, the original invoice it reverses, the return
 * reason, and a distinguishing مرتجع marker.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import type { SalesReturn } from "@/modules/sales/lib";
import { ReturnDetail } from "../ReturnDetail";

vi.mock("../../../../../../shared/invoiceTemplate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../shared/invoiceTemplate")>();
  return { ...actual, printHtml: vi.fn(() => true) };
});
import { printHtml } from "../../../../../../shared/invoiceTemplate";

// sales_returns carries a document-level `reason` that the DTO type never
// declared (getWithLines does SELECT *); include it so the adapter reads it.
const RETURN: SalesReturn & { reason: string } = {
  id: "ret-1",
  return_number: "RET-TEST-009",
  original_ar_document_id: "inv-1",
  customer_id: "c1",
  customer_name: "متجر الأمل",
  return_date: "2026-01-06",
  subtotal: 20,
  vat_amount: 3,
  total_amount: 23,
  cost_total: 12,
  refund_method: "ar_reduction",
  status: "posted",
  reason: "منتج تالف",
  version: 3,
  lines: [
    {
      id: "rl1", original_line_id: "l1", description: "برجر", sold_qty: 2, previously_returned_qty: 0,
      return_qty: 1, vat_category: "S", vat_rate: 15, net_amount: 20, vat_amount: 3, gross_amount: 23,
      cost_snapshot: 12, restock: 0, components: [],
    },
  ],
  creditNote: {
    id: "cn-1",
    document_number: "CN-TEST-777",
    issue_date: "2026-01-06",
    subtotal: 20,
    vat_amount: 3,
    total_amount: 23,
    status: "posted",
    zatca_status: "accepted",
    zatca_uuid: "cn-uuid-1",
    zatca_qr_data_url: "data:image/png;base64,iVBORwCNQR",
    zatca_icv: 42,
    customer_name: "متجر الأمل",
    original_document_number: "INV-TEST-001",
    seller: { sellerName: "مطاعم الأصالة", vatNumber: "310122393500003" },
  },
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: vi.fn(async () => ({ success: true, data: RETURN })) },
  };
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ReturnDetail id="ret-1" onBack={() => {}} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ReturnDetail — credit-note print wiring", () => {
  it("builds the shared credit note and prints it (number + original + reason + مرتجع)", async () => {
    vi.mocked(printHtml).mockReturnValue(true);
    renderDetail();
    const btn = await screen.findByRole("button", { name: /طباعة الإشعار/ });
    fireEvent.click(btn);

    expect(printHtml).toHaveBeenCalledTimes(1);
    const html = vi.mocked(printHtml).mock.calls[0][0];
    expect(html).toContain("CN-TEST-777"); // credit-note number
    expect(html).toContain("INV-TEST-001"); // original invoice it reverses
    expect(html).toContain("منتج تالف"); // document-level return reason
    expect(html).toContain("مرتجع"); // distinguishing marker
    expect(html).toContain("data:image/png;base64,iVBORwCNQR"); // stamped credit-note QR
  });
});
