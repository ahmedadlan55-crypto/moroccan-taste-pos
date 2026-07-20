import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Drawer, Button, Select, SegmentedControl, safeUserMessage } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
import { o2cApi, qk, type Customer } from "@/modules/sales/lib";
import { useCoaAccounts, useCostCenterDims } from "@/modules/banking/api";

const schema = z.object({
  name: z.string().min(1, "اسم العميل مطلوب"),
  nameEn: z.string().optional(),
  phone: z.string().optional(),
  vatRegistered: z.boolean().default(true),
  vatNumber: z.string().optional().refine((v) => !v || /^\d{15}$/.test(v), "الرقم الضريبي يجب أن يكون 15 رقمًا"),
  email: z.string().email("بريد غير صالح").optional().or(z.literal("")),
  city: z.string().optional(),
  street: z.string().optional(),
  buildingNumber: z.string().optional(),
  district: z.string().optional(),
  additionalNo: z.string().optional(),
  postalCode: z.string().optional(),
  defaultRevenueAccountId: z.string().optional(),
  defaultRevenueCostCenterId: z.string().optional(),
  customerType: z.enum(["B2C", "B2B", "B2G"]),
  creditLimit: z.coerce.number().min(0, "لا يمكن أن يكون سالبًا"),
  paymentTerms: z.string().min(1),
  creditDays: z.coerce.number().int().min(0),
});
type FormValues = z.infer<typeof schema>;

export function CustomerForm({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: Customer | null }) {
  const qc = useQueryClient();
  const editing = !!customer;
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: customer?.name ?? "", nameEn: customer?.nameEn ?? "", phone: customer?.phone ?? "",
      vatRegistered: customer?.vatRegistered ?? true,
      vatNumber: customer?.vatNumber ?? "", email: customer?.email ?? "", city: customer?.city ?? "",
      street: customer?.street ?? "", buildingNumber: customer?.buildingNumber ?? "",
      district: customer?.district ?? "", additionalNo: customer?.additionalNo ?? "", postalCode: customer?.postalCode ?? "",
      defaultRevenueAccountId: customer?.defaultRevenueAccountId ?? "", defaultRevenueCostCenterId: customer?.defaultRevenueCostCenterId ?? "",
      customerType: customer?.customerType ?? "B2C",
      creditLimit: customer?.creditLimit ?? 0, paymentTerms: customer?.paymentTerms ?? "Cash", creditDays: customer?.creditDays ?? 0,
    },
  });
  const vatRegistered = watch("vatRegistered");
  const coa = useCoaAccounts(open);
  const costCenters = useCostCenterDims();
  const revenueAccounts = (coa.data ?? []).filter((a) => a.isLeaf && a.code.startsWith("4"));

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      editing ? o2cApi.updateCustomer(customer!.id, values) : o2cApi.createCustomer(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.all });
      onClose();
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={UserPlus}
      eyebrow={editing ? "تعديل عميل" : "عميل جديد"}
      title={editing ? customer!.name : "إضافة عميل"}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
          <Button loading={mutation.isPending} onClick={handleSubmit((v) => mutation.mutate(v))}>
            {editing ? "حفظ التعديلات" : "حفظ العميل"}
          </Button>
        </div>
      }
    >
      <form className="grid grid-cols-1 gap-4" onSubmit={handleSubmit((v) => mutation.mutate(v))}>
        {mutation.isError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
            {safeUserMessage(mutation.error)}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 text-xs font-extrabold text-slate-500">المنشأة والتسجيل الضريبي</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="الاسم" required error={errors.name} className="sm:col-span-2">
              <input className="field w-full" aria-label="اسم العميل" {...register("name")} />
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
            <Field label="الرقم الفرعي للعنوان" hint="اختياري" className="sm:col-span-3"><input dir="ltr" className="field w-full tabular-nums sm:w-1/3" {...register("additionalNo")} /></Field>
          </div>
        </div>

        <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3">
          <div className="mb-2 text-xs font-extrabold text-teal-800">البيانات الافتراضية في المبيعات (اختياري)</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="حساب الإيرادات الافتراضي">
              <Select {...register("defaultRevenueAccountId")} disabled={coa.isLoading} placeholder="بدون">
                {revenueAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>
                ))}
              </Select>
            </Field>
            <Field label="مركز تكلفة الإيرادات الافتراضي">
              <Select {...register("defaultRevenueCostCenterId")} disabled={costCenters.isLoading} placeholder="بدون">
                {(costCenters.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="البريد الإلكتروني" error={errors.email}><input dir="ltr" className="field w-full" {...register("email")} /></Field>
          <Field label="نوع العميل">
            <select className="field w-full" {...register("customerType")}>
              <option value="B2C">أفراد B2C</option>
              <option value="B2B">شركات B2B</option>
              <option value="B2G">حكومي B2G</option>
            </select>
          </Field>
          <Field label="حد الائتمان" hint="0 = لا يُسمح بالبيع الآجل" error={errors.creditLimit}>
            <input dir="ltr" type="number" step="0.01" className="field w-full tabular-nums" {...register("creditLimit")} />
          </Field>
          <Field label="شروط السداد" hint="Cash = نقدي فقط"><input dir="ltr" className="field w-full" {...register("paymentTerms")} /></Field>
          <Field label="أيام الائتمان"><input dir="ltr" type="number" className="field w-full tabular-nums" {...register("creditDays")} /></Field>
        </div>
      </form>
    </Drawer>
  );
}
