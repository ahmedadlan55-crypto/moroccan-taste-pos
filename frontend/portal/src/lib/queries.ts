// react-query bindings for the HR self-service contracts.
//
// Every key is namespaced under ["portal"] and, where the answer is
// per-employee, nothing more — the server derives the employee from the JWT, so
// there is no id to key on and a sign-out clears the cache wholesale.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type {
  HoursSummary,
  LeaveType,
  MyAttendanceRow,
  MyCustody,
  MyLeaveBalance,
  MyLeaveRequestRow,
  MyProfile,
  Payslip,
  SalaryProjection,
} from "./types";
import type { MyClockPayload, ClockResponse } from "./selfService";

export const qk = {
  all: ["portal"] as const,
  profile: () => ["portal", "profile"] as const,
  attendance: () => ["portal", "attendance"] as const,
  hours: (from: string, to: string) => ["portal", "hours", from, to] as const,
  leaveBalances: () => ["portal", "leave-balances"] as const,
  leaveRequests: () => ["portal", "leave-requests"] as const,
  leaveTypes: () => ["portal", "leave-types"] as const,
  payslips: () => ["portal", "payslips"] as const,
  projection: () => ["portal", "projection"] as const,
  custody: () => ["portal", "custody"] as const,
};

/**
 * Several HR list endpoints answer `[]` on the happy path but an object on an
 * edge (e.g. `{ error }`). Coercing here keeps every screen's `.map` safe
 * without each one re-checking Array.isArray.
 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function useProfile() {
  return useQuery({
    queryKey: qk.profile(),
    queryFn: ({ signal }) => api.get<MyProfile>("/hr/my-profile", { signal }),
    // A profile does not change during a shift.
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useAttendance() {
  return useQuery({
    queryKey: qk.attendance(),
    queryFn: ({ signal }) =>
      api.get<unknown>("/hr/my-attendance", { signal }).then(asArray<MyAttendanceRow>),
    // The clock state is derived from this — it must never serve a stale answer
    // after a clock-in, so the mutation invalidates it rather than a long TTL.
    staleTime: 0,
    retry: false,
  });
}

export function useHoursSummary(from: string, to: string) {
  return useQuery({
    queryKey: qk.hours(from, to),
    queryFn: ({ signal }) =>
      api.get<HoursSummary>("/hr/my-hours-summary", { params: { from, to }, signal }),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });
}

export function useLeaveBalances() {
  return useQuery({
    queryKey: qk.leaveBalances(),
    queryFn: ({ signal }) =>
      api.get<unknown>("/hr/my-leave-balances", { signal }).then(asArray<MyLeaveBalance>),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useLeaveRequests() {
  return useQuery({
    queryKey: qk.leaveRequests(),
    queryFn: ({ signal }) =>
      api.get<unknown>("/hr/my-leave-requests", { signal }).then(asArray<MyLeaveRequestRow>),
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useLeaveTypes(enabled = true) {
  return useQuery({
    queryKey: qk.leaveTypes(),
    queryFn: ({ signal }) => api.get<unknown>("/hr/leave-types", { signal }).then(asArray<LeaveType>),
    // A reference list — fetch it once, when the request sheet first opens.
    staleTime: 60 * 60 * 1000,
    enabled,
    retry: false,
  });
}

export function usePayslips() {
  return useQuery({
    queryKey: qk.payslips(),
    queryFn: ({ signal }) => api.get<unknown>("/hr/my-payslips", { signal }).then(asArray<Payslip>),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useProjection() {
  return useQuery({
    queryKey: qk.projection(),
    queryFn: ({ signal }) => api.get<SalaryProjection>("/hr/my-salary-projection", { signal }),
    // "Live projection that reacts to every clock-in/out" (routes/hr.js) — a
    // long TTL would defeat the point of the screen.
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useCustody(enabled: boolean) {
  return useQuery({
    queryKey: qk.custody(),
    queryFn: ({ signal }) => api.get<MyCustody>("/custody/my-custody", { signal }),
    staleTime: 60 * 1000,
    enabled,
    retry: false,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function useClock() {
  const qc = useQueryClient();
  return useMutation({
    // allowFailureBody: a geofence refusal comes back as HTTP 200 with
    // success:false plus `distance` and `radius`. Those two numbers ARE the
    // answer — "you are 420 m out, the fence is 100 m" — and letting the client
    // throw on them would leave an employee standing outside the branch reading
    // a generic failure. See RequestOptions.allowFailureBody.
    mutationFn: (body: MyClockPayload) =>
      api.post<ClockResponse>("/hr/my-clock", body, { allowFailureBody: true }),
    onSuccess: () => {
      // A clock changes today's attendance row, this month's hours, and the
      // live salary projection — all three, or the app shows the employee a
      // figure it already knows is out of date.
      void qc.invalidateQueries({ queryKey: qk.attendance() });
      void qc.invalidateQueries({ queryKey: ["portal", "hours"] });
      void qc.invalidateQueries({ queryKey: qk.projection() });
    },
  });
}

export interface LeaveRequestPayload {
  leaveTypeId: string | number;
  startDate: string;
  endDate: string;
  reason?: string;
}

export function useSubmitLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LeaveRequestPayload) =>
      api.post<{ success?: boolean; error?: string }>("/hr/my-leave-request", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.leaveRequests() });
      void qc.invalidateQueries({ queryKey: qk.leaveBalances() });
    },
  });
}
