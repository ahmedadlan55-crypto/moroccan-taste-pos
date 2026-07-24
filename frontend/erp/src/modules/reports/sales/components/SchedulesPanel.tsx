// Sales Analytics Hub — scheduled reports panel (the "الجداول الزمنية" tab of
// /reports/saved).
//
// CRUD over /api/analytics/schedules (cap analytics.schedule — the PARENT page
// hides this tab without it; the server re-checks anyway). A schedule stores a
// PLANNER-shaped request (the worker dry-plans it via ExportService.createJob),
// built here from either a saved analytics view's captured URL state or the
// codec defaults, with the DEFAULT_EXPORT_SPEC metrics/dimensions.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  Select,
  Toggle,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useLang, useT } from "@/i18n";
import { analyticsFilterCodec } from "../lib/filters";
import {
  buildPlannerRequest,
  createAnalyticsSchedule,
  deleteAnalyticsSchedule,
  fetchAnalyticsSchedules,
  fetchSavedViews,
  savedViewSearchString,
  updateAnalyticsSchedule,
  DEFAULT_EXPORT_SPEC,
  type AnalyticsSavedView,
  type AnalyticsSchedule,
  type AnalyticsSchedulePayload,
  type ExportFormat,
  type ScheduleFreq,
} from "../lib/api";

/** The 16 hub segments — inlined to avoid importing the hub container here. */
const ANALYTICS_SEGMENTS = [
  "executive", "explorer", "items", "modifiers", "payments", "cashiers",
  "branches", "hours", "orders", "discounts", "voids", "shifts", "taxes",
  "profitability", "reconciliation", "builder",
] as const;

const DEFAULT_TIMEZONE = "Asia/Riyadh";
const CURRENT_SOURCE = "__current__";

/** Service contract: weekday 0 = Sunday … 6 = Saturday (ScheduleService). */
const WEEKDAY_BASE_SUNDAY = new Date(Date.UTC(2023, 0, 1)); // 2023-01-01 = Sunday

interface ScheduleForm {
  name: string;
  /** CURRENT_SOURCE (codec defaults) or a saved-view id. */
  source: string;
  format: ExportFormat;
  freq: ScheduleFreq;
  weekday: string;
  monthDay: string;
  atTime: string;
  timezone: string;
  isActive: boolean;
}

function emptyForm(): ScheduleForm {
  return {
    name: "",
    source: CURRENT_SOURCE,
    format: "csv",
    freq: "daily",
    weekday: "0",
    monthDay: "1",
    atTime: "08:00",
    timezone: DEFAULT_TIMEZONE,
    isActive: true,
  };
}

function formFrom(schedule: AnalyticsSchedule): ScheduleForm {
  return {
    name: schedule.name,
    source: CURRENT_SOURCE, // the stored request is kept unless a new source is picked
    format: schedule.format === "xlsx" ? "xlsx" : "csv",
    freq: (["daily", "weekly", "monthly"] as const).includes(schedule.freq as ScheduleFreq)
      ? (schedule.freq as ScheduleFreq)
      : "daily",
    weekday: String(schedule.weekday ?? 0),
    monthDay: String(schedule.month_day ?? 1),
    atTime: String(schedule.at_time ?? "08:00").slice(0, 5),
    timezone: schedule.timezone || DEFAULT_TIMEZONE,
    isActive: !!Number(schedule.is_active),
  };
}

export function SchedulesPanel() {
  const t = useT();
  const lang = useLang();
  const queryClient = useQueryClient();

  const schedules = useQuery({
    queryKey: ["analytics", "schedules"],
    queryFn: ({ signal }) => fetchAnalyticsSchedules(signal),
  });

  // Saved analytics views across every hub segment — the request-source picker.
  const savedViews = useQuery({
    queryKey: ["analytics", "saved-views", "all-segments"],
    queryFn: async ({ signal }) => {
      const lists = await Promise.all(
        ANALYTICS_SEGMENTS.map((s) => fetchSavedViews(`analytics:${s}`, signal).catch(() => [])),
      );
      return lists.flat();
    },
  });

  const [editing, setEditing] = useState<AnalyticsSchedule | "new" | null>(null);
  const [form, setForm] = useState<ScheduleForm>(emptyForm);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<AnalyticsSchedule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { weekday: "long", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(WEEKDAY_BASE_SUNDAY.getTime() + i * 86400000)),
    );
  }, [lang]);

  const freqLabel = (freq: string) =>
    freq === "daily" || freq === "weekly" || freq === "monthly"
      ? t(`salesReports.schedules.${freq}`)
      : freq;

  const openCreate = () => {
    setForm(emptyForm());
    setSubmitError(null);
    setEditing("new");
  };

  const openEdit = (schedule: AnalyticsSchedule) => {
    setForm(formFrom(schedule));
    setSubmitError(null);
    setEditing(schedule);
  };

  /** Planner request from the picked source (saved view URL state or defaults). */
  const requestFromSource = (source: string) => {
    let search = "";
    if (source !== CURRENT_SOURCE) {
      const view = (savedViews.data ?? []).find((v) => v.id === source);
      search = (view && savedViewSearchString(view)) ?? "";
    }
    const filters = analyticsFilterCodec.parse(new URLSearchParams(search));
    return buildPlannerRequest(filters, DEFAULT_EXPORT_SPEC);
  };

  const submit = async () => {
    if (editing == null) return;
    const name = form.name.trim();
    if (name === "") return;
    setSubmitting(true);
    setSubmitError(null);
    const payload: AnalyticsSchedulePayload = {
      name,
      request: requestFromSource(form.source),
      format: form.format,
      freq: form.freq,
      at_time: form.atTime,
      ...(form.freq === "weekly" ? { weekday: Number(form.weekday) } : {}),
      ...(form.freq === "monthly" ? { month_day: Number(form.monthDay) } : {}),
      timezone: form.timezone.trim() || DEFAULT_TIMEZONE,
      is_active: form.isActive,
    };
    try {
      if (editing === "new") await createAnalyticsSchedule(payload);
      else await updateAnalyticsSchedule(editing.id, payload);
      await queryClient.invalidateQueries({ queryKey: ["analytics", "schedules"] });
      setEditing(null);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteAnalyticsSchedule(deleting.id);
      await queryClient.invalidateQueries({ queryKey: ["analytics", "schedules"] });
    } finally {
      setDeleteBusy(false);
      setDeleting(null);
    }
  };

  const columns = useMemo<ColumnDef<AnalyticsSchedule>[]>(
    () => [
      {
        id: "name",
        header: t("salesReports.schedules.name"),
        accessor: (r) => r.name,
        pinStart: true,
        sortable: true,
      },
      {
        id: "freq",
        header: t("salesReports.schedules.freq"),
        accessor: (r) => String(r.freq),
        cell: (r) => freqLabel(String(r.freq)),
        sortable: true,
      },
      {
        id: "atTime",
        header: t("salesReports.schedules.atTime"),
        accessor: (r) => String(r.at_time ?? ""),
        cell: (r) => String(r.at_time ?? "").slice(0, 5),
      },
      {
        id: "timezone",
        header: t("salesReports.schedules.timezone"),
        accessor: (r) => r.timezone,
      },
      {
        id: "active",
        header: t("salesReports.schedules.active"),
        accessor: (r) => (Number(r.is_active) ? 1 : 0),
        cell: (r) =>
          Number(r.is_active) ? (
            <Badge tone="success">{t("common.active")}</Badge>
          ) : (
            <Badge tone="neutral">{t("common.inactive")}</Badge>
          ),
      },
      {
        id: "actions",
        header: t("common.actions"),
        accessor: () => null,
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <IconButton
              size="sm"
              aria-label={`${t("salesReports.schedules.edit")}: ${r.name}`}
              onClick={() => openEdit(r)}
            >
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              size="sm"
              variant="danger"
              aria-label={`${t("common.delete")}: ${r.name}`}
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const viewOptions = [
    // The codec defaults ARE the last-30-days window — an honest label for
    // "schedule over the current default filters" without a new i18n key.
    { value: CURRENT_SOURCE, label: t("salesReports.topbar.presets.last30") },
    ...(savedViews.data ?? []).map((v: AnalyticsSavedView) => ({
      value: v.id,
      label: v.name,
    })),
  ];

  const field = (label: string, control: ReactNode) => (
    <label className="block">
      <span className="text-xs font-bold text-slate-600">{label}</span>
      <span className="mt-1 block">{control}</span>
    </label>
  );

  return (
    <section data-testid="schedules-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-extrabold text-slate-700">
          <CalendarClock className="h-4 w-4 text-teal-700" aria-hidden="true" />
          {t("salesReports.saved.tabSchedules")}
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> {t("salesReports.schedules.create")}
        </Button>
      </div>

      <DataTable<AnalyticsSchedule>
        columns={columns}
        rows={schedules.data ?? []}
        getRowId={(r) => r.id}
        loading={schedules.isLoading}
        error={schedules.isError ? schedules.error : undefined}
        onRetry={() => void schedules.refetch()}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.name}
        columnMenu={false}
      />

      {/* create / edit */}
      <Dialog
        open={editing != null}
        onClose={() => (submitting ? undefined : setEditing(null))}
        title={editing === "new" ? t("salesReports.schedules.create") : t("salesReports.schedules.edit")}
        size="md"
        presentation="compact"
        dismissable={!submitting}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={submitting}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={form.name.trim() === ""} loading={submitting}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {field(
            t("salesReports.schedules.name"),
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />,
          )}
          {field(
            t("salesReports.saved.title"),
            <Select
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              options={viewOptions}
              aria-label={t("salesReports.saved.title")}
            />,
          )}
          <div className="grid grid-cols-2 gap-3">
            {field(
              t("salesReports.topbar.export"),
              <Select
                value={form.format}
                onChange={(e) => setForm((f) => ({ ...f, format: e.target.value === "xlsx" ? "xlsx" : "csv" }))}
                options={[
                  { value: "csv", label: t("salesReports.exportMenu.csv") },
                  { value: "xlsx", label: t("salesReports.exportMenu.xlsx") },
                ]}
                aria-label={t("salesReports.topbar.export")}
              />,
            )}
            {field(
              t("salesReports.schedules.freq"),
              <Select
                value={form.freq}
                onChange={(e) =>
                  setForm((f) => ({ ...f, freq: (["daily", "weekly", "monthly"] as const).includes(e.target.value as ScheduleFreq) ? (e.target.value as ScheduleFreq) : "daily" }))
                }
                options={[
                  { value: "daily", label: t("salesReports.schedules.daily") },
                  { value: "weekly", label: t("salesReports.schedules.weekly") },
                  { value: "monthly", label: t("salesReports.schedules.monthly") },
                ]}
                aria-label={t("salesReports.schedules.freq")}
              />,
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {form.freq === "weekly" &&
              field(
                t("salesReports.schedules.weekday"),
                <Select
                  value={form.weekday}
                  onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value }))}
                  options={weekdayLabels.map((label, i) => ({ value: String(i), label }))}
                  aria-label={t("salesReports.schedules.weekday")}
                />,
              )}
            {form.freq === "monthly" &&
              field(
                t("salesReports.schedules.monthDay"),
                <Select
                  value={form.monthDay}
                  onChange={(e) => setForm((f) => ({ ...f, monthDay: e.target.value }))}
                  options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                  aria-label={t("salesReports.schedules.monthDay")}
                />,
              )}
            {field(
              t("salesReports.schedules.atTime"),
              <Input
                type="time"
                value={form.atTime}
                onChange={(e) => setForm((f) => ({ ...f, atTime: e.target.value }))}
                aria-label={t("salesReports.schedules.atTime")}
              />,
            )}
          </div>
          {field(
            t("salesReports.schedules.timezone"),
            <Input
              value={form.timezone}
              onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
              dir="ltr"
            />,
          )}
          <Toggle
            checked={form.isActive}
            onChange={(checked) => setForm((f) => ({ ...f, isActive: checked }))}
            label={t("salesReports.schedules.active")}
          />
          {submitError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {submitError}
            </div>
          )}
        </div>
      </Dialog>

      {/* delete confirm */}
      <ConfirmDialog
        open={deleting != null}
        title={t("salesReports.schedules.deleteConfirm")}
        description={deleting?.name}
        tone="danger"
        processing={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}
