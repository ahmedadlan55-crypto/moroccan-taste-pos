// ── «ترحيل المبيعات» — the screen ───────────────────────────────────────────
//
// The owner's complaint: «كل عملية بيع ترحل بقيد وهذا ليس جيدا». Sales now
// enqueue an economic event; here a human picks a granularity, reads the exact
// journal that would be written, and posts one aggregated entry.
//
// THE GRANULARITY SELECTOR RESLICES THE SAME QUEUE. There are not two
// queues — the server regroups one list — and EVERY row expands to its
// invoices in both modes. That was the owner's non-negotiable:
// «مع رؤية التفصيل في كل الحالات».
//
// Nothing here recomputes a total. The server sends `legs` already balanced,
// and the posted tab renders `legs_json` as it was written rather than
// re-deriving it, so what is reviewed is what actually hit the ledger even
// after accounts are later renamed.

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, CheckCircle2 } from "lucide-react";
import { Button, PageHeader, Card, Badge, DatePicker, ErrorState, Input, SegmentedControl, Spinner } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { translateApiError, useLang, useT, type TFunction } from "@/i18n";
import { formatCurrency, formatDate } from "@/shared/lib";
import { Pagination } from "@/shared/tables";
import {
  usePendingBatches, usePostedBatches, useHealth, usePostBatch, useReverseBatch,
  GRANULARITIES, type Granularity, type PlannedBatch, type PostedBatch, type Filters, type HealthProblem,
} from "../salesPosting/api";

type Tab = "pending" | "posted" | "problems";

function postingWarningMessage(warning: string, t: TFunction) {
  const split = /^PAYMENT_SPLIT_MISSING:\s+(\S+)\s+(.+)$/.exec(warning);
  if (split) return t("accounting.salesPosting.warnings.paymentSplitMissing", { sourceType: split[1], sourceId: split[2] });
  const mismatch = /^PAYMENT_MISMATCH:\s+payments\s+([\d.-]+)\s+vs\s+net\+tax\s+([\d.-]+)\s+—\s+(\d+)\s+row\(s\)$/.exec(warning);
  if (mismatch) return t("accounting.salesPosting.warnings.paymentMismatch", { payments: mismatch[1], expected: mismatch[2], count: mismatch[3] });
  const code = warning.split(":", 1)[0] || "UNKNOWN";
  return t("accounting.salesPosting.warnings.unknown", { code });
}

function healthProblemMessage(problem: HealthProblem, t: TFunction) {
  switch (problem.code) {
    case "UNQUEUED_SALES": return t("accounting.salesPosting.problems.unqueuedSales", { count: problem.count ?? 0 });
    case "BATCH_BLOCKED": return t("accounting.salesPosting.problems.batchBlocked", {
      bucket: problem.bucket ?? "—",
      details: (problem.warnings ?? []).map((warning) => postingWarningMessage(warning, t)).join(" · ") || t("accounting.salesPosting.warnings.unknown", { code: "BATCH_BLOCKED" }),
    });
    case "MISSING_ACCOUNT": return t("accounting.salesPosting.problems.missingAccount", { account: problem.account ?? "—" });
    case "FAILED_ROWS": return t("accounting.salesPosting.problems.failedRows", { count: problem.count ?? 0 });
    case "STUCK_CLAIMS": return t("accounting.salesPosting.problems.stuckClaims", { count: problem.count ?? 0 });
    default: return problem.message;
  }
}

export function SalesPostingPage() {
  const t = useT();
  const canPost = useCan("finance.gl.post");
  const canReverse = useCan("finance.gl.reverse");
  const [tab, setTab] = useState<Tab>("pending");
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const [filters, setFilters] = useState<Filters>({});
  const [postedPage, setPostedPage] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const pending = usePendingBatches(granularity, filters);
  const posted = usePostedBatches(filters, postedPage, 25);
  const health = useHealth();
  const postMut = usePostBatch();
  const reverseMut = useReverseBatch();

  const problems = health.data?.problems ?? [];
  const blocking = problems.filter((p) => p.severity !== "warning");
  const mutationError = postMut.error ?? reverseMut.error;

  return (
    <div className="space-y-4">
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
                {t("accounting.salesPosting.blockingSummary", { count: blocking.length })}
              </p>
              {blocking.map((p, i) => (
                <p key={i} className="text-sm text-muted-foreground">{healthProblemMessage(p, t)}</p>
              ))}
            </div>
          </div>
        </Card>
      )}

      <SegmentedControl<Tab>
        aria-label={t("accounting.salesPosting.title")}
        className="w-full sm:w-auto [&>button]:min-w-0 [&>button]:flex-1 sm:[&>button]:flex-none"
        value={tab}
        onChange={setTab}
        options={[
          { value: "pending", label: t("accounting.salesPosting.tabs.pending") },
          { value: "posted", label: t("accounting.salesPosting.tabs.posted") },
          {
            value: "problems",
            label: (
              <span className="inline-flex items-center gap-2">
                {t("accounting.salesPosting.tabs.problems")}
                {problems.length > 0 && (
                  <Badge tone={blocking.length ? "danger" : "neutral"}>{problems.length}</Badge>
                )}
              </span>
            ),
          },
        ]}
      />

      {mutationError && (
        <Card className="border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700" role="alert">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{translateApiError(mutationError, t)}</span>
          </div>
        </Card>
      )}

      {/* Filters apply to every tab — the same window of trade throughout. */}
      <Card className="grid grid-cols-1 items-end gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(11rem,13rem)_minmax(11rem,13rem)_minmax(14rem,1fr)]">
        <label className="min-w-0 text-sm">
          <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("accounting.salesPosting.filters.from")}</span>
          <DatePicker className="w-full"
            value={filters.from ?? ""} onChange={(v) => { setPostedPage(1); setFilters({ ...filters, from: v }); }} />
        </label>
        <label className="min-w-0 text-sm">
          <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("accounting.salesPosting.filters.to")}</span>
          <DatePicker className="w-full"
            value={filters.to ?? ""} onChange={(v) => { setPostedPage(1); setFilters({ ...filters, to: v }); }} />
        </label>
        {tab === "pending" && (
          <div className="min-w-0 text-sm sm:col-span-2 lg:col-span-1">
            <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("accounting.salesPosting.filters.granularity")}</span>
            <SegmentedControl<Granularity>
              aria-label={t("accounting.salesPosting.filters.granularity")}
              className="w-full sm:w-auto [&>button]:flex-1"
              value={granularity}
              onChange={setGranularity}
              options={GRANULARITIES.map((value) => ({
                value,
                label: t(`accounting.salesPosting.granularity.${value}`),
              }))}
            />
          </div>
        )}
      </Card>

      {tab === "pending" && (
        pending.isError ? <ErrorState error={pending.error} onRetry={() => void pending.refetch()} /> : <PendingTab
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
        posted.isError ? <ErrorState error={posted.error} onRetry={() => void posted.refetch()} /> : <PostedTab
          loading={posted.isLoading}
          batches={posted.data?.batches ?? []}
          canReverse={canReverse}
          reversing={reverseMut.isPending}
          pagination={posted.data?.pagination}
          onPageChange={setPostedPage}
          onReverse={(id, reason, onSuccess) => reverseMut.mutate({ batchId: id, reason }, { onSuccess })}
        />
      )}

      {tab === "problems" && (
        <Card className="p-4">
          {health.isError ? <ErrorState error={health.error} onRetry={() => void health.refetch()} /> : health.isLoading ? <Spinner /> : problems.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> {t("accounting.salesPosting.healthOk")}
            </p>
          ) : (
            <ul className="space-y-2">
              {problems.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Badge tone={p.severity === "warning" ? "warning" : "danger"}>
                    {t(`accounting.salesPosting.severity.${p.severity}`)}
                  </Badge>
                  <span>{healthProblemMessage(p, t)}</span>
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
  const t = useT();
  const lang = useLang();
  if (loading) return <Card className="p-8 text-center"><Spinner /></Card>;
  if (!batches.length) {
    return <Card className="p-8 text-center text-muted-foreground">
      {t("accounting.salesPosting.pendingEmpty")}
    </Card>;
  }

  return (
    <div className="space-y-3">
      {totals && (
        <Card className="grid grid-cols-1 gap-3 p-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
          <Stat label={t("accounting.salesPosting.totals.batches")} value={String(totals.batches)} />
          <Stat label={t("accounting.salesPosting.totals.operations")} value={String(totals.items)} />
          <Stat label={t("accounting.salesPosting.totals.net")} value={formatCurrency(totals.net)} />
          <Stat label={t("accounting.salesPosting.totals.tax")} value={formatCurrency(totals.tax)} />
          <Stat label={t("accounting.salesPosting.totals.gross")} value={formatCurrency(totals.gross)} />
        </Card>
      )}

      {batches.map((b) => {
        const isOpen = !!open[b.key];
        return (
          <Card key={b.key} className={b.postable ? "" : "border-amber-500/40"}>
            <div className="flex flex-wrap items-center gap-3 p-3">
              <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-start focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 sm:flex-none"
                aria-expanded={isOpen}
                onClick={() => setOpen({ ...open, [b.key]: !isOpen })}>
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : lang === "ar" ? <ChevronLeft className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className="truncate font-semibold">{b.label}</span>
              </button>
              <Badge tone="neutral">{t("accounting.salesPosting.operationCount", { count: b.itemCount })}</Badge>
              {b.returnCount > 0 && (
                // Sales and returns stay two numbers, never one netted figure —
                // otherwise a slow day and a heavy-refund day look identical.
                <Badge tone="neutral">{t("accounting.salesPosting.salesReturnsCount", { sales: b.salesCount, returns: b.returnCount })}</Badge>
              )}
              <span className="w-full text-sm text-muted-foreground sm:w-auto">{t("accounting.salesPosting.journalDate", { date: formatDate(b.journalDate) })}</span>
              <span className="w-full font-mono text-sm sm:ms-auto sm:w-auto">{formatCurrency(b.gross)}</span>
              {b.postable ? (
                canPost && (
                  <Button className="w-full sm:w-auto" size="sm" disabled={posting} onClick={() => onPost(b)}>{t("accounting.salesPosting.post")}</Button>
                )
              ) : (
                <Badge tone="danger">{t("accounting.salesPosting.notPostable")}</Badge>
              )}
            </div>

            {!b.postable && (
              <div className="border-t px-3 py-2 text-sm text-amber-600">
                {b.warnings.map((warning) => postingWarningMessage(warning, t)).join(" · ")}
              </div>
            )}

            {isOpen && (
              <div className="space-y-4 border-t p-3">
                {/* The journal, before it is written. Mandatory reading: this is
                    what turns a broken chart of accounts from a silent posting
                    failure into something visible first. */}
                <section>
                  <h4 className="mb-2 text-sm font-semibold">{t("accounting.salesPosting.proposedJournal")}</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[22rem] text-sm sm:min-w-[28rem]">
                      <thead className="text-muted-foreground">
                        <tr><th className="p-1 text-start">{t("accounting.salesPosting.columns.account")}</th>
                          <th className="p-1 text-end">{t("accounting.salesPosting.columns.debit")}</th><th className="p-1 text-end">{t("accounting.salesPosting.columns.credit")}</th></tr>
                      </thead>
                      <tbody>
                        {b.legs.map((l, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-1 font-mono" dir="ltr">{l.accountCode}</td>
                            <td className="p-1 text-end font-mono">{l.debit ? formatCurrency(l.debit) : "—"}</td>
                            <td className="p-1 text-end font-mono">{l.credit ? formatCurrency(l.credit) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 font-semibold">
                        <tr>
                          <td className="p-1">{t("accounting.salesPosting.columns.total")}</td>
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
                  <h4 className="mb-2 text-sm font-semibold">{t("accounting.salesPosting.invoicesTitle", { count: b.sources.length })}</h4>
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full min-w-[20rem] text-sm sm:min-w-[24rem]">
                      <tbody>
                        {b.sources.map((s) => (
                          <tr key={s.id} className="border-t">
                            <td className="p-1">
                              {s.type !== "sale" && <Badge tone="neutral" className="me-2">{t("accounting.salesPosting.returnLabel")}</Badge>}
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

function PostedTab({ loading, batches, canReverse, reversing, pagination, onPageChange, onReverse }: {
  loading: boolean; batches: PostedBatch[];
  canReverse: boolean; reversing: boolean;
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
  onPageChange: (page: number) => void;
  onReverse: (id: string, reason: string, onSuccess: () => void) => void;
}) {
  const t = useT();
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (loading) return <Card className="p-8 text-center"><Spinner /></Card>;
  if (!batches.length) {
    return <Card className="p-8 text-center text-muted-foreground">{t("accounting.salesPosting.postedEmpty")}</Card>;
  }

  return (
    <div className="space-y-2">
      {batches.map((b) => (
        <Card key={b.id} className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-sm" dir="ltr">{b.journal_number || b.id}</span>
            <Badge tone="neutral">{t(`accounting.salesPosting.granularity.${b.granularity}`)}</Badge>
            <span className="text-sm" dir="ltr">{b.bucket_key}</span>
            <span className="text-sm text-muted-foreground">{formatDate(b.journal_date)}</span>
            <Badge tone="neutral">{t("accounting.salesPosting.operationCount", { count: b.item_count })}</Badge>
            <span className="w-full font-mono text-sm sm:ms-auto sm:w-auto">{formatCurrency(Number(b.gross_amount))}</span>
            {b.status === "reversed" ? (
              <Badge tone="neutral">{t("accounting.salesPosting.reversed")}</Badge>
            ) : canReverse && (
              <Button className="w-full sm:w-auto" size="sm" variant="secondary" disabled={reversing}
                onClick={() => { setReasonFor(b.id); setReason(""); }}>
                <RotateCcw className="me-1 h-4 w-4" /> {t("accounting.salesPosting.reverse")}
              </Button>
            )}
          </div>

          {b.status === "reversed" && b.reverse_reason && (
            <p className="mt-2 text-sm text-muted-foreground">{t("accounting.salesPosting.reverseReason", { reason: b.reverse_reason })}</p>
          )}

          {reasonFor === b.id && (
            <div className="mt-3 grid grid-cols-1 items-end gap-2 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label className="min-w-0 text-sm">
                <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("accounting.salesPosting.reverseReasonLabel")}</span>
                <Input aria-label={t("accounting.salesPosting.reverseReasonLabel")}
                  value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <Button className="w-full sm:w-auto" size="sm" disabled={reason.trim().length < 5 || reversing}
                onClick={() => onReverse(b.id, reason.trim(), () => { setReasonFor(null); setReason(""); })}>
                {t("accounting.salesPosting.confirmReverse")}
              </Button>
              <Button className="w-full sm:w-auto" size="sm" variant="ghost" onClick={() => setReasonFor(null)}>{t("common.cancel")}</Button>
            </div>
          )}
        </Card>
      ))}
      {pagination && pagination.total > 0 && (
        <Card className="overflow-hidden">
          <Pagination
            page={pagination.page}
            pageCount={pagination.totalPages}
            total={pagination.total}
            pageSize={pagination.pageSize}
            onPageChange={onPageChange}
          />
        </Card>
      )}
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
