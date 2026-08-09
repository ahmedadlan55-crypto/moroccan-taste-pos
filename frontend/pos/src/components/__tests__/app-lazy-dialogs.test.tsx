/**
 * App shell — the code-split dialogs, and the two invariants splitting them
 * could plausibly have broken.
 *
 * 1. `overlayOpen`. It gates F2/F4/F9 AND the idle PWA auto-reload. A lazily
 *    loaded dialog is on screen in TWO states — the Suspense fallback while its
 *    chunk arrives, and the dialog itself — and BOTH must count as "an overlay
 *    is open". If the fallback did not, a kiosk could reload underneath a
 *    cashier in the half-second between the tap and the chunk.
 * 2. Lifecycle. Deferring a chunk must not also unmount the dialog on close —
 *    that would silently throw away a half-counted stocktake.
 *
 * Plus the two cross-owner wirings this shell owns: PaymentDialog's
 * `onOpenShift` round trip, and ProductGrid's `parseQtyPrefix` on the search
 * box scan path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { __resetFailureLogCacheForTests, readFailures } from "@/lib/failureLog";
import type { EngineEvent } from "@/lib/offline";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeFakeEngine, makeOrder } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listOrders: vi.fn(async () => ({ success: true, data: [] })),
    listSales: vi.fn(async () => []),
    shiftSummary: vi.fn(async () => ({ success: true, data: { byStatus: {}, completedByMethod: {} } })),
    closingDataV3: vi.fn(async () => ({ success: true, data: {} })),
  };
});

// The legacy drain runs from a top-level effect on every mount; keep it inert
// so it can't write to the failure log under the tests that assert on it.
// getDrainStatus MUST return a stable reference — Header reads it through
// useSyncExternalStore, and a fresh object per call is an infinite re-render.
const DRAIN_IDLE = Object.freeze({ state: "idle", pending: 0, outcome: null });
vi.mock("@/lib/legacyDrain", () => ({
  runLegacyDrainOnce: vi.fn(async () => null),
  getDrainStatus: () => DRAIN_IDLE,
  subscribeDrain: () => () => {},
}));

import App from "@/App";
import { I18nProvider } from "@/i18n/I18nProvider";

function renderApp(ctx: PosContextValue) {
  currentCtx = ctx;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return utils;
}

/** Mount + settle the initial async held-count refresh. */
async function mount(ctx: PosContextValue = makeCtx()) {
  const utils = renderApp(ctx);
  await act(async () => {});
  return utils;
}

/**
 * The engine-event listener App registered, so a spec can replay what the real
 * engine emits. The testkit types `onEvent` as a zero-arg mock, so its
 * `mock.calls` is an empty tuple — read it through one narrow cast here rather
 * than at each call site.
 */
function engineEmitter(engine: ReturnType<typeof makeFakeEngine>): (e: EngineEvent) => void {
  const calls = (engine.onEvent as unknown as { mock: { calls: Array<[(e: EngineEvent) => void]> } }).mock.calls;
  // Effects resubscribe when the active dialog/order changes.  The real
  // engine removes the previous listener; this lightweight mock only records
  // calls, so replay the latest (live) closure rather than a stale first one.
  const latest = calls.at(-1);
  if (!latest) throw new Error("App never subscribed to engine events");
  return latest[0];
}

beforeEach(() => {
  localStorage.clear();
  __resetFailureLogCacheForTests();
});
afterEach(() => cleanup());

describe("the rare dialogs are lazy, and still open", () => {
  it("is NOT in the DOM before its first open, then opens on demand", async () => {
    await mount();
    expect(screen.queryByRole("dialog", { name: "جرد المخزون" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "جرد المخزون" }));
    expect(await screen.findByRole("dialog", { name: "جرد المخزون" })).toBeInTheDocument();
  });

  // NOTE: this is the only case in the file that opens «طلب النواقص», on
  // purpose — React.lazy memoises a resolved module, so only the FIRST open of
  // a given dialog anywhere in this file can observe the fallback at all.
  it("shows a loading overlay while the chunk is in flight", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "طلب النواقص" }));
    // Synchronously after the click the chunk has not resolved yet.
    expect(screen.getByText("جارٍ فتح النافذة…")).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "طلب النواقص والاستلام" })).toBeInTheDocument();
  });

  it("STAYS mounted after being closed, so in-progress work is not thrown away", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "جرد المخزون" }));
    const dialog = await screen.findByRole("dialog", { name: "جرد المخزون" });
    fireEvent.click(within(dialog).getByRole("button", { name: "إغلاق" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "جرد المخزون" })).not.toBeInTheDocument());
    // Re-opening is instant: no second Suspense fallback, because the component
    // was never unmounted — only its `open` prop went false.
    fireEvent.click(screen.getByRole("button", { name: "جرد المخزون" }));
    expect(screen.queryByText("جارٍ فتح النافذة…")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "جرد المخزون" })).toBeInTheDocument();
  });

  it("opens the sync report (and its failure-log tab) from the connection chip", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /متصل/ }));
    expect(await screen.findByRole("dialog", { name: "تقرير المزامنة" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /سجل الإخفاقات/ })).toBeInTheDocument();
  });
});

describe("overlayOpen still covers every lazy dialog", () => {
  it("suppresses F9 / F4 from the very frame the flag flips — fallback or dialog", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);

    fireEvent.click(screen.getByRole("button", { name: "جرد المخزون" }));
    // Whichever of the two is on screen in this first frame — the Suspense
    // fallback (cold chunk) or the dialog itself (React.lazy caches the module
    // once resolved, so a later open never suspends) — the union must already
    // be true. The fallback frame is the one that used to be reachable with the
    // gate still saying "nothing is open".
    const showing =
      screen.queryByText("جارٍ فتح النافذة…") ?? screen.queryByRole("dialog", { name: "جرد المخزون" });
    expect(showing).not.toBeNull();

    fireEvent.keyDown(window, { key: "F9" });
    fireEvent.keyDown(window, { key: "F4" });

    await act(async () => {});
    expect(engine.holdOrder).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
  });

  it("suppresses F9 / F4 while the loaded dialog is open", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);

    fireEvent.click(screen.getByRole("button", { name: "فواتيري" }));
    await screen.findByRole("dialog", { name: "فواتيري" });

    fireEvent.keyDown(window, { key: "F9" });
    fireEvent.keyDown(window, { key: "F4" });
    await act(async () => {});

    expect(engine.holdOrder).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
  });

  it("releases the gate again once the lazy dialog closes", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);

    fireEvent.click(screen.getByRole("button", { name: "فواتيري" }));
    const dialog = await screen.findByRole("dialog", { name: "فواتيري" });
    fireEvent.click(within(dialog).getByRole("button", { name: "إغلاق" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "فواتيري" })).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(engine.holdOrder).toHaveBeenCalledTimes(1));
  });
});

describe("PaymentDialog onOpenShift — payment ⇄ the FULL shift dialog", () => {
  it("closes payment, opens the real shift dialog, and comes back once a shift exists", async () => {
    const ctx = makeCtx({ shiftId: null, cart: makeOrder({ shiftId: null }) });
    const { rerender } = await mount(ctx);

    fireEvent.keyDown(window, { key: "F4" });
    expect(await screen.findByRole("dialog", { name: "الدفع" })).toBeInTheDocument();

    // The banner's hand-off — NOT an inline zero-float open.
    fireEvent.click(screen.getByRole("button", { name: "افتح وردية الآن" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument());
    const shiftDialog = await screen.findByRole("dialog", { name: "الوردية" });

    // A shift now exists (the mutation landed in the query cache).
    currentCtx = makeCtx({ shiftId: "SH-99", cart: makeOrder({ shiftId: "SH-99" }) });
    fireEvent.click(within(shiftDialog).getByRole("button", { name: "إغلاق" }));
    rerender(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <App />
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "الدفع" })).toBeInTheDocument();
  });

  it("does NOT reopen payment when the cashier cancelled without opening a shift", async () => {
    const ctx = makeCtx({ shiftId: null, cart: makeOrder({ shiftId: null }) });
    await mount(ctx);

    fireEvent.keyDown(window, { key: "F4" });
    await screen.findByRole("dialog", { name: "الدفع" });
    fireEvent.click(screen.getByRole("button", { name: "افتح وردية الآن" }));
    const shiftDialog = await screen.findByRole("dialog", { name: "الوردية" });

    fireEvent.click(within(shiftDialog).getByRole("button", { name: "إغلاق" }));
    await act(async () => {});

    // Still no shift → reopening onto the same dead-end banner helps nobody.
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
  });
});

describe("scan path — ProductGrid's parseQtyPrefix on the search box", () => {
  it("«3*M2» typed into the scan box adds the item three times", async () => {
    const ctx = makeCtx();
    await mount(ctx);

    const box = screen.getByRole("searchbox", { name: /بحث في الأصناف/ });
    fireEvent.change(box, { target: { value: "3*M2" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(3));
    expect(vi.mocked(ctx.addItem).mock.calls[0][0]).toMatchObject({ id: "M2" });
  });

  it("a code that only LOOKS like a prefix is retried whole, not misread as a quantity", async () => {
    const ctx = makeCtx();
    await mount(ctx);
    const box = screen.getByRole("searchbox", { name: /بحث في الأصناف/ });
    fireEvent.change(box, { target: { value: "9*NOPE" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(ctx.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("لا صنف يطابق")));
    expect(ctx.addItem).not.toHaveBeenCalled();
  });
});

describe("durable failure log — the App-side write site", () => {
  it("records a permanently-failed checkout so it survives the reload", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);

    // App subscribes to the engine; replay the event the engine emits when a
    // queued sale dies for good (lib/offline.ts — runCheckoutOp's fail() and
    // failCheckoutAfterPrerequisite).
    const emit = engineEmitter(engine);
    await act(async () => {
      emit({
        type: "checkout-done",
        orderId: "01DEADORDER0000000000000000",
        ok: false,
        queued: false,
        invoiceNumber: null,
        saleId: null,
        error: "الوردية مغلقة",
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(readFailures()).toHaveLength(1));
    expect(readFailures()[0]).toMatchObject({
      id: "checkout:01DEADORDER0000000000000000",
      kind: "checkout",
      orderId: "01DEADORDER0000000000000000",
      message: "الوردية مغلقة",
      cashier: "cashier1",
    });
    expect(ctx.pushToast).toHaveBeenCalledWith("error", "الوردية مغلقة");
  });

  it("does not duplicate the active PaymentDialog error as a sticky toast", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);
    fireEvent.keyDown(window, { key: "F4" });
    await screen.findByRole("dialog", { name: "الدفع" });
    vi.mocked(ctx.pushToast).mockClear();

    await act(async () => {
      engineEmitter(engine)({
        type: "checkout-done",
        orderId: ctx.cart.id,
        ok: false,
        queued: false,
        invoiceNumber: null,
        saleId: null,
        error: "فشل البيع",
      });
      await Promise.resolve();
    });

    expect(ctx.pushToast).not.toHaveBeenCalled();
    await waitFor(() => expect(readFailures()).toHaveLength(1));
  });

  it("still alerts when a background checkout fails while payment is open", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await mount(ctx);
    fireEvent.keyDown(window, { key: "F4" });
    await screen.findByRole("dialog", { name: "الدفع" });
    vi.mocked(ctx.pushToast).mockClear();

    await act(async () => {
      engineEmitter(engine)({
        type: "checkout-done",
        orderId: "ANOTHER-ORDER",
        ok: false,
        queued: false,
        invoiceNumber: null,
        saleId: null,
        error: "فشل طلب محفوظ",
      });
      await Promise.resolve();
    });

    expect(ctx.pushToast).toHaveBeenCalledWith("error", "فشل طلب محفوظ");
  });

  it("does NOT record a checkout that merely queued (offline is not a failure)", async () => {
    const engine = makeFakeEngine();
    await mount(makeCtx({ engine }));
    const emit = engineEmitter(engine);
    await act(async () => {
      emit({ type: "checkout-done", orderId: "O2", ok: true, queued: true, invoiceNumber: null, saleId: null });
      emit({ type: "checkout-done", orderId: "O3", ok: true, queued: false, invoiceNumber: "INV-1", saleId: "S1" });
      await Promise.resolve();
    });
    expect(readFailures()).toEqual([]);
  });

  it("a retried checkout that fails again UPDATES its row instead of duplicating it", async () => {
    const engine = makeFakeEngine();
    await mount(makeCtx({ engine }));
    const emit = engineEmitter(engine);
    await act(async () => {
      emit({ type: "checkout-done", orderId: "O9", ok: false, queued: false, invoiceNumber: null, saleId: null, error: "المحاولة ١" });
      await Promise.resolve();
      emit({ type: "checkout-done", orderId: "O9", ok: false, queued: false, invoiceNumber: null, saleId: null, error: "المحاولة ٢" });
      await Promise.resolve();
    });
    await waitFor(() => expect(readFailures()[0]?.message).toBe("المحاولة ٢"));
    expect(readFailures()).toHaveLength(1);
  });
});
