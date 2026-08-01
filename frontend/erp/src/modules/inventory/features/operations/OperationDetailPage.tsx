/**
 * SCREEN 2 — one inventory document, in full, as a REAL ROUTE
 * (`/inventory/operations/:type/:id`).
 *
 * This page replaces the two `?view=<id>` detail DRAWERS (transfers +
 * receipt/issue/adjustment). A drawer could show a summary; it could not show a
 * document's ledger footprint, its lots, its GL journals AND its audit trail
 * without becoming a scrolling tunnel — and it could not be linked to, printed,
 * or opened in a second tab.
 *
 * The DATA here is a read model (one normalised projection over eleven document
 * families), but the page is NOT read-only. Those two drawers were the only UI
 * in the ERP carrying approve · issue · receive · post · cancel · reverse ·
 * delete · print for their families, so shipping this page without them would
 * have deleted those actions from the product. `OperationActions` renders them,
 * reusing the drawers' own mutation hooks, permission checks and dialogs.
 *
 * Every section renders from the server payload only: an absent section says so
 * (a document that is not posted yet legitimately has no movements and no
 * journal) instead of rendering a fabricated zero.
 */
import { Link } from "react-router-dom";
import type { ComponentType, ReactNode } from "react";
import { ArrowRight, Boxes, FileText, History, Layers, Package, Paperclip, Printer, Receipt, Scale } from "lucide-react";
import { Badge, Button, ErrorState, LoadingState, PanelTitle, StatusBadge } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatQty } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  useOperationDetail,
  type OperationDetail,
  type OperationSide,
} from "@/modules/inventory/lib/hooks/useOperations";
import { OperationActions } from "./OperationActions";
import { extractAttachments, sideKindLabel, statusLabel, timelineActionLabel, typeLabel } from "./labels";

const DASH = "—";

export function OperationDetailPage({ documentType, documentId }: { documentType: string; documentId: string }) {
  const t = useT();
  const q = useOperationDetail(documentType, documentId);

  const back = (
    <Link to="/inventory/operations" className="inline-flex items-center gap-1 text-sm font-bold text-teal-700 hover:underline">
      {/* The "back" arrow points at the inline-START edge in BOTH directions. */}
      <ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" />
      {t("operations.detail.back")}
    </Link>
  );

  if (q.isLoading) {
    return (
      <div className="grid gap-6">
        {back}
        <LoadingState rows={3} />
      </div>
    );
  }
  // A failed detail request is an ERROR — never a blank document.
  if (q.isError || !q.data) {
    return (
      <div className="grid gap-6">
        {back}
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  }

  const d: OperationDetail = q.data;
  const h = d.data;
  const attachments = extractAttachments(d.header);

  return (
    <div className="print-document grid gap-6">
      {back}

      {/* ── header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-extrabold tracking-wide text-teal-700">
            <FileText className="h-4 w-4" aria-hidden="true" />
            {t("operations.detail.eyebrow")}
          </div>
          <h1 className="mt-0.5 break-words text-2xl font-extrabold text-slate-900" dir="ltr">
            {h.documentNumber || h.documentId || t("operations.detail.fallbackTitle")}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Badge tone="neutral">{typeLabel(t, h.documentType, h.documentTypeLabel)}</Badge>
            <span>{formatDate(h.date)}</span>
            {h.rawStatus && (
              <span className="font-mono" dir="ltr">
                {t("operations.detail.field.rawStatus")}: {h.rawStatus}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="no-print" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" /> {t("operations.detail.print")}
          </Button>
          <StatusBadge>{statusLabel(t, h.status)}</StatusBadge>
        </div>
      </div>

      {/* ── workflow actions ──
          The transfer / receipt / issue / adjustment DRAWERS this page replaces
          were the ONLY UI carrying approve · issue · receive · post · cancel ·
          reverse · delete · print. Shipping this page read-only would have
          removed every one of those actions from the product. They live here
          now, driven by the SAME mutation hooks, permission checks and dialogs
          the drawers used. Families with no write surface render nothing. */}
      <OperationActions documentType={h.documentType} documentId={h.documentId} />

      {/* ── summary ── */}
      <Section title={t("operations.detail.section.summary")} icon={Boxes}>
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-4">
          <KV label={t("operations.detail.field.number")} value={h.documentNumber || h.documentId} ltr />
          <KV label={t("operations.detail.field.type")} value={typeLabel(t, h.documentType, h.documentTypeLabel)} />
          <KV label={t("operations.detail.field.date")} value={formatDate(h.date)} />
          <KV label={t("operations.detail.field.status")} value={statusLabel(t, h.status)} />
          <KV label={t("operations.detail.field.source")} value={<SideValue t={t} side={h.source} />} />
          <KV label={t("operations.detail.field.destination")} value={<SideValue t={t} side={h.destination} />} />
          <KV label={t("operations.detail.field.party")} value={h.partyLabel || DASH} />
          <KV label={t("operations.detail.field.product")} value={h.productSummary || DASH} />
          <KV label={t("operations.detail.field.lines")} value={h.lineCount == null ? DASH : formatNumber(h.lineCount)} />
          <KV
            label={t("operations.detail.field.quantity")}
            value={h.totalQuantity == null ? DASH : formatQty(h.totalQuantity)}
          />
          <KV
            label={t("operations.detail.field.netValue")}
            value={h.totalValue == null ? DASH : formatCurrency(h.totalValue)}
          />
          <KV label={t("operations.detail.field.vat")} value={h.vatAmount == null ? DASH : formatCurrency(h.vatAmount)} />
          <KV
            label={t("operations.detail.field.grossValue")}
            value={h.grossValue == null ? DASH : formatCurrency(h.grossValue)}
          />
          <KV label={t("operations.detail.field.currency")} value={h.currency} />
          <KV label={t("operations.detail.field.createdBy")} value={h.createdByName || h.createdBy || DASH} />
          <KV label={t("operations.detail.field.approvedBy")} value={h.approvedByName || h.approvedBy || DASH} />
          <KV label={t("operations.detail.field.createdAt")} value={formatDateTime(h.createdAt)} />
        </div>
        {h.valueSigned && (
          <p className="border-t border-slate-100 px-5 py-3 text-xs font-bold text-amber-700">
            {t("operations.detail.signedValueNote")}
          </p>
        )}
      </Section>

      {/* ── line items ── */}
      <Section title={t("operations.detail.section.lines")} icon={Layers}>
        <Scroller>
          {d.lines.length === 0 ? (
            <Empty>{t("operations.detail.lines.empty")}</Empty>
          ) : (
            <table className="w-full text-sm">
              <THead
                cells={[
                  t("operations.detail.lines.item"),
                  t("operations.detail.lines.unit"),
                  t("operations.detail.lines.qty"),
                  t("operations.detail.lines.unitCost"),
                  t("operations.detail.lines.total"),
                ]}
                numericFrom={2}
              />
              <tbody className="divide-y divide-slate-100">
                {d.lines.map((l, i) => (
                  <tr key={l.id ?? i}>
                    <Td className="font-bold text-slate-800">{l.itemName || l.itemId || DASH}</Td>
                    <Td>{l.unit || DASH}</Td>
                    <TdNum>{l.qty == null ? DASH : formatQty(l.qty)}</TdNum>
                    <TdNum>{l.unitCost == null ? DASH : formatCurrency(l.unitCost)}</TdNum>
                    <TdNum>{l.lineTotal == null ? DASH : formatCurrency(l.lineTotal)}</TdNum>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Scroller>
      </Section>

      {/* ── stock movements the document produced ── */}
      <Section title={t("operations.detail.section.movements")} icon={Scale}>
        <Scroller>
          {d.movements.length === 0 ? (
            <Empty>{t("operations.detail.movements.empty")}</Empty>
          ) : (
            <table className="w-full text-sm">
              <THead
                cells={[
                  t("operations.detail.movements.at"),
                  t("operations.detail.movements.item"),
                  t("operations.detail.movements.type"),
                  t("operations.detail.movements.qty"),
                  t("operations.detail.movements.warehouse"),
                  t("operations.detail.movements.reference"),
                  t("operations.detail.movements.actor"),
                ]}
                numericFrom={3}
                numericTo={3}
              />
              <tbody className="divide-y divide-slate-100">
                {d.movements.map((m) => (
                  <tr key={m.id}>
                    <Td className="text-slate-500">{formatDateTime(m.at)}</Td>
                    <Td className="font-bold text-slate-800">{m.itemName || m.itemId || DASH}</Td>
                    <Td>
                      <Badge tone={m.type === "in" ? "success" : "danger"}>
                        {m.type === "in" ? t("operations.detail.movements.in") : t("operations.detail.movements.out")}
                      </Badge>
                    </Td>
                    <TdNum>{m.qty == null ? DASH : formatQty(m.qty)}</TdNum>
                    <Td>{m.warehouseId || DASH}</Td>
                    <Td className="font-mono text-xs text-slate-500" dir="ltr">
                      {m.referenceType ? `${m.referenceType}#${m.referenceId ?? ""}` : DASH}
                    </Td>
                    <Td>{m.actor || DASH}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Scroller>
      </Section>

      {/* ── lots ── */}
      <Section title={t("operations.detail.section.lots")} icon={Package}>
        <Scroller>
          {d.lots.length === 0 ? (
            <Empty>{t("operations.detail.lots.empty")}</Empty>
          ) : (
            <table className="w-full text-sm">
              <THead
                cells={[
                  t("operations.detail.lots.lot"),
                  t("operations.detail.lots.expiry"),
                  t("operations.detail.lots.item"),
                  t("operations.detail.lots.warehouse"),
                  t("operations.detail.lots.qty"),
                  t("operations.detail.lots.at"),
                ]}
                numericFrom={4}
                numericTo={4}
              />
              <tbody className="divide-y divide-slate-100">
                {d.lots.map((l) => (
                  <tr key={l.id}>
                    <Td className="font-bold text-slate-800" dir="ltr">
                      {l.lotNumber || l.lotId || DASH}
                    </Td>
                    <Td className="text-slate-500">{formatDate(l.expiryDate)}</Td>
                    <Td>{l.itemId || DASH}</Td>
                    <Td>{l.warehouseId || DASH}</Td>
                    <TdNum>{l.signedQty == null ? DASH : formatQty(l.signedQty)}</TdNum>
                    <Td className="text-slate-500">{formatDateTime(l.at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Scroller>
      </Section>

      {/* ── GL journals + their entries ── */}
      <Section title={t("operations.detail.section.journals")} icon={Receipt}>
        {d.journals.length === 0 ? (
          <Scroller>
            <Empty>{t("operations.detail.journals.empty")}</Empty>
          </Scroller>
        ) : (
          <div className="space-y-4 p-5">
            {d.journals.map((j) => (
              <div key={j.id} className="rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-extrabold text-slate-800" dir="ltr">
                      {j.journalNumber || j.id}
                    </span>
                    <span className="text-xs text-slate-400">{formatDate(j.journalDate)}</span>
                    {j.description && <span className="text-xs text-slate-500">{j.description}</span>}
                    {/* Additive only: the journal itself always renders — this is
                        just a shortcut for users who also work in accounting. */}
                    <Can cap="accounting.journals.view">
                      <Link
                        to={`/accounting/journals?q=${encodeURIComponent(j.journalNumber || j.id)}`}
                        className="text-xs font-bold text-teal-700 hover:underline"
                      >
                        {t("operations.detail.journals.openInAccounting")}
                      </Link>
                    </Can>
                  </div>
                  <div className="flex gap-4 text-xs font-bold text-slate-600">
                    <span dir="ltr" className="tabular-nums">
                      {t("operations.detail.journals.totalDebit")}: {formatCurrency(j.totalDebit)}
                    </span>
                    <span dir="ltr" className="tabular-nums">
                      {t("operations.detail.journals.totalCredit")}: {formatCurrency(j.totalCredit)}
                    </span>
                  </div>
                </div>
                <Scroller>
                  <table className="w-full text-sm">
                    <THead
                      cells={[
                        t("operations.detail.journals.account"),
                        t("operations.detail.journals.debit"),
                        t("operations.detail.journals.credit"),
                      ]}
                      numericFrom={1}
                    />
                    <tbody className="divide-y divide-slate-100">
                      {j.entries.map((e, i) => (
                        <tr key={`${j.id}:${i}`}>
                          <Td>
                            <span className="font-mono text-xs text-slate-400" dir="ltr">
                              {e.accountCode}
                            </span>{" "}
                            <span className="text-slate-700">{e.accountName || ""}</span>
                          </Td>
                          <TdNum>{e.debit ? formatCurrency(e.debit) : DASH}</TdNum>
                          <TdNum>{e.credit ? formatCurrency(e.credit) : DASH}</TdNum>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── attachments (only when the payload actually carries them) ── */}
      <Section title={t("operations.detail.section.attachments")} icon={Paperclip}>
        <div className="p-5">
          {attachments.length === 0 ? (
            <p className="text-sm font-medium text-slate-400">{t("operations.detail.attachments.empty")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <li key={a.id}>
                  {a.url ? (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-bold text-teal-700 hover:bg-slate-50"
                      aria-label={`${t("operations.detail.attachments.open")}: ${a.name}`}
                    >
                      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                      {a.name}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
                      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                      {a.name}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      {/* ── timeline / audit ── */}
      <Section title={t("operations.detail.section.timeline")} icon={History}>
        <div className="p-5">
          {d.timeline.length === 0 ? (
            <p className="text-sm font-medium text-slate-400">{t("operations.detail.timeline.empty")}</p>
          ) : (
            <ol className="space-y-3">
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <span className="text-sm font-extrabold text-slate-800">{timelineActionLabel(t, e.action)}</span>
                    <span className="text-slate-400">
                      {" · "}
                      {e.actor || DASH}
                      {" · "}
                      {formatDateTime(e.at)}
                    </span>
                    {(e.fromStatus || e.toStatus) && (
                      <div className="text-slate-500" dir="ltr">
                        {e.fromStatus || DASH} → {e.toStatus || DASH}
                      </div>
                    )}
                    {e.note && <div className="text-slate-500">{e.note}</div>}
                    {e.synthetic && (
                      <div className="text-slate-300">{t("operations.detail.timeline.synthetic")}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Section>
    </div>
  );
}

// ── small local presentation pieces ─────────────────────────────────────────

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <section className="surface overflow-hidden">
      <PanelTitle icon={icon} title={title} />
      {children}
    </section>
  );
}

function KV({ label, value, ltr }: { label: string; value: ReactNode; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 break-words text-sm font-semibold text-slate-800" dir={ltr ? "ltr" : undefined}>
        {value}
      </div>
    </div>
  );
}

function SideValue({ t, side }: { t: TFunction; side: OperationSide }) {
  if (!side.id && !side.label) return <>{DASH}</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span>{side.label || side.id}</span>
      {side.kind && <span className="text-[11px] font-bold text-slate-400">({sideKindLabel(t, side.kind)})</span>}
    </span>
  );
}

/** Wide tables scroll inside their OWN box — the page body never scrolls sideways. */
function Scroller({ children }: { children: ReactNode }) {
  return <div className="scrollbar-thin w-full overflow-x-auto">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm font-medium text-slate-400">{children}</p>;
}

function THead({ cells, numericFrom, numericTo }: { cells: string[]; numericFrom?: number; numericTo?: number }) {
  const isNum = (i: number) =>
    numericFrom != null && i >= numericFrom && (numericTo == null || i <= numericTo);
  return (
    <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-500">
      <tr>
        {cells.map((c, i) => (
          <th key={c} scope="col" className={`whitespace-nowrap px-4 py-2.5 ${isNum(i) ? "text-end" : "text-start"}`}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Td({ children, className, dir }: { children: ReactNode; className?: string; dir?: "ltr" | "rtl" }) {
  return (
    <td dir={dir} className={`px-4 py-2.5 text-start align-middle text-slate-700 ${className ?? ""}`}>
      {children}
    </td>
  );
}

function TdNum({ children }: { children: ReactNode }) {
  return (
    <td dir="ltr" className="px-4 py-2.5 text-end align-middle font-semibold tabular-nums text-slate-800">
      {children}
    </td>
  );
}
