import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, UserCog } from "lucide-react";
import { Button, IconButton, Badge, PageHeader } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { useCan } from "@/app/providers";
import { useT, useLang } from "@/i18n";
import { o2cApi, qk, Money, useDocNav, type Customer } from "@/modules/sales/lib";
import { CustomerForm } from "./CustomerForm";

interface TableState { page: number; pageSize: number; search: string }

export function CustomersList() {
  const t = useT();
  const lang = useLang();
  const { isNew, openDoc, openNew, closeNew } = useDocNav();
  const canEdit = useCan("customers.edit");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [type, setType] = useState("");
  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "" });
  const [editing, setEditing] = useState<Customer | null>(null);

  // Render the customer's name in the active UI language; fall back to the
  // Arabic name when no English name is stored.
  const bizName = useCallback((c: Customer) => (lang === "en" ? c.nameEn || c.name : c.name), [lang]);

  const ACTIVE_OPTIONS = useMemo<{ value: string; label: string }[]>(() => [
    { value: "true", label: t("misc.customers.list.filter.active") },
    { value: "false", label: t("misc.customers.list.filter.inactive") },
    { value: "", label: t("common.all") },
  ], [t]);
  const TYPE_OPTIONS = useMemo<{ value: string; label: string }[]>(() => [
    { value: "", label: t("misc.customers.list.filter.allTypes") },
    { value: "B2C", label: t("misc.customers.types.B2C") },
    { value: "B2B", label: t("misc.customers.types.B2B") },
    { value: "B2G", label: t("misc.customers.types.B2G") },
  ], [t]);

  const params = useMemo(
    () => ({ q: ts.search, active, type, page: ts.page, pageSize: ts.pageSize, sort: "name", dir: "ASC" }),
    [ts, active, type],
  );
  const list = useQuery({ queryKey: qk.customers(params), queryFn: ({ signal }) => o2cApi.customers(params, signal) });

  const onStateChange = useCallback((s: { page: number; pageSize: number; search: string }) => {
    setTs((prev) => (prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search ? prev : { page: s.page, pageSize: s.pageSize, search: s.search }));
  }, []);

  const columns = useMemo<ColumnDef<Customer>[]>(() => [
    {
      id: "name", header: t("misc.customers.list.col.name"), accessor: (c) => c.name,
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className="font-bold text-slate-800">{bizName(c)}</span>
          {!c.isActive && <Badge tone="neutral">{t("status.disabled")}</Badge>}
        </span>
      ),
    },
    { id: "phone", header: t("misc.customers.list.col.phone"), cell: (c) => <span dir="ltr" className="tabular-nums">{c.phone || "—"}</span> },
    { id: "type", header: t("misc.customers.list.col.type"), accessor: (c) => c.customerType },
    { id: "creditLimit", header: t("misc.customers.list.col.creditLimit"), align: "end", cell: (c) => <Money value={c.creditLimit} /> },
    { id: "balance", header: t("misc.customers.list.col.balance"), align: "end", cell: (c) => <Money value={c.derived?.arBalance ?? c.balance} className="font-bold" /> },
  ], [t, bizName]);

  return (
    <div>
      <PageHeader
        eyebrow={t("misc.customers.eyebrow")}
        title={t("misc.customers.list.title")}
        subtitle={t("misc.customers.list.subtitle")}
        action={<Can cap="customers.create"><Button onClick={openNew}><Plus className="h-4 w-4" /> {t("misc.customers.list.newCustomer")}</Button></Can>}
      />
      <DataTable<Customer>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination?.total ?? 0}
        getRowId={(c) => c.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onRowClick={(c) => openDoc(c.id)}
        onStateChange={onStateChange}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("misc.customers.list.searchPlaceholder")}
        columnMenu={false}
        emptyTitle={t("misc.customers.list.emptyTitle")}
        emptyBody={t("misc.customers.list.emptyBody")}
        mobileTitle={(c) => bizName(c)}
        rowActions={(c) =>
          canEdit ? (
            <IconButton aria-label={t("misc.customers.list.editAria")} size="sm" variant="secondary" onClick={() => setEditing(c)}>
              <UserCog className="h-4 w-4" />
            </IconButton>
          ) : null
        }
        filterBar={
          <>
            <label className="flex items-center">
              <span className="sr-only">{t("misc.customers.list.filterByStatus")}</span>
              <select className="field h-10" value={active} onChange={(e) => setActive(e.target.value as "" | "true" | "false")} aria-label={t("misc.customers.list.filterByStatus")}>
                {ACTIVE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex items-center">
              <span className="sr-only">{t("misc.customers.list.filterByType")}</span>
              <select className="field h-10" value={type} onChange={(e) => setType(e.target.value)} aria-label={t("misc.customers.list.filterByType")}>
                {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </>
        }
      />
      {isNew && <CustomerForm open onClose={closeNew} customer={null} />}
      {editing && <CustomerForm open onClose={() => setEditing(null)} customer={editing} />}
    </div>
  );
}
