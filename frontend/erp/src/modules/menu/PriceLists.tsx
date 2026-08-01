import { useMemo, useState } from "react";
import { Calculator, Coins } from "lucide-react";
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
  useRoundToWholeRiyal,
  menuErrorText,
  type MenuItem,
  type BulkPriceInput,
  type BulkPriceResult,
  type WholeRiyalResult,
} from "./api";
import { Money, marginPct, useBrandScope, BrandSelect, pickName } from "./lib";

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

/**
 * «ضبط الأسعار على ريالات كاملة».
 *
 * The cashier card advertises the VAT-INCLUSIVE price, and stored prices are
 * net — so a row stored at 30.4261 shows 34.99. The fix is to tune the STORED
 * price (30.4348 → shows 35), never to round at display time: a display-only
 * round would say 35 on screen while the invoice said 34.99, which is the very
 * gap this feature exists to close.
 *
 * The sweep already exists as scripts/round-prices-to-whole-riyal.js. This card
 * is here because the owner does not use a terminal — same shared logic
 * (lib/wholeRiyalSweep), reached through POST /menu/round-to-whole-riyal.
 *
 * PREVIEW FIRST, ALWAYS. The button fetches the plan WITHOUT writing (the
 * server defaults `apply` to false), the dialog lists every before → after, and
 * only the dialog's own button applies it. This moves real selling prices by up
 * to 0.50 SAR a unit; it is not something to trigger from a single tap.
 */
function WholeRiyalCard() {
  const t = useT();
  const { toast } = useToast();
  const sweep = useRoundToWholeRiyal();
  const [preview, setPreview] = useState<WholeRiyalResult | null>(null);

  function runPreview() {
    sweep.mutate(
      {},
      {
        onSuccess: (res) => setPreview(res),
        onError: (e: Error) =>
          toast({ title: t("menuRest.wholeRiyal.failed"), description: menuErrorText(e, t), tone: "error" }),
      },
    );
  }

  function applyNow() {
    sweep.mutate(
      { apply: true },
      {
        onSuccess: (res) => {
          setPreview(null);
          toast({ title: t("menuRest.wholeRiyal.appliedToast", { count: res.affected }), tone: "success" });
        },
        onError: (e: Error) =>
          toast({ title: t("menuRest.wholeRiyal.failed"), description: menuErrorText(e, t), tone: "error" }),
      },
    );
  }

  return (
    <>
      <Card className="mt-6 p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800">{t("menuRest.wholeRiyal.title")}</h3>
            <p className="mt-1 text-xs font-medium text-slate-500">{t("menuRest.wholeRiyal.subtitle")}</p>
          </div>
          <Can cap="menu.pricing.manage" fallback={<p className="text-xs font-medium text-slate-400">{t("menuRest.priceLists.needPricePermission")}</p>}>
            <Button variant="secondary" disabled={sweep.isPending} onClick={runPreview}>
              <Coins className="h-4 w-4" />
              {sweep.isPending && !preview ? t("menuRest.wholeRiyal.previewing") : t("menuRest.wholeRiyal.previewButton")}
            </Button>
          </Can>
        </div>
      </Card>

      {preview && (
        <WholeRiyalDialog
          preview={preview}
          applying={sweep.isPending}
          onApply={applyNow}
          onClose={() => { if (!sweep.isPending) setPreview(null); }}
        />
      )}
    </>
  );
}

function WholeRiyalDialog({
  preview, applying, onApply, onClose,
}: { preview: WholeRiyalResult; applying: boolean; onApply: () => void; onClose: () => void }) {
  const t = useT();
  const hasChanges = preview.items.length > 0;
  const sourceLabel = (s: string) =>
    s === "price_list_items" ? t("menuRest.wholeRiyal.sourcePriceList")
    : s === "channel_menu_items" ? t("menuRest.wholeRiyal.sourceChannel")
    : t("menuRest.wholeRiyal.sourceMenu");

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("menuRest.wholeRiyal.dialogTitle")}
      description={
        hasChanges
          ? t("menuRest.wholeRiyal.dialogDesc", { count: preview.items.length })
          : t("menuRest.wholeRiyal.dialogDescEmpty")
      }
      size="lg"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onClose} disabled={applying}>{t("common.cancel")}</Button>
          {hasChanges && (
            <Button onClick={onApply} disabled={applying}>
              {applying ? t("menuRest.wholeRiyal.applying") : t("menuRest.wholeRiyal.applyButton")}
            </Button>
          )}
        </div>
      }
    >
      {hasChanges && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
          {t("menuRest.wholeRiyal.revenueWarning")}
        </p>
      )}

      <div className="max-h-80 overflow-y-auto">
        <ul className="divide-y divide-slate-100">
          {preview.items.map((it) => (
            <li key={it.source + ":" + it.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-slate-700">{it.name}</span>
                <span className="text-[11px] font-medium text-slate-400">{sourceLabel(it.source)}</span>
              </span>
              {/* The CUSTOMER-FACING amounts, not the stored net ones: this is
                  the number the owner sees on the till and asked about. */}
              <span className="flex shrink-0 items-center gap-2 text-sm">
                <Money value={it.showsNow} className="text-slate-400 line-through" />
                <span className="text-slate-300">←</span>
                <Money value={it.shows} className="font-extrabold text-emerald-700" />
              </span>
            </li>
          ))}
        </ul>
      </div>

      {preview.review.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <p className="mb-2 text-xs font-extrabold text-amber-800">
            {t("menuRest.wholeRiyal.reviewTitle", { count: preview.review.length })}
          </p>
          <ul className="max-h-32 space-y-1 overflow-y-auto">
            {preview.review.map((r) => (
              <li key={r.source + ":" + r.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate font-bold text-slate-700">{r.name}</span>
                <Money value={r.oldPrice} className="shrink-0 text-slate-500" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
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
