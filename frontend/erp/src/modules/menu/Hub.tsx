import { useMemo } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChefHat, Layers, Soup, Store, Package } from "lucide-react";
import { PageHeader, Card, LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useBrands, useMenuItems, useSemiFinished, type MenuItem } from "./api";
import { Num } from "./lib";

interface BrandBucket {
  id: string;
  name: string;
  products: number;
  combos: number;
  inactive: number;
}

function bucketize(items: MenuItem[], brands: { id: string; name: string }[], noBrandLabel: string): BrandBucket[] {
  const byId = new Map<string, BrandBucket>();
  const nameOf = new Map(brands.map((b) => [b.id, b.name]));
  for (const b of brands) byId.set(b.id, { id: b.id, name: b.name, products: 0, combos: 0, inactive: 0 });
  for (const it of items) {
    const key = it.brandId || "__none__";
    if (!byId.has(key)) {
      byId.set(key, { id: key, name: key === "__none__" ? noBrandLabel : (nameOf.get(key) || "—"), products: 0, combos: 0, inactive: 0 });
    }
    const bucket = byId.get(key)!;
    if (it.isCombo) bucket.combos += 1;
    else if (!it.isSemiFinished) bucket.products += 1;
    if (!it.active) bucket.inactive += 1;
  }
  // Keep brands with any content OR that are declared brands (so the grid is stable).
  return [...byId.values()].filter((b) => b.id !== "__none__" || b.products + b.combos > 0);
}

export function Hub() {
  const t = useT();
  const brandsQ = useBrands();
  const itemsQ = useMenuItems({ type: "all" });
  const semiQ = useSemiFinished();

  const buckets = useMemo(
    () => bucketize(itemsQ.data ?? [], brandsQ.data ?? [], t("menuRest.hub.noBrand")),
    [itemsQ.data, brandsQ.data, t],
  );
  const semiByBrand = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of semiQ.data ?? []) m.set(s.brandId || "__none__", (m.get(s.brandId || "__none__") || 0) + 1);
    return m;
  }, [semiQ.data]);

  const totals = useMemo(() => {
    const products = buckets.reduce((s, b) => s + b.products, 0);
    const combos = buckets.reduce((s, b) => s + b.combos, 0);
    const semi = (semiQ.data ?? []).length;
    return { products, combos, semi, brands: (brandsQ.data ?? []).length };
  }, [buckets, semiQ.data, brandsQ.data]);

  if (brandsQ.isError || itemsQ.isError) {
    return (
      <div>
        <PageHeader eyebrow={t("menuRest.eyebrow")} title={t("menuRest.hub.title")} subtitle={t("menuRest.hub.subtitle")} />
        <ErrorState error={brandsQ.error ?? itemsQ.error} onRetry={() => { brandsQ.refetch(); itemsQ.refetch(); }} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t("menuRest.eyebrow")} title={t("menuRest.hub.title")} subtitle={t("menuRest.hub.subtitle")} />

      {itemsQ.isLoading || brandsQ.isLoading ? (
        <LoadingState />
      ) : (
        <>
          {/* KPI strip */}
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={<Store className="h-5 w-5" />} label={t("menuRest.hub.kpiBrands")} value={totals.brands} />
            <KpiCard icon={<Package className="h-5 w-5" />} label={t("menuRest.hub.kpiProducts")} value={totals.products} />
            <KpiCard icon={<Layers className="h-5 w-5" />} label={t("menuRest.hub.kpiCombos")} value={totals.combos} />
            <KpiCard icon={<Soup className="h-5 w-5" />} label={t("menuRest.hub.kpiSemi")} value={totals.semi} />
          </div>

          {buckets.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="h-6 w-6" />}
              title={t("menuRest.hub.emptyTitle")}
              body={t("menuRest.hub.emptyBody")}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {buckets.map((b) => (
                <Card key={b.id} className="flex flex-col gap-4 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-extrabold text-slate-900">{b.name}</div>
                      <div className="mt-0.5 text-xs font-medium text-slate-400">
                        {b.inactive > 0 ? <span>{t("menuRest.hub.inactiveCount", { count: b.inactive })}</span> : t("menuRest.hub.allActive")}
                      </div>
                    </div>
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                      <BookOpen className="h-5 w-5" />
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Stat label={t("menuRest.hub.statProducts")} value={b.products} />
                    <Stat label={t("menuRest.hub.statCombos")} value={b.combos} />
                    <Stat label={t("menuRest.hub.statSemi")} value={semiByBrand.get(b.id === "__none__" ? "__none__" : b.id) || 0} />
                  </div>

                  {b.id !== "__none__" && (
                    <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                      <QuickLink to={`/menu/brand?brandId=${b.id}`} icon={<BookOpen className="h-3.5 w-3.5" />} label={t("menuRest.hub.linkMenu")} />
                      <Can cap="menu.recipes.manage">
                        <QuickLink to={`/menu/recipes-bom?brandId=${b.id}`} icon={<ChefHat className="h-3.5 w-3.5" />} label={t("menuRest.hub.linkRecipes")} />
                      </Can>
                      <QuickLink to={`/menu/combos?brandId=${b.id}`} icon={<Layers className="h-3.5 w-3.5" />} label={t("menuRest.hub.linkCombos")} />
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-bold text-slate-400">{label}</div>
        <div className="text-2xl font-extrabold text-slate-900"><Num value={value} /></div>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-center">
      <div className="text-lg font-extrabold text-slate-900"><Num value={value} /></div>
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
    </div>
  );
}

function QuickLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
    >
      {icon}
      {label}
    </Link>
  );
}
