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
import { useBrands, useMenuItems, useBulkPriceUpdate, type MenuItem, type BulkPriceInput, type BulkPriceResult } from "./api";
import { Money, marginPct, useBrandScope, BrandSelect } from "./lib";

type Mode = "percent" | "fixed_set" | "fixed_add";
const MODES: { value: Mode; label: string }[] = [
  { value: "percent", label: "نسبة مئوية (٪ +/−)" },
  { value: "fixed_set", label: "تعيين سعر ثابت" },
  { value: "fixed_add", label: "إضافة مبلغ ثابت" },
];

export function PriceLists() {
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canPrice = useCan("menu.pricing.manage");

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
    { id: "name", header: "الصنف", accessor: (r) => r.name, sortable: true, cell: (r) => <span className="font-bold text-slate-800">{r.name}</span> },
    { id: "category", header: "الفئة", accessor: (r) => r.category || "—", sortable: true },
    { id: "price", header: "السعر", numeric: true, accessor: (r) => r.price, sortable: true, cell: (r) => <Money value={r.price} /> },
    { id: "cost", header: "التكلفة", numeric: true, accessor: (r) => r.cost, cell: (r) => <Money value={r.cost} /> },
    {
      id: "margin", header: "الهامش", numeric: true, accessor: (r) => marginPct(r.price, r.cost),
      cell: (r) => { const m = marginPct(r.price, r.cost); return <span dir="ltr" className={m > 0 ? "tabular-nums text-emerald-600" : "tabular-nums text-rose-600"}>{m}%</span>; },
    },
    { id: "status", header: "الحالة", accessor: (r) => (r.active ? "نشط" : "معطّل"), cell: (r) => <StatusBadge tone={r.active ? "success" : "neutral"}>{r.active ? "نشط" : "معطّل"}</StatusBadge> },
  ], []);

  function apply() {
    const input: BulkPriceInput = usingSelection
      ? { itemIds: selected, mode, value: Number(value), reason: reason || undefined }
      : { brandId: brandId || undefined, categoryFilter: category || undefined, mode, value: Number(value), reason: reason || undefined };
    bulk.mutate(input, {
      onSuccess: (res) => {
        setConfirmOpen(false);
        setResult(res);
        setSelected([]);
        toast({ title: `تم تحديث ${res.affected} صنف`, tone: "success" });
      },
      onError: (e: Error) => { setConfirmOpen(false); toast({ title: "تعذّر التحديث الجماعي", description: e.message, tone: "error" }); },
    });
  }

  const modeHint =
    mode === "percent" ? "موجب يرفع السعر وسالب يخفضه (مثال: 10 = +10٪)."
    : mode === "fixed_set" ? "تعيين نفس السعر لكل الأصناف المستهدفة."
    : "إضافة (أو طرح) مبلغ ثابت لسعر كل صنف.";

  return (
    <div>
      <PageHeader
        eyebrow="القوائم والوصفات"
        title="قوائم الأسعار"
        subtitle="تحديث الأسعار جماعيًا حسب العلامة أو الفئة أو الأصناف المحددة. يُسجَّل التغيير في سجل التدقيق."
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
          <Field label="نوع التعديل">
            {({ id }) => <Select id={id} className="w-full" options={MODES} value={mode} onChange={(e) => setMode(e.target.value as Mode)} />}
          </Field>
          <Field label={mode === "percent" ? "النسبة ٪" : "المبلغ"} hint={modeHint}>
            {({ id }) => <NumberInput id={id} value={value} onChange={setValue} step="any" suffix={mode === "percent" ? "٪" : "ر.س"} />}
          </Field>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="السبب (اختياري)">
            {({ id }) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: تحديث أسعار الموسم" />}
          </Field>
          <Can cap="menu.pricing.manage" fallback={<p className="text-xs font-medium text-slate-400">تحتاج صلاحية إدارة الأسعار.</p>}>
            <Button disabled={!canApply} onClick={() => setConfirmOpen(true)}>
              <Calculator className="h-4 w-4" />
              {usingSelection ? `تطبيق على ${selected.length} محدد` : `تطبيق على ${targetCount} صنف`}
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
          searchPlaceholder="ابحث باسم الصنف…"
          emptyTitle="لا توجد أصناف"
          emptyBody="اختر علامة تجارية أو أضف أصنافًا."
          mobileTitle={(r) => r.name}
          bulkActions={canPrice ? (ids) => (
            <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!valueOk}>
              <Calculator className="h-4 w-4" /> تطبيق على {ids.length}
            </Button>
          ) : undefined}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="تأكيد التحديث الجماعي"
        description={
          usingSelection
            ? `سيتم تعديل أسعار ${selected.length} صنف محدد.`
            : `سيتم تعديل أسعار ${targetCount} صنف ضمن النطاق المحدد (${brandId ? "علامة" : "كل العلامات"}${category ? " · " + category : ""}).`
        }
        confirmLabel="تطبيق"
        processing={bulk.isPending}
        error={bulk.isError ? (bulk.error as Error).message : null}
        onClose={() => { if (!bulk.isPending) setConfirmOpen(false); }}
        onConfirm={apply}
      />

      {result && <ResultDialog result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function ResultDialog({ result, onClose }: { result: BulkPriceResult; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="نتيجة التحديث"
      description={`تم تعديل ${result.affected} صنف.`}
      size="lg"
      footer={<Button onClick={onClose}>تم</Button>}
    >
      {result.items.length === 0 ? (
        <p className="text-sm font-medium text-slate-500">لم تتغيّر أي أسعار (القيم مطابقة).</p>
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
