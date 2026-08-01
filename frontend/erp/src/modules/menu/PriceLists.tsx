import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import {
  PageHeader,
  Card,
  Button,
  Select,
  NumberInput,
  Input,
  StatusBadge,
  Dialog,
  ConfirmDialog,
  LoadingState,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field } from "@/shared/forms";
import { Can, useCan } from "@/shared/permissions";
import { useT, useLang } from "@/i18n";
import {
  useBrands,
  useMenuItems,
  useBulkPriceUpdate,
  menuErrorText,
  type MenuItem,
  type BulkPriceInput,
  type BulkPriceResult,
} from "./api";
import { Money, marginPct, useBrandScope, BrandSelect, pickName } from "./lib";
import { WholeRiyalCard } from "./WholeRiyalSweep";

type Mode = "percent" | "fixed_set" | "fixed_add";

export function PriceLists() {
  const t = useT();
  const lang = useLang();
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canPrice = useCan("menu.pricing.manage");

  const MODES = useMemo<{ value: Mode; label: string }[]>(() => [
    { value: "percent", label: t("menuRest.priceLists.modePercent") },
    { value: "fixed_set", label: t("menuRest.priceLists.modeFixedSet") },
    { value: "fixed_add", label: t("menuRest.priceLists.modeFixedAdd") },
  ], [t]);

  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ brandId: brandId || undefined, type: "all" });
  const bulk = useBulkPriceUpdate();

  const rows = useMemo(
    () => (itemsQ.data ?? []).filter((i) => !i.isCombo && !i.isSemiFinished),
    [itemsQ.data],
  );
  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
    [rows],
  );

  const [category, setCategory] = useState("");
  const [mode, setMode] = useState<Mode>("percent");
  const [value, setValue] = useState<number | null>(0);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<BulkPriceResult | null>(null);

  // Table respects the category filter locally (brand filter is server-side).
  const filtered = useMemo(
    () => (category ? rows.filter((r) => r.category === category) : rows),
    [rows, category],
  );

  // Target: explicit selection wins; otherwise the brand/category scope.
  const usingSelection = selected.length > 0;
  const targetCount = usingSelection ? selected.length : filtered.length;
  const hasScope = usingSelection || !!brandId || !!category;
  const valueOk = value != null && Number.isFinite(value);
  const canApply = canPrice && valueOk && hasScope && targetCount > 0;

  const columns = useMemo<ColumnDef<MenuItem>[]>(() => [
    { id: "name", header: t("menuRest.fields.item"), accessor: (r) => pickName(r.name, r.nameEn, lang), sortable: true, cell: (r) => <span className="font-bold text-slate-800">{pickName(r.name, r.nameEn, lang)}</span> },
    { id: "category", header: t("menuRest.fields.category"), accessor: (r) => r.category || "—", sortable: true },
    { id: "price", header: t("menuRest.fields.price"), numeric: true, accessor: (r) => r.price, sortable: true, cell: (r) => <Money value={r.price} /> },
    { id: "cost", header: t("menuRest.fields.cost"), numeric: true, accessor: (r) => r.cost, cell: (r) => <Money value={r.cost} /> },
    {
      id: "margin", header: t("menuRest.fields.margin"), numeric: true, accessor: (r) => marginPct(r.price, r.cost),
      cell: (r) => { const m = marginPct(r.price, r.cost); return <span dir="ltr" className={m > 0 ? "tabular-nums text-emerald-600" : "tabular-nums text-rose-600"}>{m}%</span>; },
    },
    { id: "status", header: t("common.status"), accessor: (r) => t(r.active ? "status.active" : "status.disabled"), cell: (r) => <StatusBadge tone={r.active ? "success" : "neutral"}>{t(r.active ? "status.active" : "status.disabled")}</StatusBadge> },
  ], [t, lang]);

  function apply() {
    const input: BulkPriceInput = usingSelection
      ? { itemIds: selected, mode, value: Number(value), reason: reason || undefined }
      : { brandId: brandId || undefined, categoryFilter: category || undefined, mode, value: Number(value), reason: reason || undefined };
    bulk.mutate(input, {
      onSuccess: (res) => {
        setConfirmOpen(false);
        setResult(res);
        setSelected([]);
        toast({ title: t("menuRest.priceLists.updatedCount", { count: res.affected }), tone: "success" });
      },
      onError: (e: Error) => { setConfirmOpen(false); toast({ title: t("menuRest.priceLists.bulkFailed"), description: menuErrorText(e, t), tone: "error" }); },
    });
  }

  const modeHint =
    mode === "percent" ? t("menuRest.priceLists.hintPercent")
    : mode === "fixed_set" ? t("menuRest.priceLists.hintFixedSet")
    : t("menuRest.priceLists.hintFixedAdd");

  return (
    <div>
      <PageHeader
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.priceLists.title")}
        subtitle={t("menuRest.priceLists.subtitle")}
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
          <Field label={t("menuRest.priceLists.changeType")}>
            {({ id }) => <Select id={id} className="w-full" options={MODES} value={mode} onChange={(e) => setMode(e.target.value as Mode)} />}
          </Field>
          <Field label={mode === "percent" ? t("menuRest.priceLists.percentLabel") : t("menuRest.priceLists.amountLabel")} hint={modeHint}>
            {({ id }) => <NumberInput id={id} value={value} onChange={setValue} step="any" suffix={mode === "percent" ? t("menuRest.units.percent") : t("menuRest.units.sar")} />}
          </Field>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <Field label={t("menuRest.priceLists.reasonOptional")}>
            {({ id }) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("menuRest.priceLists.reasonPlaceholder")} />}
          </Field>
          <Can cap="menu.pricing.manage" fallback={<p className="text-xs font-medium text-slate-400">{t("menuRest.priceLists.needPricePermission")}</p>}>
            <Button disabled={!canApply} onClick={() => setConfirmOpen(true)}>
              <Calculator className="h-4 w-4" />
              {usingSelection ? t("menuRest.priceLists.applyToSelected", { count: selected.length }) : t("menuRest.priceLists.applyToItems", { count: targetCount })}
            </Button>
          </Can>
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
          selectable={canPrice}
          onSelectionChange={setSelected}
          searchable
          searchPlaceholder={t("menuRest.filters.searchByItem")}
          emptyTitle={t("menuRest.filters.noItemsTitle")}
          emptyBody={t("menuRest.priceLists.emptyBody")}
          mobileTitle={(r) => pickName(r.name, r.nameEn, lang)}
          bulkActions={canPrice ? (ids) => (
            <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!valueOk}>
              <Calculator className="h-4 w-4" /> {t("menuRest.priceLists.applyToN", { count: ids.length })}
            </Button>
          ) : undefined}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t("menuRest.priceLists.confirmTitle")}
        description={
          usingSelection
            ? t("menuRest.priceLists.confirmSelected", { count: selected.length })
            : t("menuRest.priceLists.confirmScope", {
                count: targetCount,
                scope: (brandId ? t("menuRest.priceLists.scopeBrand") : t("menuRest.priceLists.scopeAllBrands")) + (category ? " · " + category : ""),
              })
        }
        confirmLabel={t("common.apply")}
        processing={bulk.isPending}
        error={bulk.isError ? menuErrorText(bulk.error, t) : null}
        onClose={() => { if (!bulk.isPending) setConfirmOpen(false); }}
        onConfirm={apply}
      />

      {result && <ResultDialog result={result} onClose={() => setResult(null)} />}
      <WholeRiyalCard />
    </div>
  );
}

function ResultDialog({ result, onClose }: { result: BulkPriceResult; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("menuRest.priceLists.resultTitle")}
      description={t("menuRest.priceLists.resultDesc", { count: result.affected })}
      size="lg"
      footer={<Button onClick={onClose}>{t("menuRest.actions.done")}</Button>}
    >
      {result.items.length === 0 ? (
        <p className="text-sm font-medium text-slate-500">{t("menuRest.priceLists.noChanges")}</p>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <ul className="divide-y divide-slate-100">
            {result.items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-sm font-bold text-slate-700">{it.name}</span>
                <span className="flex items-center gap-2 text-sm">
                  <Money value={it.oldPrice} className="text-slate-400 line-through" />
                  <span className="text-slate-300">←</span>
                  <Money value={it.newPrice} className="font-extrabold text-slate-800" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
