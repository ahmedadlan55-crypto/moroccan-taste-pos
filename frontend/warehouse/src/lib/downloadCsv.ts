import { getToken } from "./api-client";

// CSV download (Phase 2B). api-client is JSON-only, so we use native fetch for
// the binary/text export, attaching the same JWT, and trigger a browser
// download from the returned blob. Throws an Error with the server message on
// failure (403 forbidden / 413 export-limit / 5xx) so the caller can surface it.
export async function downloadReportCsv(
  reportType: string,
  params: Record<string, string | number | undefined | null>,
): Promise<void> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const url = `/api/inventory/reports/${reportType}/export${qs.toString() ? `?${qs}` : ""}`;
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "same-origin",
  });
  if (!res.ok) {
    let msg = "تعذّر تصدير التقرير.";
    try {
      const j = await res.json();
      if (j && j.error) msg = String(j.error);
    } catch {
      /* non-JSON error */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `report-${reportType}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
