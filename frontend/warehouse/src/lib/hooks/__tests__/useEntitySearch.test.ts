import { describe, it, expect, afterEach, vi } from "vitest";
import { stubFetch } from "@/test/test-utils";
import { makeItemFetcher, makeAccountFetcher } from "../useEntitySearch";

afterEach(() => vi.unstubAllGlobals());

describe("useEntitySearch fetchers — first-page-on-open + contract guard", () => {
  it("item-search: an empty q still hits the server and maps data + pagination", async () => {
    const mock = stubFetch(() => ({
      status: 200,
      body: { data: [{ id: "1", name: "أرز بسمتي" }], pagination: { page: 1, totalPages: 2, total: 40 } },
    }));
    const page = await makeItemFetcher({ warehouseId: "W1", context: "receipt" })({ q: "", page: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextPage).toBe(2); // page 1 of 2 → there IS a next page
    expect(page.total).toBe(40);
    expect(String(mock.mock.calls[0][0])).toMatch(/\/inventory\/v2\/item-search/);
  });

  it("accounts-search: last page → nextPage null, empty list is a valid result", async () => {
    stubFetch(() => ({ status: 200, body: { data: [], pagination: { page: 3, totalPages: 3, total: 50 } } }));
    const page = await makeAccountFetcher({ context: "receipt", postingOnly: true })({ q: "cash", page: 3 });
    expect(page.nextPage).toBeNull();
    expect(page.items).toEqual([]);
  });

  it("REJECTS a contract violation where data is not an array (→ UI error state, not silent empty)", async () => {
    stubFetch(() => ({ status: 200, body: { data: null } }));
    await expect(makeItemFetcher()({ q: "", page: 1 })).rejects.toThrow(/SEARCH_CONTRACT_INVALID/);
  });

  it("REJECTS an unexpected envelope with no data key", async () => {
    stubFetch(() => ({ status: 200, body: { rows: [] } }));
    await expect(makeAccountFetcher()({ q: "", page: 1 })).rejects.toThrow(/SEARCH_CONTRACT_INVALID/);
  });
});
