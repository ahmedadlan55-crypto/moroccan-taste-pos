// Menu products list (Sprint 3 · D2) — the catalog screen, redesigned onto the
// upgraded DataTable in mode="server" over GET /api/menu/list (D3): paginated,
// no image bytes (thumbnails fetch per-item), derived branch/channel counts,
// margin value+%, cost source and tax category. Bilingual from the start
// (menu.* namespace + common/status/table). Cost & margin columns are gated by
// menu.cost.view; New/Details/Edit are full pages with real routes
// (/menu/brand/new|:id|:id/edit). Price edit + history stay as focused dialogs.
//
// Column ids double as the server sort keys (the backend whitelists
// name/category/cost/price/marginPct/branchCount/channelCount/active), so
// onStateChange forwards {columnId → sort, dir} straight through.
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Pencil, Tag, History, Trash2 } from "lucide-react";
import {
  PageHeader,
  Button,
  IconButton,
  Select,
  Checkbox,
  StatusBadge,
  ConfirmDialog,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can, useCan } from "@/shared/permissions";
import { useT, useLang } from "@/i18n";
import { useChannels } from "@/modules/sales/channels/api";
import {
  useBrands,
  useMenuList,
  useCategoryList,
  useDeleteMenuItem,
  type MenuListRow,
  type MenuListParams,
} from "./api";
import { MoneyI18n, Num, pickName, useBrandScope, BrandSelect } from "./lib";
import { MenuItemThumb } from "./MenuItemThumb";
import { PriceEditDialog, PriceHistoryDrawer } from "./PriceDialogs";

interface TableState {
  page: number;
  pageSize: number;
  search: string;
  sort: string;
  dir: "asc" | "desc";
}

type TriState = "" | "yes" | "no";
interface Filters {
  category: string;
  channel: string;
  status: "" | "active" | "inactive";
  recipe: TriState;
  image: TriState;
  missingNameEn: boolean;
  negativeMargin: boolean;
}

const EMPTY_FILTERS: Filters = { category: "", channel: "", status: "", recipe: "", image: "", missingNameEn: false, negativeMargin: false };

function triToBool(v: TriState): boolean | undefined {
  return v === "yes" ? true : v === "no" ? false : undefined;
}

export function BrandMenu() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();

  const canManage = useCan("menu.catalog.manage");
  const canPrice = useCan("menu.pricing.manage");
  const canCost = useCan("menu.cost.view");

  const brandsQ = useBrands();
  const categoriesQ = useCategoryList();
  const channelsQ = useChannels();

  const [ts, setTs] = useState<TableState>({ page: 1, pageSize: 25, search: "", sort: "", dir: "asc" });
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [priceItem, setPriceItem] = useState<MenuListRow | null>(null);
  const [historyItem, setHistoryItem] = useState<MenuListRow | null>(null);
  const [deleteItem, setDeleteItem] = useState<MenuListRow | null>(null);

  const del = useDeleteMenuItem();

  const params = useMemo<MenuListParams>(
    () => ({
      page: ts.page,
      pageSize: ts.pageSize,
      q: ts.search,
      sort: ts.sort || undefined,
      dir: ts.sort ? ts.dir : undefined,
      brandId: brandId || undefined,
      category: filters.category || undefined,
      channel: filters.channel || undefined,
      status: filters.status || undefined,
      hasRecipe: triToBool(filters.recipe),
      hasImage: triToBool(filters.image),
      missingNameEn: filters.missingNameEn || undefined,
      negativeMargin: filters.negativeMargin || undefined,
    }),
    [ts, brandId, filters],
  );
  const list = useMenuList(params);

  const onStateChange = useCallback(
    (s: { page: number; pageSize: number; sort: { columnId: string; dir: "asc" | "desc" } | null; search: string }) => {
      const sort = s.sort?.columnId ?? "";
      const dir = s.sort?.dir ?? "asc";
      setTs((prev) =>
        prev.page === s.page && prev.pageSize === s.pageSize && prev.search === s.search && prev.sort === sort && prev.dir === dir
          ? prev
          : { page: s.page, pageSize: s.pageSize, search: s.search, sort, dir },
      );
    },
    [],
  );

  const setFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Arabic category → English label, for the bilingual category cell.
  const catEn = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categoriesQ.data ?? []) if (c.categoryEn) m.set(c.categoryAr, c.categoryEn);
    return m;
  }, [categoriesQ.data]);

  const brandQuery = brandId ? `?brandId=${encodeURIComponent(brandId)}` : "";
  const goDetail = useCallback((id: string) => navigate(`/menu/brand/${encodeURIComponent(id)}${brandQuery}`), [navigate, brandQuery]);
  const goEdit = useCallback((id: string) => navigate(`/menu/brand/${encodeURIComponent(id)}/edit${brandQuery}`), [navigate, brandQuery]);
  const goNew = useCallback(() => navigate(`/menu/brand/new${brandQuery}`), [navigate, brandQuery]);

  const columns = useMemo<ColumnDef<MenuListRow>[]>(() => [
    { id: "code", header: t("menu.col.code"), accessor: (r) => r.id, width: "8rem", mobileHidden: true, cell: (r) => <span dir="ltr" className="font-mono text-xs text-slate-500">{r.id}</span> },
    { id: "image", header: t("menu.col.image"), width: "4rem", hideable: false, noExport: true, mobileHidden: true, cell: (r) => <MenuItemThumb id={r.id} imageVer={r.imageVer} hasImage={r.hasImage} alt={pickName(r.name, r.nameEn, lang)} /> },
    {
      id: "name", header: t("menu.col.nameAr"), accessor: (r) => r.name, sortable: true, priority: 1,
      cell: (r) => <span className="font-bold text-slate-800">{r.name}</span>,
    },
    {
      id: "nameEn", header: t("menu.col.nameEn"), accessor: (r) => r.nameEn, label: t("menu.col.nameEn"),
      cell: (r) =>
        r.nameEn ? (
          <span dir="ltr" className="text-slate-600">{r.nameEn}</span>
        ) : (
          <span className="chip border-amber-200 bg-amber-50 text-[11px] text-amber-700">{t("menu.badge.missingEn")}</span>
        ),
    },
    { id: "category", header: t("menu.col.category"), accessor: (r) => r.category, sortable: true, cell: (r) => <span className="text-slate-600">{pickName(r.category, catEn.get(r.category), lang) || "—"}</span> },
    { id: "brand", header: t("menu.col.brand"), accessor: (r) => r.brandName || "—" },
    {
      id: "cost", header: t("menu.col.cost"), numeric: true, sortable: true, requireCap: "menu.cost.view", accessor: (r) => r.cost, priority: 5,
      cell: (r) => (
        <span className="inline-flex flex-col items-end">
          <MoneyI18n value={r.cost} />
          <span className="text-[10px] font-bold uppercase text-slate-400">{t(`menu.costSource.${r.costSource ?? "manual"}`)}</span>
        </span>
      ),
    },
    { id: "price", header: t("menu.col.price"), numeric: true, sortable: true, accessor: (r) => r.price, priority: 2, cell: (r) => <MoneyI18n value={r.price} className="font-bold" /> },
    {
      id: "marginPct", header: t("menu.col.margin"), numeric: true, sortable: true, requireCap: "menu.cost.view", accessor: (r) => r.marginPct, label: t("menu.col.margin"),
      cell: (r) => (
        <span className="inline-flex flex-col items-end">
          <MoneyI18n value={r.marginValue} className={r.marginValue >= 0 ? "text-emerald-600" : "text-rose-600"} />
          <span dir="ltr" className={r.marginPct >= 0 ? "text-[11px] font-bold tabular-nums text-emerald-600" : "text-[11px] font-bold tabular-nums text-rose-600"}>{r.marginPct}%</span>
        </span>
      ),
    },
    { id: "tax", header: t("menu.col.tax"), accessor: (r) => r.taxCategory, cell: (r) => <span className="chip border-slate-200 bg-slate-50 text-[11px] text-slate-600">{t(`menu.tax.${r.taxCategory}`)}</span> },
    { id: "branchCount", header: t("menu.col.branches"), numeric: true, sortable: true, accessor: (r) => r.branchCount, cell: (r) => <Num value={r.branchCount} /> },
    { id: "channelCount", header: t("menu.col.channels"), numeric: true, sortable: true, accessor: (r) => r.channelCount, cell: (r) => <Num value={r.channelCount} /> },
    { id: "active", header: t("menu.col.status"), accessor: (r) => (r.active ? "active" : "disabled"), sortable: true, priority: 3, cell: (r) => <StatusBadge>{r.active ? "active" : "disabled"}</StatusBadge> },
  ], [t, lang, catEn]);

  return (
    <div>
      <PageHeader
        eyebrow={t("menu.list.eyebrow")}
        title={t("menu.list.title")}
        subtitle={t("menu.list.subtitle")}
        action={
          <Can cap="menu.catalog.manage">
            <Button onClick={goNew}>
              <Plus className="h-4 w-4" /> {t("menu.list.newItem")}
            </Button>
          </Can>
        }
      />

      <DataTable<MenuListRow>
        mode="server"
        columns={columns}
        rows={list.data?.data ?? []}
        rowCount={list.data?.pagination.total ?? 0}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        onStateChange={onStateChange}
        onRowClick={(r) => goDetail(r.id)}
        initialPageSize={25}
        searchable
        searchPlaceholder={t("menu.list.searchPlaceholder")}
        tableId="menu-items"
        savedViewsModule="menu-items"
        canColumn={(cap) => (cap === "menu.cost.view" ? canCost : true)}
        emptyTitle={t("states.emptyDefault")}
        mobileTitle={(r) => pickName(r.name, r.nameEn, lang)}
        exportFilename={`menu-${brandId || "all"}.csv`}
        filterBar={
          <div className="flex flex-wrap items-center gap-2">
            <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} allLabel={t("menu.filter.brandAll")} aria-label={t("menu.filter.brand")} />
            <Select className="h-10" value={filters.category} onChange={(e) => setFilter("category", e.target.value)} aria-label={t("menu.filter.category")}>
              <option value="">{t("menu.filter.categoryAll")}</option>
              {(categoriesQ.data ?? []).map((c) => (
                <option key={c.categoryAr} value={c.categoryAr}>{pickName(c.categoryAr, c.categoryEn, lang)}</option>
              ))}
            </Select>
            <Select className="h-10" value={filters.channel} onChange={(e) => setFilter("channel", e.target.value)} aria-label={t("menu.filter.channel")}>
              <option value="">{t("menu.filter.channelAll")}</option>
              {(channelsQ.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{pickName(c.name, c.nameEn, lang)}</option>
              ))}
            </Select>
            <Select className="h-10" value={filters.status} onChange={(e) => setFilter("status", e.target.value as Filters["status"])} aria-label={t("menu.col.status")}>
              <option value="">{t("menu.filter.statusAll")}</option>
              <option value="active">{t("menu.filter.active")}</option>
              <option value="inactive">{t("menu.filter.inactive")}</option>
            </Select>
            <Select className="h-10" value={filters.recipe} onChange={(e) => setFilter("recipe", e.target.value as TriState)} aria-label={t("menu.filter.recipeAll")}>
              <option value="">{t("menu.filter.recipeAll")}</option>
              <option value="yes">{t("menu.filter.hasRecipe")}</option>
              <option value="no">{t("menu.filter.noRecipe")}</option>
            </Select>
            <Select className="h-10" value={filters.image} onChange={(e) => setFilter("image", e.target.value as TriState)} aria-label={t("menu.filter.imageAll")}>
              <option value="">{t("menu.filter.imageAll")}</option>
              <option value="yes">{t("menu.filter.hasImage")}</option>
              <option value="no">{t("menu.filter.noImage")}</option>
            </Select>
            <Checkbox checked={filters.missingNameEn} onChange={(e) => setFilter("missingNameEn", e.target.checked)} label={t("menu.filter.missingNameEn")} />
            <Checkbox checked={filters.negativeMargin} onChange={(e) => setFilter("negativeMargin", e.target.checked)} label={t("menu.filter.negativeMargin")} />
          </div>
        }
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            {canPrice && (
              <IconButton size="sm" aria-label={t("menu.rowAction.editPrice")} onClick={() => setPriceItem(r)}>
                <Tag className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton size="sm" aria-label={t("menu.rowAction.priceHistory")} onClick={() => setHistoryItem(r)}>
              <History className="h-4 w-4" />
            </IconButton>
            {canManage && (
              <IconButton size="sm" aria-label={t("menu.rowAction.edit")} onClick={() => goEdit(r.id)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
            {canManage && (
              <IconButton size="sm" aria-label={t("common.delete")} onClick={() => setDeleteItem(r)}>
                <Trash2 className="h-4 w-4 text-rose-500" />
              </IconButton>
            )}
          </div>
        )}
      />

      {priceItem && <PriceEditDialog item={priceItem} onClose={() => setPriceItem(null)} />}
      {historyItem && <PriceHistoryDrawer item={historyItem} onClose={() => setHistoryItem(null)} />}

      <ConfirmDialog
        open={!!deleteItem}
        title={t("common.delete")}
        description={deleteItem ? pickName(deleteItem.name, deleteItem.nameEn, lang) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onClose={() => { if (!del.isPending) setDeleteItem(null); }}
        onConfirm={() => {
          if (!deleteItem) return;
          del.mutate(deleteItem.id, {
            onSuccess: () => { toast({ title: t("common.delete"), tone: "success" }); setDeleteItem(null); },
            onError: (e: Error) => toast({ title: t("states.unexpectedError"), description: e.message, tone: "error" }),
          });
        }}
      />
    </div>
  );
}
