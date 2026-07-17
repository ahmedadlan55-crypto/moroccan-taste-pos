/**
 * Parity — print domain (docs/pos-parity-matrix.md):
 *   receipt-tendered-change — المستلَم/الباقي rows print when cash was tendered
 *   receipt-tax-snapshot    — the net + VAT lines print from cartTotals
 *   receipt-print / receipt-preview-modal — printHtml opens a visible window
 *     with the rendered receipt (the preview) and invokes print; a blocked
 *     popup is reported (returns false) instead of silently doing nothing
 *   kitchen ticket          — buildKitchenTicketHtml is a separate, big-font
 *     ticket (items+qty+notes+table only, no prices)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKitchenTicketHtml, buildReceiptHtml, printHtml } from "../receipt";
import type { LocalOrder } from "../types";

function makeOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id: "01JGABCDEFGHJKMNPQRSTVWXYZ",
    status: "completed",
    orderType: "dine_in",
    tableNo: "7",
    shiftId: "SH-1",
    deviceId: "DEV-1",
    discountType: null,
    discountValue: 0,
    discountName: null,
    note: "بدون بصل",
    customerId: null,
    customerName: null,
    customerPhone: null,
    lines: [
      { menuId: "M1", name: "شاي مغربي", qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S", notes: "سكر زيادة" },
    ],
    serverVersion: 3,
    invoiceNumber: "INV-20260717-0001",
    saleId: "SALE-9",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("receipt-tendered-change + receipt-tax-snapshot", () => {
  const html = buildReceiptHtml({
    order: makeOrder(),
    payments: [{ method: "cash", amount: 46 }],
    invoiceNumber: "INV-20260717-0001",
    cashTendered: 100,
    changeDue: 54,
    cashierName: "kashier1",
    vatRate: 15,
  });

  it("prints المستلَم and الباقي with the amounts", () => {
    expect(html).toContain("المستلَم");
    expect(html).toContain("100.00");
    expect(html).toContain("الباقي");
    expect(html).toContain("54.00");
  });

  it("prints the VAT line (tax-inclusive snapshot) and the grand total", () => {
    expect(html).toContain("الضريبة (15.00% مشمولة)");
    expect(html).toContain("6.00"); // VAT inside 46 at 15% inclusive
    expect(html).toContain("الإجمالي");
    expect(html).toContain("46.00");
  });

  it("omits المستلَم/الباقي when nothing was tendered (card sale)", () => {
    const card = buildReceiptHtml({
      order: makeOrder(),
      payments: [{ method: "card", amount: 46 }],
      invoiceNumber: "INV-20260717-0001",
      cashierName: "kashier1",
      vatRate: 15,
    });
    expect(card).not.toContain("المستلَم");
    expect(card).not.toContain("الباقي");
  });
});

describe("kitchen ticket — a distinct big-font ticket, no prices", () => {
  const html = buildKitchenTicketHtml(makeOrder());

  it("carries المطبخ + order type + table + items + line notes + order note", () => {
    expect(html).toContain("المطبخ");
    expect(html).toContain("محلي");
    expect(html).toContain("طاولة");
    expect(html).toContain("شاي مغربي");
    expect(html).toContain("سكر زيادة");
    expect(html).toContain("بدون بصل");
  });

  it("prints NO money (unit price / totals stay off the kitchen ticket)", () => {
    expect(html).not.toContain("23.00");
    expect(html).not.toContain("ر.س");
  });
});

describe("receipt-print — printHtml opens, writes, prints; popup-block is reported", () => {
  it("writes the receipt HTML into the window and calls print()", () => {
    const fake = {
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fake as unknown as Window);
    const ok = printHtml("<html>receipt</html>");
    expect(ok).toBe(true);
    expect(openSpy).toHaveBeenCalled();
    expect(fake.document.write).toHaveBeenCalledWith("<html>receipt</html>");
    expect(fake.print).toHaveBeenCalled();
  });

  it("returns false when the popup is blocked so the UI can toast", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(printHtml("<html>x</html>")).toBe(false);
  });
});
