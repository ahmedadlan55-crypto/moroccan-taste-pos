import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/i18n";

const mutations = vi.hoisted(() => ({ post: vi.fn(), reverse: vi.fn() }));

vi.mock("@/app/providers", () => ({ useCan: () => true }));

vi.mock("../salesPosting/api", () => ({
  GRANULARITIES: ["daily", "monthly"],
  usePendingBatches: () => ({
    isLoading: false,
    data: {
      batches: [{
        key: "2026-08-26",
        label: "26 Aug 2026",
        granularity: "daily",
        brandId: null,
        branchId: null,
        journalDate: "2026-08-26",
        itemCount: 2,
        salesCount: 1,
        returnCount: 1,
        net: 100,
        tax: 15,
        gross: 115,
        cogs: 40,
        queueIds: [1, 2],
        sources: [
          { id: 1, type: "sale", sourceId: "sale-1", invoiceNumber: "INV-1", gross: 130 },
          { id: 2, type: "return", sourceId: "return-1", invoiceNumber: "CN-1", gross: -15 },
        ],
        legs: [
          { accountCode: "111100", debit: 115, credit: 0, warehouseId: null },
          { accountCode: "411100", debit: 0, credit: 115, warehouseId: null },
        ],
        balanced: true,
        warnings: [],
        postable: true,
      }],
      totals: { batches: 1, items: 2, net: 100, tax: 15, gross: 115, blocked: 0 },
    },
  }),
  usePostedBatches: () => ({
    isLoading: false,
    data: {
      batches: [{
        id: "batch-1",
        granularity: "monthly",
        bucket_key: "2026-08",
        journal_date: "2026-08-31",
        journal_id: "journal-1",
        journal_number: "JV-000001",
        status: "posted",
        item_count: 2,
        net_amount: 100,
        tax_amount: 15,
        gross_amount: 115,
        cogs_amount: 40,
        posted_by: "admin",
        posted_at: "2026-08-31T12:00:00Z",
        reversed_at: null,
        reversed_by: null,
        reverse_reason: null,
      }],
    },
  }),
  useHealth: () => ({ isLoading: false, data: { problems: [] } }),
  usePostBatch: () => ({ isPending: false, mutate: mutations.post }),
  useReverseBatch: () => ({ isPending: false, mutate: mutations.reverse }),
}));

import { SalesPostingPage } from "../pages/SalesPosting";

describe("SalesPostingPage bilingual UI", () => {
  beforeEach(() => {
    localStorage.setItem("erp_lang", "en");
    mutations.post.mockReset();
    mutations.reverse.mockReset();
  });

  it("renders the complete posting workflow in English and preserves its actions", () => {
    render(<I18nProvider><SalesPostingPage /></I18nProvider>);

    expect(screen.getByRole("heading", { level: 1, name: "Sales posting" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Pending" })).toBeChecked();
    expect(screen.getByText("Grouping")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Daily" })).toBeChecked();
    expect(screen.getByText("Batches")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "26 Aug 2026" }));
    expect(screen.getByText("Proposed journal entry")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Debit")).toBeInTheDocument();
    expect(screen.getByText("Credit")).toBeInTheDocument();
    expect(screen.getByText("Invoices (2)")).toBeInTheDocument();
    expect(screen.getByText("Return")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Issues" }));
    expect(screen.getByText(/No issues — every sale is in the posting queue/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Posted batches" }));
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    expect(screen.getByLabelText("Reversal reason (recorded in the journal entry)")).toBeInTheDocument();

    expect(screen.queryByText("معلّق")).not.toBeInTheDocument();
    expect(screen.queryByText("القيد المقترح")).not.toBeInTheDocument();
  });
});
