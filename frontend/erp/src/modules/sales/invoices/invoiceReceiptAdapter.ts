// Adapts an ERP Order-to-Cash invoice (the /api/order-to-cash/invoices/:id
// response) into the SHARED sale-receipt renderer so the ERP invoice prints the
// SAME document the POS does — thermal/A4 layout, seller block, ZATCA QR, totals.
//
// Seller identity: the ERP invoice carries only the FROZEN TLV seller (name +
// VAT number, decoded from the persisted ZATCA QR — the issue-time truth).
// ar_documents has no seller columns and there is no identity snapshot, so the
// fuller identity (CR / national address / header / thank-you) is deliberately
// NOT resolved live here: re-reading current settings at print time is exactly
// the post-issue drift defect the O2C side already eliminated. The shared
// renderer degrades gracefully, printing whatever identity fields are present.
import type { TFunction } from "@/i18n";
import type { Invoice } from "@/modules/sales/lib";
import type { DocumentIdentity, SaleReceiptOptions } from "../../../../../shared/invoiceTemplate";

const DEFAULT_VAT_RATE = 15;

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** The thin frozen seller (name + VAT number) → a DocumentIdentity whose other
 *  fields are intentionally empty (see file header). null when unstamped. */
function toIdentity(inv: Invoice): DocumentIdentity | null {
  if (!inv.seller) return null;
  return {
    sellerName: inv.seller.sellerName || "",
    legalName: "",
    taxNumber: inv.seller.vatNumber || "",
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

export function toSaleReceiptOptions(inv: Invoice, t: TFunction): SaleReceiptOptions {
  // The shared receipt is tax-INCLUSIVE (subtotal contains VAT; subtotal −
  // discount = total). The ERP invoice records EXCLUSIVE figures (subtotal is
  // net; net + VAT = total), so rebuild an inclusive subtotal and derive any
  // document-level discount as the residual — keeps subtotal − discount = total
  // exact, and each line's gross_amount already equals base_qty × unit_price −
  // discount (inclusive), which is what the renderer shows per line.
  const vat = round2(Number(inv.vat_amount) || 0);
  const total = round2(Number(inv.total_amount) || 0);
  const grossSubtotal = round2((Number(inv.subtotal) || 0) + vat);
  const discountAmount = round2(grossSubtotal - total);

  return {
    lines: (inv.lines ?? []).map((l) => ({
      name: l.description || "—",
      qty: Number(l.entered_qty) || 0,
      baseQty: Number(l.base_qty) || Number(l.entered_qty) || 0,
      unitPrice: Number(l.unit_price) || 0,
      lineDiscount: Number(l.discount_amount) || 0,
    })),
    payments: [],
    totals: {
      subtotal: grossSubtotal,
      lineDiscountTotal: 0,
      discountAmount: discountAmount > 0 ? discountAmount : 0,
      vatTotal: vat,
      total,
    },
    invoiceNumber: inv.document_number || null,
    fallbackSellerName: inv.seller?.sellerName || t("sales.print.invoiceFallbackSeller"),
    vatRate: DEFAULT_VAT_RATE,
    paperWidth: "A4",
    identity: toIdentity(inv),
    zatcaQrDataUrl: inv.zatca_qr_data_url ?? null,
    printedAt: inv.issue_date ? new Date(inv.issue_date) : undefined,
    stamp: inv.status === "cancelled" ? t("sales.print.cancelledStamp") : null,
    customerName: inv.customer_name ?? null,
  };
}
