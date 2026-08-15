// `modules/reports/engine` — the registry-driven report renderer shared by the
// People and Operations catalogues. A section supplies data (a
// ReportSectionDef); everything visual lives here, so the two sections cannot
// drift into two different-looking report pages.
export * from "./types";
export * from "./section";
export * from "./fetch";
export { GenericReportPage } from "./GenericReportPage";
