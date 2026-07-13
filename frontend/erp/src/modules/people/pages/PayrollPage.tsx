import { useState } from "react";
import { RunsList } from "../payroll/RunsList";
import { RunDetail } from "../payroll/RunDetail";

/**
 * Payroll (الرواتب) — the unified Back-Office payroll screen. Lists the monthly
 * payroll runs; selecting one opens its detail (calculate → approve → pay,
 * per-employee items and payslips). The calculation engine stays server-owned;
 * this screen drives it. Route `/people/payroll` → PayrollPage.
 */
export function PayrollPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return selectedRunId ? (
    <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
  ) : (
    <RunsList onOpen={setSelectedRunId} />
  );
}
