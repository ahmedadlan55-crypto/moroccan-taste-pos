// The cash chain on screen.
//
// tests/analyticsCashChain.test.js proves the period totals are right and that
// the printed operands really produce the printed expected-cash figure. This
// file proves the two things only the rendering can get wrong:
//
//   • an uncounted drawer must read "—", not 0.00 — the whole reason the
//     contract keeps `counted` nullable all the way up;
//   • the two gaps mean OPPOSITE things and must not look alike. Billed-vs-
//     collected is a receivable and is expected to be non-zero the moment
//     anything is sold on account; expected-vs-counted is the only line that
//     should read zero. Painting both as "a difference" teaches the reader to
//     ignore both, which is exactly what the wide grid did.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import { CashChain } from "../components/CashChain";
import type { ReconciliationTotals } from "../lib/api";

const BASE: ReconciliationTotals = {
  salesVsPayments: 0,
  cashExpectedVsCounted: 0,
  paymentsWithoutOrder: 0,
  ordersWithoutPayment: 0,
  orders: 18,
  invoice_total: 1800,
  payments_in: 1700,
  payments_out: 50,
  open_float: 465,
  cash_sale: 1000,
  cash_refund: 40,
  pay_in: 30,
  pay_out: 35,
  deposit: 800,
  expected_cash: 620,
  counted: 265,
};

function renderChain(over: Partial<ReconciliationTotals> = {}) {
  return render(
    <I18nProvider>
      <CashChain totals={{ ...BASE, ...over }} />
    </I18nProvider>,
  );
}

const line = (id: string) => document.querySelector(`[data-chain-line="${id}"]`) as HTMLElement | null;
const gap = (id: string) => document.querySelector(`[data-chain-gap="${id}"]`) as HTMLElement | null;

afterEach(cleanup);

describe("the chain's lines", () => {
  it("renders the whole path — billed, collected, and every drawer movement", () => {
    renderChain();
    for (const id of ["invoiced", "in", "out", "net", "float", "cash_sale", "cash_refund", "pay_in", "pay_out", "deposit", "expected", "counted"]) {
      expect(line(id), `missing chain line "${id}"`).not.toBeNull();
    }
  });

  it("shows an uncounted drawer as '—', never as zero", () => {
    // A period where nobody counted the till. Printing 0.00 would claim the
    // drawer was counted and found empty, and the variance beside it would be
    // the entire expected cash.
    renderChain({ counted: null, cashExpectedVsCounted: null });
    expect(line("counted")!.textContent).toContain("—");
    expect(line("counted")!.textContent).not.toMatch(/0\.00/);
  });

  it("marks the computed lines so the reader can see what is derived", () => {
    renderChain();
    expect(line("net")!.textContent).toContain("=");
    expect(line("expected")!.textContent).toContain("=");
    // and the operands carry their sign
    expect(line("out")!.textContent).toContain("−");
    expect(line("pay_in")!.textContent).toContain("+");
  });
});

describe("the two gaps do not look alike", () => {
  it("a receivable reads as information, not as an error", () => {
    // Billed 1,800 and collected 1,650: 150 sold on account. Real, expected,
    // and NOT a problem — so it must not carry the alarm styling.
    renderChain({ salesVsPayments: 150, cashExpectedVsCounted: 0 });
    const g = gap("billed-vs-collected")!;
    expect(g.className).toContain("blue");
    expect(g.className).not.toContain("rose");
  });

  it("an unexplained drawer difference reads as an exception", () => {
    renderChain({ salesVsPayments: 0, cashExpectedVsCounted: 12.5 });
    const g = gap("expected-vs-counted")!;
    expect(g.className).toContain("rose");
  });

  it("neither is alarmed when both are clean", () => {
    renderChain({ salesVsPayments: 0, cashExpectedVsCounted: 0 });
    expect(gap("billed-vs-collected")!.className).not.toContain("rose");
    expect(gap("expected-vs-counted")!.className).not.toContain("rose");
  });

  it("each gap says what it MEANS, not just what it is", () => {
    renderChain();
    expect(gap("billed-vs-collected")!.textContent).toContain("آجل");
    expect(gap("expected-vs-counted")!.textContent).toContain("صفرًا");
  });
});
