import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ar } from "@/i18n/dictionaries/ar";
import { Combobox } from "@/shared/ui/combobox";
import { AttachmentViewer } from "@/shared/ui/file-uploader";
import { SearchableEntityCombobox } from "@/shared/ui/searchable-entity-combobox";

describe("shared compact touch targets", () => {
  it("gives every attachment remove action a named 44px target", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentViewer
        attachments={[{ id: "invoice", name: "invoice.pdf" }]}
        onRemove={onRemove}
      />,
    );

    const remove = screen.getByRole("button", {
      name: ar.sharedUi.fileUploader.remove.replace("{name}", "invoice.pdf"),
    });
    expect(remove).toHaveClass("h-11", "w-11");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("invoice");
  });

  it("renders a clearable Combobox as sibling buttons instead of nested interactive controls", () => {
    const onChange = vi.fn();
    render(
      <Combobox
        aria-label="Status"
        options={[{ value: "active", label: "Active" }]}
        value="active"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Status" });
    const clear = screen.getByRole("button", { name: ar.sharedUi.combobox.clear });
    expect(trigger.contains(clear)).toBe(false);
    expect(clear).toHaveClass("h-11", "w-11");
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps the selected entity clear action at a non-overlapping 44px target", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    const selected = { id: "supplier-1", name: "Supplier One" };

    render(
      <QueryClientProvider client={queryClient}>
        <SearchableEntityCombobox
          value={selected}
          onChange={onChange}
          fetcher={async () => ({ items: [], nextPage: null, total: 0 })}
          queryKey={["touch-target-entity"]}
          getKey={(row) => row.id}
          getLabel={(row) => row.name}
        />
      </QueryClientProvider>,
    );

    const clear = screen.getByRole("button", { name: ar.sharedUi.entityCombobox.clearSelected });
    expect(clear).toHaveClass("h-11", "w-11");
    expect(clear).not.toHaveClass("-my-2");
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
