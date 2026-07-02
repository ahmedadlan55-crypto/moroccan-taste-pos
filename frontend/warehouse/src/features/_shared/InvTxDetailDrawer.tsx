import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, CheckCircle2, Send, Ban, Undo2, Trash2, Printer, FileText } from "lucide-react";
import { Drawer, DetailStat } from "@/components/drawer/Drawer";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { useCan } from "@/app/permission-provider";
import { useAuth } from "@/app/auth-provider";
import { formatCurrency, formatNumber, formatQty, formatDate } from "@/lib/formatters";
import { invTxStatusToLabel } from "@/lib/status-labels";
import { useInvTxDetail, useInvTxMutations } from "@/lib/hooks/useInventoryTx";
import type { InvTxConfig } from "./invtxConfig";
import type { InvTxDetail } from "@/lib/adapters/invtx.adapter";
import { ReasonDialog } from "./ReasonDialog";
import { printInvTx } from "./printInvTx";

const ACTION_LABEL: Record<string, string> = {
  create: "إنشاء", edit: "تعديل", approve: "اعتماد", post: "ترحيل", cancel: "إلغاء", reverse: "عكس", delete: "حذف",
};

export function InvTxDetailDrawer({ config, id, onClose }: { config: InvTxConfig; id: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const detailQ = useInvTxDetail(config.docType, id);
  const m = useInvTxMutations(config.docType);
  const canApprove = useCan(config.perms.approve);
  const canPost = useCan(config.perms.post);
  const canCreate = useCan(config.perms.create);
  const canReverse = useCan(config.perms.reverse);
  const [dialog, setDialog] = useState<null | "cancel" | "reverse">(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const d = detailQ.data;
  const pending = m.approve.isPending || m.post.isPending || m.cancel.isPending || m.reverse.isPending || m.remove.isPending;

  function handleErr(e: unknown) {
    if (e instanceof ApiError) setActionErr(e.isConflict ? "تغيّرت البيانات منذ آخر تحميل — أُعيد التحميل، حاول مجددًا." : e.message);
    else setActionErr("تعذّر تنفيذ الإجراء.");
    detailQ.refetch();
  }
  function run(p: Promise<unknown>) { setActionErr(null); p.then(() => setDialog(null)).catch(handleErr); }

  // Maker–Checker UI hint: the creator can't approve their own adjustment.
  const isCreator = !!d && !!user && d.actors.createdBy === user.username;
  const makerChecker = config.docType === "adjustment" && isCreator && user?.role !== "admin" && !user?.isDeveloper;

  return (
    <Drawer open={!!id} onClose={onClose} title={d?.number ?? "مستند"} eyebrow={config.title} icon={config.icon}>
      {detailQ.isLoading ? (
        <LoadingState rows={3} />
      ) : detailQ.isError ? (
        <ErrorState error={detailQ.error} onRetry={() => detailQ.refetch()} />
      ) : !d ? null : (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-2">
            <StatusBadge>{invTxStatusToLabel(d.status)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">الإصدار {formatNumber(d.version)}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <DetailStat label="المستودع" value={d.warehouse.name || d.warehouse.id} />
            <DetailStat label="التاريخ" value={formatDate(d.date)} />
            <DetailStat label="القيمة" value={formatCurrency(d.totalValue)} />
            <DetailStat label="عدد الأصناف" value={formatNumber(d.lines.length)} />
            {d.reason && <DetailStat label="السبب" value={d.reason} />}
            {d.sourceRef && <DetailStat label="المرجع" value={d.sourceRef} />}
            {d.recipient && <DetailStat label="الجهة المستلِمة" value={d.recipient} />}
            {d.referenceEvidence && <DetailStat label="إثبات" value={d.referenceEvidence} />}
          </div>

          {actionErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{actionErr}</p>}
          {makerChecker && d.status === "draft" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">لا يمكنك اعتماد تعديل أنشأته بنفسك (Maker–Checker) — يعتمده مسؤول آخر.</p>
          )}

          {/* Lines */}
          <Section title="الأصناف" icon={FileText}>
            <LineTable d={d} mode={config.lineMode} />
          </Section>

          {/* Timeline */}
          <Section title="سجل التدقيق">
            <ol className="space-y-2">
              {d.timeline.length === 0 && <li className="text-xs text-slate-400">لا أحداث.</li>}
              {d.timeline.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                  <div>
                    <span className="font-extrabold text-slate-700">{ACTION_LABEL[e.action] ?? e.action}</span>
                    <span className="text-slate-400"> · {e.actor || "—"} · {formatDate(e.at)}</span>
                    {e.note && <div className="text-slate-500">{e.note}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          {/* Movements + GL */}
          {(d.movements.length > 0 || d.journals.length > 0) && (
            <Section title="الحركات والقيود">
              {d.movements.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-slate-400"><tr><th className="py-1 text-right">النوع</th><th className="text-right">الكمية</th><th className="text-right">السبب</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.movements.map((mv) => (
                      <tr key={mv.id}><td className="py-1 font-bold">{mv.type === "in" ? "وارد" : "صادر"}</td><td className="tabular-nums">{formatQty(mv.qty)}</td><td className="text-slate-500">{mv.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              {d.journals.map((j) => (
                <div key={j.id} className="mt-2 rounded-lg border border-slate-100 p-2">
                  <div className="flex justify-between text-xs font-bold text-slate-600"><span>{j.number}</span><span className="tabular-nums">{formatCurrency(j.totalDebit)}</span></div>
                  <table className="mt-1 w-full text-[11px]">
                    <tbody>
                      {j.entries.map((en, i) => (
                        <tr key={i}><td className="text-slate-500">{en.accountName || en.accountCode}</td><td className="text-left tabular-nums text-emerald-700">{en.debit ? formatCurrency(en.debit) : ""}</td><td className="text-left tabular-nums text-rose-700">{en.credit ? formatCurrency(en.credit) : ""}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Section>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <Button variant="secondary" onClick={() => printInvTx(config, d)}><Printer className="h-4 w-4" /> طباعة</Button>
            {d.status === "draft" && canCreate && (
              <Button variant="secondary" onClick={() => navigate(`${config.routeBase}/new?edit=${d.id}`)}><Pencil className="h-4 w-4" /> تعديل</Button>
            )}
            {d.status === "draft" && canApprove && !makerChecker && (
              <Button variant="primary" disabled={pending} onClick={() => run(m.approve.mutateAsync({ id: d.id, expectedVersion: d.version }))}><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>
            )}
            {d.status === "approved" && canPost && (
              <Button variant="primary" disabled={pending} onClick={() => run(m.post.mutateAsync({ id: d.id, expectedVersion: d.version }))}><Send className="h-4 w-4" /> ترحيل</Button>
            )}
            {(d.status === "draft" || d.status === "approved") && canApprove && (
              <Button variant="ghost" disabled={pending} onClick={() => { setActionErr(null); setDialog("cancel"); }}><Ban className="h-4 w-4" /> إلغاء</Button>
            )}
            {d.status === "draft" && canApprove && (
              <Button variant="ghost" disabled={pending} onClick={() => { if (confirm("حذف هذه المسودة نهائيًا؟")) run(m.remove.mutateAsync({ id: d.id })); }}><Trash2 className="h-4 w-4" /> حذف</Button>
            )}
            {d.status === "posted" && canReverse && (
              <Button variant="danger" disabled={pending} onClick={() => { setActionErr(null); setDialog("reverse"); }}><Undo2 className="h-4 w-4" /> عكس</Button>
            )}
          </div>
        </div>
      )}

      <ReasonDialog
        open={dialog === "cancel"}
        title="إلغاء المستند"
        description="يُلغى المستند قبل الترحيل دون أي أثر على المخزون."
        confirmLabel="تأكيد الإلغاء"
        pending={m.cancel.isPending}
        error={null}
        onConfirm={(reason) => d && run(m.cancel.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reverse"}
        title="عكس المستند"
        description="يعكس أثر المخزون والقيد المحاسبي بالتكلفة الأصلية المجمّدة وقت الترحيل."
        confirmLabel="تأكيد العكس"
        pending={m.reverse.isPending}
        error={null}
        onConfirm={(reason) => d && run(m.reverse.mutateAsync({ id: d.id, reason, expectedVersion: d.version }))}
        onClose={() => setDialog(null)}
      />
    </Drawer>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon?: typeof FileText; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-slate-500">{Icon && <Icon className="h-3.5 w-3.5" />}{title}</h3>
      {children}
    </section>
  );
}

function LineTable({ d, mode }: { d: InvTxDetail; mode: InvTxConfig["lineMode"] }) {
  if (mode === "adjustment") {
    return (
      <table className="w-full text-xs">
        <thead className="text-slate-400"><tr><th className="py-1 text-right">الصنف</th><th className="text-center">النظام</th><th className="text-center">المجرود</th><th className="text-center">الفرق</th><th className="text-left">القيمة</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td className="py-1.5 font-bold text-slate-700">{l.item.name}</td>
              <td className="text-center tabular-nums text-slate-500">{formatQty(l.systemQtySnapshot)}</td>
              <td className="text-center tabular-nums text-slate-700">{formatQty(l.countedQty)}</td>
              <td className={`text-center font-bold tabular-nums ${l.delta < 0 ? "text-rose-600" : l.delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{l.delta > 0 ? "+" : ""}{formatQty(l.delta)}</td>
              <td className="text-left tabular-nums text-slate-700">{formatCurrency(l.deltaValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-slate-400"><tr><th className="py-1 text-right">الصنف</th><th className="text-center">الكمية</th><th className="text-center">التكلفة</th><th className="text-left">الإجمالي</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {d.lines.map((l) => (
          <tr key={l.id}>
            <td className="py-1.5 font-bold text-slate-700">{l.item.name}</td>
            <td className="text-center tabular-nums text-slate-700">{formatQty(l.qty)} {l.item.unit}</td>
            <td className="text-center tabular-nums text-slate-500">{formatCurrency(l.unitCost)}</td>
            <td className="text-left tabular-nums text-slate-700">{formatCurrency(l.lineTotal)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
