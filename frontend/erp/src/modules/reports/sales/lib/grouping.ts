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
  // A dimension the contract exposes that NOTHING projects must read as "no
  // data source", never as "your metrics are wrong" — the second sends the
  // reader changing metrics forever. `discount_reason` used to be the example;
  // it is projector-backed now (analytics_order_facts.discount_reason), so this
  // branch is currently defensive, and stays because the contract may reserve
  // an id again before its projector lands.
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
 * Which metrics have their POPULATION contaminated by a void metric in the
 * same request?
 *
 * The planner drops the void exclusion for an ENTIRE fact statement as soon as
 * one of its metrics tests `status = 'voided'` (planner.js:356, and the
 * `liftsVoidExclusion` flag the server projects). So `voids_value` beside
 * `orders` makes the order count start including voided orders, and
 * `avg_ticket` — a line-fact numerator over that order-fact denominator —
 * becomes void-excluded ÷ void-included. Two populations in one number, and
 * nothing on screen says so.
 *
 * The Executive statement avoids this by hand, with its metric groups pinned
 * by voidPopulation.test.ts. The Explorer cannot: the user picks any twelve
 * metrics they like. So the same rule is enforced in the picker.
 *
 * Returns metric id → the void metric ids that contaminate it.
 */
export function voidPopulationConflicts(
  registry: AnalyticsRegistry | undefined,
  metricIds: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!hasFactGraph(registry)) return out;
  const lifters = metricIds.filter((id) => registry?.metrics?.find((m) => m.id === id)?.liftsVoidExclusion);
  if (!lifters.length) return out;
  for (const id of metricIds) {
    if (lifters.includes(id)) continue;
    const mine = new Set(metricFacts(registry, id));
    // Contaminated iff it SHARES a fact statement with a lifter — a line-fact
    // metric is untouched by an order-fact void metric.
    const by = lifters.filter((v) => metricFacts(registry, v).some((f) => mine.has(f)));
    if (by.length) out[id] = by;
  }
  return out;
}

/** True when adding `candidate` to `metricIds` would contaminate a population. */
export function wouldContaminate(
  registry: AnalyticsRegistry | undefined,
  metricIds: string[],
  candidate: string,
): string[] {
  if (metricIds.includes(candidate)) return [];
  const after = voidPopulationConflicts(registry, [...metricIds, candidate]);
  const before = voidPopulationConflicts(registry, metricIds);
  const newlyBroken = Object.keys(after).filter((k) => !before[k]);
  // Either the candidate is the lifter that breaks others, or the candidate is
  // itself broken by a lifter already selected.
  if (after[candidate] && !before[candidate]) return after[candidate];
  return newlyBroken.length ? [candidate] : [];
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
