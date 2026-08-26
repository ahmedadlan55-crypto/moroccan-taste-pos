import { useQuery } from "@tanstack/react-query";
import { ReceiptText } from "lucide-react";
import {
  Badge,
  Drawer,
  DetailStat,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
} from "@/shared/ui";
import { formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { posAdminApi } from "../lib/api";
import { posAdminKeys, shiftActual, shiftDiff, shiftTheoretical, isShiftOpen } from "../lib/shifts";
import { pmGroupLabel, shiftStatusLabel } from "../lib/labels";
import type { Shift } from "../lib/types";

interface ShiftDetailDrawerProps {
  shift: Shift | null;
  onClose: () => void;
}

/** Read-only per-shift closing breakdown — /shifts/closing-data-v3/:id. */
export function ShiftDetailDrawer({ shift, onClose }: ShiftDetailDrawerProps) {
  const t = useT();
  const open = shift != null;
  const query = useQuery({
    queryKey: shift ? posAdminKeys.shiftClosing(shift.id) : ["pos-admin", "shift-closing", "none"],
    queryFn: ({ signal }) => posAdminApi.shiftClosing(shift!.id, signal),
    enabled: open,
    staleTime: 15_000,
  });

  const methods = query.data?.methods ?? [];
  const diff = shift ? shiftDiff(shift) : 0;
  const balanced = Math.abs(diff) < 0.01;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={ReceiptText}
      eyebrow={t("posAdmin.drawer.eyebrow")}
      title={shift ? shift.displayName || shift.username || t("posAdmin.drawer.titleFallback") : t("posAdmin.drawer.titleFallback")}
    >
      {shift && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={isShiftOpen(shift) ? "warning" : "success"}>
              {shiftStatusLabel(t, isShiftOpen(shift))}
            </StatusBadge>
            <Badge tone={balanced ? "success" : diff < 0 ? "danger" : "warning"}>
              {balanced ? t("posAdmin.shift.balanced") : t("posAdmin.shift.diffAmount", { amount: formatCurrency(diff) })}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DetailStat label={t("posAdmin.col.cashier")} value={shift.username || "—"} />
            <DetailStat label={t("posAdmin.col.start")} value={formatDateTime(shift.startTime)} />
            <DetailStat label={t("posAdmin.drawer.endLabel")} value={shift.endTime ? formatDateTime(shift.endTime) : "—"} />
            <DetailStat
              label={t("posAdmin.drawer.orderCount")}
              value={<span dir="ltr" className="tabular-nums">{formatNumber(query.data?.orderCount ?? 0)}</span>}
            />
            <DetailStat
              label={t("posAdmin.col.expected")}
              value={<span dir="ltr" className="tabular-nums">{formatCurrency(query.data?.expectedTotal ?? shiftTheoretical(shift))}</span>}
            />
            <DetailStat
              label={t("posAdmin.col.actual")}
              value={<span dir="ltr" className="tabular-nums">{formatCurrency(shiftActual(shift))}</span>}
            />
            <DetailStat
              label={t("posAdmin.drawer.openingFloat")}
              value={<span dir="ltr" className="tabular-nums">{formatCurrency(shift.openingFloat ?? 0)}</span>}
            />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-extrabold text-slate-600">{t("posAdmin.drawer.breakdownTitle")}</h3>
            {query.isLoading ? (
              <LoadingState rows={4} />
            ) : query.isError ? (
              <ErrorState error={query.error} onRetry={() => query.refetch()} />
            ) : methods.length === 0 ? (
              <EmptyState title={t("posAdmin.drawer.emptyTitle")} body={t("posAdmin.drawer.emptyBody")} />
            ) : (
              <div className="surface overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs font-extrabold text-slate-500">
                      <th className="px-3 py-2 text-start">{t("posAdmin.col.method")}</th>
                      <th className="px-3 py-2 text-start">{t("posAdmin.col.group")}</th>
                      <th className="px-3 py-2 text-end">{t("posAdmin.col.expected")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {methods.map((m, i) => (
                      <tr key={`${m.name ?? m.nameAr ?? "m"}-${i}`} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-2.5 font-bold text-slate-700">{m.nameAr || m.name || "—"}</td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {m.groupType ? pmGroupLabel(t, m.groupType) : "—"}
                        </td>
                        <td dir="ltr" className="px-3 py-2.5 text-end font-semibold tabular-nums text-slate-800">
                          {formatCurrency(m.expectedAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
