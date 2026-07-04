import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchableEntityCombobox, type EntityFetcher } from "../SearchableEntityCombobox";

interface Row { id: string; name: string; sku: string }
const ROWS: Row[] = [
  { id: "A", name: "أرز بسمتي", sku: "RICE-1" },
  { id: "B", name: "سكر أبيض", sku: "SUGAR-1" },
];
function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
function comboBox(fetcher: EntityFetcher<Row>, onChange = vi.fn()) {
  return wrap(
    <SearchableEntityCombobox<Row>
      value={null}
      onChange={onChange}
      fetcher={fetcher}
      queryKey={["test"]}
      getKey={(r) => r.id}
      getLabel={(r) => r.name}
      getSublabel={(r) => r.sku}
      ariaLabel="بحث تجريبي"
    />,
  );
}

describe("SearchableEntityCombobox", () => {
  it("prompts to type before any query, then server-searches and lists results", async () => {
    const fetcher: EntityFetcher<Row> = vi.fn(async ({ q }) => ({ items: ROWS.filter((r) => r.name.includes(q)), nextPage: null, total: 1 }));
    const onChange = vi.fn();
    comboBox(fetcher, onChange);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.getByText(/اكتب للبحث/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "أرز" } });
    // after debounce the fetcher runs and the option appears
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
    expect(fetcher).toHaveBeenCalled();
    fireEvent.click(screen.getByText("أرز بسمتي"));
    expect(onChange).toHaveBeenCalledWith(ROWS[0]);
  });

  it("keyboard: ArrowDown + Enter selects the active option", async () => {
    const fetcher: EntityFetcher<Row> = async () => ({ items: ROWS, nextPage: null, total: 2 });
    const onChange = vi.fn();
    comboBox(fetcher, onChange);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "س" } });
    await waitFor(() => expect(screen.getByText("سكر أبيض")).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // move to index 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(ROWS[1]);
  });

  it("shows an empty state when the server returns no rows", async () => {
    const fetcher: EntityFetcher<Row> = async () => ({ items: [], nextPage: null, total: 0 });
    comboBox(fetcher);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "xyz" } });
    await waitFor(() => expect(screen.getByText(/لا نتائج مطابقة/)).toBeInTheDocument(), { timeout: 2000 });
  });

  it("shows an error + retry when the fetcher rejects", async () => {
    const fetcher: EntityFetcher<Row> = async () => { throw new Error("boom"); };
    comboBox(fetcher);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "أرز" } });
    await waitFor(() => expect(screen.getByText(/إعادة المحاولة/)).toBeInTheDocument(), { timeout: 2000 });
  });
});
