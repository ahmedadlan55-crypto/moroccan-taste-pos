import type { TFunction } from "./types";

/**
 * Translate an ApiError-shaped `unknown` (see shared/api/api-error.ts's
 * ApiError: { kind, status, code, message }) into a user-facing string, so
 * call sites stop rendering a raw, possibly-English, possibly-technical server
 * string.
 *
 * Ported from the POS i18n system (frontend/pos/src/i18n/errorCodes.ts) — same
 * resolution contract.
 *
 * Resolution order:
 *   1. `errors.<code>` in the current dictionary, when `e.code` is a
 *      non-empty string AND that path actually resolves (t() returns the
 *      dotted path itself, unchanged, on a miss — see I18nProvider — so a
 *      miss is detected by comparing the result to the path).
 *   2. `e.message`, when it's a non-empty string.
 *   3. `String(e)`, as a last resort for non-Error throws.
 *   4. `errors.SERVER_ERROR` — always defined, so this never returns
 *      blank/undefined.
 */
export function translateApiError(e: unknown, t: TFunction): string {
  const code = hasStringProp(e, "code") ? e.code : undefined;
  if (code) {
    const path = `errors.${code}`;
    const translated = t(path);
    if (translated && translated !== path) return translated;
  }

  const message = hasStringProp(e, "message") ? e.message : undefined;
  if (message && message.trim()) return message;

  if (typeof e === "string" && e.trim()) return e;

  try {
    const s = String(e);
    if (s && s !== "undefined" && s !== "null" && s !== "[object Object]") return s;
  } catch {
    /* String() threw (e.g. a Symbol with no toString) — fall through */
  }

  return t("errors.SERVER_ERROR");
}

function hasStringProp<K extends string>(e: unknown, key: K): e is Record<K, string> {
  return typeof e === "object" && e !== null && key in e && typeof (e as Record<string, unknown>)[key] === "string";
}
