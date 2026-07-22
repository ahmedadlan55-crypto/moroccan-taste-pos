// E1 — Journal Entries: prevention + parity tests.
//  · validateJournal (pure) → unbalanced / invalid account / min-2-lines / P&L
//    mandatory cost center.
//  · can() (pure) → create / post / reverse permission matrix.
//  · hooks (renderHook) → the exact legacy endpoints (list / reverse / post-flow).
//  · render → posted journals are read-only (RULE 1); attachments are surfaced.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// Controllable capability gate for the render tests (name must start with `mock`
// so Vitest allows referencing it inside the hoisted factory).
let mockCaps = new Set<string>();
vi.mock("@/app/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/providers")>();
  return { ...actual, useCan: (cap: string) => mockCaps.has(cap) };
});

import { apiClient } from "@/shared/api";
import { can, type SessionUser } from "@/app/permissions";
import { validateJournal, computeTotals } from "../journal/journalModel";
import { useJournals, useReverseJournal, usePostJournal, type Journal, type JournalLine } from "../api";
import { JournalEditor } from "../journal/JournalEditor";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";

const get = apiClient.get as Mock;
const post = apiClient.post as Mock;

function qcWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function line(p: Partial<JournalLine>): JournalLine {
  return {
    accountId: null,
    accountCode: "",
    accountName: "",
    accountType: "",
    debit: 0,
    credit: 0,
    description: "",
    costCenterId: null,
    costCenterName: "",
    ...p,
  };
}

function journal(p: Partial<Journal> & { id: string; status: Journal["status"] }): Journal {
  return {
    id: p.id,
    journalNumber: p.journalNumber ?? "JV-000001",
    journalDate: p.journalDate ?? "2026-01-10",
    referenceType: p.referenceType ?? "manual",
    referenceId: "",
    description: p.description ?? "قيد",
    notes: p.notes ?? "",
    totalDebit: p.totalDebit ?? 0,
    totalCredit: p.totalCredit ?? 0,
    status: p.status,
    createdBy: p.createdBy ?? "admin",
    approvedBy: p.approvedBy ?? "",
    postedBy: p.postedBy ?? "",
    attachment: p.attachment ?? null,
    brandId: null,
    branchId: null,
    projectId: null,
    costCenterId: null,
    reversedByJournalId: p.reversedByJournalId ?? null,
    reversesJournalId: null,
    entries: p.entries ?? [],
  };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  mockCaps = new Set();
});

describe("validateJournal — the prevention rules", () => {
  it("blocks an unbalanced entry", () => {
    const lines = [
      line({ accountId: "a1", accountType: "asset", debit: 100 }),
      line({ accountId: "a2", accountType: "asset", credit: 60 }),
    ];
    expect(validateJournal({ description: "x", lines, headerCostCenterId: null })).toMatch(/غير متوازن/);
  });

  it("blocks fewer than two lines that have an account", () => {
    const lines = [line({ accountId: "a1", accountType: "asset", debit: 100 }), line({ debit: 0 })];
    expect(validateJournal({ description: "x", lines, headerCostCenterId: null })).toMatch(/بندين/);
  });

  it("blocks a populated line that has no account selected (invalid account)", () => {
    const lines = [
      line({ accountId: "a1", accountType: "asset", debit: 100 }),
      line({ accountId: "a2", accountType: "asset", credit: 100 }),
      line({ description: "سطر بلا حساب" }), // populated (description) but no account
    ];
    expect(validateJournal({ description: "x", lines, headerCostCenterId: null })).toMatch(/اختر حسابًا/);
  });

  it("requires a cost center on P&L (revenue/expense) lines", () => {
    const lines = [
      line({ accountId: "a1", accountType: "asset", debit: 100 }),
      line({ accountId: "a2", accountType: "revenue", credit: 100 }),
    ];
    expect(validateJournal({ description: "x", lines, headerCostCenterId: null })).toMatch(/مركز التكلفة/);
  });

  it("accepts a P&L line when the header supplies the cost center", () => {
    const lines = [
      line({ accountId: "a1", accountType: "asset", debit: 100 }),
      line({ accountId: "a2", accountType: "revenue", credit: 100 }),
    ];
    expect(validateJournal({ description: "x", lines, headerCostCenterId: "cc-hdr" })).toBeNull();
  });

  it("accepts a well-formed, balanced entry", () => {
    const lines = [
      line({ accountId: "a1", accountType: "asset", debit: 100 }),
      line({ accountId: "a2", accountType: "revenue", credit: 100, costCenterId: "cc1" }),
    ];
    expect(validateJournal({ description: "بيع", lines, headerCostCenterId: null })).toBeNull();
  });

  it("computeTotals flags balance within a 0.01 tolerance", () => {
    expect(computeTotals([line({ debit: 100 }), line({ credit: 100 })]).balanced).toBe(true);
    expect(computeTotals([line({ debit: 100 }), line({ credit: 99 })]).balanced).toBe(false);
  });
});

describe("permission matrix — create / post / reverse", () => {
  const mk = (role: string): SessionUser => ({ username: role, role });

  it("an accountant may create + post but NOT reverse", () => {
    const u = mk("accountant");
    expect(can(u, "accounting.journals.create")).toBe(true);
    expect(can(u, "accounting.journals.post")).toBe(true);
    expect(can(u, "accounting.journals.reverse")).toBe(false);
  });

  it("finance may reverse", () => {
    expect(can(mk("finance"), "accounting.journals.reverse")).toBe(true);
  });

  it("an auditor may do none of the writes", () => {
    const u = mk("auditor");
    expect(can(u, "accounting.journals.create")).toBe(false);
    expect(can(u, "accounting.journals.post")).toBe(false);
    expect(can(u, "accounting.journals.reverse")).toBe(false);
  });

  it("admin may do everything, including manage accounts", () => {
    const u = mk("admin");
    expect(can(u, "accounting.journals.create")).toBe(true);
    expect(can(u, "accounting.journals.reverse")).toBe(true);
    expect(can(u, "accounting.accounts.manage")).toBe(true);
  });
});

describe("journal hooks hit the exact legacy endpoints", () => {
  it("list → GET /erp/gl/journals", async () => {
    get.mockResolvedValue([]);
    renderHook(() => useJournals({ status: "posted" }), { wrapper: qcWrapper() });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/erp/gl/journals",
        expect.objectContaining({ params: expect.anything() }),
      ),
    );
  });

  it("reverse → POST /erp/gl/journals/:id/reverse with the reason", async () => {
    post.mockResolvedValue({ success: true, newJournalNumber: "JV-000009" });
    const { result } = renderHook(() => useReverseJournal(), { wrapper: qcWrapper() });
    result.current.mutate({ id: "J1", reason: "خطأ" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/erp/gl/journals/J1/reverse", { reason: "خطأ" }),
    );
  });

  it("posting a draft chains approve then post", async () => {
    post.mockResolvedValue({ success: true });
    const { result } = renderHook(() => usePostJournal(), { wrapper: qcWrapper() });
    result.current.mutate({ id: "J2", status: "draft" });
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/erp/gl/journals/J2/approve", {});
      expect(post).toHaveBeenCalledWith("/erp/gl/journals/J2/post", {});
    });
  });
});

describe("posted journals are read-only (RULE 1)", () => {
  const posted = journal({
    id: "J9",
    journalNumber: "JV-000009",
    status: "posted",
    description: "قيد مُرحَّل",
    totalDebit: 100,
    totalCredit: 100,
    postedBy: "admin",
    entries: [
      { accountId: "a1", accountCode: "1101", accountName: "صندوق", debit: 100, credit: 0, description: "", costCenterId: null },
      { accountId: "a2", accountCode: "4101", accountName: "مبيعات", debit: 0, credit: 100, description: "", costCenterId: null },
    ],
  });

  it("shows the immutable banner, no save button, and a gated reverse action", async () => {
    mockCaps = new Set(["accounting.journals.reverse"]);
    renderWithProviders(<JournalEditor journal={posted} onDone={() => {}} />);
    expect(await screen.findByText(/مُرحَّل ومحفوظ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^حفظ$/ })).toBeNull();
    expect(screen.getByRole("button", { name: /عكس القيد/ })).toBeInTheDocument();
  });

  it("hides the reverse action from a user without the reverse cap", async () => {
    mockCaps = new Set(); // no caps
    renderWithProviders(<JournalEditor journal={posted} onDone={() => {}} />);
    expect(await screen.findByText(/مُرحَّل ومحفوظ/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /عكس القيد/ })).toBeNull();
  });
});

describe("attachments (lightweight)", () => {
  it("surfaces an existing attachment on an editable journal", async () => {
    mockCaps = new Set(["accounting.journals.create"]);
    get.mockResolvedValue([]); // brands / branches / projects / cost-centers / account search
    const draft = journal({
      id: "J3",
      status: "draft",
      description: "قيد بمرفق",
      attachment: "data:image/png;base64,AAAA",
    });
    renderWithProviders(<JournalEditor journal={draft} onDone={() => {}} />);
    expect(await screen.findByText("مرفق")).toBeInTheDocument();
  });
});
