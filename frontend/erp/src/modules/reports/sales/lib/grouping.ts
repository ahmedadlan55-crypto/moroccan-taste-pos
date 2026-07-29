// Sales Analytics Hub — Group By legality, computed on the client.
//
// THE PROBLEM THIS SOLVES
//   The planner partitions the requested metrics by FACT, then builds one SQL
//   statement per fact. If any fact cannot express a grouped dimension it
//   raises ANALYTICS_UNSUPPORTED_COMBINATION and the ENTIRE request 422s —
//   every metric, not just the offending one. So asking for eight metrics
//   grouped by `payment_method` fails outright the moment one of the eight
//   lives on the line fact, and the screen shows a red error that names a
//   dimension and a fact id, neither of which is a word the user chose.
//
//   With a curated eight dimensions that was rare. Opening Group By to all 41
//   makes it the DEFAULT experience unless the illegal pairs are disabled
//   before submit. Hence this module.
//
// THE RULE (identical to lib/analytics/registry/grouping.js on the server)
//   A metric can be grouped by a dimension when EVERY fact the metric needs
//   can express that dimension. An additive metric needs one fact; a derived
//   metric needs the facts of all its additive inputs, because the planner
//   computes every input.
//
// WHY IT IS SAFE TO DUPLICATE THE RULE HERE
//   Because the data is not duplicated — only the comparison is. Both fact
//   lists arrive from /api/analytics/metadata, projected by the server module
//   above, and tests/analyticsGrouping.test.js proves that module agrees with
//   the real planner on all 2009 metric × dimension pairs. What is written
//   twice is one `every(...)`, in two languages.
//
// DEGRADED MODE
//   An older server does not send `facts` (metrics carried a single `fact`,
//   null for derived; dimensions carried the raw `facts` map, empty for
//   meal_period). Predicting from that data would grey out legal groupings, so
//   when `facts` is missing the model reports EVERYTHING legal and lets the
//   server be the judge: a 422 the user can read beats a control that lies.
import type { AnalyticsRegistry } from "./api";

export type DimensionKind = "time" | "scope" | "attribute" | "employee" | "derived-js" | "constant";

export interface GroupableDimension {
  id: string;
  kind: DimensionKind;
  /** Fact ids this dimension can be expressed on (empty ⇒ nothing can group by it). */
  facts: string[];
}

/** Why an option is unavailable — never rendered as a bare "disabled". */
export interface Unavailable {
  reason: "no-fact" | "metric-conflict";
  /** For "metric-conflict": the metric ids that block this dimension. */
  blockedBy: string[];
}

/** True when the server told us which facts things live on. */
export function hasFactGraph(registry: AnalyticsRegistry | undefined): boolean {
  const m = registry?.metrics?.[0];
  const d = registry?.dimensions?.[0];
  return Array.isArray(m?.facts) && Array.isArray(d?.facts);
}

function metricFacts(registry: AnalyticsRegistry | undefined, id: string): string[] {
  const m = registry?.metrics?.find((x) => x.id === id);
  if (m?.facts?.length) return m.facts;
  // Older payload: additive metrics still carry a single `fact`; derived ones
  // carry null and are treated as unconstrained (see DEGRADED MODE above).
  return m?.fact ? [m.fact] : [];
}

function dimensionFacts(registry: AnalyticsRegistry | undefined, id: string): string[] {
  return registry?.dimensions?.find((x) => x.id === id)?.facts ?? [];
}

/** Every groupable dimension the caller is allowed to see, registry order. */
export function groupableDimensions(registry: AnalyticsRegistry | undefined): GroupableDimension[] {
  return (registry?.dimensions ?? [])
    .filter((d) => d.groupable)
    .map((d) => ({ id: d.id, kind: (d.kind ?? "attribute") as DimensionKind, facts: d.facts ?? [] }));
}

/**
 * Can these metrics be grouped by this dimension? Returns null when legal, or
 * the specific obstruction when not.
 */
export function dimensionAvailability(
  registry: AnalyticsRegistry | undefined,
  metricIds: string[],
  dimId: string,
): Unavailable | null {
  if (!hasFactGraph(registry)) return null;
  const have = new Set(dimensionFacts(registry, dimId));
  // `discount_reason` is groupable in the contract and backed by no projector.
  // It must read as "no data source", never as "your metrics are wrong".
  if (have.size === 0) return { reason: "no-fact", blockedBy: [] };
  const blockedBy = metricIds.filter((id) => {
    const need = metricFacts(registry, id);
    return need.length > 0 && !need.every((f) => have.has(f));
  });
  return blockedBy.length ? { reason: "metric-conflict", blockedBy } : null;
}

/**
 * The mirror question, for the metric picker: which of these metrics cannot be
 * grouped by the dimensions currently chosen? Returns metric id → blocking
 * dimension ids.
 */
export function metricConflicts(
  registry: AnalyticsRegistry | undefined,
  metricIds: string[],
  dimIds: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!hasFactGraph(registry)) return out;
  for (const metricId of metricIds) {
    const need = metricFacts(registry, metricId);
    if (!need.length) continue;
    const bad = dimIds.filter((dimId) => {
      const have = new Set(dimensionFacts(registry, dimId));
      return have.size > 0 && !need.every((f) => have.has(f));
    });
    if (bad.length) out[metricId] = bad;
  }
  return out;
}

/**
 * Drop dimensions the current metrics cannot support. Used when a URL arrives
 * carrying a grouping saved against a different metric set — a saved view, a
 * shared link, or the Back button — so the page renders SOMETHING instead of
 * a red 422, and says what it dropped.
 */
export function reconcile(
  registry: AnalyticsRegistry | undefined,
  metricIds: string[],
  dimIds: string[],
): { dimensions: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of dimIds) {
    if (dimensionAvailability(registry, metricIds, id)) dropped.push(id);
    else kept.push(id);
  }
  return { dimensions: kept, dropped };
}
