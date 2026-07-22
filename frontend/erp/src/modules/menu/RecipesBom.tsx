import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChefHat, Save } from "lucide-react";
import {
  PageHeader,
  Card,
  Button,
  IconButton,
  Input,
  NumberInput,
  SearchableEntityCombobox,
  EmptyState,
  LoadingState,
  ErrorState,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can, useCan } from "@/shared/permissions";
import { useT, useLang } from "@/i18n";
import {
  useBrands,
  useMenuItems,
  useInventoryItems,
  useRecipes,
  useRecipeBom,
  useSaveRecipeBom,
  makeInvItemFetcher,
  makeMenuItemFetcher,
  menuErrorText,
  type MenuItem,
  type InvItem,
  type RecipeBomInput,
} from "./api";
import { Money, useBrandScope, useItemScope, BrandSelect, useFmt, pickName } from "./lib";

interface EditLine {
  key: string;
  componentItemId: string;
  itemName: string;
  unit: string;
  quantity: number | null;
  wastePct: number | null;
  avgCost: number;
}

let _seq = 0;
const nextKey = () => `ln-${Date.now()}-${_seq++}`;

export function RecipesBom() {
  const t = useT();
  const lang = useLang();
  const { brandId, setBrandId } = useBrandScope();
  const { itemId, setItemId } = useItemScope();

  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ brandId: brandId || undefined, type: "all" });
  const recipesQ = useRecipes();

  const menuItems = useMemo(
    () => (itemsQ.data ?? []).filter((i) => !i.isCombo && !i.isSemiFinished),
    [itemsQ.data],
  );
  // menuIds that already carry a (legacy or modern) recipe → surfaced in the
  // picker so the user sees which items still need one.
  const withRecipe = useMemo(() => new Set((recipesQ.data ?? []).map((r) => r.menuId)), [recipesQ.data]);
  const hasRecipe = (i: MenuItem) => !!i.bomId || withRecipe.has(i.id);
  const selectedItem = useMemo(() => menuItems.find((i) => i.id === itemId) ?? null, [menuItems, itemId]);

  return (
    <div>
      <PageHeader
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.recipes.title")}
        subtitle={t("menuRest.recipes.subtitle")}
      />

      <Card className="mb-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
        <div className="w-full sm:w-56">
          <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.fields.brand")}</label>
          <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={(v) => { setBrandId(v); setItemId(""); }} className="w-full" />
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs font-bold text-slate-600">{t("menuRest.fields.item")}</label>
          <SearchableEntityCombobox<MenuItem>
            value={selectedItem}
            onChange={(v) => setItemId(v?.id ?? "")}
            fetcher={makeMenuItemFetcher(menuItems)}
            queryKey={["menu", "recipe-item-picker", brandId]}
            getKey={(i) => i.id}
            getLabel={(i) => pickName(i.name, i.nameEn, lang)}
            getSublabel={(i) => [i.category, hasRecipe(i) ? t("menuRest.recipes.hasRecipe") : t("menuRest.recipes.noRecipe")].filter(Boolean).join(" · ") || undefined}
            placeholder={t("menuRest.recipes.searchItemPlaceholder")}
            ariaLabel={t("menuRest.aria.selectItem")}
            emptyText={t("menuRest.combobox.noItems")}
          />
        </div>
      </Card>

      {itemsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : !selectedItem ? (
        <EmptyState icon={<ChefHat className="h-6 w-6" />} title={t("menuRest.recipes.pickItemTitle")} body={t("menuRest.recipes.pickItemBody")} />
      ) : (
        <RecipeEditor key={selectedItem.id} item={selectedItem} brandId={brandId} />
      )}
    </div>
  );
}

function RecipeEditor({ item, brandId }: { item: MenuItem; brandId: string }) {
  const t = useT();
  const fmt = useFmt();
  const { toast } = useToast();
  const canManage = useCan("menu.recipes.manage");
  const bomQ = useRecipeBom(item.id);
  const invQ = useInventoryItems(brandId || undefined);
  const save = useSaveRecipeBom();

  const [lines, setLines] = useState<EditLine[]>([]);
  const [yieldQty, setYieldQty] = useState<number | null>(1);
  const [yieldUnit, setYieldUnit] = useState("PCS");
  const [notes, setNotes] = useState("");

  // Hydrate local state from the loaded BOM.
  useEffect(() => {
    if (!bomQ.data) return;
    setLines(
      bomQ.data.lines.map((l) => ({
        key: nextKey(),
        componentItemId: l.componentItemId,
        itemName: l.itemName,
        unit: l.unit || "PCS",
        quantity: l.quantity,
        wastePct: l.wastePct,
        avgCost: l.avgCost,
      })),
    );
    setYieldQty(bomQ.data.yieldQuantity || 1);
    setYieldUnit(bomQ.data.yieldUnit || "PCS");
    setNotes("");
  }, [bomQ.data]);

  const invItems = invQ.data ?? [];
  const fetcher = useMemo(() => makeInvItemFetcher(invItems), [invItems]);

  const lineCost = (l: EditLine) => (Number(l.quantity) || 0) * (l.avgCost || 0) * (1 + (Number(l.wastePct) || 0) / 100);
  const totalCost = lines.reduce((s, l) => s + lineCost(l), 0);
  const unitCost = totalCost / Math.max(1, Number(yieldQty) || 1);

  function addLine() {
    setLines((prev) => [...prev, { key: nextKey(), componentItemId: "", itemName: "", unit: "PCS", quantity: 1, wastePct: 0, avgCost: 0 }]);
  }
  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }
  function patchLine(key: string, patch: Partial<EditLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function pickComponent(key: string, inv: InvItem | null) {
    if (!inv) { patchLine(key, { componentItemId: "", itemName: "", avgCost: 0 }); return; }
    patchLine(key, { componentItemId: inv.id, itemName: inv.name, unit: inv.unit || "PCS", avgCost: inv.cost });
  }

  const invalidLines = lines.filter((l) => !l.componentItemId || !(Number(l.quantity) > 0));
  const canSave = canManage && lines.length > 0 && invalidLines.length === 0 && (Number(yieldQty) || 0) > 0;

  function submit() {
    const input: RecipeBomInput = {
      yieldQuantity: Number(yieldQty) || 1,
      yieldUnit: yieldUnit || "PCS",
      notes: notes || undefined,
      lines: lines.map((l) => ({
        componentItemId: l.componentItemId,
        quantity: Number(l.quantity) || 0,
        unit: l.unit || "PCS",
        wastePct: Number(l.wastePct) || 0,
      })),
    };
    save.mutate(
      { menuId: item.id, input },
      {
        onSuccess: (res) => toast({ title: t("menuRest.recipes.savedTitle"), description: res.computedCost != null ? t("menuRest.recipes.computedCost", { cost: fmt.money(res.computedCost) }) : undefined, tone: "success" }),
        onError: (e: Error) => toast({ title: t("menuRest.recipes.saveFailed"), description: menuErrorText(e, t), tone: "error" }),
      },
    );
  }

  if (bomQ.isLoading) return <LoadingState rows={3} />;
  if (bomQ.isError) return <ErrorState error={bomQ.error} onRetry={() => bomQ.refetch()} />;

  return (
    <div className="space-y-6">
      {bomQ.data?.hasLegacyRecipe && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
          {t("menuRest.recipes.legacyWarning")}
        </div>
      )}

      <Card className="p-5">
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <Field label={t("menuRest.recipes.yieldQty")}>
            {({ id }) => <NumberInput id={id} value={yieldQty} onChange={setYieldQty} min={0.0001} step="any" disabled={!canManage} />}
          </Field>
          <Field label={t("menuRest.recipes.yieldUnit")}>
            {({ id }) => <Input id={id} value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} disabled={!canManage} />}
          </Field>
          <Field label={t("menuRest.recipes.notesOptional")}>
            {({ id }) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canManage} />}
          </Field>
        </div>

        {/* Lines */}
        <div className="space-y-3">
          {lines.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm font-medium text-slate-400">
              {t("menuRest.recipes.noLines")}
            </p>
          )}
          {lines.map((l) => {
            const selected: InvItem | null = l.componentItemId
              ? (invItems.find((i) => i.id === l.componentItemId) ?? {
                  id: l.componentItemId, name: l.itemName, category: "", kind: "", cost: l.avgCost, stock: 0, minStock: 0, unit: l.unit, brandId: "", brandName: "",
                })
              : null;
            const qtyInvalid = !(Number(l.quantity) > 0);
            return (
              <div key={l.key} className="grid grid-cols-1 gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3 md:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem_auto] md:items-center">
                <div className="min-w-0">
                  <SearchableEntityCombobox<InvItem>
                    value={selected}
                    onChange={(v) => pickComponent(l.key, v)}
                    fetcher={fetcher}
                    queryKey={["menu", "recipe-component-picker", brandId]}
                    getKey={(i) => i.id}
                    getLabel={(i) => i.name}
                    getSublabel={(i) => `${i.category || ""}${i.unit ? " · " + i.unit : ""}`.trim() || undefined}
                    placeholder={t("menuRest.recipes.pickComponentPlaceholder")}
                    ariaLabel={t("menuRest.aria.selectComponent")}
                    disabled={!canManage}
                    emptyText={t("menuRest.combobox.noComponents")}
                  />
                </div>
                <NumberInput value={l.quantity} onChange={(v) => patchLine(l.key, { quantity: v })} min={0} step="any" invalid={qtyInvalid} suffix={l.unit} aria-label={t("menuRest.aria.quantity")} disabled={!canManage} />
                <Input value={l.unit} onChange={(e) => patchLine(l.key, { unit: e.target.value })} aria-label={t("menuRest.aria.unit")} disabled={!canManage} />
                <NumberInput value={l.wastePct} onChange={(v) => patchLine(l.key, { wastePct: v })} min={0} step="any" suffix={t("menuRest.units.percent")} aria-label={t("menuRest.recipes.wasteAria")} disabled={!canManage} />
                <div className="flex items-center justify-between gap-2 md:justify-end">
                  <Money value={lineCost(l)} className="text-xs font-bold text-slate-500" />
                  {canManage && (
                    <IconButton size="sm" aria-label={t("menuRest.recipes.deleteComponent")} onClick={() => removeLine(l.key)}>
                      <Trash2 className="h-4 w-4 text-rose-500" />
                    </IconButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {canManage && (
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={addLine}>
              <Plus className="h-4 w-4" /> {t("menuRest.recipes.addComponent")}
            </Button>
          </div>
        )}
      </Card>

      {/* Totals + save */}
      <div className="flex flex-col items-stretch justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-6">
          <div>
            <div className="text-[11px] font-bold text-slate-400">{t("menuRest.recipes.totalCost")}</div>
            <Money value={totalCost} className="text-lg font-extrabold text-slate-800" />
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400">{t("menuRest.recipes.unitCost")}</div>
            <Money value={unitCost} className="text-lg font-extrabold text-slate-800" />
          </div>
        </div>
        <Can cap="menu.recipes.manage">
          <Button onClick={submit} loading={save.isPending} disabled={!canSave}>
            <Save className="h-4 w-4" /> {t("menuRest.recipes.saveRecipe")}
          </Button>
        </Can>
      </div>
      {!canManage && (
        <p className="text-xs font-medium text-slate-400">{t("menuRest.recipes.viewOnly")}</p>
      )}
    </div>
  );
}
