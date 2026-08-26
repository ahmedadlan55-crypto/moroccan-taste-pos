// ── JournalEditor — create / edit a journal, or view a posted one ────────────
// RULE 1: a posted journal is immutable → render the read-only <JournalDetail>
//   with a "create a reversing entry" path instead of editable inputs.
// RULE 2: live debit/credit totals + balance indicator recomputed every change.
// RULE 3: save is blocked (Arabic message) unless the entry is well-formed.
// RULE 4: revenue/expense lines require a cost center (line or inherited header).

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  AttachmentViewer,
  Button,
  ConfirmDialog,
  DatePicker,
  FileUploader,
  Input,
  Select,
  Toggle,
  useToast,
  type Attachment,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import {
  todayISO,
  useBranches,
  useBrands,
  useCostCenters,
  useCreateJournal,
  usePostJournal,
  useProjects,
  useReverseJournal,
  useUpdateJournal,
  type Journal,
  type JournalInput,
  type JournalLine,
} from "../api";
import { JournalDetail } from "./JournalDetail";
import { JournalLineRow, type CostCenterOption } from "./JournalLineRow";
import {
  MoneyText,
  computeTotals,
  emptyLine,
  fmtMoney,
  lineHasAccount,
  mapJournalError,
  validateJournal,
} from "./journalModel";

const CREATE_CAP = "accounting.journals.create" as const;
const POST_CAP = "accounting.journals.post" as const;
const REVERSE_CAP = "accounting.journals.reverse" as const;

const MAX_ATTACHMENT = 4 * 1024 * 1024; // ~4MB, rides inline in the payload

export interface JournalEditorProps {
  journal: Journal | null;
  onDone: () => void;
}

// Seed the line array from an existing journal, or start with two blank lines.
function seedLines(journal: Journal | null): JournalLine[] {
  if (journal && journal.entries.length > 0) {
    return journal.entries.map((e) => ({ ...e }));
  }
  return [emptyLine(), emptyLine()];
}

export function JournalEditor({ journal, onDone }: JournalEditorProps) {
  const t = useT();
  const canCreate = useCan(CREATE_CAP);
  const canPost = useCan(POST_CAP);
  const canReverse = useCan(REVERSE_CAP);

  const isPosted = !!journal && journal.status === "posted";

  // ── RULE 1: posted journals are read-only ──────────────────────────────────
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const reverse = useReverseJournal();
  const { toast } = useToast();

  function confirmReverse(reason: string) {
    if (!journal) return;
    setReverseError(null);
    reverse.mutate(
      { id: journal.id, reason: reason || undefined },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            setReverseError(mapJournalError(t, res.error));
            return;
          }
          toast({
            tone: "success",
            title: t("accounting.journal.toast.reversed"),
            description: res.newJournalNumber ? t("accounting.journal.toast.reversedDesc", { number: res.newJournalNumber }) : undefined,
          });
          setReverseOpen(false);
          onDone();
        },
        onError: (e) => setReverseError(mapJournalError(t, e instanceof Error ? e.message : "")),
      },
    );
  }

  if (isPosted && journal) {
    return (
      <div>
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          {t("accounting.journal.editor.postedBanner")}
        </div>
        <JournalDetail
          journal={journal}
          onBack={onDone}
          onReverse={canReverse && !journal.reversedByJournalId ? () => setReverseOpen(true) : undefined}
        />
        <ConfirmDialog
          open={reverseOpen}
          title={t("accounting.journal.editor.reverseTitle")}
          description={t("accounting.journal.editor.reverseDesc")}
          tone="danger"
          confirmLabel={t("accounting.journal.editor.reverseConfirm")}
          requireReason
          reasonLabel={t("accounting.journal.editor.reverseReason")}
          processing={reverse.isPending}
          error={reverseError}
          onConfirm={confirmReverse}
          onClose={() => setReverseOpen(false)}
        />
      </div>
    );
  }

  return <JournalForm journal={journal} onDone={onDone} canCreate={canCreate} canPost={canPost} />;
}

// ── The editable form (draft / approved) ─────────────────────────────────────
interface JournalFormProps {
  journal: Journal | null;
  onDone: () => void;
  canCreate: boolean;
  canPost: boolean;
}

function JournalForm({ journal, onDone, canCreate, canPost }: JournalFormProps) {
  const t = useT();
  const { toast } = useToast();

  // Header state
  const [journalDate, setJournalDate] = useState(journal?.journalDate?.slice(0, 10) || todayISO());
  const [description, setDescription] = useState(journal?.description ?? "");
  const [notes, setNotes] = useState(journal?.notes ?? "");
  const [isOpening, setIsOpening] = useState(journal?.referenceType === "opening");
  const [brandId, setBrandId] = useState<string>(journal?.brandId ?? "");
  const [branchId, setBranchId] = useState<string>(journal?.branchId ?? "");
  const [projectId, setProjectId] = useState<string>(journal?.projectId ?? "");
  const [costCenterId, setCostCenterId] = useState<string>(journal?.costCenterId ?? "");

  // Lines state
  const [lines, setLines] = useState<JournalLine[]>(() => seedLines(journal));

  // Attachment (base64 data URL, rides inline in the payload)
  const [attachment, setAttachment] = useState<string | null>(journal?.attachment ?? null);
  const [attachmentName, setAttachmentName] = useState<string>(journal?.attachment ? t("accounting.journal.attachmentDefault") : "");

  const [formError, setFormError] = useState<string | null>(null);

  // Lookups (all optional; inherited by lines server-side)
  const brands = useBrands();
  const branches = useBranches();
  const projects = useProjects("");
  const costCenters = useCostCenters("");

  const costCenterOptions: CostCenterOption[] = useMemo(
    () =>
      (costCenters.data ?? [])
        .filter((c) => c.isActive !== false)
        .map((c) => ({ id: c.id, label: c.code ? `${c.code} — ${c.nameAr}` : c.nameAr })),
    [costCenters.data],
  );

  // RULE 2 — live totals
  const totals = useMemo(() => computeTotals(lines), [lines]);

  // Mutations
  const createJournal = useCreateJournal();
  const updateJournal = useUpdateJournal();
  const postJournal = usePostJournal();
  const busy = createJournal.isPending || updateJournal.isPending || postJournal.isPending;

  function patchLine(index: number, next: JournalLine) {
    setLines((prev) => prev.map((l, i) => (i === index ? next : l)));
  }
  function removeLine(index: number) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function onFile(files: File[]) {
    const file = files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachment(typeof reader.result === "string" ? reader.result : null);
      setAttachmentName(file.name);
    };
    reader.onerror = () => toast({ tone: "error", title: t("accounting.journal.editor.fileReadError") });
    reader.readAsDataURL(file);
  }

  function buildInput(): JournalInput {
    const ccName = costCenterOptions.find((c) => c.id === costCenterId)?.label;
    return {
      journalDate,
      referenceType: isOpening ? "opening" : "manual",
      isOpening,
      description: description.trim(),
      notes: notes.trim() || undefined,
      attachment,
      brandId: brandId || null,
      branchId: branchId || null,
      projectId: projectId || null,
      costCenterId: costCenterId || null,
      costCenterName: ccName,
      entries: lines.filter(lineHasAccount).map((l) => ({
        accountId: l.accountId,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        description: l.description?.trim() || undefined,
        costCenterId: l.costCenterId || undefined,
        costCenterName: l.costCenterName || undefined,
      })),
    };
  }

  // RULE 3 — validate, then create (POST) or update (PUT). Returns the id.
  async function persist(): Promise<string | null> {
    const error = validateJournal({
      description,
      lines,
      headerCostCenterId: costCenterId || null,
    });
    if (error) {
      setFormError(error);
      toast({ tone: "error", title: error });
      return null;
    }
    setFormError(null);
    const input = buildInput();
    try {
      if (journal?.id) {
        const res = await updateJournal.mutateAsync({ id: journal.id, input });
        if (res && res.success === false) throw new Error(res.error || "");
        return journal.id;
      }
      const res = await createJournal.mutateAsync(input);
      if (res && res.success === false) throw new Error(res.error || "");
      return res.id;
    } catch (e) {
      const msg = mapJournalError(t, e instanceof Error ? e.message : "");
      setFormError(msg);
      toast({ tone: "error", title: msg });
      return null;
    }
  }

  async function onSaveDraft() {
    const id = await persist();
    if (!id) return;
    toast({ tone: "success", title: journal?.id ? t("accounting.journal.toast.updated") : t("accounting.journal.toast.savedDraft") });
    onDone();
  }

  async function onSaveAndPost() {
    const id = await persist();
    if (!id) return;
    try {
      await postJournal.mutateAsync({ id, status: "draft" });
      toast({ tone: "success", title: t("accounting.journal.toast.savedAndPosted") });
      onDone();
    } catch (e) {
      const msg = mapJournalError(t, e instanceof Error ? e.message : "");
      setFormError(msg);
      toast({ tone: "error", title: msg });
    }
  }

  const attachmentList: Attachment[] = attachment
    ? [{ id: "att", name: attachmentName || t("accounting.journal.attachmentDefault"), url: attachment }]
    : [];

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div className="surface p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("accounting.journal.editor.date")} required>
            <DatePicker value={journalDate} onChange={setJournalDate} />
          </Field>
          <Field label={t("accounting.journal.editor.description")} required className="sm:col-span-2">
            <Input
              value={description}
              onChange={(e) => {
                setFormError(null);
                setDescription(e.target.value);
              }}
              placeholder={t("accounting.journal.editor.descPlaceholder")}
            />
          </Field>
          <Field label={t("accounting.journal.editor.descEn")}>
            <Input value={notes} dir="ltr" onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <Field label={t("accounting.journal.editor.brand")}>
            <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">{t("accounting.journal.editor.optAll")}</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("accounting.journal.editor.branch")}>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("accounting.journal.editor.optAll")}</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("accounting.journal.editor.project")}>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("accounting.journal.editor.optNone")}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code ? `${p.code} — ${p.nameAr}` : p.nameAr}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("accounting.journal.editor.costCenter")}>
            <Select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
              <option value="">{t("accounting.journal.editor.optNone")}</option>
              {costCenterOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>

          <label className="flex items-center gap-3 self-end pb-2">
            <Toggle checked={isOpening} onChange={setIsOpening} />
            <span className="text-sm font-bold text-slate-700">{t("accounting.journal.editor.opening")}</span>
          </label>
        </div>
      </div>

      {/* Lines card */}
      <div className="surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <h3 className="text-base font-extrabold text-slate-900">{t("accounting.journal.editor.lines")}</h3>
          <Button variant="secondary" onClick={addLine}>
            <Plus className="h-4 w-4" /> {t("accounting.journal.editor.addLine")}
          </Button>
        </div>

        <div className="overflow-x-auto px-2">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
                <th className="px-2 py-2 text-start">{t("accounting.common.account")}</th>
                <th className="px-2 py-2 text-end">{t("accounting.common.debit")}</th>
                <th className="px-2 py-2 text-end">{t("accounting.common.credit")}</th>
                <th className="px-2 py-2 text-start">{t("accounting.common.statement")}</th>
                <th className="px-2 py-2 text-start">{t("accounting.journal.editor.costCenterCol")}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <JournalLineRow
                  key={i}
                  value={line}
                  onChange={(next) => patchLine(i, next)}
                  onRemove={() => removeLine(i)}
                  costCenters={costCenterOptions}
                />
              ))}
            </tbody>
            {/* RULE 2 — totals + balance footer */}
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 text-xs font-extrabold">
                <td className="px-3 py-2.5 text-start">{t("accounting.common.total")}</td>
                <td className="px-3 py-2.5 text-end">
                  <MoneyText value={totals.totalDebit} strong />
                </td>
                <td className="px-3 py-2.5 text-end">
                  <MoneyText value={totals.totalCredit} strong />
                </td>
                <td className="px-3 py-2.5" colSpan={3}>
                  {totals.balanced ? (
                    <span className="font-extrabold text-emerald-600">{t("accounting.journal.editor.balanced")}</span>
                  ) : (
                    <span className="font-extrabold text-rose-600">
                      {t("accounting.journal.editor.unbalancedPrefix")} <span dir="ltr" className="tabular-nums">{fmtMoney(totals.diff)}</span>
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Attachment */}
      <div className="surface p-5">
        <h3 className="mb-3 text-base font-extrabold text-slate-900">{t("accounting.journal.editor.attachment")}</h3>
        {attachmentList.length > 0 ? (
          <AttachmentViewer
            attachments={attachmentList}
            onRemove={() => {
              setAttachment(null);
              setAttachmentName("");
            }}
          />
        ) : (
          <FileUploader
            onFiles={onFile}
            accept="image/*,application/pdf"
            maxSize={MAX_ATTACHMENT}
            onReject={(reason) => toast({ tone: "error", title: reason })}
            hint={t("accounting.journal.editor.attachmentHint")}
          />
        )}
      </div>

      {/* Inline error */}
      {formError && (
        <div className="surface border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          {formError}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          {t("common.cancel")}
        </Button>
        {canCreate && (
          <Button variant="secondary" onClick={onSaveDraft} loading={busy}>
            {t("common.save")}
          </Button>
        )}
        {canPost && (
          <Button variant="primary" onClick={onSaveAndPost} loading={busy}>
            {t("accounting.journal.editor.saveAndPost")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default JournalEditor;
