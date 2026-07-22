import { useState } from "react";
import { AlarmClock, Clock, Timer, TrendingUp, Zap } from "lucide-react";
import { useAuth } from "@/app/providers";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useTx } from "@/shared/ui/i18n";
import {
  useSlaOverdue,
  useSlaStats,
  useEscalateNow,
  type SlaOverdueItem,
} from "../lib/api";

// اتفاقيات الخدمة (SLA) — read-only health of the workflow queue: open/overdue/
// due-soon counts + system-wide overdue list, plus an admin "escalate now" sweep
// (the same sweep the background worker runs every 30 min). System-wide view →
// overdue is fetched with an EMPTY username.

function StatCard({
  icon,
  label,
  value,
  tone = "text-slate-900",
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-500">{label}</div>
        <div dir="ltr" className={`text-xl font-extrabold tabular-nums ${tone}`}>
          {value}
        </div>
      </div>
    </Card>
  );
}

export function SlaTab() {
  const t = useTx();
  const { user } = useAuth();
  const stats = useSlaStats();
  const overdue = useSlaOverdue(""); // empty → system-wide (admin) view
  const escalate = useEscalateNow();
  const { toast } = useToast();

  const [confirming, setConfirming] = useState(false);
  const [escalateError, setEscalateError] = useState<string | null>(null);

  // Priority chips reuse the shared importance labels; "urgent" is SLA-specific.
  const priorityLabel = (key: string) =>
    key === "urgent"
      ? t("workflow.sla.priorityUrgent")
      : ["high", "medium", "low"].includes(key)
        ? t(`workflow.importance.${key}`)
        : key;

  function runEscalation() {
    setEscalateError(null);
    escalate.mutate(user?.username ?? "", {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setEscalateError(res.error || t("workflow.sla.escalateFailed"));
          return;
        }
        toast({
          title: t("workflow.sla.escalateDone"),
          description: t("workflow.sla.escalateDoneDesc", { checked: res.checked ?? 0, escalated: res.escalated ?? 0 }),
          tone: "success",
        });
        setConfirming(false);
      },
      onError: (e) => setEscalateError(e instanceof Error ? e.message : t("workflow.sla.escalateFailed")),
    });
  }

  const columns: ColumnDef<SlaOverdueItem>[] = [
    {
      id: "txnNumber",
      header: t("workflow.sla.colTxn"),
      accessor: (r) => r.txnNumber || r.id,
      cell: (r) => (
        <div className="min-w-0">
          <div dir="ltr" className="truncate font-bold text-slate-800">
            {r.txnNumber || r.id}
          </div>
          <div className="truncate text-[11px] text-slate-400">{r.subject || "—"}</div>
        </div>
      ),
    },
    { id: "typeName", header: t("workflow.col.type"), accessor: (r) => r.typeName || "—" },
    { id: "assignee", header: t("workflow.sla.colAssignee"), accessor: (r) => r.currentAssignee || "—" },
    {
      id: "hoursOverdue",
      header: t("workflow.sla.colHoursOverdue"),
      accessor: (r) => r.hoursOverdue,
      numeric: true,
      sortable: true,
      cell: (r) => (
        <StatusBadge tone="danger">{String(Math.round(r.hoursOverdue))}</StatusBadge>
      ),
    },
    {
      id: "escalationCount",
      header: t("workflow.sla.colEscalationCount"),
      accessor: (r) => r.escalationCount,
      numeric: true,
      sortable: true,
      cell: (r) => (
        <Badge tone={r.escalationCount > 0 ? "warning" : "neutral"}>
          <span dir="ltr" className="tabular-nums">
            {r.escalationCount}
          </span>
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {stats.isLoading ? (
        <LoadingState rows={2} />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
      ) : stats.data && !stats.data.error ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard
            icon={<Clock className="h-5 w-5" />}
            label={t("workflow.sla.statOpen")}
            value={stats.data.totalOpen}
          />
          <StatCard
            icon={<AlarmClock className="h-5 w-5" />}
            label={t("workflow.sla.statOverdue")}
            value={stats.data.overdueCount}
            tone="text-rose-600"
          />
          <StatCard
            icon={<Timer className="h-5 w-5" />}
            label={t("workflow.sla.statDue24h")}
            value={stats.data.due24h}
            tone="text-amber-600"
          />
          <StatCard
            icon={<TrendingUp className="h-5 w-5" />}
            label={t("workflow.sla.statAvgClose")}
            value={Math.round(stats.data.avgCloseHours)}
          />
        </div>
      ) : null}

      {stats.data?.overdueByPriority && Object.keys(stats.data.overdueByPriority).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-500">{t("workflow.sla.overdueByPriority")}</span>
          {Object.entries(stats.data.overdueByPriority).map(([k, v]) => (
            <Badge key={k} tone="warning">
              {priorityLabel(k)}: <span dir="ltr">{v}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-extrabold text-slate-800">{t("workflow.sla.overdueTitle")}</h3>
        <Button variant="primary" onClick={() => setConfirming(true)}>
          <Zap className="h-4 w-4" /> {t("workflow.sla.escalateNow")}
        </Button>
      </div>

      {overdue.isLoading ? (
        <LoadingState rows={4} />
      ) : overdue.isError ? (
        <ErrorState error={overdue.error} onRetry={() => overdue.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={overdue.data ?? []}
          getRowId={(r) => r.id}
          tableId="wf-sla-overdue"
          emptyTitle={t("workflow.sla.emptyTitle")}
          emptyBody={t("workflow.sla.emptyBody")}
        />
      )}

      <ConfirmDialog
        open={confirming}
        title={t("workflow.sla.confirmTitle")}
        description={t("workflow.sla.confirmDesc")}
        confirmLabel={t("workflow.sla.escalateNow")}
        processing={escalate.isPending}
        error={escalateError}
        onConfirm={runEscalation}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
