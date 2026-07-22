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
import { useTx } from "@/shared/ui/i18n";
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
  const t = useTx();
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
        title: boolish(u.isActive) ? t("people.custodyOfficers.toggledOff") : t("people.custodyOfficers.toggledOn"),
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: qk.custodyUsers() });
    },
    onError: (e) => toast({ title: t("people.toast.opFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<CustodyUser>[] = [
    { id: "name", header: t("people.field.name"), accessor: (r) => r.name, sortable: true },
    { id: "idNumber", header: t("people.field.idNumber"), accessor: (r) => r.idNumber || "—" },
    { id: "phone", header: t("people.field.phone"), accessor: (r) => r.phone || "—" },
    { id: "jobTitle", header: t("people.field.jobTitleFull"), accessor: (r) => r.jobTitle || "—" },
    {
      id: "linkedUsername",
      header: t("people.custodyOfficers.col.loginAccount"),
      accessor: (r) => r.linkedUsername || "—",
      cell: (r) =>
        r.linkedUsername ? (
          <span dir="ltr" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700">
            <Link2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            {r.linkedUsername}
          </span>
        ) : (
          <span className="text-sm text-slate-400">{t("people.custodyOfficers.col.notLinked")}</span>
        ),
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => (boolish(r.isActive) ? t("people.bool.active") : t("people.bool.disabled")),
      cell: (r) => (
        <StatusBadge tone={boolish(r.isActive) ? "success" : "neutral"}>
          {boolish(r.isActive) ? t("people.bool.active") : t("people.bool.disabled")}
        </StatusBadge>
      ),
    },
    {
      id: "portal",
      header: t("people.custodyOfficers.col.portal"),
      accessor: (r) => (r.linkedUsername && boolish(r.isActive) ? t("people.custodyOfficers.col.portalOn") : "—"),
      cell: (r) =>
        r.linkedUsername ? (
          <StatusBadge tone={boolish(r.isActive) ? "info" : "neutral"}>
            {boolish(r.isActive) ? t("people.custodyOfficers.col.portalOn") : t("people.custodyOfficers.col.portalOff")}
          </StatusBadge>
        ) : (
          <span className="text-sm text-slate-400">—</span>
        ),
    },
  ];

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={t("people.eyebrow")} title={t("people.custodyOfficers.title")} />
        <PermissionDenied
          title={t("people.custodyOfficers.deniedTitle")}
          body={t("people.custodyOfficers.deniedBody")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.custodyOfficers.title")}
        subtitle={t("people.custodyOfficers.subtitle")}
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
        searchPlaceholder={t("people.custodyOfficers.searchPlaceholder")}
        emptyTitle={t("people.custodyOfficers.emptyTitle")}
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
            <UserPlus className="h-4 w-4" aria-hidden="true" /> {t("people.custodyOfficers.newBtn")}
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton
              aria-label={t("people.custodyOfficers.aria.edit", { name: r.name })}
              title={t("common.edit")}
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
              aria-label={boolish(r.isActive) ? t("people.custodyOfficers.aria.disable", { name: r.name }) : t("people.custodyOfficers.aria.enable", { name: r.name })}
              title={boolish(r.isActive) ? t("people.custodyOfficers.aria.disableShort") : t("people.custodyOfficers.aria.enableShort")}
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
  const t = useTx();
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
      toast({ title: initial ? t("people.custodyOfficers.dialog.updatedToast") : t("people.custodyOfficers.dialog.addedToast"), tone: "success" });
      void qc.invalidateQueries({ queryKey: qk.custodyUsers() });
      onClose();
    },
    onError: (e) => {
      // The 409 duplicate-link refusal is a FIELD-level problem (the picked
      // login account is already tied to another active custodian) — surface it
      // inline on the link control, never as a raw error toast.
      if (e instanceof ApiError && (e.code === "DUPLICATE_LINK" || e.status === 409)) {
        setLinkError(e.message || t("people.custodyOfficers.dialog.duplicateLink"));
        return;
      }
      toast({ title: t("people.toast.saveFailed"), description: safeUserMessage(e, t), tone: "error" });
    },
  });

  function close() {
    if (save.isPending) return;
    onClose();
  }

  function submit() {
    if (!name.trim()) {
      toast({ title: t("people.custodyOfficers.dialog.nameRequired"), tone: "error" });
      return;
    }
    setLinkError("");
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={initial ? t("people.custodyOfficers.dialog.editTitle", { name: initial.name }) : t("people.custodyOfficers.dialog.addTitle")}
      description={t("people.custodyOfficers.dialog.desc")}
      dismissable={!save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>
            {initial ? t("people.custodyOfficers.dialog.saveEdit") : t("people.custodyOfficers.dialog.addSubmit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            {t("people.custodyOfficers.dialog.nameLabel")} <span className="text-rose-600">*</span>
          </span>
          <Input
            className="mt-1"
            value={name}
            placeholder={t("people.custodyOfficers.dialog.namePlaceholder")}
            aria-label={t("people.custodyOfficers.dialog.nameAria")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.field.idNumber")}</span>
            <Input
              className="mt-1"
              dir="ltr"
              value={idNumber}
              aria-label={t("people.field.idNumber")}
              onChange={(e) => setIdNumber(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.field.phone")}</span>
            <Input
              className="mt-1"
              dir="ltr"
              inputMode="tel"
              value={phone}
              aria-label={t("people.field.phone")}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("people.field.jobTitleFull")}</span>
          <Input
            className="mt-1"
            value={jobTitle}
            aria-label={t("people.field.jobTitleFull")}
            onChange={(e) => setJobTitle(e.target.value)}
          />
        </label>

        <div className="block">
          <span className="text-xs font-bold text-slate-600">{t("people.custodyOfficers.dialog.linkLabel")}</span>
          <div className="mt-1">
            <Combobox
              options={linkOptions}
              value={linkedUsername || null}
              onChange={(v) => {
                setLinkedUsername(v ?? "");
                setLinkError("");
              }}
              placeholder={accounts.isLoading ? t("people.custodyOfficers.dialog.linkLoading") : t("people.custodyOfficers.dialog.linkPlaceholder")}
              emptyText={t("people.custodyOfficers.dialog.linkEmpty")}
              disabled={accounts.isLoading}
              invalid={!!linkError}
              aria-label={t("people.custodyOfficers.dialog.linkLabel")}
            />
          </div>
          {linkError ? (
            <p role="alert" className="mt-1 text-xs font-bold text-rose-600">
              {linkError}
            </p>
          ) : (
            <p className="mt-1 text-[11px] font-medium text-slate-400">
              {t("people.custodyOfficers.dialog.linkHint")}
            </p>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("people.field.notes")}</span>
          <Input
            className="mt-1"
            value={notes}
            aria-label={t("people.field.notes")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
