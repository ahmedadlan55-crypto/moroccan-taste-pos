import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Badge, ErrorState, LoadingState, Select, useToast } from "@/shared/ui";
import { ensureAck, type MutationAck } from "../_common";

// GET /api/auth/users/:username/permissions (routes/auth.js ~1103) is the single
// source of truth — the backend computes `effective` from role defaults ∪ grant
// overrides \ revoke overrides. This tab only renders the catalog and writes the
// per-row override via POST/DELETE .../permissions/:permId.
interface PermRow {
  id: string;
  category: string;
  labelAr: string;
  labelEn: string;
  isSensitive: boolean;
  sortOrder: number;
  byRole: boolean;
  override: "grant" | "revoke" | null;
  effective: boolean;
}
interface PermissionsResponse {
  success?: boolean;
  error?: string;
  username?: string;
  role?: string;
  permissions?: PermRow[];
}

type OverrideChoice = "" | "grant" | "revoke";

export function EffectivePermissions({
  username,
  canEdit,
}: {
  username: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["auth", "users", username, "permissions"];

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      apiClient.get<PermissionsResponse>(
        `/auth/users/${encodeURIComponent(username)}/permissions`,
        { signal },
      ),
  });

  const perms = useMemo(() => query.data?.permissions ?? [], [query.data]);
  const grouped = useMemo(() => {
    const by = new Map<string, PermRow[]>();
    [...perms]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .forEach((p) => {
        const key = p.category || "أخرى";
        if (!by.has(key)) by.set(key, []);
        by.get(key)!.push(p);
      });
    return [...by.entries()];
  }, [perms]);

  const mutation = useMutation({
    mutationFn: async ({ permId, choice }: { permId: string; choice: OverrideChoice }) => {
      if (choice === "") {
        return ensureAck(
          await apiClient.delete<MutationAck>(
            `/auth/users/${encodeURIComponent(username)}/permissions/${encodeURIComponent(permId)}`,
          ),
        );
      }
      return ensureAck(
        await apiClient.post<MutationAck>(
          `/auth/users/${encodeURIComponent(username)}/permissions/${encodeURIComponent(permId)}`,
          { grantType: choice },
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      toast({ title: "تم تحديث الصلاحية", tone: "success" });
    },
    onError: (e: Error) =>
      toast({ title: "تعذّر تحديث الصلاحية", description: e.message, tone: "error" }),
  });

  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.isLoading) return <LoadingState rows={4} />;
  if (query.data && query.data.success === false) {
    return (
      <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
        {query.data.error || "تعذّر تحميل الصلاحيات"}
      </p>
    );
  }

  const sourceLabel = (p: PermRow): string => {
    if (p.override === "grant") return "تجاوز (منح)";
    if (p.override === "revoke") return "تجاوز (منع)";
    if (p.byRole) return "دور";
    return "—";
  };

  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50">
          <tr>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">الصلاحية</th>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">المصدر</th>
            <th className="px-3 py-2 text-center font-extrabold text-slate-600">فعّال</th>
            {canEdit && <th className="px-3 py-2 text-center font-extrabold text-slate-600">التجاوز</th>}
          </tr>
        </thead>
        <tbody>
          {grouped.map(([category, rows]) => (
            <PermGroup
              key={category}
              category={category}
              rows={rows}
              canEdit={canEdit}
              sourceLabel={sourceLabel}
              busy={mutation.isPending}
              onChange={(permId, choice) => mutation.mutate({ permId, choice })}
              colSpan={canEdit ? 4 : 3}
            />
          ))}
          {perms.length === 0 && (
            <tr>
              <td colSpan={canEdit ? 4 : 3} className="px-3 py-8 text-center font-semibold text-slate-500">
                لا توجد صلاحيات معرّفة
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PermGroup({
  category,
  rows,
  canEdit,
  sourceLabel,
  busy,
  onChange,
  colSpan,
}: {
  category: string;
  rows: PermRow[];
  canEdit: boolean;
  sourceLabel: (p: PermRow) => string;
  busy: boolean;
  onChange: (permId: string, choice: OverrideChoice) => void;
  colSpan: number;
}) {
  return (
    <>
      <tr className="bg-slate-50/70">
        <td colSpan={colSpan} className="px-3 py-1.5 text-xs font-extrabold text-teal-700">
          {category}
        </td>
      </tr>
      {rows.map((p) => (
        <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
          <td className="px-3 py-2 text-right font-semibold text-slate-700">
            <span className="flex items-center gap-2">
              {p.labelAr || p.labelEn || p.id}
              {p.isSensitive && <Badge tone="danger">حساس</Badge>}
            </span>
          </td>
          <td className="px-3 py-2 text-right font-medium text-slate-500">{sourceLabel(p)}</td>
          <td className="px-3 py-2 text-center">
            {p.effective ? (
              <Check className="mx-auto h-4 w-4 text-teal-600" aria-label="فعّال" />
            ) : (
              <X className="mx-auto h-4 w-4 text-rose-500" aria-label="غير فعّال" />
            )}
          </td>
          {canEdit && (
            <td className="px-3 py-2 text-center">
              <Select
                className="min-w-[8rem]"
                value={p.override ?? ""}
                disabled={busy}
                aria-label={`تجاوز ${p.labelAr || p.id}`}
                onChange={(e) => onChange(p.id, e.target.value as OverrideChoice)}
              >
                <option value="">افتراضي الدور</option>
                <option value="grant">منح</option>
                <option value="revoke">منع</option>
              </Select>
            </td>
          )}
        </tr>
      ))}
    </>
  );
}
