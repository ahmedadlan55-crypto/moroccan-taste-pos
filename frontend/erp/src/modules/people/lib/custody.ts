// Custody helpers — faithful ports of the legacy admin logic in
// public/js/custody.js (openTopupModal account filters :176-195) and the
// custodian portal upload pipeline (public/custody/app.js pickImg :370-396).

import type { GlAccountLite } from "./types";

// ── Topup GL account split (EXACT legacy heuristics) ─────────────────────────
// Cash/صناديق: code starts with 1110 OR name contains صندوق/نقد/كاش.
// Bank: code starts with 11102 or 1111 OR name contains بنك/مصرف.
// If NEITHER matches anything, fall back to every asset account under 111x —
// shown for BOTH pickers (the legacy behavior).
export interface TopupAccounts {
  cash: GlAccountLite[];
  bank: GlAccountLite[];
}

export function splitTopupAccounts(accounts: GlAccountLite[]): TopupAccounts {
  const all = accounts ?? [];
  let cash = all.filter(
    (a) =>
      (a.code && a.code.indexOf("1110") === 0) ||
      (a.nameAr &&
        (a.nameAr.indexOf("صندوق") >= 0 || a.nameAr.indexOf("نقد") >= 0 || a.nameAr.indexOf("كاش") >= 0)),
  );
  let bank = all.filter(
    (a) =>
      (a.code && (a.code.indexOf("11102") === 0 || a.code.indexOf("1111") === 0)) ||
      (a.nameAr && (a.nameAr.indexOf("بنك") >= 0 || a.nameAr.indexOf("مصرف") >= 0)),
  );
  if (!cash.length && !bank.length) {
    const allCash = all.filter((a) => a.type === "asset" && !!a.code && a.code.indexOf("111") === 0);
    cash = allCash;
    bank = allCash;
  }
  return { cash, bank };
}

/** Options for the topup source picker, per payment method — mirrors
 *  onTopupMethodChange (cash → cash boxes, transfer → banks, other → both). */
export function topupAccountOptions(split: TopupAccounts, method: "cash" | "transfer" | "other"): GlAccountLite[] {
  if (method === "cash") return split.cash;
  if (method === "transfer") return split.bank;
  return [...split.cash, ...split.bank];
}

/** Whether the picked method REQUIRES a GL account (legacy submitTopup rule). */
export function topupRequiresAccount(method: "cash" | "transfer" | "other"): boolean {
  return method === "cash" || method === "transfer";
}

// ── VAT math (mirrors routes/custody.js POST /:id/expenses) ──────────────────
export function expenseTotals(amount: number, hasVat: boolean, vatRate: number) {
  const amt = Number(amount) || 0;
  const rate = hasVat ? Number(vatRate) || 15 : 0;
  const vat = hasVat ? amt * (rate / 100) : 0;
  return { amount: amt, vatRate: rate, vatAmount: vat, totalWithVat: amt + vat };
}

// ── Invoice/receipt file → base64 data-URL (legacy pipeline) ─────────────────
// Images are downscaled to max 1200px and re-encoded as JPEG q=0.82 (the
// custodian portal's exact parameters); PDFs are embedded as-is. The result is
// stored in custody_expenses.invoice_image / custody_topups.receipt_image
// (LONGTEXT) — the same column the legacy apps wrote.
export function fileToInvoiceDataUrl(file: File): Promise<string> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذّرت قراءة الملف"));
    reader.onload = () => {
      const raw = String(reader.result || "");
      if (isPdf) return resolve(raw);
      const img = new Image();
      img.onerror = () => reject(new Error("تعذّرت معالجة الصورة"));
      img.onload = () => {
        try {
          const max = 1200;
          let w = img.width;
          let h = img.height;
          if (w > max || h > max) {
            const sc = Math.min(max / w, max / h);
            w *= sc;
            h *= sc;
          }
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          if (!ctx) return resolve(raw);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL("image/jpeg", 0.82));
        } catch {
          resolve(raw);
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}
