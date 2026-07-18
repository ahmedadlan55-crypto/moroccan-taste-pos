/**
 * طلب مرتجع · Sales-return request (close2/pos-returns).
 *
 * The cashier-facing entry into the Order-to-Cash returns flow. It opens on an
 * existing sale, fetches that invoice's lines, lets the cashier pick per-line
 * return quantities + a mandatory reason, and POSTs a DRAFT return via
 * `createSalesReturn` (POST /api/order-to-cash/returns, capability returns.create
 * — which the cashier role holds).
 *
 * Division of authority — deliberately narrow:
 *   • The cashier RAISES the return (draft). Approving + posting it (the money
 *     movement + credit note) is a MANAGER action elsewhere, so this dialog only
 *     ever shows the resulting draft awaiting approval.
 *   • `restock` is ALWAYS false here (baked into createSalesReturn) — putting
 *     goods back on the shelf moves stock + reverses COGS and needs
 *     returns.restock, which the cashier does not hold.
 *   • The SERVER is the authority on remaining-returnable quantity (OVER_RETURN),
 *     tax/cost snapshotting and separation-of-duties. Client-side qty validation
 *     is only immediate feedback; the server decides.
 *
 * Only reachable when o2cEnabled is true — MyInvoicesDialog routes the «مرتجع»
 * button here in that mode and keeps the legacy returnSale() path when off, so
 * turning the flag off is a zero-risk rollback.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileText, Undo2 } from "lucide-react";
import { ApiError, createSalesReturn, getInvoice, type InvoiceDetail } from "@/lib/api";
import { fmt2 } from "@/lib/format";
import { ulid } from "@/lib/ulid";
import type { SaleRow } from "@/lib/types";
import { usePos } from "@/state/store";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Money, Skeleton, cn } from "../ui";

/** The invoice-detail line, widened to read the per-line identity + document
 *  version the RETURN path needs. The base InvoiceDetail (reprint-oriented) does
 *  not declare these; they are supplied by the invoice-detail response for the
 *  returns flow (originalLineId = ar_document_lines.id). Read defensively so the
 *  dialog still renders before that contract lands, falling back to the line's
 *  position (which the server rejects — the real id is required to submit). */
type InvoiceLineWithId = InvoiceDetail["items"][number] & { id?: string; lineId?: string };
type InvoiceWithVersion = InvoiceDetail & { version?: number | null };

interface ReturnLine {
  originalLineId: string;
  name: string;
  soldQty: number;
  unitPrice: number;
}

/** Map the create endpoint's returned status to a plain cashier message. A fresh
 *  return is always 'draft'; the rest are defensive so a differently-configured
 *  flow still reads honestly instead of a generic "queued". */
export function returnStatusMessage(status: string | null | undefined): string {
  switch (String(status || "")) {
    case "draft":
      return "تم إنشاء طلب المرتجع — بانتظار اعتماد المدير";
    case "approved":
      return "تم إنشاء المرتجع واعتماده — بانتظار الترحيل";
    case "posted":
      return "تم إنشاء المرتجع وترحيله";
    default:
      return `تم إنشاء طلب المرتجع (الحالة: ${status || "غير معروفة"})`;
  }
}

/** Turn a create failure into a specific, readable Arabic line. OVER_RETURN in
 *  particular must NOT collapse into a generic toast — it tells the cashier a
 *  quantity is beyond what is still returnable, which is actionable. */
export function returnErrorMessage(e: unknown): string {
  const err = e as ApiError;
  if (err?.code === "OVER_RETURN") {
    return `الكمية المطلوبة تتجاوز المتاح للإرجاع${err.message ? ` — ${err.message}` : ""}`;
  }
  if (err?.code === "SOD_VIOLATION") {
    return err.message || "لا يمكن اعتماد مرتجع أنشأته بنفسك.";
  }
  return err?.message || "تعذّر إنشاء طلب المرتجع";
}

export function ReturnRequestDialog({
  open,
  row,
  onClose,
  onCreated,
}: {
  open: boolean;
  row: SaleRow | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { pushToast } = usePos();
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ status: string | null; documentNumber: string | null } | null>(null);

  const orderId = row?.orderId ?? "";

  const invoiceQuery = useQuery({
    queryKey: ["return-invoice", orderId],
    queryFn: () => getInvoice(orderId),
    enabled: open && !!orderId,
  });

  // Reset the form whenever the dialog (re)opens on a different sale.
  useEffect(() => {
    if (!open) return;
    setQtys({});
    setReason("");
    setResult(null);
  }, [open, orderId]);

  const lines = useMemo<ReturnLine[]>(() => {
    const inv = invoiceQuery.data;
    if (!inv) return [];
    return (inv.items ?? []).map((it, idx) => {
      const m = it as InvoiceLineWithId;
      return {
        originalLineId: m.lineId ?? m.id ?? String(idx),
        name: it.name,
        soldQty: Number(it.qty) || 0,
        unitPrice: Number(it.price) || 0,
      };
    });
  }, [invoiceQuery.data]);

  const expectedVersion = (invoiceQuery.data as InvoiceWithVersion | null | undefined)?.version ?? null;

  // A line is over-entered when its qty exceeds what was SOLD. The server is the
  // real authority (remaining = sold − previously returned, via OVER_RETURN) but
  // this catches the obvious mistake before a round-trip.
  const overEntered = useMemo(
    () => lines.filter((l) => (qtys[l.originalLineId] ?? 0) > l.soldQty).map((l) => l.originalLineId),
    [lines, qtys],
  );

  const selected = useMemo(
    () =>
      lines
        .filter((l) => (qtys[l.originalLineId] ?? 0) > 0)
        .map((l) => ({ originalLineId: l.originalLineId, returnQty: qtys[l.originalLineId] })),
    [lines, qtys],
  );

  const submit = useMutation({
    mutationFn: () =>
      createSalesReturn(
        { originalSaleId: orderId, reason: reason.trim(), lines: selected },
        { idempotencyKey: ulid(), expectedVersion },
      ),
    onSuccess: (res) => {
      setResult({
        status: res.status ?? res.data?.status ?? "draft",
        documentNumber: res.documentNumber ?? res.data?.return_number ?? null,
      });
      onCreated?.();
    },
  });

  function setQty(id: string, raw: string) {
    const n = Math.max(0, Number(raw) || 0);
    setQtys((s) => ({ ...s, [id]: n }));
  }

  const canSubmit =
    !!invoiceQuery.data &&
    selected.length > 0 &&
    reason.trim().length > 0 &&
    overEntered.length === 0 &&
    !submit.isPending;

  const busy = submit.isPending;

  // ── Success panel ───────────────────────────────────────────────────────────
  const doneBody = result ? (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <CheckCircle2 className="h-12 w-12 text-teal-600" aria-hidden />
      <p className="text-sm font-extrabold text-ink">{returnStatusMessage(result.status)}</p>
      {result.documentNumber ? (
        <p className="text-xs font-bold text-slate-500">
          رقم المرتجع: <span className="num text-sm font-extrabold text-teal-700">{result.documentNumber}</span>
        </p>
      ) : null}
      <p className="text-[11px] font-bold text-slate-400">
        الحالة: <span className="num">{result.status || "—"}</span> — لا تُصرف قيمة حتى يعتمد المدير المرتجع ويُرحّله.
      </p>
    </div>
  ) : null;

  // ── Form body ───────────────────────────────────────────────────────────────
  const formBody = (
    <div className="flex flex-col gap-3">
      {row ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs font-bold text-slate-600">
          <span>الفاتورة الأصلية:</span>
          <span className="num font-extrabold text-ink">{row.invoiceNumber ?? row.orderId}</span>
          <Money value={fmt2(Number(row.total) || 0)} className="ms-auto font-extrabold text-ink" />
        </div>
      ) : null}

      {submit.isError ? <ErrorBanner message={returnErrorMessage(submit.error)} /> : null}

      {invoiceQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : invoiceQuery.isError ? (
        <ErrorBanner
          message={(invoiceQuery.error as Error)?.message || "تعذّر تحميل بيانات الفاتورة"}
          onRetry={() => void invoiceQuery.refetch()}
        />
      ) : !invoiceQuery.data || lines.length === 0 ? (
        <EmptyState icon={<FileText className="h-10 w-10" aria-hidden />} title="لا توجد أصناف قابلة للإرجاع في هذه الفاتورة" />
      ) : (
        <div className="scrollbar-thin max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
          <table className="w-full text-start text-xs">
            <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
              <tr>
                <th className="p-2 text-start">الصنف</th>
                <th className="p-2 text-center">المُباع</th>
                <th className="p-2 text-center">السعر</th>
                <th className="p-2 text-center">كمية الإرجاع</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const isOver = overEntered.includes(l.originalLineId);
                return (
                  <tr key={l.originalLineId} className="border-t border-slate-100 align-top">
                    <td className="p-2 font-extrabold text-ink">{l.name || "—"}</td>
                    <td className="num p-2 text-center text-slate-500">{fmt2(l.soldQty)}</td>
                    <td className="num p-2 text-center text-slate-500">{fmt2(l.unitPrice)}</td>
                    <td className="p-2 text-center">
                      <input
                        type="number"
                        min={0}
                        max={l.soldQty}
                        step="0.01"
                        inputMode="decimal"
                        value={qtys[l.originalLineId] || ""}
                        onChange={(e) => setQty(l.originalLineId, e.target.value)}
                        aria-label={`كمية إرجاع ${l.name || l.originalLineId}`}
                        aria-invalid={isOver}
                        placeholder="0"
                        className={cn(
                          "field num min-h-11 w-20 text-center font-extrabold",
                          isOver && "border-red-400 text-red-700",
                        )}
                      />
                      {isOver ? (
                        <div className="mt-1 text-[10px] font-bold text-red-600">الكمية تتجاوز المُباع</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Mandatory reason */}
      <div>
        <label htmlFor="return-reason" className="mb-1 block text-xs font-extrabold text-slate-600">
          سبب الإرجاع <span className="text-red-500">*</span>
        </label>
        <input
          id="return-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثال: صنف غير مطابق، طلب العميل الإلغاء…"
          aria-label="سبب الإرجاع"
          className="field min-h-11 w-full"
          maxLength={300}
        />
      </div>

      <p className="text-[11px] font-semibold text-slate-400">
        تُحتسب القيم (السعر/الضريبة/التكلفة) تناسبيًا في الخادم من الفاتورة الأصلية، ويعتمد المدير المرتجع قبل صرف أي قيمة.
      </p>
    </div>
  );

  const footer = result ? (
    <Button variant="primary" className="w-full" onClick={onClose}>
      إغلاق
    </Button>
  ) : (
    <div className="flex items-center justify-end gap-2">
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        إلغاء
      </Button>
      <Button
        variant="primary"
        loading={busy}
        disabled={!canSubmit}
        onClick={() => {
          if (!reason.trim()) return pushToast("error", "سبب الإرجاع مطلوب");
          submit.mutate();
        }}
      >
        <Undo2 className="h-4 w-4" aria-hidden />
        إنشاء طلب المرتجع
      </Button>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={result ? "تم إنشاء طلب المرتجع" : "طلب مرتجع · Sales Return"}
      widthClass="max-w-2xl"
      footer={footer}
      locked={busy}
    >
      {result ? doneBody : formBody}
    </Dialog>
  );
}
