/**
 * i18n type contract — shared by the provider, every module dictionary, and
 * the barrel merge stage. Ported verbatim from the POS i18n system
 * (frontend/pos/src/i18n/types.ts) so both apps speak the identical shape.
 *
 * Kept intentionally pragmatic: the goal is that a shape mismatch between
 * `ar` and `en` surfaces as a TS error when the barrel type-checks `en`
 * against `ar`'s shape (or vice versa) once every module namespace exists —
 * not that each individual module file needs elaborate typing today.
 */

/** t(path, vars) — looks up a DOTTED path across the whole merged dictionary. */
export type TFunction = (path: string, vars?: Record<string, string | number>) => string;

/**
 * A dictionary leaf is either a plain string, or a pluralization function.
 * Plural leaves are written as `(n: number) => string` — see I18nProvider's
 * calling convention docs for how `t()` resolves the numeric argument.
 */
export type DictionaryLeaf = string | ((n: number, ...rest: unknown[]) => string);

/** A recursive namespace object: string/function leaves, or nested namespaces. */
export type Dictionary = {
  [key: string]: DictionaryLeaf | Dictionary;
};
