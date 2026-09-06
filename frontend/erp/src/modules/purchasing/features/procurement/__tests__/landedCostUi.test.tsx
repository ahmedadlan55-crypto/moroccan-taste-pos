/**
 * Landed cost in the receiving UI — «مصاريف الشحن والاستيراد».
 *
 * Drives the REAL pages through the REAL hooks and adapters (only the HTTP
 * client is faked) and pins the contract with routes/procurement/receipts.js:
 *   1. the create form sends `charges[]` in the POST body in the wire shape
 *      (chargeType/amount/vatAmount/allocationMethod, optional description and
 *      supplierId omitted rather than sent empty) — and sends NO `charges` key
 *      when there are none;
 *   2. the live preview uses the same allocation rule the server posts with:
 *      per-line landed unit cost, charges total, landed total, uplift %;
 *   3. a charge the server would 422 (amount <= 0) blocks submit, with a reason;
 *   4. the detail panel prints "—" — never 0 — for a line with no charges, and
 *      says so when the envelope carried no `charges` at all;
 *   5. draft/approved receipts edit charges via PUT /receipts/:id/charges;
 *      posted ones show the translated lock reason instead of an editor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useSearchParams } from "react-router-dom";
import { I18nProvider } from "@/i18n";

const H = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: unknown }>,
  puts: [] as Array<{ path: string; body: unknown }>,
  putImpl: null as null | ((path: string, body: unknown) => unknown),
  order: {} as Record<string, unknown>,
  receipt: {} as Record<string, unknown>,
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(async (path: string) => {
        if (/\/procurement\/orders\/[^/]+$/.test(path) && !/timeline/.test(path)) return { data: H.order };
        if (/\/procurement\/receipts\/[^/]+$/.test(path) && !/timeline/.test(path)) return { data: H.receipt };
        if (/timeline$/.test(path)) return { data: [] };
        return { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } };
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        H.posts.push({ path, body });
        return { success: true, data: { id: "GRN-1" }, documentNumber: "GRN-0001", status: "draft", version: 1 };
      }),
      put: vi.fn(async (path: string, body: unknown) => {
        H.puts.push({ path, body });
        if (H.putImpl) return H.putImpl(path, body);
        return { success: true, data: H.receipt };
      }),
      patch: vi.fn(), delete: vi.fn(),
    },
  };
});

vi.mock("@/modules/inventory/lib/permission-provider", () => ({
  useCan: () => true,
  usePermissions: () => ({ can: () => true }),
  WarehousePermissionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ReceiptDetailPage } from "@/modules/purchasing/features/procurement/DetailPages";
import { ReceiveCreatePage } from "@/modules/purchasing/features/procurement/ReceivePages";

const PO_ID = "PO-TEST-1";
const LINE_ID = "POL-TEST-1";

function approvedOrder() {
  return {
    id: PO_ID, po_number: "PO-0001", supplier_id: "SUP-1", supplier_name: "مورد اختبار",
    po_date: "2026-08-01", status: "approved", version: 2, warehouse_id: "WH-MAIN",
    total_before_vat: 1000, vat_amount: 150, total_after_vat: 1150, currency: "SAR",
    // remaining 84 base = 7 cartons × 120 → line total 840, base unit cost 10
    lines: [{
      id: LINE_ID, item_id: "ITEM-1", item_name: "مادة اختبار",
      entered_qty: 10, entered_unit_code: "كرتون", conversion_factor_snapshot: 12,
      base_qty: 120, base_received_qty: 36, unit_price_entered: 120, unit_price: 10, total: 1200,
    }],
    receipts: [], invoices: [],
  };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "GRN-1", receipt_number: "GRN-0001", po_id: PO_ID, supplier_id: "SUP-1", supplier_name_snapshot: "مورد اختبار",
    receipt_date: "2026-08-02", warehouse_id: "WH-MAIN", status: "draft", version: 1,
    subtotal: 840, vat_amount: 126, total: 966, gl_journal_id: null,
    lines: [{
      id: "GRL-1", po_line_id: LINE_ID, item_id: "ITEM-1", item_name: "مادة اختبار", entered_qty: 7, entered_unit_code: "كرتون",
      base_qty: 84, base_unit_cost: 10, line_total: 840, lot_no: null, expiry_date: null,
      landedChargeAmount: null, landedUnitCost: null,
    }],
    charges: [],
    chargesTotal: 0,
    landedTotal: 840,
    ...overrides,
  };
}
const FREIGHT = {
  id: "CHG-1", chargeType: "freight", description: "شحن بحري", supplierId: "SUP-9", supplierName: "شركة الشحن",
  amount: 84, vatAmount: 12.6, allocationMethod: "value", status: "invoiced", supplierInvoiceId: "INV-7",
};

function ReceivingRoute() {
  const [sp] = useSearchParams();
  return sp.get("po") ? <ReceiveCreatePage /> : <ReceiptDetailPage />;
}
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/purchasing/receiving" element={<ReceivingRoute />} /></Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  H.posts.length = 0;
  H.puts.length = 0;
  H.putImpl = null;
  H.order = approvedOrder();
  H.receipt = receipt();
});

describe("receiving form — freight & import charges", () => {
  it("previews the landed unit cost with the server's rule and sends charges[] in the POST", async () => {
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    await screen.findByLabelText(/الكمية المستلمة/);
    // No charges yet → no landed preview at all (not a preview of 0).
    expect(screen.queryByTestId("rcv-landed-preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /إضافة مصروف/ }));
    fireEvent.change(screen.getByLabelText(/المبلغ \(صافي\)/), { target: { value: "84" } });
    fireEvent.change(screen.getByLabelText(/^ضريبة القيمة المضافة$/), { target: { value: "12.6" } });
    fireEvent.change(screen.getByLabelText(/^الوصف$/), { target: { value: "شحن بحري" } });
    fireEvent.change(screen.getByLabelText(/نوع المصروف/), { target: { value: "customs" } });
    fireEvent.change(screen.getByLabelText(/طريقة التوزيع/), { target: { value: "qty" } });

    // 840 goods + 84 charge over 84 base units → 11.00 per base unit; 10% uplift.
    expect(screen.getByTestId(`landed-unit-cost-${LINE_ID}`)).toHaveTextContent("11.00");
    const preview = screen.getByTestId("rcv-landed-preview");
    expect(preview).toHaveTextContent("84.00");
    expect(preview).toHaveTextContent("924.00");
    expect(preview).toHaveTextContent("10%");

    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    const body = H.posts[0].body as Record<string, unknown>;
    expect(H.posts[0].path).toBe("/procurement/receipts");
    expect(body.charges).toEqual([
      { chargeType: "customs", description: "شحن بحري", amount: 84, vatAmount: 12.6, allocationMethod: "qty" },
    ]);
    // No vendor picked → no supplierId key at all, not "" or null.
    expect("supplierId" in (body.charges as Record<string, unknown>[])[0]).toBe(false);
  });

  it("sends NO `charges` key when the receipt has none", async () => {
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    await screen.findByLabelText(/الكمية المستلمة/);
    fireEvent.click(screen.getByRole("button", { name: /تسجيل الاستلام/ }));
    await waitFor(() => expect(H.posts.length).toBe(1));
    expect("charges" in (H.posts[0].body as Record<string, unknown>)).toBe(false);
  });

  it("refuses to submit a charge the server would 422 (amount 0) and says why", async () => {
    renderAt(`/purchasing/receiving?po=${PO_ID}`);
    await screen.findByLabelText(/الكمية المستلمة/);
    fireEvent.click(screen.getByRole("button", { name: /إضافة مصروف/ }));
    expect(screen.getByText(/كل مصروف يحتاج مبلغًا صافيًا أكبر من صفر/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تسجيل الاستلام/ })).toBeDisabled();
    // A zero charge allocates nothing: the line's landed unit cost is "—", not 10.00.
    expect(screen.getByTestId(`landed-unit-cost-${LINE_ID}`)).toHaveTextContent("—");
    // Removing the row unblocks the form again.
    fireEvent.click(screen.getByRole("button", { name: /حذف المصروف/ }));
    expect(screen.getByRole("button", { name: /تسجيل الاستلام/ })).not.toBeDisabled();
  });
});

describe("receipt detail — landed cost panel", () => {
  it("prints — for a receipt without charges, never 0, and offers the editor while draft", async () => {
    renderAt("/purchasing/receiving?doc=GRN-1");
    expect(await screen.findByTestId("landed-kv-charges")).toHaveTextContent("—");
    expect(screen.getByTestId("landed-kv-landed")).toHaveTextContent("—");
    expect(screen.getByTestId("landed-kv-uplift")).toHaveTextContent("—");
    expect(screen.getByTestId("landed-line-GRL-1")).toHaveTextContent("—");
    expect(screen.getByTestId("landed-line-GRL-1")).not.toHaveTextContent("0");
    expect(screen.getByText(/لا مصاريف على هذا الاستلام/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تعديل المصاريف/ })).toBeInTheDocument();
    expect(screen.queryByTestId("landed-locked")).toBeNull();
  });

  it("shows the charges, their status, the invoice link and per-line landed cost of a posted receipt — locked", async () => {
    H.receipt = receipt({
      status: "posted", charges: [FREIGHT], chargesTotal: 84, landedTotal: 924,
      lines: [{ ...(receipt().lines as Record<string, unknown>[])[0], landedChargeAmount: 84, landedUnitCost: 11 }],
    });
    renderAt("/purchasing/receiving?doc=GRN-1");
    expect(await screen.findByTestId("landed-kv-charges")).toHaveTextContent("84.00");
    expect(screen.getByTestId("landed-kv-landed")).toHaveTextContent("924.00");
    expect(screen.getByTestId("landed-kv-uplift")).toHaveTextContent("10%");
    expect(screen.getByTestId("landed-line-GRL-1")).toHaveTextContent("11.00");

    const table = screen.getByTestId("landed-charges-table");
    expect(within(table).getByText("شحن")).toBeInTheDocument();
    expect(within(table).getByText("شركة الشحن")).toBeInTheDocument();
    expect(within(table).getByText("مُفوتر")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: /الفاتورة/ })).toHaveAttribute("href", expect.stringContaining("/purchasing/invoices?doc=INV-7"));

    // Posted: the lock reason replaces the editor.
    expect(screen.getByTestId("landed-locked")).toHaveTextContent(/لا يمكن تعديل المصاريف بعد ترحيل الاستلام/);
    expect(screen.queryByRole("button", { name: /تعديل المصاريف/ })).toBeNull();
  });

  it("replaces the whole charge set through PUT /receipts/:id/charges while approved", async () => {
    H.receipt = receipt({ status: "approved", charges: [FREIGHT], chargesTotal: 84, landedTotal: 924 });
    renderAt("/purchasing/receiving?doc=GRN-1");
    fireEvent.click(await screen.findByRole("button", { name: /تعديل المصاريف/ }));
    // The stored charge is loaded into the editor with its vendor and amounts.
    const amount = screen.getByLabelText(/المبلغ \(صافي\)/) as HTMLInputElement;
    expect(Number(amount.value)).toBe(84);
    fireEvent.change(amount, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /إضافة مصروف/ }));
    const amounts = screen.getAllByLabelText(/المبلغ \(صافي\)/);
    fireEvent.change(amounts[1], { target: { value: "20" } });
    fireEvent.change(screen.getAllByLabelText(/نوع المصروف/)[1], { target: { value: "insurance" } });

    fireEvent.click(screen.getByRole("button", { name: /حفظ المصاريف/ }));
    await waitFor(() => expect(H.puts.length).toBe(1));
    expect(H.puts[0].path).toBe("/procurement/receipts/GRN-1/charges");
    expect(H.puts[0].body).toEqual({
      charges: [
        { chargeType: "freight", description: "شحن بحري", supplierId: "SUP-9", amount: 100, vatAmount: 12.6, allocationMethod: "value" },
        { chargeType: "insurance", amount: 20, vatAmount: 0, allocationMethod: "value" },
      ],
    });
    // Saved → back to the read view.
    await waitFor(() => expect(screen.queryByRole("button", { name: /حفظ المصاريف/ })).toBeNull());
  });

  it("translates a 409 RECEIPT_CHARGES_LOCKED into the lock reason instead of echoing the server", async () => {
    H.receipt = receipt({ status: "approved" });
    H.putImpl = () => {
      throw Object.assign(new Error("لا يمكن تعديل مصاريف الاستيراد على استلام حالته «posted»"), { code: "RECEIPT_CHARGES_LOCKED", status: 409 });
    };
    renderAt("/purchasing/receiving?doc=GRN-1");
    fireEvent.click(await screen.findByRole("button", { name: /تعديل المصاريف/ }));
    fireEvent.click(screen.getByRole("button", { name: /إضافة مصروف/ }));
    fireEvent.change(screen.getByLabelText(/المبلغ \(صافي\)/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ المصاريف/ }));
    expect(await screen.findByText(/لا يمكن تعديل المصاريف بعد ترحيل الاستلام/)).toBeInTheDocument();
  });

  it("says the server sent no charge data — and prints no figure — when `charges` is absent", async () => {
    const bare = receipt() as Record<string, unknown>;
    delete bare.charges; delete bare.chargesTotal; delete bare.landedTotal;
    H.receipt = bare;
    renderAt("/purchasing/receiving?doc=GRN-1");
    expect(await screen.findByTestId("landed-not-provided")).toBeInTheDocument();
    expect(screen.queryByTestId("landed-kv-charges")).toBeNull();
    expect(screen.queryByTestId("landed-lines-table")).toBeNull();
    expect(screen.queryByRole("button", { name: /تعديل المصاريف/ })).toBeNull();
  });
});
