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
  // ── drill params (wave 4) — pinned by page drills, empty = not filtered.
  //    Registry dimension per param: payment_method / hour / menu_item /
  //    category / cashier (lib/analytics/registry/dimensions.js).
  /** Payment-method codes (registry dim `payment_method`) — CSV param. */
  paymentMethod: string[];
  /** Single hour "0".."23" (registry dim `hour`) — '' = not filtered. */
  hour: string;
  /** Menu-item ids (registry dim `menu_item`) — CSV param. */
  menuItemId: string[];
  /** Category ids (registry dim `category`) — CSV param. */
  categoryId: string[];
  /** Cashier ids (registry dim `cashier`) — CSV param. */
  cashierId: string[];
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

/** Same shape dateParam validates against — the URL is the only source here. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const base = makeCodec({
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
    paymentMethod: csvParam(),
    hour: stringParam(""),
    menuItemId: csvParam(),
    categoryId: csvParam(),
    cashierId: csvParam(),
  });

  /*
   * A RANGE IS EITHER FULLY EXPLICIT OR FULLY DERIVED — NEVER HALF.
   *
   * `to` on a to-date preset equals today, which is the codec's default, and a
   * codec omits its default. So `?preset=mtd` shipped `from` frozen as a
   * literal and `to` absent. Reopened a week later, `to` came back from the NEW
   * default while `from` stayed put:
   *
   *     picked 2026-07-29:  ?from=2026-07-01&preset=mtd   → 07-01 … 07-29
   *     opened 2026-08-05:  same URL                       → 07-01 … 08-05
   *
   * A 36-day window straddling two months, still labelled "Month to date" —
   * neither the range its author saw nor a real month-to-date (08-01 … 08-05).
   * `?preset=today` reopened as an eight-day window labelled "Today". And the
   * basis-of-preparation block now prints that range as the report's
   * authoritative period, on paper.
   *
   * The half is the defect, so the rule is about halves, not about presets:
   *
   *   BOTH dates in the URL  → honour them verbatim. A closed period
   *     (lastMonth/lastQuarter/lastYear) and Custom always write both, so a
   *     shared "June close" stays June for whoever opens it, whenever.
   *   EITHER missing         → derive BOTH from the preset. A to-date link then
   *     reopens as what its label says — month-to-date in August is August —
   *     instead of a window that is neither.
   *
   * Deriving only the missing side is the one thing never done: that is exactly
   * the mixed window this fixes.
   */
  const codec: FilterCodec<AnalyticsFilters> = {
    parse(sp) {
      const out = base.parse(sp);
      if (out.preset === "custom") return out;
      const bothPinned = ISO_DATE.test(sp.get("from") || "") && ISO_DATE.test(sp.get("to") || "");
      if (bothPinned) return out;
      const r = computePresetRange(out.preset, today);
      return { ...out, from: r.from, to: r.to };
    },
    serialize: base.serialize,
  };

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

/**
 * The keys whose value differs between two filter objects, as a `patch()`
 * partial. This is what turns a DRAFT into a commit: the top bar edits a local
 * copy and, on «تطبيق», patches ONLY what the analyst actually changed.
 *
 * Patching the whole object instead would work — patch() merges — but it would
 * also rewrite keys the user never touched, which makes every URL diff and
 * every test assertion say "everything changed". Comparing here keeps the
 * commit honest and keeps `patch({ businessDay: false })` readable in a log.
 *
 * Arrays compare by ORDER as well as content, matching csvParam's own
 * `sameArray` — a reordered selection really is a different URL.
 */
export function filterDiff(
  committed: AnalyticsFilters,
  draft: AnalyticsFilters,
): Partial<AnalyticsFilters> {
  const out: Partial<AnalyticsFilters> = {};
  for (const key of Object.keys(draft) as Array<keyof AnalyticsFilters>) {
    const a = committed[key];
    const b = draft[key];
    const same =
      Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((v, i) => v === b[i])
        : a === b;
    if (!same) (out as Record<string, unknown>)[key] = b;
  }
  return out;
}

/** Stable identity of a filter STATE (used to diff draft vs committed). */
export function filterSignature(
  filters: AnalyticsFilters,
  codec: FilterCodec<AnalyticsFilters> = analyticsFilterCodec,
): string {
  const s = codec.serialize(filters);
  return Object.keys(s)
    .sort()
    .map((k) => `${k}=${s[k] ?? ""}`)
    .join("&");
}

// Page-local params: pages compose their OWN codec for extra keys (e.g. a
// drill dimension) with the same primitives — useUrlFilters only ever touches
// the keys a codec serializes, so the shared codec and a page codec coexist on
// one URL without stepping on each other (and ?doc-style foreign params survive
// both). Re-exported so pages import everything from one place.
export { makeCodec, boolParam, csvParam, dateParam, stringParam };
export type { FilterCodec, ParamCodec };
