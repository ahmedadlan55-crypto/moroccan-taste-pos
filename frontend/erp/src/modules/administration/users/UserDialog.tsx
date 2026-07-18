import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, ApiError } from "@/shared/api";
import { Button, Checkbox, Dialog, Input, Select, Tabs, useToast } from "@/shared/ui";
import { Field, FormActions, zodResolver } from "@/shared/forms";
import { z, arabicText } from "@/shared/schemas";
import { useAuth, useCan } from "@/app/providers";
import { ensureAck, type MutationAck } from "../_common";
import type { User } from "./types";
import { ASSIGNABLE_ROLES, ROLE_OPTS } from "./roles";
import { checkPasswordStrength } from "./password";
import { useBrandOptions, useBranchOptions, useWarehouseOptions } from "./pickers";
import { ResetPasswordDialog } from "./ResetPasswordDialog";
import { EffectivePermissions } from "./EffectivePermissions";
import { UserAuditTrail } from "./UserAuditTrail";

export type UserDialogMode = "create" | "edit";

// One schema for both modes; the username-format + password rules are only
// enforced on create (edit renames aren't offered, and the password is rotated
// through the dedicated reset action). Mirrors the server contract in
// routes/auth.js (username regex, assignable-role guard, password strength).
function makeUserSchema(mode: UserDialogMode) {
  return z
    .object({
      username: z.string(),
      displayName: arabicText({ label: "الاسم", min: 1, max: 120 }),
      password: z.string(),
      confirmPassword: z.string(),
      role: z.string().refine((v) => ASSIGNABLE_ROLES.includes(v), "الدور غير صالح"),
      email: z
        .string()
        .trim()
        .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "البريد الإلكتروني غير صحيح"),
      phone: z.string().trim().max(20, "رقم الجوال يتجاوز الحد الأقصى"),
      brandId: z.string(),
      branchId: z.string(),
      defaultWarehouseId: z.string(),
      canChangeBranch: z.boolean(),
      employeePortal: z.boolean(),
      custodyPortal: z.boolean(),
      isDeveloper: z.boolean(),
    })
    .superRefine((val, ctx) => {
      if (mode !== "create") return;
      if (!/^[A-Za-z0-9_.@-]{2,50}$/.test(val.username)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["username"],
          message: "اسم المستخدم غير صالح (أحرف/أرقام/نقطة/شرطة/@ فقط، 2-50 خانة، بلا مسافات)",
        });
      }
      const strength = checkPasswordStrength(val.password);
      if (!strength.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message: strength.error! });
      }
      if (val.password !== val.confirmPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["confirmPassword"],
          message: "كلمتا المرور غير متطابقتين",
        });
      }
    });
}

type UserFormValues = z.infer<ReturnType<typeof makeUserSchema>>;

const EMPTY: UserFormValues = {
  username: "",
  displayName: "",
  password: "",
  confirmPassword: "",
  role: "cashier",
  email: "",
  phone: "",
  brandId: "",
  branchId: "",
  defaultWarehouseId: "",
  canChangeBranch: false,
  employeePortal: false,
  custodyPortal: false,
  isDeveloper: false,
};

export function UserDialog({
  mode,
  open,
  initial,
  onClose,
}: {
  mode: UserDialogMode;
  open: boolean;
  initial: User | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  // The server only honors `isDeveloper` when the CREATING account is the
  // primary `admin` (routes/auth.js: grantedBy === 'admin'); render the control
  // only then so we never show a checkbox the backend would silently ignore.
  const showDeveloper = user?.username === "admin";
  const canManageUsers = useCan("administration.users");
  const canAudit = useCan("administration.audit");

  const [tab, setTab] = useState<"details" | "permissions" | "audit">("details");
  const [resetOpen, setResetOpen] = useState(false);

  const schema = useMemo(() => makeUserSchema(mode), [mode]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<UserFormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY,
  });

  const pickersEnabled = open && tab === "details";
  const brandsQuery = useBrandOptions(pickersEnabled);
  const branchesQuery = useBranchOptions(pickersEnabled);
  const warehousesQuery = useWarehouseOptions(pickersEnabled);
  const brands = brandsQuery.data ?? [];
  const branches = branchesQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];

  useEffect(() => {
    if (!open) return;
    setTab("details");
    if (mode === "edit" && initial) {
      reset({
        username: initial.username,
        displayName: initial.displayName || initial.username,
        password: "",
        confirmPassword: "",
        role: ASSIGNABLE_ROLES.includes(initial.role) ? initial.role : "cashier",
        email: initial.email ?? "",
        phone: initial.phone ?? "",
        brandId: initial.brandId ?? "",
        branchId: initial.branchId ?? "",
        defaultWarehouseId: initial.defaultWarehouseId ?? "",
        canChangeBranch: !!initial.canChangeBranch,
        employeePortal: !!initial.employeePortal,
        custodyPortal: !!initial.custodyPortal,
        isDeveloper: !!initial.isDeveloper,
      });
    } else {
      reset(EMPTY);
    }
  }, [open, initial, mode, reset]);

  const buildBody = (v: UserFormValues, forCreate: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      displayName: v.displayName.trim(),
      role: v.role,
      email: v.email.trim(),
      phone: v.phone.trim(),
      // On create, omit blank ids (let the server auto-derive the warehouse from
      // the branch); on edit, send "" explicitly so clearing a link persists.
      brandId: forCreate ? v.brandId || undefined : v.brandId,
      branchId: forCreate ? v.branchId || undefined : v.branchId,
      defaultWarehouseId: forCreate ? v.defaultWarehouseId || undefined : v.defaultWarehouseId,
      canChangeBranch: v.canChangeBranch,
      employeePortal: v.employeePortal,
      custodyPortal: v.custodyPortal,
    };
    if (showDeveloper) body.isDeveloper = v.isDeveloper;
    if (forCreate) {
      body.username = v.username.trim();
      body.password = v.password;
    }
    return body;
  };

  const surfaceError = (e: Error) => {
    if (e instanceof ApiError && (e.status === 409 || e.kind === "conflict")) {
      setError("username", { type: "server", message: e.message || "اسم المستخدم مستخدم بالفعل" });
      return;
    }
    if (e instanceof ApiError && e.status === 400) {
      setError("role", { type: "server", message: e.message });
      return;
    }
    if (/كلمة المرور/.test(e.message)) {
      setError("password", { type: "server", message: e.message });
      return;
    }
    toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" });
  };

  const createMutation = useMutation({
    mutationFn: async (v: UserFormValues) =>
      ensureAck(await apiClient.post<MutationAck>("/auth/users", buildBody(v, true))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "users"] });
      toast({ title: "تم إنشاء المستخدم", tone: "success" });
      onClose();
    },
    onError: surfaceError,
  });

  const editMutation = useMutation({
    mutationFn: async (v: UserFormValues) => {
      if (!initial) return {};
      return ensureAck(
        await apiClient.put<MutationAck>(
          `/auth/users/${encodeURIComponent(initial.username)}`,
          buildBody(v, false),
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "users"] });
      toast({ title: "تم تحديث المستخدم", tone: "success" });
      onClose();
    },
    onError: surfaceError,
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      if (!initial) return {};
      return ensureAck(
        await apiClient.post<MutationAck>(
          `/auth/users/${encodeURIComponent(initial.username)}/toggle`,
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth", "users"] });
      toast({ title: "تم تغيير حالة المستخدم", tone: "success" });
      onClose();
    },
    onError: (e: Error) =>
      toast({ title: "تعذّر تغيير الحالة", description: e.message, tone: "error" }),
  });

  const active = mode === "create" ? createMutation : editMutation;
  const busy = active.isPending || toggleMutation.isPending;

  const tabItems = [
    { value: "details", label: "البيانات" },
    ...(canManageUsers ? [{ value: "permissions", label: "الصلاحيات الفعلية" }] : []),
    ...(canAudit ? [{ value: "audit", label: "سجل التدقيق" }] : []),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "مستخدم جديد" : `تعديل: ${initial?.username ?? ""}`}
      size="xl"
      dismissable={!busy}
    >
      {mode === "edit" && tabItems.length > 1 && (
        <Tabs
          items={tabItems}
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          aria-label="أقسام المستخدم"
          className="mb-4"
        />
      )}

      {(mode === "create" || tab === "details") && (
        <form
          onSubmit={handleSubmit((v) => active.mutate(v))}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {mode === "create" ? (
              <Field label="اسم المستخدم" required error={errors.username}>
                {({ id, invalid }) => (
                  <Input id={id} dir="ltr" invalid={invalid} autoComplete="off" {...register("username")} />
                )}
              </Field>
            ) : (
              <Field label="اسم المستخدم">
                {({ id }) => <Input id={id} dir="ltr" value={initial?.username ?? ""} disabled readOnly />}
              </Field>
            )}

            <Field label="الاسم الظاهر" required error={errors.displayName}>
              {({ id, invalid }) => <Input id={id} invalid={invalid} {...register("displayName")} />}
            </Field>

            {mode === "create" && (
              <>
                <Field
                  label="كلمة المرور"
                  required
                  error={errors.password}
                  hint="6 خانات على الأقل، وتتضمن حرفًا ورقمًا ورمزًا خاصًا."
                >
                  {({ id, invalid }) => (
                    <Input id={id} type="password" dir="ltr" autoComplete="new-password" invalid={invalid} {...register("password")} />
                  )}
                </Field>
                <Field label="تأكيد كلمة المرور" required error={errors.confirmPassword}>
                  {({ id, invalid }) => (
                    <Input id={id} type="password" dir="ltr" autoComplete="new-password" invalid={invalid} {...register("confirmPassword")} />
                  )}
                </Field>
              </>
            )}

            <Field label="الدور" error={errors.role}>
              {({ id, invalid }) => <Select id={id} invalid={invalid} options={ROLE_OPTS} {...register("role")} />}
            </Field>

            <Field label="البريد الإلكتروني" error={errors.email}>
              {({ id, invalid }) => (
                <Input id={id} type="email" dir="ltr" invalid={invalid} {...register("email")} />
              )}
            </Field>

            <Field label="الجوال" error={errors.phone}>
              {({ id, invalid }) => <Input id={id} dir="ltr" inputMode="tel" invalid={invalid} {...register("phone")} />}
            </Field>

            <Field label="العلامة التجارية">
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

            <Field label="الفرع">
              {({ id }) => (
                <Select id={id} {...register("branchId")}>
                  <option value="">بدون فرع</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="المستودع الافتراضي" hint="إن تُرك فارغًا يُشتق تلقائيًا من مستودع الفرع.">
              {({ id }) => (
                <Select id={id} {...register("defaultWarehouseId")}>
                  <option value="">تلقائي من الفرع</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <fieldset className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-2">
            <legend className="px-1 text-xs font-extrabold text-slate-500">الصلاحيات والبوابات</legend>
            <Checkbox label="يمكنه تغيير الفرع" {...register("canChangeBranch")} />
            <Checkbox label="بوابة الموظف (Self-Service)" {...register("employeePortal")} />
            <Checkbox label="بوابة العهدة" {...register("custodyPortal")} />
            {showDeveloper && <Checkbox label="مطوّر (صلاحيات كاملة)" {...register("isDeveloper")} />}
          </fieldset>

          {mode === "edit" && initial && (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => toggleMutation.mutate()}
                loading={toggleMutation.isPending}
              >
                {initial.active ? "تعطيل الحساب" : "تفعيل الحساب"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setResetOpen(true)}>
                إعادة تعيين كلمة المرور
              </Button>
            </div>
          )}

          <FormActions>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              إلغاء
            </Button>
            <Button type="submit" loading={active.isPending}>
              {mode === "create" ? "إنشاء المستخدم" : "حفظ التغييرات"}
            </Button>
          </FormActions>
        </form>
      )}

      {mode === "edit" && initial && tab === "permissions" && (
        <EffectivePermissions username={initial.username} canEdit={canManageUsers} />
      )}
      {mode === "edit" && initial && tab === "audit" && <UserAuditTrail username={initial.username} />}

      <ResetPasswordDialog
        open={resetOpen}
        username={initial?.username ?? null}
        onClose={() => setResetOpen(false)}
      />
    </Dialog>
  );
}
