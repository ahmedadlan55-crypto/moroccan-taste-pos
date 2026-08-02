/**
 * Unified inventory operations centre — hub list + full-page document detail.
 *
 * The apiClient mock is URL-ROUTED (not one canned payload): the hub reads
 * `/inventory/operations/meta` for its vocabulary and `/inventory/operations`
 * for its rows, and the detail route reads `/inventory/operations/:type/:id`.
 * A single blanket payload would let a screen "pass" while reading the wrong
 * endpoint entirely.
 *
 * `lastListParams` captures what actually went ON THE WIRE, so the tab test
 * proves the TYPE FILTER reached the server instead of proving a client-side
 * array was sliced — which is exactly the bug server-side pagination exists to
 * prevent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import { ar } from "@/i18n/dictionaries/ar";

const state = vi.hoisted(() => ({
  /** Flip to make GET /inventory/operations reject (ErrorState path). */
  listFails: false,
  /** The params object the hub last sent with the list request. */
  lastListParams: null as Record<string, unknown> | null,
}));

const META = vi.hoisted(() => ({
  success: true,
  data: {
    types: [
      { documentType: "receipt", label: "إذن استلام مخزني", capability: null, visible: true, available: true, twoSided: false, hasDocumentNumber: true, statuses: [{ raw: "draft", canonical: "draft" }] },
      { documentType: "issue", label: "إذن صرف مخزني", capability: null, visible: true, available: true, twoSided: false, hasDocumentNumber: true, statuses: [] },
      { documentType: "transfer", label: "تحويل مخزني", capability: null, visible: true, available: true, twoSided: true, hasDocumentNumber: true, statuses: [] },
      { documentType: "production", label: "أمر إنتاج", capability: null, visible: true, available: true, twoSided: true, hasDocumentNumber: true, statuses: [] },
      { documentType: "purchase_receipt", label: "استلام مشتريات", capability: "procurement.view", visible: true, available: true, twoSided: false, hasDocumentNumber: true, statuses: [] },
    ],
    canonicalStatuses: ["draft", "pending_approval", "approved", "in_progress", "posted", "partially_completed", "completed", "cancelled", "reversed"],
    sortable: ["date", "documentNumber", "status", "documentType", "totalValue", "createdAt"],
    maxPageSize: 100,
    currency: "SAR",
  },
}));

const ROWS = vi.hoisted(() => [
  {
    id: "receipt:R-1", documentType: "receipt", documentTypeLabel: "إذن استلام مخزني",
    documentId: "R-1", documentNumber: "RCV-0001", date: "2026-07-01",
    status: "pending_approval", rawStatus: "submitted",
    source: { kind: "gl_account", id: "5100", label: "حساب مقابل" },
    destination: { kind: "warehouse", id: "WH1", label: "المستودع الرئيسي" },
    partyLabel: null, productSummary: "طماطم (+2)", lineCount: 3, totalQuantity: 30,
    totalValue: 300, vatAmount: null, grossValue: 300, valueSigned: false, currency: "SAR",
    createdBy: "ahmed", createdByName: "أحمد", approvedBy: null, approvedByName: null,
    createdAt: "2026-07-01T08:00:00Z",
  },
  {
    id: "purchase_receipt:G-9", documentType: "purchase_receipt", documentTypeLabel: "استلام مشتريات",
    documentId: "G-9", documentNumber: "GRN-0009", date: "2026-07-02",
    status: "posted", rawStatus: "posted",
    source: { kind: "supplier", id: "SUP1", label: "مورد الخضار" },
    destination: { kind: "warehouse", id: "WH1", label: "المستودع الرئيسي" },
    partyLabel: "مورد الخضار", productSummary: "خيار", lineCount: 1, totalQuantity: 10,
    totalValue: 1000, vatAmount: 150, grossValue: 1150, valueSigned: false, currency: "SAR",
    createdBy: "sara", createdByName: "سارة", approvedBy: "ahmed", approvedByName: "أحمد",
    createdAt: "2026-07-02T08:00:00Z",
  },
  {
    id: "transfer:T-5", documentType: "transfer", documentTypeLabel: "تحويل مخزني",
    documentId: "T-5", documentNumber: "TRF-0005", date: "2026-07-03",
    status: "partially_completed", rawStatus: "partially_received",
    source: { kind: "warehouse", id: "WH1", label: "المستودع الرئيسي" },
    destination: { kind: "warehouse", id: "WH2", label: "مستودع الفرع" },
    partyLabel: null, productSummary: "أرز", lineCount: 2, totalQuantity: 20,
    totalValue: 500, vatAmount: null, grossValue: 500, valueSigned: false, currency: "SAR",
    createdBy: "ahmed", createdByName: "أحمد", approvedBy: null, approvedByName: null,
    createdAt: "2026-07-03T08:00:00Z",
  },
]);

const DETAIL = vi.hoisted(() => ({
  success: true,
  data: {
    id: "transfer:T-5", documentType: "transfer", documentTypeLabel: "تحويل مخزني",
    documentId: "T-5", documentNumber: "TRF-0005", date: "2026-07-03",
    status: "partially_completed", rawStatus: "partially_received",
    source: { kind: "warehouse", id: "WH1", label: "المستودع الرئيسي" },
    destination: { kind: "warehouse", id: "WH2", label: "مستودع الفرع" },
    partyLabel: null, productSummary: "أرز", lineCount: 1, totalQuantity: 20,
    totalValue: 500, vatAmount: null, grossValue: 500, valueSigned: false, currency: "SAR",
    createdBy: "ahmed", createdByName: "أحمد", approvedBy: null, approvedByName: null,
    createdAt: "2026-07-03T08:00:00Z",
  },
  header: { id: "T-5", attachments: '[{"name":"po-scan.pdf","url":"/files/po-scan.pdf"}]' },
  lines: [{ id: "L1", itemId: "INV1", itemName: "أرز بسمتي", unit: "كجم", qty: 20, unitCost: 25, lineTotal: 500 }],
  movements: [{ id: "M1", at: "2026-07-03T09:00:00Z", itemId: "INV1", itemName: "أرز بسمتي", type: "out", qty: 20, reason: "transfer", warehouseId: "WH1", referenceType: "transfer", referenceId: "T-5", actor: "ahmed", notes: null }],
  lots: [{ id: "LT1", lotId: "LOT-1", lotNumber: "B-2026-07", expiryDate: "2027-01-01", itemId: "INV1", warehouseId: "WH1", signedQty: -20, referenceType: "transfer", referenceId: "T-5", at: "2026-07-03T09:00:00Z" }],
  journals: [{
    id: "J1", journalNumber: "JV-1001", journalDate: "2026-07-03", totalDebit: 500, totalCredit: 500,
    referenceType: "transfer", description: "تحويل مخزني",
    entries: [
      { accountCode: "1310", accountName: "مخزون الفرع", debit: 500, credit: 0 },
      { accountCode: "1300", accountName: "مخزون رئيسي", debit: 0, credit: 500 },
    ],
  }],
  timeline: [{ action: "issue", fromStatus: "approved", toStatus: "issued", actor: "ahmed", note: null, at: "2026-07-03T09:00:00Z", synthetic: false }],
  capabilities: { requiredToView: null },
}));

function listPayload(types: string[]): unknown {
  const data = types.length ? ROWS.filter((r) => types.includes(r.documentType)) : ROWS;
  return {
    success: true,
    data,
    counts: { receipt: 1, purchase_receipt: 1, transfer: 1, issue: 0, production: 0 },
    pagination: { page: 1, pageSize: 25, total: data.length, totalPages: 1 },
    filters: {},
    includedTypes: types.length ? types : ["receipt", "issue", "transfer", "production", "purchase_receipt"],
    unavailableTypes: ["purchase_return"],
    deniedTypes: ["purchase_legacy"],
    scope: { allWarehousesAccess: true },
    generatedAt: "2026-08-01T00:00:00Z",
  };
}

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  const get = vi.fn((url: string, opts?: { params?: Record<string, unknown> }) => {
    if (url === "/inventory/operations/meta") return Promise.resolve(META);
    if (url === "/inventory/operations") {
      state.lastListParams = opts?.params ?? {};
      if (state.listFails) return Promise.reject(new Error("خادم المخزون لا يستجيب"));
      const raw = String(opts?.params?.types ?? "");
      return Promise.resolve(listPayload(raw ? raw.split(",") : []));
    }
    if (url.startsWith("/inventory/operations/")) return Promise.resolve(DETAIL);
    // Everything else the module's providers touch (access-scope, warehouses…).
    return Promise.resolve({
      data: [], rows: [], warehouses: [], accessibleWarehouses: [],
      allWarehousesAccess: true, capabilities: {},
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
    });
  });
  const noop = () => vi.fn().mockResolvedValue({});
  return { ...actual, apiClient: { get, post: noop(), put: noop(), patch: noop(), delete: noop() } };
});

import InventoryModule from "@/modules/inventory";

/** A label like «مشتريات (قديم)» carries regex metacharacters — escape before
 *  using it as a substring matcher, or the parentheses silently become a group. */
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <InventoryModule />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  state.listFails = false;
  state.lastListParams = null;
});

describe("operations hub — /inventory/operations", () => {
  it("lists MIXED document types in one table", async () => {
    renderAt("/inventory/operations");
    expect(await screen.findByText(ar.operations.title)).toBeInTheDocument();
    expect((await screen.findAllByText("RCV-0001")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("GRN-0009").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TRF-0005").length).toBeGreaterThan(0);
  });

  it("keeps «وارد مخزني» and «استلام مشتريات» distinct in the type column", async () => {
    renderAt("/inventory/operations");
    await screen.findAllByText("RCV-0001");
    // Two DIFFERENT inbound documents — collapsing them into one word is the
    // exact defect this assertion exists to catch.
    expect(screen.getAllByText(ar.operations.type.receipt).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ar.operations.type.purchase_receipt).length).toBeGreaterThan(0);
    expect(ar.operations.type.receipt).not.toBe(ar.operations.type.purchase_receipt);
  });

  it("renders canonical status labels from the DICTIONARY, not the raw server code", async () => {
    renderAt("/inventory/operations");
    await screen.findAllByText("RCV-0001");
    expect(screen.getAllByText(ar.operations.status.pending_approval).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ar.operations.status.partially_completed).length).toBeGreaterThan(0);
    // the raw codes must never reach the screen
    expect(screen.queryByText("pending_approval")).toBeNull();
    expect(screen.queryByText("partially_completed")).toBeNull();
  });

  it("tabs filter BY TYPE on the server (the type set goes on the wire)", async () => {
    renderAt("/inventory/operations");
    await screen.findAllByText("RCV-0001");

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(ar.operations.hub.tab.transfers) }));

    await waitFor(() => expect(state.lastListParams?.types).toBe("transfer"));
    await waitFor(() => expect(screen.queryAllByText("RCV-0001").length).toBe(0));
    expect(screen.getAllByText("TRF-0005").length).toBeGreaterThan(0);
  });

  it("says so when the server withheld document types", async () => {
    renderAt("/inventory/operations");
    await screen.findAllByText("RCV-0001");
    // deniedTypes → a capability note; unavailableTypes → a deployment note.
    // Both name the TYPE, so the user knows exactly what they are not seeing.
    expect(screen.getAllByText(rx(ar.operations.type.purchase_legacy)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(rx(ar.operations.type.purchase_return)).length).toBeGreaterThan(0);
  });

  it("renders ErrorState — NOT an empty table — when the list request fails", async () => {
    state.listFails = true;
    renderAt("/inventory/operations");
    await waitFor(() => expect(document.querySelector('[data-state="error"]')).toBeTruthy());
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(screen.queryByText(ar.operations.hub.empty.title)).toBeNull();
  });

  it("navigates to the full-page document route on a row click", async () => {
    renderAt("/inventory/operations");
    const cell = (await screen.findAllByText("TRF-0005"))[0];
    fireEvent.click(cell);
    // The detail page (a real route, not a drawer) takes over.
    expect(await screen.findByText(ar.operations.detail.section.movements)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.back)).toBeInTheDocument();
  });
});

describe("operations detail — /inventory/operations/:type/:id", () => {
  it("renders a DEEP LINK straight into the document, with every section", async () => {
    renderAt("/inventory/operations/transfer/T-5");
    expect(await screen.findByText(ar.operations.detail.section.summary)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.lines)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.movements)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.lots)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.journals)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.attachments)).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.section.timeline)).toBeInTheDocument();

    // real payload content, not just section chrome
    expect(screen.getAllByText("أرز بسمتي").length).toBeGreaterThan(0);
    expect(screen.getByText("JV-1001")).toBeInTheDocument();
    expect(screen.getByText("B-2026-07")).toBeInTheDocument();
    expect(screen.getByText("po-scan.pdf")).toBeInTheDocument();
    expect(screen.getByText(ar.operations.detail.timeline.action.issue)).toBeInTheDocument();
    // once in the header badge, once in the summary grid
    expect(screen.getAllByText(ar.operations.status.partially_completed).length).toBe(2);
  });

  it("a legacy ?view= drawer link redirects to the full-page route", async () => {
    renderAt("/inventory/transfers?view=T-5");
    expect(await screen.findByText(ar.operations.detail.section.journals)).toBeInTheDocument();
  });

  it("a half-written path is a not-found state, not a hollow document", async () => {
    renderAt("/inventory/operations/transfer");
    expect(await screen.findByText(ar.operations.detail.notFoundTitle)).toBeInTheDocument();
    expect(document.querySelector('[data-state="not-found"]')).toBeTruthy();
  });
});
