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

/** Mirrors legacy doSave's guards (app.js:1820-1822). Returns the error text
 *  or null when valid — pure, unit-testable. */
export function validateNewCustomer(name: string, phone: string): string | null {
  if (!name.trim()) return "اسم العميل مطلوب";
  if (!phone.trim()) return "رقم الهاتف مطلوب";
  if (phone.trim().length < 5) return "رقم الهاتف قصير جداً (5 أرقام على الأقل)";
  return null;
}

export function CustomerAddDialog({ open, onClose, onCreated, prefill, onRecallExisting }: CustomerAddDialogProps) {
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
      setError(invalid);
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
      setError(err.message || "فشل حفظ العميل");
      // Duplicate phone (legacy :1883): offer to recall the existing customer.
      if (/duplicate|dup_entry|مسجل|موجود/i.test(err.message || "")) setDupPhone(phone.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="إضافة عميل جديد" widthClass="max-w-md" locked={saving}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-extrabold text-slate-500">الاسم *</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoComplete="off"
            className="field"
            placeholder="محمد أحمد"
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-extrabold text-slate-500">الهاتف *</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={20}
            autoComplete="off"
            className="field num"
            dir="ltr"
            placeholder="05xxxxxxxx"
          />
        </label>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">الرقم الضريبي (اختياري)</span>
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
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">نوع العميل</span>
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as typeof customerType)}
              className="field"
            >
              <option value="B2C">أفراد · B2C</option>
              <option value="B2B">شركات · B2B</option>
              <option value="B2G">حكومي · B2G</option>
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
                استدعاء العميل الموجود
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button type="submit" variant="primary" className="flex-[2]" loading={saving}>
            <UserPlus className="h-4 w-4" aria-hidden />
            حفظ وربط
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
