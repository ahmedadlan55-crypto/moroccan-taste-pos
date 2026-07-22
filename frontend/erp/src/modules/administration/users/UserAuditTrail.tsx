import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { Badge, ErrorState, LoadingState } from "@/shared/ui";
import { formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
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

// Known user-management action codes → t() key suffix under
// administration.users.audit.action.*; unknown codes fall back to the raw code.
const ACTION_KEYS = new Set([
  "create_user",
  "update_user",
  "delete_user",
  "toggle_user_active",
  "reset_password",
]);

export function UserAuditTrail({ username }: { username: string }) {
  const t = useT();
  const actionLabel = (action: string): string =>
    action && ACTION_KEYS.has(action) ? t(`administration.users.audit.action.${action}`) : action || "—";
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
            <th className="px-3 py-2 text-start font-extrabold text-slate-600">{t("administration.users.audit.thDate")}</th>
            <th className="px-3 py-2 text-start font-extrabold text-slate-600">{t("administration.users.audit.thAction")}</th>
            <th className="px-3 py-2 text-start font-extrabold text-slate-600">{t("administration.users.audit.thActor")}</th>
            <th className="px-3 py-2 text-start font-extrabold text-slate-600">{t("administration.users.audit.thDetails")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r.id ?? `${r.createdAt}-${i}`)}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60"
            >
              <td className="whitespace-nowrap px-3 py-2 text-start font-medium tabular-nums text-slate-600" dir="ltr">
                {formatDateTime(r.createdAt)}
              </td>
              <td className="px-3 py-2 text-start">
                <Badge tone="teal">{actionLabel(r.action)}</Badge>
              </td>
              <td className="px-3 py-2 text-start font-semibold text-slate-700">{r.username || "—"}</td>
              <td className="px-3 py-2 text-start font-medium text-slate-500" dir="ltr">
                {r.details && r.details !== "{}" ? r.details : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center font-semibold text-slate-500">
                {t("administration.users.audit.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
