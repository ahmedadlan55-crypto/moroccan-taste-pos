// E1 — Chart of Accounts: parity + prevention tests.
// Model logic (tree/rollup/roots) is tested purely; the CRUD hooks are tested
// via renderHook to assert they hit the EXACT legacy endpoints; and the page
// renders the tree from /erp/gl/accounts.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock the shared API client, keep the real ApiError (states.tsx needs it).
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// The page render shows management actions → force can() true here.
vi.mock("@/app/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/providers")>();
  return { ...actual, useCan: () => true };
});

import { apiClient } from "@/shared/api";
import {
  buildChildrenMap,
  getRoots,
  computeRollups,
  isFolderAccount,
  accountMatches,
} from "../coa/coaModel";
import {
  useSetAccountActive,
  useDeleteGlAccount,
  useToggleAccountFolder,
  type GlAccount,
} from "../api";
import { ChartOfAccountsPage } from "../pages/ChartOfAccounts";
import { I18nProvider } from "@/i18n";

const get = apiClient.get as Mock;
const post = apiClient.post as Mock;
const del = apiClient.delete as Mock;

function qcWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
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
    reportSection: null,
    taxNature: "none",
  };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
});

describe("coaModel — tree building from the flat list", () => {
  const accounts = [
    acc({ id: "1", code: "1", nameAr: "الأصول", type: "asset", level: 1, isFolder: true }),
    acc({ id: "11", code: "11", nameAr: "الأصول المتداولة", parentId: "1", level: 2, isFolder: true }),
    acc({ id: "1102", code: "1102", nameAr: "البنك", parentId: "11", level: 3, balance: 300 }),
    acc({ id: "1101", code: "1101", nameAr: "الصندوق", parentId: "11", level: 3, balance: 500, movementCount: 3 }),
    acc({ id: "2", code: "2", nameAr: "الالتزامات", type: "liability", level: 1, isFolder: true }),
  ];

  it("roots are the accounts with codes 1..5", () => {
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

describe("COA hooks hit the exact legacy endpoints", () => {
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
});

describe("ChartOfAccountsPage", () => {
  it("renders the tree loaded from /erp/gl/accounts", async () => {
    get.mockResolvedValue([
      acc({ id: "1", code: "1", nameAr: "الأصول", type: "asset", level: 1, isFolder: true }),
      acc({ id: "1101", code: "1101", nameAr: "الصندوق", parentId: "1", level: 2, balance: 100 }),
    ]);
    wrap(<ChartOfAccountsPage />);
    // "الأصول" is both a type-filter chip and the root node name → use findAll.
    expect((await screen.findAllByText("الأصول")).length).toBeGreaterThan(0);
    expect(get).toHaveBeenCalledWith("/erp/gl/accounts");
  });
});
