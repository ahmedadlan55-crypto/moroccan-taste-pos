/**
 * Parity — bootstrap + navigation rows (docs/pos-parity-matrix.md):
 *   boot-manual-refresh-all — the stale-catalog chip is the manual refresh
 *     entry: visible only when the served copy could not be confirmed, shows
 *     the copy's age, and a tap refetches (disabled offline with an honest tip)
 *   loader-and-toast        — Toasts render/dismiss; loading uses skeletons
 *     (ProductGrid loading state) instead of a full-screen overlay
 *   boot-dom-ready-sequence safety net — the ErrorBoundary replaces a crash
 *     with a recovery screen instead of a blank page
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";

const fixture: { value: Partial<PosContextValue> } = { value: {} };
vi.mock("@/state/store", () => ({
  usePos: () => fixture.value as PosContextValue,
}));

import { StaleCatalogChip } from "../Header";
import { Toasts } from "../Toasts";
import { ErrorBoundary } from "../ErrorBoundary";
import { ProductGrid } from "../ProductGrid";
// StaleCatalogChip (from Header.tsx) resolves strings via useT(), which
// throws without an ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";

afterEach(() => {
  fixture.value = {};
  vi.restoreAllMocks();
});

describe("boot-manual-refresh-all — StaleCatalogChip", () => {
  it("renders NOTHING while the catalog is confirmed fresh", () => {
    fixture.value = {
      catalogStale: false,
      catalogAgeMs: 0,
      refetchCatalog: vi.fn(),
      engineStatus: { online: true, syncing: false, queueCount: 0, lastReport: null },
    };
    const { container } = render(
      <I18nProvider>
        <StaleCatalogChip />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stale ⇒ shows the age and a tap refetches the catalog", () => {
    const refetchCatalog = vi.fn();
    fixture.value = {
      catalogStale: true,
      catalogAgeMs: 3 * 3_600_000,
      refetchCatalog,
      engineStatus: { online: true, syncing: false, queueCount: 0, lastReport: null },
    };
    render(
      <I18nProvider>
        <StaleCatalogChip />
      </I18nProvider>,
    );
    const chip = screen.getByRole("button", { name: /قائمة قديمة/ });
    expect(chip).toHaveTextContent("3 ساعة");
    fireEvent.click(chip);
    expect(refetchCatalog).toHaveBeenCalledTimes(1);
  });

  it("offline ⇒ the chip stays visible but the refresh is disabled (honest tooltip)", () => {
    fixture.value = {
      catalogStale: true,
      catalogAgeMs: 2 * 24 * 3_600_000,
      refetchCatalog: vi.fn(),
      engineStatus: { online: false, syncing: false, queueCount: 0, lastReport: null },
    };
    render(
      <I18nProvider>
        <StaleCatalogChip />
      </I18nProvider>,
    );
    const chip = screen.getByRole("button", { name: /قائمة قديمة/ });
    expect(chip).toBeDisabled();
    expect(chip).toHaveTextContent("يومان");
  });
});

describe("loader-and-toast — Toasts", () => {
  it("renders queued toasts and dismisses on the X", () => {
    const dismissToast = vi.fn();
    fixture.value = {
      toasts: [
        { id: 1, kind: "success", message: "تم فتح الوردية" },
        { id: 2, kind: "error", message: "المتصفح منع نافذة الطباعة" },
      ],
      dismissToast,
    };
    render(<Toasts />);
    expect(screen.getByText("تم فتح الوردية")).toBeInTheDocument();
    expect(screen.getByText("المتصفح منع نافذة الطباعة")).toBeInTheDocument();
    // Picked by IDENTITY, not by index: errors now render above the transient
    // toasts (they persist until dismissed — see components/Toasts.tsx), so
    // "the first × on screen" is no longer "the first toast in the array".
    const successCard = screen.getByText("تم فتح الوردية").closest('[data-testid="pos-toast"]') as HTMLElement;
    fireEvent.click(within(successCard).getByRole("button", { name: "إغلاق التنبيه" }));
    expect(dismissToast).toHaveBeenCalledWith(1);
  });

  it("renders nothing when there are no toasts", () => {
    fixture.value = { toasts: [], dismissToast: vi.fn() };
    const { container } = render(<Toasts />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("loader — ProductGrid loading state uses skeletons", () => {
  it("shows placeholder skeletons while the catalog loads", () => {
    const { container } = render(
      <ProductGrid catalog={null} loading category={null} query="" onAdd={vi.fn()} />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});

describe("ErrorBoundary — a crash renders a recovery screen, never a blank page", () => {
  it("catches a render error and offers a reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bomb(): never {
      throw new Error("boom");
    }
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("حدث خطأ غير متوقّع")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة تحميل الصفحة" })).toBeInTheDocument();
  });
});
