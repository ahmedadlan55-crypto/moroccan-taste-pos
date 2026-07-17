/**
 * Product card images — the contract, not the pixels.
 *
 * The catalog carries `imageVersion` (an 8-char content hash), never the blob.
 * A card renders its fixed-height thumb ONLY when imageVersion is set; the
 * bytes are fetched WITH the POS Bearer token (the endpoint sits behind the
 * global /api JWT gate — a bare <img src> would 401 silently) and rendered as
 * an object URL. `?v=<imageVersion>` rides the request so the immutable HTTP
 * cache is busted exactly when the owner edits the image.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductGrid } from "../ProductGrid";
import type { Catalog, CatalogItem } from "@/lib/types";

const makeItem = (over: Partial<CatalogItem>): CatalogItem =>
  ({ id: "ITM-X", name: "صنف", price: 10, category: "أطباق", active: true, taxCategory: "S", ...over }) as CatalogItem;

function makeCatalog(items: CatalogItem[]): Catalog {
  return { items, categories: [...new Set(items.map((i) => i.category))] } as Catalog;
}

// No scrollElement prop → the grid renders unwindowed (jsdom does no layout);
// the windowing behavior itself is pinned by ProductGrid.virtual.test.tsx.
function renderGrid(items: CatalogItem[]) {
  return render(
    <ProductGrid catalog={makeCatalog(items)} loading={false} category={null} query="" onAdd={() => {}} />,
  );
}

describe("ProductCard image", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["png-bytes"], { type: "image/png" }),
  }));

  beforeEach(() => {
    localStorage.setItem("pos_token", "test-token");
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // jsdom has no createObjectURL/revokeObjectURL.
    URL.createObjectURL = vi.fn(() => "blob:itest-img");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
    localStorage.clear();
  });

  it("renders an <img> ONLY for items with imageVersion", async () => {
    const { container } = renderGrid([
      makeItem({ id: "ITM-IMG", name: "برجر", imageVersion: "abcd1234" }),
      makeItem({ id: "ITM-PLAIN", name: "شاي", imageVersion: null }),
      makeItem({ id: "ITM-LEGACY", name: "قهوة" }), // field absent entirely (old cached catalog)
    ]);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(1));
    // The reserved thumb box exists only where the image will land.
    expect(container.querySelectorAll('[data-testid="product-thumb"]').length).toBe(1);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:itest-img");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("fetches the bytes from the ABSOLUTE api path with ?v= and the Bearer token", async () => {
    const { container } = renderGrid([makeItem({ id: "ITM-77", name: "بيتزا", imageVersion: "beefcafe" })]);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Absolute /api/* — survives the SPA moving from /pos-v2/ to /pos/ (never
    // derived from import.meta.env.BASE_URL).
    expect(url).toBe("/api/pos/v2/item-image/ITM-77?v=beefcafe");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("a fetch failure leaves the grid intact — card renders, no <img>", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, blob: async () => new Blob() }));
    const { container, getByText } = renderGrid([makeItem({ id: "ITM-404", name: "مفقود", imageVersion: "00000000" })]);
    expect(getByText("مفقود")).toBeInTheDocument();
    // settle the async load; the failed image must never materialize
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelectorAll("img").length).toBe(0);
    // …but the fixed-height box still reserves the space (no reflow later).
    expect(container.querySelectorAll('[data-testid="product-thumb"]').length).toBe(1);
  });
});
