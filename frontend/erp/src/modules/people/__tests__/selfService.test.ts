import { describe, it, expect } from "vitest";
import {
  buildClockPayload,
  clockErrorMessage,
  deriveClockState,
  deviceLabel,
  fallbackDevice,
} from "../lib/selfService";
import type { MyAttendanceRow } from "../lib/types";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

describe("fallbackDevice (legacy _fallbackDevice port)", () => {
  it("detects an iPhone with iOS version", () => {
    const d = fallbackDevice(IPHONE_UA);
    expect(d.brand).toBe("Apple");
    expect(d.model).toBe("iPhone");
    expect(d.os).toBe("iOS 17.4");
  });

  it("detects Windows desktop", () => {
    const d = fallbackDevice(WINDOWS_UA);
    expect(d).toMatchObject({ brand: "PC", model: "Windows", os: "Windows" });
  });

  it("caps the UA at 500 chars (matches the legacy slice)", () => {
    const d = fallbackDevice("x".repeat(600));
    expect(d.ua).toHaveLength(500);
  });
});

describe("buildClockPayload — the EXACT legacy /hr/my-clock body", () => {
  it("produces { username, geoLat, geoLng, geoAddress, device, deviceName }", () => {
    const device = fallbackDevice(IPHONE_UA);
    const p = buildClockPayload({ username: "emp1", lat: 24.7, lng: 46.6, address: "الرياض", device });
    expect(Object.keys(p).sort()).toEqual(["device", "deviceName", "geoAddress", "geoLat", "geoLng", "username"]);
    expect(p.geoLat).toBe(24.7);
    expect(p.geoLng).toBe(46.6);
    expect(p.geoAddress).toBe("الرياض");
    expect(p.deviceName).toBe(deviceLabel(device)); // "Apple · iPhone · iOS 17.4"
    expect(p.deviceName).toBe("Apple · iPhone · iOS 17.4");
  });

  it("never invents coordinates — payload building requires lat/lng inputs", () => {
    // The card refuses to call this without a geolocation fix; the builder
    // itself passes numbers through untouched (no 0,0 defaults).
    const p = buildClockPayload({ username: "e", lat: 0.5, lng: 0.25, device: fallbackDevice("") });
    expect(p.geoLat).toBe(0.5);
    expect(p.geoLng).toBe(0.25);
    expect(p.geoAddress).toBe("");
  });
});

describe("deriveClockState", () => {
  const today = new Date("2026-07-17T09:00:00");
  const row = (over: Partial<MyAttendanceRow>): MyAttendanceRow => ({
    id: "a1",
    attendance_date: "2026-07-17",
    ...over,
  });

  it("no row today → next action is clock-in", () => {
    expect(deriveClockState([], today)).toBe("in");
    expect(deriveClockState([row({ attendance_date: "2026-07-16", clock_in: "x" })], today)).toBe("in");
  });

  it("clocked in but not out → next action is clock-out", () => {
    expect(deriveClockState([row({ clock_in: "2026-07-17T08:00:00", clock_out: null })], today)).toBe("out");
  });

  it("both recorded → done (server refuses a third event)", () => {
    expect(
      deriveClockState([row({ clock_in: "2026-07-17T08:00:00", clock_out: "2026-07-17T17:00:00" })], today),
    ).toBe("done");
  });

  it("matches ISO datetime attendance_date values", () => {
    expect(deriveClockState([row({ attendance_date: "2026-07-17T00:00:00.000Z", clock_in: "x", clock_out: null })], today)).toBe("out");
  });
});

describe("clockErrorMessage — the legacy outside_fence text", () => {
  it("renders distance/radius exactly like the legacy toast", () => {
    expect(clockErrorMessage({ success: false, code: "outside_fence", distance: 120, radius: 50 })).toBe(
      "أنت بعيد عن الفرع بـ 120 متر — قَرِّب نَفسك ضمن 50 متر.",
    );
  });

  it("falls back to the server error text", () => {
    expect(clockErrorMessage({ success: false, error: "يجب السماح بتحديد الموقع لتسجيل الحضور" })).toBe(
      "يجب السماح بتحديد الموقع لتسجيل الحضور",
    );
  });
});
