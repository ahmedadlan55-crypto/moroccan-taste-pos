/**
 * Scanner workflow (App.tsx).
 *
 * Two defects, one workflow:
 *  a) the shortcut handler skipped every keydown whose target was an input —
 *     but the barcode workflow REQUIRES focus in the SearchBox and nothing ever
 *     released it, so F4 (pay) and F9 (hold) were dead for the rest of the sale;
 *  b) a scan made while focus was anywhere else (a product card, the body, the
 *     «المزيد» button) was silently swallowed by whatever had focus.
 *
 * The document-level capture is deliberately hard to trigger by hand: ≥6
 * characters where EVERY inter-keystroke gap is ≤50ms, terminated by an Enter
 * ≤50ms after the last character, with no modifier, no overlay open, and focus
 * NOT in a text field. It never preventDefaults a printable key — only the
 * terminating Enter of an already-accepted scan — so it cannot suppress typing.
 * The "human" cases below pin exactly that.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeCatalog } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, listOrders: vi.fn(async () => ({ success: true, data: [] })) };
});

import App from "@/App";
import { I18nProvider } from "@/i18n/I18nProvider";

const CATALOG = makeCatalog({
  items: [
    { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S", barcode: "7501234" },
    { id: "M2", name: "طاجين لحم", price: 86, category: "أطباق", active: true, taxCategory: "S", barcode: "6009988" },
  ],
});

/** Virtual clock so keystroke TIMING is asserted, not accidental. */
let clock = 1_000;
const tick = (ms: number) => {
  clock += ms;
};

function renderApp(overrides: Partial<PosContextValue> = {}) {
  currentCtx = makeCtx({ catalog: CATALOG, overrides });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return currentCtx;
}

/** Type a code into the document at a fixed inter-keystroke gap, then Enter. */
function typeToDocument(code: string, gapMs: number, opts: { target?: Element; enter?: boolean } = {}) {
  const target = opts.target ?? document.body;
  const events: boolean[] = [];
  for (const ch of code) {
    tick(gapMs);
    events.push(fireEvent.keyDown(target, { key: ch }));
  }
  if (opts.enter !== false) {
    tick(gapMs);
    events.push(fireEvent.keyDown(target, { key: "Enter" }));
  }
  return events;
}

beforeEach(() => {
  cleanup();
  clock = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

describe("scanner speed accepted — a scan lands wherever focus is", () => {
  it("a fast burst + Enter on the BODY adds the item", async () => {
    const ctx = renderApp();
    typeToDocument("7501234", 5);
    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ctx.addItem).mock.calls[0][0]).toMatchObject({ id: "M1" });
  });

  it("works with focus parked on a BUTTON, and eats that Enter so the button is not clicked", async () => {
    const ctx = renderApp();
    const button = screen.getByRole("button", { name: "جرد المخزون" });
    button.focus();
    const results = typeToDocument("6009988", 5, { target: button });
    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ctx.addItem).mock.calls[0][0]).toMatchObject({ id: "M2" });
    // fireEvent returns false when the handler called preventDefault: only the
    // terminating Enter is ever cancelled, never a character.
    expect(results.slice(0, -1).every(Boolean)).toBe(true);
    expect(results.at(-1)).toBe(false);
  });

  it("honours the N*CODE quantity prefix — 12*7501234 adds twelve", async () => {
    const ctx = renderApp();
    typeToDocument("12*7501234", 5);
    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(12));
  });

  it("survives the bare Shift keydowns an UPPERCASE (Code-128) scan interleaves", async () => {
    const ctx = renderApp({
      catalog: makeCatalog({
        items: [
          { id: "M9", name: "زيت زيتون", price: 40, category: "أطباق", active: true, taxCategory: "S", barcode: "AB12CD" },
        ],
      }),
    });
    for (const ch of "AB12CD") {
      tick(4);
      if (/[A-Z]/.test(ch)) fireEvent.keyDown(document.body, { key: "Shift", shiftKey: true });
      tick(4);
      fireEvent.keyDown(document.body, { key: ch, shiftKey: /[A-Z]/.test(ch) });
    }
    tick(4);
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(ctx.addItem).toHaveBeenCalledTimes(1));
  });

  it("an unknown code toasts instead of failing silently", async () => {
    const ctx = renderApp();
    typeToDocument("9999999", 5);
    await waitFor(() => expect(ctx.pushToast).toHaveBeenCalledWith("error", "لا صنف يطابق «9999999»"));
    expect(ctx.addItem).not.toHaveBeenCalled();
  });
});

describe("it cannot eat a keystroke a human meant", () => {
  it("HUMAN typing speed (120ms/char) is never treated as a scan", async () => {
    const ctx = renderApp();
    const results = typeToDocument("7501234", 120);
    await act(async () => {});
    expect(ctx.addItem).not.toHaveBeenCalled();
    // and nothing at all was cancelled — including the Enter
    expect(results.every(Boolean)).toBe(true);
  });

  it("a fast burst SHORTER than the minimum code length is ignored", async () => {
    const ctx = renderApp();
    typeToDocument("750", 5);
    await act(async () => {});
    expect(ctx.addItem).not.toHaveBeenCalled();
  });

  it("one slow keystroke in the middle restarts the buffer — the run must be uninterrupted", async () => {
    const ctx = renderApp();
    for (const ch of "7501") {
      tick(5);
      fireEvent.keyDown(document.body, { key: ch });
    }
    tick(400); // the cashier paused
    for (const ch of "234") {
      tick(5);
      fireEvent.keyDown(document.body, { key: ch });
    }
    tick(5);
    fireEvent.keyDown(document.body, { key: "Enter" });
    await act(async () => {});
    expect(ctx.addItem).not.toHaveBeenCalled();
  });

  it("a lone Enter (submitting something, or a focused control) is left alone", async () => {
    const ctx = renderApp();
    tick(5);
    expect(fireEvent.keyDown(document.body, { key: "Enter" })).toBe(true);
    expect(ctx.addItem).not.toHaveBeenCalled();
  });

  it("is completely inert while focus is in a TEXT FIELD (the human is typing)", async () => {
    const ctx = renderApp();
    const search = screen.getByLabelText("بحث في الأصناف أو مسح باركود");
    search.focus();
    typeToDocument("7501234", 5, { target: search });
    await act(async () => {});
    // the SearchBox owns its own Enter; the document capture must not double-add
    expect(ctx.addItem).not.toHaveBeenCalled();
  });

  it("is inert while an overlay is open", async () => {
    const ctx = renderApp();
    fireEvent.keyDown(window, { key: "F4" }); // opens the payment dialog
    await screen.findByRole("dialog", { name: "الدفع" });
    typeToDocument("7501234", 5);
    await act(async () => {});
    expect(ctx.addItem).not.toHaveBeenCalled();
  });

  it("a modifier chord (Ctrl+A … Enter) is never a scan", async () => {
    const ctx = renderApp();
    for (const ch of "7501234") {
      tick(5);
      fireEvent.keyDown(document.body, { key: ch, ctrlKey: true });
    }
    tick(5);
    fireEvent.keyDown(document.body, { key: "Enter" });
    await act(async () => {});
    expect(ctx.addItem).not.toHaveBeenCalled();
  });
});

describe("the SearchBox scan releases focus so F4/F9 come back", () => {
  it("a SUCCESSFUL scan blurs the box, and F4 then opens payment", async () => {
    renderApp();
    const search = screen.getByLabelText("بحث في الأصناف أو مسح باركود") as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: "7501234" } });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(document.activeElement).not.toBe(search));
    fireEvent.keyDown(window, { key: "F4" });
    expect(await screen.findByRole("dialog", { name: "الدفع" })).toBeInTheDocument();
  });

  it("a FAILED scan keeps focus so the cashier can fix the text in place", async () => {
    const ctx = renderApp();
    const search = screen.getByLabelText("بحث في الأصناف أو مسح باركود") as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: "لا يوجد" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(ctx.pushToast).toHaveBeenCalled());
    expect(document.activeElement).toBe(search);
  });

  it("F4/F9 fire even while focus is still IN the search box", async () => {
    const ctx = renderApp();
    const search = screen.getByLabelText("بحث في الأصناف أو مسح باركود");
    search.focus();
    fireEvent.keyDown(search, { key: "F9" });
    await waitFor(() => expect(ctx.engine.holdOrder).toHaveBeenCalledTimes(1));
  });
});
