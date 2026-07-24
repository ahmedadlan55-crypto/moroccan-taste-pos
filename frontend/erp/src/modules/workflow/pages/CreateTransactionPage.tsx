import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  Paperclip,
  Save,
  Send,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/app/providers";
import { Can } from "@/shared/permissions";
import { Field, useUnsavedGuard } from "@/shared/forms";
import { useLocalStorage } from "@/shared/hooks";
import {
  AttachmentViewer,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  FileUploader,
  Input,
  Select,
  Stepper,
  useToast,
} from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { formatCurrency } from "@/shared/lib";
import {
  useCreateTransaction,
  useRoutableUsers,
  useTransactionTypes,
  type CreateTransactionInput,
} from "../lib/api";

type Importance = CreateTransactionInput["importance"];
type Secrecy = NonNullable<CreateTransactionInput["contentSecrecy"]>;

interface LocalDraft {
  transactionTypeId: string;
  title: string;
  description: string;
  amount: string;
  importance: Importance;
  scope: "internal" | "external";
  recipientUsername: string;
  dueDate: string;
  contentSecrecy: Secrecy;
  attachmentsSecrecy: Secrecy;
  updatedAt: string;
}

const EMPTY_DRAFT: LocalDraft = {
  transactionTypeId: "",
  title: "",
  description: "",
  amount: "",
  importance: "medium",
  scope: "internal",
  recipientUsername: "",
  dueDate: "",
  contentSecrecy: "normal",
  attachmentsSecrecy: "normal",
  updatedAt: "",
};

const IMPORTANCE_VALUES: Importance[] = ["low", "medium", "high", "critical"];
const SECRECY_VALUES: Secrecy[] = ["normal", "confidential", "secret", "top_secret"];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function isMeaningfulDraft(draft: LocalDraft) {
  return Boolean(
    draft.transactionTypeId ||
      draft.title.trim() ||
      draft.description.trim() ||
      draft.amount ||
      draft.recipientUsername ||
      draft.dueDate,
  );
}

export function CreateTransactionPage() {
  const t = useTx();
  // Reading direction is taken from the document (the i18n provider keeps it in
  // sync) instead of useLang(), so this page still renders in provider-less tests.
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const { user } = useAuth();
  const username = user?.username ?? "";
  const navigate = useNavigate();
  const { toast } = useToast();
  const create = useCreateTransaction();
  const types = useTransactionTypes();
  const recipients = useRoutableUsers(username, true);
  const [draft, setDraft] = useLocalStorage<LocalDraft>(
    `adlan.workflow.new-transaction.${username || "anonymous"}`,
    EMPTY_DRAFT,
  );
  const [step, setStep] = useState(1);
  const [attachment, setAttachment] = useState<{ file: File; dataUrl: string } | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  const steps = useMemo(
    () => [
      t("workflow.create.steps.basic"),
      t("workflow.create.steps.routing"),
      t("workflow.create.steps.content"),
      t("workflow.create.steps.review"),
    ],
    [t],
  );
  const importanceOptions = useMemo(
    () => IMPORTANCE_VALUES.map((value) => ({ value, label: t(`workflow.importance.${value}`) })),
    [t],
  );
  const secrecyOptions = useMemo(
    () => SECRECY_VALUES.map((value) => ({ value, label: t(`workflow.create.secrecyOpt.${value}`) })),
    [t],
  );

  const isDirty = isMeaningfulDraft(draft) || !!attachment;
  useUnsavedGuard(isDirty && !completed);

  const typeOptions = useMemo(
    () => (types.data ?? []).filter((type) => type.isActive !== false).map((type) => ({ value: type.id, label: type.name })),
    [types.data],
  );
  const recipientOptions = useMemo(() => {
    const seen = new Set<string>();
    return (recipients.data?.groups ?? []).flatMap((group) =>
      group.users.flatMap((person) => {
        if (!person.username || seen.has(person.username)) return [];
        seen.add(person.username);
        return [{
          value: person.username,
          label: `${person.fullName || person.username}${person.position ? ` — ${person.position}` : ""}`,
        }];
      }),
    );
  }, [recipients.data]);
  const selectedType = (types.data ?? []).find((type) => type.id === draft.transactionTypeId);
  const selectedRecipient = recipientOptions.find((r) => r.value === draft.recipientUsername);

  // Directional nav arrows follow the reading direction (previous ← / next →).
  const PrevIcon = rtl ? ArrowRight : ArrowLeft;
  const NextIcon = rtl ? ArrowLeft : ArrowRight;

  function update<K extends keyof LocalDraft>(key: K, value: LocalDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value, updatedAt: new Date().toISOString() }));
    setError(null);
  }

  // Returns the offending step + its message (or null), so the step-jump logic
  // never has to parse the translated message text.
  function validateStep(target = step): { step: number; message: string } | null {
    if (target >= 1) {
      if (!draft.transactionTypeId) return { step: 1, message: t("workflow.create.valid.typeRequired") };
      if (draft.title.trim().length < 5) return { step: 1, message: t("workflow.create.valid.subjectMin") };
    }
    if (target >= 2 && draft.scope === "external" && !draft.recipientUsername) {
      return { step: 2, message: t("workflow.create.valid.recipientRequired") };
    }
    if (target >= 3 && draft.description.trim().length < 5) {
      return { step: 3, message: t("workflow.create.valid.descRequired") };
    }
    return null;
  }

  function goNext() {
    const nextError = validateStep(step);
    if (nextError) {
      setError(nextError.message);
      return;
    }
    setStep((value) => Math.min(4, value + 1));
    setError(null);
  }

  async function pickFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setAttachmentBusy(true);
    setError(null);
    try {
      setAttachment({ file, dataUrl: await fileToDataUrl(file) });
    } catch {
      setError(t("workflow.create.valid.attachPrepFailed"));
    } finally {
      setAttachmentBusy(false);
    }
  }

  function submit(saveAsDraft: boolean) {
    const submitError = validateStep(saveAsDraft ? 1 : 3);
    if (submitError) {
      setError(submitError.message);
      setStep(submitError.step);
      return;
    }
    if (!username) {
      setError(t("workflow.create.valid.noUser"));
      return;
    }
    setError(null);
    create.mutate(
      {
        transactionTypeId: draft.transactionTypeId,
        title: draft.title.trim(),
        subject: draft.title.trim(),
        username,
        description: draft.description.trim(),
        contentHtml: draft.description.trim(),
        amount: draft.amount ? Number(draft.amount) : undefined,
        importance: draft.importance,
        scope: draft.scope,
        recipientUsername: draft.recipientUsername || undefined,
        dueDate: draft.dueDate || undefined,
        contentSecrecy: draft.contentSecrecy,
        attachmentsSecrecy: draft.attachmentsSecrecy,
        attachment: attachment?.dataUrl,
        saveAsDraft,
      },
      {
        onSuccess: (result) => {
          if (result.success === false) {
            setError(result.error || t("workflow.create.valid.saveFailed"));
            return;
          }
          setCompleted(true);
          setDraft(EMPTY_DRAFT);
          setAttachment(null);
          toast({
            title: saveAsDraft ? t("workflow.create.toast.draftSaved") : t("workflow.create.toast.sent"),
            description: result.txnNumber ? t("workflow.create.toast.txnNumber", { num: result.txnNumber }) : undefined,
            tone: "success",
          });
          navigate("/workflow/my-requests");
        },
        onError: (reason) => setError(reason instanceof Error ? reason.message : t("workflow.create.valid.saveFailed")),
      },
    );
  }

  return (
    <Can cap="txn.create" showDenied>
      <div className="mx-auto max-w-6xl space-y-5 pb-28">
        <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
              <FileText className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-xl font-extrabold text-slate-950">{t("workflow.create.header")}</h1>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {t("workflow.create.headerSub")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
            <Clock3 className="h-4 w-4 text-teal-600" aria-hidden="true" />
            {draft.updatedAt
              ? t("workflow.create.localSavedAt", { time: new Date(draft.updatedAt).toLocaleTimeString(rtl ? "ar-SA" : "en-US", { hour: "2-digit", minute: "2-digit" }) })
              : t("workflow.create.localAutosave")}
          </div>
        </section>

        <Card>
          <CardBody className="overflow-x-auto">
            <Stepper steps={steps} current={step} />
          </CardBody>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{steps[step - 1]}</CardTitle>
                <p className="mt-1 text-xs font-medium text-slate-500">{t("workflow.create.stepCounter", { step, total: steps.length })}</p>
              </div>
              <Badge tone="info">{t("workflow.create.localDraftBadge")}</Badge>
            </CardHeader>
            <CardBody className="space-y-5">
              {step === 1 && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t("workflow.create.field.type")} required>
                    <Select
                      value={draft.transactionTypeId}
                      onChange={(event) => update("transactionTypeId", event.target.value)}
                      options={typeOptions}
                      placeholder={types.isLoading ? t("workflow.create.typePlaceholderLoading") : t("workflow.create.typePlaceholder")}
                    />
                  </Field>
                  <Field label={t("workflow.create.field.priority")} required>
                    <Select
                      value={draft.importance}
                      onChange={(event) => update("importance", event.target.value as Importance)}
                      options={importanceOptions}
                    />
                  </Field>
                  <Field label={t("workflow.create.field.subject")} required className="md:col-span-2" hint={t("workflow.create.subjectHint")}>
                    <Input
                      value={draft.title}
                      maxLength={300}
                      onChange={(event) => update("title", event.target.value)}
                      placeholder={t("workflow.create.subjectPlaceholder")}
                    />
                  </Field>
                  <Field label={t("workflow.create.field.scope")}>
                    <Select
                      value={draft.scope}
                      onChange={(event) => update("scope", event.target.value as LocalDraft["scope"])}
                      options={[
                        { value: "internal", label: t("workflow.create.scopeInternal") },
                        { value: "external", label: t("workflow.create.scopeExternal") },
                      ]}
                    />
                  </Field>
                  <Field label={t("workflow.create.field.amount")} hint={t("workflow.create.amountHint")}>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      dir="ltr"
                      value={draft.amount}
                      onChange={(event) => update("amount", event.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-5">
                  <div className="rounded-xl border border-teal-100 bg-teal-50 p-4 text-sm font-medium leading-6 text-teal-900">
                    {t("workflow.create.routingNote")}
                  </div>
                  <Field label={t("workflow.create.field.recipient")} required={draft.scope === "external"} hint={t("workflow.create.recipientHint")}>
                    <Select
                      value={draft.recipientUsername}
                      onChange={(event) => update("recipientUsername", event.target.value)}
                      options={recipientOptions}
                      placeholder={recipients.isLoading ? t("workflow.create.recipientLoading") : t("workflow.create.recipientAuto")}
                    />
                  </Field>
                  <Field label={t("workflow.create.field.dueDate")}>
                    <Input type="date" value={draft.dueDate} onChange={(event) => update("dueDate", event.target.value)} />
                  </Field>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  <Field label={t("workflow.create.descLabel")} required hint={t("workflow.create.descHint")}>
                    <textarea
                      className="field min-h-40 resize-y py-3"
                      maxLength={10000}
                      value={draft.description}
                      onChange={(event) => update("description", event.target.value)}
                      placeholder={t("workflow.create.descPlaceholder")}
                    />
                  </Field>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label={t("workflow.create.contentSecrecyLabel")}>
                      <Select value={draft.contentSecrecy} onChange={(event) => update("contentSecrecy", event.target.value as Secrecy)} options={secrecyOptions} />
                    </Field>
                    <Field label={t("workflow.create.attachSecrecyLabel")}>
                      <Select value={draft.attachmentsSecrecy} onChange={(event) => update("attachmentsSecrecy", event.target.value as Secrecy)} options={secrecyOptions} />
                    </Field>
                  </div>
                  <section aria-labelledby="attachment-heading" className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-teal-600" aria-hidden="true" />
                      <h3 id="attachment-heading" className="text-sm font-extrabold text-slate-800">{t("workflow.create.attachHeading")}</h3>
                      <Badge tone="neutral">{t("workflow.create.attachBadge")}</Badge>
                    </div>
                    {!attachment && (
                      <FileUploader
                        onFiles={pickFiles}
                        multiple={false}
                        disabled={attachmentBusy}
                        maxSize={1_500_000}
                        onReject={() => setError(t("workflow.create.attachReject"))}
                        hint={t("workflow.create.attachHint")}
                      />
                    )}
                    <AttachmentViewer
                      attachments={attachment ? [{ id: "new", name: attachment.file.name, size: attachment.file.size }] : []}
                      onRemove={attachment ? () => setAttachment(null) : undefined}
                      emptyText={t("workflow.create.attachEmpty")}
                    />
                    <p className="text-[11px] font-medium text-slate-400">{t("workflow.create.attachNote")}</p>
                  </section>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />
                    <div>
                      <div className="text-sm font-extrabold text-emerald-900">{t("workflow.create.review.ready")}</div>
                      <div className="mt-1 text-xs font-medium text-emerald-700">{t("workflow.create.review.readySub")}</div>
                    </div>
                  </div>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <ReviewRow label={t("workflow.create.field.type")} value={selectedType?.name || "—"} />
                    <ReviewRow label={t("workflow.create.field.priority")} value={importanceOptions.find((option) => option.value === draft.importance)?.label || "—"} />
                    <ReviewRow label={t("workflow.create.review.subject")} value={draft.title || "—"} wide />
                    <ReviewRow label={t("workflow.create.field.recipient")} value={selectedRecipient?.label || t("workflow.create.review.recipientAuto")} />
                    <ReviewRow label={t("workflow.create.field.dueDate")} value={draft.dueDate || t("workflow.create.review.dueUnset")} />
                    <ReviewRow label={t("workflow.create.field.amount")} value={draft.amount ? formatCurrency(Number(draft.amount)) : t("workflow.create.review.amountUnset")} />
                    <ReviewRow label={t("workflow.create.review.attachment")} value={attachment?.file.name || t("workflow.create.review.attachmentNone")} />
                    <ReviewRow label={t("workflow.create.review.description")} value={draft.description || "—"} wide />
                  </dl>
                </div>
              )}

              {error && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
                  {error}
                </div>
              )}
            </CardBody>
          </Card>

          <aside className="space-y-4 xl:sticky xl:top-5 xl:self-start">
            <Card>
              <CardBody className="space-y-4">
                <div className="flex items-center gap-2 text-sm font-extrabold text-slate-800">
                  <ShieldCheck className="h-5 w-5 text-teal-600" aria-hidden="true" />
                  {t("workflow.create.preview.heading")}
                </div>
                <div className="space-y-3 text-xs font-medium text-slate-600">
                  <PreviewLine icon={FileText} label={t("workflow.create.field.type")} value={selectedType?.name || t("workflow.create.preview.typeUnset")} />
                  <PreviewLine icon={UserRound} label={t("workflow.create.field.recipient")} value={selectedRecipient?.label || t("workflow.create.preview.recipientByPath")} />
                  <PreviewLine icon={Clock3} label={t("workflow.create.field.dueDate")} value={draft.dueDate || t("workflow.create.preview.dueUnset")} />
                </div>
              </CardBody>
            </Card>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-medium leading-5 text-slate-500">
              {t("workflow.create.localGuard")}
            </div>
          </aside>
        </div>

        {/* Below `lg` this bar is fixed to the viewport bottom, where the shell's
            MobileNav dock (z-40, lg:hidden) also floats — lift it above the dock so
            a real tap reaches the action buttons. On lg+ it becomes `static` (flows
            in the content) and the bottom offset is moot. */}
        <div className="fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur lg:static lg:bottom-auto lg:rounded-2xl lg:border lg:shadow-sm">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => (step === 1 ? navigate("/workflow/my-requests") : setStep((value) => value - 1))}>
              <PrevIcon className="h-4 w-4" aria-hidden="true" />
              {step === 1 ? t("common.cancel") : t("workflow.create.prev")}
            </Button>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => submit(true)} loading={create.isPending}>
                <Save className="h-4 w-4" aria-hidden="true" /> {t("workflow.create.saveDraft")}
              </Button>
              {step < 4 ? (
                <Button variant="primary" onClick={goNext}>
                  {t("common.next")} <NextIcon className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button variant="primary" onClick={() => submit(false)} loading={create.isPending}>
                  <Send className="h-4 w-4" aria-hidden="true" /> {t("workflow.create.submit")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Can>
  );
}

function ReviewRow({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[11px] font-bold text-slate-400">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-sm font-bold leading-6 text-slate-800">{value}</dd>
    </div>
  );
}

function PreviewLine({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-400">{label}</div>
        <div className="mt-0.5 break-words font-bold text-slate-700">{value}</div>
      </div>
    </div>
  );
}
