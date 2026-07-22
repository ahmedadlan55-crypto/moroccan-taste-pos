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
import { useUpdatePrice, usePriceHistory, type MenuItem } from "./api";
import { MoneyI18n, marginPct } from "./lib";

/** The minimal shape both the list row and the detail read satisfy. */
export interface PriceTarget {
  id: string;
  name: string;
  price: number;
  cost: number;
}

export function toPriceTarget(item: MenuItem): PriceTarget {
  return { id: item.id, name: item.name, price: item.price, cost: item.cost };
}

export function PriceEditDialog({ item, onClose }: { item: PriceTarget; onClose: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const update = useUpdatePrice();
  const [price, setPrice] = useState<number | null>(item.price);
  const [reason, setReason] = useState("");

  const reasonOk = reason.trim().length >= 3;
  const priceOk = price != null && price >= 0;
  const preview = priceOk ? marginPct(price!, item.cost) : 0;

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
                { id: item.id, price: price!, reason: reason.trim() },
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
          <MoneyI18n value={item.price} className="font-extrabold text-slate-700" />
        </div>
        <Field label={t("menu.price.newPrice")} required>
          {({ id }) => <CurrencyInput id={id} value={price} onChange={setPrice} min={0} />}
        </Field>
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
