import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchableEntityCombobox, type EntityFetcher } from "../SearchableEntityCombobox";

interface Row { id: string; name: string; sku: string }
const ROWS: Row[] = [
  { id: "A", name: "أرز بسمتي", sku: "RICE-1" },
  { id: "B", name: "سكر أبيض", sku: "SUGAR-1" },
];
// a fetcher that server-filters by q (empty q → the whole first page)
function makeFetcher() {
  return vi.fn(async ({ q }: { q: string }) => ({
    items: ROWS.filter((r) => r.name.includes(q) || r.sku.includes(q)),
    nextPage: null,
    total: ROWS.length,
  })) as unknown as EntityFetcher<Row> & { mock: any };
}
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
  // THE regression the hotfix fixes: options must appear on open, no typing.
  it("opens with the first page on focus BEFORE any typing", async () => {
    const fetcher = makeFetcher();
    comboBox(fetcher);
    fireEvent.focus(screen.getByRole("combobox"));
    // both rows visible with an empty query — no 'type to search' prompt
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText("سكر أبيض")).toBeInTheDocument();
    expect(screen.queryByText(/اكتب للبحث/)).not.toBeInTheDocument();
    // the very first fetch fired with q === ''
    expect((fetcher as any).mock.calls[0][0].q).toBe("");
  });

  it("opens the list on mousedown (click) as well as focus", async () => {
    const fetcher = makeFetcher();
    comboBox(fetcher);
    fireEvent.mouseDown(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
  });

  it("narrows on typing, then returns to the first page when cleared", async () => {
    const fetcher = makeFetcher();
    comboBox(fetcher);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText("سكر أبيض")).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.change(input, { target: { value: "أرز" } });
    // await the settled narrowed state (a new query key briefly shows a spinner)
    await waitFor(() => {
      expect(screen.getByText("أرز بسمتي")).toBeInTheDocument();
      expect(screen.queryByText("سكر أبيض")).not.toBeInTheDocument();
    }, { timeout: 2000 });
    // clearing the text brings back the full first page
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("سكر أبيض")).toBeInTheDocument(), { timeout: 2000 });
  });

  it("renders the popup in a portal (document.body) and selects an option", async () => {
    const onChange = vi.fn();
    const fetcher = makeFetcher();
    comboBox(fetcher, onChange);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
    const listbox = screen.getByRole("listbox");
    // portal → the listbox is a direct child of <body>, not nested in the field
    expect(listbox.parentElement).toBe(document.body);
    fireEvent.click(screen.getByText("أرز بسمتي"));
    expect(onChange).toHaveBeenCalledWith(ROWS[0]);
  });

  it("keyboard: ArrowDown + Enter selects the active option", async () => {
    const onChange = vi.fn();
    const fetcher = makeFetcher();
    comboBox(fetcher, onChange);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText("سكر أبيض")).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // move to index 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(ROWS[1]);
  });

  it("reopens without showing a stale empty state", async () => {
    const onChange = vi.fn();
    const fetcher = makeFetcher();
    comboBox(fetcher, onChange);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    fireEvent.focus(input);
    // cached first page shows immediately — no empty flash
    await waitFor(() => expect(screen.getByText("أرز بسمتي")).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.queryByText(/لا نتائج مطابقة/)).not.toBeInTheDocument();
  });

  it("shows an empty state when the server returns no rows", async () => {
    const fetcher: EntityFetcher<Row> = async () => ({ items: [], nextPage: null, total: 0 });
    comboBox(fetcher);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText(/لا نتائج مطابقة/)).toBeInTheDocument(), { timeout: 2000 });
  });

  it("shows an error + retry when the fetcher rejects", async () => {
    const fetcher: EntityFetcher<Row> = async () => { throw new Error("boom"); };
    comboBox(fetcher);
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText(/إعادة المحاولة/)).toBeInTheDocument(), { timeout: 2000 });
  });
});
