import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

// Mock the shared API client while keeping the real ApiError (states.tsx needs it).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { apiClient } from "@/shared/api";
import { I18nProvider } from "@/i18n";
import { TrialBalancePage } from "../pages/TrialBalance";
import { GeneralLedgerPage } from "../pages/GeneralLedger";
import { CostCentersPage } from "../pages/CostCenters";

const get = apiClient.get as Mock;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function wrap(ui: ReactNode, route = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider><MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});

function baseTrialBalanceRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "a1",
    code: "1101",
    nameAr: "الصندوق",
    type: "asset",
    parentId: null,
    level: 1,
    hasChildren: false,
    isFolder: false,
    isPostingLeaf: true,
    isActive: true,
    isCycleMember: false,
    opening: 100,
    openDebit: 100,
    openCredit: 0,
    periodDebit: 50,
    periodCredit: 20,
    net: 30,
    closing: 130,
    closeDebit: 130,
    closeCredit: 0,
    abnormalSign: false,
    journalCount: 1,
    ...overrides,
  };
}
function baseTrialBalanceTotals(overrides: Record<string, unknown> = {}) {
  return {
    openDebit: 100, openCredit: 0, opening: 100,
    periodDebit: 50, periodCredit: 20,
    closing: 130, closeDebit: 130, closeCredit: 0,
    isOpeningBalanced: true, isPeriodBalanced: true, isClosingBalanced: true,
    isBalanced: true, abnormalCount: 0,
    ...overrides,
  };
}

describe("TrialBalance", () => {
  it("renders rows returned by the (mocked) apiClient", async () => {
    get.mockResolvedValue({
      success: true,
      isClean: true,
      rows: [baseTrialBalanceRow()],
      totals: baseTrialBalanceTotals(),
    });

    wrap(<TrialBalancePage />);
    expect((await screen.findAllByText("الصندوق"))[0]).toBeInTheDocument();
    // The trial-balance endpoint was hit with the exact legacy path.
    expect(get).toHaveBeenCalledWith("/erp/reports/trial-balance", expect.anything());
  });

  it("Tier A.1 corrective gate: displays the SERVER's totals, never a client-side re-sum of root rows", async () => {
    // Two depths (a root folder rolling up its own child leaf) so a naive
    // "sum root-level rows" algorithm — the exact bug this test guards
    // against — would compute periodDebit = 300 (the root's own rolled-up
    // figure). The server total below is deliberately a THIRD, unrelated
    // number that could never arise from summing anything shown in these
    // rows, so if the UI ever recomputes client-side instead of reading
    // `totals` from the response, this assertion fails loudly.
    get.mockResolvedValue({
      success: true,
      isClean: false,
      rows: [
        baseTrialBalanceRow({
          accountId: "root-1", code: "1", nameAr: "الأصول", parentId: null,
          level: 1, hasChildren: true, isFolder: true, isPostingLeaf: false,
          periodDebit: 300, periodCredit: 0, closing: 300, closeDebit: 300, closeCredit: 0,
        }),
        baseTrialBalanceRow({
          accountId: "leaf-1", code: "1101", nameAr: "الصندوق", parentId: "root-1",
          level: 2, hasChildren: false, isFolder: false, isPostingLeaf: true,
          periodDebit: 300, periodCredit: 0, closing: 300, closeDebit: 300, closeCredit: 0,
        }),
      ],
      totals: baseTrialBalanceTotals({
        periodDebit: 987654, periodCredit: 987654, closing: 987654, closeDebit: 987654, closeCredit: 987654,
        isOpeningBalanced: false, isPeriodBalanced: false, isClosingBalanced: false, isBalanced: false,
      }),
      diagnostics: {
        nullAccountOpening: { count: 2, debit: 40, credit: 40 },
        nullAccountPeriod: { count: 0, debit: 0, credit: 0 },
        danglingAccountOpening: { count: 0, debit: 0, credit: 0 },
        danglingAccountPeriod: { count: 0, debit: 0, credit: 0 },
        futureDatedOpeningJournals: { count: 0, debit: 0, credit: 0 },
        grossHistoricalMovement: { debit: 0, credit: 0 },
        orphanAccounts: [],
        nonLeafPostingActivity: [], cycleAccounts: [], levelMismatches: [],
        unbalancedJournals: [], headerLineMismatches: [],
        note: "test",
      },
    });

    wrap(<TrialBalancePage />);
    await screen.findAllByText("الصندوق");

    // The FOOTER (Grand Total row) must show the server's improbable total
    // (987654) — individual line rows legitimately still show 300 each
    // (that's real per-account data), so the proof has to be scoped to the
    // footer specifically, not "987,654 appears somewhere on the page".
    // Money is formatted "en-US", 2 decimals (see components.tsx `NUM`).
    const tfoot = await screen.findByText("الإجمالي").then((el) => el.closest("tfoot"));
    expect(tfoot).toBeTruthy();
    expect(tfoot!.textContent).toContain("987,654.00");
    expect(tfoot!.textContent).not.toContain("300.00");
    expect(tfoot!.textContent).not.toContain("600.00");

    // All three independent balance chips reflect the server's flags, and
    // the diagnostics warning (isClean:false, 2 null-account entries) shows.
    expect(await screen.findByText(/غير متوازن — أول المدة/)).toBeInTheDocument();
    expect(await screen.findByText(/غير متوازن — حركة الفترة/)).toBeInTheDocument();
    expect(await screen.findByText(/غير متوازن — آخر المدة/)).toBeInTheDocument();
    // Copy moved to i18n (accounting.trialBalance.status.notClean): "غير Clean"
    // → proper-Arabic "غير سليم". Same alert, same intent.
    expect(await screen.findByText(/تنبيه: التقرير غير سليم/)).toBeInTheDocument();
  });

  it("labels full-scope totals after filtering, preserves mobile level context, and drills into the account ledger", async () => {
    get.mockResolvedValue({
      success: true,
      isClean: true,
      rows: [
        baseTrialBalanceRow({ accountId: "a1", nameAr: "الصندوق", nameEn: "Cash", level: 2 }),
        baseTrialBalanceRow({ accountId: "a2", code: "1201", nameAr: "البنك", nameEn: "Bank", level: 2 }),
      ],
      totals: baseTrialBalanceTotals({ periodDebit: 777 }),
    });

    wrap(<><TrialBalancePage /><LocationProbe /></>);
    await screen.findAllByText("الصندوق");
    fireEvent.change(screen.getByLabelText(/ابحث باسم الحساب/), { target: { value: "الصندوق" } });

    expect(await screen.findByText(/تذييل التقرير هو الإجمالي المعتمد من الخادم/)).toBeInTheDocument();
    expect(screen.getByText("إجمالي النطاق الكامل")).toBeInTheDocument();
    expect(screen.getByLabelText("الصندوق، المستوى الهرمي 2")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "فتح دفتر الأستاذ للحساب الصندوق" })[0]);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain(
      "/accounting/general-ledger?accountId=a1&from=",
    ));
  });
});

describe("GeneralLedger drill-down", () => {
  it("reads accountId and period from the URL and keeps internal links basename-relative", async () => {
    get.mockImplementation((path: string, config?: { params?: Record<string, string> }) => {
      if (path === "/erp/gl/statement-sections") {
        return Promise.resolve({ success: true, sections: [] });
      }
      expect(path).toBe("/erp/reports/gl-ledger-multi");
      expect(config?.params).toEqual(expect.objectContaining({
        from: "2026-01-01",
        to: "2026-01-31",
        accounts: "a1",
      }));
      return Promise.resolve({
        success: true,
        sections: [{
          accountId: "a1", code: "110100", nameAr: "الصندوق", nameEn: "Cash",
          type: "asset", level: 3, parentId: "a", reportSection: "cash",
          normalBalance: "debit", isContra: false, cashFlowActivity: "operating",
          accountStatus: "active", isActive: true, opening: 0, openingDebit: 0,
          openingCredit: 0, totalDebit: 10, totalCredit: 0, closingBalance: 10,
          lineCount: 0, lines: [],
        }],
        grandTotals: { debit: 10, credit: 0, opening: 0, closing: 10, accountCount: 1, lineCount: 0 },
      });
    });

    wrap(
      <GeneralLedgerPage />,
      "/accounting/general-ledger?accountId=a1&from=2026-01-01&to=2026-01-31",
    );
    const accountLink = await screen.findByRole("link", { name: "الصندوق" });
    expect(accountLink).toHaveAttribute("href", "/accounting/chart-of-accounts/a1");
    expect(screen.getByText("عرض تفصيلي: حساب واحد")).toBeInTheDocument();
  });
});

describe("CostCenters", () => {
  it("renders the list and validates the required name in the form", async () => {
    get.mockResolvedValue([
      {
        id: "cc1",
        code: "C1",
        nameAr: "مركز الإنتاج",
        nameEn: "Production",
        branchId: "",
        branchName: "",
        parentId: "",
        parentName: "",
        isActive: true,
        notes: "",
        createdAt: "",
        createdBy: "",
      },
    ]);

    wrap(<CostCentersPage />);
    // DataTable renders a desktop table + a mobile card list; jsdom keeps both.
    expect((await screen.findAllByText("مركز الإنتاج")).length).toBeGreaterThan(0);

    // Open the create dialog and submit empty → the required-name error shows.
    fireEvent.click(screen.getByRole("button", { name: /مركز جديد/ }));
    fireEvent.click(screen.getByRole("button", { name: /^حفظ$/ }));
    await waitFor(() => expect(screen.getByText("الاسم بالعربية مطلوب.")).toBeInTheDocument());
  });
});
