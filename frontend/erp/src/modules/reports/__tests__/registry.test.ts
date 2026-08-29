// The central report catalogue.
//
// ─── WHY THIS TEST IS SHAPED AROUND "DERIVED, NOT LISTED" ───────────────────
// The catalogue's only real property is that nothing is declared in it. The
// moment someone hand-writes an entry it starts drifting from the section that
// owns the report, and the product goes back to where it was: a Saved Reports
// page whose hand-written 16-name array had drifted from the real 17, so every
// saved view on the Channels report was written successfully, never listed, and
// could not be deleted.
//
// So these assertions compare the catalogue AGAINST the source registries
// rather than against expected literals. A snapshot of 72 titles would pass
// while being just as stale as the array it replaced.
import { describe, expect, it } from "vitest";
import {
  REPORT_CATALOG,
  REPORT_SECTIONS,
  buildReportCatalog,
  canOpen,
  savedViewModule,
  savedViewModules,
  type CatalogEntry,
} from "../registry";
import { FINANCIAL_REPORTS } from "../financial/registry";
import { PURCHASING_REPORT_IDS } from "../purchasing/registry";
import { RECEIVABLES_REPORTS } from "../receivables/registry";
import { PEOPLE_REPORTS_SECTION } from "../people/registry";
import { OPERATIONS_REPORTS_SECTION } from "../operations/registry";
import { CENTERS } from "../sales/lib/reportRegistry";
import { INVENTORY_INTELLIGENCE_REPORTS } from "../warehouse/reportCatalog";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";

function resolve(dict: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    dict,
  );
}

describe("report catalogue", () => {
  it("indexes every report from every section registry", () => {
    // Counted from the SOURCES, so adding a report to any section updates both
    // sides of this assertion at once and it keeps meaning something.
    const expected =
      CENTERS.reduce((n, c) => n + c.views.length, 0) +
      RECEIVABLES_REPORTS.length +
      INVENTORY_INTELLIGENCE_REPORTS.length +
      PURCHASING_REPORT_IDS.length +
      FINANCIAL_REPORTS.length +
      PEOPLE_REPORTS_SECTION.reports.length +
      OPERATIONS_REPORTS_SECTION.reports.length;
    expect(REPORT_CATALOG.length).toBe(expected);
  });

  it("gives every report a unique key", () => {
    // `data-quality` exists in purchasing, inventory AND receivables. An
    // unscoped id would collapse three reports into one row and silently drop
    // two of them from the hub.
    const keys = REPORT_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("points every row at a real, refreshable address", () => {
    for (const entry of REPORT_CATALOG) {
      // Not an anchor into the page you are already on, and not a bare id.
      expect(entry.route.startsWith("/reports/")).toBe(true);
      expect(entry.route).not.toContain("#");
    }
  });

  it("places every report in one of the six sections", () => {
    const sections = new Set(REPORT_SECTIONS.map((s) => s.id));
    expect(sections.size).toBe(6);
    for (const entry of REPORT_CATALOG) expect(sections.has(entry.section)).toBe(true);
  });

  it("files receivables under sales — six sections, not seven", () => {
    const receivables = REPORT_CATALOG.filter((e) => e.route.startsWith("/reports/receivables/"));
    expect(receivables.length).toBe(RECEIVABLES_REPORTS.length);
    for (const entry of receivables) expect(entry.section).toBe("sales");
  });

  it("resolves every title in BOTH languages", () => {
    // A missing key renders the dotted path on screen, which reads as a broken
    // report rather than as missing copy.
    for (const entry of REPORT_CATALOG) {
      expect(resolve(ar, entry.titleKey), `ar: ${entry.titleKey}`).toBeTruthy();
      expect(resolve(en, entry.titleKey), `en: ${entry.titleKey}`).toBeTruthy();
    }
  });

  it("resolves every description it claims to have", () => {
    for (const entry of REPORT_CATALOG) {
      if (!entry.descriptionKey) continue;
      expect(resolve(ar, entry.descriptionKey), `ar: ${entry.descriptionKey}`).toBeTruthy();
      expect(resolve(en, entry.descriptionKey), `en: ${entry.descriptionKey}`).toBeTruthy();
    }
  });

  it("claims governance metadata ONLY where the owning registry declares it", () => {
    // The warehouse catalogue is the one registry carrying maturity/basis/
    // standard. Every badge must trace back to it — a report labelled
    // "authoritative" because its section felt trustworthy is fabricated
    // confidence, which is the thing this product refuses everywhere else.
    const declared = new Set(
      REPORT_CATALOG.filter((e) => e.maturity).map((e) => e.section),
    );
    expect([...declared].sort()).toEqual(["inventory", "purchasing"]);
    for (const entry of REPORT_CATALOG) {
      if (entry.section === "inventory" || entry.section === "purchasing") continue;
      expect(entry.maturity, entry.key).toBeUndefined();
      expect(entry.basis, entry.key).toBeUndefined();
      expect(entry.standard, entry.key).toBeUndefined();
    }
  });

  it("is a pure derivation — rebuilding produces the same catalogue", () => {
    // If any adapter reached for module-level mutable state or a Date, this
    // fails. A catalogue that differs between two builds cannot be reasoned
    // about by a search box or a favourites list keyed on `key`.
    const a = buildReportCatalog().map((e) => `${e.key}|${e.route}|${e.titleKey}`);
    const b = buildReportCatalog().map((e) => `${e.key}|${e.route}|${e.titleKey}`);
    expect(a).toEqual(b);
  });
});

describe("capability gating", () => {
  const entry = (over: Partial<CatalogEntry>): CatalogEntry =>
    ({ key: "k", id: "i", section: "sales", route: "/reports/sales/x", titleKey: "t", icon: (() => null) as never, ...over });

  it("capsAny is any-of", () => {
    const e = entry({ capsAny: ["reports.view", "analytics.view"] as never });
    expect(canOpen(e, (c) => c === "analytics.view")).toBe(true);
    expect(canOpen(e, () => false)).toBe(false);
  });

  it("a single cap is required", () => {
    const e = entry({ cap: "reports.view" as never });
    expect(canOpen(e, (c) => c === "reports.view")).toBe(true);
    expect(canOpen(e, () => false)).toBe(false);
  });

  it("no declared cap defers to the section guard", () => {
    expect(canOpen(entry({}), () => false)).toBe(true);
  });
});

describe("saved-view modules", () => {
  it("covers EVERY sales segment, including channels", () => {
    // The exact regression. The old hand-written array named 16 of 17 segments;
    // the missing one was `channels`, and a view saved there was invisible and
    // undeletable for as long as it existed.
    const modules = savedViewModules();
    expect(modules).toContain("analytics:channels");

    const segments = CENTERS.flatMap((c) => c.views);
    for (const segment of segments) {
      expect(modules, `segment ${segment} has no saved-views module`).toContain(`analytics:${segment}`);
    }
    expect(modules.length).toBe(new Set(segments).size);
  });

  it("gives a module ONLY to a real sales segment, never by URL shape", () => {
    // Only the sales hub persists views today, and membership is decided by the
    // sales registry — NOT by "the route starts with /reports/sales/".
    //
    // That inference is wrong and this test found it: the inventory catalogue
    // contains `sales-cost-profitability`, whose route deliberately points into
    // the sales hub as a cross-link. Reading the route minted
    // `analytics:sales-cost-profitability` — a module no segment answers to —
    // so the Saved Reports page would have fanned out over a dead key on every
    // load, forever.
    const segments = new Set(CENTERS.flatMap((c) => c.views));
    for (const e of REPORT_CATALOG) {
      const expected = e.section === "sales" && segments.has(e.id) ? `analytics:${e.id}` : null;
      expect(savedViewModule(e), e.key).toBe(expected);
    }
    // Prove the cross-link is actually present, or the case above is vacuous.
    const crossLink = REPORT_CATALOG.find((e) => e.id === "sales-cost-profitability");
    expect(crossLink, "the inventory→sales cross-link no longer exists").toBeTruthy();
    expect(crossLink!.route.startsWith("/reports/sales/")).toBe(true);
    expect(savedViewModule(crossLink!)).toBeNull();
  });

});
