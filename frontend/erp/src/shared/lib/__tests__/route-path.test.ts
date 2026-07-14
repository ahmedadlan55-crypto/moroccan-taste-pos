import { describe, it, expect } from "vitest";
import { normalizeRoutePath } from "../route-path";

// Regression guard for a REAL bug: react-router matches a route ignoring the
// trailing slash and case, but useLocation().pathname returns the RAW path. A
// module dispatching on the raw pathname therefore missed its own route table for
// "/accounting/journals/" and rendered a "not available" screen on a fully-built
// page. Every pathname-dispatching module now normalizes through this helper.
describe("normalizeRoutePath", () => {
  it("strips a trailing slash so a deep link with one still resolves", () => {
    expect(normalizeRoutePath("/accounting/journals/")).toBe("/accounting/journals");
    expect(normalizeRoutePath("/accounting/journals///")).toBe("/accounting/journals");
  });

  it("lower-cases (manifest paths are lower-case kebab)", () => {
    expect(normalizeRoutePath("/Accounting/Journals")).toBe("/accounting/journals");
  });

  it("leaves an already-canonical path untouched", () => {
    expect(normalizeRoutePath("/banking/reconciliation")).toBe("/banking/reconciliation");
  });

  it("keeps the root as '/'", () => {
    expect(normalizeRoutePath("/")).toBe("/");
    expect(normalizeRoutePath("//")).toBe("/");
  });
});
