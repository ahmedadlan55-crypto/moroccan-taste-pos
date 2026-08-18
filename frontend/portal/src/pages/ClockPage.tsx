// البصمة — clock in / clock out.
//
// This is the screen the portal exists for. A cook opens it standing at the
// pass, one-handed, and needs one unmistakable button.
//
// CONTRACT, ported from the original PWA (public/employee/app.js →
// doClockWithLocation / sendClock) and unchanged since:
//   • Location is REQUIRED. A denied or timed-out geolocation ABORTS — we never
//     send a clock without coordinates, because a row with no position can
//     never be geofence-checked afterwards. The server re-enforces the fence
//     independently for branches that have one.
//   • Payload: { username, geoLat, geoLng, geoAddress, device, deviceName }.
//     The actor is taken from the JWT server-side; `username` rides along for
//     wire fidelity and is ignored.
//   • An `outside_fence` refusal renders the exact distance and radius.
//
// geoAddress is sent EMPTY here, deliberately. The original app reverse-geocoded
// through Nominatim, but this app is served under `connect-src 'self'`
// (server.js), which blocks that host — so the call could only ever fail, and
// pretending otherwise would put a dead request in the clock path. Coordinates
// are what the geofence actually checks.
//
// Deliberately NOT ported: the legacy WebAuthn "biometric" prompt — it proceeded
// identically on success AND failure, so it enforced nothing.
import { useState } from "react";
import { Fingerprint, LogIn, LogOut, MapPin } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, statusTone } from "@/components/ui";
import { useToast } from "@/components/Toasts";
import { useT, useStatusLabel } from "@/i18n";
import { useAttendance, useClock } from "@/lib/queries";
import { buildClockPayload, clockErrorMessage, deriveClockState, fallbackDevice } from "@/lib/selfService";
import { formatDate, formatHours, formatTime } from "@/lib/format";
import type { PortalSession } from "@/lib/api";
import type { MyAttendanceRow } from "@/lib/types";

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout: 10000,
      enableHighAccuracy: true,
    });
  });
}

export function ClockPage({ session }: { session: PortalSession | null }) {
  const t = useT();
  const toast = useToast();
  const statusLabel = useStatusLabel();
  const attendance = useAttendance();
  const clock = useClock();
  const [locating, setLocating] = useState(false);

  const rows: MyAttendanceRow[] = attendance.data ?? [];
  const state = deriveClockState(rows);
  const busy = locating || clock.isPending;

  async function onClock() {
    if (state === "done" || busy) return;

    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      toast.error(t("clock.locationUnavailable"));
      return;
    }

    setLocating(true);
    try {
      const pos = await getPosition();
      const device = fallbackDevice(navigator.userAgent || "");
      const res = await clock.mutateAsync(
        buildClockPayload({
          username: session?.username ?? "",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          device,
        }),
      );
      if (res && res.success) {
        toast.success(res.message || t(state === "in" ? "clock.successIn" : "clock.successOut"));
      } else {
        // A geofence refusal arrives as HTTP 200 with success:false — it is a
        // refusal, not a crash, and gets the server's exact distance/radius text.
        toast.error(clockErrorMessage(res, t));
      }
    } catch (err) {
      // Two very different failures land here and the employee needs to be told
      // which: the browser refused the location, or the request failed.
      //
      // Duck-typed on purpose — `err instanceof GeolocationPositionError` would
      // throw a ReferenceError under jsdom, where that global does not exist,
      // turning a handled rejection into an unhandled one inside a test.
      const isGeoError =
        !!err && typeof err === "object" && "code" in err && !(err instanceof Error);
      toast.error(
        isGeoError
          ? t("clock.locationDenied")
          : err instanceof Error && err.message
            ? err.message
            : t("clock.locationUnavailable"),
      );
    } finally {
      setLocating(false);
    }
  }

  const Icon = state === "out" ? LogOut : LogIn;
  const actionLabel = state === "in" ? t("clock.in") : state === "out" ? t("clock.out") : t("clock.done");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <span
            className={
              state === "done"
                ? "flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"
                : "flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-50 text-teal-700"
            }
          >
            <Fingerprint className="h-8 w-8" aria-hidden />
          </span>

          <div>
            <p className="text-sm font-extrabold text-slate-900">{actionLabel}</p>
            <p className="mt-1 flex items-center justify-center gap-1 text-[11px] font-bold text-slate-400">
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              {state === "done" ? t("clock.doneHint") : t("clock.locating")}
            </p>
          </div>

          <Button
            block
            variant={state === "out" ? "danger" : "primary"}
            disabled={state === "done"}
            loading={busy}
            onClick={() => void onClock()}
            className="min-h-14 text-base"
          >
            {!busy && <Icon className="h-5 w-5" aria-hidden />}
            {busy ? t("clock.sending") : actionLabel}
          </Button>
        </div>
      </Card>

      <Card title={t("clock.recent")} bodyClassName="px-0 py-0">
        {attendance.isLoading ? (
          <LoadingState />
        ) : attendance.isError ? (
          <ErrorState error={attendance.error} onRetry={() => void attendance.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <ul>
            {rows.slice(0, 14).map((row, i) => (
              <li
                key={row.id ?? `${row.attendance_date}-${i}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="num text-xs font-extrabold text-slate-800">
                    {formatDate(row.attendance_date)}
                  </p>
                  <p className="num mt-0.5 text-[11px] font-bold text-slate-400">
                    {formatTime(row.clock_in)} → {formatTime(row.clock_out)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="num text-xs font-extrabold text-slate-700">
                    {formatHours(row.total_hours)}
                  </span>
                  {row.status && <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
