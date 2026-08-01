/**
 * SCREEN 2 — /menu/recipes/:source/:productId · the full-page recipe.
 *
 * A real ROUTE, not a drawer: a recipe is a document with seven facets (header,
 * components, cost, production, availability, where-used, versions) and a
 * lifecycle, and none of that survives being squeezed into a side panel you
 * cannot deep-link, refresh or share.
 *
 * THE RULE THIS PAGE EXISTS TO MAKE VISIBLE: an ACTIVE recipe is never edited in
 * place. Production and sale-time deduction are running against it, so the
 * server turns a save into a NEW DRAFT REVISION. That is announced in a banner
 * BEFORE the user types, not discovered afterwards from a version number that
 * changed behind their back.
 *
 * Concurrency: every write carries `expectedVersion` (= `rowVersion`, the
 * optimistic-lock token — deliberately NOT the user-facing `version`). A 409
 * (VERSION_CONFLICT / RECIPE_IMMUTABLE) is surfaced as a banner with a real
 * reload affordance; it never silently retries, and it never overwrites the
 * other person's work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ImageOff, RefreshCw, Save, Undo2 } from "lucide-react";
import { ApiError } from "@/shared/api";
import { Badge, Button, ErrorState, LoadingState, PageHeader, Tabs, useToast } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
import { useUnsavedGuard } from "@/shared/forms";
import { formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import {
  productImageUrl,
  useAvailability,
  useComponentUnits,
  useRecipeDetail,
  useRecipeMeta,
  useRecipeMutations,
  useWarehouseOptions,
  type ComponentUnit,
  type RecipeDetailPayload,
  type RecipeVersionRow,
} from "@/modules/menu/recipesApi";
import {
  batchCost as draftBatchCostOf,
  draftFromRecipe,
  serializeDraft,
  toSaveLines,
  type DraftHeader,
  type DraftLine,
  type RecipeDraft,
} from "./draft";
import { bizName, statusLabel, statusTone, typeLabel } from "./labels";
import { OverviewTab } from "./OverviewTab";
import { ComponentsTab } from "./ComponentsTab";
import { CostTab } from "./CostTab";
import { ProductionTab } from "./ProductionTab";
import { AvailabilityTab } from "./AvailabilityTab";
import { WhereUsedTab } from "./WhereUsedTab";
import { VersionsTab } from "./VersionsTab";

const TAB_IDS = ["overview", "components", "cost", "production", "availability", "whereUsed", "versions"] as const;
type TabId = (typeof TAB_IDS)[number];

type ConflictKind = "conflict" | "immutable" | null;

function payloadKey(data: RecipeDetailPayload): string {
  return `${data.productSource}:${data.productId}:${data.recipe?.bomId ?? "none"}:${data.recipe?.rowVersion ?? 0}`;
}

export function RecipeDetailPage({ source, productId }: { source: string; productId: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const canEdit = useCan("menu.recipes.manage");
  const canSeeCostCap = useCan("menu.cost.view");

  const detail = useRecipeDetail(source, productId);
  const meta = useRecipeMeta();
  const warehouses = useWarehouseOptions();
  const mutations = useRecipeMutations(source, productId);

  const data = detail.data ?? null;
  const recipe = data?.recipe ?? null;
  const product = data?.product ?? null;
  const canViewCost = (data?.canViewCost ?? true) && canSeeCostCap;

  // ── the editable draft + its baseline (value identity drives `dirty`) ──
  const empty = useMemo(() => draftFromRecipe(null, null), []);
  const [draft, setDraft] = useState<RecipeDraft>(empty);
  const [baseline, setBaseline] = useState<string>(() => serializeDraft(empty));
  const dirty = serializeDraft(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedRef = useRef("");
  useUnsavedGuard(dirty);

  const applyServer = useCallback((payload: RecipeDetailPayload) => {
    const next = draftFromRecipe(payload.recipe, payload.product);
    loadedRef.current = payloadKey(payload);
    setDraft(next);
    setBaseline(serializeDraft(next));
  }, []);

  useEffect(() => {
    if (!data) return;
    if (payloadKey(data) === loadedRef.current) return;
    // A background refetch must never silently discard unsaved edits — that is
    // what the conflict banner (and its explicit Reload) is for.
    if (loadedRef.current && dirtyRef.current) return;
    applyServer(data);
  }, [data, applyServer]);

  // ── conflict / lifecycle state ──
  const [conflict, setConflict] = useState<ConflictKind>(null);
  const [extraUnits, setExtraUnits] = useState<Record<string, ComponentUnit[]>>({});
  const [whereUsedItem, setWhereUsedItem] = useState("");
  const [availWarehouse, setAvailWarehouse] = useState("");
  const [availBatches, setAvailBatches] = useState(1);

  // Registered units for the components already on the recipe (a saved line only
  // carries the unit it was saved with, never the component's whole unit set).
  const uniqueComponents = useMemo(() => {
    const seen = new Map<string, { itemId: string; name: string }>();
    for (const l of draft.lines) if (!seen.has(l.componentItemId)) seen.set(l.componentItemId, { itemId: l.componentItemId, name: l.itemName });
    return [...seen.values()];
  }, [draft.lines]);
  const loadedUnits = useComponentUnits(uniqueComponents);
  const unitsByItem = useMemo(() => ({ ...loadedUnits, ...extraUnits }), [loadedUnits, extraUnits]);

  const availability = useAvailability(recipe?.bomId ?? null, availWarehouse, availBatches);
  const availabilityByItem = useMemo(() => {
    const map: Record<string, number> = {};
    for (const it of availability.data?.items ?? []) map[it.itemId] = it.available;
    return map;
  }, [availability.data]);

  const tab = (TAB_IDS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as TabId) : "overview";
  const setTab = (next: string) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("tab", next);
        return p;
      },
      { replace: true },
    );

  const brandName = useMemo(() => {
    const b = (meta.data?.brands ?? []).find((x) => x.id === product?.brandId);
    return b ? bizName(lang, b.name, b.nameEn) : "";
  }, [meta.data, product?.brandId, lang]);

  const status = recipe?.status ?? "none";
  /**
   * An archived version is immutable server-side (RECIPE_IMMUTABLE), so offering
   * its fields for editing would guarantee a 409 the user could not have
   * predicted. The version list stays fully actionable — clone is the way out.
   */
  const editable = canEdit && status !== "archived";
  const nextVersion = useMemo(
    () => (data?.versions ?? []).reduce((m, v) => Math.max(m, Number(v.version) || 1), 0) + 1,
    [data?.versions],
  );

  const setHeader = (patch: Partial<DraftHeader>) => setDraft((d) => ({ ...d, header: { ...d.header, ...patch } }));
  const setLines = (lines: DraftLine[]) => setDraft((d) => ({ ...d, lines }));

  // ── writes ────────────────────────────────────────────────────────────────
  function handleApiError(e: unknown) {
    if (e instanceof ApiError && (e.code === "VERSION_CONFLICT" || e.code === "RECIPE_IMMUTABLE" || e.status === 409)) {
      setConflict(e.code === "RECIPE_IMMUTABLE" ? "immutable" : "conflict");
      return;
    }
    toast({
      tone: "error",
      title: t("recipes.detail.toast.failed"),
      description: e instanceof Error ? e.message : undefined,
    });
  }

  async function reload() {
    setConflict(null);
    const res = await detail.refetch();
    if (res.data) applyServer(res.data);
  }

  async function handleSave() {
    if (draft.lines.length === 0) {
      toast({ tone: "warning", title: t("recipes.detail.toast.needLines") });
      return;
    }
    if (!(Number(draft.header.yieldQuantity) > 0)) {
      toast({ tone: "warning", title: t("recipes.detail.toast.needYield") });
      return;
    }
    setConflict(null);
    try {
      const res = await mutations.save.mutateAsync({
        bomId: recipe?.bomId ?? null,
        expectedVersion: recipe ? recipe.rowVersion : null,
        yieldQuantity: Number(draft.header.yieldQuantity),
        yieldUnit: draft.header.yieldUnit,
        effectiveFrom: draft.header.effectiveFrom || null,
        effectiveTo: draft.header.effectiveTo || null,
        notes: draft.header.notes,
        consumptionWarehouseId: draft.header.consumptionWarehouseId || null,
        needsReview: draft.header.needsReview,
        lines: toSaveLines(draft.lines),
      });
      toast({
        tone: "success",
        title:
          res?.action === "revise"
            ? t("recipes.detail.toast.savedRevision", { version: String(res.version) })
            : res?.action === "create"
              ? t("recipes.detail.toast.savedDraft")
              : t("recipes.detail.toast.savedEdit"),
      });
      loadedRef.current = "";
      const fresh = await detail.refetch();
      if (fresh.data) applyServer(fresh.data);
    } catch (e) {
      handleApiError(e);
    }
  }

  async function lifecycle(kind: "activate" | "clone" | "archive", version: RecipeVersionRow) {
    setConflict(null);
    try {
      if (kind === "activate") await mutations.activate.mutateAsync({ bomId: version.bomId, expectedVersion: version.rowVersion });
      else if (kind === "archive") await mutations.archive.mutateAsync({ bomId: version.bomId, expectedVersion: version.rowVersion });
      else await mutations.clone.mutateAsync({ bomId: version.bomId });
      toast({
        tone: "success",
        title:
          kind === "activate"
            ? t("recipes.detail.toast.activated")
            : kind === "archive"
              ? t("recipes.detail.toast.archived")
              : t("recipes.detail.toast.cloned"),
      });
      loadedRef.current = "";
      const fresh = await detail.refetch();
      if (fresh.data) applyServer(fresh.data);
    } catch (e) {
      handleApiError(e);
    }
  }

  // ── states ────────────────────────────────────────────────────────────────
  if (detail.isLoading) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  if (!product) {
    return (
      <div data-state="not-found" className="surface grid place-items-center gap-2 p-12 text-center">
        <div className="text-base font-extrabold text-slate-800">{t("recipes.detail.notFound")}</div>
        <p className="max-w-md text-sm font-medium text-slate-500">{t("recipes.detail.notFoundBody")}</p>
        <Button variant="secondary" onClick={() => navigate("/menu/recipes")}>
          <ArrowRight className="h-4 w-4" /> {t("recipes.detail.back")}
        </Button>
      </div>
    );
  }

  const imageSrc = productImageUrl(source, productId, product.imageVersion);
  const busy =
    mutations.save.isPending || mutations.activate.isPending || mutations.clone.isPending || mutations.archive.isPending;

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow={t("recipes.eyebrow")}
        title={bizName(lang, product.name, product.nameEn)}
        subtitle={product.nameEn && lang !== "en" ? product.nameEn : undefined}
        action={
          <>
            <Button variant="secondary" onClick={() => navigate("/menu/recipes")}>
              <ArrowRight className="h-4 w-4" /> {t("recipes.detail.back")}
            </Button>
            {editable && dirty && (
              <Button variant="secondary" onClick={() => data && applyServer(data)}>
                <Undo2 className="h-4 w-4" /> {t("recipes.detail.actions.discard")}
              </Button>
            )}
            {editable && (
              <Button variant="primary" onClick={handleSave} loading={mutations.save.isPending} disabled={!dirty || busy}>
                <Save className="h-4 w-4" />
                {mutations.save.isPending ? t("recipes.detail.actions.saving") : t("recipes.detail.actions.save")}
              </Button>
            )}
          </>
        }
      />

      {/* ── identity strip ── */}
      <section className="surface mb-4 flex flex-wrap items-center gap-4 p-4">
        {imageSrc ? (
          <img src={imageSrc} alt="" className="h-16 w-16 rounded-xl border border-slate-200 object-cover" />
        ) : (
          <span className="grid h-16 w-16 place-items-center rounded-xl bg-slate-100 text-slate-400" title={t("recipes.noImage")}>
            <ImageOff className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">{t("recipes.noImage")}</span>
          </span>
        )}
        <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <Meta label={t("recipes.detail.head.sku")}>
            <span dir="ltr" className="font-mono text-xs">
              {product.sku || product.id}
            </span>
          </Meta>
          <Meta label={t("recipes.col.nameEn")}>
            <span dir="ltr">{product.nameEn || t("recipes.detail.head.none")}</span>
          </Meta>
          <Meta label={t("recipes.detail.head.type")}>{typeLabel(t, product.productType)}</Meta>
          <Meta label={t("recipes.detail.head.brand")}>{brandName || t("recipes.detail.head.none")}</Meta>
          <Meta label={t("recipes.detail.head.category")}>{product.category || t("recipes.detail.head.none")}</Meta>
          <Meta label={t("recipes.detail.head.status")}>
            <span className="inline-flex flex-wrap items-center gap-1">
              <Badge tone={statusTone(status)}>{statusLabel(t, status)}</Badge>
              {recipe && (
                <Badge tone="neutral">
                  {t("recipes.detail.head.version")} {formatNumber(recipe.version)}
                </Badge>
              )}
              {dirty && <Badge tone="warning">{t("recipes.detail.dirty")}</Badge>}
            </span>
          </Meta>
        </dl>
      </section>

      {/* ── the revision / conflict banners ── */}
      {conflict && (
        <div
          role="alert"
          data-testid="recipe-conflict"
          data-state="conflict"
          className="surface mb-4 flex flex-wrap items-center justify-between gap-3 border-rose-200 bg-rose-50 p-4"
        >
          <div className="min-w-0">
            <div className="text-sm font-extrabold text-rose-800">
              {conflict === "immutable" ? t("recipes.detail.banner.immutableTitle") : t("recipes.detail.banner.conflictTitle")}
            </div>
            <p className="mt-1 text-sm font-medium text-rose-700">
              {conflict === "immutable" ? t("recipes.detail.banner.immutableBody") : t("recipes.detail.banner.conflictBody")}
            </p>
          </div>
          <Button variant="secondary" data-testid="recipe-conflict-reload" onClick={reload}>
            <RefreshCw className="h-4 w-4" /> {t("recipes.detail.banner.reload")}
          </Button>
        </div>
      )}

      {!conflict && canEdit && status === "active" && (
        <Notice
          testId="recipe-revision-banner"
          tone="amber"
          title={t("recipes.detail.banner.revisionTitle")}
          body={t("recipes.detail.banner.revisionBody", {
            next: String(nextVersion),
            current: String(recipe?.version ?? 1),
          })}
        />
      )}
      {!conflict && canEdit && status === "draft" && (
        <Notice
          testId="recipe-draft-banner"
          tone="sky"
          title={t("recipes.detail.banner.draftTitle")}
          body={t("recipes.detail.banner.draftBody", { current: String(recipe?.version ?? 1) })}
        />
      )}
      {!conflict && status === "archived" && (
        <Notice
          testId="recipe-archived-banner"
          tone="slate"
          title={t("recipes.detail.banner.archivedTitle")}
          body={t("recipes.detail.banner.archivedBody")}
        />
      )}
      {!conflict && !recipe && (
        <Notice
          testId="recipe-none-banner"
          tone="amber"
          title={t("recipes.detail.noRecipe.title")}
          body={t("recipes.detail.noRecipe.body")}
        />
      )}

      <Tabs
        aria-label={t("recipes.detail.tabs.overview")}
        value={tab}
        onChange={setTab}
        items={TAB_IDS.map((id) => ({ value: id, label: t(`recipes.detail.tabs.${id}`) }))}
        className="mb-4"
      />

      {tab === "overview" && (
        <OverviewTab
          header={draft.header}
          onChange={setHeader}
          recipe={recipe}
          product={product}
          lineCount={draft.lines.length}
          canEdit={editable}
          canViewCost={canViewCost}
        />
      )}
      {tab === "components" && (
        <ComponentsTab
          lines={draft.lines}
          onChange={setLines}
          unitsByItem={unitsByItem}
          onUnitsDiscovered={(itemId, units) => setExtraUnits((prev) => ({ ...prev, [itemId]: units }))}
          availabilityByItem={availabilityByItem}
          canEdit={editable}
          canViewCost={canViewCost}
        />
      )}
      {tab === "cost" && (
        <CostTab
          cost={recipe?.cost ?? null}
          canViewCost={canViewCost}
          hasRecipe={!!recipe}
          draftBatchCost={draftBatchCostOf(draft.lines)}
          draftUnitCost={
            draftBatchCostOf(draft.lines) == null || !(Number(draft.header.yieldQuantity) > 0)
              ? null
              : (draftBatchCostOf(draft.lines) as number) / Number(draft.header.yieldQuantity)
          }
          dirty={dirty}
        />
      )}
      {tab === "production" && (
        <ProductionTab
          lines={draft.lines}
          outputs={recipe?.outputs ?? []}
          consumptionWarehouseId={draft.header.consumptionWarehouseId}
          onWarehouseChange={(id) => setHeader({ consumptionWarehouseId: id })}
          warehouses={warehouses.data ?? []}
          canEdit={editable}
        />
      )}
      {tab === "availability" && (
        <AvailabilityTab
          bomId={recipe?.bomId ?? null}
          warehouses={warehouses.data ?? []}
          warehouseId={availWarehouse}
          onWarehouseChange={setAvailWarehouse}
          batches={availBatches}
          onBatchesChange={setAvailBatches}
        />
      )}
      {tab === "whereUsed" && (
        <WhereUsedTab lines={draft.lines} selectedItemId={whereUsedItem} onSelect={setWhereUsedItem} />
      )}
      {tab === "versions" && (
        <VersionsTab
          versions={data?.versions ?? []}
          canEdit={canEdit}
          canViewCost={canViewCost}
          busy={busy}
          onActivate={(v) => lifecycle("activate", v)}
          onClone={(v) => lifecycle("clone", v)}
          onArchive={(v) => lifecycle("archive", v)}
        />
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words font-semibold text-slate-800">{children}</dd>
    </div>
  );
}

const NOTICE_TONE = {
  amber: { box: "border-amber-200 bg-amber-50", title: "text-amber-800", body: "text-amber-700" },
  sky: { box: "border-sky-200 bg-sky-50", title: "text-sky-800", body: "text-sky-700" },
  slate: { box: "border-slate-200 bg-slate-50", title: "text-slate-800", body: "text-slate-600" },
} as const;

function Notice({
  testId,
  tone,
  title,
  body,
}: {
  testId: string;
  tone: keyof typeof NOTICE_TONE;
  title: string;
  body: string;
}) {
  const s = NOTICE_TONE[tone];
  return (
    <div data-testid={testId} className={`surface mb-4 p-4 ${s.box}`}>
      <div className={`text-sm font-extrabold ${s.title}`}>{title}</div>
      <p className={`mt-1 text-sm font-medium ${s.body}`}>{body}</p>
    </div>
  );
}
