import { describe, it, expect } from "vitest";
import { toSupplier, toOrder, toInvoice, toPayment, toDashboard, toPaginated } from "../procurement.adapter";

describe("procurement.adapter", () => {
  it("maps a supplier row (snake → camel, coercions)", () => {
    const s = toSupplier({ id: "S1", name: "مورد", name_en: "Sup", vat_number: "123", is_active: 1, ap_balance: "540.50", payment_terms: "Net30" });
    expect(s.id).toBe("S1");
    expect(s.nameEn).toBe("Sup");
    expect(s.vatNumber).toBe("123");
    expect(s.isActive).toBe(true);
    expect(s.apBalance).toBe(540.5);
    expect(s.paymentTerms).toBe("Net30");
  });

  it("supplier falls back safely on a partial row", () => {
    const s = toSupplier({ id: "S2" });
    expect(s.name).toBe("");
    expect(s.isActive).toBe(false);
    expect(s.apBalance).toBe(0);
    expect(s.paymentTerms).toBe("Cash");
  });

  it("maps a PO row", () => {
    const o = toOrder({ id: "PO1", po_number: "PO-1", supplier_name: "م", status: "approved", version: 3, total_after_vat: "1380.00", currency: "SAR" });
    expect(o.poNumber).toBe("PO-1");
    expect(o.status).toBe("approved");
    expect(o.version).toBe(3);
    expect(o.total).toBe(1380);
  });

  it("maps an invoice row incl. balance", () => {
    const i = toInvoice({ id: "I1", invoice_no: "INV-9", total_amount: 1380, paid_amount: 380, balance_amount: 1000, matching_status: "matched", status: "partially_paid", version: 2 });
    expect(i.invoiceNo).toBe("INV-9");
    expect(i.balance).toBe(1000);
    expect(i.matchingStatus).toBe("matched");
  });

  it("maps a payment row", () => {
    const p = toPayment({ id: "P1", payment_number: "PPAY-1", amount: 1380, allocated_amount: 1380, payment_method: "bank", status: "paid", version: 4 });
    expect(p.paymentNumber).toBe("PPAY-1");
    expect(p.allocated).toBe(1380);
    expect(p.method).toBe("bank");
  });

  it("maps the dashboard incl. recent activity", () => {
    const d = toDashboard({ purchaseValue: 5000, ordersPendingApproval: 2, apDue: 1200, recentActivity: [{ document_type: "po", document_id: "PO1", action: "approve", actor: "u", to_status: "approved", created_at: "2026-07-05" }] });
    expect(d.purchaseValue).toBe(5000);
    expect(d.ordersPendingApproval).toBe(2);
    expect(d.recentActivity).toHaveLength(1);
    expect(d.recentActivity[0].action).toBe("approve");
  });

  it("toPaginated maps rows + pagination + totals", () => {
    const page = toPaginated({ data: [{ id: "S1", name: "a" }], pagination: { page: 2, pageSize: 25, total: 30, totalPages: 2 }, totals: { apBalance: 999 } }, toSupplier);
    expect(page.rows).toHaveLength(1);
    expect(page.page).toBe(2);
    expect(page.total).toBe(30);
    expect(page.totals?.apBalance).toBe(999);
  });

  it("toPaginated defaults when body is empty", () => {
    const page = toPaginated({}, toSupplier);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.total).toBe(0);
  });
});
