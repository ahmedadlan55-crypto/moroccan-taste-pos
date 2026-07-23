import type { ProductionDetail } from "@/modules/inventory/lib/adapters/production.adapter";
import type { TFunction, Lang } from "@/i18n";
import { productionStatusLabel } from "./status-i18n";

// Bilingual (RTL Arabic / LTR English) print view for a production order —
// self-contained inline styles, ENGLISH (latn) digits per the warehouse
// numbering policy. Direction + every label follow the active UI language; the
// caller (ProductionDetailPage) passes its t()/lang through.
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
const money = (n: number): string => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number): string => (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function printProduction(d: ProductionDetail, t: TFunction, lang: Lang): void {
  const o = d.order;
  const dir = lang === "ar" ? "rtl" : "ltr";
  const planRows = d.plan
    .map((p) => `<tr><td>${esc(p.itemName)}</td><td class="n">${qty(p.qtyPlanned)} ${esc(p.itemUnit)}</td><td class="n">${qty(p.qtyIssued)}</td><td class="n">${qty(Math.max(p.remaining, 0))}</td><td class="n">${money(p.totalCost)}</td></tr>`)
    .join("");
  const outRows = d.outputs
    .map((ev) => `<tr><td>${esc(ev.producedAt ?? "—")}</td><td class="n">${qty(ev.qty)}</td><td class="n">${qty(ev.qtyWaste)}</td><td class="n">${money(ev.unitCost)}</td><td>${esc(ev.batchNumber ?? "—")}</td><td class="n">${money(ev.totalCost + ev.wasteCost)}</td></tr>`)
    .join("");
  const issueRows = d.issueEvents
    .map((ev) => `<tr><td class="n">${qty(ev.eventNo)}</td><td>${esc(ev.issuedBy)}</td><td>${esc(ev.issuedAt ?? "—")}</td><td class="n">${money(ev.materialsCost)}</td><td class="n">${money(ev.laborCost)}</td><td class="n">${money(ev.overheadCost)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><title>${esc(o.number)}</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Tahoma,sans-serif;color:#0f172a;margin:32px;direction:${dir}}
  h1{font-size:20px;margin:0} h2{font-size:14px;margin:20px 0 6px} .muted{color:#64748b;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f766e;padding-bottom:12px}
  .badge{display:inline-block;background:#ccfbf1;color:#0f766e;border-radius:8px;padding:2px 10px;font-weight:700;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
  .cell{border:1px solid #e2e8f0;border-radius:8px;padding:8px} .cell b{display:block;font-size:10px;color:#94a3b8}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
  th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:start} th{background:#f1f5f9}
  .n{direction:ltr;text-align:end;font-variant-numeric:tabular-nums}
  .sign{margin-top:48px;display:flex;justify-content:space-between;color:#64748b;font-size:12px}
  @media print{body{margin:12mm}}
</style></head><body>
  <div class="head">
    <div><h1>${esc(t("production.print.docTitle"))}</h1><div class="muted n">${esc(o.number)}</div></div>
    <div style="text-align:end"><span class="badge">${esc(productionStatusLabel(t, o.status))}</span><div class="muted n">${esc(o.plannedDate ?? "")}</div></div>
  </div>
  <div class="grid">
    <div class="cell"><b>${esc(t("production.print.product"))}</b>${esc(o.productName)}</div>
    <div class="cell"><b>${esc(t("production.print.plannedQty"))}</b><span class="n">${qty(o.qtyPlanned)}</span> ${esc(o.productUnit)}</div>
    <div class="cell"><b>${esc(t("production.print.producedWaste"))}</b><span class="n">${qty(o.qtyProduced)} / ${qty(o.qtyWaste)}</span></div>
    <div class="cell"><b>${esc(t("production.print.unitCost"))}</b><span class="n">${money(o.unitCost)}</span></div>
    <div class="cell"><b>${esc(t("production.print.sourceWarehouse"))}</b>${esc(o.warehouseName)}</div>
    <div class="cell"><b>${esc(t("production.print.outputWarehouse"))}</b>${esc(o.outputWarehouseName)}</div>
    <div class="cell"><b>${esc(t("production.print.totalCost"))}</b><span class="n">${money(o.totalCost)}</span></div>
    <div class="cell"><b>${esc(t("production.print.wipBalance"))}</b><span class="n">${money(o.wipBalance)}</span></div>
  </div>
  <h2>${esc(t("production.print.planHeading"))}</h2>
  <table><thead><tr><th>${esc(t("production.print.plan.material"))}</th><th>${esc(t("production.print.plan.planned"))}</th><th>${esc(t("production.print.plan.issued"))}</th><th>${esc(t("production.print.plan.remaining"))}</th><th>${esc(t("production.print.plan.value"))}</th></tr></thead><tbody>${planRows}</tbody></table>
  ${issueRows ? `<h2>${esc(t("production.print.issuesHeading"))}</h2><table><thead><tr><th>#</th><th>${esc(t("production.print.issues.by"))}</th><th>${esc(t("production.print.issues.date"))}</th><th>${esc(t("production.print.issues.materials"))}</th><th>${esc(t("production.print.issues.labor"))}</th><th>${esc(t("production.print.issues.overhead"))}</th></tr></thead><tbody>${issueRows}</tbody></table>` : ""}
  ${outRows ? `<h2>${esc(t("production.print.outputsHeading"))}</h2><table><thead><tr><th>${esc(t("production.print.outputs.date"))}</th><th>${esc(t("production.print.outputs.good"))}</th><th>${esc(t("production.print.outputs.waste"))}</th><th>${esc(t("production.print.outputs.unitCost"))}</th><th>${esc(t("production.print.outputs.batch"))}</th><th>${esc(t("production.print.outputs.value"))}</th></tr></thead><tbody>${outRows}</tbody></table>` : ""}
  <div class="sign"><span>${esc(t("production.print.createdBy"))}: ${esc(o.createdBy || "—")}</span><span>${esc(t("production.print.approvedBy"))}: ${esc(o.approvedBy || "—")}</span><span>${esc(t("production.print.signature"))}: ${esc(t("production.print.signatureLine"))}</span></div>
</body></html>`;
  const w = window.open("", "_blank", "width=880,height=940");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 200);
}
