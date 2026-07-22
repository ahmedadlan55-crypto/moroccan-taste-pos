// Status/action label helpers for procurement detail screens. Both resolve the
// bilingual label through the i18n `purchasing.*` namespace and fall back to the
// raw backend code when a code isn't mapped (matching the old `MAP[code] || code`
// behavior, and staying graceful pre-barrel-merge). Callers pass their `t` from
// useT() — these stay plain functions so they can be used in list cells, table
// text and StatusBadge children alike.
import type { TFunction } from "@/i18n";

export const st = (t: TFunction, s: string | null | undefined): string => {
  if (!s) return "—";
  const path = `purchasing.status.${s}`;
  const out = t(path);
  return out === path ? s : out;
};

export const act = (t: TFunction, a: string): string => {
  const path = `purchasing.action.${a}`;
  const out = t(path);
  return out === path ? a : out;
};
