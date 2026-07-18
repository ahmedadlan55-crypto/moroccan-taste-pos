/**
 * Customer add + history (close/b2-pos-daily) — legacy contract fidelity:
 *   • CustomerAddDialog POSTs the EXACT legacy /api/erp/customers body
 *     (doSave :1808) and auto-attaches via onCreated,
 *   • validation mirrors doSave's guards (:1820-1822),
 *   • invoiceBadge mirrors the history modal's status logic (:1444-1456),
 *   • CustomerPicker: «عميل جديد» affordance + linked-customer totals strip
 *     with the السجل entry point.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerAddDialog, validateNewCustomer } from "../dialogs/CustomerAddDialog";
import { invoiceBadge } from "../dialogs/CustomerHistoryDialog";
import { CustomerPicker } from "../CustomerPicker";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok, status, headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

describe("validateNewCustomer — legacy doSave guards", () => {
  it("requires name, phone, and ≥5 phone chars", () => {
    expect(validateNewCustomer("", "0501234567")).toMatch(/اسم/);
    expect(validateNewCustomer("محمد", "")).toMatch(/الهاتف/);
    expect(validateNewCustomer("محمد", "123")).toMatch(/قصير/);
    expect(validateNewCustomer("محمد", "0501234567")).toBeNull();
  });
});

describe("CustomerAddDialog", () => {
  it("POSTs the legacy body (id:'' = INSERT) and auto-attaches via onCreated", async () => {
    const fetchFn = stubFetch({ success: true, id: "CUST-1752" });
    const onCreated = vi.fn();
    render(<CustomerAddDialog open onClose={() => {}} onCreated={onCreated} prefill={{ name: "سعاد", phone: "0509998887" }} />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ وربط/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "CUST-1752", name: "سعاد", phone: "0509998887" }));

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/erp/customers");
    const body = JSON.parse(String(init.body));
    // The EXACT legacy doSave contract — id:'' means INSERT.
    expect(body).toMatchObject({ id: "", name: "سعاد", phone: "0509998887", customerType: "B2C", gender: "unknown", creditLimit: 0 });
  });

  it("blocks locally on invalid input — no network call", async () => {
    const fetchFn = stubFetch({ success: true, id: "X" });
    const onCreated = vi.fn();
    render(<CustomerAddDialog open onClose={() => {}} onCreated={onCreated} prefill={{ name: "بدون هاتف" }} />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ وربط/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("رقم الهاتف مطلوب");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("duplicate phone → server message + «استدعاء العميل الموجود» shortcut", async () => {
    stubFetch({ success: false, error: "رقم الهاتف مسجل لعميل آخر" });
    const onRecall = vi.fn();
    render(
      <CustomerAddDialog open onClose={() => {}} onCreated={vi.fn()} onRecallExisting={onRecall}
        prefill={{ name: "مكرر", phone: "0501112223" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /حفظ وربط/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("رقم الهاتف مسجل");
    fireEvent.click(screen.getByRole("button", { name: /استدعاء العميل الموجود/ }));
    expect(onRecall).toHaveBeenCalledWith("0501112223");
  });
});

describe("invoiceBadge — legacy status mapping", () => {
  it("maps every legacy branch", () => {
    expect(invoiceBadge({ zatcaType: "cancellation", hasCreditNote: false }).label).toBe("ملغاة");
    expect(invoiceBadge({ zatcaType: "credit_note", hasCreditNote: false }).label).toBe("مرتجع");
    expect(invoiceBadge({ zatcaType: "debit_note", hasCreditNote: false }).label).toBe("تعديل");
    expect(invoiceBadge({ zatcaType: "simplified", hasCreditNote: true }).label).toBe("مرتجع جزئياً");
    expect(invoiceBadge({ zatcaType: "simplified", hasCreditNote: false }).label).toBe("مكتملة");
  });
});

describe("CustomerPicker — new affordances", () => {
  function renderPicker(value: { id: string; name: string | null; phone: string | null } | null = null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <CustomerPicker value={value} onChange={onChange} />
      </QueryClientProvider>,
    );
    return onChange;
  }

  it("shows the «عميل جديد» affordance under the search list", async () => {
    stubFetch({ success: true, data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    renderPicker();
    expect(await screen.findByRole("button", { name: /عميل جديد/ })).toBeInTheDocument();
  });

  it("linked customer: totals strip (من /summary) + السجل + unlink", async () => {
    stubFetch({
      success: true,
      customer: { id: "C9", name: "هند", nameEn: "", phone: "0551112223", email: "", gender: "unknown", customerType: "B2C", balance: 0, creditLimit: 0, createdAt: "", isActive: true },
      kpi: { orderCount: 7, totalSpent: 1234.5, avgInvoice: 176.36, firstVisit: null, lastVisit: null },
      recentInvoices: [],
    });
    const onChange = renderPicker({ id: "C9", name: "هند", phone: "0551112223" });
    // the always-visible totals strip
    expect(await screen.findByText("1,234.50")).toBeInTheDocument();
    // السجل entry point exists
    expect(screen.getByRole("button", { name: "سجل العميل" })).toBeInTheDocument();
    // unlink still works
    fireEvent.click(screen.getByRole("button", { name: "مسح العميل" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
