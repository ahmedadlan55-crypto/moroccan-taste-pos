/**
 * Held orders board — server-held (GET /api/pos/v2/orders?status=held) merged
 * with local-held docs (offline holds that haven't synced yet). Resume loads
 * the order into the cart; void requires a reason.
 *
 * RESUME WITH A NON-EMPTY CART. This board used to simply REFUSE — «علّق الطلب
 * الحالي أو أفرغه قبل استعادة طلب آخر» — which left the cashier to do by hand
 * the one thing the software was already able to do: close the board, tap
 * تعليق, reopen the board, find the row again, tap استعادة. Five interactions,
 * with a queue at the till, for what every restaurant POS does in one.
 *
 * Now the resume action absorbs the hold: when the cart has lines the button
 * says «علّق الحالي واستعد» and does exactly that, in that order — park first,
 * resume second, so a failure to park can never destroy the in-progress order.
 * The label states both halves, so nothing happens by surprise.
 */
import { useCallback, useEffect, useState } from "react";
import { PauseCircle, PlayCircle, RefreshCw, ShoppingCart, XCircle } from "lucide-react";
import { useT, useLocalizedName } from "@/i18n/I18nProvider";
import { usePos } from "@/state/store";
import { listOrders, transition } from "@/lib/api";
import { fmt2, fmtDateTime, fmtInt, shortRef } from "@/lib/format";
import type { LocalOrder, ServerOrder } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Money, Skeleton } from "../ui";

interface HeldRow {
  doc: LocalOrder;
  source: "server" | "local";
  serverVersion: number | null;
}

function serverToLocal(so: ServerOrder): LocalOrder {
  return {
    id: so.id,
    status: so.status,
    orderType: so.orderType,
    tableNo: so.tableNo,
    shiftId: so.shiftId,
    deviceId: so.deviceId,
    discountType: so.discountType,
    discountValue: Number(so.discountValue) || 0,
    discountName: so.discountName,
    note: so.note,
    customerId: so.customerId ?? null, // preserved across hold/resume (O2C)
    customerName: null, // rides inside note ("عميل: …") — not split back out
    customerPhone: null,
    lines: so.lines.map((l) => ({
      menuId: l.menuId,
      name: l.name,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      lineDiscount: Number(l.lineDiscount) || 0,
      vatCategory: l.vatCategory,
      notes: l.notes,
    })),
    serverVersion: so.version,
    invoiceNumber: so.invoiceNumber,
    saleId: so.saleId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function HeldOrdersDialog({
  open,
  onClose,
  onCountChange,
}: {
  open: boolean;
  onClose: () => void;
  onCountChange: (n: number) => void;
}) {
  const t = useT();
  const tn = useLocalizedName();
  const { engine, engineStatus, cart, loadOrderDoc, pushToast } = usePos();
  const [rows, setRows] = useState<HeldRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  /** Drives BOTH the button label and what resume() actually does, so the two
   *  can never disagree. */
  const cartHasLines = cart.lines.length > 0;

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const local = await engine.localHeldOrders();
      let merged: HeldRow[] = local.map((doc) => ({ doc, source: "local" as const, serverVersion: doc.serverVersion }));
      if (engineStatus.online) {
        try {
          const res = await listOrders({ status: "held" });
          const localIds = new Set(local.map((d) => d.id));
          for (const so of res.data) {
            if (localIds.has(so.id)) {
              // Server copy is authoritative for synced orders.
              merged = merged.map((r) => (r.doc.id === so.id ? { doc: serverToLocal(so), source: "server", serverVersion: so.version } : r));
            } else {
              merged.push({ doc: serverToLocal(so), source: "server", serverVersion: so.version });
            }
          }
        } catch (e) {
          setError((e as Error).message);
        }
      }
      merged.sort((a, b) => b.doc.updatedAt - a.doc.updatedAt);
      setRows(merged);
      onCountChange(merged.length);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, [engine, engineStatus.online, onCountChange]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function resume(row: HeldRow) {
    // Snapshot the decision ONCE: `cart` could change under a slow await, and
    // the button label the cashier read must be the behaviour they get.
    const parkCurrent = cart.lines.length > 0;
    setBusyId(row.doc.id);
    try {
      if (parkCurrent) {
        // Park FIRST. If holding fails we stop here with the cart untouched —
        // resuming on top of an unheld order would silently destroy it, which
        // is precisely the outcome the old refusal existed to prevent.
        const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
        try {
          await engine.holdOrder(snapshot);
        } catch {
          pushToast("error", t("heldOrdersDialog.toast.holdCurrentFailed"));
          return;
        }
      }
      if (row.source === "server") {
        const res = await transition(row.doc.id, "resume", {});
        const doc: LocalOrder = { ...row.doc, status: "open", serverVersion: res.version, updatedAt: Date.now() };
        await engine.putOrder(doc);
        loadOrderDoc(doc);
      } else {
        const doc = await engine.resumeLocalOrder(row.doc);
        loadOrderDoc(doc);
      }
      // The badge is computed by App from a callback, and resume never updated
      // it — it stayed stale until something else happened to refetch. One row
      // leaves the board; if we parked the cart, one row joins it.
      if (rows) onCountChange(parkCurrent ? rows.length : Math.max(0, rows.length - 1));
      pushToast("success", parkCurrent ? t("heldOrdersDialog.toast.heldCurrentThenResumed") : t("heldOrdersDialog.toast.resumed"));
      onClose();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmVoid(row: HeldRow) {
    const reason = voidReason.trim();
    if (!reason) return;
    setBusyId(row.doc.id);
    try {
      if (row.source === "server") {
        await transition(row.doc.id, "void", { reason });
        await engine.putOrder({ ...row.doc, status: "voided", updatedAt: Date.now() });
      } else {
        await engine.voidOrder(row.doc, reason);
      }
      pushToast("success", t("heldOrdersDialog.toast.voided"));
      setVoidingId(null);
      setVoidReason("");
      await load();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("heldOrdersDialog.title")} widthClass="max-w-2xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-bold text-slate-400">
          {rows ? (
            <>
              <span className="num">{fmtInt(rows.length)}</span> {t("heldOrdersDialog.heldCount", { count: rows.length })}
              {!engineStatus.online ? t("heldOrdersDialog.offlineSuffix") : ""}
            </>
          ) : (
            t("heldOrdersDialog.loading")
          )}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("heldOrdersDialog.refresh")}
        </Button>
      </div>

      {cartHasLines ? (
        <p className="mb-3 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          <ShoppingCart className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("heldOrdersDialog.cartBusyHint")}
        </p>
      ) : null}

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<PauseCircle className="h-10 w-10" aria-hidden />}
          title={t("heldOrdersDialog.empty.title")}
          hint={t("heldOrdersDialog.empty.hint")}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const total = row.doc.lines.reduce((s, l) => s + l.qty * l.unitPrice - (l.lineDiscount || 0), 0);
            const offlineVoidBlocked = !engineStatus.online && row.serverVersion != null;
            return (
              <li key={row.doc.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-extrabold text-ink">
                      <Money value={shortRef(row.doc.id)} />
                      {row.doc.tableNo ? (
                        <span className="ms-2 text-xs font-bold text-slate-400">
                          {t("heldOrdersDialog.row.table")} <Money value={row.doc.tableNo} />
                        </span>
                      ) : null}
                      {row.source === "local" ? (
                        <span className="chip ms-2 border-amber-300 bg-amber-50 text-amber-800">{t("heldOrdersDialog.row.localBadge")}</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[11px] font-bold text-slate-400">
                      <span className="num">{fmtInt(row.doc.lines.length)}</span> {t("heldOrdersDialog.row.itemCount", { count: row.doc.lines.length })} ·{" "}
                      <Money value={fmt2(total)} /> {t("heldOrdersDialog.row.currency")} · <span className="num">{fmtDateTime(row.doc.updatedAt)}</span>
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">
                      {row.doc.lines.map((l) => `${tn(l.name, l.nameEn)} ×${l.qty}`).join("، ")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busyId === row.doc.id}
                    disabled={row.source === "server" && !engineStatus.online}
                    title={
                      row.source === "server" && !engineStatus.online
                        ? t("heldOrdersDialog.resume.offlineTitle")
                        : cartHasLines
                          ? t("heldOrdersDialog.resume.holdAndResumeTitle")
                          : t("heldOrdersDialog.resume.title")
                    }
                    onClick={() => void resume(row)}
                  >
                    {cartHasLines ? <PauseCircle className="h-4 w-4" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
                    {cartHasLines ? t("heldOrdersDialog.resume.holdAndResumeLabel") : t("heldOrdersDialog.resume.label")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === row.doc.id || offlineVoidBlocked}
                    title={offlineVoidBlocked ? t("heldOrdersDialog.void.offlineTitle") : t("heldOrdersDialog.void.title")}
                    onClick={() => {
                      setVoidingId(voidingId === row.doc.id ? null : row.doc.id);
                      setVoidReason("");
                    }}
                  >
                    <XCircle className="h-4 w-4" aria-hidden />
                    {t("heldOrdersDialog.void.label")}
                  </Button>
                </div>
                {voidingId === row.doc.id ? (
                  <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2">
                    <input
                      type="text"
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder={t("heldOrdersDialog.void.reasonPlaceholder")}
                      className="field flex-1"
                      maxLength={300}
                    />
                    <Button size="sm" variant="danger" disabled={!voidReason.trim() || busyId === row.doc.id} onClick={() => void confirmVoid(row)}>
                      {t("heldOrdersDialog.void.confirm")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
