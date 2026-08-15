// The two structural promises the People / Operations catalogues make.
//
//   1. A report row NEVER leaves /reports and is never a same-page anchor.
//      This is the rule the old sections broke (six of them opened a CRUD
//      workspace in another top-level section), so it is pinned here rather
//      than left to review.
//   2. Every registry entry is renderable: unique id, a group that exists, a
//      capability, at least one column, and a loader.
import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";
import { toReportSection } from "../engine";
import { PEOPLE_REPORTS_SECTION } from "../people/registry";
import { OPERATIONS_REPORTS_SECTION } from "../operations/registry";
import { PEOPLE_REPORT_LINKS } from "../people/directory";
import { OPERATIONS_REPORT_LINKS } from "../operations/directory";

const CATALOGUES = {
  "/reports/people": PEOPLE_REPORT_LINKS,
  "/reports/operations": OPERATIONS_REPORT_LINKS,
} as const;

const SECTIONS = [PEOPLE_REPORTS_SECTION, OPERATIONS_REPORTS_SECTION];

function resolve(dictionary: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[key];
    return undefined;
  }, dictionary);
}

describe("people & operations report registries", () => {
  it.each(SECTIONS.map((section) => [section.path, section] as const))(
    "%s — every report route stays inside /reports",
    (_path, section) => {
      for (const report of section.reports) {
        const to = `${section.path}/${report.id}`;
        expect(to.startsWith(`${section.path}/`)).toBe(true);
        expect(to).not.toContain("#");
        expect(to).not.toContain("?");
      }
    },
  );

  it.each(SECTIONS.map((section) => [section.path, section] as const))(
    "%s — ids are unique and every report is renderable",
    (_path, section) => {
      const ids = section.reports.map((report) => report.id);
      expect(new Set(ids).size).toBe(ids.length);
      const groups = new Set(section.groups.map((group) => group.id));
      for (const report of section.reports) {
        expect(groups.has(report.groupId)).toBe(true);
        expect(report.cap).toBeTruthy();
        expect(report.columns.length).toBeGreaterThan(0);
        expect(typeof report.load).toBe("function");
        expect(new Set(report.columns.map((column) => column.key)).size).toBe(report.columns.length);
        // At most ONE remote filter — the renderer holds exactly one options query.
        expect(report.filters.filter((filter) => filter.kind === "remote").length).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(SECTIONS.map((section) => [section.path, section] as const))(
    "%s — every i18n key path resolves in both languages",
    (_path, section) => {
      const paths = [
        section.titleKey,
        section.subtitleKey,
        section.eyebrowKey,
        ...section.groups.flatMap((group) => [group.titleKey, group.descriptionKey]),
        ...section.reports.flatMap((report) => [
          report.labelKey,
          report.descriptionKey,
          ...report.filters.flatMap((filter) => [
            filter.labelKey,
            ...(filter.options ?? []).map((option) => option.labelKey),
          ]),
          ...report.columns.flatMap((column) => [
            column.labelKey,
            ...Object.values(column.labels ?? {}),
          ]),
        ]),
      ];
      for (const path of paths) {
        expect(typeof resolve(ar, path), `ar: ${path}`).toBe("string");
        expect(typeof resolve(en, path), `en: ${path}`).toBe("string");
      }
    },
  );

  it("the hub serves both catalogues straight from the registries", () => {
    for (const section of SECTIONS) {
      const derived = toReportSection(section);
      const catalogue = CATALOGUES[section.path as keyof typeof CATALOGUES];
      expect(catalogue).toEqual(derived);
      const links = catalogue.groups.flatMap((group) => group.links);
      expect(links).toHaveLength(section.reports.length);
      for (const link of links) expect(link.to.startsWith("/reports/")).toBe(true);
    }
  });
});
