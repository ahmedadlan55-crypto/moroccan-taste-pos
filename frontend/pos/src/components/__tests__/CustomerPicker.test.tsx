import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerPicker } from "../CustomerPicker";

const PAGE = {
  success: true,
  data: [
    { id: "C1", name: "شركة الأفق", phone: "0551234567", creditLimit: 5000, balance: 1250.5, derived: { arBalance: 1250.5 }, isActive: true },
    { id: "C2", name: "أحمد التاجر", phone: "0509876543", creditLimit: 0, balance: 0, derived: { arBalance: 0 }, isActive: true },
  ],
  pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
};

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  })) as unknown as typeof fetch);
}

function renderPicker(onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><CustomerPicker value={null} onChange={onChange} /></QueryClientProvider>);
  return onChange;
}

describe("CustomerPicker (POS ↔ Order-to-Cash)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the FIRST PAGE of customers on open — before any typing", async () => {
    stubFetch(PAGE);
    renderPicker();
    expect(await screen.findByText("شركة الأفق")).toBeInTheDocument();
    expect(screen.getByText("أحمد التاجر")).toBeInTheDocument();
  });

  it("resolves a real customerId when a row is picked", async () => {
    stubFetch(PAGE);
    const onChange = renderPicker();
    const row = await screen.findByText("شركة الأفق");
    fireEvent.click(row);
    expect(onChange).toHaveBeenCalledWith({ id: "C1", name: "شركة الأفق", phone: "0551234567" });
  });

  it("renders credit info with English digits (no ٠-٩)", async () => {
    stubFetch(PAGE);
    renderPicker();
    const sub = await screen.findByText(/المتاح/);
    expect(/[٠-٩]/.test(sub.textContent || "")).toBe(false);
    expect(sub.textContent).toMatch(/3,?749\.50|3749\.50/); // 5000 - 1250.50
  });

  it("surfaces an error + retry when the search fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ success: false, error: "boom" }) })) as unknown as typeof fetch);
    renderPicker();
    await waitFor(() => expect(screen.getByText(/تعذّر تحميل العملاء/)).toBeInTheDocument());
    expect(screen.getByText(/إعادة المحاولة/)).toBeInTheDocument();
  });
});
