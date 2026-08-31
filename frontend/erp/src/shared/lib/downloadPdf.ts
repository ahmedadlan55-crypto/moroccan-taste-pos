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
  /**
   * The stylesheets this page is using.
   *
   * The captured HTML is class names and nothing else, so without these
   * the PDF is unstyled text that still calls itself a report. The server
   * accepts only same-origin paths, because it links them into a page it
   * renders in a real browser.
   */
  styles?: string[];
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
/**
 * The same-origin stylesheets currently applied to this page.
 *
 * Paths only: an absolute URL would be pointless (the renderer resolves
 * against its own loopback origin) and the server rejects it anyway. Vite
 * emits hashed filenames, so reading them off the live document is the only
 * way to name them correctly — a hard-coded path goes stale on the next
 * build and takes the styling with it, silently.
 */
export function collectStyleHrefs(): string[] {
  if (typeof document === "undefined") return [];
  const out: string[] = [];
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
    // `link.href` is absolute; compare origins and keep the path.
    try {
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      out.push(url.pathname + url.search);
    } catch {
      /* an href the URL parser rejects is not one we can send */
    }
  });
  return out;
}

export async function downloadReportPdf(request: PdfRequest): Promise<boolean> {
  const token = getToken();
  const res = await fetch("/api/erp/reports/pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "same-origin",
    // Default the stylesheets from the live document, so no caller has to
      // remember — forgetting produces a PDF that renders fine and looks
      // nothing like the report.
    body: JSON.stringify({ styles: collectStyleHrefs(), ...request }),
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
