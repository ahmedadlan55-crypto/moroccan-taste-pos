import type { InvTxConfig } from "./invtxConfig";
import type { InvTxDetail } from "@/modules/inventory/lib/adapters/invtx.adapter";
import { invTxStatusToLabel } from "@/modules/inventory/lib/status-labels";
import type { TFunction } from "@/i18n";

// Open a clean, RTL Arabic print view of a document in a new window and trigger
// the browser print dialog. Self-contained (inline styles) so it prints
// identically regardless of the app's CSS.
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function money(n: number): string { return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function qty(n: number): string { return (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }

export function printInvTx(config: InvTxConfig, d: InvTxDetail, t: TFunction): void {
  const p = (k: string, vars?: Record<string, string | number>) => t(`inventoryRest.invtxPrint.${k}`, vars);
  const isAdj = config.lineMode === "adjustment";
  const head = isAdj
    ? `<tr><th>${esc(p("colItem"))}</th><th>${esc(p("colSystemQty"))}</th><th>${esc(p("colCounted"))}</th><th>${esc(p("colDelta"))}</th><th>${esc(p("colValue"))}</th></tr>`
    : `<tr><th>${esc(p("colItem"))}</th><th>${esc(p("colQty"))}</th><th>${esc(p("colUnitCost"))}</th><th>${esc(p("colTotal"))}</th></tr>`;
  const rows = d.lines
    .map((l) =>
      isAdj
        ? `<tr><td>${esc(l.item.name)}</td><td>${qty(l.systemQtySnapshot)}</td><td>${qty(l.countedQty)}</td><td>${l.delta > 0 ? "+" : ""}${qty(l.delta)}</td><td>${money(l.deltaValue)}</td></tr>`
        : `<tr><td>${esc(l.item.name)}</td><td>${qty(l.qty)} ${esc(l.item.unit)}</td><td>${money(l.unitCost)}</td><td>${money(l.lineTotal)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(d.number)}</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Tahoma,sans-serif;color:#0f172a;margin:32px;direction:rtl}
  h1{font-size:20px;margin:0} .muted{color:#64748b;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f766e;padding-bottom:12px}
  .badge{display:inline-block;background:#ccfbf1;color:#0f766e;border-radius:8px;padding:2px 10px;font-weight:700;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}
  .cell{border:1px solid #e2e8f0;border-radius:8px;padding:8px} .cell b{display:block;font-size:10px;color:#94a3b8}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
  th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:right} th{background:#f1f5f9}
  .total{margin-top:12px;text-align:left;font-weight:700} .sign{margin-top:48px;display:flex;justify-content:space-between;color:#64748b;font-size:12px}
  @media print{body{margin:12mm}}
</style></head><body>
  <div class="head">
    <div><h1>${esc(config.title)}</h1><div class="muted">${esc(d.number)}</div></div>
    <div style="text-align:left"><span class="badge">${esc(invTxStatusToLabel(d.status))}</span><div class="muted">${esc(d.date ?? "")}</div></div>
  </div>
  <div class="grid">
    <div class="cell"><b>${esc(p("warehouse"))}</b>${esc(d.warehouse.name || d.warehouse.id)}</div>
    <div class="cell"><b>${esc(p("value"))}</b>${money(d.totalValue)}</div>
    <div class="cell"><b>${esc(p("itemCount"))}</b>${d.lines.length}</div>
    ${d.reason ? `<div class="cell"><b>${esc(p("reason"))}</b>${esc(d.reason)}</div>` : ""}
    ${d.sourceRef ? `<div class="cell"><b>${esc(p("ref"))}</b>${esc(d.sourceRef)}</div>` : ""}
    ${d.recipient ? `<div class="cell"><b>${esc(p("recipient"))}</b>${esc(d.recipient)}</div>` : ""}
  </div>
  <table><thead>${head}</thead><tbody>${rows}</tbody></table>
  <div class="total">${esc(p("total", { value: money(d.totalValue) }))}</div>
  <div class="sign"><span>${esc(p("preparedBy", { name: d.actors.createdBy || "—" }))}</span><span>${esc(p("approvedBy", { name: d.actors.approvedBy || "—" }))}</span><span>${esc(p("postedBy", { name: d.actors.postedBy || "—" }))}</span></div>
</body></html>`;
  const w = window.open("", "_blank", "width=820,height=900");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 200);
}
