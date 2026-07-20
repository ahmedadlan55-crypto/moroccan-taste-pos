import { useEffect } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2 } from "lucide-react";
import { Drawer, Button, Select, SegmentedControl, IconButton, safeUserMessage } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
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

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={Building2}
      eyebrow={editing ? "تعديل مورد" : "مورد جديد"}
      title={editing ? String((detail.data as Record<string, unknown> | undefined)?.name ?? "") : "إضافة مورد"}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button loading={saving} onClick={handleSubmit(onSubmit)}>{editing ? "حفظ التعديلات" : "حفظ المورد"}</Button>
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
          <div className="mb-2 text-xs font-extrabold text-slate-500">المنشأة والتسجيل الضريبي</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="اسم المورد" required error={errors.name} className="sm:col-span-2">
              <input className="field w-full" aria-label="اسم المورد" {...register("name")} />
            </Field>
            <Field label="الاسم بالإنجليزية"><input dir="ltr" className="field w-full" {...register("nameEn")} /></Field>
            <Field label="الهاتف"><input dir="ltr" className="field w-full tabular-nums" {...register("phone")} /></Field>
            <Field label="التسجيل في ضريبة القيمة المضافة" className="sm:col-span-2">
              <Controller
                control={control}
                name="vatRegistered"
                render={({ field }) => (
                  <SegmentedControl
                    aria-label="التسجيل في ضريبة القيمة المضافة"
                    value={field.value ? "registered" : "unregistered"}
                    onChange={(v) => field.onChange(v === "registered")}
                    options={[
                      { value: "registered", label: "مسجَّل في الضريبة" },
                      { value: "unregistered", label: "غير مسجَّل" },
                    ]}
                  />
                )}
              />
            </Field>
            {vatRegistered && (
              <Field label="الرقم الضريبي" error={errors.vatNumber} className="sm:col-span-2">
                <input dir="ltr" className="field w-full tabular-nums" {...register("vatNumber")} />
              </Field>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">العنوان</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="المدينة"><input className="field w-full" {...register("city")} /></Field>
            <Field label="الحي"><input className="field w-full" {...register("district")} /></Field>
            <Field label="الرمز البريدي"><input dir="ltr" className="field w-full tabular-nums" {...register("postalCode")} /></Field>
            <Field label="الشارع" className="sm:col-span-2"><input className="field w-full" {...register("street")} /></Field>
            <Field label="رقم المبنى"><input dir="ltr" className="field w-full tabular-nums" {...register("buildingNumber")} /></Field>
            <Field label="الرقم الفرعي للعنوان" hint="اختياري" className="sm:col-span-3">
              <input dir="ltr" className="field w-full tabular-nums sm:w-1/3" {...register("additionalNo")} />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="البريد الإلكتروني" error={errors.email}><input dir="ltr" className="field w-full" {...register("email")} /></Field>
          <Field label="شروط الدفع">
            <select className="field w-full" {...register("paymentTerms")}>
              <option value="Cash">نقدي Cash</option>
              <option value="Net30">آجل 30 يومًا</option>
              <option value="Net60">آجل 60 يومًا</option>
            </select>
          </Field>
        </div>

        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3">
          <div className="mb-2 text-xs font-extrabold text-teal-800">البيانات الافتراضية في المشتريات (اختياري)</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="حساب المصروفات الافتراضي">
              <Select {...register("defaultExpenseAccountId")} disabled={coa.isLoading} placeholder="بدون">
                {expenseAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </Select>
            </Field>
            <Field label="مركز تكلفة المصروفات الافتراضي">
              <Select {...register("defaultExpenseCostCenterId")} disabled={costCenters.isLoading} placeholder="بدون">
                {(costCenters.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-extrabold text-slate-500">المستفيدون (اختياري)</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => append({ bankName: "", accountName: "", accountNumber: "", iban: "" })}
            >
              <Plus className="h-4 w-4" /> أضف مستفيد
            </Button>
          </div>
          {fields.length === 0 ? (
            <p className="px-1 py-2 text-xs font-semibold text-slate-400">لا يوجد مستفيدون بعد.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-100 bg-slate-50/60 p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  <input className="field w-full" placeholder="اسم البنك" {...register(`beneficiaries.${i}.bankName` as const)} />
                  <input className="field w-full" placeholder="اسم صاحب الحساب" {...register(`beneficiaries.${i}.accountName` as const)} />
                  <input dir="ltr" className="field w-full tabular-nums" placeholder="رقم الحساب" {...register(`beneficiaries.${i}.accountNumber` as const)} />
                  <input dir="ltr" className="field w-full tabular-nums" placeholder="IBAN" {...register(`beneficiaries.${i}.iban` as const)} />
                  <IconButton aria-label="حذف المستفيد" variant="secondary" onClick={() => removeBeneficiary(i)}>
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
