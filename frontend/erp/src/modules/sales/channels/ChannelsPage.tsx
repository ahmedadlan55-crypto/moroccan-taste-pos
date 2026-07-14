import { useState } from "react";
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

const CHANNEL_TYPES: { value: string; label: string }[] = [
  { value: "dine_in", label: "صالة" },
  { value: "takeaway", label: "سفري" },
  { value: "delivery", label: "توصيل" },
  { value: "aggregator", label: "تطبيق وسيط" },
  { value: "phone", label: "هاتف" },
  { value: "app", label: "تطبيق" },
  { value: "online", label: "متجر إلكتروني" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(CHANNEL_TYPES.map((t) => [t.value, t.label]));

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
  const canManage = useCan("sales.channels.manage");
  const listQuery = useChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const del = useDeleteChannel();
  const toggle = useToggleChannel();

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
      setNameError("اسم القناة مطلوب.");
      return;
    }
    setFormError(null);
    const { id, ...rest } = form;
    const input: ChannelInput = { ...rest, name: form.name.trim() };
    const onSettled = {
      onSuccess: (res: { success: boolean; error?: string }) => {
        if (res && res.success === false) return setFormError(channelError(new Error(res.error)));
        setForm(null);
      },
      onError: (e: unknown) => setFormError(channelError(e)),
    };
    if (id) update.mutate({ id, input }, onSettled);
    else create.mutate(input, onSettled);
  }

  function confirmDelete() {
    if (!toDelete) return;
    setDeleteError(null);
    del.mutate(toDelete.id, {
      onSuccess: (res) => {
        if (res && res.success === false) return setDeleteError(channelError(new Error(res.error)));
        setToDelete(null);
      },
      onError: (e) => setDeleteError(channelError(e)),
    });
  }

  const columns: ColumnDef<SalesChannel>[] = [
    {
      id: "name",
      header: "القناة",
      accessor: (r) => r.name,
      sortable: true,
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-bold text-slate-800">{r.name}</span>
          <span dir="ltr" className="text-[11px] font-medium tabular-nums text-slate-400">
            {r.code}
          </span>
        </div>
      ),
    },
    {
      id: "type",
      header: "النوع",
      accessor: (r) => TYPE_LABEL[r.channelType] ?? r.channelType,
      cell: (r) => <Badge tone="teal">{TYPE_LABEL[r.channelType] ?? r.channelType}</Badge>,
    },
    { id: "priceList", header: "قائمة الأسعار", accessor: (r) => r.priceListName || "—" },
    {
      id: "commission",
      header: "العمولة",
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
      header: "القائمة",
      accessor: (r) => (r.useFullMenu ? "كاملة" : "مستقلّة"),
      cell: (r) => <Badge tone={r.useFullMenu ? "neutral" : "info"}>{r.useFullMenu ? "كاملة" : "مستقلّة"}</Badge>,
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="المبيعات"
        title="قنوات البيع"
        subtitle="إدارة قنوات ومنافذ البيع وأصناف كل قناة (صالة، توصيل، تطبيقات وسيطة)."
        action={
          canManage ? (
            <Button variant="primary" onClick={openNew}>
              <Plus className="h-4 w-4" /> قناة جديدة
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
        searchPlaceholder="بحث عن قناة…"
        emptyTitle="لا توجد قنوات بيع"
        emptyBody="أضف أول قناة بيع للبدء."
        onRowClick={(r) => setManaging(r)}
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="إدارة الأصناف" size="sm" onClick={() => setManaging(r)}>
              <ListChecks className="h-4 w-4" />
            </IconButton>
            {canManage && (
              <>
                <IconButton
                  aria-label={r.isActive ? "تعطيل" : "تفعيل"}
                  size="sm"
                  onClick={() => toggle.mutate(r.id)}
                >
                  <Power className={`h-4 w-4 ${r.isActive ? "text-emerald-600" : "text-slate-400"}`} />
                </IconButton>
                <IconButton aria-label="تعديل" size="sm" onClick={() => openEdit(r)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton
                  aria-label="حذف"
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
        title={isNew ? "قناة جديدة" : "تعديل القناة"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)} disabled={saving}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={submit} loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="اسم القناة" required error={nameError ?? undefined}>
                <Input
                  value={form.name}
                  invalid={!!nameError}
                  onChange={(e) => {
                    setNameError(null);
                    setForm({ ...form, name: e.target.value });
                  }}
                />
              </Field>
              <Field label="الاسم بالإنجليزية">
                <Input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </Field>
              <Field label="الرمز" hint="يُولّد تلقائيًا إن تُرك فارغًا.">
                <Input
                  value={form.code ?? ""}
                  dir="ltr"
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </Field>
              <Field label="النوع">
                <Select
                  value={form.channelType}
                  onChange={(e) => setForm({ ...form, channelType: e.target.value })}
                  options={CHANNEL_TYPES}
                />
              </Field>
              <Field label="قائمة الأسعار">
                <Select
                  value={form.priceListId ?? ""}
                  onChange={(e) => setForm({ ...form, priceListId: e.target.value })}
                  disabled={priceLists.isLoading}
                >
                  <option value="">— بدون قائمة أسعار —</option>
                  {(priceLists.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isActive ? "" : " (غير نشطة)"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="ترتيب العرض">
                <NumberInput
                  value={form.displayOrder ?? 0}
                  onChange={(v) => setForm({ ...form, displayOrder: v ?? 0 })}
                  min={0}
                  step={1}
                />
              </Field>
              <Field label="نسبة العمولة (%)">
                <NumberInput
                  value={form.commissionPct ?? 0}
                  onChange={(v) => setForm({ ...form, commissionPct: v ?? 0 })}
                  min={0}
                />
              </Field>
              <Field label="نسبة رسوم الخدمة (%)">
                <NumberInput
                  value={form.serviceFeePct ?? 0}
                  onChange={(v) => setForm({ ...form, serviceFeePct: v ?? 0 })}
                  min={0}
                />
              </Field>
            </div>

            <Field label="ملاحظات">
              <Input value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>

            <div className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-2">
              <Toggle
                checked={!!form.isActive}
                onChange={(v) => setForm({ ...form, isActive: v })}
                label="نشطة"
              />
              <Toggle
                checked={!!form.useFullMenu}
                onChange={(v) => setForm({ ...form, useFullMenu: v })}
                label="عرض القائمة الكاملة"
              />
              <Toggle
                checked={!!form.allowDiscount}
                onChange={(v) => setForm({ ...form, allowDiscount: v })}
                label="السماح بالخصم"
              />
              <Toggle
                checked={!!form.requiresExternalRef}
                onChange={(v) => setForm({ ...form, requiresExternalRef: v })}
                label="يتطلب مرجعًا خارجيًا"
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
        title="حذف القناة"
        description={toDelete ? `سيتم حذف القناة «${toDelete.name}» نهائيًا.` : ""}
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
