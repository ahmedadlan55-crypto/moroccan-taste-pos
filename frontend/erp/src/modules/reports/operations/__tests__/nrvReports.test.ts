// The two NRV reports: what the registry declares, what the loaders make of
// the wire, and the one rule both exist to keep — a figure the server does
// not have reaches the sheet as NULL (a dash), never as a 0 that reads as a
// measurement. The wire fixtures below are the shapes
// routes/erp/reports/inventoryValue.js answers, pinned live by
// tests/inventoryNrv.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/shared/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiClient: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { findReport, type ReportDefinition } from "../../engine";
import { OPERATIONS_REPORTS_SECTION } from "../registry";

function report(id: string): ReportDefinition {
  const found = findReport(OPERATIONS_REPORTS_SECTION, id);
  if (!found) throw new Error(`report ${id} is not in the operations registry`);
  return found;
}

function resolve(dictionary: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    dictionary,
  );
}

// ── wire fixtures ───────────────────────────────────────────────────────────
const NRV_BODY = {
  success: true,
  data: [
    {
      itemId: "ITEM-OK", itemName: "دقيق", itemNameEn: "Flour", unit: "كجم",
      quantity: 5, unitCost: 12, inventoryValue: 60,
      basisSource: "menu:MENU-2", basisProductName: "كعكة", basisProductNameEn: "Cake",
      unitsPerSale: 1, netSellingPrice: 30, sellingCostPct: 0,
      nrvUnit: 30, writeDownUnit: 0, writeDown: 0, status: "ok",
    },
    {
      itemId: "ITEM-IMPAIRED", itemName: "زبدة", itemNameEn: "Butter", unit: "كجم",
      quantity: 5, unitCost: 40, inventoryValue: 200,
      basisSource: "menu:MENU-1", basisProductName: "خبز", basisProductNameEn: "Bread",
      unitsPerSale: 2, netSellingPrice: 40, sellingCostPct: 0,
      nrvUnit: 30, writeDownUnit: 10, writeDown: 50, status: "impaired",
    },
    {
      itemId: "ITEM-NOBASIS", itemName: "ملح", itemNameEn: "Salt", unit: "كجم",
      quantity: 7, unitCost: 4, inventoryValue: 28,
      basisSource: null, basisProductName: null, basisProductNameEn: null,
      unitsPerSale: null, netSellingPrice: null, sellingCostPct: 0,
      nrvUnit: null, writeDownUnit: null, writeDown: null, status: "no-basis",
    },
  ],
  totals: { items: 3, itemsWithBasis: 2, noBasisCount: 1, impairedItems: 1, inventoryValue: 288, writeDown: 50 },
  basis: { vatRatePct: 15, sellingCostPct: 0, costSource: "item-wac", warehouseId: null, asOf: "2026-09-06T08:00:00.000Z" },
};

const BELOW_COST_ROW = {
  menuId: "MENU-1", productName: "خبز", productNameEn: "Bread",
  netSellingPrice: 10, unitCost: 12, costSource: "recipe", shortfallUnit: 2, marginPct: -20,
  soldQty: null, exposure: null, status: "below-cost",
};

const BELOW_COST_NO_SOURCE = {
  success: true,
  data: [BELOW_COST_ROW, { ...BELOW_COST_ROW, menuId: "MENU-FREE", productName: "عيّنة", netSellingPrice: 0, shortfallUnit: 12, marginPct: null }],
  totals: { products: 2, noCostCount: 3, exposure: null },
  basis: { vatRatePct: 15, days: 30, salesSource: null, salesMeasure: null, salesFrom: null, asOf: "2026-09-06T08:00:00.000Z" },
};

const BELOW_COST_WITH_SOURCE = {
  success: true,
  data: [{ ...BELOW_COST_ROW, soldQty: 0, exposure: 0 }, { ...BELOW_COST_ROW, menuId: "MENU-2", productName: "كعكة", costSource: "bom", unitCost: 35, netSellingPrice: 30, shortfallUnit: 5, marginPct: -16.67, soldQty: 12, exposure: 60 }],
  totals: { products: 2, noCostCount: 1, exposure: 60 },
  basis: { vatRatePct: 15, days: 60, salesSource: "analytics_daily_item", salesMeasure: "qty_sold - qty_returned", salesFrom: "2026-07-09", asOf: "2026-09-06T08:00:00.000Z" },
};

describe("NRV reports — registry", () => {
  it("both sit in the inventory-valuation group behind the roll-forward's own capability", () => {
    const rollForward = report("inventory-value-roll-forward");
    for (const id of ["inventory-nrv", "products-below-cost"]) {
      const entry = report(id);
      expect(entry.groupId).toBe("inventoryValue");
      // Borrowed, never widened: the exact capability the sibling carries.
      expect(entry.cap).toBe(rollForward.cap);
      expect(entry.csvName).toBe(id);
    }
  });

  it("declares the NRV columns, with the cost basis and the status named on every row", () => {
    expect(report("inventory-nrv").columns.map((column) => column.key)).toEqual([
      "itemName", "quantity", "unitCost", "costBasis", "inventoryValue", "basisProductName",
      "netSellingPrice", "nrvUnit", "writeDownUnit", "writeDown", "status",
    ]);
    const status = report("inventory-nrv").columns.find((column) => column.key === "status");
    expect(status?.format).toBe("status");
    expect(Object.keys(status?.labels ?? {}).sort()).toEqual(["impaired", "no-basis", "ok"]);
  });

  it("declares the below-cost columns, and never puts a nullable figure in a `count` cell", () => {
    const columns = report("products-below-cost").columns;
    expect(columns.map((column) => column.key)).toEqual([
      "productName", "netSellingPrice", "unitCost", "costSource", "shortfallUnit",
      "marginPct", "soldQty", "exposure", "salesSource",
    ]);
    // The engine's count cell renders a null as 0 (Number(null ?? 0)); the
    // nullable figures must go through a cell that prints "—" instead.
    for (const key of ["marginPct", "soldQty", "exposure"]) {
      expect(columns.find((column) => column.key === key)?.format, key).not.toBe("count");
    }
  });

  it("the warehouse picker is the one remote filter and opens over every warehouse", () => {
    const filters = report("inventory-nrv").filters;
    expect(filters).toHaveLength(1);
    const [warehouse] = filters;
    expect(warehouse.id).toBe("warehouse");
    expect(warehouse.kind).toBe("remote");
    // A falsy default would leave the engine waiting on the picker forever.
    expect(warehouse.defaultValue).toBeTruthy();
    expect(typeof warehouse.loadOptions).toBe("function");
  });

  it("the sales window is a 30/60/90-day select, 30 first", () => {
    const filters = report("products-below-cost").filters;
    expect(filters).toHaveLength(1);
    expect(filters[0].id).toBe("days");
    expect(filters[0].kind).toBe("select");
    expect(filters[0].options?.map((option) => option.value)).toEqual(["30", "60", "90"]);
  });
});

describe("NRV reports — every label resolves in both dictionaries", () => {
  beforeEach(() => get.mockReset());

  it("labels, descriptions, filters, options, columns, status maps and the loaders' totals", async () => {
    const paths = new Set<string>();
    for (const id of ["inventory-nrv", "products-below-cost"]) {
      const entry = report(id);
      paths.add(entry.labelKey);
      paths.add(entry.descriptionKey);
      for (const filter of entry.filters) {
        paths.add(filter.labelKey);
        for (const option of filter.options ?? []) paths.add(option.labelKey);
      }
      for (const column of entry.columns) {
        paths.add(column.labelKey);
        for (const key of Object.values(column.labels ?? {})) paths.add(key);
      }
    }
    // Totals are only known once a loader has run — run each over the fixture
    // that produces its FULL set of totals.
    get.mockResolvedValueOnce(NRV_BODY);
    for (const total of (await report("inventory-nrv").load({ warehouse: "*" })).totals ?? []) paths.add(total.labelKey);
    get.mockResolvedValueOnce(BELOW_COST_WITH_SOURCE);
    for (const total of (await report("products-below-cost").load({ days: "60" })).totals ?? []) paths.add(total.labelKey);

    expect(paths.size).toBeGreaterThan(30);
    for (const path of paths) {
      expect(typeof resolve(ar, path), `ar: ${path}`).toBe("string");
      expect(typeof resolve(en, path), `en: ${path}`).toBe("string");
    }
  });
});

describe("NRV reports — loaders", () => {
  beforeEach(() => get.mockReset());
  afterEach(() => {
    document.documentElement.lang = "";
  });

  it("the warehouse picker lists every warehouse after the all-warehouses choice, in the page's language", async () => {
    const warehouses = {
      success: true,
      data: [
        { id: "WH-A", code: "A", name: "المستودع الرئيسي", nameEn: "Main warehouse", isActive: true },
        { id: "WH-B", code: "B", name: "", nameEn: "", isActive: true },
      ],
    };
    get.mockResolvedValue(warehouses);
    const load = report("inventory-nrv").filters[0].loadOptions!;

    const arabic = await load();
    expect(get).toHaveBeenCalledWith("/inventory/v2/warehouses", expect.anything());
    expect(arabic.map((option) => option.value)).toEqual(["*", "WH-A", "WH-B"]);
    expect(arabic[0].label).toBe(ar.operationalReports.filter.allWarehouses);
    expect(arabic[1].label).toBe("المستودع الرئيسي");
    // A warehouse with no name still has to be pickable: code, then id.
    expect(arabic[2].label).toBe("B");

    document.documentElement.lang = "en";
    const english = await load();
    expect(english[0].label).toBe(en.operationalReports.filter.allWarehouses);
    expect(english[1].label).toBe("Main warehouse");
  });

  it("NRV: keeps a missing figure null, names the cost basis on every row, and sends no warehouse for the all choice", async () => {
    get.mockResolvedValue(NRV_BODY);
    const result = await report("inventory-nrv").load({ warehouse: "*" });

    const [path, options] = get.mock.calls[0];
    expect(path).toBe("/erp/reports/inventory-value/nrv");
    // "*" is the picker's choice, not a warehouse — the client drops an empty
    // param, so the server answers over every warehouse.
    expect((options as { params: Record<string, string> }).params.warehouseId).toBe("");

    expect(result.rows.map((row) => row.id)).toEqual(["ITEM-OK", "ITEM-IMPAIRED", "ITEM-NOBASIS"]);
    const impaired = result.rows[1];
    expect(impaired).toMatchObject({
      itemName: "زبدة", quantity: 5, unitCost: 40, costBasis: "item-wac", inventoryValue: 200,
      basisProductName: "خبز", netSellingPrice: 40, nrvUnit: 30, writeDownUnit: 10, writeDown: 50, status: "impaired",
    });
    const noBasis = result.rows[2];
    expect(noBasis.status).toBe("no-basis");
    expect(noBasis.costBasis).toBe("item-wac");
    // The whole point: null, not 0 — a zero write-down would read "fully recoverable".
    for (const key of ["basisProductName", "netSellingPrice", "nrvUnit", "writeDownUnit", "writeDown"]) {
      expect(noBasis[key], key).toBeNull();
    }

    expect(result.totals).toEqual([
      { labelKey: "operationalReports.col.inventoryValue", value: 288, format: "money" },
      { labelKey: "operationalReports.col.writeDown", value: 50, format: "money" },
      { labelKey: "operationalReports.total.itemsWithBasis", value: 2, format: "count" },
      { labelKey: "operationalReports.total.noBasisCount", value: 1, format: "count" },
      { labelKey: "operationalReports.total.impairedItems", value: 1, format: "count" },
      { labelKey: "operationalReports.total.vatRatePct", value: 15, format: "count" },
      { labelKey: "operationalReports.total.sellingCostPct", value: 0, format: "count" },
    ]);
  });

  it("NRV: a chosen warehouse is sent as-is and its basis is printed on every row", async () => {
    get.mockResolvedValue({
      ...NRV_BODY,
      data: [NRV_BODY.data[1]],
      totals: { items: 1, itemsWithBasis: 1, noBasisCount: 0, impairedItems: 1, inventoryValue: 200, writeDown: 50 },
      basis: { ...NRV_BODY.basis, costSource: "warehouse-wac", warehouseId: "WH-A" },
    });
    const result = await report("inventory-nrv").load({ warehouse: "WH-A" });
    expect((get.mock.calls[0][1] as { params: Record<string, string> }).params.warehouseId).toBe("WH-A");
    expect(result.rows[0].costBasis).toBe("warehouse-wac");
  });

  it("NRV: withholds the write-down total when no row has a basis — 0 over an empty set is not 'nothing impaired'", async () => {
    get.mockResolvedValue({
      ...NRV_BODY,
      data: [NRV_BODY.data[2]],
      totals: { items: 1, itemsWithBasis: 0, noBasisCount: 1, impairedItems: 0, inventoryValue: 28, writeDown: 0 },
    });
    const result = await report("inventory-nrv").load({ warehouse: "*" });
    const keys = (result.totals ?? []).map((total) => total.labelKey);
    expect(keys).toContain("operationalReports.col.inventoryValue");
    expect(keys).not.toContain("operationalReports.col.writeDown");
    expect(result.totals?.find((total) => total.labelKey === "operationalReports.total.noBasisCount")?.value).toBe(1);
  });

  it("below cost, no sales source: units sold, exposure and the source stay null and the exposure total is withheld", async () => {
    get.mockResolvedValue(BELOW_COST_NO_SOURCE);
    const result = await report("products-below-cost").load({ days: "30" });

    const [path, options] = get.mock.calls[0];
    expect(path).toBe("/erp/reports/inventory-value/products-below-cost");
    expect((options as { params: Record<string, string> }).params).toEqual({ days: "30" });

    expect(result.rows[0]).toMatchObject({
      id: "MENU-1", productName: "خبز", netSellingPrice: 10, unitCost: 12, costSource: "recipe",
      shortfallUnit: 2, marginPct: -20, soldQty: null, exposure: null, salesSource: null,
    });
    // Margin on a zero price is undefined: null, never 0%.
    expect(result.rows[1].marginPct).toBeNull();

    expect(result.totals).toEqual([
      { labelKey: "operationalReports.total.products", value: 2, format: "count" },
      { labelKey: "operationalReports.total.noCostCount", value: 3, format: "count" },
      { labelKey: "operationalReports.total.salesWindowDays", value: 30, format: "count" },
      { labelKey: "operationalReports.total.vatRatePct", value: 15, format: "count" },
    ]);
  });

  it("below cost, with a sales source: a real 0 sold stays 0, the source is named per row, and exposure totals", async () => {
    get.mockResolvedValue(BELOW_COST_WITH_SOURCE);
    const result = await report("products-below-cost").load({ days: "60" });

    expect(result.rows[0]).toMatchObject({ soldQty: 0, exposure: 0, salesSource: "analytics_daily_item" });
    expect(result.rows[1]).toMatchObject({ costSource: "bom", unitCost: 35, marginPct: -16.67, soldQty: 12, exposure: 60 });
    expect(result.totals).toEqual([
      { labelKey: "operationalReports.total.products", value: 2, format: "count" },
      { labelKey: "operationalReports.total.noCostCount", value: 1, format: "count" },
      { labelKey: "operationalReports.col.exposure", value: 60, format: "money" },
      { labelKey: "operationalReports.total.salesWindowDays", value: 60, format: "count" },
      { labelKey: "operationalReports.total.vatRatePct", value: 15, format: "count" },
    ]);
  });

  it("an HTTP-200 { success:false } is thrown, never rendered as an empty valuation", async () => {
    get.mockResolvedValue({ success: false, error: "تعذّر قراءة الإعدادات" });
    await expect(report("inventory-nrv").load({ warehouse: "*" })).rejects.toThrow("تعذّر قراءة الإعدادات");
  });
});
