// ── /accounting/chart-of-accounts/new  ·  …/:id/edit ────────────────────────
// The create/edit workspace as a FULL PAGE at a real URL, not a dialog. A
// half-typed account now survives a refresh, can be linked to, and the browser
// back button means what it says.
//
// `?parent=<id>` pre-selects the parent (the "add sub-account" action), so the
// intent travels in the URL instead of in component state a reload would drop.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BookText } from "lucide-react";
import {
  Button,
  ErrorState,
  FullPageFlow,
  Input,
  LoadingState,
  SegmentedControl,
  Select,
  Toggle,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useCan } from "@/app/providers";
import { useLang, useT, type TFunction } from "@/i18n";
import { ApiError } from "@/shared/api";
import {
  GL_ACCOUNT_TYPES,
  glTypeLabel,
  useSaveGlAccount,
  useStatementSections,
  type GlAccountInput,
  type GlAccountType,
} from "../api";
import { COA_BASE, MANAGE_CAP } from "./routes";
import { useCoaData } from "./useCoaData";
import { accountName, descendantIds, isFolderAccount, isSystemRoot } from "./coaModel";

// Server answers HTTP 200 with { success:false, error } — map the codes to a
// localized message via the caller-supplied `t`.
function mapError(t: TFunction, error: unknown, explicitCode?: string): string {
  const apiError = error instanceof ApiError ? error : null;
  const code = String(explicitCode || apiError?.code || "").toUpperCase();
  const s = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (["REPORT_SECTION_INVALID", "REPORT_SECTION_TYPE_MISMATCH"].includes(code)) {
    return t("accounting.coa.form.errors.reportSectionInvalid");
  }
  if (code === "CASH_FLOW_ACTIVITY_INVALID") return t("accounting.coa.form.errors.cashFlowInvalid");
  if (code === "VERSION_CONFLICT") return t("accounting.coa.form.errors.changed");
  if (code === "SYSTEM_MANAGED_PROTECTED") return t("accounting.coa.form.errors.systemManaged");
  if (["PARENT_NOT_FOLDER", "PARENT_HAS_ENTRIES"].includes(code)) {
    return t("accounting.coa.form.errors.parentNotFolder");
  }
  if (code === "TYPE_MISMATCH") return t("accounting.coa.form.errors.parentTypeMismatch");
  if (/duplicate-code|code-exists|already|مسبق/i.test(s)) return t("accounting.coa.form.errors.dupCode");
  if (/code-required/i.test(s)) return t("accounting.coa.form.errors.codeRequired");
  if (/name-required|name/i.test(s)) return t("accounting.coa.form.errors.nameRequired");
  if (/parent-not-found|invalid-parent/i.test(s)) return t("accounting.coa.form.errors.parentNotFound");
  if (/parent-is-leaf|parent-not-folder/i.test(s)) return t("accounting.coa.form.errors.parentNotFolder");
  if (/report-section|تصنيف القوائم|تصنيف القائمة المالية/i.test(s)) return t("accounting.coa.form.errors.reportSectionInvalid");
  if (/cash-flow|التدفق النقدي/i.test(s)) return t("accounting.coa.form.errors.cashFlowInvalid");
  if (/not-found/i.test(s)) return t("accounting.coa.form.errors.notFound");
  // Backend messages are not a localization surface. Unknown server text is
  // deliberately not echoed, otherwise English mode leaks Arabic validation.
  return t("accounting.coa.form.errors.generic");
}

interface FormState {
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  isFolder: boolean;
  isActive: boolean;
  reportSection: string;
  cashFlowActivity: "" | "operating" | "investing" | "financing" | "non_cash";
}

const BLANK: FormState = {
  code: "",
  nameAr: "",
  nameEn: "",
  type: "asset",
  parentId: null,
  isFolder: false,
  isActive: true,
  reportSection: "",
  cashFlowActivity: "",
};

export interface AccountFormPageProps {
  mode: "new" | "edit";
  id?: string;
}

export function AccountFormPage({ mode, id }: AccountFormPageProps) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const canManage = useCan(MANAGE_CAP);
  const { toast } = useToast();
  const save = useSaveGlAccount();
  const data = useCoaData();
  const sectionsQuery = useStatementSections();

  const isEdit = mode === "edit";
  const existing = isEdit && id ? (data.byId.get(id) ?? null) : null;
  const parentParam = sp.get("parent");

  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<{
    code?: string;
    nameAr?: string;
    nameEn?: string;
    parent?: string;
    reportSection?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Seed once the chart has loaded. `ready` (not `existing`) is the trigger, so
  // an id that does not exist settles into the not-found branch instead of
  // spinning forever on an empty form.
  const ready = !data.isLoading && !data.error;
  useEffect(() => {
    if (!ready || form) return;
    if (isEdit) {
      if (!existing) return;
      setForm({
        code: existing.code,
        nameAr: existing.nameAr,
        nameEn: existing.nameEn,
        type: existing.type,
        parentId: existing.parentId,
        isFolder: existing.isFolder,
        isActive: existing.isActive,
        reportSection: existing.reportSection ?? "",
        cashFlowActivity:
          existing.cashFlowActivity === "operating" ||
          existing.cashFlowActivity === "investing" ||
          existing.cashFlowActivity === "financing" ||
          existing.cashFlowActivity === "non_cash"
            ? existing.cashFlowActivity
            : "",
      });
      return;
    }
    const parent = parentParam ? (data.byId.get(parentParam) ?? null) : null;
    setForm({
      ...BLANK,
      parentId: parent?.id ?? null,
      type: parent?.type ?? "asset",
      isFolder: !parent,
      reportSection: parent?.reportSection ?? "",
      cashFlowActivity:
        parent?.cashFlowActivity === "operating" ||
        parent?.cashFlowActivity === "investing" ||
        parent?.cashFlowActivity === "financing" ||
        parent?.cashFlowActivity === "non_cash"
          ? parent.cashFlowActivity
          : "",
    });
  }, [ready, form, isEdit, existing, parentParam, data.byId]);

  // Parent candidates: any account minus self and its own descendants (that is
  // the cycle the server rejects), sorted by code.
  const parentOptions = useMemo(() => {
    const blocked = id ? new Set<string>([id, ...descendantIds(id, data.byParent)]) : new Set<string>();
    return data.accounts
      .filter((a) => {
        if (blocked.has(a.id) || !a.isActive) return false;
        const hasChildren = (data.byParent.get(a.id) ?? []).length > 0;
        return isFolderAccount(a, hasChildren);
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [data.accounts, data.byParent, id]);

  const close = () => navigate(isEdit && id ? `${COA_BASE}/${encodeURIComponent(id)}` : COA_BASE);

  if (!canManage) {
    return (
      <FullPageFlow open onClose={close} icon={BookText} title={t("accounting.coa.form.newTitle")}>
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {t("accounting.coa.form.noPermission")}
        </p>
      </FullPageFlow>
    );
  }

  if (data.error) {
    return (
      <FullPageFlow open onClose={close} icon={BookText} title={t("accounting.coa.form.titleFallback")}>
        <ErrorState error={data.error} onRetry={data.refetch} />
      </FullPageFlow>
    );
  }

  if (!form) {
    return (
      <FullPageFlow open onClose={close} icon={BookText} title={t("accounting.coa.form.titleFallback")}>
        {ready && isEdit && !existing ? (
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
            {t("accounting.coa.detail.errors.notFound")}
          </p>
        ) : (
          <LoadingState />
        )}
      </FullPageFlow>
    );
  }

  const parentAccount = data.byId.get(form.parentId ?? "") ?? null;
  const level = form.parentId ? (parentAccount ? parentAccount.level + 1 : 2) : 1;
  const systemRoot = existing ? isSystemRoot(existing, data.accounts) : false;

  function patch(part: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...part } : prev));
  }

  function changeParent(value: string) {
    // Re-parenting is a governed operation with its own preview/audit route.
    // Editing names or lifecycle must never move a subtree as a side effect.
    if (isEdit) return;
    const parentId = value || null;
    const parent = parentId ? (data.byId.get(parentId) ?? null) : null;
    // A new child inherits its parent's type by default.
    setForm((prev) => (prev ? {
      ...prev,
      parentId,
      type: parent ? parent.type : prev.type,
      // A missing classification on the newly selected parent must CLEAR the
      // previous inheritance. Keeping it silently misclassifies the new row.
      reportSection: parent?.reportSection ?? "",
      cashFlowActivity:
        parent?.cashFlowActivity === "operating" ||
        parent?.cashFlowActivity === "investing" ||
        parent?.cashFlowActivity === "financing" ||
        parent?.cashFlowActivity === "non_cash"
          ? parent.cashFlowActivity
          : "",
    } : prev));
    setErrors((e) => ({ ...e, parent: undefined }));
  }

  function submit() {
    if (!form) return;
    const next: typeof errors = {};
    if (!form.code.trim()) next.code = t("accounting.coa.form.validation.codeRequired");
    if (!form.nameAr.trim()) next.nameAr = t("accounting.coa.form.validation.nameArRequired");
    if (!isEdit && !form.nameEn.trim()) next.nameEn = t("accounting.coa.form.validation.nameEnRequired");
    if (!form.parentId && !(isEdit && systemRoot)) {
      next.parent = t("accounting.coa.form.validation.parentRequired");
    }
    if (!form.isFolder && !form.reportSection) {
      next.reportSection = t("accounting.coa.form.validation.reportSectionRequired");
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setFormError(null);
    const input: GlAccountInput = {
      ...(isEdit && id ? { id } : {}),
      code: form.code.trim(),
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim(),
      type: form.type,
      parentId: form.parentId,
      isFolder: form.isFolder,
      reportSection: form.reportSection || null,
      cashFlowActivity: form.cashFlowActivity || null,
      ...(isEdit ? { isActive: form.isActive } : {}),
      ...(isEdit && existing?.version != null ? { expectedVersion: existing.version } : {}),
    };

    save.mutate(input, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(mapError(t, res.error, "code" in res ? String(res.code || "") : undefined));
          return;
        }
        toast({
          tone: "success",
          title: isEdit ? t("accounting.coa.form.saved") : t("accounting.coa.form.created"),
        });
        const savedId = res?.id ?? id;
        navigate(savedId ? `${COA_BASE}/${encodeURIComponent(savedId)}` : COA_BASE, { replace: true });
      },
      onError: (e) => setFormError(mapError(t, e)),
    });
  }

  return (
    <FullPageFlow
      open
      onClose={close}
      icon={BookText}
      eyebrow={t("accounting.coa.title")}
      title={isEdit ? t("accounting.coa.form.editTitle") : t("accounting.coa.form.newTitle")}
      description={t("accounting.coa.form.description")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("accounting.coa.form.kind")} hint={t("accounting.coa.form.kindHint")}>
          <SegmentedControl<"folder" | "leaf">
            value={form.isFolder ? "folder" : "leaf"}
            onChange={(kind) => {
              patch({ isFolder: kind === "folder" });
              setErrors((e) => ({ ...e, parent: undefined }));
            }}
            options={[
              { value: "folder", label: t("accounting.coa.form.folderKind") },
              { value: "leaf", label: t("accounting.coa.form.leafKind") },
            ]}
            aria-label={t("accounting.coa.form.kindAria")}
          />
        </Field>

        {/* Field's render-function form is what actually wires the <label
            htmlFor> to the control's id. Passing a bare node leaves the label
            pointing at nothing — the field still LOOKS labelled and is silent
            to a screen reader (and to getByLabelText). */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("accounting.coa.form.parent")} error={errors.parent}>
            {({ id: fid }) => (
              <Select
                id={fid}
                value={form.parentId ?? ""}
                invalid={!!errors.parent}
                disabled={isEdit || systemRoot}
                onChange={(e) => changeParent(e.target.value)}
              >
                <option value="" disabled>
                  {t("accounting.coa.form.root")}
                </option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {accountName(p, lang)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t("accounting.coa.form.classification")}>
            {({ id: fid }) => (
              <Select
                id={fid}
                value={form.type}
                disabled={isEdit || systemRoot}
                onChange={(e) => patch({ type: e.target.value as GlAccountType })}
              >
                {GL_ACCOUNT_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {glTypeLabel(t, tp)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t("accounting.coa.form.code")} required error={errors.code}>
            {({ id: fid }) => (
              <Input
                id={fid}
                value={form.code}
                readOnly={isEdit}
                dir="ltr"
                invalid={!!errors.code}
                onChange={(e) => {
                  setErrors((x) => ({ ...x, code: undefined }));
                  patch({ code: e.target.value });
                }}
                placeholder={t("accounting.coa.form.codePlaceholder")}
                className={isEdit ? "bg-slate-50 text-slate-500" : undefined}
              />
            )}
          </Field>

          <Field label={t("accounting.coa.form.level")} hint={t("accounting.coa.form.levelHint")}>
            {({ id: fid }) => (
              <Input id={fid} value={String(level)} readOnly className="bg-slate-50 text-slate-500" />
            )}
          </Field>

          <Field
            label={t("accounting.coa.form.nameAr")}
            required
            error={errors.nameAr}
            className="sm:col-span-2"
          >
            {({ id: fid }) => (
              <Input
                id={fid}
                value={form.nameAr}
                invalid={!!errors.nameAr}
                onChange={(e) => {
                  setErrors((x) => ({ ...x, nameAr: undefined }));
                  patch({ nameAr: e.target.value });
                }}
              />
            )}
          </Field>

          <Field
            label={t("accounting.coa.form.nameEn")}
            required={!isEdit}
            error={errors.nameEn}
            className="sm:col-span-2"
          >
            {({ id: fid }) => (
              <Input
                id={fid}
                value={form.nameEn}
                dir="ltr"
                invalid={!!errors.nameEn}
                onChange={(e) => {
                  setErrors((x) => ({ ...x, nameEn: undefined }));
                  patch({ nameEn: e.target.value });
                }}
              />
            )}
          </Field>

          <Field
            label={t("accounting.coa.form.reportSection")}
            hint={t("accounting.coa.form.reportSectionHint")}
            required={!form.isFolder}
            error={errors.reportSection}
          >
            {({ id: fid }) => (
              <Select
                id={fid}
                value={form.reportSection}
                invalid={!!errors.reportSection}
                onChange={(e) => {
                  setErrors((x) => ({ ...x, reportSection: undefined }));
                  patch({ reportSection: e.target.value });
                }}
              >
                <option value="">{t("accounting.coa.form.selectReportSection")}</option>
                {(sectionsQuery.data ?? [])
                  .slice()
                  .sort((a, b) => a.displayOrder - b.displayOrder)
                  .map((section) => (
                    <option key={section.id} value={section.id}>
                      {lang === "en" ? section.nameEn : section.nameAr} — {section.id}
                    </option>
                  ))}
              </Select>
            )}
          </Field>

          <Field
            label={t("accounting.coa.form.cashFlowActivity")}
            hint={t("accounting.coa.form.cashFlowActivityHint")}
          >
            {({ id: fid }) => (
              <Select
                id={fid}
                value={form.cashFlowActivity}
                onChange={(e) => patch({
                  cashFlowActivity: e.target.value as FormState["cashFlowActivity"],
                })}
              >
                <option value="">{t("accounting.coa.form.cashFlow.none")}</option>
                <option value="operating">{t("accounting.coa.form.cashFlow.operating")}</option>
                <option value="investing">{t("accounting.coa.form.cashFlow.investing")}</option>
                <option value="financing">{t("accounting.coa.form.cashFlow.financing")}</option>
                <option value="non_cash">{t("accounting.coa.form.cashFlow.nonCash")}</option>
              </Select>
            )}
          </Field>
        </div>

        {sectionsQuery.error && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
            {t("accounting.coa.form.sectionCatalogUnavailable")}
          </p>
        )}

        {isEdit && (
          <label className="flex min-h-11 items-center gap-3">
            <Toggle checked={form.isActive} onChange={(v) => patch({ isActive: v })} />
            <span className="text-sm font-bold text-slate-700">{t("accounting.coa.form.active")}</span>
          </label>
        )}

        {isEdit && (
          <p className="text-xs font-medium text-slate-500">{t("accounting.coa.form.moveHint")}</p>
        )}

        {formError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {formError}
          </div>
        )}
      </div>
    </FullPageFlow>
  );
}

export default AccountFormPage;
