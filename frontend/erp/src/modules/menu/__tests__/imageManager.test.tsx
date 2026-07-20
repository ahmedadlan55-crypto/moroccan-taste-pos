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

const ITEM_WITH_IMAGE = { ...BASE_ITEM, id: "MENU-1", name: "شاورما دجاج", nameEn: "Chicken Shawarma", category: "ساندويتش", imageData: TINY_PNG };
const ITEM_WITHOUT_IMAGE = { ...BASE_ITEM, id: "MENU-2", name: "برجر لحم", nameEn: "Beef Burger", category: "برجر", imageData: null };

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (p: string) => {
        if (p.includes("/erp/brands")) return [{ id: "B1", name: "براند تجريبي", code: "BR", logo: null, isActive: true }];
        if (p.includes("/menu/all")) return [ITEM_WITH_IMAGE, ITEM_WITHOUT_IMAGE];
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
