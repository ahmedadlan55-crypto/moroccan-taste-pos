import { useMemo, useState } from "react";
import { ArrowRight, Plus, Copy, Pencil, Trash2, Store } from "lucide-react";
import {
  Button,
  IconButton,
  Dialog,
  ConfirmDialog,
  Input,
  Select,
  CurrencyInput,
  NumberInput,
  Toggle,
  Badge,
  Checkbox,
  EmptyState,
  Spinner,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatNumber } from "@/shared/lib";
import {
  useChannelItems,
  useAvailableItems,
  useAddChannelItems,
  useUpdateChannelItem,
  useDeleteChannelItem,
  useCopyChannelItems,
  useBrands,
  channelError,
  type SalesChannel,
  type ChannelItem,
} from "./api";

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  dine_in: "صالة",
  takeaway: "سفري",
  delivery: "توصيل",
  aggregator: "تطبيق وسيط",
  phone: "هاتف",
  app: "تطبيق",
  online: "متجر إلكتروني",
};

const SOURCE_LABEL: Record<string, string> = {
  override: "سعر خاص",
  priceList: "قائمة أسعار",
  menu: "السعر الأساسي",
};

function Money({ value, tone = "text-slate-800" }: { value: number; tone?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums font-extrabold ${tone}`}>
      {formatNumber(value)}
      <span className="ms-1 text-xs font-bold text-slate-400">ر.س</span>
    </span>
  );
}

export function ChannelItemsView({
  channel,
  allChannels,
  canManage,
  onBack,
}: {
  channel: SalesChannel;
  allChannels: SalesChannel[];
  canManage: boolean;
  onBack: () => void;
}) {
  const itemsQuery = useChannelItems(channel.id);
  const updateItem = useUpdateChannelItem();
  const data = itemsQuery.data;
  const rows = data?.items ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [editRow, setEditRow] = useState<ChannelItem | null>(null);
  const [toRemove, setToRemove] = useState<ChannelItem | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const del = useDeleteChannelItem();

  function toggleAvailability(row: ChannelItem, next: boolean) {
    updateItem.mutate({
      channelId: channel.id,
      menuItemId: row.menuItemId,
      patch: { is_available: next },
    });
  }

  function confirmRemove() {
    if (!toRemove) return;
    setRemoveError(null);
    del.mutate(
      { channelId: channel.id, menuItemId: toRemove.menuItemId },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setRemoveError(channelError(new Error(res.error)));
          setToRemove(null);
        },
        onError: (e) => setRemoveError(channelError(e)),
      },
    );
  }

  const columns: ColumnDef<ChannelItem>[] = [
    { id: "name", header: "الصنف", accessor: (r) => r.itemName, sortable: true },
    {
      id: "category",
      header: "التصنيف",
      accessor: (r) => r.category || "—",
      cell: (r) => (r.category ? <Badge tone="neutral">{r.category}</Badge> : "—"),
    },
    {
      id: "base",
      header: "الأساسي",
      numeric: true,
      accessor: (r) => r.basePrice,
      cell: (r) => <Money value={r.basePrice} tone="text-slate-500" />,
      defaultHidden: true,
    },
    {
      id: "price",
      header: "السعر الفعّال",
      numeric: true,
      accessor: (r) => r.effectivePrice,
      cell: (r) => (
        <div className="flex flex-col items-end gap-0.5">
          <Money value={r.effectivePrice} tone="text-emerald-600" />
          <Badge tone={r.priceSource === "override" ? "teal" : r.priceSource === "priceList" ? "info" : "neutral"}>
            {SOURCE_LABEL[r.priceSource] ?? r.priceSource}
          </Badge>
        </div>
      ),
    },
    {
      id: "limit",
      header: "حد يومي",
      numeric: true,
      accessor: (r) => r.dailyLimit ?? "",
      cell: (r) => (r.dailyLimit != null ? formatNumber(r.dailyLimit) : "—"),
      defaultHidden: true,
    },
    {
      id: "available",
      header: "متاح",
      accessor: (r) => (r.isAvailable ? 1 : 0),
      cell: (r) => (
        <Toggle
          checked={r.isAvailable}
          disabled={!canManage}
          onChange={(next) => toggleAvailability(r, next)}
          aria-label={`إتاحة ${r.itemName}`}
        />
      ),
    },
  ];

  const typeLabel = CHANNEL_TYPE_LABEL[channel.channelType] ?? channel.channelType;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconButton aria-label="رجوع" onClick={onBack}>
            <ArrowRight className="h-5 w-5" />
          </IconButton>
          <div>
            <div className="text-xs font-extrabold text-teal-700">أصناف القناة</div>
            <h1 className="text-xl font-extrabold text-slate-900">{channel.name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] font-bold text-slate-400">
              <span dir="ltr" className="tabular-nums">
                {channel.code}
              </span>
              <span aria-hidden="true">·</span>
              <span>{typeLabel}</span>
              {data?.priceList && (
                <>
                  <span aria-hidden="true">·</span>
                  <Badge tone="info">قائمة أسعار: {data.priceList.name}</Badge>
                </>
              )}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4" /> نسخ من قناة
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> إضافة أصناف
            </Button>
          </div>
        )}
      </div>

      {channel.useFullMenu && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          هذه القناة مضبوطة على «عرض القائمة الكاملة» — يعرض الكاشير كل أصناف المنيو النشطة بغضّ النظر عن القائمة أدناه.
          عطّل هذا الخيار من إعدادات القناة لجعل قائمتها مستقلّة.
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={itemsQuery.isLoading}
        error={itemsQuery.error}
        onRetry={() => itemsQuery.refetch()}
        searchable
        searchPlaceholder="بحث في أصناف القناة…"
        emptyTitle="لا توجد أصناف في هذه القناة"
        emptyBody={canManage ? "أضف أصنافًا أو انسخها من قناة أخرى." : "لم تُضَف أصناف بعد."}
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton aria-label="تعديل" size="sm" onClick={() => setEditRow(r)}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label="إزالة"
                    size="sm"
                    onClick={() => {
                      setRemoveError(null);
                      setToRemove(r);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </IconButton>
                </div>
              )
            : undefined
        }
      />

      {editRow && canManage && (
        <ItemEditDialog channelId={channel.id} row={editRow} onClose={() => setEditRow(null)} />
      )}

      {addOpen && canManage && (
        <AddItemsDialog channel={channel} onClose={() => setAddOpen(false)} />
      )}

      {copyOpen && canManage && (
        <CopyFromDialog
          channel={channel}
          allChannels={allChannels}
          onClose={() => setCopyOpen(false)}
        />
      )}

      <ConfirmDialog
        open={!!toRemove}
        title="إزالة الصنف من القناة"
        description={toRemove ? `سيُزال «${toRemove.itemName}» من قائمة هذه القناة.` : ""}
        tone="danger"
        confirmLabel="إزالة"
        processing={del.isPending}
        error={removeError}
        onConfirm={confirmRemove}
        onClose={() => setToRemove(null)}
      />
    </div>
  );
}

// ── Edit one override row ──────────────────────────────────────────────────────
function ItemEditDialog({
  channelId,
  row,
  onClose,
}: {
  channelId: string;
  row: ChannelItem;
  onClose: () => void;
}) {
  const update = useUpdateChannelItem();
  const [override, setOverride] = useState<number | null>(row.overridePrice);
  const [dailyLimit, setDailyLimit] = useState<number | null>(row.dailyLimit);
  const [sortOrder, setSortOrder] = useState<number | null>(row.sortOrder);
  const [notes, setNotes] = useState(row.notes ?? "");
  const [available, setAvailable] = useState(row.isAvailable);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    update.mutate(
      {
        channelId,
        menuItemId: row.menuItemId,
        patch: {
          override_price: override,
          daily_limit: dailyLimit,
          sort_order: sortOrder ?? 100,
          notes: notes.trim() || null,
          is_available: available,
        },
      },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setError(channelError(new Error(res.error)));
          onClose();
        },
        onError: (e) => setError(channelError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="تعديل الصنف في القناة"
      description={row.itemName}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending}>
            حفظ
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="سعر خاص للقناة" hint="اتركه فارغًا لاستخدام السعر الأساسي.">
            <CurrencyInput value={override} onChange={setOverride} min={0} />
          </Field>
          <Field label="الحد اليومي">
            <NumberInput value={dailyLimit} onChange={setDailyLimit} min={0} step={1} />
          </Field>
          <Field label="ترتيب العرض">
            <NumberInput value={sortOrder} onChange={setSortOrder} min={0} step={1} />
          </Field>
          <Field label="الإتاحة">
            <div className="pt-2">
              <Toggle checked={available} onChange={setAvailable} label={available ? "متاح" : "غير متاح"} />
            </div>
          </Field>
        </div>
        <Field label="ملاحظات">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
          السعر الأساسي: <Money value={row.basePrice} tone="text-slate-700" />
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Add items from the catalog ────────────────────────────────────────────────
function AddItemsDialog({ channel, onClose }: { channel: SalesChannel; onClose: () => void }) {
  const brands = useBrands();
  const [brandId, setBrandId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const available = useAvailableItems(channel.id, brandId || undefined, true);
  const add = useAddChannelItems();

  const filtered = useMemo(() => {
    const list = available.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((i) => `${i.name} ${i.category ?? ""}`.toLowerCase().includes(needle));
  }, [available.data, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (selected.size === 0) return;
    setError(null);
    add.mutate(
      { channelId: channel.id, itemIds: [...selected] },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setError(channelError(new Error(res.error)));
          onClose();
        },
        onError: (e) => setError(channelError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="إضافة أصناف إلى القناة"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={selected.size === 0}>
            إضافة {selected.size > 0 ? `(${formatNumber(selected.size)})` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="العلامة">
            <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={brands.isLoading}>
              <option value="">كل العلامات</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="بحث">
            <Input value={search} placeholder="اسم الصنف…" onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200">
          {available.isLoading ? (
            <div className="grid place-items-center py-12">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Store className="h-6 w-6" />}
              title="لا توجد أصناف متاحة"
              body="كل الأصناف مضافة بالفعل، أو لا توجد أصناف مطابقة."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Checkbox
                    checked={selected.has(i.id)}
                    onChange={() => toggle(i.id)}
                    label={
                      <span className="flex flex-col">
                        <span className="font-bold text-slate-800">{i.name}</span>
                        {i.category && <span className="text-[11px] font-medium text-slate-400">{i.category}</span>}
                      </span>
                    }
                  />
                  <Money value={i.price} tone="text-slate-500" />
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Copy items from another channel ───────────────────────────────────────────
function CopyFromDialog({
  channel,
  allChannels,
  onClose,
}: {
  channel: SalesChannel;
  allChannels: SalesChannel[];
  onClose: () => void;
}) {
  const others = allChannels.filter((c) => c.id !== channel.id);
  const [srcId, setSrcId] = useState(others[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const copy = useCopyChannelItems();

  function submit() {
    if (!srcId) return;
    setError(null);
    copy.mutate(
      { channelId: channel.id, srcChannelId: srcId },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setError(channelError(new Error(res.error)));
          onClose();
        },
        onError: (e) => setError(channelError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="نسخ الأصناف من قناة أخرى"
      description="تُضاف أصناف القناة المصدر غير الموجودة حاليًا (لا تُستبدل الموجودة)."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={copy.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={copy.isPending} disabled={!srcId}>
            نسخ
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="القناة المصدر">
          <Select value={srcId} onChange={(e) => setSrcId(e.target.value)}>
            {others.length === 0 && <option value="">لا توجد قنوات أخرى</option>}
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
