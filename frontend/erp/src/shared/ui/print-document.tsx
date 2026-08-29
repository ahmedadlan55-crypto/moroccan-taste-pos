// The one house style for every report printed inside the system.
//
// THE PROBLEM THIS SOLVES
//   Printing was per-screen and therefore inconsistent. Eleven accounting pages
//   wrapped their body in `.print-document`, so the print stylesheet could hide
//   the app chrome around them. Seven other screens — customers, lots, expiry,
//   replenishment, inventory reports, procurement documents — called
//   `window.print()` with no wrapper at all, so they printed the sidebar, the
//   filter bar and every button along with the report. And NONE of them put a
//   title, a period or a printed-at stamp on the paper: two sheets from two
//   different days were indistinguishable, and a sheet handed to an accountant
//   did not say what it was.
//
//   A report printed from inside the system is an accounting document. It
//   should look the same whichever screen produced it. So the wrapper and the
//   masthead are one component, and using it is the only thing a screen has to
//   do to print correctly.
//
// USAGE
//   <PrintDocument title={t("...")} subtitle={period}>
//     …the report body…
//   </PrintDocument>
//
//   `title` is required precisely because an untitled printout is the defect
//   this exists to remove — there is no "just wrap it" escape hatch.
//
// WHO ISSUED THE SHEET
//   This block used to say a company name was "deliberately absent" because no
//   settings read existed. One exists now — GET /api/settings/invoice-identity,
//   the same resolution (branch → brand → company → global) that stamps the
//   seller block on every tax invoice — so the promised insertion has been made:
//   the entity's legal name and VAT registration number print at the head of the
//   document, ONCE, and every report in the system gained it at that moment.
//
//   Two rules the implementation keeps.
//     · It never blocks. `useInvoiceIdentity` returns null on any failure —
//       offline, 403, no QueryClient in the tree — and the masthead then prints
//       exactly the clean typographic head it printed before. A report that
//       refuses to print because a letterhead is missing is worse than a report
//       with no letterhead.
//     · It never invents. An unknown legal name prints nothing; it does not
//       fall back to the app name, the document title, or a placeholder. A
//       fabricated issuer on an accounting document is a lie on paper.
//
//   The LOGO is still absent, and still deliberately: it is a base64 data-URL of
//   tens of KB whose failure mode on paper is a broken-image box where the
//   issuer should be. Legal name + VAT number is what a statement is required to
//   carry; the logo can follow once there is a print-time fallback for it.
import { useEffect, useState, type ReactNode } from "react";
import { cn, formatDateTime } from "@/shared/lib";
import { useInvoiceIdentity } from "@/shared/hooks/useInvoiceIdentity";
import { useT } from "@/i18n";

export interface PrintDocumentProps {
  /** The report's own name. Printed as the document title. */
  title: string;
  /** Period, scope, or whatever identifies THIS run of the report. */
  subtitle?: ReactNode;
  /** Extra identity on the right of the second line (basis, filters, branch). */
  meta?: ReactNode;
  /** Fixed timestamp, for tests. Defaults to the moment of render. */
  printedAt?: string;
  /**
   * TRUE when this document lives in a dialog or drawer ON TOP of a page that
   * is itself a printable document.
   *
   * Both are then `.print-document` and both print: pressing "print this lot
   * card" emitted the one-lot card AND the entire lots catalogue underneath it.
   * An overlay document wins — it is what the user is looking at and what the
   * print button belongs to.
   */
  overlay?: boolean;
  /**
   * Layout classes for the wrapper. PrintDocument usually REPLACES a page's
   * outer layout div, so it has to carry that div's classes — dropping them
   * silently changes the screen layout while "only" fixing print.
   */
  className?: string;
  /**
   * What this sheet of paper is, once it leaves the screen.
   *
   * A printed report outlives its tab. Without this block a reader cannot
   * tell whether the rows in front of them are the whole report or one page
   * of it, which filters produced them, or who to ask — and the totals row at
   * the bottom describes the full set either way. `complete: false` prints an
   * explicit warning rather than letting the omission pass silently.
   */
  provenance?: {
    /** Identifies THIS run when someone brings the paper back with a question. */
    reportRunId?: string;
    rowCount?: number;
    /** false ⇒ the sheet says so, in words, on the page. */
    complete?: boolean;
    /** The filters that actually shaped the numbers. */
    filters?: string;
    /** Where the figures came from, and on what basis they were measured. */
    source?: string;
    basis?: string;
    user?: string;
  };
  children: ReactNode;
}

export function PrintDocument({ title, subtitle, meta, printedAt, overlay, className, provenance, children }: PrintDocumentProps) {
  const t = useT();
  const [liveStamp, setLiveStamp] = useState(() => printedAt ?? new Date().toISOString());
  const stamp = printedAt ?? liveStamp;
  const { entityName, taxNumber } = useInvoiceIdentity();
  // Absent identity prints NO line, exactly as an absent subtitle prints no
  // line — an empty rule at the top of an accounting document reads as a
  // failure, and a half-filled letterhead reads as a wrong one.
  const hasIdentity = entityName !== "" || taxNumber !== "";

  // A report can stay open for hours. Stamp the act of PRINTING, not the act of
  // first rendering the page; an explicit stamp remains fixed for tests and
  // frozen historical documents.
  useEffect(() => {
    if (printedAt) {
      setLiveStamp(printedAt);
      return undefined;
    }
    const refreshStamp = () => setLiveStamp(new Date().toISOString());
    window.addEventListener("beforeprint", refreshStamp);
    return () => window.removeEventListener("beforeprint", refreshStamp);
  }, [printedAt]);

  return (
    <div
      className={cn("print-document", overlay && "print-document-overlay", className)}
    >
      <header className="print-only print-masthead" data-testid="print-masthead">
        {hasIdentity && (
          <div
            data-testid="print-identity"
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "4mm 8mm",
              flexWrap: "wrap",
              marginBottom: "1.5mm",
              fontSize: "10pt",
              fontWeight: 700,
            }}
          >
            {entityName !== "" && <span>{entityName}</span>}
            {taxNumber !== "" && (
              <span style={{ fontSize: "8pt", fontWeight: 600 }}>
                {t("common.vatNumber")}: <span dir="ltr">{taxNumber}</span>
              </span>
            )}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "4mm 8mm", flexWrap: "wrap" }}>
          <h1 style={{ minWidth: 0, overflowWrap: "anywhere", fontSize: "13pt", fontWeight: 800, margin: 0 }}>{title}</h1>
          {subtitle != null && (
            <span style={{ minWidth: 0, overflowWrap: "anywhere", fontSize: "9pt", fontWeight: 700 }} dir="auto">
              {subtitle}
            </span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "4mm 8mm",
            flexWrap: "wrap",
            marginTop: "1mm",
            paddingBottom: "1.5mm",
            borderBottom: "0.4mm solid var(--mt-print-strong)",
            fontSize: "8pt",
            fontWeight: 600,
          }}
        >
          <span>{t("common.printedAt", { time: formatDateTime(stamp) })}</span>
          {meta != null && <span dir="auto">{meta}</span>}
        </div>
        {provenance && <PrintProvenance {...provenance} />}
      </header>
      {children}
    </div>
  );
}

/**
 * The provenance strip. Print-only, small, and deliberately dense: it is
 * reference material for someone holding the page, not part of the report.
 */
function PrintProvenance({
  reportRunId, rowCount, complete, filters, source, basis, user,
}: NonNullable<PrintDocumentProps["provenance"]>) {
  const t = useT();
  const parts: Array<[string, string]> = [];
  if (source) parts.push([t("print.source"), source]);
  if (basis) parts.push([t("print.basis"), basis]);
  if (filters) parts.push([t("print.filters"), filters]);
  if (rowCount != null) parts.push([t("print.rowCount"), String(rowCount)]);
  if (user) parts.push([t("print.preparedBy"), user]);
  if (!parts.length && complete !== false && !reportRunId) return null;
  return (
    <div style={{ marginTop: "1.5mm", fontSize: "7.5pt", fontWeight: 600, lineHeight: 1.5 }}>
      {complete === false && (
        // Said in words, on the paper. A short report that looks whole is the
        // failure this whole block exists to prevent.
        <div style={{ fontWeight: 800 }}>{t("print.incomplete")}</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1mm 4mm" }}>
        {parts.map(([label, value]) => (
          <span key={label}>
            {label} <span dir="auto">{value}</span>
          </span>
        ))}
        {reportRunId && (
          // LTR: an identifier, not prose. In an RTL page its segments would
          // otherwise render out of order and be unquotable over the phone.
          <span>
            {t("print.runId")} <span dir="ltr">{reportRunId}</span>
          </span>
        )}
      </div>
    </div>
  );
}
