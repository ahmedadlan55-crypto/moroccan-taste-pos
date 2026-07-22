// ── JournalDetail — read-only journal voucher (view + print) ─────────────────
// Used for posted/reversed journals (which are immutable) and as the print
// surface. The action bar (back / print / reverse) is screen-only; the voucher
// body sits in a `.print-document` so window.print() emits just the voucher.

import type { ReactNode } from "react";
import { ArrowRight, Printer, Undo2 } from "lucide-react";
import { Button, StatusBadge } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import { glTypeLabel, type Journal } from "../api";
import { MoneyText, STATUS_LABEL, computeTotals } from "./journalModel";

export interface JournalDetailProps {
  journal: Journal;
  onReverse?: () => void;
  onBack: () => void;
}

function InfoCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-slate-400">{label}</span>
      <span className="text-sm font-bold text-slate-800">{value ?? "—"}</span>
    </div>
  );
}

export function JournalDetail({ journal, onReverse, onBack }: JournalDetailProps) {
  const t = useT();
  const totals = computeTotals(journal.entries);
  const reversed = !!journal.reversedByJournalId;

  return (
    <div>
      {/* Action bar — never printed */}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" onClick={onBack}>
          <ArrowRight className="h-4 w-4" /> {t("common.back")}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> {t("accounting.common.print")}
          </Button>
          {onReverse && (
            <Button variant="danger" onClick={onReverse}>
              <Undo2 className="h-4 w-4" /> {t("accounting.journal.editor.reverseTitle")}
            </Button>
          )}
        </div>
      </div>

      {/* Printable voucher */}
      <div className="print-document surface overflow-hidden">
        {/* Voucher header */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-5 py-4">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-extrabold text-slate-900">{t("accounting.journal.detail.voucherTitle")}</h2>
              <StatusBadge>{reversed ? "معكوس" : STATUS_LABEL[journal.status]}</StatusBadge>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
              <span>{t("accounting.journal.detail.number")}</span>
              <code dir="ltr" className="rounded bg-white px-2 py-0.5 text-teal-700 tabular-nums">
                {journal.journalNumber}
              </code>
            </div>
          </div>
          <div className="text-xs font-extrabold text-teal-700">{t("accounting.common.systemName")}</div>
        </div>

        {/* Meta grid */}
        <div className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-4">
          <InfoCell
            label={t("accounting.common.date")}
            value={
              <span dir="ltr" className="tabular-nums">
                {formatDate(journal.journalDate)}
              </span>
            }
          />
          <InfoCell label={t("accounting.journal.detail.status")} value={<StatusBadge>{reversed ? "معكوس" : STATUS_LABEL[journal.status]}</StatusBadge>} />
          {journal.createdBy && <InfoCell label={t("accounting.journal.detail.createdBy")} value={journal.createdBy} />}
          {journal.approvedBy && <InfoCell label={t("accounting.journal.detail.approvedBy")} value={journal.approvedBy} />}
          {journal.postedBy && <InfoCell label={t("accounting.journal.detail.postedBy")} value={journal.postedBy} />}
          {journal.brandName && <InfoCell label={t("accounting.journal.editor.brand")} value={journal.brandName} />}
          {journal.branchName && <InfoCell label={t("accounting.journal.editor.branch")} value={journal.branchName} />}
          {journal.projectName && <InfoCell label={t("accounting.journal.editor.project")} value={journal.projectName} />}
          {journal.costCenterName && <InfoCell label={t("accounting.journal.detail.costCenter")} value={journal.costCenterName} />}
        </div>

        {/* Description */}
        <div className="border-y border-slate-100 px-5 py-3">
          <InfoCell label={t("accounting.journal.editor.description")} value={journal.description || "—"} />
          {journal.notes && (
            <p dir="ltr" className="mt-2 text-xs font-medium text-slate-400">
              {journal.notes}
            </p>
          )}
        </div>

        {/* Lines */}
        <div className="overflow-x-auto px-2 py-2">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
                <th className="px-3 py-2 text-right">{t("accounting.journal.detail.accountNo")}</th>
                <th className="px-3 py-2 text-right">{t("accounting.journal.detail.accountName")}</th>
                <th className="px-3 py-2 text-right">{t("accounting.common.statement")}</th>
                <th className="px-3 py-2 text-left">{t("accounting.common.debit")}</th>
                <th className="px-3 py-2 text-left">{t("accounting.common.credit")}</th>
              </tr>
            </thead>
            <tbody>
              {journal.entries.map((l, i) => (
                <tr key={l.id ?? i} className="border-b border-slate-50 last:border-0">
                  <td className="px-3 py-2">
                    <code dir="ltr" className="text-[11px] font-semibold text-slate-500 tabular-nums">
                      {l.accountCode || "—"}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    <span className="font-semibold">{l.accountName || "—"}</span>
                    {l.accountType && (
                      <span className="mr-2 text-[11px] font-bold text-slate-400">
                        {glTypeLabel(t, l.accountType)}
                      </span>
                    )}
                    {l.costCenterName && (
                      <span className="block text-[11px] font-medium text-slate-400">
                        {t("accounting.journal.detail.lineCostCenter", { name: l.costCenterName })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{l.description || "—"}</td>
                  <td className="px-3 py-2 text-left">
                    <MoneyText value={l.debit} />
                  </td>
                  <td className="px-3 py-2 text-left">
                    <MoneyText value={l.credit} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 text-xs font-extrabold">
                <td className="px-3 py-2.5" colSpan={3}>
                  {t("accounting.journal.detail.totalLines", { count: journal.entries.length })}
                </td>
                <td className="px-3 py-2.5 text-left">
                  <MoneyText value={totals.totalDebit} strong />
                </td>
                <td className="px-3 py-2.5 text-left">
                  <MoneyText value={totals.totalCredit} strong />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

export default JournalDetail;
