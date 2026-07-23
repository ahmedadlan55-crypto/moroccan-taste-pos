// ── AccountForm — create / edit an account in a Dialog ───────────────────────
// Kind (folder|leaf), parent (level < 4), type (inherited from parent), an
// auto-derived level, code (readonly on edit) and names. Mirrors the CostCenters
// save flow: mutate → handle {success:false} via mapError → onSaved + close.

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Input,
  SegmentedControl,
  Select,
  Toggle,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useT, type TFunction } from "@/i18n";
import {
  GL_ACCOUNT_TYPES,
  glTypeLabel,
  useSaveGlAccount,
  type GlAccount,
  type GlAccountInput,
  type GlAccountType,
} from "../api";
import { buildChildrenMap, descendantIds } from "./coaModel";

// Server answers HTTP 200 with { success:false, error } — map the codes to a
// localized message via the caller-supplied `t`.
function mapError(t: TFunction, raw: string | undefined): string {
  const s = raw ?? "";
  if (/duplicate-code|code-exists|already/i.test(s)) return t("accounting.coa.form.errors.dupCode");
  if (/code-required/i.test(s)) return t("accounting.coa.form.errors.codeRequired");
  if (/name-required|name/i.test(s)) return t("accounting.coa.form.errors.nameRequired");
  if (/parent-not-found|invalid-parent/i.test(s)) return t("accounting.coa.form.errors.parentNotFound");
  if (/parent-is-leaf|parent-not-folder/i.test(s)) return t("accounting.coa.form.errors.parentNotFolder");
  if (/not-found/i.test(s)) return t("accounting.coa.form.errors.notFound");
  return s || t("accounting.coa.form.errors.generic");
}

interface FormState {
  id?: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  isFolder: boolean;
  isActive: boolean;
}

function toFormState(input: GlAccountInput): FormState {
  return {
    id: input.id,
    code: input.code ?? "",
    nameAr: input.nameAr ?? "",
    nameEn: input.nameEn ?? "",
    type: input.type ?? "asset",
    parentId: input.parentId ?? null,
    isFolder: input.isFolder ?? false,
    isActive: input.isActive ?? true,
  };
}

export interface AccountFormProps {
  open: boolean;
  account: GlAccountInput | null;
  accounts: GlAccount[];
  onClose: () => void;
  onSaved: () => void;
}

export function AccountForm({ open, account, accounts, onClose, onSaved }: AccountFormProps) {
  const t = useT();
  const save = useSaveGlAccount();
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<{ code?: string; nameAr?: string; parent?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isEdit = !!account?.id;

  // Reset local state whenever the dialog opens on a (new) account.
  useEffect(() => {
    if (open && account) {
      setForm(toFormState(account));
      setErrors({});
      setFormError(null);
    }
  }, [open, account]);

  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);

  // Parent candidates: any account with level < 4, minus self + its descendants.
  const parentOptions = useMemo(() => {
    const blocked = form?.id
      ? new Set<string>([form.id, ...descendantIds(form.id, byParent)])
      : new Set<string>();
    return accounts
      .filter((a) => a.level < 4 && !blocked.has(a.id))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, byParent, form?.id]);

  if (!form) {
    return <Dialog open={open} onClose={onClose} size="lg" title={t("accounting.coa.form.titleFallback")} />;
  }

  const parentAccount = accounts.find((a) => a.id === form.parentId) ?? null;
  const level = form.parentId ? (parentAccount ? parentAccount.level + 1 : 2) : 1;

  function patch(part: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...part } : prev));
  }

  function changeKind(kind: "folder" | "leaf") {
    patch({ isFolder: kind === "folder" });
    setErrors((e) => ({ ...e, parent: undefined }));
  }

  function changeParent(value: string) {
    const parentId = value || null;
    const parent = accounts.find((a) => a.id === parentId) ?? null;
    // A new child inherits its parent's type by default.
    patch({ parentId, type: parent ? parent.type : form!.type });
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
      ...(form.id ? { id: form.id } : {}),
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
        onSaved();
        onClose();
      },
      onError: (e) => setFormError(mapError(t, e instanceof Error ? e.message : "")),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("accounting.coa.form.editTitle") : t("accounting.coa.form.newTitle")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("accounting.coa.form.kind")}>
          <SegmentedControl<"folder" | "leaf">
            value={form.isFolder ? "folder" : "leaf"}
            onChange={changeKind}
            options={[
              { value: "folder", label: t("accounting.coa.form.folderKind") },
              { value: "leaf", label: t("accounting.coa.form.leafKind") },
            ]}
            aria-label={t("accounting.coa.form.kindAria")}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("accounting.coa.form.parent")} error={errors.parent}>
            <Select
              value={form.parentId ?? ""}
              invalid={!!errors.parent}
              onChange={(e) => changeParent(e.target.value)}
            >
              <option value="" disabled={!form.isFolder}>
                {t("accounting.coa.form.root")}
              </option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.nameAr}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("accounting.coa.form.classification")}>
            <Select
              value={form.type}
              onChange={(e) => patch({ type: e.target.value as GlAccountType })}
            >
              {GL_ACCOUNT_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {glTypeLabel(t, tp)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("accounting.coa.form.code")} required error={errors.code}>
            <Input
              value={form.code}
              readOnly={isEdit}
              invalid={!!errors.code}
              onChange={(e) => {
                setErrors((x) => ({ ...x, code: undefined }));
                patch({ code: e.target.value });
              }}
              placeholder={t("accounting.coa.form.codePlaceholder")}
              className={isEdit ? "bg-slate-50 text-slate-500" : undefined}
            />
          </Field>

          <Field label={t("accounting.coa.form.level")}>
            <Input value={String(level)} readOnly className="bg-slate-50 text-slate-500" />
          </Field>

          <Field label={t("accounting.coa.form.nameAr")} required error={errors.nameAr} className="sm:col-span-2">
            <Input
              value={form.nameAr}
              invalid={!!errors.nameAr}
              onChange={(e) => {
                setErrors((x) => ({ ...x, nameAr: undefined }));
                patch({ nameAr: e.target.value });
              }}
            />
          </Field>

          <Field label={t("accounting.coa.form.nameEn")} className="sm:col-span-2">
            <Input
              value={form.nameEn}
              dir="ltr"
              onChange={(e) => patch({ nameEn: e.target.value })}
            />
          </Field>
        </div>

        {isEdit && (
          <label className="flex items-center gap-3">
            <Toggle checked={form.isActive} onChange={(v) => patch({ isActive: v })} />
            <span className="text-sm font-bold text-slate-700">{t("accounting.coa.form.active")}</span>
          </label>
        )}

        {formError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {formError}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export default AccountForm;
