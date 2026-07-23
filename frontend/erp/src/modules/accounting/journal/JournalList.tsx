// ── JournalList — filterable list of journals + quick actions ────────────────
// Filter bar (date range / status / search / referenceType) → JournalFilters →
// useJournals. Optional KPI counts. A DataTable whose rows open the editor
// (posted ones open read-only), plus a gated "ترحيل" quick action.

import { useMemo, useState } from "react";
import { ArrowUpRight, Send } from "lucide-react";
import {
  Button,
  DatePicker,
  IconButton,
  Input,
  Select,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate } from "@/shared/lib";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import {
  usePostJournal,
  useJournals,
  type Journal,
  type JournalFilters,
} from "../api";
import {
  MoneyText,
  STATUS_LABEL,
  mapJournalError,
} from "./journalModel";

const POST_CAP = "accounting.journals.post" as const;

interface DraftFilters {
  startDate: string;
  endDate: string;
  status: string;
  q: string;
  referenceType: string;
}

const EMPTY_DRAFT: DraftFilters = {
  startDate: "",
  endDate: "",
  status: "",
  q: "",
  referenceType: "",
};

function clean(f: DraftFilters): JournalFilters {
  const out: JournalFilters = {};
  if (f.startDate) out.startDate = f.startDate;
  if (f.endDate) out.endDate = f.endDate;
  if (f.status) out.status = f.status;
  if (f.q.trim()) out.q = f.q.trim();
  if (f.referenceType) out.referenceType = f.referenceType;
  return out;
}

export interface JournalListProps {
  onOpen: (journal: Journal | null) => void;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="surface flex flex-col gap-1 p-4">
      <span className="text-[11px] font-bold text-slate-400">{label}</span>
      <span dir="ltr" className={`text-2xl font-extrabold tabular-nums ${tone}`}>
        {value}
      </span>
    </div>
  );
}

export function JournalList({ onOpen }: JournalListProps) {
  const t = useT();
  const canPost = useCan(POST_CAP);
  const { toast } = useToast();

  const statusOptions = useMemo(
    () => [
      { value: "", label: t("accounting.journal.statusOption.all") },
      { value: "draft", label: t("accounting.journal.statusOption.draft") },
      { value: "approved", label: t("accounting.journal.statusOption.approved") },
      { value: "posted", label: t("accounting.journal.statusOption.posted") },
    ],
    [t],
  );
  const refTypeOptions = useMemo(
    () => [
      { value: "", label: t("accounting.journal.refType.all") },
      { value: "manual", label: t("accounting.journal.refType.manual") },
      { value: "opening", label: t("accounting.journal.refType.opening") },
      { value: "sale", label: t("accounting.journal.refType.sale") },
      { value: "purchase", label: t("accounting.journal.refType.purchase") },
      { value: "custody", label: t("accounting.journal.refType.custody") },
      { value: "payroll", label: t("accounting.journal.refType.payroll") },
      { value: "depreciation", label: t("accounting.journal.refType.depreciation") },
      { value: "reversal", label: t("accounting.journal.refType.reversal") },
    ],
    [t],
  );

  const [draft, setDraft] = useState<DraftFilters>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<JournalFilters>({});

  const query = useJournals(applied);
  const post = usePostJournal();
  const [postingId, setPostingId] = useState<string | null>(null);

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const kpis = useMemo(() => {
    let draftN = 0;
    let approved = 0;
    let posted = 0;
    for (const j of rows) {
      if (j.status === "draft") draftN += 1;
      else if (j.status === "approved") approved += 1;
      else if (j.status === "posted") posted += 1;
    }
    return { total: rows.length, draftN, approved, posted };
  }, [rows]);

  function patch(part: Partial<DraftFilters>) {
    setDraft((d) => ({ ...d, ...part }));
  }
  // Selects apply immediately; text/date apply via the search button / Enter.
  function patchAndApply(part: Partial<DraftFilters>) {
    setDraft((d) => {
      const next = { ...d, ...part };
      setApplied(clean(next));
      return next;
    });
  }
  function applyFilters() {
    setApplied(clean(draft));
  }

  function quickPost(journal: Journal) {
    setPostingId(journal.id);
    post.mutate(
      { id: journal.id, status: journal.status },
      {
        onSuccess: (res) => {
          setPostingId(null);
          if (res && res.success === false) {
            toast({ tone: "error", title: mapJournalError(t, res.error) });
            return;
          }
          toast({ tone: "success", title: t("accounting.journal.toast.posted", { number: journal.journalNumber }) });
        },
        onError: (e) => {
          setPostingId(null);
          toast({ tone: "error", title: mapJournalError(t, e instanceof Error ? e.message : "") });
        },
      },
    );
  }

  const columns: ColumnDef<Journal>[] = [
    {
      id: "journalNumber",
      header: t("accounting.journal.col.number"),
      accessor: (r) => r.journalNumber,
      sortable: true,
      cell: (r) => (
        <code dir="ltr" className="text-xs font-extrabold text-teal-700 tabular-nums">
          {r.journalNumber}
        </code>
      ),
    },
    {
      id: "journalDate",
      header: t("accounting.common.date"),
      accessor: (r) => r.journalDate,
      sortable: true,
      cell: (r) => (
        <span dir="ltr" className="tabular-nums text-slate-600">
          {formatDate(r.journalDate)}
        </span>
      ),
    },
    { id: "description", header: t("accounting.journal.col.description"), accessor: (r) => r.description || "—" },
    {
      id: "totalDebit",
      header: t("accounting.common.debit"),
      numeric: true,
      accessor: (r) => r.totalDebit,
      sortable: true,
      cell: (r) => <MoneyText value={r.totalDebit} />,
    },
    {
      id: "totalCredit",
      header: t("accounting.common.credit"),
      numeric: true,
      accessor: (r) => r.totalCredit,
      sortable: true,
      cell: (r) => <MoneyText value={r.totalCredit} />,
    },
    {
      id: "status",
      header: t("accounting.journal.col.status"),
      accessor: (r) => STATUS_LABEL[r.status],
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge>{STATUS_LABEL[r.status]}</StatusBadge>
          {r.reversedByJournalId && <StatusBadge>معكوس</StatusBadge>}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="surface flex flex-wrap items-end gap-3 p-4">
        <label className="flex min-w-40 flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">{t("accounting.common.fromDate")}</span>
          <DatePicker value={draft.startDate} onChange={(startDate) => patch({ startDate })} />
        </label>
        <label className="flex min-w-40 flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">{t("accounting.common.toDate")}</span>
          <DatePicker value={draft.endDate} onChange={(endDate) => patch({ endDate })} />
        </label>
        <label className="flex min-w-40 flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">{t("accounting.journal.filter.status")}</span>
          <Select
            value={draft.status}
            onChange={(e) => patchAndApply({ status: e.target.value })}
            options={statusOptions}
          />
        </label>
        <label className="flex min-w-40 flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">{t("accounting.journal.filter.type")}</span>
          <Select
            value={draft.referenceType}
            onChange={(e) => patchAndApply({ referenceType: e.target.value })}
            options={refTypeOptions}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-xs font-bold text-slate-600">{t("common.search")}</span>
          <Input
            value={draft.q}
            onChange={(e) => patch({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilters();
            }}
            placeholder={t("accounting.journal.filter.searchPlaceholder")}
          />
        </label>
        <Button variant="primary" onClick={applyFilters} loading={query.isFetching}>
          {t("common.search")}
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t("accounting.journal.kpi.total")} value={kpis.total} tone="text-slate-900" />
        <Kpi label={t("accounting.journal.kpi.draft")} value={kpis.draftN} tone="text-slate-600" />
        <Kpi label={t("accounting.journal.kpi.approved")} value={kpis.approved} tone="text-amber-600" />
        <Kpi label={t("accounting.journal.kpi.posted")} value={kpis.posted} tone="text-emerald-600" />
      </div>

      {/* Table */}
      <DataTable<Journal>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        onRowClick={(r) => onOpen(r)}
        emptyTitle={t("accounting.journal.empty.title")}
        emptyBody={t("accounting.journal.empty.body")}
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            {canPost && r.status !== "posted" && (
              <IconButton
                aria-label={t("accounting.journal.action.post")}
                size="sm"
                onClick={() => quickPost(r)}
                disabled={post.isPending && postingId === r.id}
              >
                <Send className="h-4 w-4 text-teal-600" />
              </IconButton>
            )}
            <IconButton aria-label={t("accounting.journal.action.open")} size="sm" onClick={() => onOpen(r)}>
              <ArrowUpRight className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />
    </div>
  );
}

export default JournalList;
