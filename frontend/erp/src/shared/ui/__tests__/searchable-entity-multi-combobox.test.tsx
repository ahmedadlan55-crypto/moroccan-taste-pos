import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchableEntityMultiCombobox } from "@/shared/ui";

interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = [
  { id: "1", name: "أرز" },
  { id: "2", name: "سكر" },
  { id: "3", name: "دقيق" },
];
const fetcher = async () => ({ items: ROWS, nextPage: null, total: ROWS.length });

function Harness() {
  const [value, setValue] = useState<Row[]>([]);
  return (
    <SearchableEntityMultiCombobox<Row>
      value={value}
      onChange={setValue}
      fetcher={fetcher}
      queryKey={["multi-test"]}
      getKey={(r) => r.id}
      getLabel={(r) => r.name}
      ariaLabel="اختيار متعدد"
    />
  );
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("SearchableEntityMultiCombobox", () => {
  it("toggles multiple rows into removable chips (list stays open) and back", async () => {
    renderHarness();
    fireEvent.focus(screen.getByRole("combobox", { name: "اختيار متعدد" }));

    const rice = await screen.findByRole("option", { name: /أرز/ });
    const sugar = await screen.findByRole("option", { name: /سكر/ });

    fireEvent.click(rice);
    fireEvent.click(sugar);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /أرز/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("option", { name: /سكر/ })).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByRole("button", { name: "إزالة أرز" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إزالة سكر" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "إزالة أرز" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "إزالة أرز" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "إزالة سكر" })).toBeInTheDocument();
  });

  it("adds all visible results at once", async () => {
    renderHarness();
    fireEvent.focus(screen.getByRole("combobox", { name: "اختيار متعدد" }));

    const addAll = await screen.findByRole("button", { name: /إضافة كل النتائج الظاهرة/ });
    fireEvent.click(addAll);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "إزالة أرز" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "إزالة سكر" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "إزالة دقيق" })).toBeInTheDocument();
    });
  });
});
