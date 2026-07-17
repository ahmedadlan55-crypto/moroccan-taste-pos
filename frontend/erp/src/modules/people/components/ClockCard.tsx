import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, LogIn, LogOut, MapPin } from "lucide-react";
import { Card, Button, safeUserMessage, useToast } from "@/shared/ui";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import {
  buildClockPayload,
  clockErrorMessage,
  deriveClockState,
  fallbackDevice,
  type ClockState,
} from "../lib/selfService";
import type { MyAttendanceRow } from "../lib/types";

// حضور/انصراف — port of the legacy employee PWA clock flow
// (public/employee/app.js doClock/doClockWithLocation/sendClock).
//
// Contract mirrored EXACTLY:
//   • Location is REQUIRED — a missing/denied geolocation aborts with the same
//     legacy error message; we never send a clock without coordinates (the
//     server independently re-enforces the geofence when the branch has one).
//   • Payload: { username, geoLat, geoLng, geoAddress, device, deviceName } to
//     POST /api/hr/my-clock. The actor is derived from the JWT server-side.
//   • geoAddress is best-effort reverse geocoding via the same Nominatim call
//     the legacy app used; failure just sends an empty address.
//   • An outside_fence refusal renders the exact distance/radius message.
// Deliberately NOT ported: the legacy WebAuthn "biometric" prompt — it proceeded
// identically on success AND failure (decorative, enforced nothing).

const STATE_LABEL: Record<ClockState, string> = {
  in: "تسجيل حضور",
  out: "تسجيل انصراف",
  done: "اكتمل حضور اليوم",
};

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const r = await fetch(
      "https://nominatim.openstreetmap.org/reverse?lat=" + lat + "&lon=" + lng + "&format=json&accept-language=ar",
    );
    const g = (await r.json()) as { display_name?: string };
    return g.display_name || "";
  } catch {
    return "";
  }
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout: 10000,
      enableHighAccuracy: true,
    });
  });
}

export function ClockCard({ rows }: { rows: MyAttendanceRow[] }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [locating, setLocating] = useState(false);

  const state = deriveClockState(rows);

  const clock = useMutation({
    mutationFn: peopleApi.myClock,
    onSuccess: (r) => {
      if (r && r.success) {
        const devLine =
          r.device && (r.device.brand || r.device.model)
            ? " — " + [r.device.brand, r.device.model, r.device.os].filter(Boolean).join(" · ")
            : "";
        toast({ title: (r.message || "تم التسجيل") + devLine, tone: "success" });
        void qc.invalidateQueries({ queryKey: [...qk.all, "self"] });
      } else {
        toast({ title: clockErrorMessage(r), tone: "error" });
      }
    },
    onError: (e) => toast({ title: "تعذّر تسجيل الحضور", description: safeUserMessage(e), tone: "error" }),
  });

  async function onClock() {
    if (state === "done" || locating || clock.isPending) return;
    // REQUIRE location — same rule as the legacy portal (no coordinates, no clock).
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      toast({ title: "جهازك لا يدعم تحديد الموقع", tone: "error" });
      return;
    }
    setLocating(true);
    try {
      const pos = await getPosition();
      const device = fallbackDevice(navigator.userAgent || "");
      const address = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      clock.mutate(
        buildClockPayload({
          username: user?.username ?? "",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          address,
          device,
        }),
      );
    } catch {
      // Geolocation denied / timed out — the legacy app refuses to clock.
      toast({ title: "يجب السماح بالموقع لتسجيل الحضور — افتح إعدادات المتصفح", tone: "error" });
    } finally {
      setLocating(false);
    }
  }

  const busy = locating || clock.isPending;
  const Icon = state === "out" ? LogOut : LogIn;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
            <Fingerprint className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-slate-900">الحضور والانصراف</h2>
            <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-slate-500">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              يتطلب السماح بتحديد الموقع — يتحقق النظام من نطاق الفرع.
            </p>
          </div>
        </div>
        <Button
          variant={state === "out" ? "danger" : "primary"}
          size="lg"
          disabled={state === "done"}
          loading={busy}
          onClick={() => void onClock()}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
          {busy ? "جاري تحديد الموقع…" : STATE_LABEL[state]}
        </Button>
      </div>
    </Card>
  );
}
