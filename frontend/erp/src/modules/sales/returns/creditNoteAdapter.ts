// Adapts an ERP Order-to-Cash sales return (the /api/order-to-cash/returns/:id
// response, incl. its posted `creditNote`) into the SHARED credit-note renderer,
// so the ERP prints a proper مرتجع / إشعار دائن document — seller block, ZATCA
// QR, original-invoice reference, per-line returned quantities and totals.
//
// Seller identity is the FROZEN TLV seller (name + VAT number) decoded from the
// credit note's persisted QR — same frozen-at-post-time truth the sale side
// uses, never a live settings re-read (which would drift after a rename).
import type { TFunction } from "@/i18n";
import type { SalesReturn } from "@/modules/sales/lib";
import type { CreditNoteOptions, DocumentIdentity } from "../../../../../shared/invoiceTemplate";

const DEFAULT_VAT_RATE = 15;

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** sales_returns carries ONE document-level `reason` (getWithLines does
 *  `SELECT *`), but the O2C DTO never declared it — read it defensively. */
function reasonOf(r: SalesReturn): string | null {
  const raw = (r as SalesReturn & { reason?: string | null }).reason;
  return raw ? String(raw) : null;
}

function toIdentity(seller: { sellerName?: string; vatNumber?: string } | null | undefined): DocumentIdentity | null {
  if (!seller) return null;
  return {
    sellerName: seller.sellerName || "",
    legalName: "",
    taxNumber: seller.vatNumber || "",
    crNumber: "",
    address: "",
    nationalAddress: "",
    phone: "",
    email: "",
    logo: "",
    currency: "SAR",
    vatRate: DEFAULT_VAT_RATE,
    header: "",
    footer: "",
    thankYou: "",
    returnPolicy: "",
    branchName: "",
    branchCompanyName: "",
    brandName: "",
  };
}

export function toCreditNoteOptions(r: SalesReturn, t: TFunction): CreditNoteOptions {
  const cn = r.creditNote ?? null;

  // Inclusive rebuild (the shared renderer is tax-inclusive) from the recorded
  // EXCLUSIVE figures — prefer the credit note's own numbers, fall back to the
  // return's when it isn't posted yet.
  const vat = round2(Number(cn?.vat_amount ?? r.vat_amount) || 0);
  const total = round2(Number(cn?.total_amount ?? r.total_amount) || 0);
  const grossSubtotal = round2((Number(cn?.subtotal ?? r.subtotal) || 0) + vat);
  const discountAmount = round2(grossSubtotal - total);

  return {
    lines: (r.lines ?? []).map((l) => {
      const returnQty = Number(l.return_qty) || 0;
      const gross = round2(Number(l.gross_amount) || 0);
      return {
        name: l.description || "—",
        qty: returnQty,
        baseQty: returnQty,
        // No per-unit price is stored on a return line; derive it from the
        // recorded (inclusive) gross so baseQty × unitPrice ≈ gross_amount.
        unitPrice: returnQty > 0 ? round2(gross / returnQty) : gross,
        lineDiscount: 0,
        returnQty,
        soldQty: Number(l.sold_qty) || 0,
      };
    }),
    totals: {
      subtotal: grossSubtotal,
      lineDiscountTotal: 0,
      discountAmount: discountAmount > 0 ? discountAmount : 0,
      vatTotal: vat,
      total,
    },
    invoiceNumber: cn?.document_number ?? r.return_number ?? null,
    originalInvoiceNumber: cn?.original_document_number ?? null,
    returnReason: reasonOf(r),
    fallbackSellerName: cn?.seller?.sellerName || t("sales.print.creditNoteFallbackSeller"),
    vatRate: DEFAULT_VAT_RATE,
    paperWidth: "A4",
    identity: toIdentity(cn?.seller),
    zatcaQrDataUrl: cn?.zatca_qr_data_url ?? null,
    printedAt: cn?.issue_date ? new Date(cn.issue_date) : r.return_date ? new Date(r.return_date) : undefined,
    customerName: cn?.customer_name ?? r.customer_name ?? null,
  };
}
