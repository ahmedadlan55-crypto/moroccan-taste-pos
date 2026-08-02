// Sales Analytics Hub — registry ↔ i18n coverage. Every metric / dimension /
// equation code pinned by lib/registry-fixture.ts (copied from
// lib/analytics/registry/*) must resolve to a non-empty string in BOTH the
// Arabic and English dictionaries — and the dictionaries must not carry stale
// extra codes either (exact set equality catches drift in both directions).
// Every REPORT and every CENTRE in lib/reportRegistry is held to the same
// standard for its pages.<id> / centers.<id> copy — so a report cannot be
// declared without the words that name it in either language.
import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";
import { DIMENSION_CODES, EQUATION_KEYS, METRIC_CODES } from "../lib/registry-fixture";
import { ALL_FILTER_KEYS, CENTERS, REPORTS } from "../lib/reportRegistry";

const DICTS = { ar, en } as const;

function leaves(obj: Record<string, unknown>): Record<string, unknown> {
  return obj;
}

describe.each(Object.entries(DICTS))("salesReports dictionary coverage (%s)", (_lang, dict) => {
  const sr = dict.salesReports as unknown as {
    metrics: Record<string, string>;
    dims: Record<string, string>;
    explain: Record<string, string>;
    pages: Record<string, { title: string; subtitle: string }>;
    centers: Record<string, { title: string; subtitle: string }>;
    topbar: { filterNames: Record<string, string> };
  };

  it("covers EXACTLY the fixture metric codes", () => {
    expect(Object.keys(leaves(sr.metrics)).sort()).toEqual([...METRIC_CODES].sort());
    for (const code of METRIC_CODES) {
      expect(sr.metrics[code], `metrics.${code}`).toBeTypeOf("string");
      expect(sr.metrics[code].length, `metrics.${code}`).toBeGreaterThan(0);
    }
  });

  it("covers EXACTLY the fixture dimension codes", () => {
    expect(Object.keys(leaves(sr.dims)).sort()).toEqual([...DIMENSION_CODES].sort());
    for (const code of DIMENSION_CODES) {
      expect(sr.dims[code], `dims.${code}`).toBeTypeOf("string");
      expect(sr.dims[code].length, `dims.${code}`).toBeGreaterThan(0);
    }
  });

  it("covers EXACTLY the fixture equation keys with formula prose", () => {
    // "trigger" is a UI-only key (the ExplainNumber trigger label — wave 4),
    // NOT an equation key; it is carved out of the exact-set comparison.
    const equationOnly = Object.keys(leaves(sr.explain)).filter((k) => k !== "trigger");
    expect(equationOnly.sort()).toEqual([...EQUATION_KEYS].sort());
    for (const key of EQUATION_KEYS) {
      expect(sr.explain[key], `explain.${key}`).toBeTypeOf("string");
      expect(sr.explain[key].length, `explain.${key}`).toBeGreaterThan(0);
    }
  });

  it("has title + subtitle for EXACTLY the registry's reports (no stale pages)", () => {
    const reportIds = REPORTS.map((r) => r.id).sort();
    expect(Object.keys(sr.pages).sort()).toEqual(reportIds);
    for (const id of reportIds) {
      expect(sr.pages[id].title.length, `pages.${id}.title`).toBeGreaterThan(0);
      expect(sr.pages[id].subtitle.length, `pages.${id}.subtitle`).toBeGreaterThan(0);
    }
  });

  it("has title + subtitle for EXACTLY the five centres", () => {
    const centerIds = CENTERS.map((c) => c.id).sort();
    expect(Object.keys(sr.centers).sort()).toEqual(centerIds);
    for (const id of centerIds) {
      expect(sr.centers[id].title.length, `centers.${id}.title`).toBeGreaterThan(0);
      expect(sr.centers[id].subtitle.length, `centers.${id}.subtitle`).toBeGreaterThan(0);
    }
  });

  it("names every filter key, so the auto-drop notice never prints a code", () => {
    // The hub says WHICH filters it cleared. Without a name per key that
    // sentence would read "brandId, menuItemId" — an identifier, in a message
    // whose whole job is to explain a change the reader did not ask for.
    expect(Object.keys(sr.topbar.filterNames).sort()).toEqual([...ALL_FILTER_KEYS].sort());
    for (const key of ALL_FILTER_KEYS) {
      expect(sr.topbar.filterNames[key].length, `topbar.filterNames.${key}`).toBeGreaterThan(0);
    }
  });
});
