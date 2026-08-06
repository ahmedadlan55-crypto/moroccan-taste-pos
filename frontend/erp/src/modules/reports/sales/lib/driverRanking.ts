/**
 * One comparable sales driver as returned by the analytics result adapter.
 *
 * `current === 0` is a measured value and therefore remains active. `null`
 * means the value was not measured/masked and must never be ranked as zero.
 * A comparison can legitimately have `previous === 0` and `deltaPct === null`:
 * the absolute movement is still real even though growth from zero is
 * undefined.
 */
export interface DriverRow {
  key: string;
  label: string;
  current: number | null;
  previous: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
}

export interface DriverRanking {
  /** Highest measured current-period value. */
  topContributor: DriverRow | null;
  /** Largest positive absolute movement against the comparison period. */
  strongestGain: DriverRow | null;
  /** Most-negative absolute movement against the comparison period. */
  biggestDecline: DriverRow | null;
  /** True means the source query hit its row cap, so the ranking is scoped. */
  scopeLimited: boolean;
}

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Stable tie-break independent of response order. Analytics paging/caching may
 * return equal-valued rows in a different order, so the business cards must not
 * jump between equally-ranked drivers after a refresh.
 */
function tieBreak(a: DriverRow, b: DriverRow): number {
  const byKey = a.key.localeCompare(b.key, "en");
  return byKey !== 0 ? byKey : a.label.localeCompare(b.label, "en");
}

function firstBy(
  rows: readonly DriverRow[],
  eligible: (row: DriverRow) => boolean,
  compare: (a: DriverRow, b: DriverRow) => number,
): DriverRow | null {
  const ranked = rows.filter(eligible).slice().sort((a, b) => compare(a, b) || tieBreak(a, b));
  return ranked[0] ?? null;
}

/**
 * Rank the three decision cards among rows active in the current period.
 *
 * Rules:
 * - a finite current value (including zero or a negative value) is active;
 * - movers additionally require a finite previous value and absolute delta;
 * - gains are strictly positive, declines strictly negative, and an unchanged
 *   row belongs to neither;
 * - ranking uses absolute movement, never percentage movement, so a tiny base
 *   cannot outrank a materially larger riyal change;
 * - equal values resolve by stable key then label, never input order.
 */
export function rankDrivers(
  rows: readonly DriverRow[],
  rowCountCapped = false,
): DriverRanking {
  const active = (row: DriverRow) => finite(row.current);
  const comparable = (row: DriverRow) =>
    active(row) && finite(row.previous) && finite(row.deltaAbs);

  return {
    topContributor: firstBy(
      rows,
      active,
      (a, b) => (b.current as number) - (a.current as number),
    ),
    strongestGain: firstBy(
      rows,
      (row) => comparable(row) && (row.deltaAbs as number) > 0,
      (a, b) => (b.deltaAbs as number) - (a.deltaAbs as number),
    ),
    biggestDecline: firstBy(
      rows,
      (row) => comparable(row) && (row.deltaAbs as number) < 0,
      (a, b) => (a.deltaAbs as number) - (b.deltaAbs as number),
    ),
    scopeLimited: rowCountCapped === true,
  };
}
