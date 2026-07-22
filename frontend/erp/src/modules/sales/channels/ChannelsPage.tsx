import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, ListChecks, Power } from "lucide-react";
import {
  PageHeader,
  Button,
  IconButton,
  Dialog,
  ConfirmDialog,
  Input,
  Select,
  NumberInput,
  Toggle,
  Badge,
  StatusBadge,
} from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useLang } from "@/i18n";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can, useCan } from "@/shared/permissions";
import { formatNumber } from "@/shared/lib";
import { ChannelItemsView } from "./ChannelItemsView";
import {
  useChannels,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
  useToggleChannel,
  usePriceLists,
  channelError,
  type SalesChannel,
  type ChannelInput,
} from "./api";

const CHANNEL_TYPE_CODES = ["dine_in", "takeaway", "delivery", "aggregator", "phone", "app", "online"] as const;

interface FormState extends ChannelInput {
  id?: string;
}
const EMPTY: FormState = {
  name: "",
  nameEn: "",
  code: "",
  channelType: "dine_in",
  priceListId: "",
  commissionPct: 0,
  serviceFeePct: 0,
  requiresExternalRef: false,
  allowDiscount: true,
  isActive: true,
  useFullMenu: false,
  displayOrder: 0,
  notes: "",
};

export function ChannelsPage() {
  return (
    <Can cap="sales.channels.view" showDenied>
      <ChannelsScreen />
    </Can>
  );
}

function ChannelsScreen() {
  const t = useTx();
  const lang = useLang();
  const canManage = useCan("sales.channels.manage");
  const listQuery = useChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const del = useDeleteChannel();
  const toggle = useToggleChannel();

  const channelTypes = useMemo(
    () => CHANNEL_TYPE_CODES.map((code) => ({ value: code, label: t(`sales.channels.type.${code}`) })),
    [t],
  );
  const typeLabel = (code: string) => (CHANNEL_TYPE_CODES as readonly string[]).includes(code) ? t(`sales.channels.type.${code}`) : code;
  // Business data: render the English channel name when the UI is English and one exists.
  const channelName = (c: SalesChannel) => (lang === "en" && c.nameEn ? c.nameEn : c.name);

  const rows = listQuery.data ?? [];

  const [managing, setManaging] = useState<SalesChannel | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<SalesChannel | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const priceLists = usePriceLists();
  const isNew = !form?.id;
  const saving = create.isPending || update.isPending;

  // Keep the "manage items" detail in sync with fresh list data.
  const managingChannel = managing ? (rows.find((c) => c.id === managing.id) ?? managing) : null;
  if (managingChannel) {
    return (
      <ChannelItemsView
        channel={managingChannel}
        allChannels={rows}
        canManage={canManage}
        onBack={() => setManaging(null)}
      />
    );
  }

  function openNew() {
    setNameError(null);
    setFormError(null);
    setForm({ ...EMPTY });
  }
  function openEdit(c: SalesChannel) {
    setNameError(null);
    setFormError(null);
    setForm({
      id: c.id,
      name: c.name,
      nameEn: c.nameEn ?? "",
      code: c.code ?? "",
      channelType: c.channelType ?? "dine_in",
      priceListId: c.priceListId ?? "",
      commissionPct: c.commissionPct ?? 0,
      serviceFeePct: c.serviceFeePct ?? 0,
      requiresExternalRef: c.requiresExternalRef,
      allowDiscount: c.allowDiscount,
      isActive: c.isActive,
      useFullMenu: c.useFullMenu,
      displayOrder: c.displayOrder ?? 0,
      notes: c.notes ?? "",
    });
  }

  function submit() {
    if (!form) return;
    if (!form.name?.trim()) {
      setNameError(t("sales.channels.nameRequired"));
      return;
    }
    setFormError(null);
    const { id, ...rest } = form;
    const input: ChannelInput = { ...rest, name: form.name.trim() };
    const onSettled = {
      onSuccess: (res: { success: boolean; error?: string }) => {
        if (res && res.success === false) return setFormError(channelError(new Error(res.error), t));
        setForm(null);
      },
      onError: (e: unknown) => setFormError(channelError(e, t)),
    };
    if (id) update.mutate({ id, input }, onSettled);
    else create.mutate(input, onSettled);
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) return setDeleteError(channelError(new Error(res.error), t));
        setToDelete(null);
      },
      onError: (e) => setDeleteError(channelError(e, t)),
    });
  }

  const columns: ColumnDef<SalesChannel>[] = [
    {
      id: "name",
      header: t("sales.channels.col.channel"),
      accessor: (r) => channelName(r),
      sortable: true,
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-bold text-slate-800">{channelName(r)}</span>
          <span dir="ltr" className="text-[11px] font-medium tabular-nums text-slate-400">
            {r.code}
          </span>
        </div>
      ),
    },
    {
      id: "type",
      header: t("sales.channels.col.type"),
      accessor: (r) => typeLabel(r.channelType),
      cell: (r) => <Badge tone="teal">{typeLabel(r.channelType)}</Badge>,
    },
    { id: "priceList", header: t("sales.channels.col.priceList"), accessor: (r) => r.priceListName || "—" },
    {
      id: "commission",
      header: t("sales.channels.col.commission"),
      numeric: true,
      accessor: (r) => r.commissionPct,
      cell: (r) => (
        <span dir="ltr" className="tabular-nums">
          {formatNumber(r.commissionPct)}%
        </span>
      ),
      defaultHidden: true,
    },
    {
      id: "fullMenu",
      header: t("sales.channels.col.menu"),
      accessor: (r) => (r.useFullMenu ? t("sales.channels.fullMenu") : t("sales.channels.independent")),
      cell: (r) => <Badge tone={r.useFullMenu ? "neutral" : "info"}>{r.useFullMenu ? t("sales.channels.fullMenu") : t("sales.channels.independent")}</Badge>,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => (r.isActive ? t("common.active") : t("status.disabled")),
      cell: (r) => <StatusBadge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? t("common.active") : t("status.disabled")}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.salesEyebrow")}
        title={t("sales.channels.title")}
        subtitle={t("sales.channels.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={openNew}>
              <Plus className="h-4 w-4" /> {t("sales.channels.newBtn")}
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={listQuery.isLoading}
        error={listQuery.error}
        onRetry={() => listQuery.refetch()}
        searchable
        searchPlaceholder={t("sales.channels.searchPlaceholder")}
        emptyTitle={t("sales.channels.emptyTitle")}
        emptyBody={t("sales.channels.emptyBody")}
        onRowClick={(r) => setManaging(r)}
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("sales.channels.manageItems")} size="sm" onClick={() => setManaging(r)}>
              <ListChecks className="h-4 w-4" />
            </IconButton>
            {canManage && (
              <>
                <IconButton
                  aria-label={r.isActive ? t("sales.channels.deactivate") : t("sales.channels.activate")}
                  size="sm"
                  onClick={() => toggle.mutate(r.id)}
                >
                  <Power className={`h-4 w-4 ${r.isActive ? "text-emerald-600" : "text-slate-400"}`} />
                </IconButton>
                <IconButton aria-label={t("common.edit")} size="sm" onClick={() => openEdit(r)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton
                  aria-label={t("common.delete")}
                  size="sm"
                  onClick={() => {
                    setDeleteError(null);
                    setToDelete(r);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-rose-600" />
                </IconButton>
              </>
            )}
          </div>
        )}
      />

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={isNew ? t("sales.channels.newBtn") : t("sales.channels.editTitle")}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={submit} loading={saving}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("sales.channels.field.name")} required error={nameError ?? undefined}>
                <Input
                  value={form.name}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setForm({ ...form, name: e.target.value });
                  }}
                />
              </Field>
              <Field label={t("sales.channels.field.nameEn")}>
                <Input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </Field>
              <Field label={t("sales.channels.field.code")} hint={t("sales.channels.field.codeHint")}>
                <Input
                  value={form.code ?? ""}
                  dir="ltr"
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </Field>
              <Field label={t("sales.channels.field.type")}>
                <Select
                  value={form.channelType}
                  onChange={(e) => setForm({ ...form, channelType: e.target.value })}
                  options={channelTypes}
                />
              </Field>
              <Field label={t("sales.channels.field.priceList")}>
                <Select
                  value={form.priceListId ?? ""}
                  onChange={(e) => setForm({ ...form, priceListId: e.target.value })}
                  disabled={priceLists.isLoading}
                >
                  <option value="">{t("sales.channels.noPriceList")}</option>
                  {(priceLists.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isActive ? "" : ` ${t("sales.channels.inactiveSuffix")}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("sales.channels.field.displayOrder")}>
                <NumberInput
                  value={form.displayOrder ?? 0}
                  onChange={(v) => setForm({ ...form, displayOrder: v ?? 0 })}
                  min={0}
                  step={1}
                />
              </Field>
              <Field label={t("sales.channels.field.commission")}>
                <NumberInput
                  value={form.commissionPct ?? 0}
                  onChange={(v) => setForm({ ...form, commissionPct: v ?? 0 })}
                  min={0}
                />
              </Field>
              <Field label={t("sales.channels.field.serviceFee")}>
                <NumberInput
                  value={form.serviceFeePct ?? 0}
                  onChange={(v) => setForm({ ...form, serviceFeePct: v ?? 0 })}
                  min={0}
                />
              </Field>
            </div>

            <Field label={t("sales.channels.field.notes")}>
              <Input value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>

            <div className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-2">
              <Toggle
                checked={!!form.isActive}
                onChange={(v) => setForm({ ...form, isActive: v })}
                label={t("sales.channels.toggle.active")}
              />
              <Toggle
                checked={!!form.useFullMenu}
                onChange={(v) => setForm({ ...form, useFullMenu: v })}
                label={t("sales.channels.toggle.fullMenu")}
              />
              <Toggle
                checked={!!form.allowDiscount}
                onChange={(v) => setForm({ ...form, allowDiscount: v })}
                label={t("sales.channels.toggle.allowDiscount")}
              />
              <Toggle
                checked={!!form.requiresExternalRef}
                onChange={(v) => setForm({ ...form, requiresExternalRef: v })}
                label={t("sales.channels.toggle.requiresExternalRef")}
              />
            </div>

            {formError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                {formError}
              </div>
            )}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        title={t("sales.channels.deleteTitle")}
        description={toDelete ? t("sales.channels.deleteBody", { name: channelName(toDelete) }) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
