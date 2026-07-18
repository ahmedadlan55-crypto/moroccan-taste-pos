import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Pencil, Power, UserPlus } from "lucide-react";
import {
  Button,
  Combobox,
  Dialog,
  IconButton,
  Input,
  PageHeader,
  PermissionDenied,
  StatusBadge,
  safeUserMessage,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { ApiError } from "@/shared/api";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import type { CustodyUser } from "../lib/types";

// مسؤولو العهدة — admin/manager management of the custody_users directory
// (the roster the «إنشاء عهدة» picker draws from). Backed by the existing
// CRUD at routes/custody.js: GET/POST /custody/users, POST /users/:id/toggle.
//
// Authorization mirrors the SERVER's _custodyRequireAdmin (admin|manager):
//   • the route is CapGuard-gated on people.employees.view (an admin/manager
//     capability — NOT people.custody.view, which also grants the custody role
//     and would land a holder on a screen the server only 403s), and
//   • this component re-checks role === admin|manager and renders
//     PermissionDenied otherwise, so a custody-portal-only user never reaches
//     the management UI — only their own /people/custody self-view.

const boolish = (v: unknown): boolean => v === true || v === 1;

export function CustodyOfficersPage() {
  const { user } = useAuth();
  const role = String(user?.role ?? "").toLowerCase();
  // Match routes/custody.js _isAdmin exactly (admin|manager) — NOT the UI-wide
  // developer bypass: the server refuses every other role on /custody/users*.
  const isAdmin = role === "admin" || role === "manager";

  const [editing, setEditing] = useState<CustodyUser | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const qc = useQueryClient();
  const { toast } = useToast();

  const query = useQuery({
    queryKey: qk.custodyUsers(),
    queryFn: ({ signal }) => peopleApi.listCustodyUsers(signal),
    enabled: isAdmin,
  });

  const toggle = useMutation({
    mutationFn: (u: CustodyUser) => peopleApi.toggleCustodyUser(u.id),
    onSuccess: (_r, u) => {
      toast({
        title: boolish(u.isActive) ? "تم إيقاف مسؤول العهدة" : "تم تفعيل مسؤول العهدة",
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: qk.custodyUsers() });
    },
    onError: (e) => toast({ title: "تعذّرت العملية", description: safeUserMessage(e), tone: "error" }),
  });

  const columns: ColumnDef<CustodyUser>[] = [
    { id: "name", header: "الاسم", accessor: (r) => r.name, sortable: true },
    { id: "idNumber", header: "رقم الهوية", accessor: (r) => r.idNumber || "—" },
    { id: "phone", header: "الجوال", accessor: (r) => r.phone || "—" },
    { id: "jobTitle", header: "المسمى الوظيفي", accessor: (r) => r.jobTitle || "—" },
    {
      id: "linkedUsername",
      header: "حساب الدخول",
      accessor: (r) => r.linkedUsername || "—",
      cell: (r) =>
        r.linkedUsername ? (
          <span dir="ltr" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700">
            <Link2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            {r.linkedUsername}
          </span>
        ) : (
          <span className="text-sm text-slate-400">غير مرتبط</span>
        ),
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (boolish(r.isActive) ? "نشط" : "معطّل"),
      cell: (r) => (
        <StatusBadge tone={boolish(r.isActive) ? "success" : "neutral"}>
          {boolish(r.isActive) ? "نشط" : "معطّل"}
        </StatusBadge>
      ),
    },
    {
      id: "portal",
      header: "بوابة العهدة",
      accessor: (r) => (r.linkedUsername && boolish(r.isActive) ? "مفعّلة" : "—"),
      cell: (r) =>
        r.linkedUsername ? (
          <StatusBadge tone={boolish(r.isActive) ? "info" : "neutral"}>
            {boolish(r.isActive) ? "مفعّلة" : "موقوفة"}
          </StatusBadge>
        ) : (
          <span className="text-sm text-slate-400">—</span>
        ),
    },
  ];

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="الموارد البشرية" title="مسؤولو العهدة" />
        <PermissionDenied
          title="هذه الشاشة لإدارة مسؤولي العهدة"
          body="إدارة مسؤولي العهدة متاحة للمدير/المسؤول فقط. لعرض عهدتك استخدم شاشة «العهد والمستندات»."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="مسؤولو العهدة"
        subtitle="سجلّ مسؤولي العهدة وربطهم بحسابات الدخول — تُشتق منه قائمة «إنشاء عهدة»."
      />
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.custodyOfficers"
        searchable
        searchPlaceholder="بحث بالاسم أو الجوال أو حساب الدخول…"
        emptyTitle="لا يوجد مسؤولو عهدة بعد"
        exportFilename="custody-officers.csv"
        mobileTitle={(r) => r.name}
        toolbarActions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" /> مسؤول عهدة جديد
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton
              aria-label={`تعديل ${r.name}`}
              title="تعديل"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(r);
                setDialogOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label={boolish(r.isActive) ? `إيقاف ${r.name}` : `تفعيل ${r.name}`}
              title={boolish(r.isActive) ? "إيقاف" : "تفعيل"}
              size="sm"
              variant={boolish(r.isActive) ? "danger" : "ghost"}
              onClick={() => toggle.mutate(r)}
            >
              <Power className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <OfficerDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

// ── Create / edit custodian — all custody_users columns + the login-account link ─
function OfficerDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: CustodyUser | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [linkedUsername, setLinkedUsername] = useState("");
  const [linkError, setLinkError] = useState("");

  // Seed the form when (re)opened — create starts blank, edit prefills.
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setIdNumber(initial?.idNumber ?? "");
    setPhone(initial?.phone ?? "");
    setJobTitle(initial?.jobTitle ?? "");
    setNotes(initial?.notes ?? "");
    setLinkedUsername(initial?.linkedUsername ?? "");
    setLinkError("");
  }, [open, initial]);

  const accounts = useQuery({
    queryKey: qk.loginAccounts(),
    queryFn: ({ signal }) => peopleApi.listLoginAccounts(signal),
    enabled: open,
  });

  const linkOptions = useMemo(() => {
    const opts = (accounts.data ?? []).map((a) => ({
      value: a.username,
      label: a.fullName || a.username,
      sublabel: a.username,
    }));
    // Keep the current link visible even if the account isn't in the directory
    // (e.g. it was deactivated) so an edit doesn't silently drop it.
    if (linkedUsername && !opts.some((o) => o.value === linkedUsername)) {
      opts.unshift({ value: linkedUsername, label: linkedUsername, sublabel: linkedUsername });
    }
    return opts;
  }, [accounts.data, linkedUsername]);

  const save = useMutation({
    mutationFn: () =>
      peopleApi.saveCustodyUser({
        id: initial?.id,
        name: name.trim(),
        idNumber: idNumber.trim(),
        phone: phone.trim(),
        jobTitle: jobTitle.trim(),
        notes: notes.trim(),
        linkedUsername: linkedUsername || "",
      }),
    onSuccess: () => {
      toast({ title: initial ? "تم تحديث مسؤول العهدة" : "تمت إضافة مسؤول العهدة", tone: "success" });
      void qc.invalidateQueries({ queryKey: qk.custodyUsers() });
      onClose();
    },
    onError: (e) => {
      // The 409 duplicate-link refusal is a FIELD-level problem (the picked
      // login account is already tied to another active custodian) — surface it
      // inline on the link control, never as a raw error toast.
      if (e instanceof ApiError && (e.code === "DUPLICATE_LINK" || e.status === 409)) {
        setLinkError(e.message || "هذا الحساب مرتبط بالفعل بمسؤول عهدة آخر");
        return;
      }
      toast({ title: "تعذّر الحفظ", description: safeUserMessage(e), tone: "error" });
    },
  });

  function close() {
    if (save.isPending) return;
    onClose();
  }

  function submit() {
    if (!name.trim()) {
      toast({ title: "أدخل اسم مسؤول العهدة", tone: "error" });
      return;
    }
    setLinkError("");
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={initial ? `تعديل: ${initial.name}` : "إضافة مسؤول عهدة"}
      description="بيانات مسؤول العهدة وربطه بحساب دخول لتفعيل بوابة العهدة الخاصة به."
      dismissable={!save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>
            {initial ? "حفظ التغييرات" : "إضافة المسؤول"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            الاسم <span className="text-rose-600">*</span>
          </span>
          <Input
            className="mt-1"
            value={name}
            placeholder="الاسم الكامل"
            aria-label="اسم مسؤول العهدة"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">رقم الهوية</span>
            <Input
              className="mt-1"
              dir="ltr"
              value={idNumber}
              aria-label="رقم الهوية"
              onChange={(e) => setIdNumber(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">الجوال</span>
            <Input
              className="mt-1"
              dir="ltr"
              inputMode="tel"
              value={phone}
              aria-label="الجوال"
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">المسمى الوظيفي</span>
          <Input
            className="mt-1"
            value={jobTitle}
            aria-label="المسمى الوظيفي"
            onChange={(e) => setJobTitle(e.target.value)}
          />
        </label>

        <div className="block">
          <span className="text-xs font-bold text-slate-600">ربط بحساب دخول</span>
          <div className="mt-1">
            <Combobox
              options={linkOptions}
              value={linkedUsername || null}
              onChange={(v) => {
                setLinkedUsername(v ?? "");
                setLinkError("");
              }}
              placeholder={accounts.isLoading ? "جارٍ تحميل الحسابات…" : "اختر حساب دخول (اختياري)…"}
              emptyText="لا حسابات مطابقة."
              disabled={accounts.isLoading}
              invalid={!!linkError}
              aria-label="ربط بحساب دخول"
            />
          </div>
          {linkError ? (
            <p role="alert" className="mt-1 text-xs font-bold text-rose-600">
              {linkError}
            </p>
          ) : (
            <p className="mt-1 text-[11px] font-medium text-slate-400">
              يمنح الحساب صاحبَه الدخول إلى بوابة العهدة الخاصة به. لكل حساب مسؤول عهدة واحد فقط.
            </p>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">ملاحظات</span>
          <Input
            className="mt-1"
            value={notes}
            aria-label="ملاحظات"
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
