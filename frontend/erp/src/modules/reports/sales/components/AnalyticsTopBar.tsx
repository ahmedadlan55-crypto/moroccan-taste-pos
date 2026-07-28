// Sales Analytics Hub — the shared filter top bar every hub page sits under.
//
// Controlled entirely by the URL codec (lib/filters.ts): `filters` is the
// parsed state, `patch`/`reset` mutate the URL. Active-filter chips derive
// from the codec's own serialize() (non-null ⇔ non-default) so the chip row
// can never drift from what the URL actually says.
import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Plus, Printer, RefreshCw, X } from "lucide-react";
import { Badge, Button, Dialog, DropdownMenu, IconButton, Input, SegmentedControl } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
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
// The accounting reports own the print contract (printReport + PrintArea +
// the .print-document rules in styles/index.css); the hub reuses it verbatim
// rather than growing a second, drifting copy.
import { printReport } from "@/modules/accounting/components";
import { useT } from "@/i18n";
import {
  analyticsFilterCodec,
  nonDefaultFilterKeys,
  type AnalyticsCompareMode,
  type AnalyticsFilters,
} from "../lib/filters";
import {
  createSavedView,
  fetchSavedViews,
  savedViewSearchString,
  useBrandOptions,
  useBranchOptions,
  useMenuItemOptions,
  type AnalyticsResult,
} from "../lib/api";
import { ExportMenu } from "./ExportMenu";

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

/* ── save-view control (wave 4) ─────────────────────────────────
 * Server-backed named URL states, one saved-views module per hub segment
 * (module = "analytics:<segment>", segment derived from the pathname because
 * the TopBar is rendered by the hub container, which owns no such prop).
 * Save captures the CURRENT url search string as { filters: "<qs>" }; picking
 * a view REPLACES the search with the stored one. A failed server save falls
 * back to localStorage (adlan.views.analytics:<segment>, the SavedViews shape)
 * so the capture is never lost offline. */

const LOCAL_VIEWS_PREFIX = "adlan.views.";

interface LocalSavedView {
  id: string;
  name: string;
  state: { filters?: unknown };
}

function readLocalViews(module: string): LocalSavedView[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${LOCAL_VIEWS_PREFIX}${module}`) ?? "[]");
    return Array.isArray(parsed) ? (parsed as LocalSavedView[]) : [];
  } catch {
    return [];
  }
}

function writeLocalView(module: string, name: string, search: string): void {
  try {
    const key = `${LOCAL_VIEWS_PREFIX}${module}`;
    const list = readLocalViews(module).filter((v) => v?.name !== name);
    list.push({ id: `${Date.now()}`, name, state: { filters: search } });
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* best-effort offline fallback */
  }
}

function SaveViewControl() {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const segment = location.pathname.split("/").filter(Boolean).pop() ?? "";
  const module = `analytics:${segment}`;
  const search = location.search.replace(/^\?/, "");

  const views = useQuery({
    queryKey: ["analytics", "saved-views", module],
    queryFn: ({ signal }) => fetchSavedViews(module, signal),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const applySearch = (qs: string | null) => {
    if (qs == null) return;
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
  };

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setSaving(true);
    try {
      await createSavedView({ module, name: trimmed, filtersJson: { filters: search } });
      await queryClient.invalidateQueries({ queryKey: ["analytics", "saved-views", module] });
    } catch {
      // Server unreachable / endpoint down → keep the capture on this device.
      writeLocalView(module, trimmed, search);
    } finally {
      setSaving(false);
      setDialogOpen(false);
    }
  };

  const serverViews = views.data ?? [];
  const localViews = typeof window === "undefined" ? [] : readLocalViews(module);
  const serverNames = new Set(serverViews.map((v) => v.name));
  const items = [
    ...serverViews.map((v) => ({
      key: `sv-${v.id}`,
      label: v.name,
      icon: <Check className="h-4 w-4" />,
      onSelect: () => applySearch(savedViewSearchString(v)),
    })),
    ...localViews
      .filter((v) => !serverNames.has(v.name))
      .map((v) => ({
        key: `lv-${v.id}`,
        label: v.name,
        icon: <Check className="h-4 w-4" />,
        onSelect: () => applySearch(savedViewSearchString({ filtersJson: v.state?.filters })),
      })),
    {
      key: "__save__",
      label: t("salesReports.saved.savePrompt"),
      icon: <Plus className="h-4 w-4" />,
      onSelect: () => {
        setName("");
        setDialogOpen(true);
      },
    },
  ];

  return (
    <>
      <DropdownMenu
        aria-label={t("salesReports.topbar.saveView")}
        trigger={
          <span className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
            <Bookmark className="h-4 w-4" /> {t("salesReports.topbar.saveView")}
          </span>
        }
        items={items}
      />
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t("salesReports.saved.savePrompt")}
        size="sm"
        presentation="compact"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button disabled={name.trim().length === 0} loading={saving} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("salesReports.saved.saveName")}</span>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
      </Dialog>
    </>
  );
}

export function AnalyticsTopBar({ filters, patch, reset, meta, onRefresh, pageActions }: AnalyticsTopBarProps) {
  const t = useT();
  const location = useLocation();
  const defaults = analyticsFilterCodec.defaults;
  const brands = useBrandOptions();
  const branches = useBranchOptions();
  const menuItems = useMenuItemOptions();
  // Segment = the last pathname piece (the hub owns /reports/sales/<segment>).
  const segment = location.pathname.split("/").filter(Boolean).pop() ?? "";
  const canExport = useCan("analytics.export");

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
  const multiChip = (
    key: "brandId" | "branchId" | "channel" | "orderType" | "paymentMethod" | "menuItemId" | "categoryId" | "cashierId",
    labelKey: string,
  ) => {
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
  // Wave-4 drill params — chips keep the URL and the chip row in lock-step.
  multiChip("paymentMethod", "salesReports.dims.payment_method");
  multiChip("menuItemId", "salesReports.dims.menu_item");
  multiChip("categoryId", "salesReports.dims.category");
  multiChip("cashierId", "salesReports.dims.cashier");
  if (activeKeys.has("hour")) {
    chips.push({
      id: "hour",
      label: `${t("salesReports.dims.hour")}: ${filters.hour}`,
      onRemove: () => patch({ hour: "" }),
    });
  }
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
          // The owner's question is "how did THIS item sell in THAT branch" —
          // menuItemId has always been a first-class URL filter, but until now
          // the only way to set it was drilling into a row.
          t("salesReports.dims.menu_item"),
          <MultiSelectCombobox
            options={toOptions(menuItems.data)}
            values={filters.menuItemId}
            onChange={(values) => patch({ menuItemId: values })}
            ariaLabel={t("salesReports.dims.menu_item")}
            labels={{ placeholder: t("salesReports.topbar.allItems") }}
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
            // data-freshness-watermark: the visual-baseline masks target this
            // attribute — a SERVER timestamp can never be pixel-stable, so the
            // baselines blank it instead of photographing it.
            <span data-freshness-watermark className="text-xs font-bold text-slate-400">
              {t("salesReports.topbar.refreshedAt", { time: formatDateTime(watermark) })}
            </span>
          )}
          {onRefresh && (
            <IconButton size="sm" aria-label={t("salesReports.topbar.refresh")} onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
            </IconButton>
          )}
          <SaveViewControl />
          {/* Print is NOT export-gated: it puts the report the user is already
              reading on paper. The hub wraps the routed page in PrintArea, and
              this bar is .no-print, so the printout is the report alone. */}
          <IconButton size="sm" aria-label={t("salesReports.topbar.print")} onClick={printReport}>
            <Printer className="h-4 w-4" />
          </IconButton>
          {canExport && <ExportMenu segment={segment} filters={filters} />}
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
