import { useMemo, useState } from "react";
import { Layers, Pencil, History, Tags } from "lucide-react";
import {
  PageHeader,
  Button,
  IconButton,
  Dialog,
  Drawer,
  DetailStat,
  Input,
  Select,
  CurrencyInput,
  NumberInput,
  Badge,
  EmptyState,
  Spinner,
  useToast,
} from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useLang } from "@/i18n";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can, useCan } from "@/shared/permissions";
import { formatNumber, formatDateTime } from "@/shared/lib";
import {
  useMenuItems,
  useUpdatePrice,
  useBulkPriceUpdate,
  usePriceHistory,
  useBrands,
  marginPct,
  pricingError,
  type MenuItem,
  type BulkMode,
} from "./api";

const BULK_MODE_CODES: BulkMode[] = ["percent", "fixed_set", "fixed_add"];

// Money cell — LTR + tabular, matches the rest of the back-office.
function Money({ value, tone = "text-slate-800" }: { value: number; tone?: string }) {
  const t = useTx();
  return (
    <span dir="ltr" className={`tabular-nums font-extrabold ${tone}`}>
      {formatNumber(value)}
      <span className="ms-1 text-xs font-bold text-slate-400">{t("sales.currency")}</span>
    </span>
  );
}

export function PricingPage() {
  return (
    <Can cap="sales.pricing.view" showDenied>
      <PricingScreen />
    </Can>
  );
}

function PricingScreen() {
  const t = useTx();
  const lang = useLang();
  const itemName = (r: MenuItem) => (lang === "en" && r.nameEn ? r.nameEn : r.name);
  const { toast } = useToast();
  const canManage = useCan("sales.pricing.manage");

  const [brandId, setBrandId] = useState("");
  const brands = useBrands();
  const itemsQuery = useMenuItems(brandId || undefined);
  const rows = itemsQuery.data ?? [];

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editItem, setEditItem] = useState<MenuItem | null>(null);
  const [historyItem, setHistoryItem] = useState<MenuItem | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar")),
    [rows],
  );

  const columns: ColumnDef<MenuItem>[] = [
    { id: "name", header: t("sales.pricing.col.item"), accessor: (r) => itemName(r), sortable: true },
    {
      id: "category",
      header: t("sales.pricing.col.category"),
      accessor: (r) => r.category || "—",
      cell: (r) => (r.category ? <Badge tone="neutral">{r.category}</Badge> : "—"),
    },
    { id: "brand", header: t("sales.pricing.col.brand"), accessor: (r) => r.brandName || "—", defaultHidden: true },
    {
      id: "cost",
      header: t("sales.pricing.col.cost"),
      numeric: true,
      accessor: (r) => r.cost,
      cell: (r) => <Money value={r.cost} tone="text-slate-500" />,
    },
    {
      id: "price",
      header: t("sales.pricing.col.price"),
      numeric: true,
      accessor: (r) => r.price,
      sortable: true,
      cell: (r) => <Money value={r.price} tone="text-emerald-600" />,
    },
    {
      id: "margin",
      header: t("sales.pricing.col.margin"),
      numeric: true,
      accessor: (r) => marginPct(r.price, r.cost),
      cell: (r) => {
        const m = marginPct(r.price, r.cost);
        const tone = m <= 0 ? "text-rose-600" : m < 20 ? "text-amber-600" : "text-slate-700";
        return (
          <span dir="ltr" className={`tabular-nums font-bold ${tone}`}>
            {formatNumber(m)}%
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("sales.salesEyebrow")}
        title={t("sales.pricing.title")}
        subtitle={t("sales.pricing.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setBulkOpen(true)}>
              <Layers className="h-4 w-4" /> {t("sales.pricing.bulkUpdate")}
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={itemsQuery.isLoading}
        error={itemsQuery.error}
        onRetry={() => itemsQuery.refetch()}
        searchable
        searchPlaceholder={t("sales.pricing.searchPlaceholder")}
        selectable={canManage}
        onSelectionChange={setSelectedIds}
        exportFilename="menu-prices.csv"
        emptyTitle={t("sales.pricing.emptyTitle")}
        emptyBody={t("sales.pricing.emptyBody")}
        filterBar={
          <label className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">{t("sales.pricing.brand")}</span>
            <Select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              disabled={brands.isLoading}
              className="min-w-40"
            >
              <option value="">{t("sales.allBrands")}</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </label>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("sales.pricing.priceHistory")} size="sm" onClick={() => setHistoryItem(r)}>
              <History className="h-4 w-4" />
            </IconButton>
            {canManage && (
              <IconButton aria-label={t("sales.pricing.editPrice")} size="sm" onClick={() => setEditItem(r)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        )}
      />

      {editItem && canManage && (
        <PriceEditDialog
          item={editItem}
          onClose={() => setEditItem(null)}
          onDone={(msg) => {
            toast({ title: msg, tone: "success" });
            setEditItem(null);
          }}
        />
      )}

      {bulkOpen && canManage && (
        <BulkPriceDialog
          brandId={brandId}
          brandName={(brands.data ?? []).find((b) => b.id === brandId)?.name}
          categories={categories}
          selectedIds={selectedIds}
          onClose={() => setBulkOpen(false)}
          onDone={(affected) => {
            toast({ title: t("sales.pricing.bulkUpdated", { count: formatNumber(affected) }), tone: "success" });
            setBulkOpen(false);
          }}
        />
      )}

      <PriceHistoryDrawer item={historyItem} onClose={() => setHistoryItem(null)} />
    </div>
  );
}

// ── Single price edit ─────────────────────────────────────────────────────────
function PriceEditDialog({
  item,
  onClose,
  onDone,
}: {
  item: MenuItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTx();
  const lang = useLang();
  const displayName = lang === "en" && item.nameEn ? item.nameEn : item.name;
  const update = useUpdatePrice();
  const [price, setPrice] = useState<number | null>(item.price);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const priceOk = price != null && price >= 0;
  const reasonOk = reason.trim().length >= 3;
  const newMargin = price != null ? marginPct(price, item.cost) : 0;

  function submit() {
    if (!priceOk || !reasonOk) return;
    setError(null);
    update.mutate(
      { id: item.id, price: price as number, reason: reason.trim() },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setError(pricingError(new Error(res.error), t));
          onDone(res?.noop ? t("sales.pricing.noChange") : t("sales.pricing.priceUpdated"));
        },
        onError: (e) => setError(pricingError(e, t)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sales.pricing.editTitle")}
      description={displayName}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending} disabled={!priceOk || !reasonOk}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <DetailStat label={t("sales.pricing.currentPrice")} value={<Money value={item.price} />} />
          <DetailStat label={t("sales.pricing.col.cost")} value={<Money value={item.cost} tone="text-slate-500" />} />
          <DetailStat
            label={t("sales.pricing.newMargin")}
            value={
              <span dir="ltr" className="tabular-nums">
                {formatNumber(newMargin)}%
              </span>
            }
          />
        </div>

        <Field label={t("sales.pricing.newPrice")} required>
          <CurrencyInput value={price} onChange={setPrice} invalid={!priceOk} min={0} />
        </Field>
        <Field label={t("sales.pricing.reason")} required error={reason.length > 0 && !reasonOk ? t("sales.pricing.reasonMin") : undefined}>
          <Input
            value={reason}
            invalid={reason.length > 0 && !reasonOk}
            placeholder={t("sales.pricing.reasonPlaceholder")}
            onChange={(e) => setReason(e.target.value)}
          />
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

// ── Bulk price update ─────────────────────────────────────────────────────────
function BulkPriceDialog({
  brandId,
  brandName,
  categories,
  selectedIds,
  onClose,
  onDone,
}: {
  brandId: string;
  brandName?: string;
  categories: string[];
  selectedIds: string[];
  onClose: () => void;
  onDone: (affected: number) => void;
}) {
  const t = useTx();
  const bulk = useBulkPriceUpdate();
  const useSelection = selectedIds.length > 0;

  const [mode, setMode] = useState<BulkMode>("percent");
  const [value, setValue] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Scope is valid when we target explicit rows, a brand, or a category.
  const scopeValid = useSelection || !!brandId || !!categoryFilter;
  const valueOk = value != null && !Number.isNaN(value);

  function submit() {
    if (!scopeValid || !valueOk) return;
    setError(null);
    bulk.mutate(
      {
        itemIds: useSelection ? selectedIds : undefined,
        brandId: useSelection ? undefined : brandId || undefined,
        categoryFilter: useSelection ? undefined : categoryFilter || undefined,
        mode,
        value: value as number,
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          if (res && res.success === false) return setError(pricingError(new Error(res.error), t));
          onDone(res?.affected ?? 0);
        },
        onError: (e) => setError(pricingError(e, t)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sales.pricing.bulkTitle")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={bulk.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={bulk.isPending} disabled={!scopeValid || !valueOk}>
            {t("common.apply")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Scope */}
        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3 text-xs font-bold text-teal-800">
          {useSelection ? (
            <>{t("sales.pricing.scopeSelected", { count: formatNumber(selectedIds.length) })}</>
          ) : (
            <>
              {t("sales.pricing.scopePrefix")}{" "}
              {brandId ? t("sales.pricing.scopeBrand", { brand: brandName ?? brandId }) : t("sales.allBrands")}
              {categoryFilter ? t("sales.pricing.scopeCategory", { cat: categoryFilter }) : ""}.
            </>
          )}
        </div>

        {!useSelection && (
          <Field label={t("sales.pricing.categoryOptional")}>
            <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">{t("sales.pricing.allCategories")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {!scopeValid && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            {t("sales.pricing.scopeRequired")}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("sales.pricing.changeType")}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as BulkMode)}>
              {BULK_MODE_CODES.map((m) => (
                <option key={m} value={m}>
                  {t(`sales.pricing.bulkMode.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={mode === "percent" ? t("sales.pricing.percentLabel") : t("sales.pricing.valueLabel")} required>
            <NumberInput value={value} onChange={setValue} invalid={value != null && !valueOk} />
          </Field>
        </div>

        <Field label={t("sales.pricing.reasonOptional")}>
          <Input value={reason} placeholder={t("sales.pricing.bulkReasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
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

// ── Price history ─────────────────────────────────────────────────────────────
function PriceHistoryDrawer({ item, onClose }: { item: MenuItem | null; onClose: () => void }) {
  const t = useTx();
  const lang = useLang();
  const history = usePriceHistory(item?.id ?? null);
  const entries = history.data ?? [];
  const displayName = item ? (lang === "en" && item.nameEn ? item.nameEn : item.name) : "";

  return (
    <Drawer open={!!item} onClose={onClose} title={displayName} eyebrow={t("sales.pricing.historyEyebrow")} icon={Tags}>
      {history.isLoading ? (
        <div className="grid place-items-center py-12">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title={t("sales.pricing.historyEmptyTitle")} body={t("sales.pricing.historyEmptyBody")} />
      ) : (
        <ol className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span dir="ltr" className="tabular-nums text-sm font-extrabold text-slate-800">
                  {formatNumber(e.oldPrice)} ← {formatNumber(e.newPrice)} {t("sales.currency")}
                </span>
                <span dir="ltr" className="text-[11px] font-medium tabular-nums text-slate-400">
                  {formatDateTime(e.at)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-medium text-slate-500">
                <span>{e.user || "—"}</span>
                {e.reason ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-slate-600">{e.reason}</span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}
