import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import type { ItemDetail } from "@/modules/inventory/lib/adapters/item.adapter";
import { UnitsTab } from "../UnitsTab";
import { BarcodesTab } from "../BarcodesTab";

const mocks = vi.hoisted(() => {
  const unitData = {
    item: { id: "item-1", name: "Coffee", unit: "Piece", version: 4 },
    hasMovements: false,
    units: [
      {
        id: "base",
        unitName: "Piece",
        unitCode: "PC",
        isBase: true,
        conversionToBase: 1,
        precision: 2,
        allowPurchase: true,
        allowReceipt: true,
        allowIssue: true,
        allowTransfer: true,
        allowStocktake: true,
        allowProduction: true,
        allowSale: true,
        isActive: true,
      },
      {
        id: "carton",
        unitName: "Carton",
        unitCode: "CTN",
        isBase: false,
        conversionToBase: 12,
        precision: 0,
        allowPurchase: true,
        allowReceipt: true,
        allowIssue: false,
        allowTransfer: true,
        allowStocktake: true,
        allowProduction: false,
        allowSale: false,
        isActive: true,
      },
    ],
  };
  return {
    unitData,
    refetchUnits: vi.fn(),
    saveUnits: vi.fn(),
    saveBarcodes: vi.fn(),
    lookupBarcode: vi.fn(),
  };
});

vi.mock("@/modules/inventory/lib/hooks/useItemUnits", () => ({
  useItemUnits: () => ({ data: mocks.unitData, isLoading: false, isError: false, error: null, refetch: mocks.refetchUnits }),
  useItemUnitsMutation: () => ({ mutate: mocks.saveUnits, isPending: false }),
}));

vi.mock("@/modules/inventory/lib/hooks/useItems", () => ({
  useItemMutations: () => ({ saveBarcodes: { mutate: mocks.saveBarcodes, isPending: false } }),
  lookupBarcode: mocks.lookupBarcode,
}));

vi.mock("@/modules/inventory/lib/permission-provider", () => ({ useCan: () => true }));

vi.mock("../barcodeLabel", () => ({
  code39Svg: () => "<svg xmlns='http://www.w3.org/2000/svg'/>",
  printBarcodeLabels: vi.fn(),
}));

const detail: ItemDetail = {
  id: "item-1",
  name: "Coffee",
  nameEn: "Coffee",
  sku: "COF-1",
  category: "Drinks",
  unit: "Piece",
  bigUnit: "Carton",
  convRate: 12,
  cost: 5,
  stock: 24,
  minStock: 2,
  maxStock: 60,
  active: true,
  kind: "raw",
  version: 4,
  defaultWarehouseId: "warehouse-1",
  description: "",
  notes: "",
  hasMovements: false,
  trackingMode: "none",
  barcode: "628100000001",
  barcodes: [{ id: "secondary", code: "628100000002", sizeVariant: "12 pack", isPrimary: false }],
  distribution: [],
  rules: [],
  movements: [],
  timeline: [],
};

function renderIn(lang: "ar" | "en", node: React.ReactNode) {
  window.localStorage.setItem("erp_lang", lang);
  return render(<I18nProvider>{node}</I18nProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("item units and barcodes bilingual UI", () => {
  it("renders UnitsTab completely in English with responsive 44px controls", () => {
    const { container } = renderIn("en", <UnitsTab itemId="item-1" baseUnitName="Piece" />);

    expect(screen.getByText("Base unit")).toBeInTheDocument();
    expect(screen.getByText("Major units")).toBeInTheDocument();
    expect(screen.getByText("Allowed uses")).toBeInTheDocument();
    expect(screen.getByLabelText("Purchasing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add unit" })).toHaveClass("w-full", "sm:w-auto");
    expect(screen.getByRole("button", { name: "Save units" })).toHaveClass("w-full", "sm:w-auto");
    for (const input of screen.getAllByRole("textbox")) expect(input).toHaveClass("min-h-11");
    expect(container.textContent).not.toMatch(/[\u0600-\u06ff]/);
    expect(container.querySelector('[dir="rtl"]')).toBeNull();
  });

  it("renders BarcodesTab in English, keeps actions touch-safe, and localizes validation", () => {
    const { container } = renderIn("en", <BarcodesTab detail={detail} onSaved={vi.fn()} />);

    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("New barcode (scan or type)")).toBeInTheDocument();
    expect(screen.getByText("Live scan test")).toBeInTheDocument();
    const primary = screen.getByRole("button", { name: "Primary barcode 628100000001" });
    expect(primary).toHaveClass("h-11", "w-11");
    expect(screen.getByRole("button", { name: "Delete barcode 628100000002" })).toHaveClass("min-h-11");

    fireEvent.change(screen.getByRole("textbox", { name: "New barcode" }), { target: { value: "628100000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Duplicate barcode in this list: 628100000001")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[\u0600-\u06ff]/);
    expect(container.querySelector('[dir="rtl"]')).toBeNull();
  });

  it("renders the same tabs in Arabic from the mirrored dictionary", () => {
    const units = renderIn("ar", <UnitsTab itemId="item-1" baseUnitName="قطعة" />);
    expect(screen.getByText("الوحدة الأساسية")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "حفظ الوحدات" })).toBeInTheDocument();
    units.unmount();

    renderIn("ar", <BarcodesTab detail={detail} onSaved={vi.fn()} />);
    expect(screen.getByText("أساسي")).toBeInTheDocument();
    expect(screen.getByText("اختبار مسح مباشر")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "حفظ الباركودات" })).toBeInTheDocument();
  });
});
