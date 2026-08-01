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
import {
  getInvoice,
  isFeatureUnavailable,
  listRaisedReturns,
  listSales,
  listSalesReturns,
  returnSale,
  voidSale,
  ApiError,
  type InvoiceDetail,
  type RaisedReturnRef,
  type SalesReturnRow,
} from "@/lib/api";
import { round2 } from "@/lib/cartMath";
import { fmt2, fmtInt } from "@/lib/format";
import { displayNameOf } from "@/lib/auth";
import { buildReceiptHtml, printHtml, resolvePaperWidth, type DocumentLanguage } from "@/lib/receipt";
import type { ApproverCredentials, LocalOrder, Payment, ReceiptIdentity, SaleRow } from "@/lib/types";
import { usePos } from "@/state/store";
import { translateApiError } from "@/i18n/errorCodes";
import { useT } from "@/i18n/I18nProvider";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Money, Skeleton, cn } from "../ui";
import { ManagerApprovalDialog } from "./ManagerApprovalDialog";
import { ReturnRequestDialog } from "./ReturnRequestDialog";

type Filter = "all" | "active" | "cancelled" | "returned";
/** «فواتيري» now has a second surface: the O2C returns this till raised. */
type View = "invoices" | "returns";

/**
 * The i18n key for an O2C return status, so the cashier reads «بانتظار اعتماد
 * المدير» rather than the raw `draft`. Statuses come from the sales_returns
 * lifecycle (SalesReturnService: draft → approved → posted → reversed, plus
 * cancelled). An unknown value renders verbatim — never silently as "done".
 */
export function returnStatusKey(status: string | null | undefined): string | null {
  switch (String(status || "").toLowerCase()) {
    case "draft":
      return "myInvoicesDialog.returns.status.draft";
    case "approved":
      return "myInvoicesDialog.returns.status.approved";
    case "posted":
      return "myInvoicesDialog.returns.status.posted";
    case "reversed":
      return "myInvoicesDialog.returns.status.reversed";
    case "cancelled":
    case "canceled":
      return "myInvoicesDialog.returns.status.cancelled";
    default:
      return null;
  }
}

/** Badge tone per status — approved/posted read as progress, reversed/cancelled
 *  as terminal-negative, draft as waiting. */
export function returnStatusTone(status: string | null | undefined): string {
  switch (String(status || "").toLowerCase()) {
    case "posted":
      return "border-teal-200 bg-teal-50 text-teal-700";
    case "approved":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "reversed":
    case "cancelled":
    case "canceled":
      return "border-red-200 bg-red-50 text-red-700";
    case "draft":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

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

/** 'ar' | 'en' | 'both' from an untrusted value; anything else → undefined
 *  (= invoiceTemplate's own Arabic default, i.e. no behaviour change). */
export function normalizeDocumentLanguage(value: unknown): DocumentLanguage | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "ar" || v === "en" || v === "both" ? (v as DocumentLanguage) : undefined;
}

/**
 * ReceiptLanguage for a REPRINT.
 *
 * invoiceTemplate derives the whole document language from
 * `opts.identity?.language`, and the identity literal below — rebuilt from the
 * invoice's FROZEN seller snapshot — never carried that field. So a shop
 * configured English (or bilingual) printed bilingual originals and Arabic-only
 * reprints of the very same sale. Preference order: the invoice's own value if
 * the server ever ships one (read defensively — InvoiceDetail does not declare
 * it), else the cached catalog identity's, else undefined.
 */
export function resolveReprintLanguage(inv: InvoiceDetail, catalogIdentity?: ReceiptIdentity | null): DocumentLanguage | undefined {
  const loose = inv as InvoiceDetail & { receiptLanguage?: unknown; language?: unknown };
  return (
    normalizeDocumentLanguage(loose.receiptLanguage) ??
    normalizeDocumentLanguage(loose.language) ??
    normalizeDocumentLanguage(catalogIdentity?.language)
  );
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
export function reprintHtmlFromInvoice(
  inv: InvoiceDetail,
  catalog: unknown,
  fallbackCashier: string,
  // Localized reversal-stamp labels. Optional + defaulted to the legacy
  // bilingual Arabic stamp so existing (language-agnostic) callers/tests keep
  // working unchanged; the dialog passes translated labels via useT().
  stampLabels?: { voided: string; returned: string },
): string {
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
  const reprintLanguage = resolveReprintLanguage(inv, cat?.identity ?? null);
  const identity: ReceiptIdentity | null = inv.companyName
    ? {
        language: reprintLanguage,
        sellerName: inv.companyName,
        legalName: "",
        taxNumber: inv.taxNumber || "",
        crNumber: inv.crNumber || "",
        address: inv.branchAddress || "",
        nationalAddress: inv.nationalAddress || "",
        phone: inv.companyPhone || "",
        email: inv.companyEmail || "",
        // The snapshot carries it (brand logo > company logo, resolved server
        // side). Hardcoding "" here made a reprint print a DIFFERENT document
        // from the original — same sale, one with the shop's mark, one without.
        logo: inv.receiptLogo || "",
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
    : cat?.identity
      ? { ...cat.identity, language: reprintLanguage ?? cat.identity.language }
      : null;

  const stamp =
    inv.zatcaType === "cancellation"
      ? `${stampLabels?.voided ?? "ملغاة · VOIDED"}${inv.voidSerial ? ` #${inv.voidSerial}` : ""}`
      : inv.zatcaType === "credit_note"
        ? `${stampLabels?.returned ?? "مرتجع · RETURNED"}${inv.returnSerial ? ` #${inv.returnSerial}` : ""}`
        : null;

  const total = Number(inv.totalFinal) || 0;
  const subtotal = round2((inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0));
  // VAT for the reprint: prefer the PERSISTED per-category snapshot (taxSubtotals,
  // added to GET /api/sales/invoice/:orderId by the companion routes/sales.js
  // stream) over recomputing from the LIVE catalog rate. The old total/(1+rate)
  // formula recomputes from today's rate — a real bug when the catalog rate has
  // changed since the sale — so it survives ONLY as a fallback for pre-migration
  // sales that carry no snapshot. Read defensively so the base InvoiceDetail type
  // (which does not declare taxSubtotals) is left untouched.
  const snapshotVat = (inv as InvoiceDetail & { taxSubtotals?: { vat?: number } | null }).taxSubtotals?.vat;
  const vatTotal = typeof snapshotVat === "number" ? round2(snapshotVat) : round2(total - total / (1 + vatRate / 100));
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
      vatTotal,
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
  const t = useT();
  if (isCancelled(row)) {
    return (
      <span className="chip border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-extrabold text-red-700">
        {t("myInvoicesDialog.badgeCancelled")}
        {row.voidSerial ? <span className="num opacity-70">#{row.voidSerial}</span> : null}
      </span>
    );
  }
  if (isReturned(row)) {
    return (
      <span className="chip border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-extrabold text-orange-700">
        {t("myInvoicesDialog.badgeReturned")}
        {row.returnSerial ? <span className="num opacity-70">#{row.returnSerial}</span> : null}
      </span>
    );
  }
  return (
    <span className="chip border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold text-teal-700">
      {t("myInvoicesDialog.badgeActive")}
    </span>
  );
}

/**
 * «مرتجعاتي» — the returns this till raised, with the status the SERVER says
 * they are at. Before this, a cashier raised an O2C return draft and it
 * vanished: nothing in the POS ever mentioned it again, so "did the manager
 * approve my return?" had no answer short of asking the manager.
 *
 * Degradation, in order of what the cashier can act on:
 *   offline                → the list is a server read; say so.
 *   nothing raised yet     → empty state, no request at all.
 *   403 / 404 (feature)    → "not available from this screen", NOT an error —
 *                            the O2C flag is off or the cashier-portal
 *                            allow-list does not cover GET .../returns yet.
 *   any other failure      → the real message + retry.
 */
function RaisedReturnsPanel({
  raised,
  byId,
  online,
  loading,
  error,
  onRetry,
}: {
  raised: RaisedReturnRef[];
  byId: Map<string, SalesReturnRow>;
  online: boolean;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();

  if (!online) return <ErrorBanner message={t("myInvoicesDialog.offlineBanner")} />;
  if (raised.length === 0) {
    return (
      <EmptyState
        icon={<Undo2 className="h-10 w-10" />}
        title={t("myInvoicesDialog.returns.emptyTitle")}
        hint={t("myInvoicesDialog.returns.emptyHint")}
      />
    );
  }
  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) {
    return isFeatureUnavailable(error) ? (
      <EmptyState
        icon={<Undo2 className="h-10 w-10" />}
        title={t("myInvoicesDialog.returns.unavailableTitle")}
        hint={t("myInvoicesDialog.returns.unavailableHint")}
      />
    ) : (
      <ErrorBanner message={(error as Error)?.message || t("myInvoicesDialog.returns.loadError")} onRetry={onRetry} />
    );
  }

  return (
    <div className="scrollbar-thin max-h-[55vh] overflow-y-auto rounded-xl border border-slate-200">
      <table className="w-full text-start text-xs">
        <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
          <tr>
            <th className="p-2 text-start">{t("myInvoicesDialog.returns.tableStatus")}</th>
            <th className="p-2 text-start">{t("myInvoicesDialog.returns.tableNumber")}</th>
            <th className="p-2 text-start">{t("myInvoicesDialog.returns.tableOriginal")}</th>
            <th className="p-2 text-start">{t("myInvoicesDialog.returns.tableTotal")}</th>
          </tr>
        </thead>
        <tbody>
          {raised.map((r) => {
            const server = byId.get(r.id);
            const statusKey = returnStatusKey(server?.status);
            return (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="p-2">
                  {server ? (
                    <span className={cn("chip px-2 py-0.5 text-[10px] font-extrabold", returnStatusTone(server.status))}>
                      {statusKey ? t(statusKey) : server.status || "—"}
                    </span>
                  ) : (
                    <span
                      className="chip border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-extrabold text-slate-500"
                      title={t("myInvoicesDialog.returns.notInWindowHint")}
                    >
                      {t("myInvoicesDialog.returns.status.unknown")}
                    </span>
                  )}
                </td>
                <td className="p-2">
                  <div className="num font-extrabold text-ink">{server?.returnNumber ?? r.documentNumber ?? r.id}</div>
                  {server?.customerName ? (
                    <div className="text-[10px] font-bold text-slate-500">{server.customerName}</div>
                  ) : null}
                </td>
                <td className="num p-2 text-slate-500">{r.originalSaleId || "—"}</td>
                <td className="p-2">
                  {server ? (
                    <Money value={fmt2(server.totalAmount)} className="font-extrabold text-ink" />
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
  const { user, shiftId, pushToast, engineStatus, catalog, o2cEnabled, posCan } = usePos();
  const t = useT();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>("invoices");
  const [pending, setPending] = useState<{ row: SaleRow; action: "void" | "return" } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  // When O2C is on, «مرتجع» opens the new O2C return-request dialog instead of the
  // legacy (gated) returnSale path. Null = closed.
  const [returnRow, setReturnRow] = useState<SaleRow | null>(null);

  // Privileged roles skip the approval dialog — the server still authorizes.
  // Capability-aware: posCan grants the same skip (broadening only — see
  // lib/capabilities.ts); the server re-authorizes every void/return either way.
  const isPrivileged =
    ["admin", "manager"].includes(String(user?.role ?? "").toLowerCase()) || posCan("pos.sale.void.override");
  // Owner opt-out (void only) — rides in on the catalog; absent → gated.
  const requireVoidApproval =
    (catalog as unknown as { requireVoidApproval?: boolean } | null)?.requireVoidApproval !== false;

  const invoicesQuery = useQuery({
    queryKey: ["my-invoices", user?.username, shiftId],
    // shiftId now filters SERVER-SIDE (companion routes/sales.js stream) instead of
    // pulling the whole day and narrowing in the browser. `shiftId ?? undefined`
    // so listSales' `if (v)` guard omits it when there's no open shift.
    queryFn: () =>
      listSales({ startDate: todayISO(), endDate: todayISO(), username: user?.username, shiftId: shiftId ?? undefined }),
    enabled: open && !!user && engineStatus.online,
  });

  // The server already scoped the list to this shift. We keep a trivial defensive
  // filter as a NO-OP safety net (in case an older backend without the shiftId
  // filter is deployed) AND to preserve the legacy "no open shift → show nothing"
  // behaviour rather than the whole day.
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

  // ── «مرتجعاتي» — the O2C returns THIS till raised ─────────────────────────
  // Two halves, deliberately: the LEDGER (local, identity only — which returns
  // are mine) and the SERVER LIST (authority on status). SalesReturnService.list
  // filters by status / customerId / return_number only; there is no created_by
  // filter and the SELECT does not project the column, so the server cannot
  // answer "mine" and the intersection has to happen here.
  const raised = useMemo(() => (open && view === "returns" ? listRaisedReturns() : []), [open, view]);
  const returnsQuery = useQuery({
    queryKey: ["my-o2c-returns"],
    queryFn: () => listSalesReturns({ pageSize: 100 }),
    enabled: open && view === "returns" && o2cEnabled && engineStatus.online && raised.length > 0,
    retry: false, // a 403/404 is a verdict, not a blip
    staleTime: 10_000,
  });
  const returnsById = useMemo(() => {
    const m = new Map<string, SalesReturnRow>();
    for (const r of returnsQuery.data ?? []) m.set(r.id, r);
    return m;
  }, [returnsQuery.data]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["my-invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["my-o2c-returns"] });
  }, [queryClient]);

  const reverse = useMutation({
    mutationFn: async (v: { row: SaleRow; action: "void" | "return"; creds?: ApproverCredentials; reason: string }) =>
      v.action === "void" ? voidSale(v.row.orderId, v.creds) : returnSale(v.row.orderId, v.reason, v.creds),
    onSuccess: (_d, v) => {
      pushToast("success", v.action === "void" ? t("myInvoicesDialog.voidSuccessToast") : t("myInvoicesDialog.returnSuccessToast"));
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
        pushToast("error", t("myInvoicesDialog.o2cModuleActiveToast"));
        setPending(null);
        return;
      }
      // approval_required means the server rejected the credentials (or none
      // were sent) — keep the dialog open so the manager can retry.
      if (err?.code === "approval_required" || err?.status === 403) {
        if (pending) {
          setApprovalError(translateApiError(e, t));
          return;
        }
        // Privileged path that still got refused → open the gate as a fallback.
        setApprovalError(translateApiError(e, t));
        setPending({ row: v.row, action: v.action });
        return;
      }
      pushToast("error", translateApiError(e, t));
      setPending(null);
    },
  });

  function start(row: SaleRow, action: "void" | "return") {
    setApprovalError(null);
    if (!needsApprovalGate(action, isPrivileged, requireVoidApproval)) {
      // No dialog: admin/manager (legacy bypass, app.js:3527) or the owner
      // opted voids out (app.js:3519 — the server skips the same gate).
      // A return still needs a reason; legacy defaults it (app.js:3547).
      reverse.mutate({ row, action, reason: action === "return" ? t("myInvoicesDialog.returnDefaultReason") : "" });
      return;
    }
    setPending({ row, action });
  }

  /** Who to NAME on a reprint when the server sent no cashierName.
   *
   *  A reprint must name whoever MADE the sale, never whoever is standing at
   *  the till now — so the sale's own `row.username` always outranks the
   *  current user. It is a login id, though, so when the sale is this cashier's
   *  own we can upgrade it to the real name we already hold in our token. For
   *  someone else's sale we cannot know their name client-side and print their
   *  login id honestly rather than borrow ours.
   *
   *  This is the LAST resort: routes/sales.js resolves the name server-side
   *  from the sale's own username and `inv.cashierName` normally wins. */
  function fallbackCashierFor(row: SaleRow): string {
    const seller = (row.username ?? "").trim();
    if (!seller) return displayNameOf(user);
    return seller === (user?.username ?? "").trim() ? displayNameOf(user) : seller;
  }

  /** Reprint (فواتيري → طباعة): fetch the invoice (identity + STAMPED QR) and
   *  print it through the same window path as first prints. Works for reversed
   *  rows too — those print with their ملغاة/مرتجع stamp. */
  async function reprint(row: SaleRow) {
    setPrintingId(row.orderId);
    try {
      const inv = await getInvoice(row.orderId);
      if (!inv) throw new Error(t("myInvoicesDialog.reprintLoadFailed"));
      const ok = printHtml(
        reprintHtmlFromInvoice(inv, catalog, fallbackCashierFor(row), {
          voided: t("myInvoicesDialog.stampVoided"),
          returned: t("myInvoicesDialog.stampReturned"),
        }),
      );
      if (!ok) pushToast("error", t("myInvoicesDialog.popupBlocked"));
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setPrintingId(null);
    }
  }

  const busy = reverse.isPending;

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t("myInvoicesDialog.title")} widthClass="max-w-5xl">
        <div className="flex flex-col gap-3">
          {/* View switch. Only with O2C on — the returns namespace is not even
              mounted otherwise (server.js:664), so offering the tab would be
              offering a 404. */}
          {o2cEnabled ? (
            <div className="flex gap-1" role="tablist" aria-label={t("myInvoicesDialog.views.aria")}>
              {(
                [
                  ["invoices", t("myInvoicesDialog.views.invoices")],
                  ["returns", t("myInvoicesDialog.views.returns")],
                ] as Array<[View, string]>
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    "btn-press min-h-11 rounded-xl px-3 text-xs font-extrabold",
                    view === v ? "bg-ink text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {view === "returns" ? (
            <RaisedReturnsPanel
              raised={raised}
              byId={returnsById}
              online={engineStatus.online}
              loading={returnsQuery.isLoading && raised.length > 0}
              error={returnsQuery.error}
              onRetry={refresh}
            />
          ) : (
          <>
          {/* Stat strip — parity with legacy #myInvStats */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Stat label={t("myInvoicesDialog.statTotal")} value={fmtInt(stats.total)} tone="border-slate-200 bg-slate-50 text-slate-600" />
            <Stat label={t("myInvoicesDialog.statActive")} value={fmtInt(stats.active)} tone="border-teal-200 bg-teal-50 text-teal-700" />
            <Stat label={t("myInvoicesDialog.statCancelled")} value={fmtInt(stats.cancelled)} tone="border-red-200 bg-red-50 text-red-700" />
            <Stat label={t("myInvoicesDialog.statReturned")} value={fmtInt(stats.returned)} tone="border-orange-200 bg-orange-50 text-orange-700" />
            <Stat label={t("myInvoicesDialog.statAmount")} value={fmt2(stats.amount)} tone="border-sky-200 bg-sky-50 text-sky-700" />
            <Button size="sm" variant="ghost" className="ms-auto" onClick={refresh} disabled={invoicesQuery.isFetching}>
              <RotateCcw className={cn("h-3.5 w-3.5", invoicesQuery.isFetching && "animate-spin")} aria-hidden />
              {t("myInvoicesDialog.refresh")}
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
                placeholder={t("myInvoicesDialog.searchPlaceholder")}
                className="min-h-11 w-full rounded-xl border border-slate-200 ps-9 pe-3 text-sm font-bold text-ink outline-none focus:border-teal-500"
              />
            </div>
            <div className="flex gap-1">
              {(
                [
                  ["all", t("myInvoicesDialog.filterAll")],
                  ["active", t("myInvoicesDialog.filterActive")],
                  ["cancelled", t("myInvoicesDialog.filterCancelled")],
                  ["returned", t("myInvoicesDialog.filterReturned")],
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
            <ErrorBanner message={t("myInvoicesDialog.offlineBanner")} />
          ) : !shiftId ? (
            <EmptyState icon={<FileText className="h-10 w-10" />} title={t("myInvoicesDialog.noShiftTitle")} hint={t("myInvoicesDialog.noShiftHint")} />
          ) : invoicesQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : invoicesQuery.isError ? (
            <ErrorBanner message={translateApiError(invoicesQuery.error, t)} onRetry={refresh} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-10 w-10" />}
              title={rows.length === 0 ? t("myInvoicesDialog.emptyTitleNoRows") : t("myInvoicesDialog.emptyTitleNoMatch")}
              hint={rows.length === 0 ? t("myInvoicesDialog.emptyHintNoRows") : t("myInvoicesDialog.emptyHintNoMatch")}
            />
          ) : (
            <div className="scrollbar-thin max-h-[55vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-start text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
                  <tr>
                    <th className="p-2 text-start">{t("myInvoicesDialog.tableStatus")}</th>
                    <th className="p-2 text-start">{t("myInvoicesDialog.tableTime")}</th>
                    <th className="p-2 text-start">{t("myInvoicesDialog.tableInvoiceNumber")}</th>
                    <th className="hidden p-2 text-start sm:table-cell">{t("myInvoicesDialog.tableProducts")}</th>
                    <th className="p-2 text-start">{t("myInvoicesDialog.tableTotal")}</th>
                    <th className="hidden p-2 text-start md:table-cell">{t("myInvoicesDialog.tablePayment")}</th>
                    <th className="p-2 text-start">{t("myInvoicesDialog.tableActions")}</th>
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
                          {new Date(r.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
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
                              title={t("myInvoicesDialog.printTooltip")}
                            >
                              <Printer className="h-3.5 w-3.5" aria-hidden />
                              {t("myInvoicesDialog.printButton")}
                            </Button>
                            {reversed ? (
                              <span className="self-center text-[10px] font-bold text-slate-400">{t("myInvoicesDialog.reversedNoActions")}</span>
                            ) : (
                              <>
                                <Button size="sm" variant="danger" disabled={busy} onClick={() => start(r, "void")}>
                                  <Ban className="h-3.5 w-3.5" aria-hidden />
                                  {t("myInvoicesDialog.voidButton")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  // O2C ON → the new O2C return-request dialog (the
                                  // legacy returnSale path is gated 409 in that mode).
                                  // O2C OFF → untouched legacy behaviour (rollback-safe).
                                  onClick={() => (o2cEnabled ? setReturnRow(r) : start(r, "return"))}
                                  className="border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
                                >
                                  <Undo2 className="h-3.5 w-3.5" aria-hidden />
                                  {t("myInvoicesDialog.returnButton")}
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
          </>
          )}
        </div>
      </Dialog>

      <ManagerApprovalDialog
        open={!!pending}
        title={pending?.action === "void" ? t("myInvoicesDialog.voidApprovalTitle") : t("myInvoicesDialog.returnApprovalTitle")}
        reasonLabel={pending?.action === "return" ? t("myInvoicesDialog.returnReasonLabel") : undefined}
        defaultReason={pending?.action === "return" ? t("myInvoicesDialog.returnDefaultReason") : undefined}
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

      <ReturnRequestDialog
        open={!!returnRow}
        row={returnRow}
        onClose={() => setReturnRow(null)}
        onCreated={refresh}
      />
    </>
  );
}
