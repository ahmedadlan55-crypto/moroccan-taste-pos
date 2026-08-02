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
import {
  GL_ACCOUNT_TYPES,
  glTypeLabel,
  useSaveGlAccount,
  type GlAccountInput,
  type GlAccountType,
} from "../api";
import { COA_BASE, MANAGE_CAP } from "./routes";
import { useCoaData } from "./useCoaData";
import { accountName, descendantIds, isSystemRoot } from "./coaModel";

// Server answers HTTP 200 with { success:false, error } — map the codes to a
// localized message via the caller-supplied `t`.
function mapError(t: TFunction, raw: string | undefined): string {
  const s = raw ?? "";
  if (/duplicate-code|code-exists|already|مسبق/i.test(s)) return t("accounting.coa.form.errors.dupCode");
  if (/code-required/i.test(s)) return t("accounting.coa.form.errors.codeRequired");
  if (/name-required|name/i.test(s)) return t("accounting.coa.form.errors.nameRequired");
  if (/parent-not-found|invalid-parent/i.test(s)) return t("accounting.coa.form.errors.parentNotFound");
  if (/parent-is-leaf|parent-not-folder/i.test(s)) return t("accounting.coa.form.errors.parentNotFolder");
  if (/not-found/i.test(s)) return t("accounting.coa.form.errors.notFound");
  return s || t("accounting.coa.form.errors.generic");
}

interface FormState {
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  isFolder: boolean;
  isActive: boolean;
}

const BLANK: FormState = {
  code: "",
  nameAr: "",
  nameEn: "",
  type: "asset",
  parentId: null,
  isFolder: false,
  isActive: true,
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

  const isEdit = mode === "edit";
  const existing = isEdit && id ? (data.byId.get(id) ?? null) : null;
  const parentParam = sp.get("parent");

  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<{ code?: string; nameAr?: string; parent?: string }>({});
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
      });
      return;
    }
    const parent = parentParam ? (data.byId.get(parentParam) ?? null) : null;
    setForm({
      ...BLANK,
      parentId: parent?.id ?? null,
      type: parent?.type ?? "asset",
      isFolder: !parent,
    });
  }, [ready, form, isEdit, existing, parentParam, data.byId]);

  // Parent candidates: any account minus self and its own descendants (that is
  // the cycle the server rejects), sorted by code.
  const parentOptions = useMemo(() => {
    const blocked = id ? new Set<string>([id, ...descendantIds(id, data.byParent)]) : new Set<string>();
    return data.accounts
      .filter((a) => !blocked.has(a.id))
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
    const parentId = value || null;
    const parent = parentId ? (data.byId.get(parentId) ?? null) : null;
    // A new child inherits its parent's type by default.
    setForm((prev) => (prev ? { ...prev, parentId, type: parent ? parent.type : prev.type } : prev));
    setErrors((e) => ({ ...e, parent: undefined }));
  }

  function submit() {
    if (!form) return;
    const next: typeof errors = {};
    if (!form.code.trim()) next.code = t("accounting.coa.form.validation.codeRequired");
    if (!form.nameAr.trim()) next.nameAr = t("accounting.coa.form.validation.nameArRequired");
    if (!form.isFolder && !form.parentId) next.parent = t("accounting.coa.form.validation.parentRequired");
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
      level,
      isFolder: form.isFolder,
      ...(isEdit ? { isActive: form.isActive } : {}),
    };

    save.mutate(input, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setFormError(mapError(t, res.error));
          return;
        }
        toast({
          tone: "success",
          title: isEdit ? t("accounting.coa.form.saved") : t("accounting.coa.form.created"),
        });
        const savedId = res?.id ?? id;
        navigate(savedId ? `${COA_BASE}/${encodeURIComponent(savedId)}` : COA_BASE, { replace: true });
      },
      onError: (e) => setFormError(mapError(t, e instanceof Error ? e.message : "")),
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
                disabled={systemRoot}
                onChange={(e) => changeParent(e.target.value)}
              >
                <option value="" disabled={!form.isFolder}>
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

          <Field label={t("accounting.coa.form.nameEn")} className="sm:col-span-2">
            {({ id: fid }) => (
              <Input
                id={fid}
                value={form.nameEn}
                dir="ltr"
                onChange={(e) => patch({ nameEn: e.target.value })}
              />
            )}
          </Field>
        </div>

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
