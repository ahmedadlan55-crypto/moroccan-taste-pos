// The head of every printed report in the hub.
//
// A printed report used to start with whatever the screen happened to render
// first — usually a KPI card — and carried no title, no period and no printed-
// at stamp. Two sheets from two days looked identical, and a sheet handed to an
// accountant did not say what it was.
//
// This is `.print-only`: invisible on screen, where the page header, the filter
// bar and the tab title already say all of it. On paper it is the identity of
// the document:
//
//     ‹report title›                                    ‹period›
//     ─────────────────────────────────────────────────────────
//     printed ‹timestamp›                        ‹basis summary›
//
// Deliberately NOT here: a company name and logo. The hub has no settings read
// for either, and inventing a placeholder — or shipping an empty slot that
// looks like a failed image — is worse than a clean typographic head. When a
// branding source exists, it belongs in this one component and every report
// gains it at once.
import { formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import type { AnalyticsFilters } from "../lib/filters";

export interface PrintMastheadProps {
  /** Segment id — resolves the report's own title. */
  segment: string;
  filters: AnalyticsFilters;
  /** Fixed timestamp, for tests. Defaults to now, stamped at render. */
  printedAt?: string;
}

export function PrintMasthead({ segment, filters, printedAt }: PrintMastheadProps) {
  const t = useT();
  const title = t(`salesReports.pages.${segment}.title`);
  const stamp = printedAt ?? new Date().toISOString();

  return (
    <header className="print-only print-masthead" data-testid="print-masthead">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8mm" }}>
        <h1 style={{ fontSize: "13pt", fontWeight: 800, margin: 0 }}>{title}</h1>
        <span style={{ fontSize: "9pt", fontWeight: 700 }} dir="ltr">
          {filters.from} — {filters.to}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "8mm",
          marginTop: "1mm",
          paddingBottom: "1.5mm",
          borderBottom: "0.4mm solid #52525b",
          fontSize: "8pt",
          fontWeight: 600,
        }}
      >
        <span>{t("salesReports.print.printedAt", { time: formatDateTime(stamp) })}</span>
        <span>
          {filters.businessDay
            ? t("salesReports.topbar.businessDay")
            : t("salesReports.topbar.calendarDay")}
          {" · "}
          {filters.taxIncl ? t("salesReports.topbar.taxIncl") : t("salesReports.topbar.taxExcl")}
        </span>
      </div>
    </header>
  );
}
