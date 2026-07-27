/**
 * components/Toasts.tsx — the asymmetry: a success may vanish, an error may not.
 *
 * `state/store.tsx` auto-dismisses EVERY toast after 5s and keeps only the last
 * few, so an error disappeared exactly like a success and three quick successes
 * evicted the one failure that mattered. These specs pin the rendering-side fix
 * by driving the store the way the store actually behaves — handing the
 * component a toast and then TAKING IT AWAY — and asserting the error is still
 * on screen while the success is not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PosContextValue, Toast } from "@/state/store";

const state: { toasts: Toast[]; dismissToast: ReturnType<typeof vi.fn> } = {
  toasts: [],
  dismissToast: vi.fn(),
};
vi.mock("@/state/store", () => ({
  usePos: () => state as unknown as PosContextValue,
}));

import { Toasts } from "../Toasts";
import { I18nProvider } from "@/i18n/I18nProvider";

function setToasts(toasts: Toast[]) {
  state.toasts = toasts;
}

function renderToasts() {
  return render(
    <I18nProvider>
      <Toasts />
    </I18nProvider>,
  );
}

/** What the store does after 5s: the toast is simply gone from the array. */
function storeEvictsEverything(rerender: ReturnType<typeof renderToasts>["rerender"]) {
  setToasts([]);
  rerender(
    <I18nProvider>
      <Toasts />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.toasts = [];
  state.dismissToast = vi.fn();
});

describe("an error survives the store's auto-dismiss", () => {
  it("still renders after the store has evicted it", () => {
    setToasts([{ id: 1, kind: "error", message: "فشل الدفع — لم تُسجَّل العملية" }]);
    const { rerender } = renderToasts();
    expect(screen.getByText("فشل الدفع — لم تُسجَّل العملية")).toBeInTheDocument();

    storeEvictsEverything(rerender);

    expect(screen.getByText("فشل الدفع — لم تُسجَّل العملية")).toBeInTheDocument();
    expect(screen.getByTestId("pos-toast-error")).toBeInTheDocument();
  });

  it("says so on the toast itself, so the cashier knows it is waiting for them", () => {
    setToasts([{ id: 1, kind: "error", message: "خطأ" }]);
    renderToasts();
    expect(screen.getByText("يبقى حتى الإغلاق")).toBeInTheDocument();
  });

  it("is NOT resurrected once dismissed, even if the store still holds it", () => {
    // A store that DOES persist errors keeps handing the same toast back.
    setToasts([{ id: 1, kind: "error", message: "خطأ ثابت" }]);
    const { rerender } = renderToasts();
    fireEvent.click(screen.getByRole("button", { name: "إغلاق التنبيه" }));
    expect(state.dismissToast).toHaveBeenCalledWith(1);

    rerender(
      <I18nProvider>
        <Toasts />
      </I18nProvider>,
    );
    expect(screen.queryByText("خطأ ثابت")).not.toBeInTheDocument();
  });

  it("a SUCCESS still vanishes when the store evicts it (the behaviour that was correct)", () => {
    setToasts([{ id: 1, kind: "success", message: "تمت الإضافة" }]);
    const { rerender } = renderToasts();
    expect(screen.getByText("تمت الإضافة")).toBeInTheDocument();
    storeEvictsEverything(rerender);
    expect(screen.queryByText("تمت الإضافة")).not.toBeInTheDocument();
  });

  it("three successes cannot evict the one failure that mattered", () => {
    setToasts([{ id: 1, kind: "error", message: "فشل الترحيل" }]);
    const { rerender } = renderToasts();
    // The store's cap keeps the last four — the error is gone from ITS array.
    setToasts([
      { id: 2, kind: "success", message: "نجاح ١" },
      { id: 3, kind: "success", message: "نجاح ٢" },
      { id: 4, kind: "success", message: "نجاح ٣" },
    ]);
    rerender(
      <I18nProvider>
        <Toasts />
      </I18nProvider>,
    );
    expect(screen.getByText("فشل الترحيل")).toBeInTheDocument();
  });
});

describe("a stack of errors collapses instead of burying a 390px screen", () => {
  const many: Toast[] = [
    { id: 1, kind: "error", message: "خطأ ١" },
    { id: 2, kind: "error", message: "خطأ ٢" },
    { id: 3, kind: "error", message: "خطأ ٣" },
    { id: 4, kind: "error", message: "خطأ ٤" },
  ];

  it("shows the two NEWEST in full and collapses the rest behind one row", () => {
    setToasts(many);
    renderToasts();
    expect(screen.getAllByTestId("pos-toast-error")).toHaveLength(2);
    expect(screen.getByText("خطأ ٤")).toBeInTheDocument(); // newest is never the one hidden
    expect(screen.getByText("خطأ ٣")).toBeInTheDocument();
    expect(screen.queryByText("خطأ ١")).not.toBeInTheDocument();
    expect(screen.getByTestId("pos-toasts-more-errors")).toHaveTextContent("و 2 خطأ آخر — عرض");
  });

  it("expands to show them all, and collapses again", () => {
    setToasts(many);
    renderToasts();
    fireEvent.click(screen.getByTestId("pos-toasts-more-errors"));
    expect(screen.getAllByTestId("pos-toast-error")).toHaveLength(4);
    expect(screen.getByText("خطأ ١")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pos-toasts-more-errors"));
    expect(screen.getAllByTestId("pos-toast-error")).toHaveLength(2);
  });

  it("offers a single «إغلاق كل الأخطاء» once there is more than one", () => {
    setToasts(many);
    renderToasts();
    const all = screen.getByTestId("pos-toasts-dismiss-all");
    expect(all).toHaveTextContent("إغلاق كل الأخطاء (4)");
    fireEvent.click(all);
    expect(screen.queryAllByTestId("pos-toast-error")).toHaveLength(0);
    // Every id is cleared on the store side too, not just in this component.
    expect(state.dismissToast.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2, 3, 4]);
  });

  it("offers no bulk control for a single error (nothing to bulk-dismiss)", () => {
    setToasts([{ id: 9, kind: "error", message: "وحيد" }]);
    renderToasts();
    expect(screen.queryByTestId("pos-toasts-dismiss-all")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pos-toasts-more-errors")).not.toBeInTheDocument();
  });

  it("bounds its own height so it can never paint over the whole till", () => {
    setToasts(many);
    renderToasts();
    expect(screen.getByTestId("pos-toasts").className).toContain("max-h-[70vh]");
    expect(screen.getByTestId("pos-toasts").className).toContain("overflow-y-auto");
  });
});

describe("one cause never paints as a wall of identical cards", () => {
  // From a production screenshot: two red cards, same sentence, stacked, over a
  // till whose cart was hidden behind them. One drain had failed several ops for
  // ONE reason. The sticky mirror outlives a store toast's 5s TTL by design, so
  // the recurrence arrives as a genuinely NEW id — id-dedup alone cannot see it.
  it("collapses a repeat of a message already on screen", () => {
    const msg = "هذا الطلب يخص كاشيرًا آخر";
    setToasts([{ id: 1, kind: "error", message: msg }]);
    const { rerender } = renderToasts();

    setToasts([{ id: 2, kind: "error", message: msg }]);
    rerender(
      <I18nProvider>
        <Toasts />
      </I18nProvider>,
    );

    expect(screen.getAllByText(msg)).toHaveLength(1);
  });

  it("still shows a genuinely different failure alongside it", () => {
    setToasts([{ id: 1, kind: "error", message: "خطأ أول" }]);
    const { rerender } = renderToasts();
    setToasts([{ id: 2, kind: "error", message: "خطأ ثانٍ" }]);
    rerender(
      <I18nProvider>
        <Toasts />
      </I18nProvider>,
    );

    expect(screen.getByText("خطأ أول")).toBeInTheDocument();
    expect(screen.getByText("خطأ ثانٍ")).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("announces errors assertively and keeps a labelled close control on each", () => {
    setToasts([{ id: 1, kind: "error", message: "خطأ" }]);
    renderToasts();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إغلاق التنبيه" })).toBeInTheDocument();
  });

  it("renders nothing at all when there is nothing to say", () => {
    setToasts([]);
    const { container } = renderToasts();
    expect(container).toBeEmptyDOMElement();
  });
});
