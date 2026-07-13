import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Pencil, Plus, Tags, Trash2, Wand2 } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
  Toggle,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { useCan } from "@/app/providers";
import { asArray, ensureAck, type MutationAck } from "../_common";
import { BrandWizard } from "../brand-wizard";

// ── Types (mapped from the raw /api/erp JSON) ────────────────────────────────
interface Company {
  id: string;
  name: string;
  legalName: string;
  crNumber: string;
  taxNumber: string;
  country: string;
  city: string;
  baseCurrency: string;
  isActive: boolean;
}
interface BrandStat {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  branchCount: number;
  menuCount: number;
  employeeCount: number;
}

const CURRENCIES = [
  { value: "SAR", label: "ريال سعودي (SAR)" },
  { value: "AED", label: "درهم إماراتي (AED)" },
  { value: "USD", label: "دولار أمريكي (USD)" },
  { value: "EUR", label: "يورو (EUR)" },
];

// ── Company form ─────────────────────────────────────────────────────────────
const companySchema = z.object({
  name: arabicText({ label: "اسم الشركة" }),
  legalName: z.string().trim().max(200).optional().or(z.literal("")),
  crNumber: z.string().trim().max(50).optional().or(z.literal("")),
  taxNumber: z.string().trim().max(50).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  country: z.string().trim().max(4).optional().or(z.literal("")),
  baseCurrency: z.string().trim().max(8).optional().or(z.literal("")),
});
type CompanyForm = z.infer<typeof companySchema>;

function CompanyFormDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Company | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CompanyForm>({
    resolver: zodResolver(companySchema),
    defaultValues: {
      name: "",
      legalName: "",
      crNumber: "",
      taxNumber: "",
      city: "",
      country: "SA",
      baseCurrency: "SAR",
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      name: initial?.name ?? "",
      legalName: initial?.legalName ?? "",
      crNumber: initial?.crNumber ?? "",
      taxNumber: initial?.taxNumber ?? "",
      city: initial?.city ?? "",
      country: initial?.country || "SA",
      baseCurrency: initial?.baseCurrency || "SAR",
    });
  }, [open, initial, reset]);

  const mutation = useMutation({
    mutationFn: async (values: CompanyForm) => {
      const res = await apiClient.post<MutationAck>("/erp/companies", {
        id: initial?.id,
        ...values,
      });
      return ensureAck(res);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "companies"] });
      toast({ title: initial ? "تم تحديث الشركة" : "تم إنشاء الشركة", tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "تعديل شركة" : "شركة جديدة"}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="اسم الشركة" required error={errors.name} className="sm:col-span-2">
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label="الاسم القانوني" error={errors.legalName}>
            {({ id }) => <Input id={id} {...register("legalName")} />}
          </Field>
          <Field label="السجل التجاري" error={errors.crNumber}>
            {({ id }) => <Input id={id} {...register("crNumber")} />}
          </Field>
          <Field label="الرقم الضريبي" error={errors.taxNumber}>
            {({ id }) => <Input id={id} inputMode="numeric" {...register("taxNumber")} />}
          </Field>
          <Field label="المدينة" error={errors.city}>
            {({ id }) => <Input id={id} {...register("city")} />}
          </Field>
          <Field label="الدولة" error={errors.country}>
            {({ id }) => <Input id={id} {...register("country")} />}
          </Field>
          <Field label="العملة الأساسية" error={errors.baseCurrency}>
            {({ id }) => <Select id={id} options={CURRENCIES} {...register("baseCurrency")} />}
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

// ── Brand form ───────────────────────────────────────────────────────────────
const brandSchema = z.object({
  name: arabicText({ label: "اسم العلامة" }),
  code: z.string().trim().max(20).optional().or(z.literal("")),
  isActive: z.boolean(),
});
type BrandForm = z.infer<typeof brandSchema>;

function BrandFormDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: BrandStat | null;
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
  } = useForm<BrandForm>({
    resolver: zodResolver(brandSchema),
    defaultValues: { name: "", code: "", isActive: true },
  });

  useEffect(() => {
    if (!open) return;
    reset({ name: initial?.name ?? "", code: initial?.code ?? "", isActive: initial?.isActive ?? true });
  }, [open, initial, reset]);

  const mutation = useMutation({
    mutationFn: async (values: BrandForm) => {
      const res = await apiClient.post<MutationAck>("/erp/brands", { id: initial?.id, ...values });
      return ensureAck(res);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "brands-stats"] });
      toast({ title: initial ? "تم تحديث العلامة" : "تم إنشاء العلامة", tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "تعديل علامة تجارية" : "علامة تجارية جديدة"}
      size="md"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <Field label="اسم العلامة" required error={errors.name}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
        </Field>
        <Field label="الرمز" error={errors.code} hint="رمز مختصر يميّز العلامة (اختياري)">
          {({ id }) => <Input id={id} {...register("code")} />}
        </Field>
        <Toggle
          checked={watch("isActive")}
          onChange={(v) => setValue("isActive", v)}
          label="علامة نشطة"
        />
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

// ── Companies tab ────────────────────────────────────────────────────────────
function CompaniesTab() {
  const canManage = useCan("administration.companies");
  const [editing, setEditing] = useState<Company | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: ["erp", "companies"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/companies", { signal }),
  });
  const rows = asArray<Company>(query.data);

  const columns: ColumnDef<Company>[] = [
    { id: "name", header: "الشركة", accessor: (r) => r.name, sortable: true },
    { id: "legalName", header: "الاسم القانوني", accessor: (r) => r.legalName || "—" },
    { id: "crNumber", header: "السجل التجاري", accessor: (r) => r.crNumber || "—" },
    { id: "taxNumber", header: "الرقم الضريبي", accessor: (r) => r.taxNumber || "—" },
    { id: "city", header: "المدينة", accessor: (r) => r.city || "—" },
    { id: "currency", header: "العملة", accessor: (r) => r.baseCurrency || "SAR" },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge>{r.isActive ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث عن شركة…"
        exportFilename="companies.csv"
        tableId="admin-companies"
        emptyTitle="لا توجد شركات"
        emptyBody="ابدأ بإضافة الشركة الأم لمجموعتك."
        mobileTitle={(r) => r.name}
        toolbarActions={
          canManage && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> شركة جديدة
            </Button>
          )
        }
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
      <CompanyFormDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
    </>
  );
}

// ── Brands tab ───────────────────────────────────────────────────────────────
function BrandsTab({ onOpenWizard }: { onOpenWizard?: () => void }) {
  const canManage = useCan("administration.companies");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<BrandStat | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<BrandStat | null>(null);

  const query = useQuery({
    queryKey: ["erp", "brands-stats"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/brands-stats", { signal }),
  });
  const rows = asArray<BrandStat>(query.data);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => ensureAck(await apiClient.delete<MutationAck>(`/erp/brands/${id}`)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "brands-stats"] });
      toast({ title: "تم حذف العلامة", tone: "success" });
      setDeleting(null);
    },
    onError: (e: Error) => toast({ title: "تعذّر الحذف", description: e.message, tone: "error" }),
  });

  const columns: ColumnDef<BrandStat>[] = [
    { id: "name", header: "العلامة التجارية", accessor: (r) => r.name, sortable: true },
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—" },
    { id: "branchCount", header: "الفروع", accessor: (r) => r.branchCount, numeric: true, sortable: true },
    { id: "menuCount", header: "القوائم", accessor: (r) => r.menuCount, numeric: true },
    { id: "employeeCount", header: "الموظفون", accessor: (r) => r.employeeCount, numeric: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge>{r.isActive ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث عن علامة…"
        exportFilename="brands.csv"
        tableId="admin-brands"
        emptyTitle="لا توجد علامات تجارية"
        mobileTitle={(r) => r.name}
        toolbarActions={
          canManage && (
            <div className="flex items-center gap-2">
              {onOpenWizard && (
                <Button size="sm" variant="secondary" onClick={onOpenWizard}>
                  <Wand2 className="h-4 w-4" /> معالج علامة جديدة
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> علامة جديدة
              </Button>
            </div>
          )
        }
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
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
                  <IconButton
                    aria-label={`حذف ${r.name}`}
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
      <BrandFormDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
      <ConfirmDialog
        open={!!deleting}
        title="حذف العلامة التجارية"
        description={
          deleting
            ? `سيتم حذف «${deleting.name}». لا يمكن الحذف إذا كانت مرتبطة بفروع.`
            : ""
        }
        tone="danger"
        confirmLabel="حذف"
        processing={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : null}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

export default function CompaniesBrandsPage() {
  const [tab, setTab] = useState("companies");
  const canWizard = useCan("administration.brands.wizard");

  // Full-page wizard mode — replaces the tabbed shell while active.
  if (tab === "wizard" && canWizard) {
    return <BrandWizard onDone={() => setTab("brands")} onCancel={() => setTab("brands")} />;
  }

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="الشركات والعلامات التجارية"
        subtitle="إدارة الكيانات القانونية والعلامات التجارية للمجموعة."
        action={<Badge tone="teal">هيكل المجموعة</Badge>}
      />
      <Tabs
        aria-label="أقسام الشركات والعلامات"
        value={tab === "wizard" ? "brands" : tab}
        onChange={setTab}
        className="mb-4"
        items={[
          {
            value: "companies",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-4 w-4" /> الشركات
              </span>
            ),
          },
          {
            value: "brands",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Tags className="h-4 w-4" /> العلامات التجارية
              </span>
            ),
          },
        ]}
      />
      {tab === "companies" && <CompaniesTab />}
      {tab === "brands" && (
        <BrandsTab onOpenWizard={canWizard ? () => setTab("wizard") : undefined} />
      )}
    </div>
  );
}
