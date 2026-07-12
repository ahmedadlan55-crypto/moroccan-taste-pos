import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Toggle,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { formatNumber } from "@/shared/lib";
import { useCan } from "@/app/providers";
import { asArray, ensureAck, type MutationAck } from "../_common";

interface PaymentMethod {
  id: number | string;
  name: string;
  nameAr: string;
  groupType: string;
  isActive: boolean;
  sortOrder: number;
  serviceFeeType: string;
  serviceFeeValue: number;
  serviceFeeRate: number;
  description: string;
  color?: string;
  [key: string]: unknown;
}

const GROUP_OPTS = [
  { value: "cash", label: "نقد" },
  { value: "card", label: "شبكة / بطاقة" },
  { value: "transfer", label: "تحويل بنكي" },
  { value: "credit", label: "آجل" },
  { value: "wallet", label: "محفظة إلكترونية" },
];
const GROUP_AR = new Map(GROUP_OPTS.map((g) => [g.value, g.label]));
const FEE_OPTS = [
  { value: "none", label: "بدون رسوم" },
  { value: "percent", label: "نسبة مئوية %" },
  { value: "fixed", label: "مبلغ ثابت" },
];

const pmSchema = z.object({
  name: arabicText({ label: "اسم طريقة الدفع", max: 120 }),
  nameAr: z.string().trim().max(120).optional().or(z.literal("")),
  groupType: z.string(),
  serviceFeeType: z.string(),
  serviceFeeValue: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || (!Number.isNaN(Number(v)) && Number(v) >= 0), "قيمة غير صحيحة"),
  sortOrder: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || !Number.isNaN(Number(v)), "أدخل رقمًا"),
  isActive: z.boolean(),
  description: z.string().trim().max(300).optional().or(z.literal("")),
});
type PmForm = z.infer<typeof pmSchema>;

function PaymentMethodDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: PaymentMethod | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PmForm>({
    resolver: zodResolver(pmSchema),
    defaultValues: {
      name: "",
      nameAr: "",
      groupType: "cash",
      serviceFeeType: "none",
      serviceFeeValue: "",
      sortOrder: "",
      isActive: true,
      description: "",
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      name: initial?.name ?? "",
      nameAr: initial?.nameAr ?? "",
      groupType: initial?.groupType || "cash",
      serviceFeeType: initial?.serviceFeeType || "none",
      serviceFeeValue: initial != null ? String(initial.serviceFeeValue ?? "") : "",
      sortOrder: initial != null ? String(initial.sortOrder ?? "") : "",
      isActive: initial?.isActive ?? true,
      description: initial?.description ?? "",
    });
  }, [open, initial, reset]);

  const mutation = useMutation({
    mutationFn: async (values: PmForm) => {
      // Spread the existing record first so flags/GL/color the form doesn't edit
      // survive the update (the POST writes every column directly).
      const payload = {
        ...(initial ?? {}),
        name: values.name,
        nameAr: values.nameAr || values.name,
        groupType: values.groupType,
        serviceFeeType: values.serviceFeeType,
        serviceFeeValue: values.serviceFeeValue ? Number(values.serviceFeeValue) : 0,
        sortOrder: values.sortOrder ? Number(values.sortOrder) : 0,
        isActive: values.isActive,
        description: values.description ?? "",
      };
      return ensureAck(await apiClient.post<MutationAck>("/settings/payment-methods-full", payload));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "payment-methods-full"] });
      toast({ title: initial ? "تم تحديث طريقة الدفع" : "تم إنشاء طريقة الدفع", tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "تعديل طريقة دفع" : "طريقة دفع جديدة"}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الاسم" required error={errors.name}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label="الاسم بالعربية" error={errors.nameAr}>
            {({ id }) => <Input id={id} {...register("nameAr")} />}
          </Field>
          <Field label="المجموعة" error={errors.groupType}>
            {({ id }) => <Select id={id} options={GROUP_OPTS} {...register("groupType")} />}
          </Field>
          <Field label="نوع الرسوم" error={errors.serviceFeeType}>
            {({ id }) => <Select id={id} options={FEE_OPTS} {...register("serviceFeeType")} />}
          </Field>
          <Field label="قيمة الرسوم" error={errors.serviceFeeValue} hint="نسبة أو مبلغ حسب النوع">
            {({ id, invalid }) => <Input id={id} dir="ltr" inputMode="decimal" invalid={invalid} {...register("serviceFeeValue")} />}
          </Field>
          <Field label="الترتيب" error={errors.sortOrder}>
            {({ id, invalid }) => <Input id={id} dir="ltr" inputMode="numeric" invalid={invalid} {...register("sortOrder")} />}
          </Field>
          <Field label="وصف" error={errors.description} className="sm:col-span-2">
            {({ id }) => <Input id={id} {...register("description")} />}
          </Field>
        </div>
        <Toggle checked={watch("isActive")} onChange={(v) => setValue("isActive", v)} label="طريقة نشطة" />
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            إلغاء
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {initial ? "حفظ التغييرات" : "إنشاء"}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

export default function PaymentMethodsPage() {
  const canManage = useCan("administration.payment-methods");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<PaymentMethod | null>(null);

  const query = useQuery({
    queryKey: ["settings", "payment-methods-full"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/settings/payment-methods-full", { signal }),
  });
  const rows = asArray<PaymentMethod>(query.data);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      ensureAck(await apiClient.delete<MutationAck>(`/settings/payment-methods-full/${id}`)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "payment-methods-full"] });
      toast({ title: "تم حذف طريقة الدفع", tone: "success" });
      setDeleting(null);
    },
    onError: (e: Error) => toast({ title: "تعذّر الحذف", description: e.message, tone: "error" }),
  });

  const feeText = (m: PaymentMethod): string => {
    if (m.serviceFeeType === "percent") return `${formatNumber(m.serviceFeeValue)}%`;
    if (m.serviceFeeType === "fixed") return formatNumber(m.serviceFeeValue);
    if (m.serviceFeeRate) return `${formatNumber(m.serviceFeeRate * 100)}%`;
    return "—";
  };

  const columns: ColumnDef<PaymentMethod>[] = [
    {
      id: "name",
      header: "طريقة الدفع",
      accessor: (r) => r.nameAr || r.name,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span
            className="h-3 w-3 shrink-0 rounded-full border border-slate-200"
            style={{ backgroundColor: r.color || undefined }}
            aria-hidden="true"
          />
          {r.nameAr || r.name}
        </span>
      ),
      sortable: true,
    },
    { id: "group", header: "المجموعة", accessor: (r) => GROUP_AR.get(r.groupType) ?? r.groupType },
    { id: "fee", header: "الرسوم", accessor: (r) => feeText(r) },
    { id: "sort", header: "الترتيب", accessor: (r) => r.sortOrder ?? 0, numeric: true, sortable: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge>{r.isActive ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="طرق الدفع"
        subtitle="طرق الدفع المتاحة في نقاط البيع، رسومها ومجموعاتها المحاسبية."
        action={
          canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> طريقة جديدة
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث عن طريقة دفع…"
        exportFilename="payment-methods.csv"
        tableId="admin-payment-methods"
        initialSort={{ columnId: "sort", dir: "asc" }}
        emptyTitle="لا توجد طرق دفع"
        mobileTitle={(r) => r.nameAr || r.name}
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-label={`تعديل ${r.nameAr || r.name}`}
                    size="sm"
                    onClick={() => {
                      setEditing(r);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={`حذف ${r.nameAr || r.name}`}
                    size="sm"
                    variant="danger"
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              )
            : undefined
        }
      />
      <PaymentMethodDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
      <ConfirmDialog
        open={!!deleting}
        title="حذف طريقة الدفع"
        description={deleting ? `سيتم حذف «${deleting.nameAr || deleting.name}».` : ""}
        tone="danger"
        confirmLabel="حذف"
        processing={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : null}
        onConfirm={() => deleting && deleteMutation.mutate(String(deleting.id))}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
