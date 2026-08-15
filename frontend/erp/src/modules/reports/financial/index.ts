// modules/reports/financial — the financial reports section.
//
// Three things leave this barrel and nothing else:
//   · FinancialReportsDirectory — the catalogue at /reports/financial
//   · the registry               — ids, labels, capabilities, lazy pages
//   · renderFinancialReport(id)  — what /reports/financial/<id> renders
//
// The router never imports an accounting page directly; it asks for an id.
// That keeps "which component is this report" in ONE table instead of in the
// route table as well, which is how the two drift apart.
export { default as FinancialReportsDirectory } from "./FinancialReportsDirectory";
export {
  FINANCIAL_REPORTS,
  FINANCIAL_REPORT_BY_ID,
  financialReportPath,
  isFinancialReportId,
  renderFinancialReport,
  type FinancialReport,
  type FinancialReportId,
} from "./registry";
