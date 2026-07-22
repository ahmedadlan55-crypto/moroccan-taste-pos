/**
 * CategoryTranslations (bilingual-i18n-images, Fix D) — a small admin section
 * that lists every distinct menu category (LIVE from GET /api/menu/categories
 * — never hardcoded) and lets an admin/manager attach the English label used
 * across the bilingual menu/invoices, matching db/migrations/0013_bilingual_
 * catalog.sql (menu_category_i18n: category_ar PK + category_en).
 *
 * Gating mirrors ImageManager.tsx exactly: the outer screen is wrapped in
 * `Can cap="menu.view" showDenied` (broad read audience — the same capability
 * every other /menu/* nav item requires), while the per-row edit input + save
 * button additionally require "menu.catalog.manage" (the same write
 * capability PriceLists.tsx gates its bulk-price action behind, and that
 * routes/menu.js's PUT /menu/categories/:categoryAr actually enforces via
 * MGR). Without menu.catalog.manage a row still shows the current English
 * label, just as read-only text — no input, no button.
 */
import { useMemo, useState } from "react";
import { Languages } from "lucide-react";
import { PageHeader, Card, Button, Input, LoadingState, ErrorState, EmptyState, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { Can, useCan } from "@/shared/permissions";
import { useCategoryList, useUpdateCategoryEn, menuErrorText, type CategoryTranslation } from "./api";

/** Gate the whole page — the screen (and its query/mutation) only mounts once
 *  menu.view is confirmed, matching ImageManager/PricingPage's idiom (a thin
 *  outer Can wraps the hook-bearing screen, not the other way around). */
export function CategoryTranslations() {
  return (
    <Can cap="menu.view" showDenied>
      <CategoryTranslationsScreen />
    </Can>
  );
}

function CategoryTranslationsScreen() {
  const t = useTx();
  const { toast } = useToast();
  const canManage = useCan("menu.catalog.manage");

  const categoriesQ = useCategoryList();
  const updateCategory = useUpdateCategoryEn();

  // Per-row draft text, keyed by the Arabic category name (the stable key the
  // backend groups by). Only dirtied rows get an entry; everything else reads
  // straight from the server value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAr, setSavingAr] = useState<string | null>(null);

  const rows = useMemo(() => categoriesQ.data ?? [], [categoriesQ.data]);

  function draftFor(row: CategoryTranslation): string {
    return drafts[row.categoryAr] ?? row.categoryEn ?? "";
  }

  function isDirty(row: CategoryTranslation): boolean {
    return draftFor(row).trim() !== (row.categoryEn ?? "").trim();
  }

  function onChangeDraft(categoryAr: string, value: string) {
    setDrafts((prev) => ({ ...prev, [categoryAr]: value }));
  }

  function save(row: CategoryTranslation) {
    const categoryEn = draftFor(row).trim();
    if (!categoryEn) {
      toast({ title: t("menuRest.categoryTranslations.enRequired"), tone: "error" });
      return;
    }
    setSavingAr(row.categoryAr);
    updateCategory.mutate(
      { categoryAr: row.categoryAr, categoryEn },
      {
        onSuccess: () => {
          toast({ title: t("menuRest.categoryTranslations.savedTitle", { name: row.categoryAr }), tone: "success" });
          setDrafts((prev) => {
            if (!(row.categoryAr in prev)) return prev;
            const next = { ...prev };
            delete next[row.categoryAr];
            return next;
          });
        },
        onError: (e: Error) => toast({ title: t("menuRest.categoryTranslations.saveFailed"), description: menuErrorText(e, t), tone: "error" }),
        onSettled: () => setSavingAr((cur) => (cur === row.categoryAr ? null : cur)),
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("menuRest.eyebrow")}
        title={t("menuRest.categoryTranslations.title")}
        subtitle={t("menuRest.categoryTranslations.subtitle")}
      />

      <Card>
        {categoriesQ.isLoading ? (
          <div className="p-5">
            <LoadingState rows={2} />
          </div>
        ) : categoriesQ.isError ? (
          <div className="p-5">
            <ErrorState error={categoriesQ.error} onRetry={() => categoriesQ.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t("menuRest.categoryTranslations.emptyTitle")} body={t("menuRest.categoryTranslations.emptyBody")} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-start">
                  <th scope="col" className="px-5 py-3 text-xs font-bold text-slate-600">{t("menuRest.categoryTranslations.colCategory")}</th>
                  <th scope="col" className="px-5 py-3 text-xs font-bold text-slate-600">{t("menuRest.categoryTranslations.colItemCount")}</th>
                  <th scope="col" className="px-5 py-3 text-xs font-bold text-slate-600">{t("menuRest.categoryTranslations.colEnName")}</th>
                  {canManage && <th scope="col" className="px-5 py-3 text-xs font-bold text-slate-600" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.categoryAr}>
                    <td className="px-5 py-3 font-bold text-slate-800">{row.categoryAr}</td>
                    <td className="px-5 py-3 text-slate-500">
                      <span dir="ltr" className="tabular-nums">{row.itemCount}</span>
                    </td>
                    <td className="px-5 py-3">
                      {canManage ? (
                        <Input
                          dir="ltr"
                          value={draftFor(row)}
                          onChange={(e) => onChangeDraft(row.categoryAr, e.target.value)}
                          placeholder="Category name in English"
                          aria-label={t("menuRest.categoryTranslations.enNameAria", { name: row.categoryAr })}
                          className="max-w-xs"
                        />
                      ) : (
                        <span className="text-slate-600">{row.categoryEn || "—"}</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-5 py-3">
                        <Button
                          size="sm"
                          onClick={() => save(row)}
                          disabled={!isDirty(row)}
                          loading={savingAr === row.categoryAr}
                        >
                          {t("common.save")}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!canManage && (
        <p className="mt-3 text-xs font-medium text-slate-400">
          <Languages className="mb-0.5 inline h-3.5 w-3.5" aria-hidden /> {t("menuRest.categoryTranslations.needManagePermission")}
        </p>
      )}
    </div>
  );
}
