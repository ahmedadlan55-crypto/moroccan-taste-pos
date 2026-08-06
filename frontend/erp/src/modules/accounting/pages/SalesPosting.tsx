// ── «ترحيل المبيعات» — the screen ───────────────────────────────────────────
//
// The owner's complaint: «كل عملية بيع ترحل بقيد وهذا ليس جيدا». Sales now
// enqueue an economic event; here a human picks a granularity, reads the exact
// journal that would be written, and posts one aggregated entry.
//
// THE GRANULARITY SELECTOR RESLICES THE SAME QUEUE. There are not three
// queues — the server regroups one list — and EVERY row expands to its
// invoices in all three modes. That was the owner's non-negotiable:
// «مع رؤية التفصيل في كل الحالات».
//
// Nothing here recomputes a total. The server sends `legs` already balanced,
// and the posted tab renders `legs_json` as it was written rather than
// re-deriving it, so what is reviewed is what actually hit the ledger even
// after accounts are later renamed.

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, RotateCcw, CheckCircle2 } from "lucide-react";
import { Button, PageHeader, Card, Badge, DatePicker, Spinner } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import { formatCurrency, formatDate } from "@/shared/lib";
import {
  usePendingBatches, usePostedBatches, useHealth, usePostBatch, useReverseBatch,
  GRANULARITIES, type Granularity, type PlannedBatch, type Filters,
} from "../salesPosting/api";

const GRAN_LABEL: Record<Granularity, string> = {
  daily: "يومي",
  monthly: "شهري",
  invoice: "فاتورة بفاتورة",
};

type Tab = "pending" | "posted" | "problems";

export function SalesPostingPage() {
  const t = useT();
  const canPost = useCan("finance.gl.post");
  const [tab, setTab] = useState<Tab>("pending");
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const [filters, setFilters] = useState<Filters>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const pending = usePendingBatches(granularity, filters);
  const posted = usePostedBatches(filters);
  const health = useHealth();
  const postMut = usePostBatch();
  const reverseMut = useReverseBatch();

  const problems = health.data?.problems ?? [];
  const blocking = problems.filter((p) => p.severity !== "warning");

  return (
    <div className="space-y-4">
      {/* The heading is the part of this screen the bilingual sweep inspects as
          "chrome", and it was a hardcoded Arabic literal — so an English user
          saw Arabic here. The rest of this file is still hardcoded Arabic;
          translating it fully is its own task, not this one. */}
      <PageHeader
        title={t("accounting.salesPosting.title")}
        subtitle={t("accounting.salesPosting.subtitle")}
      />

      {/* The compensating control for deferred posting: this banner is the only
          thing that turns a quiet, delayed failure back into a visible one. */}
      {blocking.length > 0 && (
        <Card className="border-red-500/40 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div className="space-y-1">
              <p className="font-semibold text-red-600 dark:text-red-400">
                {blocking.length} مشكلة تمنع الترحيل
              </p>
              {blocking.map((p, i) => (
                <p key={i} className="text-sm text-muted-foreground">{p.message}</p>
              ))}
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["pending", "posted", "problems"] as Tab[]).map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "secondary"} size="sm" onClick={() => setTab(t)}>
            {t === "pending" ? "معلّق" : t === "posted" ? "الدفعات المرحَّلة" : "مشاكل"}
            {t === "problems" && problems.length > 0 && (
              <Badge tone={blocking.length ? "danger" : "neutral"} className="ms-2">
                {problems.length}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      {/* Filters apply to every tab — the same window of trade throughout. */}
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">من</span>
          <DatePicker className="w-44"
            value={filters.from ?? ""} onChange={(v) => setFilters({ ...filters, from: v })} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">إلى</span>
          <DatePicker className="w-44"
            value={filters.to ?? ""} onChange={(v) => setFilters({ ...filters, to: v })} />
        </label>
        {tab === "pending" && (
          <div className="text-sm">
            <span className="mb-1 block text-muted-foreground">الحُبيبة</span>
            <div className="flex rounded border">
              {GRANULARITIES.map((g) => (
                <button key={g} type="button"
                  className={"px-3 py-1 text-sm " + (granularity === g ? "bg-primary text-primary-foreground" : "")}
                  onClick={() => setGranularity(g)}>
                  {GRAN_LABEL[g]}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {tab === "pending" && (
        <PendingTab
          loading={pending.isLoading}
          batches={pending.data?.batches ?? []}
          totals={pending.data?.totals}
          open={open} setOpen={setOpen}
          canPost={canPost}
          posting={postMut.isPending}
          onPost={(b) => postMut.mutate({ granularity, bucketKey: b.key, ...filters })}
        />
      )}

      {tab === "posted" && (
        <PostedTab
          loading={posted.isLoading}
          batches={posted.data?.batches ?? []}
          canPost={canPost}
          reversing={reverseMut.isPending}
          onReverse={(id, reason) => reverseMut.mutate({ batchId: id, reason })}
        />
      )}

      {tab === "problems" && (
        <Card className="p-4">
          {health.isLoading ? <Spinner /> : problems.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="h-4 w-4" /> لا مشاكل — كل بيعة لها صف في الطابور والحسابات موجودة
            </p>
          ) : (
            <ul className="space-y-2">
              {problems.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Badge tone={p.severity === "warning" ? "warning" : "danger"}>
                    {p.severity === "critical" ? "حرج" : p.severity === "blocking" ? "مانع" : "تنبيه"}
                  </Badge>
                  <span>{p.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function PendingTab({ loading, batches, totals, open, setOpen, canPost, posting, onPost }: {
  loading: boolean; batches: PlannedBatch[];
  totals?: { batches: number; items: number; net: number; tax: number; gross: number; blocked: number };
  open: Record<string, boolean>; setOpen: (v: Record<string, boolean>) => void;
  canPost: boolean; posting: boolean; onPost: (b: PlannedBatch) => void;
}) {
  if (loading) return <Card className="p-8 text-center"><Spinner /></Card>;
  if (!batches.length) {
    return <Card className="p-8 text-center text-muted-foreground">
      لا توجد مبيعات معلّقة في هذا المدى — كل شيء مُرحَّل
    </Card>;
  }

  return (
    <div className="space-y-3">
      {totals && (
        <Card className="grid grid-cols-2 gap-3 p-3 text-sm sm:grid-cols-5">
          <Stat label="دفعات" value={String(totals.batches)} />
          <Stat label="عمليات" value={String(totals.items)} />
          <Stat label="الصافي" value={formatCurrency(totals.net)} />
          <Stat label="الضريبة" value={formatCurrency(totals.tax)} />
          <Stat label="الإجمالي" value={formatCurrency(totals.gross)} />
        </Card>
      )}

      {batches.map((b) => {
        const isOpen = !!open[b.key];
        return (
          <Card key={b.key} className={b.postable ? "" : "border-amber-500/40"}>
            <div className="flex flex-wrap items-center gap-3 p-3">
              <button type="button" className="flex items-center gap-2 text-start"
                onClick={() => setOpen({ ...open, [b.key]: !isOpen })}>
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                <span className="font-semibold">{b.label}</span>
              </button>
              <Badge tone="neutral">{b.itemCount} عملية</Badge>
              {b.returnCount > 0 && (
                // Sales and returns stay two numbers, never one netted figure —
                // otherwise a slow day and a heavy-refund day look identical.
                <Badge tone="neutral">{b.salesCount} بيع · {b.returnCount} مرتجع</Badge>
              )}
              <span className="text-sm text-muted-foreground">تاريخ القيد {formatDate(b.journalDate)}</span>
              <span className="ms-auto font-mono text-sm">{formatCurrency(b.gross)}</span>
              {b.postable ? (
                canPost && (
                  <Button size="sm" disabled={posting} onClick={() => onPost(b)}>ترحيل</Button>
                )
              ) : (
                <Badge tone="danger">غير قابل للترحيل</Badge>
              )}
            </div>

            {!b.postable && (
              <div className="border-t px-3 py-2 text-sm text-amber-600">
                {b.warnings.join(" · ")}
              </div>
            )}

            {isOpen && (
              <div className="space-y-4 border-t p-3">
                {/* The journal, before it is written. Mandatory reading: this is
                    what turns a broken chart of accounts from a silent posting
                    failure into something visible first. */}
                <section>
                  <h4 className="mb-2 text-sm font-semibold">القيد المقترح</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[28rem] text-sm">
                      <thead className="text-muted-foreground">
                        <tr><th className="p-1 text-start">الحساب</th>
                          <th className="p-1 text-end">مدين</th><th className="p-1 text-end">دائن</th></tr>
                      </thead>
                      <tbody>
                        {b.legs.map((l, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-1 font-mono">{l.accountCode}</td>
                            <td className="p-1 text-end font-mono">{l.debit ? formatCurrency(l.debit) : "—"}</td>
                            <td className="p-1 text-end font-mono">{l.credit ? formatCurrency(l.credit) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 font-semibold">
                        <tr>
                          <td className="p-1">الإجمالي</td>
                          <td className="p-1 text-end font-mono">
                            {formatCurrency(b.legs.reduce((s, l) => s + l.debit, 0))}</td>
                          <td className="p-1 text-end font-mono">
                            {formatCurrency(b.legs.reduce((s, l) => s + l.credit, 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </section>

                {/* The detail, in every granularity — the owner's condition. */}
                <section>
                  <h4 className="mb-2 text-sm font-semibold">الفواتير ({b.sources.length})</h4>
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full min-w-[24rem] text-sm">
                      <tbody>
                        {b.sources.map((s) => (
                          <tr key={s.id} className="border-t">
                            <td className="p-1">
                              {s.type !== "sale" && <Badge tone="neutral" className="me-2">مرتجع</Badge>}
                              {s.invoiceNumber || s.sourceId}
                            </td>
                            <td className="p-1 text-end font-mono">{formatCurrency(s.gross)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function PostedTab({ loading, batches, canPost, reversing, onReverse }: {
  loading: boolean; batches: ReturnType<typeof usePostedBatches>["data"] extends undefined ? never[] : NonNullable<ReturnType<typeof usePostedBatches>["data"]>["batches"];
  canPost: boolean; reversing: boolean; onReverse: (id: string, reason: string) => void;
}) {
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (loading) return <Card className="p-8 text-center"><Spinner /></Card>;
  if (!batches.length) {
    return <Card className="p-8 text-center text-muted-foreground">لا توجد دفعات مُرحَّلة بعد</Card>;
  }

  return (
    <div className="space-y-2">
      {batches.map((b) => (
        <Card key={b.id} className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-sm">{b.journal_number || b.id}</span>
            <Badge tone="neutral">{GRAN_LABEL[b.granularity]}</Badge>
            <span className="text-sm">{b.bucket_key}</span>
            <span className="text-sm text-muted-foreground">{formatDate(b.journal_date)}</span>
            <Badge tone="neutral">{b.item_count} عملية</Badge>
            <span className="ms-auto font-mono text-sm">{formatCurrency(Number(b.gross_amount))}</span>
            {b.status === "reversed" ? (
              <Badge tone="neutral">معكوسة</Badge>
            ) : canPost && (
              <Button size="sm" variant="secondary" disabled={reversing}
                onClick={() => { setReasonFor(b.id); setReason(""); }}>
                <RotateCcw className="me-1 h-3 w-3" /> عكس
              </Button>
            )}
          </div>

          {b.status === "reversed" && b.reverse_reason && (
            <p className="mt-2 text-sm text-muted-foreground">سبب العكس: {b.reverse_reason}</p>
          )}

          {reasonFor === b.id && (
            <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
              <label className="flex-1 text-sm">
                <span className="mb-1 block text-muted-foreground">سبب العكس (يُسجَّل في القيد)</span>
                <input className="w-full rounded border bg-background px-2 py-1"
                  value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <Button size="sm" disabled={reason.trim().length < 5 || reversing}
                onClick={() => { onReverse(b.id, reason.trim()); setReasonFor(null); }}>
                تأكيد العكس
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReasonFor(null)}>إلغاء</Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono font-semibold">{value}</div>
    </div>
  );
}
