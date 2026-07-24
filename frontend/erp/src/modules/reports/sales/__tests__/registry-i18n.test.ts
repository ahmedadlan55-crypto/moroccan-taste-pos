// Sales Analytics Hub — registry ↔ i18n coverage. Every metric / dimension /
// equation code pinned by lib/registry-fixture.ts (copied from
// lib/analytics/registry/*) must resolve to a non-empty string in BOTH the
// Arabic and English dictionaries — and the dictionaries must not carry stale
// extra codes either (exact set equality catches drift in both directions).
// The hub's 16 segments are held to the same standard for pages.<id> copy.
import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";
import { DIMENSION_CODES, EQUATION_KEYS, METRIC_CODES } from "../lib/registry-fixture";
import { SALES_HUB_SEGMENTS } from "../SalesAnalyticsHub";

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

  it("has title + subtitle for every hub segment (and no stale pages)", () => {
    const segmentIds = SALES_HUB_SEGMENTS.map((s) => s.id).sort();
    expect(Object.keys(sr.pages).sort()).toEqual(segmentIds);
    for (const id of segmentIds) {
      expect(sr.pages[id].title.length, `pages.${id}.title`).toBeGreaterThan(0);
      expect(sr.pages[id].subtitle.length, `pages.${id}.subtitle`).toBeGreaterThan(0);
    }
  });
});
