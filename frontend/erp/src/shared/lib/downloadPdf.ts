import { getToken } from "@/shared/api";

// Report → PDF, rendered server-side by Chromium.
//
// ─── WHY THE CLIENT SENDS THE MARKUP ────────────────────────────────────────
// The server could open the report's own URL in a browser, but that renderer
// would need the user's session, filters, warehouse scope and language — a
// second implementation of every report, authenticated differently, drifting
// from the first. The page already holds the exact document it prints, so
// sending THAT makes the PDF and the printed sheet the same artifact by
// construction.
//
// ─── WHY IT FALLS BACK INSTEAD OF FAILING ───────────────────────────────────
// The browser binary is an OS package and can be absent. When it is, the server
// answers a coded 503 and this helper opens the print dialog — which produces
// the same document through the same stylesheet. The user gets their PDF either
// way; only the number of clicks changes.

/** The server's answer when this host has no renderer installed. */
export const PDF_UNAVAILABLE = "PDF_RENDERER_UNAVAILABLE";

export interface PdfRequest {
  /** The `.print-document` subtree — the document, not the whole page. */
  html: string;

  title: string;
  filename?: string;
  landscape?: boolean;
  direction?: "rtl" | "ltr";
}

/** Does this deployment have a PDF renderer? Ask BEFORE offering the button. */
export async function pdfAvailable(): Promise<boolean> {
  try {
    const token = getToken();
    const res = await fetch("/api/erp/reports/pdf/capability", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "same-origin",
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.data?.available === true;
  } catch {
    // A probe that cannot answer is not a reason to show a broken button.
    return false;
  }
}

/**
 * Render and download. Returns `false` when the host has no renderer, so the
 * caller can fall back to `window.print()` — it does NOT throw for that case,
 * because an uninstalled optional component is not an error the user caused.
 * Genuine failures (403, 5xx) still throw.
 */
export async function downloadReportPdf(request: PdfRequest): Promise<boolean> {
  const token = getToken();
  const res = await fetch("/api/erp/reports/pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "same-origin",
    // The server inlines the SPA stylesheet from its own disk — it is
    // already serving that exact file — so the request carries only the
    // document. An earlier version sent the hrefs and let the renderer
    // fetch them back over loopback; the fetch never arrived and the PDF
    // came out unstyled with nothing reporting a failure.
    body: JSON.stringify(request),
  });

  if (res.status === 503) {
    let code: string | undefined;
    try { code = (await res.json())?.code; } catch { /* non-JSON */ }
    if (code === PDF_UNAVAILABLE) return false;
  }
  if (!res.ok) {
    let message = "تعذّر إنشاء ملف PDF.";
    try {
      const body = await res.json();
      if (body?.error) message = String(body.error);
    } catch { /* non-JSON error */ }
    throw new Error(message);
  }

  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${request.filename || request.title || "report"}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  return true;
}

/**
 * Lift the printable document out of the live page.
 *
 * `.print-document` is the element the print stylesheet already treats as the
 * document; taking the whole page would carry the sidebar, the filter card and
 * every button into the PDF. Returns null when the page has no printable
 * document, so the caller can stay quiet rather than send an empty request.
 */
export function capturePrintDocument(): string | null {
  if (typeof document === "undefined") return null;
  // An overlay document (a dialog printed on top of a page that is itself
  // printable) wins — it is what the user is looking at and what the button
  // belongs to. Same precedence the print CSS uses.
  const node =
    document.querySelector(".print-document-overlay") ??
    document.querySelector(".print-document");
  if (!node) return null;
  const clone = node.cloneNode(true) as HTMLElement;
  // Screen-only chrome is marked `.no-print` and must not reach the paper.
  clone.querySelectorAll(".no-print").forEach((el) => el.remove());
  return clone.innerHTML;
}
