import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/shared/ui";
import { DataTable } from "@/shared/tables";
import { useAuth } from "@/app/providers";
import type { TxnListItem } from "../lib/types";
import { buildTxnColumns, type PeopleColumn } from "./txn-columns";
import { ScreenIntro } from "./ScreenIntro";
import { TxnDetailDrawer } from "./TxnDetailDrawer";

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
  /** Inbox only: expose the "act in the legacy system" note in the detail drawer. */
  showLegacyAction?: boolean;
}

/**
 * The shared read-only list surface for a workflow box (وارد / صادر / طلباتي):
 * a DataTable of transactions whose rows open a read-only detail Drawer. No
 * approve/reject actions — those are the heavy engine, deferred to the legacy app.
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
  showLegacyAction = false,
}: Props) {
  const { user } = useAuth();
  const username = user?.username ?? "";

  const query = useQuery({
    queryKey: queryKey(username),
    queryFn: ({ signal }) => fetcher(username, { signal }),
    enabled: !!username,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const columns = useMemo(() => buildTxnColumns(peopleColumn), [peopleColumn]);
  const rows = query.data ?? [];

  return (
    <div className="space-y-5">
      <ScreenIntro
        icon={icon}
        description={description}
        action={
          rows.length > 0 ? (
            <Badge tone="teal">{`${rows.length} معاملة`}</Badge>
          ) : undefined
        }
      />

      <DataTable<TxnListItem>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder={searchPlaceholder ?? "بحث بالرقم أو الموضوع…"}
        tableId={tableId}
        initialSort={{ columnId: "createdAt", dir: "desc" }}
        emptyTitle={emptyTitle}
        emptyBody={emptyBody}
        onRowClick={(r) => {
          setSelectedId(r.id);
          setOpen(true);
        }}
        mobileTitle={(r) => r.subject || r.title || r.txnNumber || "—"}
      />

      <TxnDetailDrawer
        txnId={selectedId}
        open={open}
        onClose={() => setOpen(false)}
        username={username}
        showLegacyAction={showLegacyAction}
      />
    </div>
  );
}
