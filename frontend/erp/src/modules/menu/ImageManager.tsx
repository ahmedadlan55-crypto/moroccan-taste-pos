/**
 * ImageManager (close/d-images bulk manager, Owner K) — brand/category/review
 * filters over the catalog + a selectable DataTable + a bulk-upload dialog,
 * modeled structurally on PriceLists.tsx (PageHeader + filter Card + DataTable
 * with selectable/bulkActions).
 *
 * DATA SOURCE NOTE (2026-07-20, verified against the actual router source in
 * this worktree — routes/product-images.js exists but is not yet mounted in
 * server.js): the table below sources rows from the EXISTING, working
 * useMenuItems (/menu/all), which already carries imageData per item — NOT
 * from the new useImageList(). This is deliberate, not just a standalone
 * stopgap: routes/product-images.js's list query never selects image_data
 * ("the 66MB rule" — see its own comment), shipping only an id/name/category/
 * imageVer(hash)/imageBytes row with no brandName, no thumbnail bytes. It can
 * never power this table's thumbnail column, so /menu/all remains the right
 * source even after the router is mounted.
 *
 * There is also no review-workflow (pending/approved/rejected) anywhere in
 * the backend today — imageReviewStatus/imageUpdatedAt/imageUpdatedBy on
 * MenuItem (api.ts) are forward-looking optional fields with no current data
 * source; the review-status filter below is kept per spec but is inert until
 * a real review workflow ships (see its hint text).
 *
 * Per-row replace/delete falls back to the EXISTING PUT /api/menu/:id
 * image-only path (useUpdateMenuItem, same mechanism ItemImageEditor/
 * BrandMenu already use) — chosen over the new useReplaceImage/useDeleteImage
 * for the same standalone-usability reason. Write actions here (row replace/
 * delete, the bulk-upload trigger) gate on capability "menu.image.manage",
 * matching what routes/product-images.js actually enforces
 * (requireCapability('menu.image.manage'), seeded to admin+manager in
 * db/migrations/capability-seeds/g-menu-images.json) — the capability is now
 * declared in @/app/permissions with the same role grant (MGR) as
 * menu.catalog.manage. Bulk upload has no legacy equivalent, so
 * ImageManagerBulkUpload calls the new useBulkUploadImages() directly; it
 * will start working the moment the router is mounted, no frontend change
 * needed.
 */
import { useMemo, useRef, useState } from "react";
import { ImagePlus, ImageOff, Trash2, UploadCloud } from "lucide-react";
import {
  PageHeader,
  Card,
  Button,
  IconButton,
  Select,
  SegmentedControl,
  StatusBadge,
  LoadingState,
  useToast,
  type StatusTone,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can, useCan } from "@/shared/permissions";
import { formatDateTime } from "@/shared/lib";
import { useBrands, useMenuItems, useUpdateMenuItem, type MenuItem, type MenuItemInput } from "./api";
import { useBrandScope, BrandSelect } from "./lib";
import { downscaleImageFile } from "./imageCompression";
import { ImageManagerBulkUpload } from "./ImageManagerBulkUpload";

type ImageFilter = "all" | "has" | "missing";
type ReviewFilter = "" | "pending" | "approved" | "rejected";

const IMAGE_FILTER_OPTIONS: { value: ImageFilter; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "has", label: "له صورة" },
  { value: "missing", label: "بلا صورة" },
];

const REVIEW_OPTIONS: { value: ReviewFilter; label: string }[] = [
  { value: "", label: "كل حالات المراجعة" },
  { value: "pending", label: "قيد المراجعة" },
  { value: "approved", label: "معتمد" },
  { value: "rejected", label: "مرفوض" },
];

function imageStatus(item: MenuItem): { label: string; tone: StatusTone } {
  if (!item.imageData) return { label: "بلا صورة", tone: "neutral" };
  if (item.imageReviewStatus === "approved") return { label: "معتمد", tone: "success" };
  if (item.imageReviewStatus === "pending") return { label: "قيد المراجعة", tone: "warning" };
  if (item.imageReviewStatus === "rejected") return { label: "مرفوض", tone: "danger" };
  return { label: "له صورة", tone: "success" };
}

/** The PUT /menu/:id route resets stock/unit/pricing/yield columns when they
 *  are absent from the body — carry every existing value through so an
 *  image-only edit can never silently clobber the rest of the item (mirrors
 *  BrandMenu.tsx's update payload construction exactly). */
function buildImageOnlyUpdate(item: MenuItem, imageData: string): MenuItemInput {
  return {
    name: item.name,
    nameEn: item.nameEn || "",
    category: item.category,
    brandId: item.brandId || null,
    price: item.price,
    cost: item.cost,
    unit: item.unit || null,
    active: item.active,
    stock: item.stock,
    minStock: item.minStock,
    pricingMode: item.pricingMode,
    markupPct: item.markupPct,
    bigUnit: item.bigUnit,
    convRate: item.convRate,
    yieldQuantity: item.yieldQuantity,
    yieldUnit: item.yieldUnit,
    imageData,
  };
}

/** Gate the whole page — the inner screen (and its queries/mutations) only
 *  mounts once menu.view is confirmed, matching the PricingPage/ChannelsPage
 *  idiom (Can showDenied wraps a thin outer component, not the hook-bearing
 *  screen itself). */
export function ImageManager() {
  return (
    <Can cap="menu.view" showDenied>
      <ImageManagerScreen />
    </Can>
  );
}

function ImageManagerScreen() {
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canManage = useCan("menu.image.manage");

  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ brandId: brandId || undefined, type: "all" });
  const update = useUpdateMenuItem();

  const [category, setCategory] = useState("");
  const [imageFilter, setImageFilter] = useState<ImageFilter>("all");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("");
  const [selected, setSelected] = useState<string[]>([]);
  // The dialog's match/assign pool: the exact selection when opened from the
  // BulkActionBar (a deliberate "upload for THESE items" scope), otherwise
  // every currently-filtered row (header button, no selection required).
  const [bulkScope, setBulkScope] = useState<MenuItem[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const fileInputs = useRef(new Map<string, HTMLInputElement | null>());

  // Combos live under a separate endpoint/id-space (/menu/combos/:id) and
  // don't carry an imageData field — this manager only covers finished +
  // semi-finished catalog rows, matching PriceLists' combo exclusion.
  const rows = useMemo(() => (itemsQ.data ?? []).filter((i) => !i.isCombo), [itemsQ.data]);
  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
    [rows],
  );

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (category && r.category !== category) return false;
        if (imageFilter === "has" && !r.imageData) return false;
        if (imageFilter === "missing" && r.imageData) return false;
        if (reviewFilter && r.imageReviewStatus !== reviewFilter) return false;
        return true;
      }),
    [rows, category, imageFilter, reviewFilter],
  );

  function doReplace(item: MenuItem, imageData: string) {
    setBusyRowId(item.id);
    update.mutate(
      { id: item.id, input: buildImageOnlyUpdate(item, imageData) },
      {
        onSuccess: () => toast({ title: `تم تحديث صورة «${item.name}»`, tone: "success" }),
        onError: (e: Error) => toast({ title: "تعذّر رفع الصورة", description: e.message, tone: "error" }),
        onSettled: () => setBusyRowId(null),
      },
    );
  }

  async function onPickReplace(item: MenuItem, file: File | null) {
    if (!file) return;
    setBusyRowId(item.id);
    try {
      const imageData = await downscaleImageFile(file);
      doReplace(item, imageData);
    } catch (e) {
      toast({ title: "تعذّر تجهيز الصورة", description: e instanceof Error ? e.message : undefined, tone: "error" });
      setBusyRowId(null);
    }
  }

  function onRemove(item: MenuItem) {
    setBusyRowId(item.id);
    update.mutate(
      { id: item.id, input: buildImageOnlyUpdate(item, "") },
      {
        onSuccess: () => toast({ title: `تم حذف صورة «${item.name}»`, tone: "success" }),
        onError: (e: Error) => toast({ title: "تعذّر حذف الصورة", description: e.message, tone: "error" }),
        onSettled: () => setBusyRowId(null),
      },
    );
  }

  const columns = useMemo<ColumnDef<MenuItem>[]>(
    () => [
      {
        id: "thumbnail",
        header: "الصورة",
        hideable: false,
        sortable: false,
        cell: (r) => (
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {r.imageData ? (
              <img src={r.imageData} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImageOff className="h-4 w-4 text-slate-300" aria-hidden />
            )}
          </div>
        ),
      },
      {
        id: "name",
        header: "الصنف",
        accessor: (r) => r.name,
        sortable: true,
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate font-bold text-slate-800">{r.name}</div>
            {r.nameEn && (
              <div dir="ltr" className="truncate text-[11px] font-medium text-slate-400">
                {r.nameEn}
              </div>
            )}
          </div>
        ),
      },
      { id: "brand", header: "العلامة التجارية", accessor: (r) => r.brandName, sortable: true },
      { id: "category", header: "الفئة", accessor: (r) => r.category || "—", sortable: true },
      {
        id: "status",
        header: "حالة الصورة",
        accessor: (r) => imageStatus(r).label,
        cell: (r) => {
          const s = imageStatus(r);
          return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
        },
      },
      {
        id: "updated",
        header: "آخر تحديث",
        accessor: (r) => r.imageUpdatedAt,
        cell: (r) => (
          <div className="flex flex-col">
            <span dir="ltr" className="text-xs tabular-nums text-slate-500">
              {formatDateTime(r.imageUpdatedAt)}
            </span>
            {r.imageUpdatedBy && <span className="text-[11px] font-medium text-slate-400">{r.imageUpdatedBy}</span>}
          </div>
        ),
        mobileHidden: true,
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        eyebrow="القوائم والوصفات"
        title="إدارة صور الأصناف"
        subtitle="استعرض ورشّح الأصناف حسب حالة الصورة، وارفع صورًا لعدة أصناف دفعة واحدة."
        action={
          <Can cap="menu.image.manage">
            <Button onClick={() => { setBulkScope(selected.length > 0 ? filtered.filter((r) => selected.includes(r.id)) : filtered); setBulkOpen(true); }}>
              <UploadCloud className="h-4 w-4" />
              {selected.length > 0 ? `رفع صور لـ ${selected.length} محدد` : "رفع صور جماعي"}
            </Button>
          </Can>
        }
      />

      <Card className="mb-6 p-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">العلامة التجارية</label>
            <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={(v) => { setBrandId(v); setSelected([]); }} className="w-full" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">الفئة</label>
            <Select className="h-10 w-full" value={category} onChange={(e) => { setCategory(e.target.value); setSelected([]); }} aria-label="تصفية بالفئة">
              <option value="">كل الفئات</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">حالة الصورة</label>
            <SegmentedControl
              options={IMAGE_FILTER_OPTIONS}
              value={imageFilter}
              onChange={setImageFilter}
              className="w-full justify-between"
              aria-label="تصفية حسب وجود الصورة"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">حالة المراجعة</label>
            <Select className="h-10 w-full" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)} options={REVIEW_OPTIONS} aria-label="تصفية بحالة المراجعة" />
            {reviewFilter && (
              <p className="mt-1 text-[11px] font-medium text-slate-400">
                ميزة مراجعة الصور غير مفعّلة بعد على الخادم — لن تظهر نتائج بهذا الفلتر حاليًا.
              </p>
            )}
          </div>
        </div>
      </Card>

      {brandsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : (
        <DataTable<MenuItem>
          columns={columns}
          rows={filtered}
          getRowId={(r) => r.id}
          loading={itemsQ.isLoading}
          error={itemsQ.isError ? itemsQ.error : undefined}
          onRetry={() => itemsQ.refetch()}
          selectable={canManage}
          onSelectionChange={setSelected}
          searchable
          searchPlaceholder="ابحث باسم الصنف…"
          emptyTitle="لا توجد أصناف"
          emptyBody="غيّر عوامل التصفية أو اختر علامة تجارية أخرى."
          mobileTitle={(r) => r.name}
          rowActions={canManage ? (r) => (
            <div className="flex items-center gap-1">
              <input
                ref={(el) => { fileInputs.current.set(r.id, el); }}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-label={`استبدال صورة ${r.name}`}
                disabled={busyRowId === r.id}
                onChange={(e) => { void onPickReplace(r, e.target.files?.[0] ?? null); e.target.value = ""; }}
              />
              <IconButton
                size="sm"
                aria-label={`${r.imageData ? "تغيير" : "إضافة"} صورة ${r.name}`}
                disabled={busyRowId === r.id}
                onClick={() => fileInputs.current.get(r.id)?.click()}
              >
                <ImagePlus className="h-4 w-4" />
              </IconButton>
              {r.imageData && (
                <IconButton
                  size="sm"
                  variant="danger"
                  aria-label={`حذف صورة ${r.name}`}
                  disabled={busyRowId === r.id}
                  onClick={() => onRemove(r)}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              )}
            </div>
          ) : undefined}
          bulkActions={canManage ? (ids) => (
            <Button size="sm" onClick={() => { setBulkScope(filtered.filter((r) => ids.includes(r.id))); setBulkOpen(true); }}>
              <UploadCloud className="h-4 w-4" /> رفع صور لـ {ids.length} محدد
            </Button>
          ) : undefined}
        />
      )}

      {bulkOpen && (
        <ImageManagerBulkUpload open={bulkOpen} onClose={() => setBulkOpen(false)} items={bulkScope} />
      )}
    </div>
  );
}
