import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, EyeOff, Inbox, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge, EmptyState, ErrorState, LoadingState, buttonVariants } from "@/shared/ui";
import { DataTable } from "@/shared/tables";
import { useAuth, useCan } from "@/app/providers";
import { useTx } from "@/shared/ui/i18n";
import { cn } from "@/shared/lib";
import type { TxnListItem } from "../lib/types";
import { buildTxnColumns, type PeopleColumn } from "./txn-columns";
import { ScreenIntro } from "./ScreenIntro";
import { TxnDetailDrawer } from "./TxnDetailDrawer";
import { WorkflowQueueCard } from "./WorkflowQueueCard";
import {
  WorkflowQueueToolbar,
  type QueueFilterState,
  type QueueSegment,
} from "./WorkflowQueueToolbar";

interface Props {
  icon: LucideIcon;
  description: string;
  tableId: string;
  peopleColumn: PeopleColumn;
  queryKey: (username: string) => readonly unknown[];
  fetcher: (username: string, opts: { signal?: AbortSignal }) => Promise<TxnListItem[]>;
  emptyTitle: string;
  emptyBody?: string;
  searchPlaceholder?: string;
  /** Inbox only: enable the real action bar (اعتماد/رفض/إرجاع/إحالة) in the drawer. */
  canAct?: boolean;
}

/**
 * The shared list surface for a workflow box (وارد / صادر / طلباتي): a DataTable
 * of transactions whose rows open a detail Drawer. Only the inbox passes
 * `canAct` — outbox / طلباتي stay read-only.
 */
export function TxnListScreen({
  icon,
  description,
  tableId,
  peopleColumn,
  queryKey,
  fetcher,
  emptyTitle,
  emptyBody,
  searchPlaceholder,
  canAct = false,
}: Props) {
  const t = useTx();
  const { user } = useAuth();
  const username = user?.username ?? "";
  const canCreate = useCan("txn.create");

  const query = useQuery({
    queryKey: queryKey(username),
    queryFn: ({ signal }) => fetcher(username, { signal }),
    enabled: !!username,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<QueueFilterState>({
    search: "",
    segment: "all",
    status: "",
    importance: "",
  });

  const columns = useMemo(() => buildTxnColumns(peopleColumn, t), [peopleColumn, t]);
  const rows = query.data ?? [];
  const counts = useMemo<Record<QueueSegment, number>>(() => ({
    all: rows.length,
    active: rows.filter((row) => ["created", "pending", "in_progress", "replied", "returned"].includes(row.status)).length,
    unread: rows.filter((row) => row.isRead === false).length,
    overdue: rows.filter((row) => row.isOverdue).length,
  }), [rows]);
  const filteredRows = useMemo(() => {
    const needle = filters.search.trim().toLocaleLowerCase("ar");
    return rows.filter((row) => {
      if (filters.status && row.status !== filters.status) return false;
      if (filters.importance && row.importance !== filters.importance) return false;
      if (filters.segment === "active" && !["created", "pending", "in_progress", "replied", "returned"].includes(row.status)) return false;
      if (filters.segment === "unread" && row.isRead !== false) return false;
      if (filters.segment === "overdue" && !row.isOverdue) return false;
      if (!needle) return true;
      return [
        row.txnNumber,
        row.subject,
        row.title,
        row.typeName,
        row.creatorName,
        row.createdBy,
        row.assigneeName,
        row.currentAssignee,
        row.branchName,
        row.deptName,
      ].some((value) => String(value ?? "").toLocaleLowerCase("ar").includes(needle));
    });
  }, [filters, rows]);

  function openTxn(row: TxnListItem) {
    setSelectedId(row.id);
    setOpen(true);
  }

  return (
    <div className="space-y-5">
      <ScreenIntro
        icon={icon}
        description={description}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {rows.length > 0 && <Badge tone="teal">{t("workflow.list.countBadge", { count: rows.length })}</Badge>}
            {canCreate && (
              <Link to="/workflow/new" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                <Plus className="h-4 w-4" aria-hidden="true" /> {t("workflow.list.newTxn")}
              </Link>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label={t("workflow.list.kpiAria")}>
        {[
          { label: t("workflow.list.kpiTotal"), value: counts.all, Icon: Inbox, tone: "text-slate-700 bg-slate-50" },
          { label: t("workflow.list.kpiActive"), value: counts.active, Icon: CheckCircle2, tone: "text-sky-700 bg-sky-50" },
          { label: t("workflow.list.kpiUnread"), value: counts.unread, Icon: EyeOff, tone: "text-teal-700 bg-teal-50" },
          { label: t("workflow.list.kpiOverdue"), value: counts.overdue, Icon: AlertTriangle, tone: "text-rose-700 bg-rose-50" },
        ].map(({ label, value, Icon: KpiIcon, tone }) => (
          <div key={label} className="surface flex min-w-0 items-center gap-3 p-4">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone}`}>
              <KpiIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="text-xl font-extrabold tabular-nums text-slate-900">{value}</div>
              <div className="truncate text-xs font-bold text-slate-500">{label}</div>
            </div>
          </div>
        ))}
      </div>

      <WorkflowQueueToolbar
        value={filters}
        onChange={setFilters}
        counts={counts}
        searchPlaceholder={searchPlaceholder}
      />

      <div className="hidden md:block">
        <DataTable<TxnListItem>
          columns={columns}
          rows={filteredRows}
          getRowId={(r) => r.id}
          loading={query.isLoading}
          error={query.isError ? query.error : undefined}
          onRetry={() => query.refetch()}
          tableId={tableId}
          initialSort={{ columnId: "createdAt", dir: "desc" }}
          emptyTitle={emptyTitle}
          emptyBody={emptyBody}
          onRowClick={openTxn}
          stackOnMobile={false}
        />
      </div>

      <div className="md:hidden">
        {query.isLoading ? (
          <div className="surface p-4"><LoadingState /></div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : filteredRows.length === 0 ? (
          <EmptyState
            title={filters.search || filters.segment !== "all" || filters.status || filters.importance ? t("workflow.list.noMatchTitle") : emptyTitle}
            body={filters.search || filters.segment !== "all" || filters.status || filters.importance ? t("workflow.list.noMatchBody") : emptyBody}
          />
        ) : (
          <ul className="space-y-3">
            {filteredRows.map((row) => (
              <WorkflowQueueCard
                key={row.id}
                row={row}
                personLabel={peopleColumn.header}
                person={peopleColumn.value(row)}
                onOpen={() => openTxn(row)}
              />
            ))}
          </ul>
        )}
      </div>

      <TxnDetailDrawer
        txnId={selectedId}
        open={open}
        onClose={() => setOpen(false)}
        username={username}
        canAct={canAct}
      />
    </div>
  );
}
