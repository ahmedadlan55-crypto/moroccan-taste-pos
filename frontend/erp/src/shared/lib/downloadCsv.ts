import { getToken } from "@/shared/api";

// CSV download helper. The api-client is JSON-only, so we use native fetch for
// binary/text exports, attaching the same JWT, and trigger a browser download
// from the returned blob. Throws an Error with the server message on failure
// (403 forbidden / 413 export-limit / 5xx) so the caller can surface it.
//
// `endpoint` is an /api-relative path (with or without the /api prefix); domain
// pages pass their own export endpoint. A convenience wrapper for the inventory
// report exporter is kept below for parity with the warehouse app.
export async function downloadCsv(
  endpoint: string,
  filename: string,
  params: Record<string, string | number | undefined | null> = {},
): Promise<void> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const base = endpoint.startsWith("/api") ? endpoint : `/api${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const url = `${base}${qs.toString() ? `?${qs}` : ""}`;
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "same-origin",
  });
  if (!res.ok) {
    let msg = "تعذّر تصدير الملف.";
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
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** Parity wrapper for the inventory report exporter (mirrors the warehouse app). */
export async function downloadReportCsv(
  reportType: string,
  params: Record<string, string | number | undefined | null>,
): Promise<void> {
  return downloadCsv(
    `/inventory/reports/${reportType}/export`,
    `report-${reportType}-${new Date().toISOString().slice(0, 10)}.csv`,
    params,
  );
}
