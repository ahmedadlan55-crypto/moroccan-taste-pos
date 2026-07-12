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

const TYPE_OPTS = [
  { value: "main", label: "رئيسي" },
  { value: "branch", label: "فرع" },
];
const SUPPLY_OPTS = [
  { value: "parent_company", label: "من الشركة الأم" },
  { value: "warehouse", label: "من المستودع" },
  { value: "auto", label: "تلقائي" },
];

const branchSchema = z.object({
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
  const qc = useQueryClient();
  const { toast } = useToast();
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
      toast({ title: initial ? "تم تحديث الفرع" : "تم إنشاء الفرع", tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "تعديل فرع" : "فرع جديد"}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="اسم الفرع" required error={errors.name} className="sm:col-span-2">
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label="الرمز" error={errors.code}>
            {({ id }) => <Input id={id} {...register("code")} />}
          </Field>
          <Field label="العلامة التجارية" error={errors.brandId}>
            {({ id }) => (
              <Select id={id} {...register("brandId")}>
                <option value="">بدون علامة</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="النوع" error={errors.type}>
            {({ id }) => <Select id={id} options={TYPE_OPTS} {...register("type")} />}
          </Field>
          <Field label="نمط التوريد" error={errors.supplyMode}>
            {({ id }) => <Select id={id} options={SUPPLY_OPTS} {...register("supplyMode")} />}
          </Field>
          <Field label="المدير" error={errors.manager}>
            {({ id }) => <Input id={id} {...register("manager")} />}
          </Field>
          <Field label="الموقع" error={errors.location}>
            {({ id }) => <Input id={id} {...register("location")} />}
          </Field>
        </div>
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

export default function BranchesPage() {
  const canManage = useCan("administration.branches");
  const [editing, setEditing] = useState<Branch | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: ["erp", "branches-full"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/branches-full", { signal }),
  });
  const rows = asArray<Branch>(query.data);

  const columns: ColumnDef<Branch>[] = [
    { id: "name", header: "الفرع", accessor: (r) => r.name, sortable: true },
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—" },
    { id: "brand", header: "العلامة", accessor: (r) => r.brandName || "—" },
    {
      id: "type",
      header: "النوع",
      accessor: (r) => (r.type === "main" ? "رئيسي" : "فرع"),
    },
    { id: "warehouse", header: "المستودع", accessor: (r) => r.warehouseName || "—" },
    { id: "manager", header: "المدير", accessor: (r) => r.manager || "—" },
    { id: "location", header: "الموقع", accessor: (r) => r.location || "—", defaultHidden: true },
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
        title="الفروع"
        subtitle="إدارة فروع نقاط البيع وربطها بالعلامات والمستودعات."
        action={
          canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> فرع جديد
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
        searchPlaceholder="بحث عن فرع…"
        exportFilename="branches.csv"
        tableId="admin-branches"
        emptyTitle="لا توجد فروع"
        mobileTitle={(r) => r.name}
        rowActions={
          canManage
            ? (r) => (
                <IconButton
                  aria-label={`تعديل ${r.name}`}
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
