import { useEffect } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2 } from "lucide-react";
import { Drawer, Button, Select, SegmentedControl, IconButton, safeUserMessage } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
import { useT, useLang } from "@/i18n";
import { useCoaAccounts, useCostCenterDims } from "@/modules/banking/api";
import {
  useSupplier, useCreateSupplier, useUpdateSupplier,
  useSupplierBeneficiaries, useSaveSupplierBeneficiary, useDeleteSupplierBeneficiary,
} from "@/modules/inventory/lib/hooks/useProcurement";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { supplierSchema, type SupplierInput } from "@/modules/inventory/lib/schemas/procurement.schema";

const EMPTY: SupplierInput = {
  name: "", nameEn: "", vatRegistered: true, vatNumber: "", phone: "", email: "",
  city: "", street: "", buildingNumber: "", district: "", additionalNo: "", postalCode: "",
  paymentTerms: "Cash", defaultExpenseAccountId: "", defaultExpenseCostCenterId: "", beneficiaries: [],
};

export function SupplierForm({ open, onClose, supplierId }: { open: boolean; onClose: () => void; supplierId?: string | null }) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const editing = !!supplierId;
  const detail = useSupplier(editing ? supplierId! : null);
  const beneficiaries = useSupplierBeneficiaries(editing ? supplierId! : null);

  const { register, handleSubmit, control, watch, reset, formState: { errors } } = useForm<SupplierInput>({
    resolver: zodResolver(supplierSchema),
    defaultValues: EMPTY,
  });
  const { fields, append, remove } = useFieldArray({ control, name: "beneficiaries" });
  const vatRegistered = watch("vatRegistered");

  useEffect(() => {
    if (!open) return;
    if (!editing) { reset(EMPTY); return; }
    if (!detail.data) return;
    const d = detail.data as Record<string, unknown>;
    reset({
      name: String(d.name ?? ""), nameEn: String(d.name_en ?? ""),
      vatRegistered: d.vat_registered == null ? true : !!Number(d.vat_registered),
      vatNumber: String(d.vat_number ?? ""), phone: String(d.phone ?? ""), email: String(d.email ?? ""),
      city: String(d.city ?? ""), street: String(d.street ?? ""), buildingNumber: String(d.building_number ?? ""),
      district: String(d.district ?? ""), additionalNo: String(d.additional_no ?? ""), postalCode: String(d.postal_code ?? ""),
      paymentTerms: (String(d.payment_terms ?? "Cash") as SupplierInput["paymentTerms"]),
      defaultExpenseAccountId: String(d.default_expense_account_id ?? ""),
      defaultExpenseCostCenterId: String(d.default_expense_cost_center_id ?? ""),
      beneficiaries: (beneficiaries.data ?? []).map((b) => ({
        serverId: b.id, bankName: b.bankName, accountName: b.accountName ?? "", accountNumber: b.accountNumber ?? "", iban: b.iban ?? "",
      })),
    });
  }, [open, editing, detail.data, beneficiaries.data, reset]);

  const coa = useCoaAccounts(open);
  const costCenters = useCostCenterDims();
  const expenseAccounts = (coa.data ?? []).filter((a) => a.isLeaf && a.code.startsWith("5"));

  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const saveBeneficiary = useSaveSupplierBeneficiary();
  const deleteBeneficiary = useDeleteSupplierBeneficiary();
  const saving = createSupplier.isPending || updateSupplier.isPending || saveBeneficiary.isPending;
  const saveError = createSupplier.error || updateSupplier.error;

  function removeBeneficiary(index: number) {
    const row = fields[index] as unknown as { serverId?: string };
    if (row.serverId && supplierId) deleteBeneficiary.mutate({ supplierId, beneficiaryId: row.serverId });
    remove(index);
  }

  async function onSubmit(values: SupplierInput) {
    const { beneficiaries: rows, ...body } = values;
    let targetId = supplierId ?? "";
    if (editing) {
      await updateSupplier.mutateAsync({ id: supplierId!, body });
    } else {
      const res = await createSupplier.mutateAsync(body);
      targetId = res.data?.id ?? "";
    }
    if (targetId) {
      for (const b of rows) {
        if (!b.serverId && b.bankName.trim()) {
          await saveBeneficiary.mutateAsync({
            supplierId: targetId,
            body: { bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber, iban: b.iban },
          });
        }
      }
    }
    qc.invalidateQueries({ queryKey: queryKeys.procurement.suppliers.all });
    onClose();
  }

  // Editing title shows the record's own name (business data); prefer the
  // English name in the English UI when the record carries one.
  const editRecord = detail.data as Record<string, unknown> | undefined;
  const editTitle = lang === "en" && editRecord?.name_en ? String(editRecord.name_en) : String(editRecord?.name ?? "");

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={Building2}
      /* Release integration — sprint's t() side is kept (its editTitle also
         prefers name_en in the English UI, which the accounting side could not
         do). The accounting side's real change here was the create-mode title
         "إضافة مورد" -> "إضافة مورد جديد" (closure-gate fix af80f2f: the old
         title collided with the eyebrow "مورد جديد"). That fix now lives in
         the dictionary — see purchasing.suppliers.form.addTitle in
         i18n/dictionaries/ar. Resolving to sprint's side alone would have
         silently reverted it, with no conflict marker pointing anywhere. */
      eyebrow={editing ? t("purchasing.suppliers.form.editEyebrow") : t("purchasing.suppliers.newSupplier")}
      title={editing ? editTitle : t("purchasing.suppliers.form.addTitle")}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button loading={saving} onClick={handleSubmit(onSubmit)}>{editing ? t("purchasing.common.saveChanges") : t("purchasing.suppliers.form.saveSupplier")}</Button>
        </div>
      }
    >
      <form className="grid grid-cols-1 gap-4" onSubmit={handleSubmit(onSubmit)}>
        {saveError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {safeUserMessage(saveError)}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">{t("purchasing.suppliers.form.entityVatSection")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("purchasing.suppliers.form.name")} required error={errors.name} className="sm:col-span-2">
              <input className="field w-full" aria-label={t("purchasing.suppliers.form.name")} {...register("name")} />
            </Field>
            <Field label={t("purchasing.suppliers.form.nameEn")}><input dir="ltr" className="field w-full" {...register("nameEn")} /></Field>
            <Field label={t("purchasing.suppliers.field.phone")}><input dir="ltr" className="field w-full tabular-nums" {...register("phone")} /></Field>
            <Field label={t("purchasing.suppliers.form.vatRegistration")} className="sm:col-span-2">
              <Controller
                control={control}
                name="vatRegistered"
                render={({ field }) => (
                  <SegmentedControl
                    aria-label={t("purchasing.suppliers.form.vatRegistration")}
                    value={field.value ? "registered" : "unregistered"}
                    onChange={(v) => field.onChange(v === "registered")}
                    options={[
                      { value: "registered", label: t("purchasing.suppliers.form.vatRegistered") },
                      { value: "unregistered", label: t("purchasing.suppliers.form.vatUnregistered") },
                    ]}
                  />
                )}
              />
            </Field>
            {vatRegistered && (
              <Field label={t("purchasing.suppliers.field.vatNumber")} error={errors.vatNumber} className="sm:col-span-2">
                <input dir="ltr" className="field w-full tabular-nums" {...register("vatNumber")} />
              </Field>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">{t("purchasing.suppliers.form.addressSection")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t("purchasing.suppliers.field.city")}><input className="field w-full" {...register("city")} /></Field>
            <Field label={t("purchasing.suppliers.field.district")}><input className="field w-full" {...register("district")} /></Field>
            <Field label={t("purchasing.suppliers.field.postalCode")}><input dir="ltr" className="field w-full tabular-nums" {...register("postalCode")} /></Field>
            <Field label={t("purchasing.suppliers.field.street")} className="sm:col-span-2"><input className="field w-full" {...register("street")} /></Field>
            <Field label={t("purchasing.suppliers.field.buildingNumber")}><input dir="ltr" className="field w-full tabular-nums" {...register("buildingNumber")} /></Field>
            <Field label={t("purchasing.suppliers.form.additionalNo")} hint={t("purchasing.common.optional")} className="sm:col-span-3">
              <input dir="ltr" className="field w-full tabular-nums sm:w-1/3" {...register("additionalNo")} />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("purchasing.suppliers.form.email")} error={errors.email}><input dir="ltr" className="field w-full" {...register("email")} /></Field>
          <Field label={t("purchasing.suppliers.field.paymentTerms")}>
            <select className="field w-full" {...register("paymentTerms")}>
              <option value="Cash">{t("purchasing.suppliers.form.termCash")}</option>
              <option value="Net30">{t("purchasing.suppliers.form.termNet30")}</option>
              <option value="Net60">{t("purchasing.suppliers.form.termNet60")}</option>
            </select>
          </Field>
        </div>

        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3">
          <div className="mb-2 text-xs font-extrabold text-teal-800">{t("purchasing.suppliers.form.defaultsSection")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("purchasing.suppliers.form.defaultExpenseAccount")}>
              <Select {...register("defaultExpenseAccountId")} disabled={coa.isLoading} placeholder={t("purchasing.suppliers.form.none")}>
                {expenseAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("purchasing.suppliers.form.defaultCostCenter")}>
              <Select {...register("defaultExpenseCostCenterId")} disabled={costCenters.isLoading} placeholder={t("purchasing.suppliers.form.none")}>
                {(costCenters.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-extrabold text-slate-500">{t("purchasing.suppliers.form.beneficiariesSection")}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => append({ bankName: "", accountName: "", accountNumber: "", iban: "" })}
            >
              <Plus className="h-4 w-4" /> {t("purchasing.suppliers.form.addBeneficiary")}
            </Button>
          </div>
          {fields.length === 0 ? (
            <p className="px-1 py-2 text-xs font-semibold text-slate-400">{t("purchasing.suppliers.form.noBeneficiaries")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-100 bg-slate-50/60 p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  <input className="field w-full" placeholder={t("purchasing.suppliers.form.bankName")} {...register(`beneficiaries.${i}.bankName` as const)} />
                  <input className="field w-full" placeholder={t("purchasing.suppliers.form.accountName")} {...register(`beneficiaries.${i}.accountName` as const)} />
                  <input dir="ltr" className="field w-full tabular-nums" placeholder={t("purchasing.suppliers.form.accountNumber")} {...register(`beneficiaries.${i}.accountNumber` as const)} />
                  <input dir="ltr" className="field w-full tabular-nums" placeholder="IBAN" {...register(`beneficiaries.${i}.iban` as const)} />
                  <IconButton aria-label={t("purchasing.suppliers.form.removeBeneficiary")} variant="secondary" onClick={() => removeBeneficiary(i)}>
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      </form>
    </Drawer>
  );
}
