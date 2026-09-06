/**
 * ImageManager — bulk image manager smoke/render + filter interaction, plus
 * the anti-duplication guarantee for the extracted compression pipeline: both
 * ItemImageEditor AND ImageManager/ImageManagerBulkUpload must import the
 * SAME functions from ./imageCompression.ts, not hand-rolled duplicates.
 *
 * Modeled on menu.smoke.test.tsx (mocked apiClient.get, real query hooks) and
 * itemImage.test.tsx (mocked @/shared/permissions for a controllable gate).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/shared/ui";
import * as ItemImageEditorModule from "../ItemImageEditor";
import * as ImageCompressionModule from "../imageCompression";
import { ImageManager } from "../ImageManager";

// Controllable capability gate — ImageManager imports BOTH Can and useCan
// from the shared permissions surface; both must honor the same flag so the
// menu.view outer gate and the menu.catalog.manage inner gate are testable.
const capAllowed = vi.fn((_cap: string) => true);
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => capAllowed(cap),
  Can: ({ cap, children, fallback = null, showDenied = false }: {
    cap: string;
    children: React.ReactNode;
    fallback?: React.ReactNode;
    showDenied?: boolean;
  }) => {
    if (capAllowed(cap)) return children;
    if (showDenied) return <div data-testid="permission-denied">denied</div>;
    return fallback;
  },
}));

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const BASE_ITEM = {
  price: 18,
  cost: 6,
  computedCost: 6,
  stock: 100,
  minStock: 5,
  active: true,
  brandId: "B1",
  brandName: "براند تجريبي",
  pricingMode: "fixed",
  markupPct: 30,
  isSemiFinished: false,
  isCombo: false,
  bomId: null,
  productionMethod: "made_at_branch",
  deductStrategy: "on_sale",
  unit: "حبة",
  bigUnit: null,
  convRate: 1,
  yieldQuantity: 1,
  yieldUnit: null,
  isTaxInclusive: true,
};

// menu-hardening: /menu/all rows carry hasImage + an 8-char imageVer and NO
// imageData key — the bytes are fetched per item by MenuItemThumb. The old
// fixture shipped TINY_PNG on the row; that shape no longer exists on the wire.
const ITEM_WITH_IMAGE = { ...BASE_ITEM, id: "MENU-1", name: "شاورما دجاج", nameEn: "Chicken Shawarma", category: "ساندويتش", hasImage: true, imageVer: "a1b2c3d4" };
const ITEM_WITHOUT_IMAGE = { ...BASE_ITEM, id: "MENU-2", name: "برجر لحم", nameEn: "Beef Burger", category: "برجر", hasImage: false, imageVer: null };
// A row that still carried bytes but says hasImage:false must be treated as
// image-less — hasImage is the contract, imageData is not on list rows.
const ITEM_STALE_BYTES = { ...ITEM_WITHOUT_IMAGE, id: "MENU-3", name: "سلطة", nameEn: "Salad", imageData: TINY_PNG };

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (p: string) => {
        if (p.includes("/erp/brands")) return [{ id: "B1", name: "براند تجريبي", code: "BR", logo: null, isActive: true }];
        if (p.includes("/menu/all")) return [ITEM_WITH_IMAGE, ITEM_WITHOUT_IMAGE, ITEM_STALE_BYTES];
        return [];
      }),
    },
  };
});

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/menu/images"]}>
          <ImageManager />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ImageManager — render + filters", () => {
  it("renders the page header and both catalog rows once loaded", async () => {
    capAllowed.mockReturnValue(true);
    renderManager();
    expect(screen.getByText("إدارة صور الأصناف")).toBeInTheDocument();
    // DataTable renders BOTH the desktop table and the mobile stacked-card
    // list at once (CSS-only hiding, both present in jsdom) — use the *All*
    // query variant, matching menu.smoke.test.tsx's convention.
    expect((await screen.findAllByText("شاورما دجاج")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("برجر لحم").length).toBeGreaterThan(0);
  });

  it("the «بلا صورة» filter hides items that already have an image", async () => {
    capAllowed.mockReturnValue(true);
    renderManager();
    await screen.findAllByText("شاورما دجاج");

    fireEvent.click(screen.getByRole("radio", { name: "بلا صورة" }));

    await waitFor(() => expect(screen.queryByText("شاورما دجاج")).not.toBeInTheDocument());
    expect(screen.getAllByText("برجر لحم").length).toBeGreaterThan(0);
  });

  it("the «له صورة» filter hides items missing an image", async () => {
    capAllowed.mockReturnValue(true);
    renderManager();
    await screen.findAllByText("شاورما دجاج");

    fireEvent.click(screen.getByRole("radio", { name: "له صورة" }));

    await waitFor(() => expect(screen.queryByText("برجر لحم")).not.toBeInTheDocument());
    expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0);
    // hasImage:false wins over a stray imageData on the row — the filter reads
    // the contract field, never the bytes.
    expect(screen.queryByText("سلطة")).not.toBeInTheDocument();
  });

  it("the thumbnail column reads hasImage/imageVer, never a data URL on the row", async () => {
    capAllowed.mockReturnValue(true);
    renderManager();
    await screen.findAllByText("شاورما دجاج");
    // No row ships bytes any more, so no <img src="data:…"> can exist — even for
    // the fixture that (wrongly) still carries imageData. jsdom has no
    // URL.createObjectURL, so useItemImage degrades to the placeholder for the
    // item WITH an image as well; what matters is that nothing renders the
    // list-row bytes directly.
    const dataImgs = Array.from(document.querySelectorAll("img")).filter((el) => (el.getAttribute("src") || "").startsWith("data:"));
    expect(dataImgs).toHaveLength(0);
    // The status column is driven by hasImage: exactly one «له صورة» badge row
    // (MENU-1); the stale-bytes row shows «بلا صورة».
    const rowWithImage = screen.getAllByText("شاورما دجاج")[0].closest("tr");
    expect(rowWithImage?.textContent).toContain("له صورة");
    const staleRow = screen.getAllByText("سلطة")[0].closest("tr");
    expect(staleRow?.textContent).toContain("بلا صورة");
  });

  it("renders the permission-denied panel without menu.view", async () => {
    capAllowed.mockReturnValue(false);
    renderManager();
    expect(await screen.findByTestId("permission-denied")).toBeInTheDocument();
    expect(screen.queryByText("إدارة صور الأصناف")).not.toBeInTheDocument();
  });
});

describe("imageCompression — shared, not duplicated", () => {
  it("ItemImageEditor re-exports the EXACT SAME functions as imageCompression.ts", () => {
    expect(ItemImageEditorModule.downscaleImageFile).toBe(ImageCompressionModule.downscaleImageFile);
    expect(ItemImageEditorModule.fitWithin).toBe(ImageCompressionModule.fitWithin);
    expect(ItemImageEditorModule.dataUrlDecodedBytes).toBe(ImageCompressionModule.dataUrlDecodedBytes);
    expect(ItemImageEditorModule.IMAGE_MAX_SIDE).toBe(ImageCompressionModule.IMAGE_MAX_SIDE);
    expect(ItemImageEditorModule.IMAGE_MAX_DECODED_BYTES).toBe(ImageCompressionModule.IMAGE_MAX_DECODED_BYTES);
  });

  it("ImageManager.tsx and ImageManagerBulkUpload.tsx import downscaleImageFile from ./imageCompression (no re-implementation)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const managerSrc = readFileSync(path.join(dir, "..", "ImageManager.tsx"), "utf8");
    const bulkSrc = readFileSync(path.join(dir, "..", "ImageManagerBulkUpload.tsx"), "utf8");

    for (const src of [managerSrc, bulkSrc]) {
      expect(src).toMatch(/from ["']\.\/imageCompression["']/);
      // Neither file may redeclare the pipeline itself — that would be a
      // second implementation, defeating the whole extraction.
      expect(src).not.toMatch(/function downscaleImageFile/);
      expect(src).not.toMatch(/function fitWithin/);
    }
  });
});
