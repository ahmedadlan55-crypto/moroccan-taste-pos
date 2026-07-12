import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Drawer, Button, safeUserMessage } from "@/shared/ui";
import { Field, zodResolver } from "@/shared/forms";
import { o2cApi, qk, type Customer } from "@/modules/sales/lib";

const schema = z.object({
  name: z.string().min(1, "اسم العميل مطلوب"),
  nameEn: z.string().optional(),
  phone: z.string().optional(),
  vatNumber: z.string().optional().refine((v) => !v || /^\d{15}$/.test(v), "الرقم الضريبي يجب أن يكون 15 رقمًا"),
  email: z.string().email("بريد غير صالح").optional().or(z.literal("")),
  city: z.string().optional(),
  customerType: z.enum(["B2C", "B2B", "B2G"]),
  creditLimit: z.coerce.number().min(0, "لا يمكن أن يكون سالبًا"),
  paymentTerms: z.string().min(1),
  creditDays: z.coerce.number().int().min(0),
});
type FormValues = z.infer<typeof schema>;

export function CustomerForm({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: Customer | null }) {
  const qc = useQueryClient();
  const editing = !!customer;
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: customer?.name ?? "", nameEn: customer?.nameEn ?? "", phone: customer?.phone ?? "",
      vatNumber: customer?.vatNumber ?? "", email: customer?.email ?? "", city: customer?.city ?? "",
      customerType: customer?.customerType ?? "B2C",
      creditLimit: customer?.creditLimit ?? 0, paymentTerms: customer?.paymentTerms ?? "Cash", creditDays: customer?.creditDays ?? 0,
    },
  });

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
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={handleSubmit((v) => mutation.mutate(v))}>
        {mutation.isError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700 sm:col-span-2">
            {safeUserMessage(mutation.error)}
          </div>
        )}
        <Field label="الاسم" required error={errors.name} className="sm:col-span-2">
          <input className="field w-full" aria-label="اسم العميل" {...register("name")} />
        </Field>
        <Field label="الاسم بالإنجليزية"><input dir="ltr" className="field w-full" {...register("nameEn")} /></Field>
        <Field label="الهاتف"><input dir="ltr" className="field w-full tabular-nums" {...register("phone")} /></Field>
        <Field label="الرقم الضريبي" error={errors.vatNumber}><input dir="ltr" className="field w-full tabular-nums" {...register("vatNumber")} /></Field>
        <Field label="البريد الإلكتروني" error={errors.email}><input dir="ltr" className="field w-full" {...register("email")} /></Field>
        <Field label="المدينة"><input className="field w-full" {...register("city")} /></Field>
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
      </form>
    </Drawer>
  );
}
