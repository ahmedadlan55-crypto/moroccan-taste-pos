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
import { useT } from "@/i18n";
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

const CURRENCY_VALUES = ["SAR", "AED", "USD", "EUR"] as const;

// ── Company form ─────────────────────────────────────────────────────────────
const companySchema = z.object({
  // arabicText's interpolated {label} message stays Arabic (shared-primitives contract).
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
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const currencyOptions = CURRENCY_VALUES.map((v) => ({ value: v, label: t(`administration.companies.currency.${v}`) }));
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
      toast({ title: initial ? t("administration.companies.toast.updated") : t("administration.companies.toast.created"), tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: t("administration.companies.toast.saveFailed"), description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? t("administration.companies.form.editTitle") : t("administration.companies.form.createTitle")}
      size="lg"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("administration.companies.form.name")} required error={errors.name} className="sm:col-span-2">
            {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
          </Field>
          <Field label={t("administration.companies.form.legalName")} error={errors.legalName}>
            {({ id }) => <Input id={id} {...register("legalName")} />}
          </Field>
          <Field label={t("administration.companies.form.crNumber")} error={errors.crNumber}>
            {({ id }) => <Input id={id} {...register("crNumber")} />}
          </Field>
          <Field label={t("administration.companies.form.taxNumber")} error={errors.taxNumber}>
            {({ id }) => <Input id={id} inputMode="numeric" {...register("taxNumber")} />}
          </Field>
          <Field label={t("administration.companies.form.city")} error={errors.city}>
            {({ id }) => <Input id={id} {...register("city")} />}
          </Field>
          <Field label={t("administration.companies.form.country")} error={errors.country}>
            {({ id }) => <Input id={id} {...register("country")} />}
          </Field>
          <Field label={t("administration.companies.form.baseCurrency")} error={errors.baseCurrency}>
            {({ id }) => <Select id={id} options={currencyOptions} {...register("baseCurrency")} />}
          </Field>
        </div>
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {initial ? t("administration.companies.form.saveChanges") : t("administration.companies.form.create")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ── Brand form ───────────────────────────────────────────────────────────────
const brandSchema = z.object({
  // arabicText's interpolated {label} message stays Arabic (shared-primitives contract).
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
  const t = useT();
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
      toast({ title: initial ? t("administration.companies.brand.toast.updated") : t("administration.companies.brand.toast.created"), tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: t("administration.companies.brand.toast.saveFailed"), description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? t("administration.companies.brand.form.editTitle") : t("administration.companies.brand.form.createTitle")}
      size="md"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <Field label={t("administration.companies.brand.form.name")} required error={errors.name}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("name")} />}
        </Field>
        <Field label={t("administration.companies.brand.form.code")} error={errors.code} hint={t("administration.companies.brand.form.codeHint")}>
          {({ id }) => <Input id={id} {...register("code")} />}
        </Field>
        <Toggle
          checked={watch("isActive")}
          onChange={(v) => setValue("isActive", v)}
          label={t("administration.companies.brand.form.activeToggle")}
        />
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {initial ? t("administration.companies.brand.form.saveChanges") : t("administration.companies.brand.form.create")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ── Companies tab ────────────────────────────────────────────────────────────
function CompaniesTab() {
  const t = useT();
  const canManage = useCan("administration.companies");
  const [editing, setEditing] = useState<Company | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: ["erp", "companies"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/erp/companies", { signal }),
  });
  const rows = asArray<Company>(query.data);

  const columns: ColumnDef<Company>[] = [
    { id: "name", header: t("administration.companies.col.company"), accessor: (r) => r.name, sortable: true },
    { id: "legalName", header: t("administration.companies.col.legalName"), accessor: (r) => r.legalName || "—" },
    { id: "crNumber", header: t("administration.companies.col.crNumber"), accessor: (r) => r.crNumber || "—" },
    { id: "taxNumber", header: t("administration.companies.col.taxNumber"), accessor: (r) => r.taxNumber || "—" },
    { id: "city", header: t("administration.companies.col.city"), accessor: (r) => r.city || "—" },
    { id: "currency", header: t("administration.companies.col.currency"), accessor: (r) => r.baseCurrency || "SAR" },
    {
      id: "status",
      header: t("administration.companies.col.status"),
      accessor: (r) => t(r.isActive ? "status.active" : "status.disabled"),
      cell: (r) => <StatusBadge>{r.isActive ? "active" : "disabled"}</StatusBadge>,
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
        searchPlaceholder={t("administration.companies.searchPlaceholder")}
        exportFilename="companies.csv"
        tableId="admin-companies"
        emptyTitle={t("administration.companies.empty")}
        emptyBody={t("administration.companies.emptyBody")}
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
              <Plus className="h-4 w-4" /> {t("administration.companies.newCompany")}
            </Button>
          )
        }
        rowActions={
          canManage
            ? (r) => (
                <IconButton
                  aria-label={t("administration.companies.editAria", { name: r.name })}
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
  const t = useT();
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
      toast({ title: t("administration.companies.brand.toast.deleted"), tone: "success" });
      setDeleting(null);
    },
    onError: (e: Error) => toast({ title: t("administration.companies.brand.toast.deleteFailed"), description: e.message, tone: "error" }),
  });

  const columns: ColumnDef<BrandStat>[] = [
    { id: "name", header: t("administration.companies.brand.col.name"), accessor: (r) => r.name, sortable: true },
    { id: "code", header: t("administration.companies.brand.col.code"), accessor: (r) => r.code || "—" },
    { id: "branchCount", header: t("administration.companies.brand.col.branches"), accessor: (r) => r.branchCount, numeric: true, sortable: true },
    { id: "menuCount", header: t("administration.companies.brand.col.menus"), accessor: (r) => r.menuCount, numeric: true },
    { id: "employeeCount", header: t("administration.companies.brand.col.employees"), accessor: (r) => r.employeeCount, numeric: true },
    {
      id: "status",
      header: t("administration.companies.brand.col.status"),
      accessor: (r) => t(r.isActive ? "status.active" : "status.disabled"),
      cell: (r) => <StatusBadge>{r.isActive ? "active" : "disabled"}</StatusBadge>,
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
        searchPlaceholder={t("administration.companies.brand.searchPlaceholder")}
        exportFilename="brands.csv"
        tableId="admin-brands"
        emptyTitle={t("administration.companies.brand.empty")}
        mobileTitle={(r) => r.name}
        toolbarActions={
          canManage && (
            <div className="flex items-center gap-2">
              {onOpenWizard && (
                <Button size="sm" variant="secondary" onClick={onOpenWizard}>
                  <Wand2 className="h-4 w-4" /> {t("administration.companies.brand.wizardBtn")}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> {t("administration.companies.brand.newBtn")}
              </Button>
            </div>
          )
        }
        rowActions={
          canManage
            ? (r) => (
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-label={t("administration.companies.brand.editAria", { name: r.name })}
                    size="sm"
                    onClick={() => {
                      setEditing(r);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={t("administration.companies.brand.deleteAria", { name: r.name })}
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
        title={t("administration.companies.brand.deleteTitle")}
        description={deleting ? t("administration.companies.brand.deleteDesc", { name: deleting.name }) : ""}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : null}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

export default function CompaniesBrandsPage() {
  const t = useT();
  const [tab, setTab] = useState("companies");
  const canWizard = useCan("administration.brands.wizard");

  // Full-page wizard mode — replaces the tabbed shell while active.
  if (tab === "wizard" && canWizard) {
    return <BrandWizard onDone={() => setTab("brands")} onCancel={() => setTab("brands")} />;
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.companies.title")}
        subtitle={t("administration.companies.subtitle")}
        action={<Badge tone="teal">{t("administration.companies.structureBadge")}</Badge>}
      />
      <Tabs
        aria-label={t("administration.companies.tabsAria")}
        value={tab === "wizard" ? "brands" : tab}
        onChange={setTab}
        className="mb-4"
        items={[
          {
            value: "companies",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-4 w-4" /> {t("administration.companies.tabCompanies")}
              </span>
            ),
          },
          {
            value: "brands",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Tags className="h-4 w-4" /> {t("administration.companies.tabBrands")}
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
