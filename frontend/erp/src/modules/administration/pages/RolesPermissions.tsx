import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldCheck } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Badge, Button, Checkbox, LoadingState, ErrorState, PageHeader, useToast } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { asArray, ensureAck, type MutationAck } from "../_common";

interface PermissionDef {
  id: string;
  category: string;
  labelAr: string;
  labelEn: string;
  isSensitive: boolean;
  sortOrder: number;
}

// The assignable roles shown as matrix columns. `admin` is a wildcard (all
// permissions) and is intentionally excluded from the editable grid.
const ROLES: { value: string; label: string }[] = [
  { value: "manager", label: "مدير" },
  { value: "accountant", label: "محاسب" },
  { value: "finance", label: "مالية" },
  { value: "cashier", label: "كاشير" },
  { value: "sales", label: "مبيعات" },
  { value: "auditor", label: "مدقّق" },
  { value: "custody", label: "عهدة" },
  { value: "employee", label: "موظف" },
];

export default function RolesPermissionsPage() {
  const canEdit = useCan("administration.roles");
  const qc = useQueryClient();
  const { toast } = useToast();

  const catalogQuery = useQuery({
    queryKey: ["auth", "permissions-catalog"],
    queryFn: ({ signal }) => apiClient.get<unknown>("/auth/permissions/catalog", { signal }),
  });

  const roleQueries = useQueries({
    queries: ROLES.map((r) => ({
      queryKey: ["auth", "role-perms", r.value],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiClient.get<unknown>(`/auth/permissions/role/${r.value}`, { signal }),
    })),
  });

  // base assignment per role, from the server
  const baseByRole = useMemo(() => {
    const map = new Map<string, Set<string>>();
    ROLES.forEach((r, i) => {
      map.set(r.value, new Set(asArray<string>(roleQueries[i]?.data).map(String)));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleQueries.map((q) => q.dataUpdatedAt).join(",")]);

  // local edits keyed "role|permId" → desired checked state
  const [edits, setEdits] = useState<Record<string, boolean>>({});

  const catalog = asArray<PermissionDef>(catalogQuery.data);
  const grouped = useMemo(() => {
    const by = new Map<string, PermissionDef[]>();
    [...catalog]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .forEach((p) => {
        const key = p.category || "أخرى";
        if (!by.has(key)) by.set(key, []);
        by.get(key)!.push(p);
      });
    return [...by.entries()];
  }, [catalog]);

  const isChecked = (role: string, permId: string): boolean => {
    const key = `${role}|${permId}`;
    if (key in edits) return edits[key];
    return baseByRole.get(role)?.has(permId) ?? false;
  };
  const toggle = (role: string, permId: string) => {
    const key = `${role}|${permId}`;
    setEdits((prev) => ({ ...prev, [key]: !isChecked(role, permId) }));
  };

  const changedRoles = useMemo(() => {
    const set = new Set<string>();
    for (const key of Object.keys(edits)) {
      const [role, permId] = key.split("|");
      const base = baseByRole.get(role)?.has(permId) ?? false;
      if (edits[key] !== base) set.add(role);
    }
    return set;
  }, [edits, baseByRole]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const role of changedRoles) {
        const finalIds = catalog.map((p) => p.id).filter((id) => isChecked(role, id));
        const res = await apiClient.put<MutationAck>(`/auth/permissions/role/${role}`, {
          permissionIds: finalIds,
        });
        ensureAck(res);
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["auth", "role-perms"] });
      setEdits({});
      toast({ title: "تم حفظ الصلاحيات", tone: "success" });
    },
    onError: (e: Error) => toast({ title: "تعذّر حفظ الصلاحيات", description: e.message, tone: "error" }),
  });

  const loading = catalogQuery.isLoading || roleQueries.some((q) => q.isLoading);
  const dirty = changedRoles.size > 0;

  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="الأدوار والصلاحيات"
        subtitle="مصفوفة الصلاحيات لكل دور. تعديل الصلاحيات مقصور على حساب المطوّر الرئيسي."
        action={
          <div className="flex items-center gap-2">
            {dirty && <Badge tone="warning">تغييرات غير محفوظة</Badge>}
            {canEdit && (
              <Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending} disabled={!dirty}>
                <Save className="h-4 w-4" /> حفظ الصلاحيات
              </Button>
            )}
          </div>
        }
      />

      {catalogQuery.error ? (
        <ErrorState error={catalogQuery.error} onRetry={() => catalogQuery.refetch()} />
      ) : loading ? (
        <LoadingState />
      ) : catalog.length === 0 ? (
        <div className="surface grid place-items-center gap-3 p-12 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="text-base font-extrabold text-slate-800">لا توجد صلاحيات معرّفة</div>
        </div>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <th className="sticky right-0 z-10 bg-slate-50 px-4 py-3 text-right font-extrabold text-slate-600">
                  الصلاحية
                </th>
                {ROLES.map((r) => (
                  <th key={r.value} className="px-3 py-3 text-center font-extrabold text-slate-600">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([category, perms]) => (
                <PermissionGroup
                  key={category}
                  category={category}
                  perms={perms}
                  roles={ROLES}
                  isChecked={isChecked}
                  toggle={toggle}
                  canEdit={canEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PermissionGroup({
  category,
  perms,
  roles,
  isChecked,
  toggle,
  canEdit,
}: {
  category: string;
  perms: PermissionDef[];
  roles: { value: string; label: string }[];
  isChecked: (role: string, permId: string) => boolean;
  toggle: (role: string, permId: string) => void;
  canEdit: boolean;
}) {
  return (
    <>
      <tr className="bg-slate-50/70">
        <td
          colSpan={roles.length + 1}
          className="sticky right-0 bg-slate-50/70 px-4 py-2 text-xs font-extrabold text-teal-700"
        >
          {category}
        </td>
      </tr>
      {perms.map((p) => (
        <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
          <td className="sticky right-0 bg-white px-4 py-2.5 text-right font-semibold text-slate-700">
            <span className="flex items-center gap-2">
              {p.labelAr || p.labelEn || p.id}
              {p.isSensitive && <Badge tone="danger">حساس</Badge>}
            </span>
          </td>
          {roles.map((r) => (
            <td key={r.value} className="px-3 py-2.5 text-center">
              <span className="inline-flex justify-center">
                <Checkbox
                  checked={isChecked(r.value, p.id)}
                  disabled={!canEdit}
                  onChange={() => toggle(r.value, p.id)}
                  aria-label={`${p.labelAr || p.id} — ${r.label}`}
                />
              </span>
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
