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
// WHAT IS DELIBERATELY ABSENT
//   A company name and logo. There is no settings read for either today, and a
//   placeholder — or an empty slot that reads as a failed image — is worse than
//   a clean typographic head. When a branding source exists it goes in HERE,
//   once, and every report in the system gains it at the same moment.
import type { ReactNode } from "react";
import { cn, formatDateTime } from "@/shared/lib";
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

  return (
    <div
      className={cn("print-document", overlay && "print-document-overlay", className)}
    >
      <header className="print-only print-masthead" data-testid="print-masthead">
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
