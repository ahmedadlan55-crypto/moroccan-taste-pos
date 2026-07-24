/**
 * CustomerAddDialog — «عميل جديد» from the POS (close/b2-pos-daily).
 *
 * Legacy contract: public/pos/app.js posOpenCustomerAddModal :1736 / doSave
 * :1808 → POST /api/erp/customers with id:'' (INSERT). The legacy modal had 9
 * fields; the till needs name+phone (+optional VAT/type) — the rest belong to
 * the ERP customer master. Validation mirrors doSave: name required, phone
 * required and ≥5 chars. On success the customer is AUTO-ATTACHED to the cart
 * via onCreated → CustomerPicker.onChange → store.setCustomerRef (the legacy
 * «حفظ وربط · Save & Link» behavior).
 *
 * Duplicate phone (:1883): the server's failure message surfaces in the error
 * banner with a «استدعاء العميل الموجود» shortcut that reopens the search
 * prefilled with the phone.
 *
 * Provider-free by design (no usePos): the username comes from lib/auth
 * directly, results/errors render inline — so the dialog unit-tests without
 * the full store.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Search, UserPlus } from "lucide-react";
import { ApiError, createErpCustomer, type NewCustomerInput } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { useT } from "@/i18n/I18nProvider";
import { Dialog } from "../Dialog";
import { Button } from "../ui";

export interface CustomerAddPrefill {
  name?: string;
  phone?: string;
}

export interface CustomerAddDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fires with the CREATED customer — the caller attaches it to the cart. */
  onCreated: (c: { id: string; name: string; phone: string }) => void;
  prefill?: CustomerAddPrefill;
  /** Duplicate-phone shortcut: recall the existing customer into the search. */
  onRecallExisting?: (phone: string) => void;
}

/** Mirrors legacy doSave's guards (app.js:1820-1822). Returns the i18n key
 *  (dotted path under customerAddDialog.validation) of the error, or null when
 *  valid — pure, unit-testable; the caller resolves the key via t(). */
export function validateNewCustomer(name: string, phone: string): string | null {
  if (!name.trim()) return "customerAddDialog.validation.nameRequired";
  if (!phone.trim()) return "customerAddDialog.validation.phoneRequired";
  if (phone.trim().length < 5) return "customerAddDialog.validation.phoneTooShort";
  return null;
}

export function CustomerAddDialog({ open, onClose, onCreated, prefill, onRecallExisting }: CustomerAddDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [customerType, setCustomerType] = useState<NonNullable<NewCustomerInput["customerType"]>>("B2C");
  const [error, setError] = useState<string | null>(null);
  const [dupPhone, setDupPhone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(prefill?.name ?? "");
    setPhone(prefill?.phone ?? "");
    setVatNumber("");
    setCustomerType("B2C");
    setError(null);
    setDupPhone(null);
    setSaving(false);
  }, [open, prefill?.name, prefill?.phone]);

  async function save() {
    if (saving) return;
    setError(null);
    setDupPhone(null);
    const invalid = validateNewCustomer(name, phone);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setSaving(true);
    try {
      const res = await createErpCustomer(
        { name: name.trim(), phone: phone.trim(), vatNumber: vatNumber.trim() || undefined, customerType },
        currentUser()?.username ?? "cashier",
      );
      onCreated({ id: res.id, name: name.trim(), phone: phone.trim() });
    } catch (e) {
      const err = e as ApiError;
      // err.message is the SERVER's (Arabic) message — surfaced verbatim; only
      // the client-side fallback is translated.
      setError(err.message || t("customerAddDialog.errors.saveFailed"));
      // Duplicate phone (legacy :1883): offer to recall the existing customer.
      // Regex matches the SERVER's Arabic error text — must stay Arabic.
      if (/duplicate|dup_entry|مسجل|موجود/i.test(err.message || "")) setDupPhone(phone.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("customerAddDialog.title")} widthClass="max-w-md" locked={saving}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("customerAddDialog.fields.nameLabel")}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoComplete="off"
            className="field"
            placeholder={t("customerAddDialog.fields.namePlaceholder")}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("customerAddDialog.fields.phoneLabel")}</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={20}
            autoComplete="off"
            className="field num"
            dir="ltr"
            placeholder={t("customerAddDialog.fields.phonePlaceholder")}
          />
        </label>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("customerAddDialog.fields.vatLabel")}</span>
            <input
              type="text"
              value={vatNumber}
              onChange={(e) => setVatNumber(e.target.value)}
              maxLength={20}
              autoComplete="off"
              className="field num"
              dir="ltr"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("customerAddDialog.fields.typeLabel")}</span>
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as typeof customerType)}
              className="field"
            >
              <option value="B2C">{t("customerAddDialog.fields.typeB2C")}</option>
              <option value="B2B">{t("customerAddDialog.fields.typeB2B")}</option>
              <option value="B2G">{t("customerAddDialog.fields.typeB2G")}</option>
            </select>
          </label>
        </div>

        {error ? (
          <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-bold text-red-700">
            <AlertTriangle className="me-1 inline h-3.5 w-3.5" aria-hidden />
            {error}
            {dupPhone && onRecallExisting ? (
              <button
                type="button"
                onClick={() => onRecallExisting(dupPhone)}
                className="mt-2 flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 font-extrabold text-slate-700 hover:bg-slate-100"
              >
                <Search className="h-3.5 w-3.5" aria-hidden />
                {t("customerAddDialog.actions.recallExisting")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>
            {t("customerAddDialog.actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" className="flex-[2]" loading={saving}>
            <UserPlus className="h-4 w-4" aria-hidden />
            {t("customerAddDialog.actions.saveLink")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
