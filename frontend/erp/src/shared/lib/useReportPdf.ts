import { useEffect, useState } from "react";
import { capturePrintDocument, downloadReportPdf, pdfAvailable } from "./downloadPdf";

// One implementation of "turn this report into a PDF", for every report shell.
//
// ─── WHY A HOOK, AND WHY HERE ───────────────────────────────────────────────
// Two unrelated toolbars need this: the reports module's own export group, and
// `ReportHeader`, which eleven accounting and receivables statements render.
// Putting the logic in either one and importing it from the other would close
// a cycle (the reports shell already imports from accounting). `shared/lib`
// is what both already depend on, and it is where `downloadReportPdf` lives.
//
// ─── THE PARTS THAT ARE EASY TO GET WRONG ───────────────────────────────────
//   · PROBE BEFORE OFFERING. The browser binary is an OS package and can be
//     absent. A button that 503s when pressed is worse than no button, so the
//     caller renders nothing until `canPdf` is true.
//   · FALL BACK, DO NOT FAIL. An uninstalled optional component is not an
//     error the user caused. On a coded 503 this opens the print dialog, which
//     produces the same document through the same stylesheet.
//   · NEVER PDF A REPORT THAT MUST NOT PRINT. A statement whose source failed
//     still has a page around it. Callers pass the same `disabled` they pass
//     to print — a PDF route around a blocked print button would reintroduce
//     the exact defect the block exists to prevent, one button over.

export interface UseReportPdfOptions {
  /** Document title, and the default filename. */
  title: string;
  filename?: string;
  landscape?: boolean;
  direction?: "rtl" | "ltr";
}

export interface UseReportPdf {
  /** Does this deployment have a renderer? False until the probe answers. */
  canPdf: boolean;
  /** True while a render is in flight. */
  pdfBusy: boolean;
  /** Capture the printable document and download it, or fall back to print. */
  renderPdf: () => Promise<void>;
}

export function useReportPdf(options: UseReportPdfOptions): UseReportPdf {
  const { title, filename, landscape, direction } = options;
  const [canPdf, setCanPdf] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void pdfAvailable().then((ok) => { if (alive) setCanPdf(ok); });
    return () => { alive = false; };
  }, []);

  async function renderPdf(): Promise<void> {
    const html = capturePrintDocument();
    // No printable document on the page means there is nothing to send. Stay
    // quiet rather than posting an empty render the server would reject.
    if (!html) return;
    setPdfBusy(true);
    try {
      const rendered = await downloadReportPdf({
        html,
        title,
        filename: filename || title,
        landscape: landscape === true,
        direction: direction === "ltr" ? "ltr" : "rtl",
      });
      if (!rendered) window.print();
    } catch {
      window.print();
    } finally {
      setPdfBusy(false);
    }
  }

  return { canPdf, pdfBusy, renderPdf };
}
