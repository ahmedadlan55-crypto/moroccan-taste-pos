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
import type { ReactNode } from "react";
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
  children: ReactNode;
}

export function PrintDocument({ title, subtitle, meta, printedAt, overlay, className, children }: PrintDocumentProps) {
  const t = useT();
  const stamp = printedAt ?? new Date().toISOString();
  const { entityName, taxNumber } = useInvoiceIdentity();
  // Absent identity prints NO line, exactly as an absent subtitle prints no
  // line — an empty rule at the top of an accounting document reads as a
  // failure, and a half-filled letterhead reads as a wrong one.
  const hasIdentity = entityName !== "" || taxNumber !== "";

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
              gap: "8mm",
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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8mm" }}>
          <h1 style={{ fontSize: "13pt", fontWeight: 800, margin: 0 }}>{title}</h1>
          {subtitle != null && (
            <span style={{ fontSize: "9pt", fontWeight: 700 }} dir="ltr">
              {subtitle}
            </span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "8mm",
            marginTop: "1mm",
            paddingBottom: "1.5mm",
            borderBottom: "0.4mm solid var(--mt-print-strong)",
            fontSize: "8pt",
            fontWeight: 600,
          }}
        >
          <span>{t("common.printedAt", { time: formatDateTime(stamp) })}</span>
          {meta != null && <span>{meta}</span>}
        </div>
      </header>
      {children}
    </div>
  );
}
