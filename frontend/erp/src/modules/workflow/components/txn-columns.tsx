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
        <span className="font-semibold text-slate-800">{r.subject || r.title || "—"}</span>
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
