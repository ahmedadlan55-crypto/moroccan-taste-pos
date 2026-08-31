// The export toolbar every report shares.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Six report shells grew independently, and each re-implemented "print" and
// "export CSV" next to its own layout. That duplication was survivable while
// the two buttons were one line each. Server-side PDF is not one line: it
// needs a capability probe before the button is offered, a capture of the
// printable subtree, a coded 503 to fall back from, and a busy state. Written
// six times it would be wrong in five — and it was. When PDF shipped, exactly
// ONE shell got the button, so most reports in the product could not produce
// a PDF at all.
//
// So this owns the export CONTRACT, not the layout. The shells differ in
// structure for real reasons — purchasing renders a separate print-only
// document, the sales hub wraps lazily-loaded views, inventory nests its
// header inside PrintDocument — and forcing those into one component would be
// a rewrite of five working surfaces to gain nothing a shared toolbar does not
// already give. Each keeps its layout and drops this into the action slot it
// already has.
//
// ─── WHY PDF FALLS BACK INSTEAD OF FAILING ──────────────────────────────────
// The renderer is an OS package and can be absent. When it is, the server
// answers a coded 503 and this opens the print dialog, which produces the same
// document through the same stylesheet. The user gets their PDF either way;
// only the number of clicks changes.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, FileText, Printer } from "lucide-react";
import { Button } from "@/shared/ui";
import { capturePrintDocument, downloadReportPdf, pdfAvailable } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { printReport } from "@/modules/accounting/components";

/** Wide tables get landscape paper. One threshold, in one place. */
export const LANDSCAPE_COLUMN_THRESHOLD = 7;

export interface ReportExportActionsProps {
  /** Document title, and the default PDF filename. */
  title: string;
  /** Filename stem, when it should differ from the title. */
  filename?: string;
  /**
   * Column count, so ONE threshold decides landscape for every report instead
   * of each page picking its own.
   */
  columnCount?: number;
  /** Explicit override when the page knows better than the column count. */
  landscape?: boolean;
  /**
   * The page's own CSV producer. When omitted the button is not rendered at
   * all, rather than shown and inert.
   */
  onExportCsv?: () => void | Promise<void>;
  /**
   * True while the data is missing or still loading. Every action is disabled:
   * printing a half-loaded report produces a sheet that looks complete and is
   * not.
   */
  disabled?: boolean;
  /** Extra controls (a back link, a scope switch) rendered before the group. */
  children?: ReactNode;
  className?: string;
}

export function ReportExportActions({
  title,
  filename,
  columnCount,
  landscape,
  onExportCsv,
  disabled = false,
  children,
  className,
}: ReportExportActionsProps) {
  const t = useT();
  const lang = useLang();
  const [canPdf, setCanPdf] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);

  // Ask BEFORE offering the button, rather than presenting an action that
  // fails when pressed.
  useEffect(() => {
    let alive = true;
    void pdfAvailable().then((ok) => { if (alive) setCanPdf(ok); });
    return () => { alive = false; };
  }, []);

  const isLandscape = useMemo(
    () => (landscape != null ? landscape : (columnCount ?? 0) >= LANDSCAPE_COLUMN_THRESHOLD),
    [landscape, columnCount],
  );

  async function onPdf() {
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
        landscape: isLandscape,
        direction: lang === "ar" ? "rtl" : "ltr",
      });
      // A host with no renderer is not an error the user caused.
      if (!rendered) printReport();
    } catch {
      printReport();
    } finally {
      setPdfBusy(false);
    }
  }

  async function onCsv() {
    if (!onExportCsv) return;
    setCsvBusy(true);
    try {
      await onExportCsv();
    } finally {
      setCsvBusy(false);
    }
  }

  return (
    <div className={`no-print flex w-full flex-wrap items-center gap-2 sm:w-auto ${className ?? ""}`}>
      {children}
      {onExportCsv ? (
        <Button
          className="flex-1 sm:flex-none"
          variant="secondary"
          onClick={onCsv}
          loading={csvBusy}
          disabled={disabled}
        >
          <Download className="h-4 w-4" /> {t("table.exportCsv")}
        </Button>
      ) : null}
      {canPdf ? (
        <Button
          className="flex-1 sm:flex-none"
          variant="secondary"
          onClick={onPdf}
          loading={pdfBusy}
          disabled={disabled}
        >
          <FileText className="h-4 w-4" /> {t("operationalReports.downloadPdf")}
        </Button>
      ) : null}
      <Button
        className="flex-1 sm:flex-none"
        variant="secondary"
        onClick={printReport}
        disabled={disabled}
      >
        <Printer className="h-4 w-4" /> {t("operationalReports.print")}
      </Button>
    </div>
  );
}
