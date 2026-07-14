import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ChevronDown, ChevronLeft, Network, Search, Unlink, UserCog,
} from "lucide-react";
import {
  Button, Dialog, EmptyState, ErrorState, Input, LoadingState,
  PageHeader, PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { usePermissions } from "@/app/providers";
import { orgTreeApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import {
  buildOrgTree, eligibleManagers, flattenTree, matchesQuery,
  PERMISSION_KEYS, PERMISSION_LABELS,
  type OrgEmployee, type OrgNode, type OrgPermissions,
} from "../lib/orgTree";

// /people/org-tree — the org chart.
//
// Converted from the legacy-only `wfLoadOrgTree`, WITH a correction worth stating:
// the legacy screen is called "الشجرة الإدارية" and renders a FLAT grid — it never
// nested anything, and the only editable fields are manager, level and the six
// can_*_txn flags. Departments, positions, add/delete and drag-drop do not exist
// there. The nesting, search, collapse and unlinked-employee view here are NEW.
//
// These six flags are authorization (they decide who may approve a transaction),
// which is why editing needs workflow.manage while reading needs workflow.view.
// Until v4 this endpoint had no auth at all.

function PermissionChips({ p }: { p: OrgPermissions }) {
  const on = PERMISSION_KEYS.filter((k) => p[k]);
  if (on.length === 0) return <span className="text-[11px] text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {on.map((k) => (
        <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
          {PERMISSION_LABELS[k]}
        </span>
      ))}
    </div>
  );
}

function EmployeeRow({
  node, collapsed, onToggle, onEdit, canManage, flat,
}: {
  node: OrgNode; collapsed: Set<string>; onToggle: (id: string) => void;
  onEdit: (e: OrgEmployee) => void; canManage: boolean; flat: boolean;
}) {
  const e = node.employee;
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(e.id);
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5" style={{ paddingInlineStart: flat ? 0 : node.depth * 18 }}>
          {hasKids && !flat ? (
            <button
              type="button"
              onClick={() => onToggle(e.id)}
              aria-label={isCollapsed ? "توسيع" : "طي"}
              aria-expanded={!isCollapsed}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              {isCollapsed ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className="h-6 w-6 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-slate-800">{e.fullName || e.empNumber}</div>
            <div className="truncate font-mono text-[11px] text-slate-400">
              {e.empNumber}{e.username ? ` · ${e.username}` : ""}
            </div>
          </div>
          {hasKids && <StatusBadge dot={false}>{String(node.children.length)}</StatusBadge>}
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-600">{e.positionName || e.jobTitle || "—"}</td>
      <td className="px-3 py-2.5 text-xs text-slate-600">{e.deptName || "—"}</td>
      <td className="px-3 py-2.5 text-xs text-slate-600">{e.branchName || "—"}</td>
      <td className="px-3 py-2.5"><StatusBadge dot={false}>{String(e.workflowLevel)}</StatusBadge></td>
      <td className="px-3 py-2.5"><PermissionChips p={e.permissions} /></td>
      <td className="px-3 py-2.5">
        {canManage ? (
          <Button size="sm" variant="ghost" onClick={() => onEdit(e)}>
            <UserCog className="h-3.5 w-3.5" /> تعديل
          </Button>
        ) : (
          <span className="text-[11px] text-slate-400">للعرض فقط</span>
        )}
      </td>
    </tr>
  );
}

export function OrgTreePage() {
  const { can } = usePermissions();
  const canManage = can("workflow.manage");
  const { toast } = useToast();
  const client = useQueryClient();

  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<OrgEmployee | null>(null);
  const [draft, setDraft] = useState<{ managerId: string; workflowLevel: number; permissions: OrgPermissions } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: qk.orgTree(),
    queryFn: ({ signal }) => orgTreeApi.list(signal),
  });

  const save = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof orgTreeApi.update>[1] }) =>
      orgTreeApi.update(id, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.orgTree() });
      toast({ title: "تم حفظ إعدادات الموظف", tone: "success" });
      setEditing(null); setDraft(null);
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, tone: "error" }),
  });

  const employees = useMemo(() => data ?? [], [data]);
  const tree = useMemo(() => buildOrgTree(employees), [employees]);
  const searching = q.trim().length > 0;

  // While searching, show a flat list of matches — nesting a filtered tree hides
  // matches whose ancestors don't match.
  const rows: OrgNode[] = useMemo(() => {
    if (searching) {
      return employees
        .filter((e) => matchesQuery(e, q))
        .map((e) => ({ employee: e, children: [], depth: 0 }));
    }
    return flattenTree(tree.roots, collapsed);
  }, [searching, q, employees, tree, collapsed]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  function openEdit(e: OrgEmployee) {
    setEditing(e);
    setDraft({ managerId: e.managerId, workflowLevel: e.workflowLevel, permissions: { ...e.permissions } });
  }

  /** Send ONLY what changed — the endpoint writes exactly the keys present. */
  function submit() {
    if (!editing || !draft) return;
    const body: Parameters<typeof orgTreeApi.update>[1] = {};
    if (draft.managerId !== editing.managerId) body.managerId = draft.managerId || null;
    if (draft.workflowLevel !== editing.workflowLevel) body.workflowLevel = draft.workflowLevel;
    const permsChanged = PERMISSION_KEYS.some((k) => draft.permissions[k] !== editing.permissions[k]);
    if (permsChanged) body.permissions = draft.permissions;
    if (Object.keys(body).length === 0) { setEditing(null); setDraft(null); return; }
    save.mutate({ id: editing.id, body });
  }

  const managerOptions = useMemo(
    () => (editing ? eligibleManagers(employees, editing.id) : []),
    [employees, editing],
  );

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const cycleEmployees = employees.filter((e) => tree.cycleIds.includes(e.id));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الهيكل الإداري"
        subtitle="المدير المباشر ومستوى الاعتماد وصلاحيات المعاملات لكل موظف."
      />

      {cycleEmployees.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-bold">{cycleEmployees.length} موظفًا في حلقة إدارية مغلقة.</div>
            <div className="mt-1 font-medium">
              {cycleEmployees.map((e) => e.fullName || e.empNumber).join("، ")} — يتبع كلٌّ منهم الآخر، فلا جذر لهذا
              الفرع. عدّل مديرهم لإعادتهم إلى الشجرة. (لا يمكن إنشاء حلقة جديدة؛ الخادم يرفضها.)
            </div>
          </div>
        </div>
      )}

      <section className="surface">
        <PanelTitle
          icon={Network}
          title="الشجرة"
          subtitle={searching ? `${rows.length} نتيجة` : `${employees.length} موظفًا نشطًا`}
          action={
            <div className="w-full sm:w-64">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ابحث بالاسم أو الرقم أو القسم…"
                aria-label="بحث"
                leading={<Search className="h-4 w-4" />}
              />
            </div>
          }
        />
        <div className="overflow-x-auto p-5">
          {rows.length === 0 ? (
            <EmptyState
              title={searching ? "لا نتائج مطابقة" : "لا يوجد موظفون نشطون"}
              body={searching ? "جرّب كلمة أخرى." : "أضف موظفين من شاشة الموظفين ليظهر الهيكل."}
            />
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-right text-xs font-bold text-slate-500">
                  <th className="px-3 py-2">الموظف</th>
                  <th className="px-3 py-2">المنصب</th>
                  <th className="px-3 py-2">القسم</th>
                  <th className="px-3 py-2">الفرع</th>
                  <th className="px-3 py-2">المستوى</th>
                  <th className="px-3 py-2">صلاحيات المعاملات</th>
                  <th className="px-3 py-2">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <EmployeeRow
                    key={n.employee.id}
                    node={n}
                    collapsed={collapsed}
                    onToggle={toggle}
                    onEdit={openEdit}
                    canManage={canManage}
                    flat={searching}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {tree.orphans.length > 0 && !searching && (
        <section className="surface">
          <PanelTitle
            icon={Unlink}
            title="موظفون خارج الشجرة"
            subtitle="مديرهم المسجَّل غير موجود ضمن الموظفين النشطين — يظهرون هنا بدل أن يختفوا."
          />
          <div className="overflow-x-auto p-5">
            <table className="w-full min-w-[720px] text-sm">
              <tbody>
                {flattenTree(tree.orphans, collapsed).map((n) => (
                  <EmployeeRow
                    key={n.employee.id}
                    node={n}
                    collapsed={collapsed}
                    onToggle={toggle}
                    onEdit={openEdit}
                    canManage={canManage}
                    flat
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog
        open={!!editing}
        onClose={() => { setEditing(null); setDraft(null); }}
        title={editing ? `تعديل — ${editing.fullName || editing.empNumber}` : ""}
      >
        {editing && draft && (
          <div className="grid gap-4">
            <Field label="المدير المباشر" hint="لا تظهر هنا المرؤوسون — اختيارهم يُنشئ حلقة يرفضها الخادم.">
              {({ id }) => (
                <select
                  id={id}
                  className="field"
                  value={draft.managerId}
                  onChange={(ev) => setDraft({ ...draft, managerId: ev.target.value })}
                >
                  <option value="">— بلا مدير —</option>
                  {managerOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.fullName || m.empNumber}</option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="مستوى الاعتماد" hint="من 1 إلى 7.">
              {({ id }) => (
                <select
                  id={id}
                  className="field"
                  value={draft.workflowLevel}
                  onChange={(ev) => setDraft({ ...draft, workflowLevel: Number(ev.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              )}
            </Field>

            <fieldset className="grid gap-2">
              <legend className="text-xs font-bold text-slate-600">صلاحيات المعاملات</legend>
              <div className="grid grid-cols-2 gap-2">
                {PERMISSION_KEYS.map((k) => (
                  <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.permissions[k]}
                      onChange={(ev) => setDraft({ ...draft, permissions: { ...draft.permissions, [k]: ev.target.checked } })}
                    />
                    <span className="font-bold text-slate-700">{PERMISSION_LABELS[k]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setEditing(null); setDraft(null); }}>إلغاء</Button>
              <Button variant="primary" loading={save.isPending} onClick={submit}>حفظ</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

export default OrgTreePage;
