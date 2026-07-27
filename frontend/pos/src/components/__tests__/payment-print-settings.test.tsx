/**
 * PaymentDialog printing — the three owner settings the SALE path ignored.
 *
 *  1. ReceiptPaperWidth  — buildReceiptHtml was called with no `paperWidth`, so
 *     every fresh sale printed the 80mm default while a REPRINT of the same
 *     sale honoured the setting. A 58mm shop got clipped receipts that read as
 *     a printer fault.
 *  2. ReceiptAutoPrint   — resolveAutoPrint() existed, was exported and was
 *     unit-tested, but had ZERO non-test callers: «طباعة تلقائية» did nothing.
 *     The window MUST be opened synchronously inside the confirm click (a
 *     window opened after the checkout await is popup-blocked), parked in a
 *     ref (not state — StrictMode would print twice), and closed on any
 *     non-success outcome.
 *  3. Kitchen ticket paper width + language — both arguments were defaulted
 *     away, so an English 58mm till printed an 80mm ARABIC ticket.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { Catalog } from "@/lib/types";
import type { CheckoutOutcome } from "@/lib/offline";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeCatalog, makeFakeEngine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

// Real builders (the whole point is asserting the HTML they produce); only the
// two print sinks are stubbed so nothing tries to open a window in jsdom.
vi.mock("@/lib/receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt")>();
  return {
    ...actual,
    printHtml: vi.fn(() => true),
    // Mirrors the real contract: no usable handle ⇒ false (never opens one).
    printHtmlInto: vi.fn((_html: string, win: Window | null | undefined) => !!win && !win.closed),
  };
});

import { PaymentDialog } from "../dialogs/PaymentDialog";
import { printHtml, printHtmlInto } from "@/lib/receipt";
import { I18nProvider } from "@/i18n/I18nProvider";

/** `receiptSettings` rides on the catalog payload but is not declared on the
 *  Catalog type (defensive-read by design — see resolvePaperWidth). */
function catalogWithSettings(settings: Record<string, unknown>): Catalog {
  return makeCatalog({ receiptSettings: settings } as unknown as Partial<Catalog>);
}

/** A fake popup handle: records what the dialog does to it. */
function fakeWindow() {
  return { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }) };
}

function renderDialog(ctx: PosContextValue, opts: { strict?: boolean } = {}) {
  currentCtx = ctx;
  const tree = (
    <I18nProvider>
      <PaymentDialog open onClose={() => {}} />
    </I18nProvider>
  );
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const CONFIRM = /تأكيد الدفع/;

async function payAndSucceed() {
  fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
  await screen.findByText("تم الدفع بنجاح");
}

beforeEach(() => {
  cleanup();
  vi.mocked(printHtml).mockClear();
  vi.mocked(printHtmlInto).mockClear();
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("1 — the SALE receipt honours the owner's paper width", () => {
  it("58mm in the catalog reaches the printed sale receipt", async () => {
    renderDialog(makeCtx({ catalog: catalogWithSettings({ paperWidth: "58", autoPrint: "0" }) }));
    await payAndSucceed();
    fireEvent.click(screen.getByRole("button", { name: "طباعة الإيصال" }));
    expect(vi.mocked(printHtml).mock.calls[0][0]).toContain('data-paper="58"');
  });

  it("A4 reaches it too — the value is read, not hardcoded", async () => {
    renderDialog(makeCtx({ catalog: catalogWithSettings({ paperWidth: "A4", autoPrint: "0" }) }));
    await payAndSucceed();
    fireEvent.click(screen.getByRole("button", { name: "طباعة الإيصال" }));
    expect(vi.mocked(printHtml).mock.calls[0][0]).toContain('data-paper="A4"');
  });

  it("no setting at all still prints the historical 80mm default", async () => {
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "0" }) }));
    await payAndSucceed();
    fireEvent.click(screen.getByRole("button", { name: "طباعة الإيصال" }));
    expect(vi.mocked(printHtml).mock.calls[0][0]).toContain('data-paper="80"');
  });
});

describe("2 — ReceiptAutoPrint is actually wired", () => {
  it("opens the print window SYNCHRONOUSLY inside the click, before the checkout await", () => {
    const win = fakeWindow();
    const open = vi.fn((_url?: string, _target?: string, _features?: string) => win as unknown as Window);
    vi.stubGlobal("open", open);
    // A checkout that never settles: if the window were opened after the await
    // (the popup-blocked bug) nothing would have been opened at this point.
    const engine = makeFakeEngine();
    engine.checkout.mockImplementation(() => new Promise<CheckoutOutcome>(() => {}));
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "1" }), engine }));

    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    expect(open).toHaveBeenCalledTimes(1); // still the click's own task
    expect(open.mock.calls[0][0]).toBe("");
  });

  it("writes the receipt into that same pre-opened window on success", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win as unknown as Window));
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "1", paperWidth: "58" }) }));
    await payAndSucceed();

    await waitFor(() => expect(printHtmlInto).toHaveBeenCalledTimes(1));
    const [html, handle] = vi.mocked(printHtmlInto).mock.calls[0];
    expect(handle).toBe(win);
    expect(html).toContain('data-paper="58"'); // and it is the SAME builder as the manual button
    expect(win.close).not.toHaveBeenCalled(); // a printing window is never closed under it
  });

  it("autoPrint='0' opens nothing and prints nothing — the manual button still works", async () => {
    const open = vi.fn(() => fakeWindow() as unknown as Window);
    vi.stubGlobal("open", open);
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "0" }) }));
    await payAndSucceed();

    expect(open).not.toHaveBeenCalled();
    expect(printHtmlInto).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "طباعة الإيصال" }));
    expect(printHtml).toHaveBeenCalledTimes(1);
  });

  it("a BLOCKED popup falls back to a toast, never a silent loss", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    const ctx = makeCtx({ catalog: catalogWithSettings({ autoPrint: "1" }) });
    renderDialog(ctx);
    await payAndSucceed();

    await waitFor(() => expect(printHtmlInto).toHaveBeenCalledWith(expect.any(String), null));
    expect(ctx.pushToast).toHaveBeenCalledWith("error", "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة");
    // …and the manual affordance is still on screen.
    expect(screen.getByRole("button", { name: "طباعة الإيصال" })).toBeInTheDocument();
  });

  it("closes the parked window when the sale FAILS (no blank popup left behind)", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win as unknown as Window));
    const engine = makeFakeEngine();
    engine.checkout.mockImplementation(
      async (): Promise<CheckoutOutcome> => ({ state: "failed", invoiceNumber: null, saleId: null, error: "رُفضت العملية" }),
    );
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "1" }), engine }));

    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    await screen.findByText("رُفضت العملية");
    expect(win.close).toHaveBeenCalled();
    expect(printHtmlInto).not.toHaveBeenCalled();
  });

  it("StrictMode prints ONCE per sale — the handle is a ref, not state", async () => {
    const win = fakeWindow();
    const open = vi.fn(() => win as unknown as Window);
    vi.stubGlobal("open", open);
    renderDialog(makeCtx({ catalog: catalogWithSettings({ autoPrint: "1" }) }), { strict: true });
    await payAndSucceed();

    await waitFor(() => expect(printHtmlInto).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("3 — the kitchen ticket carries paper width AND language", () => {
  it("prints at the configured width, in the UI language (ar under vitest)", async () => {
    renderDialog(makeCtx({ catalog: catalogWithSettings({ paperWidth: "58", autoPrint: "0" }) }));
    await payAndSucceed();
    fireEvent.click(screen.getByRole("button", { name: "طباعة للمطبخ" }));

    const html = vi.mocked(printHtml).mock.calls[0][0];
    expect(html).toContain('data-paper="58"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain('dir="rtl"');
  });

  it("an ENGLISH till prints an ENGLISH ticket (the receipt.kitchen.en namespace was unreachable)", async () => {
    window.localStorage.setItem("pos_lang", "en");
    renderDialog(makeCtx({ catalog: catalogWithSettings({ paperWidth: "58", autoPrint: "0" }) }));

    fireEvent.click(screen.getByRole("button", { name: /Confirm payment/ }));
    await screen.findByText("Payment successful");
    fireEvent.click(screen.getByRole("button", { name: "Print for kitchen" }));

    const html = vi.mocked(printHtml).mock.calls[0][0];
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('data-paper="58"');
    expect(html).not.toContain("تذكرة المطبخ");
  });
});

/** Guards the shared adapter used by both print paths above. */
describe("printHtmlInto — never opens a window of its own", async () => {
  const actual = await vi.importActual<typeof import("@/lib/receipt")>("@/lib/receipt");
  it("returns false for a missing or already-closed handle", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    expect(actual.printHtmlInto("<p/>", null)).toBe(false);
    expect(actual.printHtmlInto("<p/>", { closed: true } as unknown as Window)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("writes into a live handle and prints it", () => {
    const doc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const win = { closed: false, document: doc, setTimeout: vi.fn(), focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    expect(actual.printHtmlInto("<p>x</p>", win as unknown as Window)).toBe(true);
    expect(doc.write).toHaveBeenCalledWith("<p>x</p>");
  });
});
