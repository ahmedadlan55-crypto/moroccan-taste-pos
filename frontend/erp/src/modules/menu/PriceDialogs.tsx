/**
 * Focused price-edit dialog + price-history drawer (bilingual).
 *
 * These are intentionally SMALL, single-purpose overlays (one number + a reason,
 * and a read-only audit list) — not the "big forms" the sprint routes to full
 * pages. Extracted from BrandMenu so both the product list (row action) and the
 * full-page product editor can open the exact same price workflow. The edit
 * records a price-change audit row (reason required); the drawer reads the log.
 */
import { useState } from "react";
import { History } from "lucide-react";
import {
  Button,
  Dialog,
  Drawer,
  CurrencyInput,
  LoadingState,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useT, useLang, formatDate } from "@/i18n";
import { useUpdatePrice, usePriceHistory, useVatRate, type MenuItem } from "./api";
import { MoneyI18n, marginPct, netForGross, priceBreakdown } from "./lib";

/** The minimal shape both the list row and the detail read satisfy.
 *  The tax fields are REQUIRED for the gross↔net conversion below — without
 *  them the dialog cannot know what the customer actually pays. */
export interface PriceTarget {
  id: string;
  name: string;
  price: number;
  cost: number;
  taxCategory?: string | null;
  isTaxInclusive?: boolean | null;
}

export function toPriceTarget(item: MenuItem): PriceTarget {
  return {
    id: item.id, name: item.name, price: item.price, cost: item.cost,
    taxCategory: item.taxCategory ?? "S", isTaxInclusive: item.isTaxInclusive,
  };
}

/**
 * Price edit — IN THE AMOUNT THE CUSTOMER PAYS.
 *
 * This field used to be the STORED price, which is net of VAT for every menu
 * row. So typing 35 — meaning "I want this to ring up at 35" — stored 35 net
 * and the till showed 40.25. The owner had no way to reach a round number
 * except by computing 35 ÷ 1.15 by hand, which nobody does.
 *
 * The field is now the gross. The net is derived on save (`netForGross`), so
 * the stored column and every downstream calculation are untouched — only the
 * number a human types and reads has changed to the one they were already
 * thinking in. The live breakdown underneath shows exactly what will be stored,
 * so nothing is hidden behind the conversion.
 */
export function PriceEditDialog({ item, onClose }: { item: PriceTarget; onClose: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const update = useUpdatePrice();
  const vatRateQ = useVatRate();
  const vatRatePct = vatRateQ.data ?? 15;

  const current = priceBreakdown(item.price, item.taxCategory, item.isTaxInclusive, vatRatePct);
  const [gross, setGross] = useState<number | null>(current.gross);
  const [reason, setReason] = useState("");

  const reasonOk = reason.trim().length >= 3;
  const priceOk = gross != null && gross >= 0;
  // What will actually be written, and what the till will then print.
  const netToStore = priceOk ? netForGross(gross!, item.taxCategory, item.isTaxInclusive, vatRatePct) : 0;
  const next = priceBreakdown(netToStore, item.taxCategory, item.isTaxInclusive, vatRatePct);
  const preview = priceOk ? marginPct(next.net, item.cost) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("menu.price.editTitle")}
      description={item.name}
      size="md"
      dismissable={!update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={update.isPending}
            disabled={!reasonOk || !priceOk}
            onClick={() =>
              update.mutate(
                // The NET goes to the server — the contract is unchanged; only
                // the number the human typed was in gross terms.
                { id: item.id, price: netToStore, reason: reason.trim() },
                {
                  onSuccess: (res) => {
                    toast({ title: res.noop ? t("menu.price.noChange") : t("menu.price.updated"), tone: "success" });
                    onClose();
                  },
                  onError: (e: Error) => toast({ title: t("menu.price.updateFailed"), description: e.message, tone: "error" }),
                },
              )
            }
          >
            {t("menu.price.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-bold text-slate-400">{t("menu.price.current")}</span>
          <MoneyI18n value={current.gross} className="font-extrabold text-slate-700" />
        </div>

        <Field label={t("menu.price.grossLabel")} hint={t("menu.price.grossHint")} required>
          {({ id }) => <CurrencyInput id={id} value={gross} onChange={setGross} min={0} />}
        </Field>

        {/* Nothing is hidden behind the gross→net conversion: this is exactly
            what will be stored and exactly what the till will print. */}
        {priceOk && (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-400">{t("menu.price.storedNet")}</span>
              <MoneyI18n value={next.net} className="font-bold text-slate-600" />
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-bold text-slate-400">{t("menu.col.priceTax")}</span>
              {next.rate === 0
                ? <span className="text-slate-300">—</span>
                : <MoneyI18n value={next.tax} className="font-bold text-slate-600" />}
            </div>
            <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1">
              <span className="font-extrabold text-slate-600">{t("menu.price.showsAtTill")}</span>
              <MoneyI18n
                value={next.gross}
                className={next.grossIsWhole ? "font-extrabold text-emerald-700" : "font-extrabold text-amber-700"}
              />
            </div>
          </div>
        )}

        {/* The whole point of the change: say so BEFORE saving, with the number
            to type instead. Warn, never block — a fractional price is the
            owner's call to make, not an error. */}
        {priceOk && !next.grossIsWhole && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
            {t("menu.price.notWholeWarn", { target: String(next.wholeTarget) })}
          </p>
        )}

        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-bold text-slate-400">{t("menu.price.expectedMargin")}</span>
          <span dir="ltr" className={preview > 0 ? "tabular-nums font-extrabold text-emerald-600" : "tabular-nums font-extrabold text-rose-600"}>{preview}%</span>
        </div>
        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            {t("menu.price.reason")} <span className="text-rose-600">*</span>
          </span>
          <textarea
            className="field mt-1 min-h-20 w-full resize-y py-2"
            placeholder={t("menu.price.reasonPlaceholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {!reasonOk && reason.length > 0 && (
            <span className="mt-1 block text-xs font-bold text-rose-600">{t("menu.price.reasonTooShort")}</span>
          )}
        </label>
      </div>
    </Dialog>
  );
}

export function PriceHistoryDrawer({ item, onClose }: { item: PriceTarget; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const q = usePriceHistory(item.id);
  return (
    <Drawer open onClose={onClose} title={item.name} eyebrow={t("menu.price.historyEyebrow")} icon={History}>
      {q.isLoading ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <p className="text-sm font-medium text-rose-600">{t("menu.price.historyError")}</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm font-medium text-slate-500">{t("menu.price.historyEmpty")}</p>
      ) : (
        <ul className="space-y-3">
          {(q.data ?? []).map((h) => (
            <li key={h.id} className="rounded-xl border border-slate-100 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-400" dir="ltr">
                  {formatDate(h.at, lang)}
                </span>
                <span className="text-[11px] font-bold text-slate-500">{h.user}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <MoneyI18n value={h.oldPrice} className="text-slate-400 line-through" />
                <span className="text-slate-300">←</span>
                <MoneyI18n value={h.newPrice} className="font-extrabold text-slate-800" />
              </div>
              {h.reason && <div className="mt-1 text-xs font-medium text-slate-500">{h.reason}</div>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
