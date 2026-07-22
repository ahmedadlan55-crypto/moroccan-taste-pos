// Self-service clock-in/out helpers — a faithful port of the legacy employee
// PWA contract (public/employee/app.js → doClockWithLocation/_fallbackDevice/
// sendClock). The payload shape is preserved EXACTLY: the server
// (POST /api/hr/my-clock) reads { geoLat, geoLng, geoAddress, deviceName,
// device } and derives the employee from the JWT — the legacy `username` field
// is sent for fidelity but ignored server-side since v7.5 (H1).
//
// Geofence rule (mirrors legacy): location is REQUIRED. The legacy app never
// sent a clock without coordinates — a denied/missing geolocation aborts with
// an error toast. We keep that: no silent "clock without coords" fallback.

import type { TFunction } from "@/i18n";
import type { MyAttendanceRow } from "./types";

// ── Device fingerprint (port of legacy _fallbackDevice, app.js:1386) ─────────
export interface DeviceInfo {
  brand: string;
  model: string;
  os: string;
  ua: string;
}

export function fallbackDevice(ua: string): DeviceInfo {
  let brand = "";
  let model = "";
  let os = "";
  if (/iPhone|iPad|iPod/.test(ua)) {
    brand = "Apple";
    model = /iPad/.test(ua) ? "iPad" : /iPod/.test(ua) ? "iPod" : "iPhone";
    const iosM = ua.match(/OS (\d+[_\d]*) like Mac OS X/);
    os = "iOS" + (iosM ? " " + iosM[1].replace(/_/g, ".") : "");
  } else if (/Android/.test(ua)) {
    const aBuild = ua.match(/;\s*([^;)]+)\s*Build\//);
    const aBuild2 = ua.match(/Android\s*\d+;\s*([^;)]+)\)/);
    model = (aBuild && aBuild[1]) || (aBuild2 && aBuild2[1]) || "Android";
    brand = /Samsung|SM-|Galaxy/i.test(model)
      ? "Samsung"
      : /Pixel/i.test(model)
        ? "Google"
        : /Huawei|HW-|Honor/i.test(model)
          ? "Huawei"
          : /Xiaomi|Redmi|MI |POCO/i.test(model)
            ? "Xiaomi"
            : /OnePlus/i.test(model)
              ? "OnePlus"
              : /Oppo|CPH/i.test(model)
                ? "Oppo"
                : /Vivo/i.test(model)
                  ? "Vivo"
                  : "Android";
    const aV = ua.match(/Android\s*(\d+(?:\.\d+)?)/);
    os = "Android" + (aV ? " " + aV[1] : "");
  } else if (/Windows/.test(ua)) {
    brand = "PC";
    model = "Windows";
    os = "Windows";
  } else if (/Mac OS X/.test(ua)) {
    brand = "Apple";
    model = "Mac";
    os = "macOS";
  } else if (/Linux/.test(ua)) {
    brand = "PC";
    model = "Linux";
    os = "Linux";
  }
  return { brand, model, os, ua: ua.slice(0, 500) };
}

/** Human label the legacy app derived for the device_name column. */
export function deviceLabel(d: DeviceInfo): string {
  return [d.brand, d.model, d.os].filter(Boolean).join(" · ") || "Browser";
}

// ── Clock payload (EXACT legacy shape — app.js:1338-1375) ────────────────────
export interface MyClockPayload {
  username: string;
  geoLat: number;
  geoLng: number;
  geoAddress: string;
  device: DeviceInfo;
  deviceName: string;
}

export function buildClockPayload(args: {
  username: string;
  lat: number;
  lng: number;
  address?: string;
  device: DeviceInfo;
}): MyClockPayload {
  return {
    username: args.username,
    geoLat: args.lat,
    geoLng: args.lng,
    geoAddress: args.address ?? "",
    device: args.device,
    deviceName: deviceLabel(args.device),
  };
}

// ── Today's clock state, derived from the my-attendance rows ─────────────────
export type ClockState = "in" | "out" | "done";

/** yyyy-mm-dd of a date value the API may return as ISO datetime or date. */
function ymd(v: unknown): string {
  const s = String(v ?? "");
  // Normalize via Date when parseable so timezone-suffixed ISO strings match.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return s.slice(0, 10);
}

/**
 * "in"   → no attendance row today (next action = تسجيل حضور)
 * "out"  → clocked in, not out (next action = تسجيل انصراف)
 * "done" → both recorded (server refuses a third event)
 */
export function deriveClockState(rows: MyAttendanceRow[], today = new Date()): ClockState {
  const t = ymd(today.toISOString());
  const row = rows.find((r) => ymd(r.attendance_date) === t);
  if (!row) return "in";
  if (!row.clock_out) return "out";
  return "done";
}

// ── Geofence error message (mirrors legacy sendClock, app.js:1430-1436) ──────
export interface ClockResponse {
  success?: boolean;
  action?: string;
  message?: string;
  error?: string;
  code?: string;
  distance?: number;
  radius?: number;
  device?: Partial<DeviceInfo>;
}

// `t` is optional: the ClockCard passes its active-language translator to
// localize this, but unit tests (and any no-provider caller) call it with one
// argument and get the exact legacy Arabic — the same no-provider fallback
// pattern the shared kit uses.
export function clockErrorMessage(r: ClockResponse | null | undefined, t?: TFunction): string {
  const failed = t ? t("people.clock.failed") : "فشل تسجيل الحضور";
  if (!r) return failed;
  if (r.code === "outside_fence" && r.distance && r.radius) {
    return t
      ? t("people.clock.outsideFence", { distance: r.distance, radius: r.radius })
      : "أنت بعيد عن الفرع بـ " + r.distance + " متر — قَرِّب نَفسك ضمن " + r.radius + " متر.";
  }
  return r.error || failed;
}
