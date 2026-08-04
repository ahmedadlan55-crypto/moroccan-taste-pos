// Chart of Accounts — model, hooks and the SEVEN routed pages.
//
// The regression tests here pin the four defects Package H fixed, because each
// of them was invisible on screen rather than loud:
//   * roots hardcoded to codes "1".."5", so production's six-digit chart
//     rendered as an empty tree;
//   * a parentless non-root account (a "stray root") disappeared entirely
//     instead of being reported;
//   * search never looked at nameEn, so English users got "no matches" on a
//     chart that contained the word they typed;
//   * every sub-path under /accounting/chart-of-accounts rendered NotFound,
//     which is what made a dialog the only possible editor.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, renderHook, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// Mock the shared API client, keep the real ApiError (states.tsx needs it).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// The pages show management actions → force can() true here.
vi.mock("@/app/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/providers")>();
  return { ...actual, useCan: () => true };
});

import { ApiError, apiClient } from "@/shared/api";
import {
  accountMatches,
  buildChildrenMap,
  computeHealth,
  computeRollups,
  getRoots,
  getTreeRoots,
  isAbnormalBalance,
  isFolderAccount,
  isSystemRoot,
  naturalAmount,
  nodeDisplayBalance,
  normalSide,
} from "../coa/coaModel";
import { coaSubSegments } from "../coa";
import {
  useSetAccountActive,
  useDeleteGlAccount,
  useToggleAccountFolder,
  useMoveGlAccount,
  useStatementSections,
  normalizeGlAccount,
  type GlAccount,
} from "../api";
import { ChartOfAccountsPage } from "../pages/ChartOfAccounts";
import AccountingModule from "../index";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/shared/ui";

const get = apiClient.get as Mock;
const post = apiClient.post as Mock;
const del = apiClient.delete as Mock;

const COA = "/accounting/chart-of-accounts";

function qcWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** Render inside the full provider stack the routed pages need. */
function wrap(ui: ReactNode, route = COA) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function acc(p: Partial<GlAccount> & { id: string; code: string }): GlAccount {
  return {
    id: p.id,
    code: p.code,
    nameAr: p.nameAr ?? p.code,
    nameEn: p.nameEn ?? "",
    type: p.type ?? "asset",
    parentId: p.parentId ?? null,
    level: p.level ?? 1,
    isActive: p.isActive ?? true,
    isFolder: p.isFolder ?? false,
    displayOrder: p.displayOrder ?? null,
    balance: p.balance ?? 0,
    storedBalance: p.storedBalance ?? 0,
    movementCount: p.movementCount ?? 0,
    accountClass: "detail",
    reportSection: p.reportSection ?? null,
    taxNature: "none",
    isSystemRoot: p.isSystemRoot,
    isContra: p.isContra,
    isPostable: p.isPostable,
    status: p.status,
    normalBalance: p.normalBalance,
    systemManaged: p.systemManaged,
    cashFlowActivity: p.cashFlowActivity,
    version: p.version,
  };
}

/** Route every GET the CoA pages make: the list, plus the per-account ledger. */
function mockChart(accounts: GlAccount[]) {
  get.mockImplementation((path: string) => {
    if (String(path).includes("/erp/gl/statement-sections")) {
      return Promise.resolve({
        success: true,
        sections: [
          { id: "cash", statement: "balance_sheet", group: "currentAssets", nameAr: "النقدية", nameEn: "Cash", normalBalance: "debit", isContra: false, displayOrder: 10, cashFlowBucket: "cash" },
          { id: "ppe", statement: "balance_sheet", group: "nonCurrentAssets", nameAr: "الأصول الثابتة", nameEn: "PPE", normalBalance: "debit", isContra: false, displayOrder: 20, cashFlowBucket: "fixedAssets" },
          { id: "zakat", statement: "balance_sheet", group: "currentLiabilities", nameAr: "الزكاة المستحقة", nameEn: "Zakat payable", normalBalance: "credit", isContra: false, displayOrder: 30, cashFlowBucket: "otherCurrentLiabilities" },
        ],
      });
    }
    if (String(path).includes("/erp/gl/account-ledger/")) {
      return Promise.resolve({ success: true, ledger: [] });
    }
    return Promise.resolve(accounts);
  });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  window.localStorage.clear();
});

// ════════════════════════════════════════════════════════════════════════════
// Model
// ════════════════════════════════════════════════════════════════════════════

describe("coaModel — tree building from the flat list", () => {
  const accounts = [
    acc({ id: "1", code: "1", nameAr: "الأصول", type: "asset", level: 1, isFolder: true }),
    acc({ id: "11", code: "11", nameAr: "الأصول المتداولة", parentId: "1", level: 2, isFolder: true }),
    acc({ id: "1102", code: "1102", nameAr: "البنك", parentId: "11", level: 3, balance: 300 }),
    acc({ id: "1101", code: "1101", nameAr: "الصندوق", parentId: "11", level: 3, balance: 500, movementCount: 3 }),
    acc({ id: "2", code: "2", nameAr: "الالتزامات", type: "liability", level: 1, isFolder: true }),
  ];

  it("roots are the accounts with codes 1..5 when nothing carries is_system_root", () => {
    expect(getRoots(accounts).map((r) => r.code)).toEqual(["1", "2"]);
  });

  it("children are grouped by parentId and sorted by code", () => {
    const map = buildChildrenMap(accounts);
    expect(map.get("11")!.map((a) => a.code)).toEqual(["1101", "1102"]);
  });

  it("rollup balance sums self + all descendants", () => {
    const map = buildChildrenMap(accounts);
    const roll = computeRollups(accounts, map);
    expect(roll.get("11")).toBe(800);
    expect(roll.get("1")).toBe(800);
  });

  it("folder detection covers root codes and any account with children", () => {
    const map = buildChildrenMap(accounts);
    expect(isFolderAccount(accounts[0], (map.get("1")?.length ?? 0) > 0)).toBe(true);
    expect(isFolderAccount(accounts[3], false)).toBe(false); // leaf 1101
  });

  it("search matches Arabic name or code, case-insensitive", () => {
    const cash = accounts[3];
    expect(accountMatches(cash, "صندوق")).toBe(true);
    expect(accountMatches(cash, "1101")).toBe(true);
    expect(accountMatches(cash, "بنك")).toBe(false);
  });
});

describe("coaModel — bilingual search", () => {
  const cash = acc({ id: "1101", code: "1101", nameAr: "الصندوق", nameEn: "Cash on hand" });

  it("matches the ENGLISH name, not only the Arabic one", () => {
    expect(accountMatches(cash, "Cash")).toBe(true);
    expect(accountMatches(cash, "cash on")).toBe(true); // case-insensitive
  });

  it("still matches the Arabic name and the code", () => {
    expect(accountMatches(cash, "صندوق")).toBe(true);
    expect(accountMatches(cash, "1101")).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(accountMatches(cash, "Inventory")).toBe(false);
  });
});

describe("coaModel — roots come from is_system_root, not a code set", () => {
  // Production's chart: six-digit roots. The hardcoded 1..5 set matches NOTHING
  // here, which is exactly how the whole chart used to render as empty.
  const prod = [
    acc({ id: "a", code: "100000", nameAr: "الأصول", type: "asset", isSystemRoot: true, isFolder: true }),
    acc({ id: "b", code: "200000", nameAr: "الالتزامات", type: "liability", isSystemRoot: true, isFolder: true }),
    acc({ id: "a1", code: "110000", nameAr: "الأصول المتداولة", parentId: "a", level: 2, isFolder: true }),
    acc({ id: "a11", code: "110100", nameAr: "الصندوق", parentId: "a1", level: 3, balance: 900 }),
  ];

  it("prefers the flag over the legacy code set", () => {
    expect(getRoots(prod).map((a) => a.code)).toEqual(["100000", "200000"]);
    expect(isSystemRoot(prod[0], prod)).toBe(true);
    expect(isSystemRoot(prod[2], prod)).toBe(false);
  });

  it("keeps every six-digit descendant reachable from a root", () => {
    const byParent = buildChildrenMap(prod);
    expect(byParent.get("a")!.map((a) => a.code)).toEqual(["110000"]);
    expect(byParent.get("a1")!.map((a) => a.code)).toEqual(["110100"]);
    expect(getTreeRoots(prod).map((a) => a.code)).toEqual(["100000", "200000"]);
  });

  it("falls back to the code set only while NO row carries the flag", () => {
    const legacy = [acc({ id: "1", code: "1" }), acc({ id: "9", code: "9999", parentId: null })];
    expect(getRoots(legacy).map((a) => a.code)).toEqual(["1"]);
    expect(isSystemRoot(legacy[0], legacy)).toBe(true);
  });
});

describe("coaModel — a stray root is REPORTED, never hidden", () => {
  const chart = [
    acc({ id: "a", code: "100000", nameAr: "الأصول", isSystemRoot: true, isFolder: true }),
    acc({ id: "a1", code: "110000", nameAr: "الصندوق", parentId: "a", level: 2, balance: 10 }),
    // Parentless and NOT a system root — the old tree simply never drew it.
    acc({ id: "s", code: "990000", nameAr: "حساب سائب", parentId: null, level: 1 }),
    // Points at a parent that does not exist.
    acc({ id: "o", code: "880000", nameAr: "حساب يتيم", parentId: "does-not-exist", level: 2 }),
  ];

  it("renders the stray root and the orphan at the top of the tree", () => {
    expect(getTreeRoots(chart).map((a) => a.code)).toEqual([
      "100000",
      "880000",
      "990000",
    ]);
  });

  it("flags them as issues rather than dropping them", () => {
    const byParent = buildChildrenMap(chart);
    const health = computeHealth(chart, byParent, computeRollups(chart, byParent));
    expect(health.strayRoots.map((a) => a.code)).toEqual(["990000"]);
    expect(health.orphans.map((a) => a.code)).toEqual(["880000"]);
    expect(health.byAccount.get("s")).toContain("strayRoot");
    expect(health.byAccount.get("o")).toContain("orphan");
    expect(health.totalIssues).toBeGreaterThanOrEqual(2);
  });

  it("detects a cycle without hanging", () => {
    const cyclic = [
      acc({ id: "x", code: "1", parentId: "y" }),
      acc({ id: "y", code: "2", parentId: "x" }),
    ];
    const byParent = buildChildrenMap(cyclic);
    const health = computeHealth(cyclic, byParent, computeRollups(cyclic, byParent));
    expect(health.cycles.length).toBe(2);
  });

  it("audits bilingual names, derived levels, folder flags, root type and code class", () => {
    const governed = [
      acc({
        id: "root",
        code: "100000",
        nameAr: "الأصول",
        nameEn: "Assets",
        type: "asset",
        level: 1,
        isSystemRoot: true,
        isFolder: true,
        classCode: "1",
      }),
      acc({
        id: "bad-parent",
        code: "110000",
        nameAr: "أصول متداولة",
        nameEn: "Current assets",
        type: "asset",
        parentId: "root",
        level: 4,
        isFolder: false,
      }),
      acc({
        id: "bad-child",
        code: "210100",
        nameAr: "صندوق",
        nameEn: "",
        type: "liability",
        parentId: "bad-parent",
        level: 3,
        reportSection: "cash",
      }),
    ];
    const byParent = buildChildrenMap(governed);
    const health = computeHealth(governed, byParent, computeRollups(governed, byParent));

    expect(health.missingEnglish.map((a) => a.id)).toEqual(["bad-child"]);
    expect(health.levelMismatches.map((a) => a.id)).toEqual(["bad-parent"]);
    expect(health.folderFlagMismatches.map((a) => a.id)).toEqual(["bad-parent"]);
    expect(health.codeClassMismatches.map((a) => a.id)).toEqual(["bad-child"]);
    expect(health.typeMismatches.map((a) => a.id)).toEqual(["bad-child"]);
    expect(health.byAccount.get("bad-child")).toEqual(
      expect.arrayContaining(["missingEnglish", "codeClassMismatch", "typeMismatch"]),
    );
  });

  it("separates legacy code-length warnings and catches zakat classified under equity", () => {
    const accounts = [
      acc({ id: "eq", code: "3", nameAr: "حقوق الملكية", nameEn: "Equity", type: "equity", isFolder: true }),
      acc({ id: "z", code: "310100", nameAr: "زكاة", nameEn: "Zakat", type: "equity", parentId: "eq", level: 2, reportSection: "zakat" }),
    ];
    const byParent = buildChildrenMap(accounts);
    const health = computeHealth(accounts, byParent, computeRollups(accounts, byParent), [{
      id: "zakat",
      statement: "balance_sheet",
      group: "currentLiabilities",
      nameAr: "الزكاة المستحقة",
      nameEn: "Zakat payable",
      normalBalance: "credit",
      isContra: false,
      displayOrder: 10,
      cashFlowBucket: null,
    }]);

    expect(health.nonCanonicalCodes.map((a) => a.id)).toEqual(["eq"]);
    expect(health.invalidCodes).toEqual([]);
    expect(health.statementSectionTypeMismatches.map((a) => a.id)).toEqual(["z"]);
    expect(health.byAccount.get("z")).toContain("statementSectionTypeMismatch");
  });
});

describe("coaModel — rollups at EVERY depth, and abnormal is not the raw sign", () => {
  // Four levels deep: the old `depth <= 2` cutoff showed L3's OWN balance (0)
  // while all the money sat one level below it.
  const deep = [
    acc({ id: "r", code: "1", isSystemRoot: true, isFolder: true }),
    acc({ id: "l2", code: "11", parentId: "r", level: 2, isFolder: true }),
    acc({ id: "l3", code: "111", parentId: "l2", level: 3, isFolder: true }),
    acc({ id: "l4", code: "1111", parentId: "l3", level: 4, balance: 700 }),
  ];

  it("a level-3 folder shows its rollup, not its own zero", () => {
    const byParent = buildChildrenMap(deep);
    const rollups = computeRollups(deep, byParent);
    expect(nodeDisplayBalance(deep[2], 2, true, rollups)).toBe(700);
    expect(nodeDisplayBalance(deep[1], 1, true, rollups)).toBe(700);
    expect(nodeDisplayBalance(deep[3], 3, false, rollups)).toBe(700);
  });

  it("a credit-natured account with a credit balance is NORMAL", () => {
    // Server sends Σ(debit − credit): a liability with 500 credit is −500.
    const payable = acc({ id: "p", code: "2100", type: "liability" });
    expect(normalSide(payable)).toBe("credit");
    expect(naturalAmount(payable, -500)).toBe(500);
    expect(isAbnormalBalance(payable, -500)).toBe(false);
    // …and a DEBIT balance on it is the genuinely abnormal case.
    expect(isAbnormalBalance(payable, 500)).toBe(true);
  });

  it("a contra account is not reported abnormal for sitting on its inverted side", () => {
    // Accumulated depreciation: typed asset (debit) but naturally credit.
    const accDep = acc({
      id: "d",
      code: "1290",
      type: "asset",
      normalBalance: "debit", // 0028 seeds this FROM TYPE — contra is the flip
      isContra: true,
      reportSection: "acc_dep",
    });
    expect(normalSide(accDep)).toBe("credit");
    expect(isAbnormalBalance(accDep, -4000)).toBe(false);
    expect(isAbnormalBalance(accDep, 4000)).toBe(true);
  });
});

describe("api — the list row normalizer reads BOTH spellings", () => {
  it("accepts snake_case 0028 columns as well as camelCase", () => {
    const row = normalizeGlAccount({
      id: "a",
      code: "100000",
      name_ar: "الأصول",
      name_en: "Assets",
      type: "asset",
      parent_id: null,
      level: 1,
      is_active: 1,
      is_folder: 1,
      is_system_root: 1,
      is_contra: 0,
      normal_balance: "debit",
      report_section: "cash",
      movement_count: 3,
    });
    expect(row.nameEn).toBe("Assets");
    expect(row.isSystemRoot).toBe(true);
    expect(row.isContra).toBe(false);
    expect(row.normalBalance).toBe("debit");
    expect(row.movementCount).toBe(3);
  });

  it("leaves a 0028 column UNDEFINED when the server does not send it", () => {
    // undefined ≠ false: it is what tells the model to fall back to the code set.
    const row = normalizeGlAccount({ id: "a", code: "1", nameAr: "الأصول", type: "asset" });
    expect(row.isSystemRoot).toBeUndefined();
    expect(row.isContra).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hooks
// ════════════════════════════════════════════════════════════════════════════

describe("COA hooks hit the exact legacy endpoints", () => {
  it("loads the financial-statement catalog from the server authority", async () => {
    get.mockResolvedValue({
      success: true,
      sections: [{
        id: "cash", statement: "balance_sheet", group: "currentAssets",
        nameAr: "النقدية", nameEn: "Cash", normalBalance: "debit",
        isContra: false, displayOrder: 10, cashFlowBucket: "cash",
      }],
    });
    const { result } = renderHook(() => useStatementSections(), { wrapper: qcWrapper() });
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe("cash"));
    expect(get).toHaveBeenCalledWith("/erp/gl/statement-sections");
  });

  it("activate/deactivate posts is_active to /erp/gl/accounts", async () => {
    post.mockResolvedValue({ success: true, id: "1101" });
    const account = acc({ id: "1101", code: "1101", nameAr: "الصندوق", parentId: "11", level: 3 });
    const { result } = renderHook(() => useSetAccountActive(), { wrapper: qcWrapper() });
    result.current.mutate({ account, isActive: false });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/erp/gl/accounts",
        expect.objectContaining({ id: "1101", isActive: false }),
      ),
    );
  });

  it("delete hits DELETE /erp/gl/accounts/:id", async () => {
    del.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useDeleteGlAccount(), { wrapper: qcWrapper() });
    result.current.mutate("1101");
    await waitFor(() => expect(del).toHaveBeenCalledWith("/erp/gl/accounts/1101"));
  });

  it("folder toggle hits POST /erp/gl/accounts/:id/folder", async () => {
    post.mockResolvedValue({ success: true, id: "11", isFolder: true });
    const { result } = renderHook(() => useToggleAccountFolder(), { wrapper: qcWrapper() });
    result.current.mutate({ id: "11", isFolder: true });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/erp/gl/accounts/11/folder", { isFolder: true }),
    );
  });

  it("move keeps the account code stable and sends the optimistic version", async () => {
    post.mockResolvedValue({ success: true, oldCode: "1102", newCode: "1202" });
    const { result } = renderHook(() => useMoveGlAccount(), { wrapper: qcWrapper() });
    result.current.mutate({ id: "1102", parentId: "12", autoRenumber: false, expectedVersion: 7 });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/erp/gl/accounts/1102/move", {
        parentId: "12",
        autoRenumber: false,
        expectedVersion: 7,
      }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Routing
// ════════════════════════════════════════════════════════════════════════════

describe("the CoA subtree resolves every sub-path", () => {
  it("splits the segments after the base without touching id case", () => {
    expect(coaSubSegments(COA)).toEqual([]);
    expect(coaSubSegments(`${COA}/new`)).toEqual(["new"]);
    expect(coaSubSegments(`${COA}/AC-1101/edit`)).toEqual(["AC-1101", "edit"]);
    expect(coaSubSegments(`${COA}/AC-1101/move/`)).toEqual(["AC-1101", "move"]);
  });

  it("the accounting module prefix-dispatches a deep path instead of 404ing", async () => {
    mockChart([acc({ id: "1", code: "1", nameAr: "الأصول", isFolder: true })]);
    wrap(<AccountingModule />, `${COA}/new`);
    // The create page is a full-page flow with the "New account" title.
    expect(await screen.findByRole("heading", { name: "حساب جديد" })).toBeInTheDocument();
  });

  it("an unknown deep path still resolves to NotFound", async () => {
    mockChart([acc({ id: "1", code: "1", nameAr: "الأصول", isFolder: true })]);
    wrap(<AccountingModule />, `${COA}/1/nonsense`);
    await waitFor(() => expect(screen.queryByRole("tree")).not.toBeInTheDocument());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Pages
// ════════════════════════════════════════════════════════════════════════════

const CHART: GlAccount[] = [
  acc({
    id: "a",
    code: "100000",
    nameAr: "الأصول",
    nameEn: "Assets",
    type: "asset",
    isSystemRoot: true,
    isFolder: true,
  }),
  acc({
    id: "a1",
    code: "110000",
    nameAr: "الأصول المتداولة",
    nameEn: "Current assets",
    parentId: "a",
    level: 2,
    isFolder: true,
  }),
  acc({
    id: "a11",
    code: "110100",
    nameAr: "الصندوق",
    nameEn: "Cash on hand",
    parentId: "a1",
    level: 3,
    balance: 900,
    movementCount: 4,
    reportSection: "cash",
  }),
  acc({
    id: "a12",
    code: "110200",
    nameAr: "المخزون",
    nameEn: "Inventory",
    parentId: "a1",
    level: 3,
    balance: 100,
    reportSection: "inventory",
  }),
  acc({ id: "s", code: "990000", nameAr: "حساب سائب", nameEn: "Stray account", level: 1 }),
];

describe("ChartOfAccountsPage — list", () => {
  it("renders an accessible tree loaded from /erp/gl/accounts", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);

    const tree = await screen.findByRole("tree");
    expect(tree).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/erp/gl/accounts");

    const items = within(tree).getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(0);
    // aria-level is 1-based and a group wraps the children of an open node.
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(items[0]).toHaveAttribute("aria-expanded", "true");
    expect(within(tree).getAllByRole("group").length).toBeGreaterThan(0);
  });

  it("keeps SIX-DIGIT accounts visible — the hardcoded 1..5 roots used to hide them", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);

    const tree = await screen.findByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: /توسيع الكل/ }));

    // Root, its level-2 group, BOTH level-3 leaves and the stray root — the
    // whole six-digit chart, which the old ROOT_CODES set matched none of.
    await waitFor(() => expect(within(tree).getByText("110100")).toBeInTheDocument());
    for (const code of ["100000", "110000", "110100", "110200", "990000"]) {
      expect(within(tree).getByText(code)).toBeInTheDocument();
    }
    expect(within(tree).getAllByRole("treeitem").length).toBe(5);
  });

  it("surfaces a stray root in the tree instead of dropping it", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);

    const tree = await screen.findByRole("tree");
    expect(within(tree).getByText("990000")).toBeInTheDocument();
    // …and it is labelled as a defect, not shown as an ordinary root.
    expect(within(tree).getByText("جذر شاذّ")).toBeInTheDocument();
  });

  it("searches the ENGLISH name as well as the Arabic one", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);
    await screen.findByRole("tree");

    const box = screen.getByLabelText("بحث في دليل الحسابات");
    fireEvent.change(box, { target: { value: "Inventory" } });

    await waitFor(() => {
      const tree = screen.getByRole("tree");
      expect(within(tree).getByText("110200")).toBeInTheDocument();
      expect(within(tree).queryByText("990000")).not.toBeInTheDocument();
    });
  });

  it("filtering by the issue kind narrows the tree to the flagged accounts", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);
    await screen.findByRole("tree");

    fireEvent.change(screen.getByLabelText("الملاحظات"), { target: { value: "strayRoot" } });

    await waitFor(() => {
      const tree = screen.getByRole("tree");
      expect(within(tree).getByText("990000")).toBeInTheDocument();
      expect(within(tree).queryByText("110100")).not.toBeInTheDocument();
    });
  });
});

describe("ChartOfAccountsPage — keyboard tree navigation", () => {
  async function renderTree() {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />);
    const tree = await screen.findByRole("tree");
    return tree;
  }

  it("ArrowDown / ArrowUp / Home / End walk the VISIBLE rows", async () => {
    const tree = await renderTree();
    const rows = () => within(tree).getAllByRole("treeitem");

    const first = rows()[0];
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[0]);

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rows()[rows().length - 1]);

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("the direction-aware arrows collapse and expand (RTL: Right closes, Left opens)", async () => {
    const tree = await renderTree();
    const root = () => within(tree).getAllByRole("treeitem")[0];

    root().focus();
    expect(root()).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() => expect(root()).toHaveAttribute("aria-expanded", "false"));
    expect(within(tree).queryByText("110000")).not.toBeInTheDocument();

    root().focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    await waitFor(() => expect(root()).toHaveAttribute("aria-expanded", "true"));
    expect(within(tree).getByText("110000")).toBeInTheDocument();
  });

  it("exposes exactly ONE tab stop for the whole tree", async () => {
    const tree = await renderTree();
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });
});

describe("routed create / edit / move / detail pages", () => {
  it("/new renders the create workspace as a full page", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />, `${COA}/new`);
    expect(await screen.findByRole("heading", { name: "حساب جديد" })).toBeInTheDocument();
    expect(screen.getByLabelText(/الاسم بالعربية/)).toBeInTheDocument();
    // No dialog: the create flow is a routed page, not an overlay on the list.
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("/new?parent=<id> pre-selects the parent from the URL", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />, `${COA}/new?parent=a1`);
    await screen.findByRole("heading", { name: "حساب جديد" });
    const parent = screen.getByLabelText("الحساب الرئيسي") as HTMLSelectElement;
    await waitFor(() => expect(parent.value).toBe("a1"));
  });

  it("clears stale statement and cash-flow inheritance when the new parent is unclassified", async () => {
    const chart = [
      ...CHART,
      acc({ id: "classified", code: "120000", nameAr: "مصنف", nameEn: "Classified", parentId: "a", level: 2, isFolder: true, reportSection: "cash", cashFlowActivity: "non_cash" }),
      acc({ id: "unclassified", code: "130000", nameAr: "غير مصنف", nameEn: "Unclassified", parentId: "a", level: 2, isFolder: true }),
    ];
    mockChart(chart);
    wrap(<ChartOfAccountsPage />, `${COA}/new?parent=classified`);
    await screen.findByRole("heading", { name: "حساب جديد" });

    const section = await screen.findByLabelText(/تصنيف القوائم المالية/) as HTMLSelectElement;
    const cashFlow = screen.getByLabelText(/نشاط التدفق النقدي/) as HTMLSelectElement;
    await waitFor(() => expect(section.value).toBe("cash"));
    expect(cashFlow.value).toBe("non_cash");

    fireEvent.change(screen.getByLabelText("الحساب الرئيسي"), { target: { value: "unclassified" } });
    expect(section.value).toBe("");
    expect(cashFlow.value).toBe("");
  });

  it("/:id renders the routed detail page for that account", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />, `${COA}/a11`);
    expect(await screen.findByRole("heading", { name: "الصندوق", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText("110100").length).toBeGreaterThan(0);
  });

  it("renders classification, cash-flow, tax and lifecycle values as localized labels, never raw enums", async () => {
    window.localStorage.setItem("erp_lang", "en");
    mockChart(CHART.map((item) => item.id === "a11" ? {
      ...item,
      reportSection: "cash",
      cashFlowActivity: "non_cash",
      taxNature: "vat_input",
      status: "archived" as const,
      isActive: false,
    } : item));
    wrap(<ChartOfAccountsPage />, `${COA}/a11`);

    expect(await screen.findByText("Non-cash adjustment")).toBeInTheDocument();
    expect(screen.getByText("Input VAT")).toBeInTheDocument();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
    expect(screen.queryByText("non_cash")).not.toBeInTheDocument();
    expect(screen.queryByText("vat_input")).not.toBeInTheDocument();
  });

  it("/:id/edit pre-fills the account and locks its code", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />, `${COA}/a11/edit`);
    expect(await screen.findByRole("heading", { name: "تعديل الحساب" })).toBeInTheDocument();
    const code = (await screen.findByLabelText(/^الرمز/)) as HTMLInputElement;
    await waitFor(() => expect(code.value).toBe("110100"));
    expect(code).toHaveAttribute("readonly");
    const nameAr = screen.getByLabelText(/الاسم بالعربية/) as HTMLInputElement;
    expect(nameAr.value).toBe("الصندوق");
  });

  it("allows a system root's bilingual name to be saved without inventing a parent", async () => {
    mockChart(CHART);
    post.mockResolvedValue({ success: true, id: "a" });
    wrap(<ChartOfAccountsPage />, `${COA}/a/edit`);
    await screen.findByRole("heading", { name: "تعديل الحساب" });
    fireEvent.change(screen.getByLabelText(/الاسم بالإنجليزية/), { target: { value: "Assets updated" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/erp/gl/accounts", expect.objectContaining({
      id: "a",
      parentId: null,
      nameEn: "Assets updated",
    })));
  });

  it("/:id/move renders the move workspace and offers no descendant as a target", async () => {
    const chart = [...CHART, acc({ id: "a2", code: "120000", nameAr: "مجموعة بديلة", parentId: "a", level: 2, isFolder: true })];
    mockChart(chart);
    wrap(<ChartOfAccountsPage />, `${COA}/a1/move`);
    expect(await screen.findByRole("heading", { name: "نقل حساب" })).toBeInTheDocument();

    const select = (await screen.findByLabelText("الأب الجديد")) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain("a1"); // itself
    expect(values).not.toContain("a11"); // its descendant → would be a cycle
    expect(values).not.toContain("s"); // posting leaf → server would reject it
    expect(values).toContain("a");
    expect(values).toContain("a2");
    expect(screen.getByRole("button", { name: "تنفيذ النقل" })).toBeDisabled();
  });

  it("the move page POSTs to /erp/gl/accounts/:id/move", async () => {
    const chart = [
      ...CHART.map((item) => item.id === "a1" ? { ...item, version: 7 } : item),
      acc({ id: "a2", code: "120000", nameAr: "مجموعة بديلة", parentId: "a", level: 2, isFolder: true }),
    ];
    mockChart(chart);
    post.mockResolvedValue({ success: true, oldCode: "110000", newCode: "990100" });
    wrap(<ChartOfAccountsPage />, `${COA}/a1/move`);
    await screen.findByRole("heading", { name: "نقل حساب" });

    fireEvent.change(await screen.findByLabelText("الأب الجديد"), { target: { value: "a2" } });
    fireEvent.click(screen.getByRole("button", { name: "تنفيذ النقل" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/erp/gl/accounts/a1/move", {
        parentId: "a2",
        autoRenumber: false,
        expectedVersion: 7,
      }),
    );
  });

  it("maps structured move failures to the active language instead of leaking Arabic server text", async () => {
    window.localStorage.setItem("erp_lang", "en");
    const chart = [
      ...CHART,
      acc({ id: "a2", code: "120000", nameAr: "مجموعة بديلة", nameEn: "Alternative group", parentId: "a", level: 2, isFolder: true }),
    ];
    mockChart(chart);
    post.mockRejectedValue(new ApiError({
      kind: "validation",
      status: 422,
      code: "PARENT_NOT_FOLDER",
      message: "الحساب الأب يجب أن يكون حسابًا تجميعيًا",
    }));
    wrap(<ChartOfAccountsPage />, `${COA}/a1/move`);
    await screen.findByRole("heading", { name: "Move account" });
    fireEvent.change(await screen.findByLabelText("New parent"), { target: { value: "a2" } });
    fireEvent.click(screen.getByRole("button", { name: "Move account" }));

    expect(await screen.findByText("Choose an active group/control account as the new parent.")).toBeInTheDocument();
    expect(screen.queryByText(/الحساب الأب/)).not.toBeInTheDocument();
  });

  it("/:id for an unknown id says so instead of rendering an empty shell", async () => {
    mockChart(CHART);
    wrap(<ChartOfAccountsPage />, `${COA}/no-such-account`);
    expect(
      await screen.findByRole("heading", { name: /الحساب غير موجود/, level: 1 }),
    ).toBeInTheDocument();
  });
});

describe("/health surfaces the defects the tree used to swallow", () => {
  it("lists the stray root, the orphan and the unmapped accounts", async () => {
    mockChart([
      ...CHART,
      acc({ id: "o", code: "880000", nameAr: "حساب يتيم", parentId: "ghost", level: 2 }),
    ]);
    wrap(<ChartOfAccountsPage />, `${COA}/health`);

    expect(await screen.findByRole("heading", { name: "فحص دليل الحسابات" })).toBeInTheDocument();
    expect(screen.getAllByText("جذور شاذّة").length).toBeGreaterThan(0);
    expect(screen.getAllByText("حساب سائب").length).toBeGreaterThan(0);
    expect(screen.getAllByText("حساب يتيم").length).toBeGreaterThan(0);
  });
});
