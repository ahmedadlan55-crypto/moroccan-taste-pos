import { AlertTriangle, Clock3 } from "lucide-react";
import { Badge, StatusBadge } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import type { ColumnDef } from "@/shared/tables";
import { importanceMeta, statusMeta } from "../lib/labels";
import type { TxnListItem } from "../lib/types";

/** The "person" column varies by box: sender (وارد) vs. current holder (صادر/طلباتي). */
export interface PeopleColumn {
  id: string;
  header: string;
  value: (row: TxnListItem) => string;
}

/**
 * Column set shared by every workflow list (وارد / صادر / طلباتي). Read-only:
 * every cell renders through the shared formatters + status/priority badges.
 */
export function buildTxnColumns(people: PeopleColumn): ColumnDef<TxnListItem>[] {
  return [
    {
      id: "txnNumber",
      header: "رقم المعاملة",
      accessor: (r) => r.txnNumber ?? "",
      cell: (r) => (
        <span dir="ltr" className="font-bold tabular-nums text-slate-700">
          {r.txnNumber || "—"}
        </span>
      ),
      sortable: true,
      width: "9rem",
    },
    {
      id: "type",
      header: "النوع",
      accessor: (r) => r.typeName ?? "",
      cell: (r) => r.typeName || "—",
      sortable: true,
    },
    {
      id: "subject",
      header: "الموضوع",
      accessor: (r) => r.subject || r.title || "",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-800">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${r.isRead === false ? "bg-teal-600" : "bg-transparent"}`}
            aria-label={r.isRead === false ? "غير مقروءة" : undefined}
          />
          <span className="line-clamp-2">{r.subject || r.title || "—"}</span>
        </span>
      ),
    },
    {
      id: people.id,
      header: people.header,
      accessor: people.value,
      cell: (r) => people.value(r) || "—",
      sortable: true,
    },
    {
      id: "currentStep",
      header: "الخطوة الحالية",
      accessor: (r) => r.currentStepName ?? "",
      cell: (r) => <span className="font-semibold text-slate-600">{r.currentStepName || "—"}</span>,
      sortable: true,
    },
    {
      id: "sla",
      header: "SLA",
      accessor: (r) => r.dueDate ?? "",
      cell: (r) => r.isOverdue ? (
        <span className="inline-flex items-center gap-1 font-bold text-rose-700">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> متأخرة
        </span>
      ) : r.dueDate ? (
        <span className="inline-flex items-center gap-1 font-semibold text-slate-500">
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> {formatDate(r.dueDate)}
        </span>
      ) : "—",
      sortable: true,
      width: "9rem",
    },
    {
      id: "importance",
      header: "الأهمية",
      accessor: (r) => r.importance ?? "",
      cell: (r) => {
        const meta = importanceMeta(r.importance);
        return <Badge tone={meta.tone}>{meta.label}</Badge>;
      },
      sortable: true,
      align: "center",
      width: "7rem",
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status ?? "",
      cell: (r) => {
        const meta = statusMeta(r.status);
        return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
      },
      sortable: true,
      align: "center",
      width: "9rem",
    },
    {
      id: "createdAt",
      header: "التاريخ",
      accessor: (r) => r.createdAt ?? "",
      cell: (r) => (
        <span dir="ltr" className="tabular-nums text-slate-500">
          {formatDate(r.createdAt)}
        </span>
      ),
      sortable: true,
      width: "9rem",
    },
  ];
}
