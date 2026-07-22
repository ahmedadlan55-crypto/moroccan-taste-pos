import { useEffect, useMemo, useState } from "react";
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
import { useT, type TFunction } from "@/i18n";
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

const GROUP_VALUES = ["cash", "card", "transfer", "credit", "wallet"] as const;
const FEE_VALUES = ["none", "percent", "fixed"] as const;

function makePmSchema(t: TFunction) {
  return z.object({
    // arabicText's interpolated {label} message stays Arabic (shared-primitives contract).
    name: arabicText({ label: "اسم طريقة الدفع", max: 120 }),
    nameAr: z.string().trim().max(120).optional().or(z.literal("")),
    groupType: z.string(),
    serviceFeeType: z.string(),
    serviceFeeValue: z
      .string()
      .trim()
      .optional()
      .or(z.literal(""))
      .refine((v) => !v || (!Number.isNaN(Number(v)) && Number(v) >= 0), t("administration.payments.err.invalidValue")),
    sortOrder: z
      .string()
      .trim()
      .optional()
      .or(z.literal(""))
      .refine((v) => !v || !Number.isNaN(Number(v)), t("administration.payments.err.invalidNumber")),
    isActive: z.boolean(),
    description: z.string().trim().max(300).optional().or(z.literal("")),
  });
}
type PmForm = z.infer<ReturnType<typeof makePmSchema>>;

function PaymentMethodDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: PaymentMethod | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schema = useMemo(() => makePmSchema(t), [t]);
  const groupOptions = useMemo(() => GROUP_VALUES.map((v) => ({ value: v, label: t(`administration.payments.group.${v}`) })), [t]);
  const feeOptions = useMemo(() => FEE_VALUES.map((v) => ({ value: v, label: t(`administration.payments.fee.${v}`) })), [t]);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PmForm>({
    resolver: zodResolver(schema),
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
      toast({ title: initial ? t("administration.payments.toast.updated") : t("administration.payments.toast.created"), tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: t("administration.payments.toast.saveFailed"), description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? t("administration.payments.form.editTitle") : t("administration.payments.form.createTitle")}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("administration.payments.form.name")} required error={errors.name}>
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label={t("administration.payments.form.nameAr")} error={errors.nameAr}>
            {({ id }) => <Input id={id} {...register("nameAr")} />}
          </Field>
          <Field label={t("administration.payments.form.group")} error={errors.groupType}>
            {({ id }) => <Select id={id} options={groupOptions} {...register("groupType")} />}
          </Field>
          <Field label={t("administration.payments.form.feeType")} error={errors.serviceFeeType}>
            {({ id }) => <Select id={id} options={feeOptions} {...register("serviceFeeType")} />}
          </Field>
          <Field label={t("administration.payments.form.feeValue")} error={errors.serviceFeeValue} hint={t("administration.payments.form.feeValueHint")}>
            {({ id, invalid }) => <Input id={id} dir="ltr" inputMode="decimal" invalid={invalid} {...register("serviceFeeValue")} />}
          </Field>
          <Field label={t("administration.payments.form.sortOrder")} error={errors.sortOrder}>
            {({ id, invalid }) => <Input id={id} dir="ltr" inputMode="numeric" invalid={invalid} {...register("sortOrder")} />}
          </Field>
          <Field label={t("administration.payments.form.description")} error={errors.description} className="sm:col-span-2">
            {({ id }) => <Input id={id} {...register("description")} />}
          </Field>
        </div>
        <Toggle checked={watch("isActive")} onChange={(v) => setValue("isActive", v)} label={t("administration.payments.form.activeToggle")} />
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {initial ? t("administration.payments.form.saveChanges") : t("administration.payments.form.create")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

export default function PaymentMethodsPage() {
  const t = useT();
  const canManage = useCan("administration.payment-methods");
  const qc = useQueryClient();
  const { toast } = useToast();
  const groupLabel = (v: string) => (GROUP_VALUES.includes(v as (typeof GROUP_VALUES)[number]) ? t(`administration.payments.group.${v}`) : v);
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
      toast({ title: t("administration.payments.toast.deleted"), tone: "success" });
      setDeleting(null);
    },
    onError: (e: Error) => toast({ title: t("administration.payments.toast.deleteFailed"), description: e.message, tone: "error" }),
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
      header: t("administration.payments.col.name"),
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
    { id: "group", header: t("administration.payments.col.group"), accessor: (r) => groupLabel(r.groupType) },
    { id: "fee", header: t("administration.payments.col.fee"), accessor: (r) => feeText(r) },
    { id: "sort", header: t("administration.payments.col.sort"), accessor: (r) => r.sortOrder ?? 0, numeric: true, sortable: true },
    {
      id: "status",
      header: t("administration.payments.col.status"),
      accessor: (r) => t(r.isActive ? "status.active" : "status.disabled"),
      cell: (r) => <StatusBadge>{r.isActive ? "active" : "disabled"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.payments.title")}
        subtitle={t("administration.payments.subtitle")}
        action={
          canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> {t("administration.payments.newBtn")}
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
        searchPlaceholder={t("administration.payments.searchPlaceholder")}
        exportFilename="payment-methods.csv"
        tableId="admin-payment-methods"
        initialSort={{ columnId: "sort", dir: "asc" }}
        emptyTitle={t("administration.payments.empty")}
        mobileTitle={(r) => r.nameAr || r.name}
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-label={t("administration.payments.editAria", { name: r.nameAr || r.name })}
                    size="sm"
                    onClick={() => {
                      setEditing(r);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={t("administration.payments.deleteAria", { name: r.nameAr || r.name })}
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
        title={t("administration.payments.deleteTitle")}
        description={deleting ? t("administration.payments.deleteDesc", { name: deleting.nameAr || deleting.name }) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : null}
        onConfirm={() => deleting && deleteMutation.mutate(String(deleting.id))}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
