/**
 * ImageManager (close/d-images bulk manager, Owner K) — brand/category/review
 * filters over the catalog + a selectable DataTable + a bulk-upload dialog,
 * modeled structurally on PriceLists.tsx (PageHeader + filter Card + DataTable
 * with selectable/bulkActions).
 *
 * DATA SOURCE NOTE: the table sources rows from useMenuItems (/menu/all) for
 * brandName + the full item shape the image-only PUT must carry through.
 * menu-hardening: /menu/all no longer ships image bytes at all ("the 66MB
 * rule" — every list read now carries only hasImage + an 8-char imageVer
 * content hash, the same expression as /menu/list). So the thumbnail column,
 * the has/missing filter and the row actions all read hasImage/imageVer, and
 * the bytes come per item — with the token — through MenuItemThumb /
 * useItemImage (GET /api/pos/v2/item-image/:id?v=imageVer). A replace or
 * delete goes through useUpdateMenuItem, whose onSuccess invalidates the
 * items query; the refetched row carries a NEW imageVer, which is exactly
 * what busts the thumbnail cache (keyed on id + imageVer).
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
import { ImagePlus, Trash2, UploadCloud } from "lucide-react";
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
import { useTx } from "@/shared/ui/i18n";
import { Can, useCan } from "@/shared/permissions";
import { formatDateTime } from "@/shared/lib";
import type { TFunction } from "@/i18n";
import { useBrands, useMenuItems, useUpdateMenuItem, menuErrorText, type MenuItem, type MenuItemInput } from "./api";
import { useBrandScope, BrandSelect } from "./lib";
import { downscaleImageFile, imagePrepMessage } from "./imageCompression";
import { ImageManagerBulkUpload } from "./ImageManagerBulkUpload";
import { MenuItemThumb } from "./MenuItemThumb";

type ImageFilter = "all" | "has" | "missing";
type ReviewFilter = "" | "pending" | "approved" | "rejected";

/** Image presence + (forward-looking) review-status label, localized via t. The
 *  review states reuse the shared status.* codes; presence is menuRest-owned. */
function imageStatus(item: MenuItem, t: TFunction): { label: string; tone: StatusTone } {
  // hasImage, never imageData: the list rows carry no bytes (see header note).
  if (!item.hasImage) return { label: t("menuRest.imageManager.noImage"), tone: "neutral" };
  if (item.imageReviewStatus === "approved") return { label: t("status.approved"), tone: "success" };
  if (item.imageReviewStatus === "pending") return { label: t("status.underReview"), tone: "warning" };
  if (item.imageReviewStatus === "rejected") return { label: t("status.rejected"), tone: "danger" };
  return { label: t("menuRest.imageManager.hasImage"), tone: "success" };
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
  const t = useTx();
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canManage = useCan("menu.image.manage");

  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ brandId: brandId || undefined, type: "all" });
  const update = useUpdateMenuItem();

  const IMAGE_FILTER_OPTIONS = useMemo<{ value: ImageFilter; label: string }[]>(() => [
    { value: "all", label: t("common.all") },
    { value: "has", label: t("menuRest.imageManager.hasImage") },
    { value: "missing", label: t("menuRest.imageManager.noImage") },
  ], [t]);

  const REVIEW_OPTIONS = useMemo<{ value: ReviewFilter; label: string }[]>(() => [
    { value: "", label: t("menuRest.imageManager.allReview") },
    { value: "pending", label: t("status.underReview") },
    { value: "approved", label: t("status.approved") },
    { value: "rejected", label: t("status.rejected") },
  ], [t]);

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
        if (imageFilter === "has" && !r.hasImage) return false;
        if (imageFilter === "missing" && r.hasImage) return false;
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
        onSuccess: () => toast({ title: t("menuRest.imageManager.imageUpdated", { name: item.name }), tone: "success" }),
        onError: (e: Error) => toast({ title: t("menuRest.imageManager.uploadFailed"), description: menuErrorText(e, t), tone: "error" }),
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
      toast({ title: t("menuRest.imagePrep.title"), description: imagePrepMessage(e, t), tone: "error" });
      setBusyRowId(null);
    }
  }

  function onRemove(item: MenuItem) {
    setBusyRowId(item.id);
    update.mutate(
      { id: item.id, input: buildImageOnlyUpdate(item, "") },
      {
        onSuccess: () => toast({ title: t("menuRest.imageManager.imageDeleted", { name: item.name }), tone: "success" }),
        onError: (e: Error) => toast({ title: t("menuRest.imageManager.deleteFailed"), description: menuErrorText(e, t), tone: "error" }),
        onSettled: () => setBusyRowId(null),
      },
    );
  }

  const columns = useMemo<ColumnDef<MenuItem>[]>(
    () => [
      {
        id: "thumbnail",
        header: t("menuRest.imageManager.imageCol"),
        hideable: false,
        sortable: false,
        // Bytes are fetched per item with the token (useItemImage) and keyed on
        // imageVer — no data URL rides on the list row any more.
        cell: (r) => <MenuItemThumb id={r.id} imageVer={r.imageVer} hasImage={r.hasImage} alt="" className="h-10 w-10 rounded-lg" />,
      },
      {
        id: "name",
        header: t("menuRest.fields.item"),
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
      { id: "brand", header: t("menuRest.fields.brand"), accessor: (r) => r.brandName, sortable: true },
      { id: "category", header: t("menuRest.fields.category"), accessor: (r) => r.category || "—", sortable: true },
      {
        id: "status",
        header: t("menuRest.imageManager.imageStatusCol"),
        accessor: (r) => imageStatus(r, t).label,
        cell: (r) => {
          const s = imageStatus(r, t);
          return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
        },
      },
      {
        id: "updated",
        header: t("menuRest.imageManager.lastUpdated"),
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
    [t],
  );

  return (
    <div>
      <PageHeader
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.imageManager.title")}
        subtitle={t("menuRest.imageManager.subtitle")}
        action={
          <Can cap="menu.image.manage">
            <Button onClick={() => { setBulkScope(selected.length > 0 ? filtered.filter((r) => selected.includes(r.id)) : filtered); setBulkOpen(true); }}>
              <UploadCloud className="h-4 w-4" />
              {selected.length > 0 ? t("menuRest.imageManager.uploadForSelected", { count: selected.length }) : t("menuRest.imageManager.bulkUpload")}
            </Button>
          </Can>
        }
      />

      <Card className="mb-6 p-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.fields.brand")}</label>
            <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={(v) => { setBrandId(v); setSelected([]); }} className="w-full" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.fields.category")}</label>
            <Select className="h-10 w-full" value={category} onChange={(e) => { setCategory(e.target.value); setSelected([]); }} aria-label={t("menuRest.aria.filterByCategory")}>
              <option value="">{t("menuRest.filters.allCategories")}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.imageManager.imageStatusCol")}</label>
            <SegmentedControl
              options={IMAGE_FILTER_OPTIONS}
              value={imageFilter}
              onChange={setImageFilter}
              className="w-full justify-between"
              aria-label={t("menuRest.imageManager.filterByImageAria")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.imageManager.reviewStatus")}</label>
            <Select className="h-10 w-full" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)} options={REVIEW_OPTIONS} aria-label={t("menuRest.imageManager.filterByReviewAria")} />
            {reviewFilter && (
              <p className="mt-1 text-[11px] font-medium text-slate-400">
                {t("menuRest.imageManager.reviewInactive")}
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
          searchPlaceholder={t("menuRest.filters.searchByItem")}
          emptyTitle={t("menuRest.filters.noItemsTitle")}
          emptyBody={t("menuRest.imageManager.emptyBody")}
          mobileTitle={(r) => r.name}
          rowActions={canManage ? (r) => (
            <div className="flex items-center gap-1">
              <input
                ref={(el) => { fileInputs.current.set(r.id, el); }}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-label={t("menuRest.imageManager.replaceImageAria", { name: r.name })}
                disabled={busyRowId === r.id}
                onChange={(e) => { void onPickReplace(r, e.target.files?.[0] ?? null); e.target.value = ""; }}
              />
              <IconButton
                size="sm"
                aria-label={t(r.hasImage ? "menuRest.imageManager.changeImageAria" : "menuRest.imageManager.addImageAria", { name: r.name })}
                disabled={busyRowId === r.id}
                onClick={() => fileInputs.current.get(r.id)?.click()}
              >
                <ImagePlus className="h-4 w-4" />
              </IconButton>
              {r.hasImage && (
                <IconButton
                  size="sm"
                  variant="danger"
                  aria-label={t("menuRest.imageManager.deleteImageAria", { name: r.name })}
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
              <UploadCloud className="h-4 w-4" /> {t("menuRest.imageManager.uploadForSelected", { count: ids.length })}
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
