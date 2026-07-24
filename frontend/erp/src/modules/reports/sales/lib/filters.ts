// Sales Analytics Hub — the ONE shared URL filter codec.
//
// Every hub page keys its state off this codec via useUrlFilters, so a URL is
// a complete, shareable description of what the user is looking at. The param
// NAMES from / to / brandId / branchId are the CANONICAL redirect contract
// (legacy report URLs redirect onto them) — never rename them.
//
// Defaults: preset "last30" with the CONCRETE computed dates (the URL codec
// always carries real dates when non-default, and parse() of an empty URL
// returns real dates too, so query bodies never see an empty range).
import {
  makeCodec,
  boolParam,
  csvParam,
  dateParam,
  stringParam,
  type FilterCodec,
  type ParamCodec,
} from "@/shared/hooks/useUrlFilters";
import {
  computePresetRange,
  DATE_RANGE_PRESETS,
  type DateRangePreset,
} from "@/shared/ui/date-range-picker";
import { todayISO } from "@/shared/lib";

/** Comparison modes the hub URL supports this wave (no custom window yet). */
export const ANALYTICS_COMPARE_MODES = ["none", "prevPeriod", "prevYear"] as const;
export type AnalyticsCompareMode = (typeof ANALYTICS_COMPARE_MODES)[number];

export interface AnalyticsFilters {
  /** ISO YYYY-MM-DD inclusive range — the canonical `from`/`to` params. */
  from: string;
  to: string;
  /** The preset that produced from/to ("custom" when hand-picked). */
  preset: DateRangePreset;
  compare: AnalyticsCompareMode;
  /** Multi-select scopes — canonical `brandId`/`branchId` CSV params. */
  brandId: string[];
  branchId: string[];
  channel: string[];
  orderType: string[];
  /** true → business-day basis (default); false → calendar day. */
  businessDay: boolean;
  /** true → tax-inclusive figures; false (default) → ex-VAT. */
  taxIncl: boolean;
}

/** A ParamCodec constrained to a closed union; anything else → the default. */
function enumParam<T extends string>(values: readonly T[], defaultValue: T): ParamCodec<T> {
  return {
    parse: (raw) => (raw != null && (values as readonly string[]).includes(raw) ? (raw as T) : defaultValue),
    serialize: (v) => (v === defaultValue ? null : v),
  };
}

export interface AnalyticsFilterDefaults {
  from: string;
  to: string;
  preset: DateRangePreset;
  compare: AnalyticsCompareMode;
  businessDay: boolean;
  taxIncl: boolean;
}

/** The concrete defaults for a given "today" (exported for tests + chips). */
export function computeAnalyticsDefaults(today: string = todayISO()): AnalyticsFilterDefaults {
  const { from, to } = computePresetRange("last30", today);
  return { from, to, preset: "last30", compare: "none", businessDay: true, taxIncl: false };
}

/**
 * Build the codec for a given "today" (tests pin a fixed date; the app uses the
 * module-level singleton below). Declared ONCE per lifetime — useUrlFilters
 * memoizes against the codec's identity.
 */
export function createAnalyticsFilterCodec(
  today: string = todayISO(),
): FilterCodec<AnalyticsFilters> & { defaults: AnalyticsFilterDefaults } {
  const d = computeAnalyticsDefaults(today);
  const codec = makeCodec({
    from: dateParam(d.from),
    to: dateParam(d.to),
    preset: enumParam<DateRangePreset>(DATE_RANGE_PRESETS, d.preset),
    compare: enumParam<AnalyticsCompareMode>(ANALYTICS_COMPARE_MODES, d.compare),
    brandId: csvParam(),
    branchId: csvParam(),
    channel: csvParam(),
    orderType: csvParam(),
    businessDay: boolParam(d.businessDay),
    taxIncl: boolParam(d.taxIncl),
  });
  return { ...codec, defaults: d };
}

/** The app-wide codec instance (stable identity — safe for useUrlFilters). */
export const analyticsFilterCodec = createAnalyticsFilterCodec();

/**
 * The codec-owned keys whose CURRENT value differs from the default — i.e. the
 * active-filter chips. Derived from serialize(): a key serializes to null iff
 * it holds its default, so no second source of truth exists.
 */
export function nonDefaultFilterKeys(
  filters: AnalyticsFilters,
  codec: FilterCodec<AnalyticsFilters> = analyticsFilterCodec,
): Array<keyof AnalyticsFilters> {
  const serialized = codec.serialize(filters);
  return (Object.keys(serialized) as Array<keyof AnalyticsFilters>).filter(
    (k) => serialized[k as string] != null,
  );
}

// Page-local params: pages compose their OWN codec for extra keys (e.g. a
// drill dimension) with the same primitives — useUrlFilters only ever touches
// the keys a codec serializes, so the shared codec and a page codec coexist on
// one URL without stepping on each other (and ?doc-style foreign params survive
// both). Re-exported so pages import everything from one place.
export { makeCodec, boolParam, csvParam, dateParam, stringParam };
export type { FilterCodec, ParamCodec };
