import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Plus, Pencil, Trash2, Tag, History } from "lucide-react";
import {
  PageHeader,
  Button,
  IconButton,
  Input,
  Select,
  Toggle,
  StatusBadge,
  Dialog,
  Drawer,
  ConfirmDialog,
  CurrencyInput,
  LoadingState,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { Can, useCan } from "@/shared/permissions";
import { formatDateTime } from "@/shared/lib";
import {
  useBrands,
  useMenuItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  useUpdatePrice,
  usePriceHistory,
  type MenuItem,
  type MenuItemInput,
} from "./api";
import { Money, marginPct, useBrandScope, BrandSelect } from "./lib";
import { ItemImageEditor } from "./ItemImageEditor";

const TAX_OPTIONS = [
  { value: "S", label: "خاضع 15٪ (S)" },
  { value: "Z", label: "صفري (Z)" },
  { value: "E", label: "معفى (E)" },
  { value: "O", label: "خارج النطاق (O)" },
];

export function BrandMenu() {
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canManage = useCan("menu.catalog.manage");
  const canPrice = useCan("menu.pricing.manage");

  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ brandId: brandId || undefined, type: "all" });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [priceItem, setPriceItem] = useState<MenuItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<MenuItem | null>(null);
  const [historyItem, setHistoryItem] = useState<MenuItem | null>(null);

  const del = useDeleteMenuItem();

  // Catalog table = finished sellable items (combos + semi have their own screens).
  const rows = useMemo(
    () => (itemsQ.data ?? []).filter((i) => !i.isCombo && !i.isSemiFinished),
    [itemsQ.data],
  );

  const columns = useMemo<ColumnDef<MenuItem>[]>(() => [
    {
      id: "name",
      header: "الصنف",
      accessor: (r) => r.name,
      sortable: true,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-bold text-slate-800">{r.name}</div>
          {r.nameEn && <div dir="ltr" className="truncate text-[11px] text-slate-400">{r.nameEn}</div>}
        </div>
      ),
    },
    { id: "category", header: "الفئة", accessor: (r) => r.category || "—", sortable: true },
    { id: "price", header: "السعر", numeric: true, accessor: (r) => r.price, sortable: true, cell: (r) => <Money value={r.price} /> },
    { id: "cost", header: "التكلفة", numeric: true, accessor: (r) => r.cost, cell: (r) => <Money value={r.cost} /> },
    {
      id: "margin",
      header: "الهامش",
      numeric: true,
      accessor: (r) => marginPct(r.price, r.cost),
      cell: (r) => {
        const m = marginPct(r.price, r.cost);
        return <span dir="ltr" className={m > 0 ? "tabular-nums text-emerald-600" : "tabular-nums text-rose-600"}>{m}%</span>;
      },
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.active ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge tone={r.active ? "success" : "neutral"}>{r.active ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ], []);

  return (
    <div>
      <PageHeader
        eyebrow="القوائم والوصفات"
        title="قائمة العلامة التجارية"
        subtitle="أصناف القائمة والأسعار لكل علامة تجارية. تعديل السعر يُسجَّل في سجل الأسعار."
        action={
          <Can cap="menu.catalog.manage">
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="h-4 w-4" /> صنف جديد
            </Button>
          </Can>
        }
      />

      {brandsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : (
        <DataTable<MenuItem>
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          loading={itemsQ.isLoading}
          error={itemsQ.isError ? itemsQ.error : undefined}
          onRetry={() => itemsQ.refetch()}
          searchable
          searchPlaceholder="ابحث باسم الصنف أو الفئة…"
          initialPageSize={25}
          emptyTitle="لا توجد أصناف"
          emptyBody={brandId ? "لا توجد أصناف لهذه العلامة بعد." : "أضف صنفًا جديدًا أو اختر علامة تجارية."}
          mobileTitle={(r) => r.name}
          exportFilename={`menu-${brandId || "all"}.csv`}
          filterBar={
            <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} />
          }
          rowActions={(r) => (
            <div className="flex items-center justify-end gap-1">
              {canPrice && (
                <IconButton size="sm" aria-label="تعديل السعر" onClick={() => setPriceItem(r)}>
                  <Tag className="h-4 w-4" />
                </IconButton>
              )}
              <IconButton size="sm" aria-label="سجل الأسعار" onClick={() => setHistoryItem(r)}>
                <History className="h-4 w-4" />
              </IconButton>
              {canManage && (
                <IconButton size="sm" aria-label="تعديل الصنف" onClick={() => { setEditing(r); setFormOpen(true); }}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
              )}
              {canManage && (
                <IconButton size="sm" aria-label="حذف الصنف" onClick={() => setDeleteItem(r)}>
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </IconButton>
              )}
            </div>
          )}
        />
      )}

      {formOpen && (
        <ItemFormDialog
          open={formOpen}
          initial={editing}
          brands={brandsQ.data ?? []}
          defaultBrandId={brandId}
          onClose={() => setFormOpen(false)}
        />
      )}

      {priceItem && (
        <PriceEditDialog item={priceItem} onClose={() => setPriceItem(null)} />
      )}

      {historyItem && (
        <PriceHistoryDrawer item={historyItem} onClose={() => setHistoryItem(null)} />
      )}

      <ConfirmDialog
        open={!!deleteItem}
        title="حذف الصنف"
        description={deleteItem ? `سيتم إخفاء «${deleteItem.name}» من القوائم (حذف ناعم يحفظ السجل).` : ""}
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onClose={() => { if (!del.isPending) setDeleteItem(null); }}
        onConfirm={() => {
          if (!deleteItem) return;
          del.mutate(deleteItem.id, {
            onSuccess: () => { toast({ title: "تم حذف الصنف", tone: "success" }); setDeleteItem(null); },
            onError: (e: Error) => toast({ title: "تعذّر الحذف", description: e.message, tone: "error" }),
          });
        }}
      />
    </div>
  );
}

// ── Create / edit item form ──────────────────────────────────────────────────
const itemSchema = z.object({
  name: arabicText({ label: "اسم الصنف" }),
  nameEn: z.string().trim().max(200).optional().or(z.literal("")),
  category: z.string().trim().min(1, "الفئة مطلوبة").max(100),
  brandId: z.string().optional().or(z.literal("")),
  price: z.coerce.number().finite("أدخل سعرًا صحيحًا").min(0, "السعر لا يمكن أن يكون سالبًا"),
  cost: z.coerce.number().finite("أدخل تكلفة صحيحة").min(0, "التكلفة لا يمكن أن تكون سالبة"),
  unit: z.string().trim().max(20).optional().or(z.literal("")),
  taxCategory: z.enum(["S", "Z", "E", "O"]),
  active: z.boolean(),
});
type ItemForm = z.infer<typeof itemSchema>;

function ItemFormDialog({
  open,
  initial,
  brands,
  defaultBrandId,
  onClose,
}: {
  open: boolean;
  initial: MenuItem | null;
  brands: { id: string; name: string }[];
  defaultBrandId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  // close/d-images — pending image edit, OUTSIDE react-hook-form on purpose:
  // undefined = untouched (field omitted → server leaves the stored image),
  // '' = remove on save, string = the new ≤512px JPEG data URL.
  const [imageData, setImageData] = useState<string | undefined>(undefined);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ItemForm>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: "", nameEn: "", category: "عام", brandId: defaultBrandId || "", price: 0, cost: 0, unit: "", taxCategory: "S", active: true },
  });

  useEffect(() => {
    if (!open) return;
    setImageData(undefined);
    reset({
      name: initial?.name ?? "",
      nameEn: initial?.nameEn ?? "",
      category: initial?.category ?? "عام",
      brandId: initial?.brandId ?? defaultBrandId ?? "",
      price: initial?.price ?? 0,
      cost: initial?.cost ?? 0,
      unit: initial?.unit ?? "",
      taxCategory: "S",
      active: initial?.active ?? true,
    });
  }, [open, initial, defaultBrandId, reset]);

  function submit(v: ItemForm) {
    const base: MenuItemInput = {
      name: v.name,
      nameEn: v.nameEn || "",
      category: v.category,
      brandId: v.brandId || null,
      price: v.price,
      cost: v.cost,
      unit: v.unit || null,
      active: v.active,
    };
    if (initial) {
      // NOTE: the server's menu payload does not expose the current tax_category,
      // and the PUT route only overwrites it when `taxCategory` is present — so we
      // deliberately OMIT it here to preserve the item's existing ZATCA category.
      // Carry through the other fields the PUT route would otherwise reset.
      const body: MenuItemInput = {
        ...base,
        stock: initial.stock,
        minStock: initial.minStock,
        pricingMode: initial.pricingMode,
        markupPct: initial.markupPct,
        bigUnit: initial.bigUnit,
        convRate: initial.convRate,
        yieldQuantity: initial.yieldQuantity,
        yieldUnit: initial.yieldUnit,
        // Only send imageData when the user actually touched it — the PUT
        // route leaves the stored image alone when the field is absent.
        ...(imageData !== undefined ? { imageData } : {}),
      };
      update.mutate(
        { id: initial.id, input: body },
        {
          onSuccess: () => { toast({ title: "تم حفظ التغييرات", tone: "success" }); onClose(); },
          onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
        },
      );
    } else {
      create.mutate({ ...base, taxCategory: v.taxCategory, ...(imageData ? { imageData } : {}) }, {
        onSuccess: () => { toast({ title: "تم إنشاء الصنف", tone: "success" }); onClose(); },
        onError: (e: Error) => toast({ title: "تعذّر الإنشاء", description: e.message, tone: "error" }),
      });
    }
  }

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onClose={onClose} title={initial ? "تعديل صنف" : "صنف جديد"} size="lg" dismissable={!isSubmitting}>
      <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="اسم الصنف" required error={errors.name}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label="الاسم بالإنجليزية" error={errors.nameEn}>
            {({ id }) => <Input id={id} dir="ltr" {...register("nameEn")} />}
          </Field>
          <Field label="الفئة" required error={errors.category}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("category")} />}
          </Field>
          <Field label="العلامة التجارية" error={errors.brandId}>
            {({ id }) => (
              <Select id={id} {...register("brandId")}>
                <option value="">بدون علامة</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="السعر" required error={errors.price}>
            {({ id, invalid }) => <Input id={id} type="number" step="0.01" min={0} inputMode="decimal" dir="ltr" invalid={invalid} {...register("price")} />}
          </Field>
          <Field label="التكلفة" error={errors.cost}>
            {({ id, invalid }) => <Input id={id} type="number" step="0.01" min={0} inputMode="decimal" dir="ltr" invalid={invalid} {...register("cost")} />}
          </Field>
          <Field label="الوحدة" error={errors.unit} hint="مثال: حبة، كجم، لتر">
            {({ id }) => <Input id={id} {...register("unit")} />}
          </Field>
          {!initial && (
            <Field label="فئة الضريبة (ZATCA)" error={errors.taxCategory} hint="تُحدَّد عند الإنشاء فقط">
              {({ id }) => <Select id={id} options={TAX_OPTIONS} {...register("taxCategory")} />}
            </Field>
          )}
        </div>
        <ItemImageEditor
          current={initial?.imageData ?? null}
          pending={imageData}
          onChange={setImageData}
          disabled={isSubmitting}
        />
        <Toggle checked={watch("active")} onChange={(v) => setValue("active", v)} label="صنف نشط" />
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>إلغاء</Button>
          <Button type="submit" loading={pending}>{initial ? "حفظ التغييرات" : "إنشاء"}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ── Inline price edit (records reason to the audit log) ──────────────────────
function PriceEditDialog({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const { toast } = useToast();
  const update = useUpdatePrice();
  const [price, setPrice] = useState<number | null>(item.price);
  const [reason, setReason] = useState("");

  const reasonOk = reason.trim().length >= 3;
  const priceOk = price != null && price >= 0;
  const preview = priceOk ? marginPct(price!, item.cost) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title="تعديل السعر"
      description={item.name}
      size="md"
      dismissable={!update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>إلغاء</Button>
          <Button
            loading={update.isPending}
            disabled={!reasonOk || !priceOk}
            onClick={() =>
              update.mutate(
                { id: item.id, price: price!, reason: reason.trim() },
                {
                  onSuccess: (res) => {
                    toast({ title: res.noop ? "لا تغيير في السعر" : "تم تحديث السعر", tone: "success" });
                    onClose();
                  },
                  onError: (e: Error) => toast({ title: "تعذّر تحديث السعر", description: e.message, tone: "error" }),
                },
              )
            }
          >
            حفظ السعر
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-bold text-slate-400">السعر الحالي</span>
          <Money value={item.price} className="font-extrabold text-slate-700" />
        </div>
        <Field label="السعر الجديد" required>
          {({ id }) => <CurrencyInput id={id} value={price} onChange={setPrice} min={0} />}
        </Field>
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-bold text-slate-400">الهامش المتوقّع</span>
          <span dir="ltr" className={preview > 0 ? "tabular-nums font-extrabold text-emerald-600" : "tabular-nums font-extrabold text-rose-600"}>{preview}%</span>
        </div>
        <label className="block">
          <span className="text-xs font-bold text-slate-600">سبب التغيير <span className="text-rose-600">*</span></span>
          <textarea
            className="field mt-1 min-h-20 w-full resize-y py-2"
            placeholder="اكتب سبب تغيير السعر…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {!reasonOk && reason.length > 0 && (
            <span className="mt-1 block text-xs font-bold text-rose-600">السبب يجب أن يكون 3 أحرف على الأقل.</span>
          )}
        </label>
      </div>
    </Dialog>
  );
}

// ── Price history ────────────────────────────────────────────────────────────
function PriceHistoryDrawer({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const q = usePriceHistory(item.id);
  return (
    <Drawer open onClose={onClose} title={item.name} eyebrow="سجل الأسعار" icon={History}>
      {q.isLoading ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <p className="text-sm font-medium text-rose-600">تعذّر تحميل السجل.</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm font-medium text-slate-500">لا توجد تغييرات سعر مسجّلة لهذا الصنف.</p>
      ) : (
        <ul className="space-y-3">
          {(q.data ?? []).map((h) => (
            <li key={h.id} className="rounded-xl border border-slate-100 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-400">{formatDateTime(h.at)}</span>
                <span className="text-[11px] font-bold text-slate-500">{h.user}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <Money value={h.oldPrice} className="text-slate-400 line-through" />
                <span className="text-slate-300">←</span>
                <Money value={h.newPrice} className="font-extrabold text-slate-800" />
              </div>
              {h.reason && <div className="mt-1 text-xs font-medium text-slate-500">{h.reason}</div>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
