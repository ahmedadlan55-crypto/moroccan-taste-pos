import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import { asArray, ensureAck, type MutationAck } from "../_common";

interface Branch {
  id: string;
  code: string;
  name: string;
  location: string;
  type: string;
  isActive: boolean;
  brandId: string;
  brandName: string;
  warehouseId: string;
  warehouseName: string;
  costCenterId: string;
  costCenterName: string;
  manager: string;
  supplyMode: string;
  companyName: string;
}
interface BrandLite {
  id: string;
  name: string;
}

const TYPE_VALUES = ["main", "branch"] as const;
const SUPPLY_VALUES = ["parent_company", "warehouse", "auto"] as const;

const branchSchema = z.object({
  // arabicText's interpolated {label} message stays Arabic (shared-primitives contract).
  name: arabicText({ label: "اسم الفرع" }),
  code: z.string().trim().max(20).optional().or(z.literal("")),
  brandId: z.string().optional().or(z.literal("")),
  location: z.string().trim().max(500).optional().or(z.literal("")),
  manager: z.string().trim().max(100).optional().or(z.literal("")),
  type: z.string(),
  supplyMode: z.string(),
});
type BranchForm = z.infer<typeof branchSchema>;

function BranchFormDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Branch | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const typeOptions = TYPE_VALUES.map((v) => ({ value: v, label: t(`administration.branches.typeOpt.${v}`) }));
  const supplyOptions = SUPPLY_VALUES.map((v) => ({ value: v, label: t(`administration.branches.supplyOpt.${v}`) }));
  const brandsQuery = useQuery({
    queryKey: ["erp", "brands"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/brands", { signal }),
    enabled: open,
  });
  const brands = asArray<BrandLite>(brandsQuery.data);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BranchForm>({
    resolver: zodResolver(branchSchema),
    defaultValues: {
      name: "",
      code: "",
      brandId: "",
      location: "",
      manager: "",
      type: "branch",
      supplyMode: "parent_company",
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      name: initial?.name ?? "",
      code: initial?.code ?? "",
      brandId: initial?.brandId ?? "",
      location: initial?.location ?? "",
      manager: initial?.manager ?? "",
      type: initial?.type || "branch",
      supplyMode: initial?.supplyMode || "parent_company",
    });
  }, [open, initial, reset]);

  const mutation = useMutation({
    mutationFn: async (values: BranchForm) => {
      // Preserve the warehouse / cost-center / company links the form doesn't
      // edit so an UPDATE doesn't wipe them (the POST writes them directly).
      const res = await apiClient.post<MutationAck>("/erp/branches-full", {
        id: initial?.id,
        ...values,
        warehouseId: initial?.warehouseId || "",
        costCenterId: initial?.costCenterId || "",
        companyName: initial?.companyName || "",
      });
      return ensureAck(res);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "branches-full"] });
      toast({ title: initial ? t("administration.branches.toast.updated") : t("administration.branches.toast.created"), tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: t("administration.branches.toast.saveFailed"), description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? t("administration.branches.form.editTitle") : t("administration.branches.form.createTitle")}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("administration.branches.form.name")} required error={errors.name} className="sm:col-span-2">
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label={t("administration.branches.form.code")} error={errors.code}>
            {({ id }) => <Input id={id} {...register("code")} />}
          </Field>
          <Field label={t("administration.branches.form.brand")} error={errors.brandId}>
            {({ id }) => (
              <Select id={id} {...register("brandId")}>
                <option value="">{t("administration.branches.form.brandNone")}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("administration.branches.form.type")} error={errors.type}>
            {({ id }) => <Select id={id} options={typeOptions} {...register("type")} />}
          </Field>
          <Field label={t("administration.branches.form.supplyMode")} error={errors.supplyMode}>
            {({ id }) => <Select id={id} options={supplyOptions} {...register("supplyMode")} />}
          </Field>
          <Field label={t("administration.branches.form.manager")} error={errors.manager}>
            {({ id }) => <Input id={id} {...register("manager")} />}
          </Field>
          <Field label={t("administration.branches.form.location")} error={errors.location}>
            {({ id }) => <Input id={id} {...register("location")} />}
          </Field>
        </div>
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {initial ? t("administration.branches.form.saveChanges") : t("administration.branches.form.create")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

export default function BranchesPage() {
  const t = useT();
  const canManage = useCan("administration.branches");
  const [editing, setEditing] = useState<Branch | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: ["erp", "branches-full"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/branches-full", { signal }),
  });
  const rows = asArray<Branch>(query.data);

  const columns: ColumnDef<Branch>[] = [
    { id: "name", header: t("administration.branches.col.branch"), accessor: (r) => r.name, sortable: true },
    { id: "code", header: t("administration.branches.col.code"), accessor: (r) => r.code || "—" },
    { id: "brand", header: t("administration.branches.col.brand"), accessor: (r) => r.brandName || "—" },
    {
      id: "type",
      header: t("administration.branches.col.type"),
      accessor: (r) => t(r.type === "main" ? "administration.branches.typeMain" : "administration.branches.typeBranch"),
    },
    { id: "warehouse", header: t("administration.branches.col.warehouse"), accessor: (r) => r.warehouseName || "—" },
    { id: "manager", header: t("administration.branches.col.manager"), accessor: (r) => r.manager || "—" },
    { id: "location", header: t("administration.branches.col.location"), accessor: (r) => r.location || "—", defaultHidden: true },
    {
      id: "status",
      header: t("administration.branches.col.status"),
      accessor: (r) => t(r.isActive ? "status.active" : "status.disabled"),
      cell: (r) => <StatusBadge>{r.isActive ? "active" : "disabled"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.branches.title")}
        subtitle={t("administration.branches.subtitle")}
        action={
          canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> {t("administration.branches.newBtn")}
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder={t("administration.branches.searchPlaceholder")}
        exportFilename="branches.csv"
        tableId="admin-branches"
        emptyTitle={t("administration.branches.empty")}
        mobileTitle={(r) => r.name}
        rowActions={
          canManage
            ? (r) => (
                <IconButton
                  aria-label={t("administration.branches.editAria", { name: r.name })}
                  size="sm"
                  onClick={() => {
                    setEditing(r);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
              )
            : undefined
        }
      />
      <BranchFormDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
