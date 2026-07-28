import { describe, expect, it } from "vitest";
import { ar } from "../dictionaries/ar";
import { en } from "../dictionaries/en";

/**
 * Structural parity between the ar and en barrel exports. As of the i18n
 * scaffold (owner E) the barrels only carry `common` + `errors` — a later
 * merge stage adds every screen namespace, and this test will exercise
 * those too once they land, unchanged.
 *
 * Recursively walks both trees and asserts: identical key sets at every
 * path, and identical leaf `typeof` (string vs function) at every shared
 * leaf. It does NOT assert leaf VALUES match (translations differ by
 * design) — only shape.
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

/**
 * A function leaf is called with a plain NUMBER, never a params object.
 *
 * I18nProvider's makeT does `leaf(resolvePluralArg(vars))`. A leaf written as
 * `(p: { count: number; who: string }) => ...` therefore receives `5`, and
 * every field read off it is `undefined` — the cashier sees
 * "undefined pending operations synced". TypeScript does not catch it: the
 * DictionaryLeaf type is `(n: number, ...rest: unknown[]) => string`, which a
 * one-object-parameter function structurally satisfies.
 *
 * Shipped exactly that way in three namespaces on 2026-07-27, so this is the
 * guard rather than a note in a review checklist. Multi-variable strings must
 * be TEMPLATES with {placeholders}, which format() interpolates; only a
 * single-number plural may be a function.
 */
function collectFunctionLeaves(dict: AnyDict, path: string, out: Array<[string, (n: number) => string]>) {
  for (const [k, v] of Object.entries(dict)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "function") out.push([p, v as (n: number) => string]);
    else if (isPlainObject(v)) collectFunctionLeaves(v as AnyDict, p, out);
  }
}

describe("function leaves take a number, not a params object", () => {
  for (const [lang, dict] of [["ar", ar], ["en", en]] as const) {
    it(`every ${lang} function leaf renders without 'undefined'`, () => {
      const leaves: Array<[string, (n: number) => string]> = [];
      collectFunctionLeaves(dict as unknown as AnyDict, "", leaves);
      const broken: string[] = [];
      for (const [p, fn] of leaves) {
        for (const n of [0, 1, 2, 11]) {
          let rendered: string;
          try {
            rendered = fn(n);
          } catch (e) {
            broken.push(`${p} threw for n=${n}: ${(e as Error).message}`);
            continue;
          }
          if (typeof rendered !== "string" || rendered.includes("undefined")) {
            broken.push(`${p} rendered "${rendered}" for n=${n}`);
          }
        }
      }
      expect(broken).toEqual([]);
    });
  }
});
