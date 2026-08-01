// One house style for every report printed inside the system.
//
// THE DEFECT, measured across the whole ERP before this component existed:
// twenty screens called `window.print()`. Eleven wrapped their body so the
// print stylesheet could hide the app chrome; SEVEN did not, and printed the
// sidebar, the filter bar and every button along with the report. And not one
// of the twenty put a title, a period or a printed-at stamp on the paper —
// two sheets from two different days were indistinguishable, and a sheet
// handed to an accountant did not say what it was.
//
// The structural test at the bottom is the one that matters: it walks the
// SOURCE of every screen that calls window.print() and fails if any of them
// prints without a document wrapper. A rendering test cannot see a screen
// nobody wrote a test for.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { I18nProvider } from "@/i18n";
import { PrintDocument } from "../print-document";

const SRC = path.resolve(__dirname, "../../..");

function renderDoc(props: Partial<React.ComponentProps<typeof PrintDocument>> = {}) {
  return render(
    <I18nProvider>
      <PrintDocument title="تقرير الأصناف" {...props}>
        <p>body</p>
      </PrintDocument>
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("the printed document's head", () => {
  it("names the report", () => {
    renderDoc();
    expect(screen.getByTestId("print-masthead").textContent).toContain("تقرير الأصناف");
  });

  it("carries a printed-at stamp, so two sheets from two days are distinguishable", () => {
    renderDoc({ printedAt: "2026-07-29T09:00:00.000Z" });
    expect(screen.getByTestId("print-masthead").textContent).toContain("طُبع في");
  });

  it("shows the period and the basis when given them", () => {
    renderDoc({ subtitle: "2026-07-01 — 2026-07-31", meta: "يوم العمل · شامل الضريبة" });
    const head = screen.getByTestId("print-masthead").textContent ?? "";
    expect(head).toContain("2026-07-01");
    expect(head).toContain("يوم العمل");
  });

  it("omits the subtitle line rather than printing an empty one", () => {
    renderDoc();
    expect(screen.getByTestId("print-masthead").textContent).not.toContain("—");
  });

  it("is print-only, and marks its body as THE printable document", () => {
    renderDoc();
    const head = screen.getByTestId("print-masthead");
    // jsdom loads no stylesheet, so assert the CONTRACT — the classes the print
    // stylesheet keys off — rather than a computed style that would be a lie.
    expect(head.className).toContain("print-only");
    expect(head.closest(".print-document"), "the head sits outside the print area").not.toBeNull();
  });
});

/* ── the structural rule ────────────────────────────────────────────────────
 * A screen that can print must say WHAT it prints. Without this, the next
 * print button added anywhere in the ERP silently reintroduces the defect:
 * it works on screen, and only someone standing at a printer finds out.
 */
describe("every screen that prints, prints a document", () => {
  /** Every .tsx under src that calls window.print() or printReport(). */
  function printingFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        printingFiles(p, out);
      } else if (e.name.endsWith(".tsx")) {
        const src = fs.readFileSync(p, "utf8");
        if (/window\.print\(\)|printReport\(\)/.test(src)) out.push(p);
      }
    }
    return out;
  }

  /**
   * Files that legitimately trigger a print they do not own the layout of.
   * Each entry names WHY, so the list cannot quietly become a dumping ground.
   */
  const ALLOWED: Record<string, string> = {
    // A reusable print BUTTON. The pages that use it own their own wrapper.
    "detail-shared.tsx": "shared print button; the calling detail page wraps",
    // The printing helper itself.
    "components.tsx": "defines printReport()/PrintArea for the accounting module",
    // A hub SEGMENT. SalesAnalyticsHub wraps whichever segment is routed, so
    // the print button here triggers the hub's document — the page owning its
    // own wrapper would nest two of them.
    "Executive.tsx": "rendered inside SalesAnalyticsHub's PrintDocument",
  };

  it("has no screen that prints without a print-document wrapper", () => {
    const offenders = printingFiles(SRC)
      .filter((p) => {
        const src = fs.readFileSync(p, "utf8");
        const wrapped = /PrintDocument|PrintArea|print-document/.test(src);
        return !wrapped && !ALLOWED[path.basename(p)];
      })
      .map((p) => path.relative(SRC, p));

    expect(
      offenders,
      `these screens call print() with no document wrapper, so they print the ` +
        `sidebar, the filter bar and every button along with the report:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("still finds the printing screens at all — the probe must not silently pass", () => {
    // A regex that matched nothing would make the test above vacuously green.
    expect(printingFiles(SRC).length).toBeGreaterThan(10);
  });
});
