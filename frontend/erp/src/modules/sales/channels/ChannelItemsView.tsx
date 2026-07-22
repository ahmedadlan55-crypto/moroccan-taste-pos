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
import { useTx } from "@/shared/ui/i18n";
import { useLang } from "@/i18n";
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

const CHANNEL_TYPE_CODES = new Set(["dine_in", "takeaway", "delivery", "aggregator", "phone", "app", "online"]);
const SOURCE_CODES = new Set(["override", "priceList", "menu"]);

function Money({ value, tone = "text-slate-800" }: { value: number; tone?: string }) {
  const t = useTx();
  return (
    <span dir="ltr" className={`tabular-nums font-extrabold ${tone}`}>
      {formatNumber(value)}
      <span className="ms-1 text-xs font-bold text-slate-400">{t("sales.currency")}</span>
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
  const t = useTx();
  const lang = useLang();
  const channelName = lang === "en" && channel.nameEn ? channel.nameEn : channel.name;
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
          if (res && res.success === false) return setRemoveError(channelError(new Error(res.error), t));
          setToRemove(null);
        },
        onError: (e) => setRemoveError(channelError(e, t)),
      },
    );
  }

  const columns: ColumnDef<ChannelItem>[] = [
    { id: "name", header: t("sales.channels.itemCol.name"), accessor: (r) => r.itemName, sortable: true },
    {
      id: "category",
      header: t("sales.channels.itemCol.category"),
      accessor: (r) => r.category || "—",
      cell: (r) => (r.category ? <Badge tone="neutral">{r.category}</Badge> : "—"),
    },
    {
      id: "base",
      header: t("sales.channels.itemCol.base"),
      numeric: true,
      accessor: (r) => r.basePrice,
      cell: (r) => <Money value={r.basePrice} tone="text-slate-500" />,
      defaultHidden: true,
    },
    {
      id: "price",
      header: t("sales.channels.itemCol.effectivePrice"),
      numeric: true,
      accessor: (r) => r.effectivePrice,
      cell: (r) => (
        <div className="flex flex-col items-end gap-0.5">
          <Money value={r.effectivePrice} tone="text-emerald-600" />
          <Badge tone={r.priceSource === "override" ? "teal" : r.priceSource === "priceList" ? "info" : "neutral"}>
            {SOURCE_CODES.has(r.priceSource) ? t(`sales.channels.source.${r.priceSource}`) : r.priceSource}
          </Badge>
        </div>
      ),
    },
    {
      id: "limit",
      header: t("sales.channels.itemCol.dailyLimit"),
      numeric: true,
      accessor: (r) => r.dailyLimit ?? "",
      cell: (r) => (r.dailyLimit != null ? formatNumber(r.dailyLimit) : "—"),
      defaultHidden: true,
    },
    {
      id: "available",
      header: t("sales.channels.itemCol.available"),
      accessor: (r) => (r.isAvailable ? 1 : 0),
      cell: (r) => (
        <Toggle
          checked={r.isAvailable}
          disabled={!canManage}
          onChange={(next) => toggleAvailability(r, next)}
          aria-label={t("sales.channels.items.availabilityAria", { name: r.itemName })}
        />
      ),
    },
  ];

  const typeLabel = CHANNEL_TYPE_CODES.has(channel.channelType) ? t(`sales.channels.type.${channel.channelType}`) : channel.channelType;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconButton aria-label={t("common.back")} onClick={onBack}>
            <ArrowRight className="h-5 w-5" />
          </IconButton>
          <div>
            <div className="text-xs font-extrabold text-teal-700">{t("sales.channels.items.eyebrow")}</div>
            <h1 className="text-xl font-extrabold text-slate-900">{channelName}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] font-bold text-slate-400">
              <span dir="ltr" className="tabular-nums">
                {channel.code}
              </span>
              <span aria-hidden="true">·</span>
              <span>{typeLabel}</span>
              {data?.priceList && (
                <>
                  <span aria-hidden="true">·</span>
                  <Badge tone="info">{t("sales.channels.items.priceList", { name: data.priceList.name })}</Badge>
                </>
              )}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4" /> {t("sales.channels.items.copyFrom")}
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> {t("sales.channels.items.addItems")}
            </Button>
          </div>
        )}
      </div>

      {channel.useFullMenu && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          {t("sales.channels.items.fullMenuWarning")}
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
        searchPlaceholder={t("sales.channels.items.searchPlaceholder")}
        emptyTitle={t("sales.channels.items.emptyTitle")}
        emptyBody={canManage ? t("sales.channels.items.emptyBodyManage") : t("sales.channels.items.emptyBodyView")}
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton aria-label={t("common.edit")} size="sm" onClick={() => setEditRow(r)}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={t("sales.channels.items.remove")}
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
        title={t("sales.channels.items.removeTitle")}
        description={toRemove ? t("sales.channels.items.removeBody", { name: toRemove.itemName }) : ""}
        tone="danger"
        confirmLabel={t("sales.channels.items.remove")}
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
  const t = useTx();
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
          if (res && res.success === false) return setError(channelError(new Error(res.error), t));
          onClose();
        },
        onError: (e) => setError(channelError(e, t)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sales.channels.itemEdit.title")}
      description={row.itemName}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("sales.channels.itemEdit.overridePrice")} hint={t("sales.channels.itemEdit.overrideHint")}>
            <CurrencyInput value={override} onChange={setOverride} min={0} />
          </Field>
          <Field label={t("sales.channels.itemEdit.dailyLimit")}>
            <NumberInput value={dailyLimit} onChange={setDailyLimit} min={0} step={1} />
          </Field>
          <Field label={t("sales.channels.field.displayOrder")}>
            <NumberInput value={sortOrder} onChange={setSortOrder} min={0} step={1} />
          </Field>
          <Field label={t("sales.channels.itemEdit.availability")}>
            <div className="pt-2">
              <Toggle checked={available} onChange={setAvailable} label={available ? t("sales.channels.itemEdit.available") : t("sales.channels.itemEdit.unavailable")} />
            </div>
          </Field>
        </div>
        <Field label={t("sales.channels.field.notes")}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
          {t("sales.channels.itemEdit.basePrice")}: <Money value={row.basePrice} tone="text-slate-700" />
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
  const t = useTx();
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
          if (res && res.success === false) return setError(channelError(new Error(res.error), t));
          onClose();
        },
        onError: (e) => setError(channelError(e, t)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sales.channels.addItems.title")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={selected.size === 0}>
            {t("common.add")} {selected.size > 0 ? `(${formatNumber(selected.size)})` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("sales.channels.addItems.brand")}>
            <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={brands.isLoading}>
              <option value="">{t("sales.allBrands")}</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.search")}>
            <Input value={search} placeholder={t("sales.channels.addItems.searchPlaceholder")} onChange={(e) => setSearch(e.target.value)} />
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
              title={t("sales.channels.addItems.emptyTitle")}
              body={t("sales.channels.addItems.emptyBody")}
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
  const t = useTx();
  const lang = useLang();
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
          if (res && res.success === false) return setError(channelError(new Error(res.error), t));
          onClose();
        },
        onError: (e) => setError(channelError(e, t)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sales.channels.copyFrom.title")}
      description={t("sales.channels.copyFrom.desc")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={copy.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={copy.isPending} disabled={!srcId}>
            {t("sales.channels.copyFrom.copyBtn")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t("sales.channels.copyFrom.source")}>
          <Select value={srcId} onChange={(e) => setSrcId(e.target.value)}>
            {others.length === 0 && <option value="">{t("sales.channels.copyFrom.noOthers")}</option>}
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {lang === "en" && c.nameEn ? c.nameEn : c.name} ({c.code})
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
