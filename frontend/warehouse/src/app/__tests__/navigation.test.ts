import { describe, it, expect } from "vitest";
import { navigation, flatNav } from "@/app/navigation";

// The warehouse module must expose EXACTLY ONE unified procurement entry (spec §12);
// suppliers/orders/receipts/invoices/payments/returns/reports are internal tabs, not
// separate nav items — no duplicate/legacy purchasing links in the sidebar.
describe("warehouse navigation — single unified procurement entry", () => {
  it("has exactly one 'purchasing' nav item labelled «المشتريات والموردون»", () => {
    const purchasing = flatNav.filter((i) => i.id === "purchasing");
    expect(purchasing).toHaveLength(1);
    expect(purchasing[0].label).toBe("المشتريات والموردون");
    expect(purchasing[0].path).toBe("/purchasing");
  });

  it("has exactly one procurement group with a single item", () => {
    const groups = navigation.filter((g) => g.items.some((i) => i.id === "purchasing"));
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("المشتريات والموردون");
    expect(groups[0].items).toHaveLength(1);
  });

  it("exposes NO fragmented legacy supplier/purchasing nav items", () => {
    const legacyIds = ["suppliers", "purchase-orders", "purchaseOrders", "purchase-reports", "purchaseReports", "ap-aging", "apAging", "supplier-statement", "purchases"];
    expect(flatNav.filter((i) => legacyIds.includes(i.id))).toHaveLength(0);
  });

  it("Sidebar filter hides the procurement group when the flag is OFF and shows exactly one when ON", () => {
    // mirrors the exact filter in components/app-shell/Sidebar.tsx
    const visiblePurchasing = (procurementEnabled: boolean) =>
      navigation
        .filter((g) => procurementEnabled || !g.items.some((i) => i.id === "purchasing"))
        .flatMap((g) => g.items)
        .filter((i) => i.id === "purchasing");
    expect(visiblePurchasing(false)).toHaveLength(0);
    expect(visiblePurchasing(true)).toHaveLength(1);
  });
});
