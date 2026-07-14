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

// Money cell — LTR + tabular, matches the rest of the back-office.
function Money({ value, tone = "text-slate-800" }: { value: number; tone?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums font-extrabold ${tone}`}>
      {formatNumber(value)}
      <span className="ms-1 text-xs font-bold text-slate-400">ر.س</span>
    </span>
  );
}

const BULK_MODE_LABEL: Record<BulkMode, string> = {
  percent: "نسبة مئوية (%)",
  fixed_set: "تعيين سعر ثابت",
  fixed_add: "إضافة مبلغ ثابت",
};

export function PricingPage() {
  return (
    <Can cap="sales.pricing.view" showDenied>
      <PricingScreen />
    </Can>
  );
}

function PricingScreen() {
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
    { id: "name", header: "الصنف", accessor: (r) => r.name, sortable: true },
    {
      id: "category",
      header: "التصنيف",
      accessor: (r) => r.category || "—",
      cell: (r) => (r.category ? <Badge tone="neutral">{r.category}</Badge> : "—"),
    },
    { id: "brand", header: "العلامة", accessor: (r) => r.brandName || "—", defaultHidden: true },
    {
      id: "cost",
      header: "التكلفة",
      numeric: true,
      accessor: (r) => r.cost,
      cell: (r) => <Money value={r.cost} tone="text-slate-500" />,
    },
    {
      id: "price",
      header: "السعر",
      numeric: true,
      accessor: (r) => r.price,
      sortable: true,
      cell: (r) => <Money value={r.price} tone="text-emerald-600" />,
    },
    {
      id: "margin",
      header: "الهامش",
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
        eyebrow="المبيعات"
        title="قوائم الأسعار"
        subtitle="تحرير أسعار الأصناف، التحديث الجماعي حسب العلامة/التصنيف، وسجل تغيّر السعر."
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setBulkOpen(true)}>
              <Layers className="h-4 w-4" /> تحديث جماعي
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
        searchPlaceholder="بحث عن صنف…"
        selectable={canManage}
        onSelectionChange={setSelectedIds}
        exportFilename="menu-prices.csv"
        emptyTitle="لا توجد أصناف"
        emptyBody="اختر علامة أخرى أو أضف أصنافًا من قسم المنيو."
        filterBar={
          <label className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">العلامة</span>
            <Select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              disabled={brands.isLoading}
              className="min-w-40"
            >
              <option value="">كل العلامات</option>
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
            <IconButton aria-label="سجل السعر" size="sm" onClick={() => setHistoryItem(r)}>
              <History className="h-4 w-4" />
            </IconButton>
            {canManage && (
              <IconButton aria-label="تعديل السعر" size="sm" onClick={() => setEditItem(r)}>
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
            toast({ title: `تم تحديث ${formatNumber(affected)} صنف`, tone: "success" });
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
          if (res && res.success === false) return setError(pricingError(new Error(res.error)));
          onDone(res?.noop ? "لا تغيير على السعر" : "تم تحديث السعر");
        },
        onError: (e) => setError(pricingError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="تعديل السعر"
      description={item.name}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending} disabled={!priceOk || !reasonOk}>
            حفظ
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <DetailStat label="السعر الحالي" value={<Money value={item.price} />} />
          <DetailStat label="التكلفة" value={<Money value={item.cost} tone="text-slate-500" />} />
          <DetailStat
            label="الهامش الجديد"
            value={
              <span dir="ltr" className="tabular-nums">
                {formatNumber(newMargin)}%
              </span>
            }
          />
        </div>

        <Field label="السعر الجديد" required>
          <CurrencyInput value={price} onChange={setPrice} invalid={!priceOk} min={0} />
        </Field>
        <Field label="سبب التغيير" required error={reason.length > 0 && !reasonOk ? "3 أحرف على الأقل." : undefined}>
          <Input
            value={reason}
            invalid={reason.length > 0 && !reasonOk}
            placeholder="مثال: مواءمة أسعار المنافسين"
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
          if (res && res.success === false) return setError(pricingError(new Error(res.error)));
          onDone(res?.affected ?? 0);
        },
        onError: (e) => setError(pricingError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="تحديث جماعي للأسعار"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={bulk.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={bulk.isPending} disabled={!scopeValid || !valueOk}>
            تطبيق
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Scope */}
        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3 text-xs font-bold text-teal-800">
          {useSelection ? (
            <>سيُطبّق على {formatNumber(selectedIds.length)} صنف محدَّد.</>
          ) : (
            <>
              النطاق:{" "}
              {brandId ? `علامة «${brandName ?? brandId}»` : "كل العلامات"}
              {categoryFilter ? ` — تصنيف «${categoryFilter}»` : ""}.
            </>
          )}
        </div>

        {!useSelection && (
          <Field label="التصنيف (اختياري)">
            <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">كل التصنيفات</option>
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
            حدّد أصنافًا من الجدول، أو اختر علامة/تصنيفًا. لا يُسمح بتطبيق التغيير على كل المنيو دون نطاق.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نوع التغيير">
            <Select value={mode} onChange={(e) => setMode(e.target.value as BulkMode)}>
              {(Object.keys(BULK_MODE_LABEL) as BulkMode[]).map((m) => (
                <option key={m} value={m}>
                  {BULK_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={mode === "percent" ? "النسبة (%)" : "القيمة (ر.س)"} required>
            <NumberInput value={value} onChange={setValue} invalid={value != null && !valueOk} />
          </Field>
        </div>

        <Field label="السبب (اختياري)">
          <Input value={reason} placeholder="سبب التحديث الجماعي" onChange={(e) => setReason(e.target.value)} />
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
  const history = usePriceHistory(item?.id ?? null);
  const entries = history.data ?? [];

  return (
    <Drawer open={!!item} onClose={onClose} title={item?.name ?? ""} eyebrow="سجل تغيّر السعر" icon={Tags}>
      {history.isLoading ? (
        <div className="grid place-items-center py-12">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="لا يوجد سجل بعد" body="لم يُسجَّل أي تغيير على سعر هذا الصنف." />
      ) : (
        <ol className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span dir="ltr" className="tabular-nums text-sm font-extrabold text-slate-800">
                  {formatNumber(e.oldPrice)} ← {formatNumber(e.newPrice)} ر.س
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
