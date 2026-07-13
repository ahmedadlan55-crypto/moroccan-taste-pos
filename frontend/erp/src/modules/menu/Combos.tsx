import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Layers, X } from "lucide-react";
import {
  PageHeader,
  Card,
  Button,
  IconButton,
  Input,
  Select,
  Toggle,
  NumberInput,
  StatusBadge,
  Drawer,
  ConfirmDialog,
  SearchableEntityCombobox,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can, useCan } from "@/shared/permissions";
import {
  useBrands,
  useCombos,
  useMenuItems,
  useCreateCombo,
  useUpdateCombo,
  useDeleteCombo,
  makeMenuItemFetcher,
  type Combo,
  type ComboInput,
  type MenuItem,
} from "./api";
import { Money, useBrandScope, BrandSelect } from "./lib";

export function Combos() {
  const { toast } = useToast();
  const { brandId, setBrandId } = useBrandScope();
  const canManage = useCan("menu.catalog.manage");

  const brandsQ = useBrands();
  const combosQ = useCombos(brandId || undefined);
  const del = useDeleteCombo();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Combo | null>(null);
  const [deleting, setDeleting] = useState<Combo | null>(null);

  return (
    <div>
      <PageHeader
        eyebrow="القوائم والوصفات"
        title="الوجبات المركّبة"
        subtitle="عروض ووجبات مركّبة من عدة أصناف (مثال: أي ساندويتش مع عصير). تُوسّع لمكوّناتها عند البيع."
        action={
          <Can cap="menu.catalog.manage">
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="h-4 w-4" /> عرض جديد
            </Button>
          </Can>
        }
      />

      <Card className="mb-6 flex items-center gap-3 p-4">
        <span className="text-xs font-bold text-slate-600">العلامة التجارية</span>
        <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} />
      </Card>

      {combosQ.isLoading || brandsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : combosQ.isError ? (
        <ErrorState error={combosQ.error} onRetry={() => combosQ.refetch()} />
      ) : (combosQ.data ?? []).length === 0 ? (
        <EmptyState icon={<Layers className="h-6 w-6" />} title="لا توجد عروض" body="أنشئ عرضًا مركّبًا من عدة أصناف." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(combosQ.data ?? []).map((c) => (
            <Card key={c.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-extrabold text-slate-900">{c.name}</div>
                  <div className="mt-0.5 text-xs font-medium text-slate-400">{c.category || "عروض"}</div>
                </div>
                <StatusBadge tone={c.active ? "success" : "neutral"}>{c.active ? "نشط" : "معطّل"}</StatusBadge>
              </div>
              <div className="flex items-center justify-between border-y border-slate-100 py-2">
                <span className="text-xs font-bold text-slate-400">السعر</span>
                <Money value={c.price} className="text-lg font-extrabold text-slate-800" />
              </div>
              <ul className="space-y-1.5">
                {c.groups.map((g) => (
                  <li key={g.id} className="text-xs">
                    <span className="font-bold text-slate-600">{g.type === "fixed" ? "ثابت" : `اختيار (${g.minSelect}-${g.maxSelect})`}: </span>
                    <span className="text-slate-500">{g.options.map((o) => o.name).join("، ") || "—"}</span>
                  </li>
                ))}
                {c.groups.length === 0 && <li className="text-xs text-slate-400">لا مكوّنات</li>}
              </ul>
              {canManage && (
                <div className="mt-auto flex justify-end gap-1 border-t border-slate-100 pt-3">
                  <IconButton size="sm" aria-label="تعديل العرض" onClick={() => { setEditing(c); setFormOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton size="sm" aria-label="حذف العرض" onClick={() => setDeleting(c)}>
                    <Trash2 className="h-4 w-4 text-rose-500" />
                  </IconButton>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <ComboFormDrawer
          initial={editing}
          brands={brandsQ.data ?? []}
          defaultBrandId={brandId}
          onClose={() => setFormOpen(false)}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="حذف العرض"
        description={deleting ? `سيتم إخفاء العرض «${deleting.name}» (حذف ناعم).` : ""}
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onClose={() => { if (!del.isPending) setDeleting(null); }}
        onConfirm={() => {
          if (!deleting) return;
          del.mutate(deleting.id, {
            onSuccess: () => { toast({ title: "تم حذف العرض", tone: "success" }); setDeleting(null); },
            onError: (e: Error) => toast({ title: "تعذّر الحذف", description: e.message, tone: "error" }),
          });
        }}
      />
    </div>
  );
}

// ── Combo builder ────────────────────────────────────────────────────────────
interface EditItem { key: string; menuItemId: string; name: string; qty: number | null }
interface EditGroup { key: string; type: "fixed" | "choice"; name: string; minSelect: number | null; maxSelect: number | null; items: EditItem[] }

let _seq = 0;
const nk = () => `g-${Date.now()}-${_seq++}`;

function ComboFormDrawer({
  initial,
  brands,
  defaultBrandId,
  onClose,
}: {
  initial: Combo | null;
  brands: { id: string; name: string }[];
  defaultBrandId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateCombo();
  const update = useUpdateCombo();
  const itemsQ = useMenuItems({ type: "all" });
  const pickable = useMemo(
    () => (itemsQ.data ?? []).filter((i) => !i.isCombo && !i.isSemiFinished),
    [itemsQ.data],
  );
  const fetcher = useMemo(() => makeMenuItemFetcher(pickable), [pickable]);

  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [price, setPrice] = useState<number | null>(0);
  const [category, setCategory] = useState("عروض");
  const [comboBrandId, setComboBrandId] = useState("");
  const [active, setActive] = useState(true);
  const [groups, setGroups] = useState<EditGroup[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(initial?.name ?? "");
    setNameEn(initial?.nameEn ?? "");
    setPrice(initial?.price ?? 0);
    setCategory(initial?.category ?? "عروض");
    setComboBrandId(initial?.brandId ?? defaultBrandId ?? "");
    setActive(initial?.active ?? true);
    setGroups(
      (initial?.groups ?? []).map((g) => ({
        key: nk(),
        type: g.type,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        items: g.options.map((o) => ({ key: nk(), menuItemId: o.menuItemId, name: o.name, qty: o.qty })),
      })),
    );
    setErr(null);
  }, [initial, defaultBrandId]);

  function addGroup(type: "fixed" | "choice") {
    setGroups((p) => [...p, { key: nk(), type, name: type === "fixed" ? "مكوّن ثابت" : "اختيار", minSelect: type === "choice" ? 1 : 0, maxSelect: type === "choice" ? 1 : 0, items: [] }]);
  }
  function patchGroup(key: string, patch: Partial<EditGroup>) {
    setGroups((p) => p.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function removeGroup(key: string) {
    setGroups((p) => p.filter((g) => g.key !== key));
  }
  function addItem(gk: string) {
    setGroups((p) => p.map((g) => (g.key === gk ? { ...g, items: [...g.items, { key: nk(), menuItemId: "", name: "", qty: 1 }] } : g)));
  }
  function patchItem(gk: string, ik: string, patch: Partial<EditItem>) {
    setGroups((p) => p.map((g) => (g.key === gk ? { ...g, items: g.items.map((it) => (it.key === ik ? { ...it, ...patch } : it)) } : g)));
  }
  function removeItem(gk: string, ik: string) {
    setGroups((p) => p.map((g) => (g.key === gk ? { ...g, items: g.items.filter((it) => it.key !== ik) } : g)));
  }

  // Client-side validation mirroring routes/menu.js _validateCombo.
  function validate(): string | null {
    if (!name.trim()) return "اسم العرض مطلوب";
    if (price == null || price < 0) return "سعر العرض يجب أن يكون صفرًا أو أكثر";
    if (groups.length === 0) return "أضف مكوّنًا ثابتًا أو مجموعة اختيار واحدة على الأقل";
    for (const g of groups) {
      const items = g.items.filter((it) => it.menuItemId);
      if (items.length === 0) return `كل مجموعة يجب أن تحتوي عنصرًا واحدًا على الأقل: ${g.name}`;
      if (g.type === "choice") {
        const mn = Number(g.minSelect), mx = Number(g.maxSelect);
        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn < 0 || mx < 1 || mn > mx) return `حدود الاختيار غير صحيحة في: ${g.name}`;
        if (mx > items.length) return `الحد الأقصى للاختيار أكبر من عدد الخيارات في: ${g.name}`;
      }
    }
    return null;
  }

  function submit() {
    const v = validate();
    if (v) { setErr(v); return; }
    setErr(null);
    const input: ComboInput = {
      name: name.trim(),
      nameEn: nameEn || undefined,
      price: Number(price) || 0,
      category: category || "عروض",
      brandId: comboBrandId || null,
      active,
      groups: groups.map((g) => ({
        type: g.type,
        name: g.name,
        minSelect: g.type === "choice" ? Number(g.minSelect) || 0 : undefined,
        maxSelect: g.type === "choice" ? Number(g.maxSelect) || 1 : undefined,
        items: g.items.filter((it) => it.menuItemId).map((it) => ({ menuItemId: it.menuItemId, qty: Number(it.qty) || 1 })),
      })),
    };
    const onDone = { onSuccess: () => { toast({ title: initial ? "تم حفظ العرض" : "تم إنشاء العرض", tone: "success" as const }); onClose(); }, onError: (e: Error) => setErr(e.message) };
    if (initial) update.mutate({ id: initial.id, input }, onDone);
    else create.mutate(input, onDone);
  }

  const pending = create.isPending || update.isPending;

  return (
    <Drawer
      open
      onClose={onClose}
      title={initial ? "تعديل عرض" : "عرض جديد"}
      eyebrow="وجبة مركّبة"
      icon={Layers}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-xs font-bold text-rose-600">{err}</div>
          <Button variant="secondary" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button onClick={submit} loading={pending}>{initial ? "حفظ" : "إنشاء"}</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="اسم العرض" required>
            {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="الاسم بالإنجليزية">
            {({ id }) => <Input id={id} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label="السعر" required>
            {({ id }) => <NumberInput id={id} value={price} onChange={setPrice} min={0} step={0.01} suffix="ر.س" />}
          </Field>
          <Field label="الفئة">
            {({ id }) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} />}
          </Field>
          <Field label="العلامة التجارية">
            {({ id }) => (
              <Select id={id} value={comboBrandId} onChange={(e) => setComboBrandId(e.target.value)}>
                <option value="">بدون علامة</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Toggle checked={active} onChange={setActive} label="عرض نشط" />

        {/* Groups */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-extrabold text-slate-800">المكوّنات</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => addGroup("fixed")}><Plus className="h-4 w-4" /> ثابت</Button>
              <Button variant="secondary" size="sm" onClick={() => addGroup("choice")}><Plus className="h-4 w-4" /> اختيار</Button>
            </div>
          </div>

          {groups.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs font-medium text-slate-400">
              أضف مكوّنًا ثابتًا (يُضاف دائمًا) أو مجموعة اختيار (يختار منها العميل).
            </p>
          )}

          {groups.map((g) => (
            <div key={g.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className={g.type === "fixed" ? "chip border-teal-200 bg-teal-50 text-teal-700" : "chip border-violet-200 bg-violet-50 text-violet-700"}>
                  {g.type === "fixed" ? "ثابت" : "اختيار"}
                </span>
                <Input className="h-9 flex-1" value={g.name} onChange={(e) => patchGroup(g.key, { name: e.target.value })} aria-label="اسم المجموعة" />
                {g.type === "choice" && (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-bold text-slate-400">من</span>
                    <NumberInput className="h-9 w-16" value={g.minSelect} onChange={(v) => patchGroup(g.key, { minSelect: v })} min={0} step={1} aria-label="أدنى اختيار" />
                    <span className="text-[11px] font-bold text-slate-400">إلى</span>
                    <NumberInput className="h-9 w-16" value={g.maxSelect} onChange={(v) => patchGroup(g.key, { maxSelect: v })} min={1} step={1} aria-label="أقصى اختيار" />
                  </div>
                )}
                <IconButton size="sm" aria-label="حذف المجموعة" onClick={() => removeGroup(g.key)}>
                  <X className="h-4 w-4 text-rose-500" />
                </IconButton>
              </div>

              <div className="space-y-2">
                {g.items.map((it) => {
                  const selected: MenuItem | null = it.menuItemId
                    ? (pickable.find((m) => m.id === it.menuItemId) ?? ({ id: it.menuItemId, name: it.name } as MenuItem))
                    : null;
                  return (
                    <div key={it.key} className="grid grid-cols-[minmax(0,1fr)_5rem_auto] items-center gap-2">
                      <SearchableEntityCombobox<MenuItem>
                        value={selected}
                        onChange={(v) => patchItem(g.key, it.key, { menuItemId: v?.id ?? "", name: v?.name ?? "" })}
                        fetcher={fetcher}
                        queryKey={["menu", "combo-item-picker"]}
                        getKey={(m) => m.id}
                        getLabel={(m) => m.name}
                        getSublabel={(m) => m.category || undefined}
                        placeholder="اختر صنفًا…"
                        ariaLabel="اختيار صنف"
                        emptyText="لا أصناف مطابقة."
                      />
                      <NumberInput value={it.qty} onChange={(v) => patchItem(g.key, it.key, { qty: v })} min={1} step={1} aria-label="الكمية" />
                      <IconButton size="sm" aria-label="حذف الصنف" onClick={() => removeItem(g.key, it.key)}>
                        <Trash2 className="h-4 w-4 text-rose-500" />
                      </IconButton>
                    </div>
                  );
                })}
                <Button variant="ghost" size="sm" onClick={() => addItem(g.key)}>
                  <Plus className="h-4 w-4" /> إضافة صنف
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
