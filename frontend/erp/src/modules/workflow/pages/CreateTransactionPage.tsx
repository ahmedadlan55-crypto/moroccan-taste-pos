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

const STEPS = ["البيانات الأساسية", "التوجيه", "المحتوى والمرفقات", "المراجعة والإرسال"];

const IMPORTANCE_OPTIONS = [
  { value: "low", label: "منخفضة" },
  { value: "medium", label: "متوسطة" },
  { value: "high", label: "عالية" },
  { value: "critical", label: "حرجة" },
];

const SECRECY_OPTIONS = [
  { value: "normal", label: "عادي" },
  { value: "confidential", label: "سري" },
  { value: "secret", label: "سري جدًا" },
  { value: "top_secret", label: "مقيد للغاية" },
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("تعذّر قراءة الملف"));
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

  const isDirty = isMeaningfulDraft(draft) || !!attachment;
  useUnsavedGuard(isDirty && !completed);

  const typeOptions = useMemo(
    () => (types.data ?? []).filter((t) => t.isActive !== false).map((t) => ({ value: t.id, label: t.name })),
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
  const selectedType = (types.data ?? []).find((t) => t.id === draft.transactionTypeId);
  const selectedRecipient = recipientOptions.find((r) => r.value === draft.recipientUsername);

  function update<K extends keyof LocalDraft>(key: K, value: LocalDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value, updatedAt: new Date().toISOString() }));
    setError(null);
  }

  function validateStep(target = step): string | null {
    if (target >= 1) {
      if (!draft.transactionTypeId) return "اختر نوع المعاملة.";
      if (draft.title.trim().length < 5) return "اكتب موضوعًا واضحًا من 5 أحرف على الأقل.";
    }
    if (target >= 2 && draft.scope === "external" && !draft.recipientUsername) {
      return "اختر مستلمًا للمعاملة الخارجية.";
    }
    if (target >= 3 && draft.description.trim().length < 5) {
      return "أضف وصفًا أو محتوى يوضح المطلوب.";
    }
    return null;
  }

  function goNext() {
    const nextError = validateStep(step);
    if (nextError) {
      setError(nextError);
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
      setError("تعذّر تجهيز المرفق. اختر ملفًا آخر.");
    } finally {
      setAttachmentBusy(false);
    }
  }

  function submit(saveAsDraft: boolean) {
    const submitError = validateStep(saveAsDraft ? 1 : 3);
    if (submitError) {
      setError(submitError);
      setStep(submitError.includes("مستلم") ? 2 : submitError.includes("وصف") ? 3 : 1);
      return;
    }
    if (!username) {
      setError("تعذّر تحديد المستخدم الحالي. أعد تسجيل الدخول ثم حاول مرة أخرى.");
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
            setError(result.error || "تعذّر حفظ المعاملة.");
            return;
          }
          setCompleted(true);
          setDraft(EMPTY_DRAFT);
          setAttachment(null);
          toast({
            title: saveAsDraft ? "تم حفظ المسودة" : "تم إرسال المعاملة",
            description: result.txnNumber ? `رقم المعاملة: ${result.txnNumber}` : undefined,
            tone: "success",
          });
          navigate("/workflow/my-requests");
        },
        onError: (reason) => setError(reason instanceof Error ? reason.message : "تعذّر حفظ المعاملة."),
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
              <h1 className="text-xl font-extrabold text-slate-950">إنشاء معاملة إدارية</h1>
              <p className="mt-1 text-sm font-medium text-slate-500">
                أدخل البيانات ثم راجع مسار الإرسال قبل اعتماده.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
            <Clock3 className="h-4 w-4 text-teal-600" aria-hidden="true" />
            {draft.updatedAt ? `حُفظ محليًا ${new Date(draft.updatedAt).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}` : "الحفظ المحلي التلقائي مفعّل"}
          </div>
        </section>

        <Card>
          <CardBody className="overflow-x-auto">
            <Stepper steps={STEPS} current={step} />
          </CardBody>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{STEPS[step - 1]}</CardTitle>
                <p className="mt-1 text-xs font-medium text-slate-500">الخطوة {step} من {STEPS.length}</p>
              </div>
              <Badge tone="info">مسودة محلية</Badge>
            </CardHeader>
            <CardBody className="space-y-5">
              {step === 1 && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="نوع المعاملة" required>
                    <Select
                      value={draft.transactionTypeId}
                      onChange={(event) => update("transactionTypeId", event.target.value)}
                      options={typeOptions}
                      placeholder={types.isLoading ? "جارٍ تحميل الأنواع…" : "اختر النوع"}
                    />
                  </Field>
                  <Field label="الأولوية" required>
                    <Select
                      value={draft.importance}
                      onChange={(event) => update("importance", event.target.value as Importance)}
                      options={IMPORTANCE_OPTIONS}
                    />
                  </Field>
                  <Field label="موضوع المعاملة" required className="md:col-span-2" hint="اكتب عنوانًا قصيرًا يمكن تمييزه في الوارد والتقارير.">
                    <Input
                      value={draft.title}
                      maxLength={300}
                      onChange={(event) => update("title", event.target.value)}
                      placeholder="مثال: اعتماد شراء معدات الفرع"
                    />
                  </Field>
                  <Field label="النطاق">
                    <Select
                      value={draft.scope}
                      onChange={(event) => update("scope", event.target.value as LocalDraft["scope"])}
                      options={[
                        { value: "internal", label: "داخلي" },
                        { value: "external", label: "خارجي" },
                      ]}
                    />
                  </Field>
                  <Field label="المبلغ المرتبط" hint="اختياري — بالريال السعودي.">
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
                    يختار النظام أول خطوة اعتماد وفق نوع المعاملة ومنصب المنشئ. اختيار مستلم مباشر يضمن وصول المعاملة عندما لا يوجد مسار معرف.
                  </div>
                  <Field label="المستلم" required={draft.scope === "external"} hint="يمكن تركه فارغًا إذا كان لهذا النوع مسار اعتماد مكتمل.">
                    <Select
                      value={draft.recipientUsername}
                      onChange={(event) => update("recipientUsername", event.target.value)}
                      options={recipientOptions}
                      placeholder={recipients.isLoading ? "جارٍ تحميل المستلمين…" : "التوجيه التلقائي حسب المسار"}
                    />
                  </Field>
                  <Field label="موعد الاستحقاق">
                    <Input type="date" value={draft.dueDate} onChange={(event) => update("dueDate", event.target.value)} />
                  </Field>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  <Field label="الوصف والمطلوب" required hint="يوضع هذا المحتوى داخل تفاصيل المعاملة للمراجعين.">
                    <textarea
                      className="field min-h-40 resize-y py-3"
                      maxLength={10000}
                      value={draft.description}
                      onChange={(event) => update("description", event.target.value)}
                      placeholder="اشرح خلفية الطلب والقرار المطلوب والمبررات…"
                    />
                  </Field>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="سرية المحتوى">
                      <Select value={draft.contentSecrecy} onChange={(event) => update("contentSecrecy", event.target.value as Secrecy)} options={SECRECY_OPTIONS} />
                    </Field>
                    <Field label="سرية المرفق">
                      <Select value={draft.attachmentsSecrecy} onChange={(event) => update("attachmentsSecrecy", event.target.value as Secrecy)} options={SECRECY_OPTIONS} />
                    </Field>
                  </div>
                  <section aria-labelledby="attachment-heading" className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-teal-600" aria-hidden="true" />
                      <h3 id="attachment-heading" className="text-sm font-extrabold text-slate-800">المرفق</h3>
                      <Badge tone="neutral">ملف واحد</Badge>
                    </div>
                    {!attachment && (
                      <FileUploader
                        onFiles={pickFiles}
                        multiple={false}
                        disabled={attachmentBusy}
                        maxSize={1_500_000}
                        onReject={() => setError("الحد الأقصى للمرفق في المعاملة 1.5 ميجابايت.")}
                        hint="PDF أو صورة أو مستند — بحد أقصى 1.5 ميجابايت"
                      />
                    )}
                    <AttachmentViewer
                      attachments={attachment ? [{ id: "new", name: attachment.file.name, size: attachment.file.size }] : []}
                      onRemove={attachment ? () => setAttachment(null) : undefined}
                      emptyText="لم يُضف مرفق بعد."
                    />
                    <p className="text-[11px] font-medium text-slate-400">لا يُخزّن محتوى الملف داخل المسودة المحلية؛ أعد اختياره بعد إعادة تحميل الصفحة.</p>
                  </section>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />
                    <div>
                      <div className="text-sm font-extrabold text-emerald-900">المعاملة جاهزة للمراجعة</div>
                      <div className="mt-1 text-xs font-medium text-emerald-700">راجع الملخص قبل الحفظ كمسودة أو الإرسال إلى المسار.</div>
                    </div>
                  </div>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <ReviewRow label="النوع" value={selectedType?.name || "—"} />
                    <ReviewRow label="الأولوية" value={IMPORTANCE_OPTIONS.find((option) => option.value === draft.importance)?.label || "—"} />
                    <ReviewRow label="الموضوع" value={draft.title || "—"} wide />
                    <ReviewRow label="المستلم" value={selectedRecipient?.label || "توجيه تلقائي حسب المسار"} />
                    <ReviewRow label="الاستحقاق" value={draft.dueDate || "غير محدد"} />
                    <ReviewRow label="المبلغ" value={draft.amount ? `${Number(draft.amount).toLocaleString("ar-SA", { minimumFractionDigits: 2 })} ر.س` : "غير مرتبط"} />
                    <ReviewRow label="المرفق" value={attachment?.file.name || "لا يوجد"} />
                    <ReviewRow label="الوصف" value={draft.description || "—"} wide />
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
                  معاينة التوجيه
                </div>
                <div className="space-y-3 text-xs font-medium text-slate-600">
                  <PreviewLine icon={FileText} label="النوع" value={selectedType?.name || "لم يُحدد"} />
                  <PreviewLine icon={UserRound} label="المستلم" value={selectedRecipient?.label || "حسب المسار"} />
                  <PreviewLine icon={Clock3} label="الاستحقاق" value={draft.dueDate || "غير محدد"} />
                </div>
              </CardBody>
            </Card>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-medium leading-5 text-slate-500">
              الحفظ المحلي يحمي المدخلات على هذا الجهاز. استخدم «حفظ كمسودة» لإنشاء مسودة مرئية في حسابك.
            </div>
          </aside>
        </div>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur lg:static lg:rounded-2xl lg:border lg:shadow-sm">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => (step === 1 ? navigate("/workflow/my-requests") : setStep((value) => value - 1))}>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
              {step === 1 ? "إلغاء" : "السابق"}
            </Button>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => submit(true)} loading={create.isPending}>
                <Save className="h-4 w-4" aria-hidden="true" /> حفظ كمسودة
              </Button>
              {step < 4 ? (
                <Button variant="primary" onClick={goNext}>
                  التالي <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button variant="primary" onClick={() => submit(false)} loading={create.isPending}>
                  <Send className="h-4 w-4" aria-hidden="true" /> إرسال المعاملة
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
