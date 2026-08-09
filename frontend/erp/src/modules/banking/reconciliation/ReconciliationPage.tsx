import { useMemo, useState } from "react";
import { Plus, ArrowRight, ArrowLeft, Wand2, Lock, Unlink, Scale } from "lucide-react";
import {
  Button,
  IconButton,
  Dialog,
  ConfirmDialog,
  Input,
  DatePicker,
  Select,
  StatusBadge,
  Card,
  LoadingState,
  ErrorState,
  EmptyState,
  PageHeader,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useCan } from "@/app/providers";
import { formatDate } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import {
  useBankStatements,
  useStatementDetail,
  useCreateStatement,
  useAutoMatch,
  useMatchLine,
  useUnmatchLine,
  useAdjustLine,
  useCloseStatement,
  useBankAccounts,
  useCoaAccounts,
  todayISO,
  type BankStatement,
  type StatementLine,
} from "../api";

const MANAGE = "banking.reconciliation.manage" as const;
const CLOSE = "banking.reconciliation.close" as const;

function money(n: number) {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function Money({ value }: { value: number }) {
  const n = Number(value) || 0;
  const tone = Math.abs(n) < 0.005 ? "text-slate-400" : n > 0 ? "text-emerald-600" : "text-rose-600";
  return <span dir="ltr" className={`tabular-nums font-semibold ${tone}`}>{money(n)}</span>;
}

export function ReconciliationPage() {
  const [selected, setSelected] = useState<string | null>(null);
  if (selected) return <StatementDetailView id={selected} onBack={() => setSelected(null)} />;
  return <StatementList onOpen={setSelected} />;
}

// ── Master list ──────────────────────────────────────────────────────────────
function StatementList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const canManage = useCan(MANAGE);
  const list = useBankStatements();
  const [creating, setCreating] = useState(false);
  const rows = list.data ?? [];
  const statusLabel = (status: string) => (status === "closed" ? t("banking.reconciliation.closed") : t("status.draft"));

  const columns: ColumnDef<BankStatement>[] = [
    { id: "bank", header: t("banking.shared.bank"), accessor: (r) => r.bankName || r.bankAccountId },
    { id: "period", header: t("banking.reconciliation.cols.period"), accessor: (r) => `${r.periodFrom ? formatDate(r.periodFrom) : "—"} → ${r.periodTo ? formatDate(r.periodTo) : "—"}` },
    { id: "closing", header: t("banking.reconciliation.cols.closingBalance"), accessor: (r) => r.closingBalance, cell: (r) => <Money value={r.closingBalance} />, numeric: true },
    { id: "lines", header: t("banking.reconciliation.cols.lines"), accessor: (r) => r.lineCount, numeric: true },
    { id: "unmatched", header: t("banking.reconciliation.unmatched"), accessor: (r) => r.unmatchedCount, numeric: true },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => statusLabel(r.status),
      cell: (r) => <StatusBadge tone={r.status === "closed" ? "success" : "neutral"}>{statusLabel(r.status)}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("banking.shared.eyebrow")}
        title={t("banking.reconciliation.title")}
        subtitle={t("banking.reconciliation.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> {t("banking.reconciliation.newBtn")}
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        emptyTitle={t("banking.reconciliation.emptyTitle")}
        emptyBody={t("banking.reconciliation.emptyBody")}
        onRowClick={(r) => onOpen(r.id)}
      />
      {creating && <CreateStatementDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </div>
  );
}

function CreateStatementDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const banks = useBankAccounts();
  const create = useCreateStatement();
  const { toast } = useToast();
  const [bankAccountId, setBankAccountId] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState(todayISO());
  const [opening] = useState("0");
  const [closing, setClosing] = useState("0");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<string | null>(null);

  // CSV: one line per row "date,description,reference,amount".
  const parsed = useMemo(() => {
    return csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(",");
        return {
          lineDate: (parts[0] || "").trim() || undefined,
          description: (parts[1] || "").trim(),
          reference: (parts[2] || "").trim(),
          amount: Number((parts[3] || "").trim()) || 0,
        };
      });
  }, [csv]);

  function submit() {
    if (!bankAccountId) { setError(t("banking.reconciliation.form.selectBank")); return; }
    if (!parsed.length) { setError(t("banking.reconciliation.form.linesRequired")); return; }
    setError(null);
    create.mutate(
      { bankAccountId, periodFrom: periodFrom || undefined, periodTo: periodTo || undefined, openingBalance: Number(opening) || 0, closingBalance: Number(closing) || 0, lines: parsed },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || t("banking.shared.createFailed")); return; }
          toast({ tone: "success", title: t("banking.reconciliation.toast.created") });
          if (res.id) onCreated(res.id);
        },
        onError: (e) => setError(e instanceof Error ? e.message : t("banking.shared.createFailed")),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("banking.reconciliation.dialogTitle")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>{t("banking.shared.create")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("banking.reconciliation.fields.bankAccount")} required>
            <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">{t("banking.shared.selectPlaceholder")}</option>
              {(banks.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.bankName}{b.accountNumber ? ` — ${b.accountNumber}` : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("banking.reconciliation.fields.closingBalance")}><Input value={closing} dir="ltr" onChange={(e) => setClosing(e.target.value)} /></Field>
          <Field label={t("banking.shared.dateFrom")}><DatePicker value={periodFrom} onChange={setPeriodFrom} /></Field>
          <Field label={t("banking.shared.dateTo")}><DatePicker value={periodTo} onChange={setPeriodTo} /></Field>
        </div>
        <Field label={t("banking.reconciliation.fields.linesLabel")}>
          <textarea
            className="field min-h-40 w-full resize-y py-2 font-mono text-xs"
            dir="ltr"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"2026-02-05,Deposit,REF1,500\n2026-02-10,Bank fee,REF2,-20"}
          />
        </Field>
        <p className="text-xs font-bold text-slate-400">{t("banking.reconciliation.parsedCount", { count: parsed.length })}</p>
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

// ── Detail (statement lines vs book) ─────────────────────────────────────────
function StatementDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const lang = useLang();
  const BackIcon = lang === "ar" ? ArrowRight : ArrowLeft;
  const canManage = useCan(MANAGE);
  const canClose = useCan(CLOSE);
  const detail = useStatementDetail(id);
  const autoMatch = useAutoMatch();
  const match = useMatchLine();
  const unmatch = useUnmatchLine();
  const close = useCloseStatement();
  const { toast } = useToast();
  const [adjustLine, setAdjustLine] = useState<StatementLine | null>(null);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  if (detail.isLoading) return <LoadingState />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  const { statement, lines, book } = detail.data;
  const isClosed = statement.status === "closed";
  const freeBook = book.filter((b) => !b.matched);

  function doClose(reason: string) {
    void reason;
    setCloseErr(null);
    close.mutate(id, {
      onSuccess: (res) => {
        if (res && res.success === false) { setCloseErr(res.error || t("banking.reconciliation.closeFailed")); return; }
        toast({ tone: "success", title: t("banking.reconciliation.toast.closed") });
        setConfirmClose(false);
      },
      onError: (e) => setCloseErr(e instanceof Error ? e.message : t("banking.reconciliation.closeFailed")),
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" onClick={onBack}><BackIcon className="h-4 w-4" /> {t("common.back")}</Button>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={isClosed ? "success" : "neutral"}>{isClosed ? t("banking.reconciliation.closed") : t("status.draft")}</StatusBadge>
          {canManage && !isClosed && (
            <Button variant="secondary" onClick={() =>
              autoMatch.mutate(id, { onSuccess: (r) => toast({ tone: "success", title: t("banking.reconciliation.autoMatchResult", { matched: r.matched, remaining: r.remaining }) }) })
            } loading={autoMatch.isPending}>
              <Wand2 className="h-4 w-4" /> {t("banking.reconciliation.autoMatch")}
            </Button>
          )}
          {canClose && !isClosed && (
            <Button variant="primary" onClick={() => { setCloseErr(null); setConfirmClose(true); }}>
              <Lock className="h-4 w-4" /> {t("banking.reconciliation.closeTitle")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Statement lines */}
        <Card>
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-800">{t("banking.reconciliation.statementLines")}</div>
          <div className="divide-y divide-slate-50">
            {lines.length === 0 && <div className="p-6"><EmptyState title={t("banking.reconciliation.noLines")} /></div>}
            {lines.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-slate-800">{l.description || "—"}</div>
                  <div className="text-[11px] font-medium text-slate-400">
                    {l.lineDate ? formatDate(l.lineDate) : "—"} {l.reference ? `· ${l.reference}` : ""}
                  </div>
                </div>
                <Money value={l.amount} />
                {l.matchStatus === "unmatched" ? (
                  <StatusBadge tone="warning">{t("banking.reconciliation.unmatched")}</StatusBadge>
                ) : (
                  <StatusBadge tone="success">{l.matchStatus === "adjusted" ? t("banking.reconciliation.adjust") : t("banking.reconciliation.matched")}</StatusBadge>
                )}
                {canManage && !isClosed && l.matchStatus === "unmatched" && (
                  <>
                    <MatchControl line={l} freeBook={freeBook} onMatch={(glEntryId) =>
                      match.mutate({ lineId: l.id, glEntryId }, { onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : t("banking.reconciliation.matchFailed") }) })
                    } />
                    <IconButton aria-label={t("banking.reconciliation.adjust")} size="sm" onClick={() => setAdjustLine(l)}><Scale className="h-4 w-4" /></IconButton>
                  </>
                )}
                {canManage && !isClosed && l.matchStatus === "matched" && (
                  <IconButton aria-label={t("banking.reconciliation.unmatchAria")} size="sm" onClick={() => unmatch.mutate(l.id)}><Unlink className="h-4 w-4" /></IconButton>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Book movements */}
        <Card>
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-800">{t("banking.reconciliation.bookMovements")}</div>
          <div className="divide-y divide-slate-50">
            {book.length === 0 && <div className="p-6"><EmptyState title={t("banking.reconciliation.noMovements")} body={t("banking.reconciliation.noMovementsBody")} /></div>}
            {book.map((b) => (
              <div key={b.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-slate-800">{b.description || "—"}</div>
                  <div className="text-[11px] font-medium text-slate-400" dir="ltr">{formatDate(b.date)} · {b.journalNumber}</div>
                </div>
                <Money value={b.amount} />
                {b.matched && <StatusBadge tone="success">{t("banking.reconciliation.matched")}</StatusBadge>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {adjustLine && (
        <AdjustDialog statementId={id} line={adjustLine} onClose={() => setAdjustLine(null)} />
      )}
      <ConfirmDialog
        open={confirmClose}
        title={t("banking.reconciliation.closeTitle")}
        description={t("banking.reconciliation.closeDesc")}
        confirmLabel={t("banking.reconciliation.closeShort")}
        processing={close.isPending}
        error={closeErr}
        onConfirm={doClose}
        onClose={() => setConfirmClose(false)}
      />
    </div>
  );
}

function MatchControl({ line, freeBook, onMatch }: { line: StatementLine; freeBook: { id: string; amount: number; journalNumber: string }[]; onMatch: (glEntryId: string) => void }) {
  const t = useT();
  const [val, setVal] = useState("");
  // Suggest book entries with the same amount first.
  const sorted = [...freeBook].sort((a, b) => Math.abs(a.amount - line.amount) - Math.abs(b.amount - line.amount));
  return (
    <Select value={val} onChange={(e) => { const v = e.target.value; setVal(""); if (v) onMatch(v); }} className="max-w-40">
      <option value="">{t("banking.reconciliation.matchWith")}</option>
      {sorted.map((b) => (
        <option key={b.id} value={b.id}>{b.journalNumber} ({b.amount.toFixed(2)})</option>
      ))}
    </Select>
  );
}

function AdjustDialog({ statementId, line, onClose }: { statementId: string; line: StatementLine; onClose: () => void }) {
  const t = useT();
  const adjust = useAdjustLine();
  const coa = useCoaAccounts(true);
  const { toast } = useToast();
  const [contra, setContra] = useState("");
  const [kind, setKind] = useState<"fee" | "interest">(line.amount < 0 ? "fee" : "interest");
  const [amount, setAmount] = useState(String(Math.abs(line.amount || 0)));
  const [error, setError] = useState<string | null>(null);
  const leaves = (coa.data ?? []).filter((a) => a.isLeaf);

  function submit() {
    if (!contra) { setError(t("banking.reconciliation.adjustDialog.selectContra")); return; }
    const amt = Number(amount) || 0;
    if (amt <= 0) { setError(t("banking.reconciliation.adjustDialog.amountInvalid")); return; }
    setError(null);
    adjust.mutate(
      { statementId, lineId: line.id, contraAccountId: contra, kind, amount: amt, description: line.description },
      {
        onSuccess: (res) => {
          if (res && res.success === false) { setError(res.error || t("banking.reconciliation.adjustDialog.failed")); return; }
          toast({ tone: "success", title: t("banking.reconciliation.adjustDialog.posted") });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : t("banking.reconciliation.adjustDialog.failed")),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("banking.reconciliation.adjustDialog.title")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={adjust.isPending}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} loading={adjust.isPending}>{t("banking.reconciliation.adjustDialog.postBtn")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("banking.shared.type")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "fee" | "interest")}>
            <option value="fee">{t("banking.reconciliation.adjustDialog.fee")}</option>
            <option value="interest">{t("banking.reconciliation.adjustDialog.interest")}</option>
          </Select>
        </Field>
        <Field label={t("banking.reconciliation.adjustDialog.contraAccount")} required>
          <Select value={contra} onChange={(e) => setContra(e.target.value)}>
            <option value="">{t("banking.shared.selectAccount")}</option>
            {leaves.map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("banking.shared.amount")} required>
          <Input value={amount} dir="ltr" onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}
      </div>
    </Dialog>
  );
}

export default ReconciliationPage;
