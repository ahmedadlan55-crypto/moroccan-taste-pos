// Sales Analytics Hub — the Group By control.
//
// Up to MAX_GROUP_DIMS grouping levels, chosen from EVERY groupable dimension
// the caller may see (41, where the Explorer previously offered a curated 8).
//
// THREE THINGS THIS CONTROL REFUSES TO DO
//
//  1. Offer a pair the server will reject. The planner 422s the WHOLE request
//     — every metric, not just the offending one — when a grouped dimension is
//     unavailable on any requested metric's fact. So illegal options are
//     disabled here, and each one SAYS which metric blocks it. A greyed row
//     with no reason is indistinguishable from missing data.
//
//  2. Offer the same dimension twice. Grouping by branch inside branch is
//     legal SQL and a wasted level, so a dimension chosen in one slot leaves
//     the other slots.
//
//  3. Hide the levels behind "advanced". Grouping is the primary question an
//     owner asks of a sales report — by branch? by day? by cashier? — so the
//     levels sit on the surface, in reading order, each labelled by its depth.
//
// Options are sorted by KIND (time → scope → attribute → employee) and carry
// the kind as a sublabel, because a flat alphabetical list of 41 ids is a wall.
// A disabled option's sublabel is replaced by the reason it is disabled: the
// slot where the user needs the explanation is the slot they just tried.
import { useMemo } from "react";
import { Layers, X } from "lucide-react";
import { Combobox, IconButton, type ComboboxOption } from "@/shared/ui";
import { useT, type TFunction } from "@/i18n";
import { dimensionAvailability, groupableDimensions, type DimensionKind } from "../lib/grouping";
import type { AnalyticsRegistry } from "../lib/api";

/** The planner's own ceiling — lib/analytics/planner.js:56 MAX_DIMENSIONS. */
export const MAX_GROUP_DIMS = 3;

/** Display order for the kind groups; anything unlisted sorts last. */
const KIND_ORDER: DimensionKind[] = ["time", "scope", "attribute", "employee", "derived-js", "constant"];

/** meal_period is kind 'derived-js' in the registry but reads as a time bucket. */
function kindLabel(t: TFunction, kind: DimensionKind): string {
  const key = kind === "derived-js" ? "time" : kind;
  return t(`salesReports.groupBy.kinds.${key}`);
}

export interface GroupByControlProps {
  registry: AnalyticsRegistry | undefined;
  /** Chosen dimension ids, outermost first. Length 0..MAX_GROUP_DIMS. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Metrics the report will request — drives which dimensions are legal. */
  metricIds: string[];
  className?: string;
}

export function GroupByControl({ registry, value, onChange, metricIds, className }: GroupByControlProps) {
  const t = useT();

  const dims = useMemo(() => groupableDimensions(registry), [registry]);

  /** One option list per slot: same dimensions, different exclusions. */
  const optionsForSlot = useMemo(() => {
    const sorted = [...dims].sort((a, b) => {
      const ka = KIND_ORDER.indexOf(a.kind);
      const kb = KIND_ORDER.indexOf(b.kind);
      if (ka !== kb) return (ka === -1 ? 99 : ka) - (kb === -1 ? 99 : kb);
      return t(`salesReports.dims.${a.id}`).localeCompare(t(`salesReports.dims.${b.id}`));
    });
    return (slot: number): ComboboxOption<string>[] =>
      sorted.map((d) => {
        const takenElsewhere = value.some((v, i) => v === d.id && i !== slot);
        const blocked = dimensionAvailability(registry, metricIds, d.id);
        let sublabel = kindLabel(t, d.kind);
        if (blocked?.reason === "no-fact") {
          sublabel = t("salesReports.groupBy.noSource");
        } else if (blocked?.reason === "metric-conflict") {
          sublabel = `${t("salesReports.groupBy.blockedBy")} ${blocked.blockedBy
            .map((m) => t(`salesReports.metrics.${m}`))
            .join("، ")}`;
        } else if (takenElsewhere) {
          sublabel = t("salesReports.groupBy.alreadyUsed");
        }
        return { value: d.id, label: t(`salesReports.dims.${d.id}`), sublabel, disabled: !!blocked || takenElsewhere };
      });
  }, [dims, registry, metricIds, value, t]);

  /**
   * Slots rendered = every chosen level, plus ONE empty slot to add the next.
   * Never more than the planner accepts.
   */
  const slotCount = Math.min(value.length + 1, MAX_GROUP_DIMS);

  const setSlot = (slot: number, next: string | null) => {
    const out = [...value];
    if (next == null) {
      // Removing a level collapses the ones after it — a grouping with a hole
      // in the middle is not a thing the planner (or a reader) can express.
      out.splice(slot, 1);
    } else {
      out[slot] = next;
    }
    onChange(out.filter(Boolean).slice(0, MAX_GROUP_DIMS));
  };

  return (
    <div className={className} data-testid="group-by-control">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Layers className="h-4 w-4 text-teal-700" aria-hidden="true" />
        <span className="text-xs font-extrabold text-slate-500">{t("salesReports.groupBy.label")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: slotCount }, (_, slot) => {
          const current = value[slot] ?? null;
          return (
            <div key={slot} className="flex items-center gap-1" data-testid={`group-by-slot-${slot}`}>
              <div className="min-w-44">
                <Combobox<string>
                  options={optionsForSlot(slot)}
                  value={current}
                  onChange={(v) => setSlot(slot, v)}
                  placeholder={
                    slot === 0 ? t("salesReports.groupBy.pickFirst") : t("salesReports.groupBy.pickNext")
                  }
                  emptyText={t("salesReports.states.empty")}
                  aria-label={`${t("salesReports.groupBy.label")} ${slot + 1}`}
                />
              </div>
              {current && (
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={`${t("common.clear")} — ${t(`salesReports.dims.${current}`)}`}
                  onClick={() => setSlot(slot, null)}
                  data-testid={`group-by-clear-${slot}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
