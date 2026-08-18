// Key parity between ar and en.
//
// The portal is used in both languages by the same people on the same shift.
// A key present in one dictionary and missing from the other renders its own
// dotted path — "profile.net" under a salary figure — which is worse than an
// untranslated word. This makes that a build failure instead of a bug report.
import { describe, expect, it } from "vitest";
import { ar, en } from "../dict";
import { makeT } from "..";

function paths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    paths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("ar/en dictionary parity", () => {
  const arKeys = paths(ar).sort();
  const enKeys = paths(en).sort();

  it("has the same key set in both languages", () => {
    expect(enKeys.filter((k) => !arKeys.includes(k)), "keys in en but not ar").toEqual([]);
    expect(arKeys.filter((k) => !enKeys.includes(k)), "keys in ar but not en").toEqual([]);
  });

  it("has no empty strings", () => {
    const empty = [...paths(ar), ...paths(en)].filter((p) => {
      const t = makeT("ar");
      return t(p).trim() === "";
    });
    expect(empty).toEqual([]);
  });

  it("carries the same {placeholders} in both languages", () => {
    // A translation that drops {name} renders a greeting addressed to nobody;
    // one that invents {date} renders the literal braces to the employee.
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const tAr = makeT("ar");
    const tEn = makeT("en");
    const mismatched = arKeys.filter(
      (k) => JSON.stringify(placeholders(tAr(k))) !== JSON.stringify(placeholders(tEn(k))),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("t()", () => {
  it("interpolates named vars", () => {
    expect(makeT("en")("home.greeting", { name: "Sara" })).toBe("Hello, Sara");
  });

  it("leaves an unknown placeholder alone rather than printing undefined", () => {
    expect(makeT("en")("home.greeting", { other: "x" })).toBe("Hello, {name}");
  });

  it("returns the key itself when it does not exist — visible, not silent", () => {
    expect(makeT("ar")("nope.not.here")).toBe("nope.not.here");
  });
});
