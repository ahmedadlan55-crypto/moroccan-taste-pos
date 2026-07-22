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
import { useT, useLang } from "@/i18n";
import {
  useBrands,
  useCombos,
  useMenuItems,
  useCreateCombo,
  useUpdateCombo,
  useDeleteCombo,
  makeMenuItemFetcher,
  menuErrorText,
  type Combo,
  type ComboInput,
  type MenuItem,
} from "./api";
import { Money, useBrandScope, BrandSelect, pickName } from "./lib";

export function Combos() {
  const t = useT();
  const lang = useLang();
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
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.combos.title")}
        subtitle={t("menuRest.combos.subtitle")}
        action={
          <Can cap="menu.catalog.manage">
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="h-4 w-4" /> {t("menuRest.combos.newCombo")}
            </Button>
          </Can>
        }
      />

      <Card className="mb-6 flex items-center gap-3 p-4">
        <span className="text-xs font-bold text-slate-600">{t("menuRest.fields.brand")}</span>
        <BrandSelect brands={brandsQ.data ?? []} value={brandId} onChange={setBrandId} />
      </Card>

      {combosQ.isLoading || brandsQ.isLoading ? (
        <LoadingState rows={2} />
      ) : combosQ.isError ? (
        <ErrorState error={combosQ.error} onRetry={() => combosQ.refetch()} />
      ) : (combosQ.data ?? []).length === 0 ? (
        <EmptyState icon={<Layers className="h-6 w-6" />} title={t("menuRest.combos.emptyTitle")} body={t("menuRest.combos.emptyBody")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(combosQ.data ?? []).map((c) => (
            <Card key={c.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-extrabold text-slate-900">{pickName(c.name, c.nameEn, lang)}</div>
                  <div className="mt-0.5 text-xs font-medium text-slate-400">{c.category || "عروض"}</div>
                </div>
                <StatusBadge tone={c.active ? "success" : "neutral"}>{t(c.active ? "status.active" : "status.disabled")}</StatusBadge>
              </div>
              <div className="flex items-center justify-between border-y border-slate-100 py-2">
                <span className="text-xs font-bold text-slate-400">{t("menuRest.fields.price")}</span>
                <Money value={c.price} className="text-lg font-extrabold text-slate-800" />
              </div>
              <ul className="space-y-1.5">
                {c.groups.map((g) => (
                  <li key={g.id} className="text-xs">
                    <span className="font-bold text-slate-600">{g.type === "fixed" ? t("menuRest.combos.typeFixed") : t("menuRest.combos.choiceRange", { min: g.minSelect, max: g.maxSelect })}: </span>
                    <span className="text-slate-500">{g.options.map((o) => pickName(o.name, o.nameEn, lang)).join(t("menuRest.combos.optionSeparator")) || "—"}</span>
                  </li>
                ))}
                {c.groups.length === 0 && <li className="text-xs text-slate-400">{t("menuRest.combos.noComponentsShort")}</li>}
              </ul>
              {canManage && (
                <div className="mt-auto flex justify-end gap-1 border-t border-slate-100 pt-3">
                  <IconButton size="sm" aria-label={t("menuRest.combos.editComboAria")} onClick={() => { setEditing(c); setFormOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton size="sm" aria-label={t("menuRest.combos.deleteComboAria")} onClick={() => setDeleting(c)}>
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
        title={t("menuRest.combos.deleteTitle")}
        description={deleting ? t("menuRest.combos.deleteConfirm", { name: pickName(deleting.name, deleting.nameEn, lang) }) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        error={del.isError ? menuErrorText(del.error, t) : null}
        onClose={() => { if (!del.isPending) setDeleting(null); }}
        onConfirm={() => {
          if (!deleting) return;
          del.mutate(deleting.id, {
            onSuccess: () => { toast({ title: t("menuRest.combos.deletedTitle"), tone: "success" }); setDeleting(null); },
            onError: (e: Error) => toast({ title: t("menuRest.combos.deleteFailed"), description: menuErrorText(e, t), tone: "error" }),
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
  const t = useT();
  const lang = useLang();
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
    if (!name.trim()) return t("menuRest.combos.valNameRequired");
    if (price == null || price < 0) return t("menuRest.combos.valPriceMin");
    if (groups.length === 0) return t("menuRest.combos.valNeedGroup");
    for (const g of groups) {
      const items = g.items.filter((it) => it.menuItemId);
      if (items.length === 0) return t("menuRest.combos.valGroupEmpty", { name: g.name });
      if (g.type === "choice") {
        const mn = Number(g.minSelect), mx = Number(g.maxSelect);
        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn < 0 || mx < 1 || mn > mx) return t("menuRest.combos.valChoiceBounds", { name: g.name });
        if (mx > items.length) return t("menuRest.combos.valMaxExceeds", { name: g.name });
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
    const onDone = { onSuccess: () => { toast({ title: initial ? t("menuRest.combos.savedTitle") : t("menuRest.combos.createdTitle"), tone: "success" as const }); onClose(); }, onError: (e: Error) => setErr(menuErrorText(e, t)) };
    if (initial) update.mutate({ id: initial.id, input }, onDone);
    else create.mutate(input, onDone);
  }

  const pending = create.isPending || update.isPending;

  return (
    <Drawer
      open
      onClose={onClose}
      title={initial ? t("menuRest.combos.editTitle") : t("menuRest.combos.newTitle")}
      eyebrow={t("menuRest.combos.drawerEyebrow")}
      icon={Layers}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-xs font-bold text-rose-600">{err}</div>
          <Button variant="secondary" onClick={onClose} disabled={pending}>{t("common.cancel")}</Button>
          <Button onClick={submit} loading={pending}>{initial ? t("common.save") : t("menuRest.combos.create")}</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("menuRest.combos.comboName")} required>
            {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label={t("menuRest.combos.nameEn")}>
            {({ id }) => <Input id={id} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label={t("menuRest.fields.price")} required>
            {({ id }) => <NumberInput id={id} value={price} onChange={setPrice} min={0} step={0.01} suffix={t("menuRest.units.sar")} />}
          </Field>
          <Field label={t("menuRest.fields.category")}>
            {({ id }) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} />}
          </Field>
          <Field label={t("menuRest.fields.brand")}>
            {({ id }) => (
              <Select id={id} value={comboBrandId} onChange={(e) => setComboBrandId(e.target.value)}>
                <option value="">{t("menuRest.combos.noBrandOption")}</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Toggle checked={active} onChange={setActive} label={t("menuRest.combos.activeToggle")} />

        {/* Groups */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-extrabold text-slate-800">{t("menuRest.combos.components")}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => addGroup("fixed")}><Plus className="h-4 w-4" /> {t("menuRest.combos.typeFixed")}</Button>
              <Button variant="secondary" size="sm" onClick={() => addGroup("choice")}><Plus className="h-4 w-4" /> {t("menuRest.combos.typeChoice")}</Button>
            </div>
          </div>

          {groups.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs font-medium text-slate-400">
              {t("menuRest.combos.groupsHint")}
            </p>
          )}

          {groups.map((g) => (
            <div key={g.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className={g.type === "fixed" ? "chip border-teal-200 bg-teal-50 text-teal-700" : "chip border-violet-200 bg-violet-50 text-violet-700"}>
                  {g.type === "fixed" ? t("menuRest.combos.typeFixed") : t("menuRest.combos.typeChoice")}
                </span>
                <Input className="h-9 flex-1" value={g.name} onChange={(e) => patchGroup(g.key, { name: e.target.value })} aria-label={t("menuRest.combos.groupNameAria")} />
                {g.type === "choice" && (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-bold text-slate-400">{t("menuRest.combos.rangeFrom")}</span>
                    <NumberInput className="h-9 w-16" value={g.minSelect} onChange={(v) => patchGroup(g.key, { minSelect: v })} min={0} step={1} aria-label={t("menuRest.combos.minSelectAria")} />
                    <span className="text-[11px] font-bold text-slate-400">{t("menuRest.combos.rangeTo")}</span>
                    <NumberInput className="h-9 w-16" value={g.maxSelect} onChange={(v) => patchGroup(g.key, { maxSelect: v })} min={1} step={1} aria-label={t("menuRest.combos.maxSelectAria")} />
                  </div>
                )}
                <IconButton size="sm" aria-label={t("menuRest.combos.deleteGroupAria")} onClick={() => removeGroup(g.key)}>
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
                        getLabel={(m) => pickName(m.name, m.nameEn, lang)}
                        getSublabel={(m) => m.category || undefined}
                        placeholder={t("menuRest.combobox.pickItem")}
                        ariaLabel={t("menuRest.aria.selectItem")}
                        emptyText={t("menuRest.combobox.noItems")}
                      />
                      <NumberInput value={it.qty} onChange={(v) => patchItem(g.key, it.key, { qty: v })} min={1} step={1} aria-label={t("menuRest.aria.quantity")} />
                      <IconButton size="sm" aria-label={t("menuRest.combos.deleteItemAria")} onClick={() => removeItem(g.key, it.key)}>
                        <Trash2 className="h-4 w-4 text-rose-500" />
                      </IconButton>
                    </div>
                  );
                })}
                <Button variant="ghost" size="sm" onClick={() => addItem(g.key)}>
                  <Plus className="h-4 w-4" /> {t("menuRest.combos.addItem")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
