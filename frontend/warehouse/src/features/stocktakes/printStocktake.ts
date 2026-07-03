import type { StocktakeDetail } from "@/lib/adapters/stocktake.adapter";
import { stocktakeStatusToLabel } from "@/lib/status-labels";

// Self-contained RTL print for a stocktake. mode="count" → a blank/blind count
// sheet (for the floor); mode="variance" → the reconciled variance report. All
// styles inline so it prints from a popup with no external CSS.
function esc(v: unknown): string { return String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)); }
function n(v: number, dp = 2): string { return (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); }

export function printStocktake(d: StocktakeDetail, mode: "count" | "variance"): void {
  const blind = d.blindCount && mode === "count";
  const title = mode === "count" ? "ورقة عدّ" : "تقرير فروقات الجرد";
  const head = mode === "count"
    ? `<tr><th>الصنف</th><th>الوحدة</th>${blind ? "" : "<th>النظري وقت العد</th>"}<th>المعدود</th><th>ملاحظات</th></tr>`
    : `<tr><th>الصنف</th><th>اللقطة</th><th>حركات أثناء العد</th><th>النظري وقت العد</th><th>المعدود</th><th>فرق الكمية</th><th>التكلفة</th><th>فرق القيمة</th></tr>`;
  const rows = d.lines.map((l) => {
    if (mode === "count") {
      return `<tr><td class="r">${esc(l.item.name)}</td><td>${esc(l.item.unit)}</td>${blind ? "" : `<td>${n(l.theoreticalQty, 3)}</td>`}<td class="blank"></td><td></td></tr>`;
    }
    const counted = l.counted ? n(l.countedQty ?? 0, 3) : "—";
    const vcls = l.variance < 0 ? "neg" : l.variance > 0 ? "pos" : "";
    return `<tr><td class="r">${esc(l.item.name)}</td><td>${n(l.snapshotQty, 3)}</td><td>${n(l.netMovements, 3)}</td><td>${n(l.theoreticalQty, 3)}</td><td>${counted}</td><td class="${vcls}">${l.counted ? n(l.variance, 3) : "—"}</td><td>${n(l.unitCost, 4)}</td><td class="${vcls}">${l.counted ? n(l.varianceValue) : "—"}</td></tr>`;
  }).join("");
  const totalVar = mode === "variance" ? `<div class="total">إجمالي قيمة الفروقات: <b>${n(d.totalVarianceValue)}</b></div>` : "";

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)} ${esc(d.number)}</title>
<style>
*{box-sizing:border-box} body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#0f172a;margin:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#64748b;font-size:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
.cell{border:1px solid #e2e8f0;border-radius:8px;padding:8px} .cell .k{font-size:10px;color:#94a3b8} .cell .v{font-weight:800;font-size:13px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center}
th{background:#f8fafc;font-weight:800} td.r{text-align:right;font-weight:700} td.blank{height:26px}
.neg{color:#dc2626;font-weight:800} .pos{color:#059669;font-weight:800}
.total{margin-top:12px;text-align:left;font-size:13px}
.sign{margin-top:28px;display:flex;justify-content:space-between;font-size:12px;color:#475569}
@media print{body{margin:8mm}}
</style></head><body>
<h1>${esc(title)} — ${esc(d.number)}</h1>
<div class="sub">المستودع: ${esc(d.warehouse.name)} · الحالة: ${esc(stocktakeStatusToLabel(d.status))} · ${esc(d.date ?? "")}</div>
<div class="grid">
  <div class="cell"><div class="k">عدد الأصناف</div><div class="v">${n(d.totalLines, 0)}</div></div>
  <div class="cell"><div class="k">المعدود</div><div class="v">${n(d.countedLines, 0)}</div></div>
  <div class="cell"><div class="k">أسطر الفروقات</div><div class="v">${n(d.varianceLines, 0)}</div></div>
  <div class="cell"><div class="k">${mode === "count" ? "النوع" : "إجمالي قيمة الفرق"}</div><div class="v">${mode === "count" ? (blind ? "عدّ أعمى" : "عدّ مفتوح") : n(d.totalVarianceValue)}</div></div>
</div>
<table><thead>${head}</thead><tbody>${rows}</tbody></table>
${totalVar}
<div class="sign"><span>العادّ: ${esc(d.actors.createdBy || "____________")}</span><span>المراجع: ${esc(d.actors.approvedBy || "____________")}</span><span>المرحّل: ${esc(d.actors.postedBy || "____________")}</span></div>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 250);
}
