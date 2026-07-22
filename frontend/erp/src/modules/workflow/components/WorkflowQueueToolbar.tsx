import { AlertTriangle, CheckCircle2, EyeOff, Search, SlidersHorizontal } from "lucide-react";
import { Button, Input, Select } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { cn } from "@/shared/lib";

export type QueueSegment = "all" | "unread" | "overdue" | "active";

export interface QueueFilterState {
  search: string;
  segment: QueueSegment;
  status: string;
  importance: string;
}

// Segment metadata; the visible label resolves via t("workflow.toolbar.seg*").
const SEGMENTS: Array<{
  value: QueueSegment;
  labelKey: string;
  icon: typeof CheckCircle2;
}> = [
  { value: "all", labelKey: "workflow.toolbar.segAll", icon: SlidersHorizontal },
  { value: "active", labelKey: "workflow.toolbar.segActive", icon: CheckCircle2 },
  { value: "unread", labelKey: "workflow.toolbar.segUnread", icon: EyeOff },
  { value: "overdue", labelKey: "workflow.toolbar.segOverdue", icon: AlertTriangle },
];

export function WorkflowQueueToolbar({
  value,
  onChange,
  counts,
  searchPlaceholder,
}: {
  value: QueueFilterState;
  onChange: (next: QueueFilterState) => void;
  counts: Record<QueueSegment, number>;
  searchPlaceholder?: string;
}) {
  const t = useTx();
  const filtered = value.status || value.importance || value.segment !== "all";

  return (
    <section className="surface overflow-hidden" aria-label={t("workflow.toolbar.filterAria")}>
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[minmax(18rem,1fr)_12rem_12rem_auto]">
        <Input
          value={value.search}
          onChange={(event) => onChange({ ...value, search: event.target.value })}
          placeholder={searchPlaceholder ?? t("workflow.toolbar.searchPlaceholder")}
          aria-label={t("workflow.toolbar.searchAria")}
          leading={<Search className="h-4 w-4" aria-hidden="true" />}
        />
        <Select
          value={value.status}
          aria-label={t("workflow.toolbar.statusAria")}
          onChange={(event) => onChange({ ...value, status: event.target.value })}
        >
          <option value="">{t("workflow.toolbar.statusAll")}</option>
          <option value="pending">{t("workflow.status.pending")}</option>
          <option value="in_progress">{t("workflow.status.in_progress")}</option>
          <option value="approved">{t("workflow.status.approved")}</option>
          <option value="returned">{t("workflow.status.returned")}</option>
          <option value="rejected">{t("workflow.status.rejected")}</option>
          <option value="closed">{t("workflow.status.closed")}</option>
        </Select>
        <Select
          value={value.importance}
          aria-label={t("workflow.toolbar.importanceAria")}
          onChange={(event) => onChange({ ...value, importance: event.target.value })}
        >
          <option value="">{t("workflow.toolbar.importanceAll")}</option>
          <option value="critical">{t("workflow.importance.critical")}</option>
          <option value="high">{t("workflow.importance.high")}</option>
          <option value="medium">{t("workflow.importance.medium")}</option>
          <option value="low">{t("workflow.importance.low")}</option>
        </Select>
        <Button
          variant="ghost"
          disabled={!filtered && !value.search}
          onClick={() => onChange({ search: "", segment: "all", status: "", importance: "" })}
        >
          {t("workflow.toolbar.clearFilters")}
        </Button>
      </div>

      <div className="flex gap-2 overflow-x-auto p-3 scrollbar-thin" role="group" aria-label={t("workflow.toolbar.segmentAria")}>
        {SEGMENTS.map(({ value: segment, labelKey, icon: Icon }) => {
          const selected = value.segment === segment;
          return (
            <button
              key={segment}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ ...value, segment })}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                selected
                  ? "border-teal-600 bg-teal-50 text-teal-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(labelKey)}
              <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-xs tabular-nums">{counts[segment]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
