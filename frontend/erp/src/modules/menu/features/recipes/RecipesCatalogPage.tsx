/**
 * SCREEN 1 — /menu/recipes · the recipe CATALOG.
 *
 * A server-mode DataTable over GET /api/recipes. Every list control (search,
 * facets, page, page size, sort) lives in the URL so it survives the round-trip
 * into a recipe and back.
 *
 * THE HEADLINE: this lists PRODUCTS, not recipes. A product with no recipe is a
 * first-class row with status "none" — that is the whole point of the screen
 * (the previous /menu/recipes-bom screen could only show products that already
 * had a BOM, so the ones that needed attention were the ones you could not see).
 *
 * Cost columns are gated twice: `requireCap: "menu.cost.view"` resolved through
 * `canColumn`, AND the response's `canViewCost` — the server strips the numbers
 * to null rather than faking them, so a denied user must not see empty cost
 * columns pretending to be data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChefHat, ImageOff, Percent, UtensilsCrossed } from "lucide-react";
import { Badge, Button, MetricCard, PageHeader, Select } from "@/shared/ui";
import { DataTable, Pagination, type ColumnDef } from "@/shared/tables";
import { useDebounce } from "@/shared/hooks";
import { usePermissions, type Capability } from "@/shared/permissions";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import {
  productImageUrl,
  useRecipeCatalog,
  useRecipeMeta,
  type CatalogRow,
} from "@/modules/menu/recipesApi";
import { anomalyLabel, bizName, formatPct, statusLabel, statusTone, typeLabel } from "./labels";

const PAGE_SIZES = [10, 25, 50, 100];
/** The exact sort keys routes/recipes.js accepts (SORTS). Column ids mirror them. */
const SORTABLE = new Set([
  "name",
  "name_en",
  "product_type",
  "category",
  "status",
  "updated_at",
  "selling_price",
  "yield_quantity",
  "version",
]);
const COST_COLUMN_IDS = new Set(["unitCost", "foodCostPct", "marginPct"]);
const SCROLL_KEY = "menu-recipes:scrollY";

export function RecipesCatalogPage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();

  // ── URL is the single source of truth ──
  const q = params.get("q") ?? "";
  const brandId = params.get("brandId") ?? "";
  const category = params.get("category") ?? "";
  const productType = params.get("productType") ?? "";
  const recipeStatus = params.get("recipeStatus") ?? "";
  const missingRecipe = params.get("missingRecipe") === "1";
  const needsReview = params.get("needsReview") === "1";
  const costAnomaly = params.get("costAnomaly") ?? "";
  const sort = SORTABLE.has(params.get("sort") ?? "") ? (params.get("sort") as string) : "name";
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;

  const patch = useCallback(
    (next: Record<string, string | number | null>, resetPage = true) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === "") p.delete(k);
            else p.set(k, String(v));
          }
          if (resetPage && !("page" in next)) p.delete("page");
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // ── debounced search: the input echoes instantly, the URL (and therefore the
  //    request) only follows once the user pauses ──
  const [qInput, setQInput] = useState(q);
  const debouncedQ = useDebounce(qInput, 350);
  useEffect(() => {
    if (debouncedQ !== q) patch({ q: debouncedQ || null });
    // Depending on `q` here would fight the user's own keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const meta = useRecipeMeta();
  const list = useRecipeCatalog({
    q,
    brandId,
    category,
    productType,
    recipeStatus,
    missingRecipe: missingRecipe ? "1" : "",
    needsReview: needsReview ? "1" : "",
    costAnomaly,
    page,
    pageSize,
    sort,
    dir,
  });

  const rows = list.data?.rows ?? [];
  const kpis = list.data?.kpis;
  const total = list.data?.pagination.total ?? 0;
  const totalPages = list.data?.pagination.totalPages ?? 1;
  const serverAllowsCost = list.data?.canViewCost !== false;

  // ── scroll restore across the detail round-trip ──
  useEffect(() => {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      sessionStorage.removeItem(SCROLL_KEY);
      const y = Number(saved);
      requestAnimationFrame(() => window.scrollTo(0, Number.isFinite(y) ? y : 0));
    }
  }, []);
  const openRow = useCallback(
    (row: CatalogRow) => {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
      navigate(`/menu/recipes/${row.productSource}/${encodeURIComponent(row.productId)}`);
    },
    [navigate],
  );

  // ── DataTable owns the sort-header interaction; mirror it to the URL ──
  const initialSort = useMemo<{ columnId: string; dir: "asc" | "desc" }>(() => ({ columnId: sort, dir }), [sort, dir]);
  const lastSort = useRef(`${sort}:${dir}`);
  const onStateChange = useCallback(
    (st: { sort: { columnId: string; dir: "asc" | "desc" } | null }) => {
      const nextCol = st.sort && SORTABLE.has(st.sort.columnId) ? st.sort.columnId : "name";
      const nextDir = st.sort?.dir ?? "asc";
      const key = `${nextCol}:${nextDir}`;
      if (key === lastSort.current) return;
      lastSort.current = key;
      patch({ sort: nextCol, dir: nextDir });
    },
    [patch],
  );

  const dash = t("recipes.dash");

  const columns = useMemo<ColumnDef<CatalogRow>[]>(() => {
    const all: ColumnDef<CatalogRow>[] = [
      {
        id: "image",
        header: t("recipes.col.image"),
        hideable: false,
        mobileHidden: true,
        width: 72,
        cell: (r) => {
          const src = productImageUrl(r.productSource, r.productId, r.imageVersion);
          // No imageVersion → the product genuinely has no image. Rendering an
          // <img> anyway would fire a request that 404s for every such row.
          if (!src) {
            return (
              <span
                className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 text-slate-400"
                title={t("recipes.noImage")}
              >
                <ImageOff className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">{t("recipes.noImage")}</span>
              </span>
            );
          }
          return (
            <img
              src={src}
              alt=""
              loading="lazy"
              className="h-10 w-10 rounded-lg border border-slate-200 object-cover"
            />
          );
        },
      },
      {
        id: "sku",
        header: t("recipes.col.sku"),
        accessor: (r) => r.sku,
        hideable: false,
        cell: (r) => (
          <span dir="ltr" className="font-mono text-xs text-slate-500">
            {r.sku || r.productId}
          </span>
        ),
      },
      {
        id: "name",
        header: t("recipes.col.nameAr"),
        accessor: (r) => r.name,
        sortable: true,
        hideable: false,
        ellipsis: true,
        priority: 1,
        cell: (r) => <span className="font-extrabold text-slate-900">{r.name}</span>,
      },
      {
        id: "name_en",
        header: t("recipes.col.nameEn"),
        accessor: (r) => r.nameEn,
        sortable: true,
        ellipsis: true,
        cell: (r) =>
          r.nameEn ? (
            <span dir="ltr" className="text-slate-700">
              {r.nameEn}
            </span>
          ) : (
            <span className="text-slate-400">{dash}</span>
          ),
      },
      {
        id: "product_type",
        header: t("recipes.col.productType"),
        accessor: (r) => r.productType,
        sortable: true,
        cell: (r) => typeLabel(t, r.productType),
      },
      {
        id: "brand",
        header: t("recipes.col.brand"),
        accessor: (r) => r.brandName,
        cell: (r) => bizName(lang, r.brandName, r.brandNameEn) || dash,
      },
      {
        id: "category",
        header: t("recipes.col.category"),
        accessor: (r) => r.category,
        sortable: true,
        cell: (r) => r.category || dash,
      },
      {
        id: "status",
        header: t("recipes.col.status"),
        accessor: (r) => r.recipeStatus,
        sortable: true,
        hideable: false,
        priority: 2,
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Badge tone={statusTone(r.recipeStatus)}>{statusLabel(t, r.recipeStatus)}</Badge>
            {r.needsReview && <Badge tone="warning">{t("recipes.filter.needsReview")}</Badge>}
          </span>
        ),
      },
      {
        id: "version",
        header: t("recipes.col.version"),
        accessor: (r) => r.version ?? -1,
        sortable: true,
        numeric: true,
        cell: (r) => (r.version == null ? dash : formatNumber(r.version)),
      },
      {
        id: "yield_quantity",
        header: t("recipes.col.yieldQuantity"),
        accessor: (r) => r.yieldQuantity ?? -1,
        sortable: true,
        numeric: true,
        cell: (r) => (r.yieldQuantity == null ? dash : formatNumber(r.yieldQuantity)),
      },
      {
        id: "unit",
        header: t("recipes.col.unit"),
        accessor: (r) => r.yieldUnit || r.unit,
        cell: (r) => r.yieldUnit || r.unit || dash,
      },
      {
        id: "unitCost",
        header: t("recipes.col.unitCost"),
        numeric: true,
        requireCap: "menu.cost.view",
        accessor: (r) => r.unitCost ?? -1,
        cell: (r) => (r.unitCost == null ? dash : formatCurrency(r.unitCost)),
      },
      {
        id: "selling_price",
        header: t("recipes.col.sellingPrice"),
        numeric: true,
        sortable: true,
        accessor: (r) => r.sellingPrice ?? -1,
        cell: (r) => (r.sellingPrice == null ? dash : formatCurrency(r.sellingPrice)),
      },
      {
        id: "foodCostPct",
        header: t("recipes.col.foodCostPct"),
        numeric: true,
        requireCap: "menu.cost.view",
        accessor: (r) => r.foodCostPct ?? -1,
        cellTone: (r) => (r.foodCostPct == null ? undefined : r.foodCostPct >= 60 ? "negative" : undefined),
        cell: (r) => (r.foodCostPct == null ? dash : formatPct(r.foodCostPct)),
      },
      {
        id: "marginPct",
        header: t("recipes.col.marginPct"),
        numeric: true,
        requireCap: "menu.cost.view",
        accessor: (r) => r.marginPct ?? -1,
        cellTone: (r) => (r.marginPct == null ? undefined : r.marginPct < 0 ? "negative" : undefined),
        cell: (r) => (r.marginPct == null ? dash : formatPct(r.marginPct)),
      },
      {
        id: "updated_at",
        header: t("recipes.col.updatedAt"),
        accessor: (r) => r.updatedAt ?? "",
        sortable: true,
        cell: (r) => (r.updatedAt ? formatDate(r.updatedAt) : dash),
      },
    ];
    // Server-side denial wins over the client-side capability: an allowed user
    // on a deny-listed session must not see three columns of empty cells.
    return serverAllowsCost ? all : all.filter((c) => !COST_COLUMN_IDS.has(c.id));
  }, [t, lang, dash, serverAllowsCost]);

  const anomalyOptions = meta.data?.costAnomalies ?? [];
  const typeOptions = meta.data?.productTypes ?? [];
  const statusOptions = meta.data?.recipeStatuses ?? [];

  const hasFacets = !!(q || brandId || category || productType || recipeStatus || costAnomaly || missingRecipe || needsReview);

  const filterBar = (
    <>
      <label className="relative min-w-0 flex-1 sm:min-w-56">
        <span className="sr-only">{t("recipes.catalog.searchPlaceholder")}</span>
        <input
          className="field h-10 w-full py-2"
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder={t("recipes.catalog.searchPlaceholder")}
          aria-label={t("recipes.catalog.searchPlaceholder")}
        />
      </label>
      <Select
        className="h-10 w-auto"
        value={brandId}
        onChange={(e) => patch({ brandId: e.target.value || null })}
        aria-label={t("recipes.filter.brand")}
      >
        <option value="">{t("recipes.filter.allBrands")}</option>
        {(meta.data?.brands ?? []).map((b) => (
          <option key={b.id} value={b.id}>
            {bizName(lang, b.name, b.nameEn)}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={category}
        onChange={(e) => patch({ category: e.target.value || null })}
        aria-label={t("recipes.filter.category")}
      >
        <option value="">{t("recipes.filter.allCategories")}</option>
        {(meta.data?.categories ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={productType}
        onChange={(e) => patch({ productType: e.target.value || null })}
        aria-label={t("recipes.filter.productType")}
      >
        <option value="">{t("recipes.filter.allTypes")}</option>
        {typeOptions.map((ty) => (
          <option key={ty} value={ty}>
            {typeLabel(t, ty)}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={recipeStatus}
        onChange={(e) => patch({ recipeStatus: e.target.value || null })}
        aria-label={t("recipes.filter.status")}
      >
        <option value="">{t("recipes.filter.allStatuses")}</option>
        {statusOptions.map((s) => (
          <option key={s} value={s}>
            {statusLabel(t, s)}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-auto"
        value={costAnomaly}
        onChange={(e) => patch({ costAnomaly: e.target.value || null })}
        aria-label={t("recipes.filter.anomaly")}
      >
        <option value="">{t("recipes.filter.allAnomalies")}</option>
        {anomalyOptions.map((a) => (
          <option key={a} value={a}>
            {anomalyLabel(t, a)}
          </option>
        ))}
      </Select>
      <FilterChip active={missingRecipe} onClick={() => patch({ missingRecipe: missingRecipe ? null : "1" })}>
        {t("recipes.filter.noRecipe")}
      </FilterChip>
      <FilterChip active={needsReview} onClick={() => patch({ needsReview: needsReview ? null : "1" })}>
        {t("recipes.filter.needsReview")}
      </FilterChip>
    </>
  );

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow={t("recipes.eyebrow")}
        title={t("recipes.catalog.title")}
        subtitle={t("recipes.catalog.subtitle")}
      />

      <section className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("recipes.kpi.products")}
          value={formatNumber(kpis?.products ?? 0)}
          note={t("recipes.kpi.productsNote")}
          icon={UtensilsCrossed}
          tone="blue"
        />
        <MetricCard
          label={t("recipes.kpi.withoutRecipe")}
          value={formatNumber(kpis?.withoutRecipe ?? 0)}
          note={t("recipes.kpi.withoutRecipeNote")}
          icon={ChefHat}
          tone="amber"
          onClick={() => patch({ missingRecipe: "1" })}
        />
        <MetricCard
          label={t("recipes.kpi.needsReview")}
          value={formatNumber(kpis?.needsReview ?? 0)}
          note={t("recipes.kpi.needsReviewNote")}
          icon={AlertTriangle}
          tone="rose"
          onClick={() => patch({ needsReview: "1" })}
        />
        <MetricCard
          label={t("recipes.kpi.avgFoodCost")}
          value={kpis?.avgFoodCostPct == null ? t("recipes.kpi.costHidden") : formatPct(kpis.avgFoodCostPct)}
          note={t("recipes.kpi.avgFoodCostNote")}
          icon={Percent}
          tone="teal"
        />
      </section>

      <DataTable<CatalogRow>
        mode="server"
        columns={columns}
        rows={rows}
        rowCount={total}
        getRowId={(r) => `${r.productSource}:${r.productId}`}
        loading={list.isLoading || list.isFetching}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        initialSort={initialSort}
        onStateChange={onStateChange}
        searchable={false}
        paginate={false}
        columnMenu
        tableId="menu-recipes"
        canColumn={(cap) => can(cap as Capability)}
        filterBar={filterBar}
        onRowClick={openRow}
        mobileTitle={(r) => bizName(lang, r.name, r.nameEn)}
        emptyTitle={t("recipes.empty.title")}
        emptyBody={hasFacets ? t("recipes.empty.filtered") : t("recipes.empty.plain")}
      />

      {total > 0 && (
        <div className="surface mt-3">
          <Pagination
            page={page}
            pageCount={totalPages}
            total={total}
            pageSize={pageSize}
            onPageChange={(p) => patch({ page: p }, false)}
            onPageSizeChange={(s) => patch({ pageSize: s })}
            pageSizeOptions={PAGE_SIZES}
          />
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "primary" : "secondary"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="min-h-10"
    >
      {children}
    </Button>
  );
}
