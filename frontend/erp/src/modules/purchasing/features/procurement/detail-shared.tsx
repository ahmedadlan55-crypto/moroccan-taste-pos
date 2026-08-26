// Shared building blocks for procurement detail screens: back link, header with
// print, status stepper, key/value grid, section wrapper, timeline panel, GL
// journal panel, attachments panel, action bar, and A4 print styles.
import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Printer, Clock, Landmark, Paperclip } from "lucide-react";
import { PanelTitle } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState } from "@/shared/ui";
import { formatCurrency, formatDateTime } from "@/shared/lib";
import { cn } from "@/shared/lib";
import { useTimeline, useGLJournal, type TimelineEvent } from "@/modules/inventory/lib/hooks/useProcurement";
import { useT, translateApiError } from "@/i18n";
import { st, act } from "./labels";

export function BackLink({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="text-sm font-bold text-teal-700 hover:underline print:hidden">← {label}</Link>;
}

export function PrintButton() {
  const t = useT();
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer className="h-4 w-4" /> {t("purchasing.detail.print")}
    </Button>
  );
}

export function DetailHeader({ eyebrow, title, subtitle, status, actions }: { eyebrow: string; title: string; subtitle?: string; status?: string; actions?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="text-xs font-extrabold uppercase tracking-wide text-teal-700">{eyebrow}</div>
        <h1 className="mt-0.5 text-2xl font-extrabold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-medium text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {status && <StatusBadge>{st(t, status)}</StatusBadge>}
        <PrintButton />
        {actions}
      </div>
    </div>
  );
}

export function Section({ icon: Icon, title, subtitle, action, children }: { icon?: React.ComponentType<{ className?: string }>; title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="surface overflow-hidden print:border print:shadow-none">
      <PanelTitle icon={Icon} title={title} subtitle={subtitle} action={action} />
      {children}
    </section>
  );
}

export function KV({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((it, i) => (
        <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
          <div className="text-[10px] font-extrabold uppercase text-slate-400">{it.label}</div>
          <div className="mt-0.5 text-sm font-bold text-slate-800">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

export function StatusStepper({ steps, current }: { steps: Array<{ key: string; label: string }>; current: string }) {
  const t = useT();
  const idx = steps.findIndex((s) => s.key === current);
  const cancelled = current === "cancelled" || current === "reversed";
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 py-4">
      {steps.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={cn(
              "flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-bold",
              cancelled ? "bg-slate-100 text-slate-400" : done ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-400",
            )}>
              <span className="grid h-4 w-4 place-items-center rounded-full bg-white/20 text-[10px]">{i + 1}</span>
              {s.label}
            </span>
            {i < steps.length - 1 && <span className={cn("h-0.5 w-4", done && !cancelled ? "bg-teal-400" : "bg-slate-200")} />}
          </div>
        );
      })}
      {cancelled && <span className="ml-2 rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-600">{st(t, current)}</span>}
    </div>
  );
}

export function TimelinePanel({ entity, id }: { entity: string; id: string }) {
  const t = useT();
  const { data, isLoading } = useTimeline(entity, id);
  return (
    <Section icon={Clock} title={t("purchasing.detail.timelineTitle")}>
      {isLoading ? <div className="p-5"><LoadingState rows={2} /></div> : !data || data.length === 0 ? (
        <div className="p-5 text-sm text-slate-400">{t("purchasing.detail.timelineEmpty")}</div>
      ) : (
        <ol className="divide-y divide-slate-100">
          {data.map((e: TimelineEvent) => (
            <li key={e.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="font-bold text-slate-700">
                {act(t, e.action)}
                {e.from_status && e.to_status && <span className="text-slate-400"> · {st(t, e.from_status)} → {st(t, e.to_status)}</span>}
              </span>
              <span className="flex items-center gap-3 text-[11px] text-slate-400">
                {e.actor && <span className="font-semibold">{e.actor}</span>}
                {e.gl_journal_id && <span className="rounded bg-violet-50 px-1.5 py-0.5 font-bold text-violet-600">{t("purchasing.detail.journalChip")}</span>}
                <span className="tabular-nums">{formatDateTime(e.created_at)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

export function GLPanel({ journalId }: { journalId: string | null | undefined }) {
  const t = useT();
  const { data, isLoading } = useGLJournal(journalId || null);
  if (!journalId) return null;
  return (
    <Section icon={Landmark} title={t("purchasing.detail.journalTitle")} subtitle={data ? `${data.journal_number}` : undefined}>
      {isLoading || !data ? <div className="p-5"><LoadingState rows={2} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr>
              <th className="px-3 py-2 text-start text-[11px] font-extrabold text-slate-400">{t("purchasing.detail.account")}</th>
              <th className="px-3 py-2 text-end text-[11px] font-extrabold text-slate-400">{t("purchasing.detail.debit")}</th>
              <th className="px-3 py-2 text-end text-[11px] font-extrabold text-slate-400">{t("purchasing.detail.credit")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.entries.map((e, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 text-sm text-slate-700"><span className="tabular-nums text-slate-400">{e.account_code}</span> {e.account_name}</td>
                  <td className="px-3 py-2 text-end text-sm font-bold tabular-nums text-slate-800">{Number(e.debit) ? formatCurrency(Number(e.debit)) : "—"}</td>
                  <td className="px-3 py-2 text-end text-sm font-bold tabular-nums text-slate-800">{Number(e.credit) ? formatCurrency(Number(e.credit)) : "—"}</td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-extrabold">
                <td className="px-3 py-2 text-sm text-slate-500">{t("purchasing.col.total")}</td>
                <td className="px-3 py-2 text-end text-sm tabular-nums text-teal-700">{formatCurrency(Number(data.total_debit))}</td>
                <td className="px-3 py-2 text-end text-sm tabular-nums text-teal-700">{formatCurrency(Number(data.total_credit))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function AttachmentsPanel({ attachments }: { attachments?: string | null }) {
  const t = useT();
  let list: Array<{ name?: string; url?: string }> = [];
  if (attachments) { try { const p = JSON.parse(attachments); if (Array.isArray(p)) list = p; } catch { /* ignore */ } }
  return (
    <Section icon={Paperclip} title={t("purchasing.detail.attachmentsTitle")}>
      {list.length === 0 ? (
        <div className="p-5 text-sm text-slate-400">{t("purchasing.detail.attachmentsEmpty")}</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((a, i) => (
            <li key={i} className="flex items-center gap-2 px-5 py-3 text-sm">
              <Paperclip className="h-4 w-4 text-slate-400" />
              {a.url ? <a href={a.url} className="font-bold text-teal-700 hover:underline" target="_blank" rel="noreferrer">{a.name || a.url}</a> : <span className="font-semibold text-slate-700">{a.name || t("purchasing.detail.attachment")}</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 print:hidden">{translateApiError(error, t)}</p>;
}
