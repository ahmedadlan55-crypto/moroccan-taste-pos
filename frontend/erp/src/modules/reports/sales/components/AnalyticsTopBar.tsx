// Sales Analytics Hub — the shared filter top bar every hub page sits under.
//
// Controlled entirely by the URL codec (lib/filters.ts): `filters` is the
// parsed state, `patch`/`reset` mutate the URL. Active-filter chips derive
// from the codec's own serialize() (non-null ⇔ non-default) so the chip row
// can never drift from what the URL actually says.
import type { ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";
import { Badge, IconButton, SegmentedControl } from "@/shared/ui";
import {
  ComparePicker,
  DateRangePicker,
  DATE_RANGE_PRESETS,
  COMPARE_MODES,
  type CompareMode,
  type DateRangePreset,
} from "@/shared/ui/date-range-picker";
import { MultiSelectCombobox, type MultiSelectOption } from "@/shared/ui/multi-select-combobox";
import { formatDate, formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  analyticsFilterCodec,
  nonDefaultFilterKeys,
  type AnalyticsCompareMode,
  type AnalyticsFilters,
} from "../lib/filters";
import { useBrandOptions, useBranchOptions, type AnalyticsResult } from "../lib/api";

/** Static channel codes this wave (server-backed options arrive with explorer). */
export const CHANNEL_CODES = ["pos", "online", "aggregator", "call_center"] as const;
/** Static order-type codes this wave. */
export const ORDER_TYPE_CODES = ["dine_in", "takeaway", "delivery", "pickup"] as const;

export interface AnalyticsTopBarProps {
  filters: AnalyticsFilters;
  patch: (partial: Partial<AnalyticsFilters>) => void;
  reset: () => void;
  /** The active query's meta (freshness / late count) when a page has data. */
  meta?: AnalyticsResult["meta"];
  /** Refetch handler for the refresh icon (hidden when absent). */
  onRefresh?: () => void;
  /** Page-owned actions (save view / export …) rendered at the end. */
  pageActions?: ReactNode;
}

/** One removable active-filter chip. */
function FilterChip({ label, onRemove, removeLabel }: { label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 py-0.5 ps-2.5 pe-1 text-[11px] font-extrabold leading-none text-teal-700">
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="grid h-5 w-5 place-items-center rounded-full text-teal-600 transition hover:bg-teal-100 hover:text-rose-600"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function toOptions(rows: Array<{ id: string; name: string }> | undefined): MultiSelectOption[] {
  return (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
}

export function AnalyticsTopBar({ filters, patch, reset, meta, onRefresh, pageActions }: AnalyticsTopBarProps) {
  const t = useT();
  const defaults = analyticsFilterCodec.defaults;
  const brands = useBrandOptions();
  const branches = useBranchOptions();

  const presetLabels = Object.fromEntries(
    DATE_RANGE_PRESETS.map((p) => [p, t(`salesReports.topbar.presets.${p}`)]),
  ) as Record<DateRangePreset, string>;
  const compareLabels = Object.fromEntries(
    COMPARE_MODES.map((m) => [m, t(`salesReports.topbar.compareModes.${m}`)]),
  ) as Record<CompareMode, string>;

  const channelOptions: MultiSelectOption[] = CHANNEL_CODES.map((c) => ({
    value: c,
    label: t(`salesReports.topbar.channels.${c}`),
  }));
  const orderTypeOptions: MultiSelectOption[] = ORDER_TYPE_CODES.map((o) => ({
    value: o,
    label: t(`salesReports.topbar.orderTypes.${o}`),
  }));

  // ── active-filter chips (codec-derived; period keys collapse into one) ──
  const activeKeys = new Set(nonDefaultFilterKeys(filters));
  const chips: Array<{ id: string; label: string; onRemove: () => void }> = [];
  if (activeKeys.has("from") || activeKeys.has("to") || activeKeys.has("preset")) {
    chips.push({
      id: "period",
      label: `${t("salesReports.topbar.period")}: ${formatDate(filters.from)} – ${formatDate(filters.to)}`,
      onRemove: () => patch({ from: defaults.from, to: defaults.to, preset: defaults.preset }),
    });
  }
  if (activeKeys.has("compare")) {
    chips.push({
      id: "compare",
      label: `${t("salesReports.topbar.compare")}: ${t(`salesReports.topbar.compareModes.${filters.compare}`)}`,
      onRemove: () => patch({ compare: defaults.compare }),
    });
  }
  const multiChip = (key: "brandId" | "branchId" | "channel" | "orderType", labelKey: string) => {
    if (!activeKeys.has(key)) return;
    chips.push({
      id: key,
      label: `${t(labelKey)}: ${formatNumber(filters[key].length)}`,
      onRemove: () => patch({ [key]: [] } as Partial<AnalyticsFilters>),
    });
  };
  multiChip("brandId", "salesReports.topbar.brand");
  multiChip("branchId", "salesReports.topbar.branch");
  multiChip("channel", "salesReports.topbar.channel");
  multiChip("orderType", "salesReports.topbar.orderType");
  if (activeKeys.has("businessDay")) {
    chips.push({
      id: "businessDay",
      label: t("salesReports.topbar.calendarDay"),
      onRemove: () => patch({ businessDay: defaults.businessDay }),
    });
  }
  if (activeKeys.has("taxIncl")) {
    chips.push({
      id: "taxIncl",
      label: t("salesReports.topbar.taxIncl"),
      onRemove: () => patch({ taxIncl: defaults.taxIncl }),
    });
  }

  const watermark = meta?.freshness?.watermark ?? null;
  const pendingDays = meta?.freshness?.pendingDays ?? 0;

  const field = (label: string, control: ReactNode) => (
    <div className="flex min-w-40 flex-col gap-1.5">
      <span className="text-xs font-extrabold text-slate-500">{label}</span>
      {control}
    </div>
  );

  return (
    <div className="no-print surface mb-4 space-y-3 p-4" data-testid="analytics-topbar">
      {/* row 1 — period + compare + scopes */}
      <div className="flex flex-wrap items-end gap-3">
        {field(
          t("salesReports.topbar.period"),
          <DateRangePicker
            value={{ from: filters.from, to: filters.to, preset: filters.preset }}
            onChange={(range) => patch({ from: range.from, to: range.to, preset: range.preset })}
            labels={{
              presets: presetLabels,
              from: t("salesReports.topbar.from"),
              to: t("salesReports.topbar.to"),
              presetAriaLabel: t("salesReports.topbar.period"),
            }}
          />,
        )}
        {field(
          t("salesReports.topbar.compare"),
          <ComparePicker
            value={filters.compare}
            onChange={(mode) => {
              // The URL contract carries none|prevPeriod|prevYear this wave; a
              // custom compare window ships with the builder wave.
              if (mode === "custom") return;
              patch({ compare: mode as AnalyticsCompareMode });
            }}
            labels={{
              modes: compareLabels,
              from: t("salesReports.topbar.from"),
              to: t("salesReports.topbar.to"),
              modeAriaLabel: t("salesReports.topbar.compare"),
            }}
          />,
        )}
        {field(
          t("salesReports.topbar.brand"),
          <MultiSelectCombobox
            options={toOptions(brands.data)}
            values={filters.brandId}
            onChange={(values) => patch({ brandId: values })}
            ariaLabel={t("salesReports.topbar.brand")}
            labels={{ placeholder: t("salesReports.topbar.allBrands") }}
          />,
        )}
        {field(
          t("salesReports.topbar.branch"),
          <MultiSelectCombobox
            options={toOptions(branches.data)}
            values={filters.branchId}
            onChange={(values) => patch({ branchId: values })}
            ariaLabel={t("salesReports.topbar.branch")}
            labels={{ placeholder: t("salesReports.topbar.allBranches") }}
          />,
        )}
        {field(
          t("salesReports.topbar.channel"),
          <MultiSelectCombobox
            options={channelOptions}
            values={filters.channel}
            onChange={(values) => patch({ channel: values })}
            searchable={false}
            ariaLabel={t("salesReports.topbar.channel")}
            labels={{ placeholder: t("salesReports.topbar.allChannels") }}
          />,
        )}
        {field(
          t("salesReports.topbar.orderType"),
          <MultiSelectCombobox
            options={orderTypeOptions}
            values={filters.orderType}
            onChange={(values) => patch({ orderType: values })}
            searchable={false}
            ariaLabel={t("salesReports.topbar.orderType")}
            labels={{ placeholder: t("salesReports.topbar.allOrderTypes") }}
          />,
        )}
      </div>

      {/* row 2 — basis toggles + freshness + page actions */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          size="sm"
          aria-label={t("salesReports.topbar.dateBasis")}
          value={filters.businessDay ? "business" : "calendar"}
          onChange={(v) => patch({ businessDay: v === "business" })}
          options={[
            { value: "business", label: t("salesReports.topbar.businessDay") },
            { value: "calendar", label: t("salesReports.topbar.calendarDay") },
          ]}
        />
        <SegmentedControl
          size="sm"
          aria-label={t("salesReports.topbar.taxBasis")}
          value={filters.taxIncl ? "incl" : "excl"}
          onChange={(v) => patch({ taxIncl: v === "incl" })}
          options={[
            { value: "excl", label: t("salesReports.topbar.taxExcl") },
            { value: "incl", label: t("salesReports.topbar.taxIncl") },
          ]}
        />

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {pendingDays > 0 && (
            <Badge tone="warning">{t("salesReports.topbar.lateTx", { count: pendingDays })}</Badge>
          )}
          {watermark && (
            <span className="text-xs font-bold text-slate-400">
              {t("salesReports.topbar.refreshedAt", { time: formatDateTime(watermark) })}
            </span>
          )}
          {onRefresh && (
            <IconButton size="sm" aria-label={t("salesReports.topbar.refresh")} onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
            </IconButton>
          )}
          {pageActions}
        </div>
      </div>

      {/* row 3 — active-filter chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="active-filter-chips">
          <span className="text-[11px] font-extrabold text-slate-400">
            {t("salesReports.topbar.activeFilters")}
          </span>
          {chips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.label}
              onRemove={chip.onRemove}
              removeLabel={t("salesReports.topbar.removeFilter", { name: chip.label })}
            />
          ))}
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-2 py-1 text-[11px] font-extrabold text-slate-500 transition hover:bg-slate-50 hover:text-rose-600"
          >
            {t("salesReports.topbar.clearAll")}
          </button>
        </div>
      )}
    </div>
  );
}
