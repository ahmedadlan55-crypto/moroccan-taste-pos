import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { Badge, ErrorState, LoadingState } from "@/shared/ui";
import { formatDateTime } from "@/shared/lib";
import { asArray } from "../_common";

// GET /api/auth/users/:username/audit (routes/auth.js, added in close2) — the
// read-only user-management history written by _auditUserOp to audit_log.
interface AuditRow {
  id: number | string;
  action: string;
  entityType: string;
  entityId: string;
  username: string;
  details: string;
  createdAt: string;
}

const ACTION_AR: Record<string, string> = {
  create_user: "إنشاء المستخدم",
  update_user: "تعديل المستخدم",
  delete_user: "حذف المستخدم",
  toggle_user_active: "تفعيل/تعطيل",
  reset_password: "إعادة تعيين كلمة المرور",
};

export function UserAuditTrail({ username }: { username: string }) {
  const query = useQuery({
    queryKey: ["auth", "users", username, "audit"],
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`/auth/users/${encodeURIComponent(username)}/audit`, { signal }),
  });
  const rows = asArray<AuditRow>(query.data);

  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.isLoading) return <LoadingState rows={4} />;

  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50">
          <tr>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">التاريخ</th>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">الإجراء</th>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">المنفّذ</th>
            <th className="px-3 py-2 text-right font-extrabold text-slate-600">التفاصيل</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r.id ?? `${r.createdAt}-${i}`)}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60"
            >
              <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums text-slate-600" dir="ltr">
                {formatDateTime(r.createdAt)}
              </td>
              <td className="px-3 py-2 text-right">
                <Badge tone="teal">{ACTION_AR[r.action] ?? r.action ?? "—"}</Badge>
              </td>
              <td className="px-3 py-2 text-right font-semibold text-slate-700">{r.username || "—"}</td>
              <td className="px-3 py-2 text-right font-medium text-slate-500" dir="ltr">
                {r.details && r.details !== "{}" ? r.details : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center font-semibold text-slate-500">
                لا توجد سجلات لهذا المستخدم
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
