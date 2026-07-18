/**
 * فواتيري · My Invoices — parity with the legacy #modalMyInvoices
 * (public/pos/app.js:3288-3553, markup public/pos/index.html).
 *
 * Legacy behaviour reproduced exactly:
 *   • pulls TODAY's sales then narrows to the ACTIVE SHIFT client-side — the
 *     GET /api/sales endpoint has no shift filter (routes/sales.js:1715), which
 *     is why the old POS filters in the browser (app.js:3300).
 *   • stat strip: total · active · cancelled · returned · amount, where the
 *     amount EXCLUDES reversed docs.
 *   • status badge, time, invoice number + system ref, first 3 products + "+N",
 *     payment method + notes, and per-row Cancel / Return actions.
 *   • a reversed row is inert — legacy shows "تم — لا إجراءات".
 *
 * Beyond parity (explicitly requested): search + filter, which the legacy modal
 * never had (audited gap `myinv-no-search-filter`).
 *
 * Void/return go through the LEGACY financial path on purpose: they move money
 * and must reuse the same ZATCA + GL + stock reversal as the old cashier.
 */
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, FileText, Printer, RotateCcw, Search, Undo2 } from "lucide-react";
import { getInvoice, listSales, returnSale, voidSale, ApiError, type InvoiceDetail } from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2, fmtInt } from "@/lib/format";
import { buildReceiptHtml, printHtml, resolvePaperWidth } from "@/lib/receipt";
import type { ApproverCredentials, LocalOrder, Payment, ReceiptIdentity, SaleRow } from "@/lib/types";
import { usePos } from "@/state/store";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Money, Skeleton, cn } from "../ui";
import { ManagerApprovalDialog } from "./ManagerApprovalDialog";

type Filter = "all" | "active" | "cancelled" | "returned";

/**
 * Does this action need the manager-approval dialog?
 * Legacy parity (public/pos/app.js:3519-3525): admin/manager never see it, and
 * the owner can opt VOIDS out via settings.RequireManagerApprovalForVoid='0'
 * (delivered to the client on the catalog as `requireVoidApproval`). RETURNS
 * are never opted out — money leaves the till. The SERVER re-checks the same
 * setting either way (routes/sales.js:_requireManagerApproval); this only
 * decides whether to SHOW a dialog the server would wave through.
 */
export function needsApprovalGate(action: "void" | "return", privileged: boolean, requireVoidApproval: boolean): boolean {
  if (privileged) return false;
  if (action === "void" && !requireVoidApproval) return false;
  return true;
}

/**
 * Build the REPRINT receipt from GET /api/sales/invoice/:orderId — pure, so
 * the vitest suite can assert the fetched (server-stamped) QR and the reversal
 * stamp reach the HTML. Fidelity rules:
 *  • identity = the invoice's frozen seller snapshot; catalog identity only
 *    when the invoice carries none (pre-snapshot sales).
 *  • QR = zatcaQr.qrDataUrl EXACTLY as fetched — NEVER derived client-side.
 *  • totals = the RECORDED figures (totalFinal/discount); VAT derived from the
 *    recorded total like the legacy template's fallback, since the invoice
 *    endpoint does not echo per-line categories.
 *  • a reversed document prints with its ملغاة/مرتجع stamp + serial.
 */
export function reprintHtmlFromInvoice(inv: InvoiceDetail, catalog: unknown, fallbackCashier: string): string {
  const cat = catalog as { identity?: ReceiptIdentity | null; receiptShowFields?: null; vatRate?: number } | null;
  const vatRate = Number(cat?.vatRate) || 15;
  const now = Date.now();

  const doc: LocalOrder = {
    id: inv.orderId,
    status: "completed",
    orderType: "takeaway",
    tableNo: null,
    shiftId: null,
    deviceId: null,
    discountType: inv.discountAmount > 0 ? "FIXED" : null,
    discountValue: inv.discountAmount > 0 ? inv.discountAmount : 0,
    discountName: inv.discountName || null,
    note: null,
    customerId: inv.customerId,
    customerName: inv.customerName || null,
    customerPhone: inv.customerPhone || null,
    lines: (inv.items ?? []).map((it) => ({
      menuId: "",
      name: it.name,
      qty: Number(it.qty) || 0,
      unitPrice: Number(it.price) || 0,
      lineDiscount: 0,
      vatCategory: "S",
      notes: null,
    })),
    serverVersion: null,
    invoiceNumber: inv.invoiceNumber,
    saleId: inv.orderId,
    createdAt: now,
    updatedAt: now,
  };

  const payments = (
    inv.splitDetails && inv.splitDetails.length
      ? inv.splitDetails.map((d) => ({ method: d.method, amount: Number(d.amount) || 0 }))
      : [{ method: inv.payment || "كاش", amount: Number(inv.totalFinal) || 0 }]
  ) as Payment[];

  // Identity: the invoice's frozen seller block wins (identitySource snapshot/
  // live is resolved server-side); the cached catalog identity is only a
  // fallback for sales that carry none.
  const identity: ReceiptIdentity | null = inv.companyName
    ? {
        sellerName: inv.companyName,
        legalName: "",
        taxNumber: inv.taxNumber || "",
        crNumber: inv.crNumber || "",
        address: inv.branchAddress || "",
        nationalAddress: inv.nationalAddress || "",
        phone: inv.companyPhone || "",
        email: inv.companyEmail || "",
        logo: "",
        currency: inv.currency || "SAR",
        vatRate,
        header: inv.receiptHeader || "",
        footer: inv.receiptFooter || "",
        thankYou: inv.receiptThankYou || "",
        returnPolicy: inv.receiptReturnPolicy || "",
        branchName: inv.branchName || "",
        branchCompanyName: inv.branchCompanyName || "",
        brandName: inv.brandName || "",
      }
    : (cat?.identity ?? null);

  const stamp =
    inv.zatcaType === "cancellation"
      ? `ملغاة · VOIDED${inv.voidSerial ? ` #${inv.voidSerial}` : ""}`
      : inv.zatcaType === "credit_note"
        ? `مرتجع · RETURNED${inv.returnSerial ? ` #${inv.returnSerial}` : ""}`
        : null;

  const total = Number(inv.totalFinal) || 0;
  const subtotal = round2((inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0));
  const parsedDate = new Date(inv.date);

  return buildReceiptHtml({
    order: doc,
    payments,
    invoiceNumber: inv.invoiceNumber,
    cashTendered: Number(inv.cashTendered) || 0,
    changeDue: Number(inv.changeDue) || 0,
    cashierName: inv.cashierName || fallbackCashier,
    vatRate,
    identity,
    showFields: cat?.receiptShowFields ?? null,
    zatcaQrDataUrl: inv.zatcaQr?.qrDataUrl ?? null,
    paperWidth: resolvePaperWidth(catalog),
    printedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
    stamp,
    totalsOverride: {
      subtotal,
      lineDiscountTotal: 0,
      discountAmount: Number(inv.discountAmount) || 0,
      vatTotal: round2(total - total / (1 + vatRate / 100)),
      total,
    },
  });
}

/** A row is reversed when it carries a cancellation or credit-note ZATCA type. */
const isReversed = (r: SaleRow) => r.zatcaType === "cancellation" || r.zatcaType === "credit_note";
const isCancelled = (r: SaleRow) => r.zatcaType === "cancellation";
const isReturned = (r: SaleRow) => r.zatcaType === "credit_note";

/** Local YYYY-MM-DD — must match the server's DATE(order_date) in local time. */
function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function StatusBadge({ row }: { row: SaleRow }) {
  if (isCancelled(row)) {
    return (
      <span className="chip border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-extrabold text-red-700">
        ملغاة
        {row.voidSerial ? <span className="num opacity-70">#{row.voidSerial}</span> : null}
      </span>
    );
  }
  if (isReturned(row)) {
    return (
      <span className="chip border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-extrabold text-orange-700">
        مرتجع
        {row.returnSerial ? <span className="num opacity-70">#{row.returnSerial}</span> : null}
      </span>
    );
  }
  return (
    <span className="chip border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold text-teal-700">سارية</span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className={cn("chip px-2.5 py-1 text-[11px] font-extrabold", tone)}>
      {label} <span className="num">{value}</span>
    </span>
  );
}

export function MyInvoicesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, shiftId, pushToast, engineStatus, catalog } = usePos();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pending, setPending] = useState<{ row: SaleRow; action: "void" | "return" } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);

  // Privileged roles skip the approval dialog — the server still authorizes.
  const isPrivileged = ["admin", "manager"].includes(String(user?.role ?? "").toLowerCase());
  // Owner opt-out (void only) — rides in on the catalog; absent → gated.
  const requireVoidApproval =
    (catalog as unknown as { requireVoidApproval?: boolean } | null)?.requireVoidApproval !== false;

  const invoicesQuery = useQuery({
    queryKey: ["my-invoices", user?.username, shiftId],
    queryFn: () => listSales({ startDate: todayISO(), endDate: todayISO(), username: user?.username }),
    enabled: open && !!user && engineStatus.online,
  });

  // Narrow to the active shift exactly like the legacy POS. With no open shift
  // we show nothing rather than the whole day — matching legacy's empty state.
  const rows = useMemo(() => {
    const all = invoicesQuery.data ?? [];
    return shiftId ? all.filter((r) => r.shiftId === shiftId) : [];
  }, [invoicesQuery.data, shiftId]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => !isReversed(r));
    return {
      total: rows.length,
      active: active.length,
      cancelled: rows.filter(isCancelled).length,
      returned: rows.filter(isReturned).length,
      // Legacy excludes reversed documents from the money total (app.js:3355).
      amount: active.reduce((s, r) => s + (Number(r.total) || 0), 0),
    };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && isReversed(r)) return false;
      if (filter === "cancelled" && !isCancelled(r)) return false;
      if (filter === "returned" && !isReturned(r)) return false;
      if (!q) return true;
      return (
        (r.invoiceNumber ?? "").toLowerCase().includes(q) ||
        r.orderId.toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.payment ?? "").toLowerCase().includes(q) ||
        r.items.some((it) => (it.name ?? "").toLowerCase().includes(q))
      );
    });
  }, [rows, query, filter]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["my-invoices"] });
  }, [queryClient]);

  const reverse = useMutation({
    mutationFn: async (v: { row: SaleRow; action: "void" | "return"; creds?: ApproverCredentials; reason: string }) =>
      v.action === "void" ? voidSale(v.row.orderId, v.creds) : returnSale(v.row.orderId, v.reason, v.creds),
    onSuccess: (_d, v) => {
      pushToast("success", v.action === "void" ? "أُلغيت الفاتورة" : "سُجّل المرتجع (إشعار دائن)");
      setPending(null);
      setApprovalError(null);
      refresh();
    },
    onError: (e: unknown, v) => {
      const err = e as ApiError;
      // ORDER_TO_CASH_ENABLE=1 makes middleware/o2cLegacyGate reject the legacy
      // reverse path with 409 (server.js:590) because reversals moved to the
      // append-only O2C credit note. The LEGACY POS hits the same wall — its
      // إلغاء button is equally dead in this configuration. Say so plainly
      // rather than showing the raw gate message, which redirects to /sales — a
      // SPA that no longer exists.
      if (err?.code === "O2C_MODULE_ACTIVE") {
        pushToast(
          "error",
          "الإلغاء والمرتجع منقولان إلى وحدة «المبيعات والعملاء» — غير متاحين من الكاشير حاليًا.",
        );
        setPending(null);
        return;
      }
      // approval_required means the server rejected the credentials (or none
      // were sent) — keep the dialog open so the manager can retry.
      if (err?.code === "approval_required" || err?.status === 403) {
        if (pending) {
          setApprovalError(err.message);
          return;
        }
        // Privileged path that still got refused → open the gate as a fallback.
        setApprovalError(err.message);
        setPending({ row: v.row, action: v.action });
        return;
      }
      pushToast("error", err?.message ?? "تعذّر تنفيذ الإجراء");
      setPending(null);
    },
  });

  function start(row: SaleRow, action: "void" | "return") {
    setApprovalError(null);
    if (!needsApprovalGate(action, isPrivileged, requireVoidApproval)) {
      // No dialog: admin/manager (legacy bypass, app.js:3527) or the owner
      // opted voids out (app.js:3519 — the server skips the same gate).
      // A return still needs a reason; legacy defaults it (app.js:3547).
      reverse.mutate({ row, action, reason: action === "return" ? "مرتجع عميل" : "" });
      return;
    }
    setPending({ row, action });
  }

  /** Reprint (فواتيري → طباعة): fetch the invoice (identity + STAMPED QR) and
   *  print it through the same window path as first prints. Works for reversed
   *  rows too — those print with their ملغاة/مرتجع stamp. */
  async function reprint(row: SaleRow) {
    setPrintingId(row.orderId);
    try {
      const inv = await getInvoice(row.orderId);
      if (!inv) throw new Error("تعذّر تحميل بيانات الفاتورة للطباعة");
      const ok = printHtml(reprintHtmlFromInvoice(inv, catalog, row.username || user?.username || ""));
      if (!ok) pushToast("error", "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة");
    } catch (e) {
      pushToast("error", (e as Error).message || "تعذّرت طباعة الفاتورة");
    } finally {
      setPrintingId(null);
    }
  }

  const busy = reverse.isPending;

  return (
    <>
      <Dialog open={open} onClose={onClose} title="فواتيري · My Invoices" widthClass="max-w-5xl">
        <div className="flex flex-col gap-3">
          {/* Stat strip — parity with legacy #myInvStats */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Stat label="الإجمالي" value={fmtInt(stats.total)} tone="border-slate-200 bg-slate-50 text-slate-600" />
            <Stat label="سارية" value={fmtInt(stats.active)} tone="border-teal-200 bg-teal-50 text-teal-700" />
            <Stat label="ملغاة" value={fmtInt(stats.cancelled)} tone="border-red-200 bg-red-50 text-red-700" />
            <Stat label="مرتجع" value={fmtInt(stats.returned)} tone="border-orange-200 bg-orange-50 text-orange-700" />
            <Stat label="ر.س" value={fmt2(stats.amount)} tone="border-sky-200 bg-sky-50 text-sky-700" />
            <Button size="sm" variant="ghost" className="ms-auto" onClick={refresh} disabled={invoicesQuery.isFetching}>
              <RotateCcw className={cn("h-3.5 w-3.5", invoicesQuery.isFetching && "animate-spin")} aria-hidden />
              تحديث
            </Button>
          </div>

          {/* Search + filter — NOT in the legacy modal; requested addition */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-slate-400" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="بحث برقم الفاتورة أو العميل أو الصنف…"
                className="min-h-11 w-full rounded-xl border border-slate-200 ps-9 pe-3 text-sm font-bold text-ink outline-none focus:border-teal-500"
              />
            </div>
            <div className="flex gap-1">
              {(
                [
                  ["all", "الكل"],
                  ["active", "سارية"],
                  ["cancelled", "ملغاة"],
                  ["returned", "مرتجع"],
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    "btn-press min-h-11 rounded-xl px-3 text-xs font-bold",
                    filter === f ? "bg-ink text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          {!engineStatus.online ? (
            <ErrorBanner message="عرض الفواتير يتطلب اتصالًا بالخادم — الفواتير السابقة غير محفوظة على الجهاز." />
          ) : !shiftId ? (
            <EmptyState icon={<FileText className="h-10 w-10" />} title="لا توجد وردية مفتوحة" hint="افتح وردية لعرض فواتيرها." />
          ) : invoicesQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : invoicesQuery.isError ? (
            <ErrorBanner message={(invoicesQuery.error as Error).message} onRetry={refresh} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-10 w-10" />}
              title={rows.length === 0 ? "لا توجد فواتير في هذه الوردية بعد" : "لا نتائج مطابقة"}
              hint={rows.length === 0 ? "ستظهر الفواتير هنا فور إتمام أول عملية بيع." : "جرّب بحثًا أو تصفية مختلفة."}
            />
          ) : (
            <div className="scrollbar-thin max-h-[55vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-start text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
                  <tr>
                    <th className="p-2 text-start">الحالة</th>
                    <th className="p-2 text-start">الوقت</th>
                    <th className="p-2 text-start">رقم الفاتورة</th>
                    <th className="hidden p-2 text-start sm:table-cell">المنتجات</th>
                    <th className="p-2 text-start">الإجمالي</th>
                    <th className="hidden p-2 text-start md:table-cell">الدفع</th>
                    <th className="p-2 text-start">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const reversed = isReversed(r);
                    const shown = r.items.slice(0, 3);
                    const more = r.items.length - shown.length;
                    return (
                      <tr
                        key={r.orderId}
                        className={cn("border-t border-slate-100 align-top", reversed && "bg-slate-50/70 opacity-70")}
                      >
                        <td className="p-2">
                          <StatusBadge row={r} />
                        </td>
                        <td className="num p-2 text-slate-500">
                          {new Date(r.date).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="p-2">
                          <div className="num font-extrabold text-ink">{r.invoiceNumber ?? r.orderId}</div>
                          {r.invoiceNumber ? <div className="num text-[10px] text-slate-400">{r.orderId}</div> : null}
                          {r.customerName ? <div className="text-[10px] font-bold text-slate-500">{r.customerName}</div> : null}
                        </td>
                        <td className="hidden p-2 sm:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {shown.map((it, i) => (
                              <span key={i} className="chip border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600">
                                <span className="num">{it.qty ?? 1}×</span> {it.name ?? "—"}
                              </span>
                            ))}
                            {more > 0 ? <span className="num text-[10px] font-bold text-slate-400">+{more}</span> : null}
                          </div>
                        </td>
                        <td className="p-2">
                          <Money value={fmt2(Number(r.total) || 0)} className="font-extrabold text-ink" />
                        </td>
                        <td className="hidden p-2 md:table-cell">
                          <div className="font-bold text-slate-600">{r.payment ?? "—"}</div>
                          {r.paymentNotes ? <div className="text-[10px] text-slate-400">{r.paymentNotes}</div> : null}
                        </td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || printingId === r.orderId}
                              loading={printingId === r.orderId}
                              onClick={() => void reprint(r)}
                              title="إعادة طباعة الفاتورة (برمز ZATCA المختوم)"
                            >
                              <Printer className="h-3.5 w-3.5" aria-hidden />
                              طباعة
                            </Button>
                            {reversed ? (
                              <span className="self-center text-[10px] font-bold text-slate-400">تم — لا إجراءات</span>
                            ) : (
                              <>
                                <Button size="sm" variant="danger" disabled={busy} onClick={() => start(r, "void")}>
                                  <Ban className="h-3.5 w-3.5" aria-hidden />
                                  إلغاء
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => start(r, "return")}
                                  className="border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
                                >
                                  <Undo2 className="h-3.5 w-3.5" aria-hidden />
                                  مرتجع
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Dialog>

      <ManagerApprovalDialog
        open={!!pending}
        title={pending?.action === "void" ? "اعتماد إلغاء فاتورة" : "اعتماد مرتجع"}
        reasonLabel={pending?.action === "return" ? "سبب الإرجاع" : undefined}
        defaultReason={pending?.action === "return" ? "مرتجع عميل" : undefined}
        busy={busy}
        error={approvalError}
        onClose={() => {
          setPending(null);
          setApprovalError(null);
        }}
        onSubmit={(creds, reason) => {
          if (!pending) return;
          reverse.mutate({ row: pending.row, action: pending.action, creds, reason });
        }}
      />
    </>
  );
}
