import { describe, expect, it } from "vitest";
import { ar } from "../dictionaries/ar";
import { en } from "../dictionaries/en";

/**
 * Structural parity between the ar and en barrel exports. Ported from the POS
 * i18n test (frontend/pos/src/i18n/__tests__/dictionary.test.ts).
 *
 * As of the A1 scaffold the barrels carry `common` + `errors` + `states`. Other
 * agents append a namespace per module (tables, inventory, menu, …) and this
 * test exercises those too once they land, unchanged.
 *
 * Recursively walks both trees and asserts: identical key sets at every path,
 * and identical leaf `typeof` (string vs function) at every shared leaf. It
 * does NOT assert leaf VALUES match (translations differ by design) — only
 * shape.
 */
type AnyDict = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyDict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(a: AnyDict, b: AnyDict, path: string, errors: string[]): void {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  const label = path || "<root>";

  const missingInEn = aKeys.filter((k) => !bKeys.includes(k));
  const missingInAr = bKeys.filter((k) => !aKeys.includes(k));
  if (missingInEn.length || missingInAr.length) {
    errors.push(
      `Key mismatch at "${label}": missing in en=[${missingInEn.join(", ")}] missing in ar=[${missingInAr.join(", ")}]`,
    );
  }

  const shared = aKeys.filter((k) => bKeys.includes(k));
  for (const key of shared) {
    const av = a[key];
    const bv = b[key];
    const nextPath = path ? `${path}.${key}` : key;
    const aType = typeof av;
    const bType = typeof bv;

    if (aType !== bType) {
      errors.push(`Type mismatch at "${nextPath}": ar=${aType} en=${bType}`);
      continue;
    }

    if (isPlainObject(av) && isPlainObject(bv)) {
      walk(av, bv, nextPath, errors);
    }
    // string/function leaves: typeof already confirmed equal above, nothing
    // further to assert (values are intentionally different translations).
  }
}

describe("i18n dictionary structural parity (ar vs en)", () => {
  it("has identical namespace/key sets and identical leaf types at every path", () => {
    const errors: string[] = [];
    walk(ar as unknown as AnyDict, en as unknown as AnyDict, "", errors);
    expect(errors).toEqual([]);
  });

  it("is non-empty (sanity — catches an accidentally-emptied barrel)", () => {
    expect(Object.keys(ar).length).toBeGreaterThan(0);
    expect(Object.keys(en).length).toBeGreaterThan(0);
  });

  it("uses single-brace placeholders, the only form the interpolator understands", () => {
    // `format()` in ../interpolate replaces /\{(\w+)\}/ — SINGLE braces. A
    // template written `{{count}}` therefore renders as `{5}`: the inner
    // `{count}` is substituted and the outer braces survive as literal text.
    //
    // This was not hypothetical. The whole warehouse control centre shipped
    // with `{{…}}` and had been printing "Across {2} stocked items" and
    // "Page {1} of {3}" on a live screen — 52 placeholders across both
    // languages. Nothing failed, because a stray brace is not an error; it is
    // just wrong on the page, which is why a guard belongs here and not in a
    // reviewer's eye.
    const offenders: string[] = [];
    const scan = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        if (/\{\{\w+\}\}/.test(node)) offenders.push(`${path}: ${node.slice(0, 60)}`);
        return;
      }
      if (!isPlainObject(node)) return;
      for (const [key, value] of Object.entries(node)) scan(value, path ? `${path}.${key}` : key);
    };
    scan(ar as unknown as AnyDict, "ar");
    scan(en as unknown as AnyDict, "en");
    expect(offenders).toEqual([]);
  });
});
