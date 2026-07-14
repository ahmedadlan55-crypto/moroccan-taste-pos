/**
 * Moroccan Taste — Canonical Receipt Template (v6.19.0)
 * --------------------------------------------------------------------
 * THE SINGLE SOURCE OF TRUTH for invoice/receipt rendering across the
 * entire system. Loaded by both:
 *   • POS shell (/pos/index.html) — for sale-time print to customer
 *   • Admin shell (/index.html)   — for reprint from reports / history
 *
 * Why this exists (the bug it fixes)
 *   Before v6.19.0, POS and Admin each had their own ~500-line receipt
 *   HTML builders. The customer received one design; the admin reprint
 *   produced a DIFFERENT design (different columns, fonts, sizes,
 *   headers). The owner's exact complaint:
 *     "الاصل هي التي انشأت للعميل اريدها ان تظهر هي نفسها لا غيرها
 *      في التقارير كامله لا تعطني فواتير مختلفة في كل جزء"
 *   ("The original is the one created for the customer — I want IT
 *   to appear, not different ones, in ALL the reports. Don't give me
 *   different invoices in each part.")
 *
 *   This module unifies everything. The output is BYTE-IDENTICAL no
 *   matter who called it. There is ONE receipt design.
 *
 * Architecture
 *   The canonical design is the POS's thermal printout (the version
 *   the customer physically receives). It's optimized for 80mm
 *   thermal paper — all-black ink (no white-on-black, which is
 *   invisible on thermal), thick borders, heavy fonts, ZATCA QR.
 *
 *   The on-screen preview modal renders the SAME body HTML (just
 *   without the <html> wrapper / @media print rules) — so the
 *   cashier sees exactly what's about to print.
 *
 * Public API
 *   window.MTReceipt.printInvoice(orderId, opts)
 *     — fetch invoice, render preview into modal, generate QR,
 *       auto-print to thermal printer (silent iframe). Promise.
 *
 *   window.MTReceipt.printLast()
 *     — re-print the most recently rendered receipt (used by the
 *       "Print" button inside #modalReceipt).
 *
 *   window.MTReceipt.buildReceiptHTML(receipt, opts)
 *     — low-level: build HTML from a merged receipt object.
 *       opts: { qrImg, includeWrapper }
 *
 *   window.MTReceipt.silentPrint(html)
 *     — low-level: fire-and-forget print via hidden iframe.
 *
 *   window.MTReceipt.generateZATCA_TLV(seller, vat, ts, total, vatAmt)
 *     — base64 TLV string for the ZATCA Phase 1 QR code.
 *
 * Backward compatibility
 *   For any HTML that still uses onclick="printReceiptWindow()" or
 *   code that calls printReceipt(orderId), window.printReceipt and
 *   window.printReceiptWindow are aliased to MTReceipt.printInvoice
 *   and MTReceipt.printLast.  Old call sites keep working.
 */
(function() {
  'use strict';

  // ── Internal helpers (kept local to avoid polluting global scope) ──

  function _formatVal(n) {
    return (typeof window.formatVal === 'function')
      ? window.formatVal(n)
      : (Number(n) || 0).toFixed(2);
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _toast(msg, isErr) {
    if (typeof window.glassToast === 'function') return window.glassToast(msg, isErr);
    if (typeof window.showToast === 'function')  return window.showToast(msg, isErr);
    console.warn('[MTReceipt]', msg);
  }

  function _formatDate(d) {
    try {
      var dt = new Date(d);
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
             dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } catch (e) { return String(d || ''); }
  }

  /**
   * Merge raw invoice with shell settings + user into a fully-resolved
   * receipt object. Both POS and Admin call this identically, so the
   * inputs to buildReceiptHTML are guaranteed consistent.
   */
  function _prepReceipt(inv, settings, user) {
    settings = settings || {};
    var companyName       = inv.companyName       || settings.name || 'Moroccan Taste';
    var companyNameAr     = 'المذاق المغربي';
    var taxNumber         = inv.taxNumber         || settings.taxNumber || '';
    var currency          = inv.currency          || settings.currency || 'SAR';
    var companyPhone      = inv.companyPhone      || settings.companyPhone || '';
    var companyEmail      = inv.companyEmail      || settings.companyEmail || '';
    // Owner-authored footer line (settings.receiptFooter). Absent → the block
    // below simply doesn't render; nothing else on the receipt shifts.
    var receiptFooter     = inv.receiptFooter     || settings.receiptFooter || '';
    var branchName        = inv.branchName        || settings.branchName || '';
    var branchAddr        = inv.branchAddress     || settings.branchAddress || '';
    var branchCompanyName = inv.branchCompanyName || '';
    var cashierName       = inv.cashierName       || inv.username || user || '';
    var cashierEmpNo      = inv.cashierEmpNo      || inv.username || '';
    var logoUrl           = inv.receiptLogo       || inv.brandLogo || inv.companyLogo || settings.logo || '';

    var totalItems = (inv.items || []).reduce(function(s, i) { return s + (Number(i.qty) || 0); }, 0);
    // v6.20.0 — totalFinal stored on the sale row is already the WHOLE
    // SAR amount the customer paid (backend rounded it during INSERT).
    // The net/vat extraction uses the LIVE VAT rate from settings (not
    // hardcoded 1.15) so VAT report adjustments stay consistent.  Both
    // values keep 2-decimal precision for ZATCA QR compliance.
    var totalFinal = Number(inv.totalFinal) || 0;
    var vatRate = (typeof window.getActiveVATRate === 'function')
      ? window.getActiveVATRate()
      : 15;
    var netAmount  = totalFinal / (1 + vatRate / 100);
    var vatAmount  = totalFinal - netAmount;

    // v7.3 — discount + split transparency (auditable receipt). Derive the
    // pre-discount subtotal back from the recorded total + discounts so the
    // printed math always ties exactly: SUBTOTAL − discounts === TOTAL.
    var _lineDiscTotal = Number(inv.lineDiscountTotal) || 0;
    if (!_lineDiscTotal && inv.lineDiscounts) {
      try {
        var _ld = (typeof inv.lineDiscounts === 'string') ? JSON.parse(inv.lineDiscounts) : inv.lineDiscounts;
        Object.keys(_ld || {}).forEach(function (k) { _lineDiscTotal += Number(_ld[k] && _ld[k].amount) || 0; });
      } catch (e) {}
    }
    var _invoiceDiscount = Number(inv.discountAmount) || 0;
    var _splitDetails = inv.splitDetails;
    if (typeof _splitDetails === 'string') { try { _splitDetails = JSON.parse(_splitDetails); } catch (e) { _splitDetails = null; } }

    return {
      inv: inv,
      vatRate: vatRate,
      companyName: companyName, companyNameAr: companyNameAr,
      taxNumber: taxNumber, currency: currency,
      companyPhone: companyPhone, companyEmail: companyEmail,
      receiptFooter: receiptFooter,
      branchName: branchName, branchAddr: branchAddr, branchCompanyName: branchCompanyName,
      cashierName: cashierName, cashierEmpNo: cashierEmpNo,
      logoUrl: logoUrl,
      dateStr: _formatDate(inv.date),
      totalItems: totalItems, netAmount: netAmount, vatAmount: vatAmount,
      subtotal: totalFinal + _lineDiscTotal + _invoiceDiscount,
      lineDiscTotal: _lineDiscTotal, invoiceDiscount: _invoiceDiscount,
      discountName: inv.discountName || '', splitDetails: _splitDetails
    };
  }

  // ── ZATCA Phase 1 TLV QR Code Generator ──
  // Generates a base64 string per ZATCA spec (5 TLV fields: seller,
  // VAT#, ISO8601 timestamp, total, VAT amount). Identical algorithm
  // formerly duplicated in POS and Admin app.js.
  function generateZATCA_TLV(sellerName, vatNumber, timestamp, totalAmount, vatAmount) {
    function utf8Bytes(str) {
      var bytes = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
        else if (c < 0x10000) {
          bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F));
        } else {
          bytes.push(0xF0 | (c >> 18)); bytes.push(0x80 | ((c >> 12) & 0x3F));
          bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F));
        }
      }
      return bytes;
    }
    function makeTLV(tag, value) {
      var valBytes = utf8Bytes(String(value || ''));
      return [tag, valBytes.length].concat(valBytes);
    }
    var tlv = [];
    tlv = tlv.concat(makeTLV(1, sellerName));
    tlv = tlv.concat(makeTLV(2, vatNumber));
    tlv = tlv.concat(makeTLV(3, timestamp));
    tlv = tlv.concat(makeTLV(4, totalAmount));
    tlv = tlv.concat(makeTLV(5, vatAmount));
    var binary = '';
    for (var i = 0; i < tlv.length; i++) binary += String.fromCharCode(tlv[i]);
    return btoa(binary);
  }

  // ── The canonical thermal receipt body (extracted verbatim from
  //    pos/app.js#printReceiptWindow). Optimized for 80mm thermal:
  //    all-black, heavy fonts, double borders, light grey accents
  //    (no white-on-black which would print invisible). Includes
  //    VOIDED/RETURNED banners, prominent INVOICE NO box, system
  //    ref + date row, items table, VAT breakdown, payment, served-by,
  //    ZATCA QR, thank-you, contact footer.
  function _buildReceiptBody(r, opts) {
    opts = opts || {};
    var qrImg = opts.qrImg || '';
    var esc = _esc, formatVal = _formatVal;

    // Items table rows (3 columns: Qty | Item @unitPrice | Total)
    // v6.20.0 — Per-line unit price + total shown as WHOLE numbers so
    // they match what the cashier saw on the POS screen and what the
    // customer expects (the same digits without decimal kopecks).  The
    // VAT breakdown table below the items keeps decimal precision for
    // ZATCA compliance.
    var _whole = function(v) { return String(Math.round(Number(v) || 0)); };
    var itemsHtml = '';
    (r.inv.items || []).forEach(function(i) {
      var qty = Number(i.qty) || 0;
      var unitPrice = qty > 0 ? (Number(i.total) / qty) : Number(i.price || 0);
      itemsHtml +=
        '<tr style="direction:ltr;border-bottom:1px dotted #000;">' +
          '<td style="text-align:center;font-size:14px;padding:8px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;vertical-align:top;width:40px;color:#000;">' + qty + '×</td>' +
          '<td style="text-align:left;font-size:13px;padding:8px 8px;font-weight:700;line-height:1.35;color:#000;">' +
            esc(i.name) +
            '<div style="font-size:11px;color:#000;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace;margin-top:3px;letter-spacing:0.02em;">@ ' + _whole(unitPrice) + '</div>' +
          '</td>' +
          '<td style="text-align:right;font-size:14px;padding:8px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;vertical-align:top;width:66px;color:#000;">' + _whole(i.total) + '</td>' +
        '</tr>';
    });

    return (
      // ───── HEADER: logo + brand identity ─────
      (r.logoUrl
        ? '<div style="text-align:center;padding:6px 0 8px;border-bottom:2.5px solid #000;margin-bottom:8px;">' +
            '<img src="' + esc(r.logoUrl) + '" style="max-width:110px;max-height:110px;object-fit:contain;display:block;margin:0 auto;">' +
          '</div>'
        : '<div style="border-top:2.5px solid #000;margin-bottom:8px;"></div>'
      ) +

      '<div style="text-align:center;font-size:15px;font-weight:800;direction:rtl;margin-bottom:2px;">' + esc(r.companyNameAr || 'المذاق المغربي') + '</div>' +
      '<div style="text-align:center;font-size:20px;font-weight:900;direction:ltr;margin-bottom:' + (r.branchCompanyName ? '4' : '8') + 'px;letter-spacing:0.5px;">' + esc(r.companyName) + '</div>' +
      (r.branchCompanyName
        ? '<div style="text-align:center;font-size:13px;font-weight:700;color:#000;direction:rtl;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #000;">' + esc(r.branchCompanyName) + '</div>'
        : ''
      ) +

      '<div style="text-align:center;font-size:13px;color:#000;font-weight:700;margin-bottom:1px;">Simplified TAX Invoice</div>' +
      '<div style="text-align:center;font-size:11px;color:#000;direction:rtl;margin-bottom:8px;">فاتورة ضريبية مبسطة</div>' +

      (r.taxNumber
        ? '<div style="text-align:center;margin-bottom:6px;padding:4px 8px;border:1.5px solid #000;border-radius:2px;display:inline-block;width:100%;">' +
            '<span style="font-size:10px;color:#000;letter-spacing:0.05em;">VAT NO. <span style="direction:rtl;">| الرقم الضريبي</span></span><br>' +
            '<span style="font-size:13px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;direction:ltr;">' + esc(r.taxNumber) + '</span>' +
          '</div>'
        : ''
      ) +

      (r.branchName ? '<div style="text-align:center;font-size:13px;font-weight:800;direction:ltr;margin-top:6px;letter-spacing:0.5px;">' + esc(String(r.branchName).toUpperCase()) + '</div>' : '') +
      (r.branchAddr ? '<div style="text-align:center;font-size:11px;color:#000;direction:rtl;margin-bottom:8px;line-height:1.6;">' + esc(r.branchAddr) + '</div>' : '') +

      '<div style="border-top:2px solid #000;margin:8px 0;"></div>' +

      // ───── VOIDED / RETURNED BANNER (only for reversed sales) ─────
      (r.inv.zatcaType === 'cancellation'
        ? '<div style="text-align:center;margin:8px 0;padding:8px;background:#fff;border:3px double #000;border-radius:3px;">' +
            '<div style="font-size:16px;font-weight:900;letter-spacing:2px;color:#000;">VOIDED · مَلغاة</div>' +
            (r.inv.voidSerial ? '<div style="font-size:11px;font-family:ui-monospace,monospace;font-weight:800;color:#000;margin-top:3px;">' + esc(r.inv.voidSerial) + '</div>' : '') +
          '</div>'
        : (r.inv.zatcaType === 'credit_note' || r.inv.returnSerial
            ? '<div style="text-align:center;margin:8px 0;padding:8px;background:#fff;border:3px double #000;border-radius:3px;">' +
                '<div style="font-size:16px;font-weight:900;letter-spacing:2px;color:#000;">RETURNED · مُرتَجَع</div>' +
                (r.inv.returnSerial ? '<div style="font-size:11px;font-family:ui-monospace,monospace;font-weight:800;color:#000;margin-top:3px;">' + esc(r.inv.returnSerial) + '</div>' : '') +
              '</div>'
            : '')
      ) +

      // ───── TAX INVOICE BADGE (black-on-light for thermal compatibility) ─────
      '<div style="text-align:center;margin-bottom:8px;">' +
        '<div style="background:#f0f0f0;color:#000;text-align:center;padding:6px 16px;font-weight:800;font-size:13px;display:inline-block;border:2px solid #000;border-radius:3px;letter-spacing:0.5px;">' +
          'TAX INVOICE <span style="font-size:11px;direction:rtl;">| فاتورة ضريبية</span>' +
        '</div>' +
      '</div>' +

      // ───── PROMINENT INVOICE NUMBER ─────
      '<div style="text-align:center;padding:10px 6px;border:2px solid #000;margin-bottom:8px;border-radius:3px;">' +
        '<div style="font-size:10px;color:#000;letter-spacing:0.1em;font-weight:700;margin-bottom:2px;">' +
          'INVOICE NO. <span style="direction:rtl;font-size:11px;">| رقم الفاتورة</span>' +
        '</div>' +
        '<div style="font-size:20px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;letter-spacing:1.5px;color:#000;">' +
          esc(r.inv.invoiceNumber || r.inv.orderId) +
        '</div>' +
      '</div>' +

      // ───── SYSTEM REF + DATE ─────
      '<div style="border:1px solid #000;border-radius:3px;padding:6px 10px;margin-bottom:8px;">' +
        (r.inv.invoiceNumber
          ? '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:9px;letter-spacing:0.05em;color:#000;margin-bottom:3px;">' +
              '<span>SYSTEM REF <span style="direction:rtl;">| المرجع</span></span>' +
              '<span style="font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;color:#000;font-size:9px;word-break:break-all;text-align:end;">' + esc(r.inv.orderId) + '</span>' +
            '</div>'
          : ''
        ) +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:#000;' + (r.inv.invoiceNumber ? 'border-top:1px dashed #000;padding-top:4px;' : '') + '">' +
          '<span>DATE <span style="direction:rtl;">| التاريخ</span></span>' +
          '<span style="font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;color:#000;">' + esc(r.dateStr) + '</span>' +
        '</div>' +
      '</div>' +

      // ───── ITEMS TABLE ─────
      '<table style="width:100%;border-collapse:collapse;direction:ltr;table-layout:fixed;">' +
        '<thead><tr style="border-top:2px solid #000;border-bottom:2px solid #000;background:#f0f0f0;color:#000;">' +
          '<th style="text-align:center;font-size:11px;padding:6px 2px;color:#000;font-weight:900;letter-spacing:0.05em;width:40px;">QTY</th>' +
          '<th style="text-align:left;font-size:11px;padding:6px 8px;color:#000;font-weight:900;letter-spacing:0.05em;">ITEM</th>' +
          '<th style="text-align:right;font-size:11px;padding:6px 2px;color:#000;font-weight:900;letter-spacing:0.05em;width:66px;">TOTAL ' + esc(r.currency) + '</th>' +
        '</tr></thead>' +
        '<tbody>' + itemsHtml + '</tbody>' +
      '</table>' +

      // ───── TOTAL ITEMS BANNER ─────
      '<div style="text-align:center;margin:10px 0;padding:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;">' +
        '<span style="font-size:11px;color:#000;letter-spacing:0.05em;">TOTAL ITEMS <span style="direction:rtl;font-size:10px;">| عدد الأصناف</span> :</span> ' +
        '<span style="font-size:18px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;color:#000;">' + esc(r.totalItems) + '</span>' +
      '</div>' +

      // ───── SUBTOTAL + DISCOUNTS (only when a discount applies) ─────
      // v7.3 — itemize line + invoice discounts so SUBTOTAL − discounts ===
      // the TOTAL in the VAT box below; keeps the printed receipt auditable.
      ((r.lineDiscTotal > 0 || r.invoiceDiscount > 0)
        ? '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-family:ui-monospace,SFMono-Regular,monospace;">' +
            '<tr><td style="text-align:left;font-size:12px;padding:3px 2px;color:#000;">SUBTOTAL · <span style="direction:rtl;">الإجمالي الفرعي</span></td>' +
              '<td style="text-align:right;font-size:13px;font-weight:800;padding:3px 2px;color:#000;">' + _whole(r.subtotal) + ' ' + esc(r.currency) + '</td></tr>' +
            (r.lineDiscTotal > 0
              ? '<tr><td style="text-align:left;font-size:12px;padding:3px 2px;color:#000;">LINE DISCOUNTS · <span style="direction:rtl;">خصم الأصناف</span></td>' +
                  '<td style="text-align:right;font-size:13px;font-weight:800;padding:3px 2px;color:#000;">- ' + _whole(r.lineDiscTotal) + '</td></tr>'
              : '') +
            (r.invoiceDiscount > 0
              ? '<tr><td style="text-align:left;font-size:12px;padding:3px 2px;color:#000;">INVOICE DISCOUNT' + (r.discountName ? ' (' + esc(r.discountName) + ')' : '') + ' · <span style="direction:rtl;">خصم الفاتورة</span></td>' +
                  '<td style="text-align:right;font-size:13px;font-weight:800;padding:3px 2px;color:#000;">- ' + _whole(r.invoiceDiscount) + '</td></tr>'
              : '') +
          '</table>'
        : '') +

      // ───── VAT BREAKDOWN ─────
      // v6.20.0 — TOTAL = whole SAR (what the customer paid).
      //           NET + VAT = 2-decimal precision (ZATCA compliance).
      //           The VAT header label uses the LIVE rate (e.g. "VAT 20%"
      //           if the owner changes the settings).
      '<table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:10px 0;">' +
        '<tr style="background:#f0f0f0;color:#000;border-bottom:1.5px solid #000;">' +
          '<td style="text-align:center;padding:6px 4px;border-right:1px solid #000;font-size:11px;font-weight:900;color:#000;">TOTAL<br>VALUE<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">إجمالي القيمة</div></td>' +
          '<td style="text-align:center;padding:6px 4px;border-right:1px solid #000;font-size:11px;font-weight:900;color:#000;">NET<br>AMOUNT<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">قبل الضريبة</div></td>' +
          '<td style="text-align:center;padding:6px 4px;font-size:11px;font-weight:900;color:#000;">VAT<br>' + esc(r.vatRate) + '%<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">ضريبة القيمة</div></td>' +
        '</tr>' +
        '<tr>' +
          '<td style="text-align:center;padding:10px 4px;border-right:1px solid #000;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + _whole(r.inv.totalFinal) + '</td>' +
          '<td style="text-align:center;padding:10px 4px;border-right:1px solid #000;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + r.netAmount.toFixed(2) + '</td>' +
          '<td style="text-align:center;padding:10px 4px;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + r.vatAmount.toFixed(2) + '</td>' +
        '</tr>' +
      '</table>' +

      // ───── PAYMENT ROW ─────
      // v6.20.0 — Customer-facing total = whole.
      '<div style="border:2.5px double #000;border-radius:3px;padding:8px 10px;margin:10px 0;background:#f0f0f0;color:#000;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:900;color:#000;">' +
          '<span style="color:#000;">PAYMENT · <span style="direction:rtl;">طريقة الدفع</span>: ' + esc(r.inv.payment || 'CASH') + '</span>' +
          '<span style="color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-size:16px;">' + _whole(r.inv.totalFinal) + ' ' + esc(r.currency) + '</span>' +
        '</div>' +
      '</div>' +

      // ───── SPLIT PAYMENT BREAKDOWN (only when paid via split) ─────
      // v7.3 — itemize each tender so a split sale is auditable on paper.
      ((r.splitDetails && typeof r.splitDetails === 'object' && Object.keys(r.splitDetails).length)
        ? '<div style="border:1px dashed #000;border-radius:3px;padding:6px 10px;margin:6px 0;font-family:ui-monospace,SFMono-Regular,monospace;">' +
            '<div style="font-size:10px;color:#000;letter-spacing:0.05em;margin-bottom:3px;text-align:center;">SPLIT PAYMENT · <span style="direction:rtl;">دفع مقسّم</span></div>' +
            Object.keys(r.splitDetails).map(function (m) {
              return '<div style="display:flex;justify-content:space-between;font-size:12px;color:#000;padding:1px 0;">' +
                '<span>' + esc(m) + '</span>' +
                '<span style="font-weight:800;">' + _whole(r.splitDetails[m]) + ' ' + esc(r.currency) + '</span>' +
              '</div>';
            }).join('') +
          '</div>'
        : '') +

      // ───── CASH TENDERED → CHANGE (only on a cash sale with change) ─────
      // v7.3 — print what the customer handed over and the change returned so
      // both the drawer and the customer can verify the amount.
      ((Number(r.inv.changeDue) > 0 || Number(r.inv.cashTendered) > 0)
        ? '<div style="border:1px dashed #000;border-radius:3px;padding:6px 10px;margin:6px 0;font-family:ui-monospace,SFMono-Regular,monospace;">' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;color:#000;padding:1px 0;">' +
              '<span>TENDERED · <span style="direction:rtl;">المستلم</span></span>' +
              '<span style="font-weight:800;">' + _whole(r.inv.cashTendered) + ' ' + esc(r.currency) + '</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:13px;color:#000;padding:1px 0;font-weight:900;">' +
              '<span>CHANGE · <span style="direction:rtl;">الباقي</span></span>' +
              '<span>' + _whole(r.inv.changeDue) + ' ' + esc(r.currency) + '</span>' +
            '</div>' +
          '</div>'
        : '') +

      // ───── CASHIER / SERVER ─────
      '<div style="text-align:center;font-size:12px;color:#000;margin:8px 0;padding:6px;border-top:1px dashed #000;">' +
        '<div style="font-weight:700;">SERVED BY: <strong style="font-size:13px;">' + esc(r.cashierName) + (r.cashierEmpNo && r.cashierEmpNo !== r.cashierName ? ' (' + esc(r.cashierEmpNo) + ')' : '') + '</strong></div>' +
        '<div style="font-size:11px;color:#000;direction:rtl;margin-top:2px;">قدّم لكم الخدمة: ' + esc(r.cashierName) + '</div>' +
      '</div>' +

      // ───── CUSTOMER (only if cashier captured one) ─────
      (r.inv.customerName
        ? '<div style="text-align:center;font-size:12px;color:#000;margin:6px 0;padding:6px;border-top:1px dashed #000;">' +
            '<div style="font-weight:700;">CUSTOMER: <strong>' + esc(r.inv.customerName) + '</strong>' + (r.inv.customerPhone ? ' · ' + esc(r.inv.customerPhone) : '') + '</div>' +
            '<div style="font-size:11px;color:#000;direction:rtl;margin-top:2px;">العميل: ' + esc(r.inv.customerName) + (r.inv.customerPhone ? ' · ' + esc(r.inv.customerPhone) : '') + '</div>' +
          '</div>'
        : ''
      ) +

      // ───── PAYMENT NOTES (if supplied) ─────
      (r.inv.paymentNotes
        ? '<div style="text-align:center;font-size:11px;color:#000;margin:4px 0;font-style:italic;">Notes: ' + esc(r.inv.paymentNotes) + '</div>'
        : ''
      ) +

      // ───── ZATCA QR ─────
      // When called from showAndPrint(), the rendered preview gets a
      // canvas inside #receiptQR. For the actual print HTML we embed
      // the data-URL image (qrImg). For the on-screen preview we just
      // emit the empty placeholder div — the caller's setTimeout will
      // populate it via window.QRCode.
      (qrImg
        ? '<div style="text-align:center;margin:14px 0 8px;padding:10px;border:1.5px solid #000;border-radius:3px;">' +
            '<img src="' + qrImg + '" width="160" height="160" style="display:block;margin:0 auto;">' +
            '<div style="font-size:10px;color:#000;margin-top:6px;letter-spacing:0.05em;font-weight:700;">SCAN FOR ZATCA E-INVOICE</div>' +
            '<div style="font-size:10px;color:#000;direction:rtl;margin-top:1px;">امسح للحصول على الفاتورة الإلكترونية</div>' +
          '</div>'
        : '<div id="receiptQR" style="text-align:center;margin:14px auto 8px;padding:10px;border:1.5px solid #000;border-radius:3px;width:170px;"></div>'
      ) +

      // ───── THANK YOU ─────
      '<div style="text-align:center;margin-top:10px;padding-top:8px;border-top:2px solid #000;">' +
        '<div style="font-size:14px;font-weight:800;color:#000;letter-spacing:0.5px;">THANK YOU FOR YOUR VISIT</div>' +
        '<div style="font-size:13px;font-weight:800;color:#000;direction:rtl;margin-top:2px;">شُكرًا لِزيارَتِكم</div>' +
      '</div>' +

      // Owner-authored footer from settings.receiptFooter.
      (r.receiptFooter
        ? '<div style="text-align:center;font-size:11px;color:#000;direction:rtl;margin-top:6px;white-space:pre-line;">' + esc(r.receiptFooter) + '</div>'
        : '') +

      // v6.20.0 — VAT rate label is dynamic (driven by settings.VATRate).
      '<div style="text-align:center;font-size:10px;color:#000;margin-top:6px;">All Prices Include VAT (' + esc(r.vatRate) + '%)</div>' +
      '<div style="text-align:center;font-size:10px;color:#000;direction:rtl;margin-bottom:4px;">جميع الأسعار شاملة الضريبة المضافة (' + esc(r.vatRate) + '%)</div>' +

      // ───── CONTACT ─────
      (r.companyPhone || r.companyEmail
        ? '<div style="text-align:center;margin-top:6px;padding-top:5px;border-top:1px dashed #000;">' +
            (r.companyPhone ? '<div style="font-size:11px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;">📞 ' + esc(r.companyPhone) + '</div>' : '') +
            (r.companyEmail ? '<div style="font-size:11px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;">✉ ' + esc(r.companyEmail) + '</div>' : '') +
          '</div>'
        : ''
      ) +

      // Bottom padding so the printer cut doesn't shave the last line
      '<div style="height:14px;"></div>'
    );
  }

  /**
   * Build the receipt HTML. Two modes:
   *   • opts.includeWrapper = true  → full <!DOCTYPE html>...</html> ready for window.print() / iframe
   *   • opts.includeWrapper = false → body fragment only, for embedding in modal preview
   */
  function buildReceiptHTML(r, opts) {
    opts = opts || {};
    var includeWrapper = opts.includeWrapper !== false; // default true
    var bodyHtml = _buildReceiptBody(r, opts);

    if (!includeWrapper) return bodyHtml;

    return '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><title>Receipt ' + _esc(r.inv.orderId) + '</title>' +
      '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-weight:inherit;}' +
        'body{font-family:"Tahoma","Cairo","Segoe UI","Arial Black",Arial,sans-serif;padding:10px;width:300px;margin:0 auto;font-size:13px;color:#000;background:#fff;font-weight:700;-webkit-font-smoothing:none;-moz-osx-font-smoothing:never;font-smooth:never;text-rendering:geometricPrecision;}' +
        // Thermal-printer override. Forces every element black + bold
        // + thin stroke. Bumps tiny inline 9-10px sizes to 11px so
        // they survive on 80mm paper. Padding 5mm keeps borders out
        // of the printer's hardware-clipped right margin.
        '@media print{@page{margin:0;size:80mm auto;}' +
          'body{padding:6px 5mm;width:100%;font-weight:800;}' +
          '*,*::before,*::after{color:#000 !important;font-weight:700 !important;-webkit-text-stroke:0.3px #000;text-shadow:0 0 0.4px #000;}' +
          '[style*="font-size:9px"],[style*="font-size:10px"]{font-size:11px !important;}' +
        '}' +
      '</style></head><body>' + bodyHtml + '</body></html>';
  }

  // ── Silent print via hidden iframe ──
  // Browsers / kiosks block popups in many configurations; iframe
  // printing always succeeds and goes straight to the OS default
  // printer (silent under Chrome / Edge --kiosk-printing). The iframe
  // self-cleans after 4s.
  function silentPrint(html) {
    try { var prior = document.getElementById('mtPrintFrame'); if (prior) prior.remove(); } catch (e) {}
    var f = document.createElement('iframe');
    f.id = 'mtPrintFrame';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:-10000px;bottom:-10000px;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(f);
    f.onload = function() {
      try { f.contentWindow.focus(); f.contentWindow.print(); }
      catch (e) { console.warn('[MTReceipt] iframe print failed:', e); }
      setTimeout(function() { try { f.remove(); } catch (e) {} }, 4000);
    };
    var doc = f.contentDocument || f.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  }

  // ── Module-private state: the most recently rendered receipt ──
  // Used by printLast() so the "Print" button in #modalReceipt
  // can re-fire the print without re-fetching from the server.
  // Also mirrored to window.state._lastReceipt for legacy code that
  // reads the snapshot directly.
  var _lastReceipt = null;

  /**
   * Ensure the QRCode library is loaded. POS preloads it via
   * <script src="qrcode.min.js"> so this resolves instantly. Admin
   * lazy-loads it via window.ensureQRCode() — we delegate to that
   * if present; otherwise we assume QRCode is already global.
   */
  function _ensureQRCodeLib() {
    if (typeof window.QRCode !== 'undefined') return Promise.resolve();
    if (typeof window.ensureQRCode === 'function') return window.ensureQRCode();
    // Last-resort fallback: try to inject the CDN script
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = function() { reject(new Error('فشل تحميل مكتبة QRCode')); };
      document.head.appendChild(s);
    });
  }

  /**
   * The main entry point.  Fetches /api/sales/invoice/:orderId,
   * renders the receipt preview into #receiptBox of #modalReceipt,
   * generates the ZATCA QR code, opens the modal, and (by default)
   * auto-prints the thermal version after 600ms.
   *
   * Callable from any context.  Used by:
   *   • POS:    after checkout (autoPrint=true, default)
   *   • Admin:  reprint button in transactions report (autoPrint=true)
   *
   * @param {string} orderId
   * @param {Object} [opts]
   * @param {Object} [opts.api]        - api-bridge (defaults to window.api)
   * @param {Object} [opts.settings]   - shell settings (defaults to window.state.settings)
   * @param {string} [opts.user]       - current user (defaults to window.state.user)
   * @param {string} [opts.previewSelector] - selector of preview container (defaults to '#receiptBox')
   * @param {string} [opts.modalSelector]   - modal selector (defaults to '#modalReceipt')
   * @param {boolean} [opts.autoPrint] - whether to auto-print (default true)
   * @param {Function} [opts.openModal] - modal-open function (defaults to openGlassModal || openModal)
   */
  function printInvoice(orderId, opts) {
    opts = opts || {};
    var apiObj = opts.api || window.api;
    var settings = opts.settings || (window.state && window.state.settings) || {};
    var user = opts.user || (window.state && window.state.user) || '';
    var previewSelector = opts.previewSelector || '#receiptBox';
    var modalSelector = opts.modalSelector || '#modalReceipt';
    var autoPrint = opts.autoPrint !== false;
    var openModalFn = opts.openModal || window.openGlassModal || window.openModal;

    if (!apiObj || typeof apiObj.withSuccessHandler !== 'function') {
      _toast('API غير متاح لجلب الفاتورة', true);
      return;
    }

    _ensureQRCodeLib().catch(function(e) {
      _toast(e.message || 'فشل تحميل QRCode', true);
    });

    apiObj
      .withFailureHandler(function(err) {
        _toast((err && err.message) || 'فشل جلب الفاتورة', true);
      })
      .withSuccessHandler(function(inv) {
        if (!inv) { _toast('الفاتورة غير موجودة', true); return; }

        console.log('[MTReceipt] orderId=' + orderId + ' customer:',
          inv.customerId ? (inv.customerId + ' / ' + (inv.customerName || '(no name)') + ' / ' + (inv.customerPhone || '(no phone)')) : 'null (walk-in)');

        var receipt = _prepReceipt(inv, settings, user);
        _lastReceipt = receipt;
        // Mirror to legacy global so old code that reads state._lastReceipt still works
        try { if (window.state) window.state._lastReceipt = receipt; } catch (e) {}

        // Render preview HTML (body only, no <html> wrapper) into modal
        var previewHtml = buildReceiptHTML(receipt, { includeWrapper: false });
        var box = document.querySelector(previewSelector);
        if (box) box.innerHTML = previewHtml;

        // Open modal
        if (typeof openModalFn === 'function') {
          try { openModalFn(modalSelector); } catch (e) { console.warn('[MTReceipt] modal open failed:', e); }
        }

        // Generate ZATCA QR code in the rendered preview
        setTimeout(function() {
          var qrEl = (box && box.querySelector('#receiptQR')) || document.getElementById('receiptQR');
          if (qrEl && typeof window.QRCode !== 'undefined') {
            qrEl.innerHTML = '';
            var tlv = generateZATCA_TLV(
              receipt.companyName,
              receipt.taxNumber,
              new Date(inv.date).toISOString(),
              _formatVal(inv.totalFinal),
              receipt.vatAmount.toFixed(2)
            );
            try {
              new window.QRCode(qrEl, { text: tlv, width: 140, height: 140, colorDark: '#000', colorLight: '#fff' });
            } catch (e) { console.warn('[MTReceipt] QR render failed:', e); }
          }
        }, 200);

        // Auto-print thermal version after the QR canvas is ready
        if (autoPrint) {
          setTimeout(function() { printLast(); }, 600);
        }
      })
      .getInvoice(orderId);
  }

  /**
   * Re-print the most recently rendered receipt.  Used by the "Print"
   * button inside #modalReceipt (onclick="printReceiptWindow()") so
   * the cashier / owner can re-trigger printing without re-fetching.
   */
  function printLast() {
    if (!_lastReceipt) {
      _toast('لا توجد فاتورة محفوظة للطباعة', true);
      return;
    }
    // Grab the QR canvas data-URL from the on-screen preview so the
    // printed copy includes the visible ZATCA QR (rather than an
    // empty placeholder div).
    var qrCanvas = document.querySelector('#receiptQR canvas');
    var qrImg = qrCanvas ? qrCanvas.toDataURL() : '';
    var fullHtml = buildReceiptHTML(_lastReceipt, { qrImg: qrImg, includeWrapper: true });
    silentPrint(fullHtml);
  }

  // ── Public API ──
  window.MTReceipt = {
    printInvoice: printInvoice,
    printLast: printLast,
    silentPrint: silentPrint,
    buildReceiptHTML: buildReceiptHTML,
    generateZATCA_TLV: generateZATCA_TLV
  };

  // ── Backward-compat globals ──
  // Existing HTML / onclick attributes (e.g. pos/index.html line 748:
  // onclick="printReceiptWindow()") and existing calls in app.js
  // continue to work without modification.
  window.printReceipt = function(orderId) { return printInvoice(orderId); };
  window.printReceiptWindow = function() { return printLast(); };
  window.generateZATCA_TLV = generateZATCA_TLV;
  window._silentPrint = silentPrint;
})();
