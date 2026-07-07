/**
 * Held orders board — server-held (GET /api/pos/v2/orders?status=held) merged
 * with local-held docs (offline holds that haven't synced yet). Resume loads
 * the order into the cart; void requires a reason.
 */
import { useCallback, useEffect, useState } from "react";
import { PauseCircle, PlayCircle, RefreshCw, XCircle } from "lucide-react";
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
  const { engine, engineStatus, cart, loadOrderDoc, pushToast } = usePos();
  const [rows, setRows] = useState<HeldRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

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
    if (cart.lines.length > 0) {
      pushToast("error", "علّق الطلب الحالي أو أفرغه قبل استعادة طلب آخر");
      return;
    }
    setBusyId(row.doc.id);
    try {
      if (row.source === "server") {
        const res = await transition(row.doc.id, "resume", {});
        const doc: LocalOrder = { ...row.doc, status: "open", serverVersion: res.version, updatedAt: Date.now() };
        await engine.putOrder(doc);
        loadOrderDoc(doc);
      } else {
        const doc = await engine.resumeLocalOrder(row.doc);
        loadOrderDoc(doc);
      }
      pushToast("success", "تمت استعادة الطلب إلى السلة");
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
      pushToast("success", "أُلغي الطلب المعلق");
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
    <Dialog open={open} onClose={onClose} title="الطلبات المعلقة" widthClass="max-w-2xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-bold text-slate-400">
          {rows ? (
            <>
              <span className="num">{fmtInt(rows.length)}</span> طلب معلق
              {!engineStatus.online ? " (المحلية فقط — لا اتصال)" : ""}
            </>
          ) : (
            "جارٍ التحميل…"
          )}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          تحديث
        </Button>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<PauseCircle className="h-10 w-10" aria-hidden />} title="لا طلبات معلقة" hint="علّق طلبًا من السلة ليظهر هنا" />
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
                          طاولة <Money value={row.doc.tableNo} />
                        </span>
                      ) : null}
                      {row.source === "local" ? (
                        <span className="chip ms-2 border-amber-300 bg-amber-50 text-amber-800">محلي — غير مزامن</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[11px] font-bold text-slate-400">
                      <span className="num">{fmtInt(row.doc.lines.length)}</span> صنف ·{" "}
                      <Money value={fmt2(total)} /> ر.س · <span className="num">{fmtDateTime(row.doc.updatedAt)}</span>
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">
                      {row.doc.lines.map((l) => `${l.name} ×${l.qty}`).join("، ")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busyId === row.doc.id}
                    disabled={row.source === "server" && !engineStatus.online}
                    title={row.source === "server" && !engineStatus.online ? "استعادة طلب من الخادم تتطلب اتصالًا" : "استعادة إلى السلة"}
                    onClick={() => void resume(row)}
                  >
                    <PlayCircle className="h-4 w-4" aria-hidden />
                    استعادة
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === row.doc.id || offlineVoidBlocked}
                    title={offlineVoidBlocked ? "إلغاء طلب مزامَن غير متاح بلا اتصال" : "إلغاء الطلب"}
                    onClick={() => {
                      setVoidingId(voidingId === row.doc.id ? null : row.doc.id);
                      setVoidReason("");
                    }}
                  >
                    <XCircle className="h-4 w-4" aria-hidden />
                    إلغاء
                  </Button>
                </div>
                {voidingId === row.doc.id ? (
                  <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2">
                    <input
                      type="text"
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder="سبب الإلغاء (إلزامي)"
                      className="field flex-1"
                      maxLength={300}
                    />
                    <Button size="sm" variant="danger" disabled={!voidReason.trim() || busyId === row.doc.id} onClick={() => void confirmVoid(row)}>
                      تأكيد الإلغاء
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
