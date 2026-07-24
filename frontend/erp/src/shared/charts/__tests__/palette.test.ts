import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  resolveChartPalette,
  readChartPalette,
  useChartPalette,
  __resetChartPaletteCacheForTests,
} from "@/shared/charts/palette";

afterEach(() => {
  __resetChartPaletteCacheForTests();
});

describe("resolveChartPalette", () => {
  it("returns resolved token values when the reader provides them", () => {
    const reads: string[] = [];
    const palette = resolveChartPalette((token) => {
      reads.push(token);
      return ` value(${token}) `; // padded — must be trimmed
    });
    expect(palette.series).toHaveLength(8);
    expect(palette.series[0]).toBe("value(--mt-chart-1)");
    expect(palette.series[7]).toBe("value(--mt-chart-8)");
    expect(palette.grid).toBe("value(--mt-chart-grid)");
    expect(palette.axis).toBe("value(--mt-chart-axis)");
    expect(palette.pos).toBe("value(--mt-chart-pos)");
    expect(palette.neg).toBe("value(--mt-chart-neg)");
    expect(palette.warn).toBe("value(--mt-chart-warn)");
    // every token read exactly once
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("falls back to the var() reference for tokens the reader cannot resolve", () => {
    const palette = resolveChartPalette(() => "");
    expect(palette.series[0]).toBe("var(--mt-chart-1)");
    expect(palette.grid).toBe("var(--mt-chart-grid)");
    expect(palette.neg).toBe("var(--mt-chart-neg)");
  });

  it("mixes resolved and fallback values per token", () => {
    const palette = resolveChartPalette((token) => (token === "--mt-chart-2" ? "resolved" : ""));
    expect(palette.series[1]).toBe("resolved");
    expect(palette.series[0]).toBe("var(--mt-chart-1)");
  });
});

describe("readChartPalette", () => {
  it("memoizes: two reads return the same object", () => {
    const first = readChartPalette();
    const second = readChartPalette();
    expect(second).toBe(first);
  });

  it("in a DOM without the design-tokens stylesheet, every value is a var() reference (safe fallback)", () => {
    const palette = readChartPalette();
    for (const color of [...palette.series, palette.grid, palette.axis, palette.pos, palette.neg, palette.warn]) {
      expect(color).toMatch(/^var\(--mt-chart-/);
    }
  });
});

describe("useChartPalette", () => {
  it("returns a stable palette across re-renders", () => {
    const { result, rerender } = renderHook(() => useChartPalette());
    const first = result.current;
    expect(first.series).toHaveLength(8);
    rerender();
    expect(result.current).toBe(first);
  });
});
