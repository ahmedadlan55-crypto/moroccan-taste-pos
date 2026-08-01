// Whole-riyal price sweep — the card, the header button, and the preview dialog.
//
// Lives in its own file because TWO screens need it: the price-lists screen
// (where bulk pricing already lives) and the brand menu list (where the owner
// actually sees the halalas in the «شامل الضريبة» column and wants them gone).
// A second copy would drift, and drift in a preview means the list a human
// approved is not the list that got written.
import { useState } from "react";
import { Coins } from "lucide-react";
import { Button, Card, Dialog, useToast } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useRoundToWholeRiyal, menuErrorText, type WholeRiyalResult } from "./api";
import { Money } from "./lib";

/**
 * «ضبط الأسعار على ريالات كاملة» — the preview→apply flow, shared by both
 * presentations below.
 *
 * The cashier card advertises the VAT-INCLUSIVE price, and stored prices are
 * net — so a row stored at 30.4261 shows 34.99. The fix is to tune the STORED
 * price (30.4348 → shows 35), never to round at display time: a display-only
 * round would say 35 on screen while the invoice said 34.99, which is the very
 * gap this feature exists to close.
 *
 * The sweep also exists as scripts/round-prices-to-whole-riyal.js. This UI is
 * here because the owner does not use a terminal — same shared logic
 * (lib/wholeRiyalSweep), reached through POST /menu/round-to-whole-riyal.
 *
 * PREVIEW FIRST, ALWAYS. The button fetches the plan WITHOUT writing (the
 * server defaults `apply` to false), the dialog lists every before → after, and
 * only the dialog's own button applies it. This moves real selling prices by up
 * to 0.50 SAR a unit; it is not something to trigger from a single tap.
 */
function useSweep() {
  const t = useT();
  const { toast } = useToast();
  const sweep = useRoundToWholeRiyal();
  const [preview, setPreview] = useState<WholeRiyalResult | null>(null);

  const fail = (e: Error) =>
    toast({ title: t("menuRest.wholeRiyal.failed"), description: menuErrorText(e, t), tone: "error" });

  return {
    pending: sweep.isPending,
    preview,
    // Reads only — the server writes nothing unless `apply` is true.
    runPreview: () => sweep.mutate({}, { onSuccess: setPreview, onError: fail }),
    applyNow: () =>
      sweep.mutate(
        { apply: true },
        {
          onSuccess: (res) => {
            setPreview(null);
            toast({ title: t("menuRest.wholeRiyal.appliedToast", { count: res.affected }), tone: "success" });
          },
          onError: fail,
        },
      ),
    close: () => { if (!sweep.isPending) setPreview(null); },
  };
}

/** Header-bar presentation — a bare button. Used on the brand menu list, where
 *  the «شامل الضريبة» column already explains why you would press it. */
export function WholeRiyalButton() {
  const t = useT();
  const s = useSweep();
  return (
    <>
      <Can cap="menu.pricing.manage">
        <Button variant="secondary" disabled={s.pending} onClick={s.runPreview}>
          <Coins className="h-4 w-4" />
          {s.pending && !s.preview ? t("menuRest.wholeRiyal.previewing") : t("menu.list.roundPrices")}
        </Button>
      </Can>
      {s.preview && (
        <WholeRiyalDialog preview={s.preview} applying={s.pending} onApply={s.applyNow} onClose={s.close} />
      )}
    </>
  );
}

/** Full-card presentation with the explanatory copy — used on the price-lists
 *  screen, which has no column showing the problem. */
export function WholeRiyalCard() {
  const t = useT();
  const s = useSweep();
  return (
    <>
      <Card className="mt-6 p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800">{t("menuRest.wholeRiyal.title")}</h3>
            <p className="mt-1 text-xs font-medium text-slate-500">{t("menuRest.wholeRiyal.subtitle")}</p>
          </div>
          <Can cap="menu.pricing.manage" fallback={<p className="text-xs font-medium text-slate-400">{t("menuRest.priceLists.needPricePermission")}</p>}>
            <Button variant="secondary" disabled={s.pending} onClick={s.runPreview}>
              <Coins className="h-4 w-4" />
              {s.pending && !s.preview ? t("menuRest.wholeRiyal.previewing") : t("menuRest.wholeRiyal.previewButton")}
            </Button>
          </Can>
        </div>
      </Card>

      {s.preview && (
        <WholeRiyalDialog preview={s.preview} applying={s.pending} onApply={s.applyNow} onClose={s.close} />
      )}
    </>
  );
}

export function WholeRiyalDialog({
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
