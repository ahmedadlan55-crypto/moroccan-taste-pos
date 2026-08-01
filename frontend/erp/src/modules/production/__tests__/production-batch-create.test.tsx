import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import { AuthProvider, PermissionProvider } from "@/app/providers";

/* ── fixtures ───────────────────────────────────────────────────────────────
   Wire shapes ONLY — every fixture below is what the backend really sends
   (routes/production-batches.js + /production-orders/boms), so a test that
   passes here cannot be passing against an invented envelope. */
const H = vi.hoisted(() => {
  const boms = [
    {
      id: "BOM-BREAD", product_id: "P-BREAD", version: 3,
      yield_quantity: 1, yield_unit: "كجم", product_name: "خبز",
      product_unit: "كجم", tracking_mode: "none", line_count: 2,
    },
    {
      id: "BOM-JUICE", product_id: "P-JUICE", version: 1,
      yield_quantity: 1, yield_unit: "لتر", product_name: "عصير",
      product_unit: "لتر", tracking_mode: "lot", line_count: 1,
    },
  ];
  const warehouses = [
    { id: "WH-MAIN", name: "المستودع الرئيسي", is_active: 1 },
    { id: "WH-OUT", name: "مستودع التشغيل", is_active: 1 },
  ];
  // ONE material needed by BOTH products — the attribution array is exactly the
  // per-product breakdown the create screen has to render.
  const preview = {
    success: true,
    data: {
      products: [
        { line: 0, bomId: "BOM-BREAD", productId: "P-BREAD", qtyPlanned: 10, warehouseId: "WH-MAIN", materialCost: 60 },
        { line: 1, bomId: "BOM-JUICE", productId: "P-JUICE", qtyPlanned: 4, warehouseId: "WH-MAIN", materialCost: 40 },
      ],
      materials: [
        {
          itemId: "ITM-SUGAR", itemName: "سكر", itemNameEn: "Sugar", unit: "كجم",
          trackingMode: "none", warehouseId: "WH-MAIN",
          required: 7, available: 20, delta: 13, status: "ok", unitCost: 10, lineCost: 70,
          attribution: [
            { line: 0, bomId: "BOM-BREAD", productId: "P-BREAD", qty: 5 },
            { line: 1, bomId: "BOM-JUICE", productId: "P-JUICE", qty: 2 },
          ],
        },
      ],
      summary: { productCount: 2, materialCount: 1, shortageCount: 0, allAvailable: true, totalMaterialCost: 70 },
    },
  };
  const batchDetail = {
    success: true,
    data: {
      id: "PBT-1", batchNumber: "PBT-20260801-0001", batchDate: "2026-08-01", status: "draft",
      warehouseId: "WH-MAIN", outputWarehouseId: "WH-OUT", notes: "", version: 1, childCount: 2,
      createdBy: "tester", createdAt: "2026-08-01T06:00:00Z", approvedBy: null, approvedAt: null,
      cancelledBy: null, cancelReason: null,
    },
    children: [
      {
        id: "POV2-a", orderNumber: "PRD-20260801-0001", lineNo: 0, bomId: "BOM-BREAD", bomVersion: 3,
        productId: "P-BREAD", productName: "خبز", productNameEn: "Bread", qtyPlanned: 10, qtyProduced: 0,
        qtyWaste: 0, status: "draft", warehouseId: "WH-MAIN", warehouseName: "المستودع الرئيسي",
        outputWarehouseId: "WH-OUT", outputWarehouseName: "مستودع التشغيل", wipBalance: 0, totalCost: 60,
        unitCost: 6, allowedScrapPct: null, batchNumber: null, version: 1,
      },
      {
        id: "POV2-b", orderNumber: "PRD-20260801-0002", lineNo: 1, bomId: "BOM-JUICE", bomVersion: 1,
        productId: "P-JUICE", productName: "عصير", productNameEn: "Juice", qtyPlanned: 4, qtyProduced: 0,
        qtyWaste: 0, status: "draft", warehouseId: "WH-MAIN", warehouseName: "المستودع الرئيسي",
        outputWarehouseId: "WH-OUT", outputWarehouseName: "مستودع التشغيل", wipBalance: 0, totalCost: 40,
        unitCost: 10, allowedScrapPct: 0, batchNumber: "L-1", version: 1,
      },
    ],
    materials: [
      {
        itemId: "ITM-SUGAR", itemName: "سكر", itemNameEn: "Sugar", unit: "كجم", warehouseId: "WH-MAIN",
        required: 7, issued: 0, remaining: 7, available: 20, shortage: 0, unitCost: 10,
        attribution: [
          { orderId: "POV2-a", orderNumber: "PRD-20260801-0001", productName: "خبز", qty: 5 },
          { orderId: "POV2-b", orderNumber: "PRD-20260801-0002", productName: "عصير", qty: 2 },
        ],
      },
    ],
    timeline: [
      { id: "EV-1", action: "create", from_status: null, to_status: "draft", actor: "tester", note: "", created_at: "2026-08-01T06:00:00Z" },
    ],
  };
  return { boms, warehouses, preview, batchDetail };
});

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  const get = vi.fn((path: string) => {
    if (path.includes("/production-orders/boms")) return Promise.resolve({ data: H.boms });
    if (path.includes("warehouses-summary")) return Promise.resolve({ warehouses: H.warehouses, totals: {} });
    if (/\/production-batches\/[^/]+$/.test(path)) return Promise.resolve(H.batchDetail);
    if (path.includes("access-scope"))
      return Promise.resolve({ capabilities: {}, accessibleWarehouses: [], allWarehousesAccess: true });
    return Promise.resolve({
      data: [], rows: [], warehouses: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
    });
  });
  return {
    ...actual,
    apiClient: { get, post: vi.fn().mockResolvedValue({ success: true }), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import ProductionModule from "@/modules/production";

/* ── transport double ───────────────────────────────────────────────────────
   `preview` and `create` are the two endpoints that answer with PER-LINE
   rejections, so the module talks to them directly (see lib/batchApi.ts) —
   stub fetch for those and assert against the REAL wire body. */
interface FetchCase {
  status: number;
  body: unknown;
}
let previewCase: FetchCase = { status: 200, body: H.preview };
let createCase: FetchCase = { status: 201, body: { success: true, data: { id: "PBT-1", batchNumber: "PBT-20260801-0001", children: [] } } };
let createCalls: unknown[] = [];

function response({ status, body }: FetchCase): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `x.${b64(payload)}.y`;
}

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

/** Mirrors app/router.tsx exactly: the manifest leaf owns its subtree, so the
 *  shell registers the exact path AND a `<path>/*` splat against this module. */
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <PermissionProvider>
            <MemoryRouter initialEntries={[path]}>
              <Probe />
              <Routes>
                <Route path="/inventory/production" element={<ProductionModule />} />
                <Route path="/inventory/production/*" element={<ProductionModule />} />
              </Routes>
            </MemoryRouter>
          </PermissionProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

async function addProduct(productName: string) {
  fireEvent.click(screen.getAllByRole("button", { name: "إضافة منتج" })[0]);
  const option = await screen.findByRole("button", { name: new RegExp(productName) });
  fireEvent.click(option);
}

function row(line: number): HTMLElement {
  return screen.getByLabelText(`سطر المنتج ${line}`);
}

/** Two complete rows + a source warehouse — the state every test needs. */
async function buildTwoRowDocument() {
  // The warehouse list arrives asynchronously; a controlled <select> silently
  // REFUSES a value whose <option> is not mounted yet, which would leave the
  // document without a source warehouse and every later assertion chasing a
  // preview that was never requested.
  const wh = screen.getByLabelText("مستودع المواد (المصدر)") as HTMLSelectElement;
  await waitFor(() => expect(within(wh).getByRole("option", { name: "المستودع الرئيسي" })).toBeInTheDocument());
  fireEvent.change(wh, { target: { value: "WH-MAIN" } });
  expect(wh.value).toBe("WH-MAIN");
  await addProduct("خبز");
  fireEvent.change(within(row(1)).getByLabelText("الكمية — خبز"), { target: { value: "10" } });
  await addProduct("عصير");
  fireEvent.change(within(row(2)).getByLabelText("الكمية — عصير"), { target: { value: "4" } });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    "pos_token",
    jwt({ username: "tester", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  previewCase = { status: 200, body: H.preview };
  createCase = { status: 201, body: { success: true, data: { id: "PBT-1", batchNumber: "PBT-20260801-0001", children: [] } } };
  createCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/production-batches/preview")) return response(previewCase);
      if (url.endsWith("/production-batches")) {
        createCalls.push(JSON.parse(String(init?.body ?? "{}")));
        return response(createCase);
      }
      return response({ status: 404, body: { success: false, error: "unmocked" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("production document — multi-product create page", () => {
  it("renders on a direct deep link to /inventory/production/new, and again after a refresh", async () => {
    renderAt("/inventory/production/new");
    expect(await screen.findByText("سند إنتاج جديد (عدة منتجات)")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/inventory/production/new");

    // A refresh is a fresh mount driven by the URL alone — no in-app navigation
    // and no surviving state. Re-rendering from scratch is exactly that.
    cleanup();
    renderAt("/inventory/production/new");
    expect(await screen.findByText("سند إنتاج جديد (عدة منتجات)")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/inventory/production/new");
  });

  it("redirects the retired ?new=1 and ?doc=<id> query forms onto the real URLs", async () => {
    renderAt("/inventory/production?new=1");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/inventory/production/new"));
    expect(await screen.findByText("سند إنتاج جديد (عدة منتجات)")).toBeInTheDocument();

    cleanup();
    renderAt("/inventory/production?doc=POV2-abc123");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/inventory/production/POV2-abc123"));

    cleanup();
    renderAt("/inventory/production?new=1&edit=POV2-abc123");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/inventory/production/POV2-abc123/edit"));
  });

  it("adds several product rows to the outputs table", async () => {
    renderAt("/inventory/production/new");
    await screen.findByText("سند إنتاج جديد (عدة منتجات)");

    await addProduct("خبز");
    await addProduct("عصير");

    expect(row(1)).toBeInTheDocument();
    expect(row(2)).toBeInTheDocument();
    expect(within(row(1)).getByText("خبز")).toBeInTheDocument();
    expect(within(row(2)).getByText("عصير")).toBeInTheDocument();
    // The BOM version travels with the row, per product.
    expect(within(row(1)).getByText("v3")).toBeInTheDocument();
    expect(within(row(2)).getByText("v1")).toBeInTheDocument();
  });

  it("leaves an untouched scrap allowance NULL and sends 0 only when the user typed 0", async () => {
    renderAt("/inventory/production/new");
    await screen.findByText("سند إنتاج جديد (عدة منتجات)");
    await buildTwoRowDocument();

    // Row 1 untouched → default policy. Row 2 explicitly zero → zero scrap.
    fireEvent.change(within(row(2)).getByLabelText("سماحية الهدر % — عصير"), { target: { value: "0" } });
    expect(within(row(1)).getByText("السياسة الافتراضية")).toBeInTheDocument();
    expect(within(row(2)).getByText("صفر هدر")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /إنشاء السند/ }));
    await waitFor(() => expect(createCalls).toHaveLength(1));
    const sent = createCalls[0] as { items: Array<{ allowedScrapPct: number | null }> };
    expect(sent.items[0].allowedScrapPct).toBeNull();
    expect(sent.items[1].allowedScrapPct).toBe(0);
  });

  it("shows each material once with its per-product attribution", async () => {
    renderAt("/inventory/production/new");
    await screen.findByText("سند إنتاج جديد (عدة منتجات)");
    await buildTwoRowDocument();

    // The consolidated material appears once per rendered layout (DataTable
    // keeps a desktop table AND a mobile card list mounted), never once per
    // product — that is the whole point of consolidating.
    const sugarCells = await screen.findAllByText("سكر");
    expect(sugarCells.length).toBeGreaterThan(0);

    // …and the per-product split is spelled out for BOTH products.
    expect((await screen.findAllByText(/^خبز: /)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/^عصير: /)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/كل المواد متوفرة/).length).toBeGreaterThan(0);
  });

  it("maps a server rejection's detail[].line back to the row that caused it", async () => {
    createCase = {
      status: 422,
      body: {
        success: false,
        code: "VALIDATION_ERROR",
        error: "بعض السطور غير صالحة — لم يُنشأ أي أمر",
        requestId: "req-1",
        // line 1 = the SECOND row (zero-based), i.e. عصير.
        detail: [{ line: 1, code: "VALIDATION_ERROR", message: "الوصفة بلا مكوّنات: BOM-JUICE" }],
      },
    };

    renderAt("/inventory/production/new");
    await screen.findByText("سند إنتاج جديد (عدة منتجات)");
    await buildTwoRowDocument();

    fireEvent.click(screen.getByRole("button", { name: /إنشاء السند/ }));

    const secondRow = await waitFor(() => {
      const r = row(2);
      expect(within(r).getByText("الوصفة بلا مكوّنات: BOM-JUICE")).toBeInTheDocument();
      return r;
    });
    expect(within(secondRow).getByText("سطر 2")).toBeInTheDocument();
    // …and NOT onto the innocent row.
    expect(within(row(1)).queryByText("الوصفة بلا مكوّنات: BOM-JUICE")).toBeNull();
    // No partial success is ever implied.
    expect(screen.getByRole("alert")).toHaveTextContent("رفض الخادم الطلب");
  });
});

describe("production document — detail page", () => {
  it("renders on a direct deep link to /inventory/production/batches/:id with children and attribution", async () => {
    renderAt("/inventory/production/batches/PBT-1");

    expect(await screen.findByText("PBT-20260801-0001")).toBeInTheDocument();
    // Every child order is its OWN production order — listed, not pooled.
    expect((await screen.findAllByText("PRD-20260801-0001")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("PRD-20260801-0002").length).toBeGreaterThan(0);
    // …and the consolidated material keeps its per-product split.
    expect(screen.getAllByText("سكر").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^خبز \(PRD-20260801-0001\): /).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^عصير \(PRD-20260801-0002\): /).length).toBeGreaterThan(0);
  });
});
