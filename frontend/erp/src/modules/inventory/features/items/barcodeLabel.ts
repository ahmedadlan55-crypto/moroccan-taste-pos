// Phase W4 — Code39 SVG generator + label printing. Code39 is chosen because
// it covers the alphanumeric codes lib/barcode.js accepts (A–Z, 0–9, -.$/+% and
// space) with a trivially-correct encoding — no external dependency, and the
// output is scannable by every commercial reader.

const CODE39: Record<string, string> = {
  "0": "101001101101", "1": "110100101011", "2": "101100101011", "3": "110110010101",
  "4": "101001101011", "5": "110100110101", "6": "101100110101", "7": "101001011011",
  "8": "110100101101", "9": "101100101101",
  A: "110101001011", B: "101101001011", C: "110110100101", D: "101011001011",
  E: "110101100101", F: "101101100101", G: "101010011011", H: "110101001101",
  I: "101101001101", J: "101011001101", K: "110101010011", L: "101101010011",
  M: "110110101001", N: "101011010011", O: "110101101001", P: "101101101001",
  Q: "101010110011", R: "110101011001", S: "101101011001", T: "101011011001",
  U: "110010101011", V: "100110101011", W: "110011010101", X: "100101101011",
  Y: "110010110101", Z: "100110110101",
  "-": "100101011011", ".": "110010101101", " ": "100110101101", "$": "100100100101",
  "/": "100100101001", "+": "100101001001", "%": "101001001001", "*": "100101101101",
};

/** Returns an SVG string for the code, or null when it has un-encodable chars. */
export function code39Svg(code: string, opts?: { height?: number; moduleWidth?: number }): string | null {
  const text = String(code || "").toUpperCase();
  if (!text || [...text].some((c) => !CODE39[c] || c === "*")) return null;
  const height = opts?.height ?? 48;
  const mw = opts?.moduleWidth ?? 2;
  const full = "*" + text + "*";
  let bars = "";
  let x = 0;
  for (let i = 0; i < full.length; i++) {
    const pattern = CODE39[full[i]];
    for (let j = 0; j < pattern.length; j++) {
      if (pattern[j] === "1") bars += `<rect x="${x}" y="0" width="${mw}" height="${height}" fill="#0f172a"/>`;
      x += mw;
    }
    x += mw; // inter-character gap
  }
  const width = x - mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${text}">${bars}</svg>`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export interface LabelSpec { itemName: string; sku?: string | null; code: string; sizeVariant?: string | null }

/** Opens a print window with one label card per barcode (repeat for copies). */
export function printBarcodeLabels(labels: LabelSpec[], copies = 1): void {
  const cards = labels.flatMap((l) => Array.from({ length: Math.max(1, copies) }, () => l)).map((l) => {
    const svg = code39Svg(l.code, { height: 44, moduleWidth: 2 });
    return `<div class="label">
      <div class="name">${esc(l.itemName)}${l.sizeVariant ? ` — ${esc(l.sizeVariant)}` : ""}</div>
      ${svg ?? '<div class="nosvg">تعذّر توليد رمز مرئي لهذا الباركود (رموز غير مدعومة في Code39)</div>'}
      <div class="code" dir="ltr">${esc(l.code)}</div>
      ${l.sku ? `<div class="sku" dir="ltr">SKU: ${esc(l.sku)}</div>` : ""}
    </div>`;
  }).join("");
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>ملصقات باركود</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Tahoma,sans-serif;margin:16px;direction:rtl;display:flex;flex-wrap:wrap;gap:8px}
  .label{width:220px;border:1px dashed #cbd5e1;border-radius:8px;padding:10px;text-align:center;page-break-inside:avoid}
  .name{font-size:12px;font-weight:700;color:#0f172a;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  svg{max-width:100%;height:auto}
  .code{font-family:monospace;font-size:12px;font-weight:700;letter-spacing:1px;color:#0f172a;margin-top:4px}
  .sku{font-family:monospace;font-size:10px;color:#64748b}
  .nosvg{font-size:10px;color:#b91c1c;padding:8px}
  @media print{body{margin:4mm} .label{border-style:solid}}
</style></head><body>${cards}</body></html>`;
  const w = window.open("", "_blank", "width=760,height=640");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 200);
}
