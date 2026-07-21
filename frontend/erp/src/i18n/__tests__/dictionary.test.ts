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
});
