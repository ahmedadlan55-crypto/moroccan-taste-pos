// Sales Analytics Hub — the shared filter top bar every hub page sits under.
//
// TWO CONTRACTS THIS FILE OWNS
//
// 1. DRAFT → COMMIT. `filters` is the COMMITTED state (parsed from the URL);
//    every control here edits a local DRAFT and nothing reaches the URL until
//    «تطبيق». Before, each edit patched the URL immediately, so the previous
//    period's numbers sat under the NEW period's heading for the length of the
//    refetch — a silently wrong number, not a cosmetic lag. The hub marks the
//    results region aria-busy for the window where the label leads the data;
//    here the job is to make that window start only when the analyst says so.
//
// 2. A COMPACT PRIMARY BAR. Period, branch, compare, Apply and a "more
//    filters" toggle are always visible; brand / item / channel / order type /
//    date basis / tax basis live in an INLINE expandable area (never a side
//    panel — shared/ui/drawer.tsx is a retired shim). The bar used to render
//    all eleven controls plus the page's own settings as one 1463px column,
//    which put the first KPI below the fold.
//
// Active-filter chips still derive from the codec's own serialize() (non-null
// ⇔ non-default) against the COMMITTED filters, so the chip row always
// describes what you are LOOKING AT, never what you are about to ask for.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bookmark,
  Check,
  ChevronDown,
  Plus,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge, Button, Dialog, DropdownMenu, Input, SegmentedControl } from "@/shared/ui";
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
import { cn } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  analyticsFilterCodec,
  filterDiff,
  filterSignature,
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
import { ItemPicker } from "./ItemPicker";
import { useChannels } from "@/modules/sales/channels/api";

/** RETIRED. These four codes never existed in `sales_channels` — see the
 *  channelOptions comment below. Kept only so an old saved view that stored one
 *  can still be recognised and cleared rather than silently returning zero. */
export const RETIRED_CHANNEL_CODES = ["pos", "online", "aggregator", "call_center"] as const;
/** Static order-type codes this wave. */
export const ORDER_TYPE_CODES = ["dine_in", "takeaway", "delivery"] as const;

/** aria-controls target of the "more filters" toggle (one bar per screen). */
const MORE_FILTERS_ID = "analytics-more-filters";

export interface AnalyticsTopBarProps {
  /** Stable report id used by the export registry (never the centre pathname). */
  reportId?: string;
  filters: AnalyticsFilters;
  patch: (partial: Partial<AnalyticsFilters>) => void;
  reset: () => void;
  /**
   * The filter keys the ACTIVE REPORT can honour (lib/reportRegistry
   * reportFilterKeys). A control outside this set is not rendered at all: the
   * planner 422s a filter dimension the report's facts cannot express, and a
   * control that can only break the screen — or worse, scope half of it — is
   * not a control.
   *
   * UNDEFINED means "no report context" (a standalone render, a test, a future
   * embed) and shows everything, which is the behaviour this bar has always
   * had. The hub always passes it.
   */
  filterKeys?: readonly string[];
  /** Comparison window (registry `compare`). */
  showCompare?: boolean;
  /** Business-day vs calendar-day toggle (registry dateBases). */
  showDateBasis?: boolean;
  /** Ex-VAT vs incl-VAT toggle (registry taxModes — a client-side metric swap). */
  showTaxBasis?: boolean;
  /** The active query's meta (freshness / late count) when a page has data. */
  meta?: AnalyticsResult["meta"];
  /**
   * Whether this report can export the CURRENT scope without silently dropping
   * a filter. The hub derives this from the report registry; standalone uses
   * keep the historical default.
   */
  showExport?: boolean;
  /** Prevents a print snapshot while the visible figures still belong to the
   *  previous committed filter set. */
  printDisabled?: boolean;
  /** Refetch handler for the refresh icon (hidden when absent). */
  onRefresh?: () => void;
  /** Page-owned actions (save view / export …) rendered at the end. */
  pageActions?: ReactNode;
  /**
   * A report's OWN settings, for callers that render this bar outside the hub.
   * The hub itself no longer passes them: a report's configuration is not a
   * filter, and Builder's config alone is taller than a viewport — it goes in
   * the rail BESIDE the report (see SalesAnalyticsHub), which is what keeps
   * this card at one screen-row of chrome.
   */
  children?: ReactNode;
}

/** One removable active-filter chip. */
function FilterChip({ label, onRemove, removeLabel }: { label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="inline-flex min-h-11 items-center gap-1 rounded-full border border-teal-200 bg-teal-50 ps-3 pe-0.5 text-[11px] font-extrabold leading-none text-teal-700">
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="grid h-11 w-11 place-items-center rounded-full text-teal-600 transition hover:bg-teal-100 hover:text-rose-600"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function toOptions(rows: Array<{ id: string; name: string }> | undefined): MultiSelectOption[] {
  return (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
}

/**
 * A FAILED LOOKUP IS NOT AN EMPTY DOMAIN.
 *
 * Every option picker here used to read `query.data ?? []`, so a 500 on
 * /erp/branches-full rendered a picker that said "no options" — indistinguish-
 * able from a company that genuinely has one branch, and it invites the analyst
 * to conclude the scope is empty rather than that the screen is broken. The
 * picker is replaced by this, which says what failed and offers the retry.
 *
 * Sized to the same 44px as the field it stands in, so the bar does not jump
 * when a lookup fails, and the retry stays a real touch target.
 */
function LookupError({
  name,
  onRetry,
  scope,
}: {
  name: string;
  onRetry: () => void;
  /** Which picker failed — for tests and for automation, never for the user. */
  scope: string;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      data-testid="lookup-error"
      data-lookup-error={scope}
      className="flex min-h-11 items-center justify-between gap-1 rounded-xl border border-rose-200 bg-rose-50 ps-2.5 pe-1"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-extrabold text-rose-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("salesReports.topbar.lookupFailed", { name })}</span>
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 shrink-0 rounded-lg px-2 text-[11px] font-extrabold text-rose-700 underline transition hover:bg-rose-100"
      >
        {t("salesReports.topbar.lookupRetry")}
      </button>
    </div>
  );
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
          // min-h-11, not min-h-9: this is a real touch target, and it also
          // pins the action bar to the same 44px as the control row below it.
          <span className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {/* This is a primary report action, so its name stays visible on a
                phone. Icon-only action rows save a few pixels at the cost of
                making every unfamiliar control a guessing exercise. */}
            <Bookmark className="h-4 w-4" />
            <span>{t("salesReports.topbar.saveView")}</span>
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

export function AnalyticsTopBar({
  reportId,
  filters,
  patch,
  reset,
  meta,
  onRefresh,
  pageActions,
  children,
  filterKeys,
  showCompare = true,
  showDateBasis = true,
  showTaxBasis = true,
  showExport = true,
  printDisabled = false,
}: AnalyticsTopBarProps) {
  const t = useT();
  const location = useLocation();
  /** `undefined` filterKeys = no report context → every control, as before. */
  const shows = (key: string) => !filterKeys || filterKeys.includes(key);
  const defaults = analyticsFilterCodec.defaults;
  // The expensive scope domains are filter editors, not page prerequisites.
  // Keep them asleep until their editor opens (or a committed deep-link needs
  // names for its active values). The branch picker is primary and remains
  // eager only on reports that can actually honour a branch filter.
  const [showMore, setShowMore] = useState(false);
  const brands = useBrandOptions(
    shows("brandId") && (showMore || filters.brandId.length > 0),
  );
  const branches = useBranchOptions(shows("branchId"));
  const menuItems = useMenuItemOptions(
    shows("menuItemId") && (showMore || filters.menuItemId.length > 0),
  );
  // A hub route names a CENTRE (operations/payments/items), while exports are
  // keyed by the active REPORT (orders/taxes/profitability). Standalone uses
  // retain the historical pathname fallback; the hub always passes reportId.
  const segment = reportId ?? location.pathname.split("/").filter(Boolean).pop() ?? "";
  const canExport = useCan("analytics.export");

  const presetLabels = Object.fromEntries(
    DATE_RANGE_PRESETS.map((p) => [p, t(`salesReports.topbar.presets.${p}`)]),
  ) as Record<DateRangePreset, string>;
  const compareLabels = Object.fromEntries(
    COMPARE_MODES.map((m) => [m, t(`salesReports.topbar.compareModes.${m}`)]),
  ) as Record<CompareMode, string>;

  // REAL CHANNELS, KEYED BY THE COLUMN THE ENGINE FILTERS ON.
  //
  // This used to map a hardcoded CHANNEL_CODES list — "pos" / "online" /
  // "aggregator" / "call_center" — while the dimension filters on
  // `f.channel_id` (lib/analytics/registry/dimensions.js:151), which holds the
  // owner's real `sales_channels.id` values. The two sets never intersected, so
  // picking ANY channel silently emptied every report in the hub. The file's own
  // comment admitted the list was provisional; it then outlived the wave.
  //
  // An EMPTY load falls back to no options rather than to fake ones: an empty
  // picker is honest, a picker full of ids that match nothing is not. A FAILED
  // load is a different fact and now says so — see LookupError.
  const channelsQuery = useChannels(
    shows("channel") && (showMore || filters.channel.length > 0),
  );
  const channelOptions: MultiSelectOption[] = (channelsQuery.data ?? []).map((c) => ({
    value: c.id,
    label: c.name || c.code || c.id,
  }));
  // "pickup" is not in the ENUM this column can hold (dine_in | takeaway |
  // delivery), so it could only ever return nothing.
  const orderTypeOptions: MultiSelectOption[] = ORDER_TYPE_CODES.map((o) => ({
    value: o,
    label: t(`salesReports.topbar.orderTypes.${o}`),
  }));
  const summarizeValues = (values: string[], options: MultiSelectOption[] = []) => {
    const labels = values.map((value) => options.find((option) => option.value === value)?.label ?? value);
    const shown = labels.slice(0, 2).join(" · ");
    return labels.length > 2 ? `${shown} +${formatNumber(labels.length - 2)}` : shown;
  };

  /* ── DRAFT STATE ────────────────────────────────────────────────────────
   * `filters` is committed (the URL). `draft` is what the controls show. The
   * two are identical until someone edits, and «تطبيق» patches ONLY the diff.
   *
   * The resync effect keys off the committed SIGNATURE, not the object: the
   * hub memoizes `filters` per URL, but a page test (or any caller that parses
   * on every render) hands us a fresh object each time, and depending on that
   * identity would loop set-state → render → set-state. It also means an
   * outside commit — a drill pin from a page row, a saved view, clear-all —
   * pulls the draft back in step, so the bar can never show an edit that the
   * report below it has already superseded. */
  const committedSig = filterSignature(filters);
  const [draft, setDraft] = useState<AnalyticsFilters>(filters);
  useEffect(() => {
    setDraft(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedSig]);

  const pending = useMemo(() => filterDiff(filters, draft), [filters, draft]);
  const dirty = Object.keys(pending).length > 0;
  const edit = (partial: Partial<AnalyticsFilters>) => setDraft((d) => ({ ...d, ...partial }));
  const apply = () => {
    if (dirty) patch(pending);
  };

  /* ── the inline "more filters" area ──────────────────────────────────────
   * Everything that is not period / branch / compare. It opens itself when the
   * URL already carries one of these, because a deep link whose scope is
   * hidden behind a collapsed toggle is a filter the reader cannot see. */
  const MORE_KEYS = (
    [
      shows("brandId") ? "brandId" : null,
      shows("menuItemId") ? "menuItemId" : null,
      shows("channel") ? "channel" : null,
      shows("orderType") ? "orderType" : null,
      showDateBasis ? "businessDay" : null,
      showTaxBasis ? "taxIncl" : null,
    ] as const
  ).filter((k): k is Exclude<typeof k, null> => k != null);
  const hasMore = MORE_KEYS.length > 0;
  const moreActiveCount = MORE_KEYS.filter((k) =>
    new Set(nonDefaultFilterKeys(draft)).has(k),
  ).length;
  // Always start compact, including on a shared/deep link. The committed chips
  // below remain visible and state exactly which hidden filters are active;
  // opening a large filter editor automatically was the reason the first KPI
  // disappeared below the fold on a 390px phone.
  // ── active-filter chips (codec-derived; period keys collapse into one) ──
  // Derived from the COMMITTED filters on purpose: a chip describes the report
  // on screen. Chips (and clear-all) commit immediately — removing one is an
  // explicit "show me without this", not a draft edit.
  const activeKeys = new Set(nonDefaultFilterKeys(filters));
  const chips: Array<{ id: string; label: string; onRemove: () => void }> = [];
  if (activeKeys.has("from") || activeKeys.has("to") || activeKeys.has("preset")) {
    chips.push({
      id: "period",
      label: `${t("salesReports.topbar.period")}: ${formatDate(filters.from)} – ${formatDate(filters.to)}`,
      onRemove: () => patch({ from: defaults.from, to: defaults.to, preset: defaults.preset }),
    });
  }
  if (showCompare && activeKeys.has("compare")) {
    chips.push({
      id: "compare",
      label: `${t("salesReports.topbar.compare")}: ${t(`salesReports.topbar.compareModes.${filters.compare}`)}`,
      onRemove: () => patch({ compare: defaults.compare }),
    });
  }
  const multiChip = (
    key: "brandId" | "branchId" | "channel" | "orderType" | "paymentMethod" | "menuItemId" | "categoryId" | "cashierId",
    labelKey: string,
    options?: MultiSelectOption[],
  ) => {
    // A chip is a claim that the report on screen is scoped this way. A key the
    // report cannot honour is dropped from the URL by the hub, so it can only
    // be active here transiently — never claim it.
    if (!activeKeys.has(key) || !shows(key)) return;
    chips.push({
      id: key,
      label: `${t(labelKey)}: ${summarizeValues(filters[key], options)}`,
      onRemove: () => patch({ [key]: [] } as Partial<AnalyticsFilters>),
    });
  };
  multiChip("brandId", "salesReports.topbar.brand", toOptions(brands.data));
  multiChip("branchId", "salesReports.topbar.branch", toOptions(branches.data));
  multiChip("channel", "salesReports.topbar.channel", channelOptions);
  multiChip("orderType", "salesReports.topbar.orderType", orderTypeOptions);
  // Wave-4 drill params — chips keep the URL and the chip row in lock-step.
  multiChip("paymentMethod", "salesReports.dims.payment_method");
  multiChip("menuItemId", "salesReports.dims.menu_item");
  multiChip("categoryId", "salesReports.dims.category");
  multiChip("cashierId", "salesReports.dims.cashier");
  if (activeKeys.has("hour") && shows("hour")) {
    chips.push({
      id: "hour",
      label: `${t("salesReports.dims.hour")}: ${formatNumber(Number(filters.hour))}`,
      onRemove: () => patch({ hour: "" }),
    });
  }
  if (showDateBasis && activeKeys.has("businessDay")) {
    chips.push({
      id: "businessDay",
      label: t("salesReports.topbar.calendarDay"),
      onRemove: () => patch({ businessDay: defaults.businessDay }),
    });
  }
  if (showTaxBasis && activeKeys.has("taxIncl")) {
    chips.push({
      id: "taxIncl",
      label: t("salesReports.topbar.taxIncl"),
      onRemove: () => patch({ taxIncl: defaults.taxIncl }),
    });
  }

  const watermark = meta?.freshness?.watermark ?? null;
  const pendingDays = meta?.freshness?.pendingDays ?? 0;

  // A labelled field — for the EXPANDED area only. The primary bar carries no
  // visible labels on purpose: each of its controls has an aria-label and
  // displays its own value, and dropping the label line is most of what buys a
  // one-row, 44px-tall primary bar.
  const field = (label: string, control: ReactNode) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-extrabold text-slate-500">{label}</span>
      {control}
    </div>
  );

  /** A picker that says "this lookup failed" instead of "you have none". */
  const picker = (
    scope: string,
    name: string,
    query: { isError: boolean; refetch: () => unknown },
    control: ReactNode,
  ) =>
    query.isError ? (
      <LookupError scope={scope} name={name} onRetry={() => void query.refetch()} />
    ) : (
      control
    );

  return (
    // ONE card with a named action row and a compact control grid. Desktop keeps
    // the primary controls on one line. A phone deliberately uses one FULL-WIDTH
    // field per row: two cramped half-width selects looked shorter in CSS yet
    // took longer to read and left Arabic values truncated. Everything secondary
    // stays behind "more filters" and the committed chip summary.
    <div
      className="no-print surface mb-4 flex flex-col gap-2 p-2"
      data-testid="analytics-topbar"
    >
      {/* THE ONE ACTION BAR — first in the DOM, not moved with `order`
          (visually-top / tab-order-last is a WCAG 2.4.3 focus-order defect).
          Saved views, refresh, print and export live here and nowhere else. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Hidden on a phone: with the heading in the row the actions wrapped
            onto a second line, and a wrapped action bar is 44px of the very
            height this rebuild is about. The card is under a heading that
            already says what it is. */}
        <h2 className="me-auto hidden ps-1.5 text-xs font-extrabold text-slate-500 sm:block">
          {t("salesReports.hub.filtersTitle")}
        </h2>
        {/* The draft's own status light: the analyst can see that what the bar
            shows is NOT what the report below it answers. */}
        {dirty && <Badge tone="warning">{t("salesReports.topbar.pendingChanges")}</Badge>}
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
          <Button size="sm" variant="secondary" className="min-h-11" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
            {t("salesReports.topbar.refresh")}
          </Button>
        )}
        <SaveViewControl />
        {/* Print is NOT export-gated: it puts the report the user is already
            reading on paper. The hub wraps the routed page in PrintArea, and
            this bar is .no-print, so the printout is the report alone. */}
        <Button size="sm" variant="secondary" className="min-h-11" onClick={printReport} disabled={printDisabled}>
          <Printer className="h-4 w-4" />
          {t("salesReports.topbar.print")}
        </Button>
        {canExport && showExport && <ExportMenu segment={segment} filters={filters} />}
        {pageActions}
      </div>

      {/* ── THE PRIMARY BAR ──────────────────────────────────────────────────
          Period, branch, compare, Apply, more. One full-width field per row on
          a phone, two columns from sm, one row from xl. Each control names
          itself via aria-label and shows its value in place.

          `xl`, not `lg`: at a 1024 viewport the shell's 288px sidebar leaves
          ~688px, and four minmax() tracks whose minimums total 694px would
          push the page into horizontal overflow — which the e2e sweep fails
          on, at exactly that viewport. */}
      {/* Both xl templates are STATIC strings so Tailwind emits them; only which
          one is applied is conditional. */}
      <div
        data-testid="analytics-primary-filters"
        className={cn(
          "grid grid-cols-1 gap-2 sm:grid-cols-2",
          showCompare
            ? "xl:grid-cols-[minmax(11rem,1.1fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_auto]"
            : "xl:grid-cols-[minmax(11rem,1.1fr)_minmax(9rem,1fr)_auto]",
        )}
      >
        <div className="min-w-0 sm:col-span-2 xl:col-span-1">
          <DateRangePicker
            className="w-full [&>span]:w-full sm:[&>span]:w-auto"
            value={{ from: draft.from, to: draft.to, preset: draft.preset }}
            onChange={(range) => edit({ from: range.from, to: range.to, preset: range.preset })}
            labels={{
              presets: presetLabels,
              from: t("salesReports.topbar.from"),
              to: t("salesReports.topbar.to"),
              presetAriaLabel: t("salesReports.topbar.period"),
            }}
          />
        </div>
        <div className="min-w-0">
          {picker(
            "branch",
            t("salesReports.topbar.branch"),
            branches,
            <MultiSelectCombobox
              className="w-full"
              options={toOptions(branches.data)}
              values={draft.branchId}
              onChange={(values) => edit({ branchId: values })}
              ariaLabel={t("salesReports.topbar.branch")}
              labels={{ placeholder: t("salesReports.topbar.allBranches") }}
            />,
          )}
        </div>
        {/* NOT rendered — not hidden. A report with no comparison (the
            reconciliation endpoint takes a window and nothing else) would
            otherwise carry a control that changes no number on its screen, and
            a tab stop to reach it. */}
        {showCompare && (
          <div className="min-w-0">
            <ComparePicker
              className="w-full [&>span]:w-full"
              modes={["none", "prevPeriod", "prevYear"]}
              value={draft.compare}
              onChange={(mode) => {
                // This caller exposes only the three supported modes above;
                // ComparePicker remains capable of custom windows elsewhere.
                if (mode === "custom") return;
                edit({ compare: mode as AnalyticsCompareMode });
              }}
              labels={{
                modes: compareLabels,
                from: t("salesReports.topbar.from"),
                to: t("salesReports.topbar.to"),
                modeAriaLabel: t("salesReports.topbar.compare"),
              }}
            />
          </div>
        )}
        <div className="flex w-full items-center gap-2 sm:col-span-2 xl:col-span-1">
          {/* Enabled ONLY when the draft differs from the URL — the button is
              the answer to "does the report below me reflect this bar?". */}
          <Button
            className={cn("min-h-11 flex-1 xl:flex-none", dirty && "ring-2 ring-amber-300")}
            disabled={!dirty}
            onClick={apply}
          >
            {t("salesReports.topbar.apply")}
          </Button>
          {hasMore && (
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            aria-controls={MORE_FILTERS_ID}
            // Explicit label: the count badge below would otherwise change the
            // button's accessible NAME every time a filter is added.
            aria-label={t("salesReports.topbar.moreFilters")}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 xl:flex-none"
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{t("salesReports.topbar.moreFilters")}</span>
            {moreActiveCount > 0 && (
              <span
                aria-hidden="true"
                className="grid h-5 min-w-5 place-items-center rounded-full bg-teal-600 px-1 text-[11px] font-extrabold text-white"
              >
                {formatNumber(moreActiveCount)}
              </span>
            )}
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", showMore && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          )}
        </div>
      </div>

      {/* ── THE EXPANDED AREA — INLINE, never a panel ─────────────────────────
          shared/ui/drawer.tsx is a deliberate compatibility shim whose header
          says side panels do not come back; these controls therefore open in
          the page, under the bar that owns them, where the chips and the Apply
          button they feed are still visible. */}
      {hasMore && showMore && (
        <div
          id={MORE_FILTERS_ID}
          data-testid="more-filters"
          className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {shows("brandId") &&
            field(
              t("salesReports.topbar.brand"),
              picker(
                "brand",
                t("salesReports.topbar.brand"),
                brands,
                <MultiSelectCombobox
                  options={toOptions(brands.data)}
                  values={draft.brandId}
                  onChange={(values) => edit({ brandId: values })}
                  ariaLabel={t("salesReports.topbar.brand")}
                  labels={{ placeholder: t("salesReports.topbar.allBrands") }}
                />,
              ),
            )}
          {shows("menuItemId") &&
            field(
              // The owner's question is "how did THIS item sell in THAT branch" —
              // menuItemId has always been a first-class URL filter, but until now
              // the only way to set it was drilling into a row.
              t("salesReports.dims.menu_item"),
              picker(
                "menuItem",
                t("salesReports.dims.menu_item"),
                menuItems,
                // ItemPicker, not MultiSelectCombobox: the menu is the one
                // lookup here that runs to four figures, and this is the field
                // people type into. Debounced + virtualized — see the header of
                // components/ItemPicker.tsx.
                <ItemPicker
                  options={toOptions(menuItems.data)}
                  values={draft.menuItemId}
                  onChange={(values) => edit({ menuItemId: values })}
                  ariaLabel={t("salesReports.dims.menu_item")}
                  placeholder={t("salesReports.topbar.allItems")}
                />,
              ),
            )}
          {shows("channel") &&
            field(
              t("salesReports.topbar.channel"),
              picker(
                "channel",
                t("salesReports.topbar.channel"),
                channelsQuery,
                <MultiSelectCombobox
                  options={channelOptions}
                  values={draft.channel}
                  onChange={(values) => edit({ channel: values })}
                  searchable={false}
                  ariaLabel={t("salesReports.topbar.channel")}
                  labels={{ placeholder: t("salesReports.topbar.allChannels") }}
                />,
              ),
            )}
          {shows("orderType") &&
            field(
              t("salesReports.topbar.orderType"),
              <MultiSelectCombobox
                options={orderTypeOptions}
                values={draft.orderType}
                onChange={(values) => edit({ orderType: values })}
                searchable={false}
                ariaLabel={t("salesReports.topbar.orderType")}
                labels={{ placeholder: t("salesReports.topbar.allOrderTypes") }}
              />,
            )}
          {/* The SegmentedControl is inline-flex with non-flexing children, so
              a stretched one needs `[&>button]:flex-1` or it leaves trailing
              dead space. */}
          {showDateBasis &&
            field(
              t("salesReports.topbar.dateBasis"),
              <SegmentedControl
                size="sm"
                className="w-full [&>button]:min-h-11 [&>button]:flex-1"
                aria-label={t("salesReports.topbar.dateBasis")}
                value={draft.businessDay ? "business" : "calendar"}
                onChange={(v) => edit({ businessDay: v === "business" })}
                options={[
                  { value: "business", label: t("salesReports.topbar.businessDay") },
                  { value: "calendar", label: t("salesReports.topbar.calendarDay") },
                ]}
              />,
            )}
          {showTaxBasis &&
            field(
              t("salesReports.topbar.taxBasis"),
              <SegmentedControl
                size="sm"
                className="w-full [&>button]:min-h-11 [&>button]:flex-1"
                aria-label={t("salesReports.topbar.taxBasis")}
                value={draft.taxIncl ? "incl" : "excl"}
                onChange={(v) => edit({ taxIncl: v === "incl" })}
                options={[
                  { value: "excl", label: t("salesReports.topbar.taxExcl") },
                  { value: "incl", label: t("salesReports.topbar.taxIncl") },
                ]}
              />,
            )}
        </div>
      )}

      {/* A page's OWN settings, when this bar is rendered outside the hub. The
          hub itself now renders them in the rail BESIDE the report (they are a
          report's configuration, not a filter, and Builder's config alone is
          taller than a viewport). Kept so a standalone render loses nothing. */}
      {children && <div className="border-t border-slate-100 pt-3">{children}</div>}

      {/* row 3 — active-filter chips. Last, because it is a summary of state
          the controls above already show. */}
      {chips.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
          data-testid="active-filter-chips"
        >
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
            className="min-h-11 rounded-lg px-3 text-[11px] font-extrabold text-slate-500 transition hover:bg-slate-50 hover:text-rose-600"
          >
            {t("salesReports.topbar.clearAll")}
          </button>
        </div>
      )}
    </div>
  );
}
