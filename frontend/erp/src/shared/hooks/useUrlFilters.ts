// useUrlFilters — typed, codec-driven URL filter state for analytics pages.
//
// The Sales Analytics Hub keeps its filter state in the URL (shareable deep
// links, drill-downs, back-button friendly). This hook generalizes the
// AnalyticsPage `patchParams` pattern: a FilterCodec declares how a typed
// filter object maps to/from URLSearchParams, and the hook ONLY ever touches
// the keys the codec's serialize() returns — foreign params (e.g. ?doc opened
// by a drawer, ?wh owned by the Topbar warehouse scope) always survive.
//
// Navigation semantics: patch() uses replace:true by default (filter tweaks
// don't spam history); pass { push: true } for drill-downs that should create
// a history entry the user can Back out of. href() renders the would-be URL
// for real <a>/<Link> deep links without navigating.
//
// NOTE: pass a STABLE codec (module-level const, or useMemo) — the returned
// callbacks and the parsed `filters` are memoized against its identity.
import { useCallback, useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

export interface FilterCodec<T> {
  parse(sp: URLSearchParams): T;
  serialize(v: T): Record<string, string | null>;
}

export interface UrlFiltersApi<T> {
  /** The current filters, parsed from the live URLSearchParams (memoized). */
  filters: T;
  /** Merge a partial update into the URL. replace by default; push:true adds a history entry (drills). */
  patch(partial: Partial<T>, opts?: { push?: boolean }): void;
  /** Remove every codec-owned key from the URL (foreign keys survive). */
  reset(): void;
  /** `${pathname}?${qs}` for the URL patch() would produce — for <Link to={...}> deep links. */
  href(partial: Partial<T>): string;
}

/** Apply a serialized patch onto params: null removes the key, a string sets it. */
function applySerialized(params: URLSearchParams, patch: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) params.delete(key);
    else params.set(key, value);
  }
}

export function useUrlFilters<T>(codec: FilterCodec<T>): UrlFiltersApi<T> {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();

  const filters = useMemo(() => codec.parse(searchParams), [codec, searchParams]);

  const patch = useCallback(
    (partial: Partial<T>, opts?: { push?: boolean }) => {
      // Functional update: rapid successive patches each see the latest params.
      setSearchParams(
        (prev) => {
          const merged = { ...codec.parse(prev), ...partial };
          const next = new URLSearchParams(prev);
          applySerialized(next, codec.serialize(merged));
          return next;
        },
        { replace: !opts?.push },
      );
    },
    [codec, setSearchParams],
  );

  const reset = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        // serialize() returns EVERY codec-owned key (null for defaults), so its
        // key set is exactly the set of keys reset() must clear.
        for (const key of Object.keys(codec.serialize(codec.parse(prev)))) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [codec, setSearchParams]);

  const href = useCallback(
    (partial: Partial<T>): string => {
      const merged = { ...filters, ...partial };
      const next = new URLSearchParams(searchParams);
      applySerialized(next, codec.serialize(merged));
      const qs = next.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [codec, filters, searchParams, pathname],
  );

  return useMemo(() => ({ filters, patch, reset, href }), [filters, patch, reset, href]);
}

/* ────────────────────────────────────────────────────────────────
 * makeCodec — build a FilterCodec from per-key ParamCodec specs.
 * Each ParamCodec serializes its DEFAULT to null (key removed →
 * clean URLs); parse of a missing/invalid raw returns the default.
 * ──────────────────────────────────────────────────────────────── */

export interface ParamCodec<V> {
  parse(raw: string | null): V;
  serialize(value: V): string | null;
}

/** Plain string param. "" (or the default) serializes to null → key removed. */
export function stringParam(defaultValue = ""): ParamCodec<string> {
  return {
    parse: (raw) => raw ?? defaultValue,
    serialize: (v) => (v === defaultValue || v === "" ? null : v),
  };
}

/** Boolean param serialized as "1"/"0"; the default serializes to null. */
export function boolParam(defaultValue = false): ParamCodec<boolean> {
  return {
    parse: (raw) => {
      if (raw === "1" || raw === "true") return true;
      if (raw === "0" || raw === "false") return false;
      return defaultValue;
    },
    serialize: (v) => (v === defaultValue ? null : v ? "1" : "0"),
  };
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * string[] param serialized as a comma-joined list. The default serializes to
 * null; a non-default EMPTY selection serializes to "" (key present, empty) so
 * "cleared" stays distinguishable from "use the default".
 */
export function csvParam(defaultValue: string[] = []): ParamCodec<string[]> {
  return {
    parse: (raw) => {
      if (raw == null) return [...defaultValue];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    },
    serialize: (v) => {
      if (sameArray(v, defaultValue)) return null;
      return v.join(",");
    },
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO "YYYY-MM-DD" param; malformed raw values fall back to the default. */
export function dateParam(defaultValue = ""): ParamCodec<string> {
  return {
    parse: (raw) => (raw != null && ISO_DATE_RE.test(raw) ? raw : defaultValue),
    serialize: (v) => (v === defaultValue || !ISO_DATE_RE.test(v) ? null : v),
  };
}

type ParamSpec = Record<string, ParamCodec<unknown>>;
type CodecShape<S extends ParamSpec> = { [K in keyof S]: S[K] extends ParamCodec<infer V> ? V : never };

/**
 * Compose per-key ParamCodecs into one FilterCodec:
 *
 *   const codec = makeCodec({
 *     q: stringParam(), from: dateParam(), branches: csvParam(), compare: boolParam(),
 *   });
 *   const { filters, patch } = useUrlFilters(codec); // filters: { q: string; from: string; ... }
 *
 * Declare the codec ONCE at module level (stable identity — see useUrlFilters).
 */
export function makeCodec<S extends ParamSpec>(spec: S): FilterCodec<CodecShape<S>> {
  const keys = Object.keys(spec) as Array<keyof S & string>;
  return {
    parse(sp) {
      const out = {} as CodecShape<S>;
      for (const key of keys) {
        out[key] = spec[key].parse(sp.get(key)) as CodecShape<S>[typeof key];
      }
      return out;
    },
    serialize(v) {
      const out: Record<string, string | null> = {};
      for (const key of keys) {
        out[key] = spec[key].serialize((v as Record<string, unknown>)[key]);
      }
      return out;
    },
  };
}
