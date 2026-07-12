import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { apiClient, ApiError } from "@/shared/api";
import {
  Badge,
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

interface User {
  username: string;
  displayName: string;
  role: string;
  active: boolean;
  email: string;
  phone: string;
  isDeveloper?: boolean;
  branchName?: string;
  brandName?: string;
}

const ROLE_OPTS = [
  { value: "admin", label: "مدير النظام" },
  { value: "manager", label: "مدير" },
  { value: "accountant", label: "محاسب" },
  { value: "finance", label: "مالية" },
  { value: "cashier", label: "كاشير" },
  { value: "sales", label: "مبيعات" },
  { value: "auditor", label: "مدقّق" },
  { value: "custody", label: "عهدة" },
  { value: "employee", label: "موظف" },
  { value: "developer", label: "مطوّر" },
];
const ROLE_LABEL = new Map(ROLE_OPTS.map((r) => [r.value, r.label]));

const userSchema = z.object({
  displayName: arabicText({ label: "الاسم", min: 1, max: 120 }),
  role: z.string(),
  email: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "البريد الإلكتروني غير صحيح"),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
});
type UserForm = z.infer<typeof userSchema>;

function UserEditDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: User | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserForm>({
    resolver: zodResolver(userSchema),
    defaultValues: { displayName: "", role: "employee", email: "", phone: "" },
  });

  useEffect(() => {
    if (!open || !initial) return;
    reset({
      displayName: initial.displayName || initial.username,
      role: initial.role || "employee",
      email: initial.email ?? "",
      phone: initial.phone ?? "",
    });
  }, [open, initial, reset]);

  const mutation = useMutation({
    mutationFn: async (values: UserForm) => {
      if (!initial) return {};
      const res = await apiClient.put<MutationAck>(
        `/auth/users/${encodeURIComponent(initial.username)}`,
        values,
      );
      return ensureAck(res);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "users"] });
      toast({ title: "تم تحديث المستخدم", tone: "success" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? `تعديل: ${initial.username}` : "تعديل مستخدم"}
      size="md"
      dismissable={!isSubmitting}
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4" noValidate>
        <Field label="الاسم الظاهر" required error={errors.displayName}>
          {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("displayName")} />}
        </Field>
        <Field label="الدور" error={errors.role}>
          {({ id }) => <Select id={id} options={ROLE_OPTS} {...register("role")} />}
        </Field>
        <Field label="البريد الإلكتروني" error={errors.email}>
          {({ id, invalid }) => <Input id={id} type="email" dir="ltr" invalid={invalid} {...register("email")} />}
        </Field>
        <Field label="الجوال" error={errors.phone}>
          {({ id }) => <Input id={id} dir="ltr" inputMode="tel" {...register("phone")} />}
        </Field>
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            إلغاء
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            حفظ التغييرات
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

interface UsersResult {
  limited: boolean;
  rows: User[];
}

export default function UsersPage() {
  const canManage = useCan("administration.users");
  const [editing, setEditing] = useState<User | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery<UsersResult>({
    queryKey: ["auth", "users"],
    queryFn: async ({ signal }) => {
      try {
        const data = await apiClient.get<unknown>("/auth/users", { signal });
        return { limited: false, rows: asArray<User>(data) };
      } catch (e) {
        // Non-admin roles get a 403 on /users but may still read the lightweight
        // display-name directory — degrade to a read-only list instead of erroring.
        if (e instanceof ApiError && (e.kind === "forbidden" || e.status === 403)) {
          const data = await apiClient.get<unknown>("/auth/users-list", { signal });
          const rows = asArray<{ username: string; fullName: string }>(data).map<User>((u) => ({
            username: u.username,
            displayName: u.fullName || u.username,
            role: "",
            active: true,
            email: "",
            phone: "",
          }));
          return { limited: true, rows };
        }
        throw e;
      }
    },
  });

  const limited = query.data?.limited ?? false;
  const rows = query.data?.rows ?? [];

  const columns: ColumnDef<User>[] = [
    { id: "username", header: "اسم المستخدم", accessor: (r) => r.username, sortable: true },
    { id: "displayName", header: "الاسم", accessor: (r) => r.displayName || "—" },
    {
      id: "role",
      header: "الدور",
      accessor: (r) => (r.role ? ROLE_LABEL.get(r.role) ?? r.role : "—"),
      cell: (r) =>
        r.role ? <Badge tone={r.isDeveloper ? "purple" : "teal"}>{ROLE_LABEL.get(r.role) ?? r.role}</Badge> : "—",
    },
    { id: "branch", header: "الفرع", accessor: (r) => r.branchName || "—", defaultHidden: limited },
    { id: "email", header: "البريد", accessor: (r) => r.email || "—", defaultHidden: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (r.active ? "نشط" : "معطّل"),
      cell: (r) => <StatusBadge>{r.active ? "نشط" : "معطّل"}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="المستخدمون"
        subtitle="حسابات الدخول والأدوار. تعديل المستخدمين متاح لمديري النظام فقط."
        action={limited ? <Badge tone="warning">عرض محدود</Badge> : undefined}
      />
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.username}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        searchable
        searchPlaceholder="بحث بالاسم أو اسم المستخدم…"
        exportFilename="users.csv"
        tableId="admin-users"
        emptyTitle="لا يوجد مستخدمون"
        mobileTitle={(r) => r.displayName || r.username}
        rowActions={
          canManage && !limited
            ? (r) => (
                <IconButton
                  aria-label={`تعديل ${r.username}`}
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
      <UserEditDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
