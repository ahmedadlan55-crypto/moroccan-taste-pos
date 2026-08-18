// The clock is the portal's reason to exist. Three rules, all ported from the
// original PWA, all of them things a refactor would quietly drop:
//
//   1. NO LOCATION, NO CLOCK. A denied geolocation must abort — never fall back
//      to sending a clock without coordinates, because a row with no position
//      can never be geofence-checked afterwards.
//   2. A geofence refusal arrives as HTTP 200 with success:false. It is a
//      refusal to show the employee, not a crash and not a success.
//   3. The payload keeps the server's exact field names.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ClockPage } from "../ClockPage";
import { ToastProvider } from "@/components/Toasts";
import type { PortalSession } from "@/lib/api";

const SESSION: PortalSession = { username: "sara", role: "employee", fullName: "سارة" };

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

/** Attendance list is empty → deriveClockState says "in" (nothing today yet). */
function mockApi(clockResponse: unknown, clockStatus = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const isClock = String(url).includes("/hr/my-clock");
      const body = isClock ? clockResponse : [];
      return {
        ok: (isClock ? clockStatus : 200) < 400,
        status: isClock ? clockStatus : 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return calls;
}

function grantPosition(lat: number, lng: number) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback) =>
        ok({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition),
    },
  });
}

function denyPosition() {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback) =>
        fail?.({ code: 1, message: "User denied Geolocation" } as GeolocationPositionError),
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("emp_token", "jwt-abc");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("no location, no clock", () => {
  it("does NOT post a clock when geolocation is denied", async () => {
    denyPosition();
    const calls = mockApi({ success: true });

    render(<ClockPage session={SESSION} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /تسجيل حضور/ }));

    await screen.findByText(/لا يمكن تسجيل البصمة بدون تحديد الموقع/);
    expect(
      calls.some((c) => c.url.includes("/hr/my-clock")),
      "a clock with no coordinates can never be geofence-checked",
    ).toBe(false);
  });
});

describe("the payload keeps the server's field names", () => {
  it("posts geoLat/geoLng/device/deviceName", async () => {
    grantPosition(24.7136, 46.6753);
    const calls = mockApi({ success: true, message: "تم تسجيل حضورك" });

    render(<ClockPage session={SESSION} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /تسجيل حضور/ }));

    await waitFor(() => expect(calls.some((c) => c.url.includes("/hr/my-clock"))).toBe(true));
    const clockCall = calls.find((c) => c.url.includes("/hr/my-clock"))!;
    const sent = JSON.parse(String(clockCall.init?.body));

    expect(sent.geoLat).toBe(24.7136);
    expect(sent.geoLng).toBe(46.6753);
    expect(sent.username).toBe("sara");
    expect(typeof sent.deviceName).toBe("string");
    expect(sent.device).toBeTypeOf("object");
  });
});

describe("a geofence refusal is shown, not swallowed", () => {
  it("renders the exact distance and radius from an HTTP 200 refusal", async () => {
    grantPosition(24.0, 46.0);
    // The server's shape for "you are too far away" — success:false at 200.
    mockApi({ success: false, code: "outside_fence", distance: 420, radius: 100 });

    render(<ClockPage session={SESSION} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /تسجيل حضور/ }));

    const alert = await screen.findByText(/420/);
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain("100");
  });
});
