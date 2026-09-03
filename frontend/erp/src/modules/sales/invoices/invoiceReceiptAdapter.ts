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

/**
 * The seller block. Preference order:
 *   1. the FULL identity frozen at issue (`inv.identity`) — logo, CR, address,
 *      footer, language — the same snapshot the POS receipt prints;
 *   2. the thin TLV seller (name + VAT number) for an invoice issued before
 *      the snapshot existed. Nothing is re-read live: that is the post-issue
 *      drift the O2C side exists to prevent.
 */
function toIdentity(inv: Invoice): DocumentIdentity | null {
  const f = inv.identity;
  if (f && (f.sellerName || f.taxNumber)) {
    const lang = f.language === "en" || f.language === "both" ? f.language : "ar";
    return {
      sellerName: f.sellerName || inv.seller?.sellerName || "",
      legalName: f.legalName || "",
      taxNumber: f.taxNumber || inv.seller?.vatNumber || "",
      crNumber: f.crNumber || "",
      address: f.address || "",
      nationalAddress: f.nationalAddress || "",
      phone: f.phone || "",
      email: f.email || "",
      logo: f.logo || "",
      currency: f.currency || "SAR",
      vatRate: Number.isFinite(Number(f.vatRate)) ? Number(f.vatRate) : DEFAULT_VAT_RATE,
      salesTaxName: f.salesTaxName || undefined,
      language: lang,
      header: f.header || "",
      footer: f.footer || "",
      thankYou: f.thankYou || "",
      returnPolicy: f.returnPolicy || "",
      branchName: f.branchName || "",
      branchNameEn: f.branchNameEn || undefined,
      branchCompanyName: f.branchCompanyName || "",
      brandName: f.brandName || "",
    };
  }
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
  // The recorded rate when the snapshot carries one; the historical default
  // otherwise. Used for the per-line VAT breakdown on A4.
  const vatRate = inv.identity && Number.isFinite(Number(inv.identity.vatRate)) ? Number(inv.identity.vatRate) : DEFAULT_VAT_RATE;
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
    vatRate,
    paperWidth: "A4",
    identity: toIdentity(inv),
    zatcaQrDataUrl: inv.zatca_qr_data_url ?? null,
    printedAt: inv.issue_date ? new Date(inv.issue_date) : undefined,
    stamp: inv.status === "cancelled" ? t("sales.print.cancelledStamp") : null,
    customerName: inv.customer_name ?? null,
    // A4 tax-invoice parties and choices. The buyer is what the server froze
    // at issue (or the live record for a pre-feature invoice); a registered
    // buyer needs their VAT number on the paper to book it.
    buyer: inv.buyer
      ? { name: inv.buyer.name ?? null, vatNumber: inv.buyer.vatNumber ?? null, address: inv.buyer.address ?? null, phone: inv.buyer.phone ?? null, email: inv.buyer.email ?? null }
      : null,
    dueDate: inv.due_date ?? null,
    a4: inv.a4Options ?? null,
  };
}
