// The inventory report's PDF must describe the WHOLE report.
//
// ─── THE DEFECT THIS PREVENTS ───────────────────────────────────────────────
// The screen shows one server page. `withPrintSnapshot` exists because
// printing straight from that DOM produces a sheet that looks like the report
// and silently stops partway — the single worst failure a report can have,
// because nothing about the paper says it is incomplete.
//
// Print already goes through it. When PDF was added the obvious wiring —
// `onClick={renderPdf}` — would have captured the same partial DOM and
// produced a partial PDF, with no error anywhere. So PDF rides the identical
// snapshot window, and this pins that.
//
// ─── WHY A SOURCE-LEVEL CHECK ───────────────────────────────────────────────
// Rendering this page needs routing, permissions, warehouse scope and a live
// query client, and even then "the capture saw the full table" is asserted by
// reaching into a mocked DOM. The invariant is a WIRING rule — which callback
// the button is attached to — and reading the wiring directly tests it without
// a fixture that could pass for the wrong reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(__dirname, "..", "features", "reports", "ReportDetailPage.tsx"),
  "utf8",
);

/** Source with comments stripped — a rule must not be satisfied by prose. */
// Normalise line endings FIRST. This file is CRLF, and `.` does not match
// a carriage return — so a `//` comment strip anchored on $ silently matches
// nothing and leaves every comment in the "code".
const CODE = SOURCE
  .split(String.fromCharCode(13)).join("")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

describe("inventory report PDF rides the print snapshot", () => {
  it("still has a snapshot window at all", () => {
    expect(CODE).toContain("async function withPrintSnapshot");
    // The whole point of the window: the complete rows are committed before
    // anything captures the DOM.
    expect(CODE).toContain("fetchReportPrintSnapshot");
    expect(CODE).toContain("flushSync");
  });

  it("routes PDF through it, not straight at the renderer", () => {
    expect(CODE).toMatch(/function onPdf\(\)\s*\{\s*return withPrintSnapshot\(renderPdf\);\s*\}/);
  });

  it("routes print through it too, so both emit the same document", () => {
    expect(CODE).toMatch(/function onPrint\(\)\s*\{\s*return withPrintSnapshot\(/);
  });

  it("never calls the renderer outside the snapshot window", () => {
    // `renderPdf` may appear exactly twice: once destructured from the hook,
    // once handed to withPrintSnapshot. A third occurrence means somebody
    // found a way to render without the full rows.
    const uses = CODE.match(/\brenderPdf\b/g) || [];
    expect(uses.length).toBe(2);
  });

  it("never prints outside it either", () => {
    // The only `window.print()` is the one inside onPrint's emitter. The PDF
    // path's own fallback lives in the shared hook, which is called from
    // inside the window — so it prints the complete document too.
    const prints = CODE.match(/window\.print\(\)/g) || [];
    expect(prints.length).toBe(1);
  });

  it("disables PDF on exactly the conditions that disable print", () => {
    // A PDF button that stayed live while print was blocked would put the same
    // half-loaded report on paper by another route.
    const guard = "disabled={!data || isFetching || printing}";
    const guards = CODE.split(guard).length - 1;
    expect(guards).toBe(2);
  });
});
