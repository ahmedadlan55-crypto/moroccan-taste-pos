import { useMemo, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, UserCog } from "lucide-react";
import { Button, IconButton, Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useSuppliers, type ListParams } from "@/modules/inventory/lib/hooks/useProcurement";
import type { Supplier } from "@/modules/inventory/lib/adapters/procurement.adapter";
import { SupplierForm } from "./SupplierForm";

interface TableState { page: number; pageSize: number; search: string }

export function SuppliersList() {
  const t = useT();
  const lang = useLang();
  const [, setSearchParams] = useSearchParams();
  const canManage = useCan("procurement.manage");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });
  const [drawerId, setDrawerId] = useState<string | null | undefined>(undefined);

  const params = useMemo<ListParams>(() => ({ q: ts.search, page: ts.page, pageSize: ts.pageSize, sort: "name", dir: "ASC" }), [ts]);
  const list = useSuppliers(params);

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const openDetail = useCallback(
    (id: string) => setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set("doc", id); return n; }),
    [setSearchParams],
  );

  const columns = useMemo<ColumnDef<Supplier>[]>(() => [
    {
      id: "name", header: t("purchasing.col.supplier"), accessor: (s) => s.name,
      cell: (s) => (
        <span className="flex items-center gap-2">
          <span className="font-bold text-slate-800">{lang === "en" && s.nameEn ? s.nameEn : s.name}</span>
          {!s.isActive && <Badge tone="neutral">{t("status.disabled")}</Badge>}
        </span>
      ),
    },
    { id: "vatNumber", header: t("purchasing.suppliers.field.vatNumber"), cell: (s) => <span dir="ltr" className="tabular-nums">{s.vatNumber || "—"}</span> },
    { id: "city", header: t("purchasing.suppliers.field.city"), accessor: (s) => s.city || "—" },
    { id: "paymentTerms", header: t("purchasing.suppliers.field.paymentTerms"), accessor: (s) => s.paymentTerms },
    { id: "apBalance", header: t("purchasing.suppliers.field.apBalance"), align: "end", cell: (s) => <span className="font-bold tabular-nums">{formatCurrency(s.apBalance)}</span> },
  ], [t, lang]);

  return (
    <div>
      <PageHeader
        eyebrow={t("purchasing.tabs.suppliers")}
        title={t("purchasing.suppliers.list.title")}
        subtitle={t("purchasing.suppliers.list.subtitle")}
        action={canManage ? <Button onClick={() => setDrawerId(null)}><Plus className="h-4 w-4" /> {t("purchasing.suppliers.newSupplier")}</Button> : null}
      />
      <DataTable<Supplier>
        mode="server"
        columns={columns}
        rows={list.data?.rows ?? []}
        rowCount={list.data?.total ?? 0}
        getRowId={(s) => s.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(s) => openDetail(s.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("purchasing.suppliers.list.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("purchasing.suppliers.list.emptyTitle")}
        emptyBody={t("purchasing.suppliers.list.emptyBody")}
        mobileTitle={(s) => (lang === "en" && s.nameEn ? s.nameEn : s.name)}
        rowActions={(s) =>
          canManage ? (
            <IconButton aria-label={t("purchasing.suppliers.editSupplierAria")} size="sm" variant="secondary" onClick={() => setDrawerId(s.id)}>
              <UserCog className="h-4 w-4" />
            </IconButton>
          ) : null
        }
      />
      {drawerId !== undefined && (
        <SupplierForm open onClose={() => setDrawerId(undefined)} supplierId={drawerId} />
      )}
    </div>
  );
}
