// modules/reports/receivables — the order-to-cash report section of /reports.
//
// Three parts, the same shape every section has: the declarative catalogue, the
// one generic report page, and the directory that lists it. Routing is owned
// elsewhere (modules/reports/index.tsx); nothing here reaches out of /reports.
export * from "./registry";
export { ReceivablesReportPage } from "./ReceivablesReportPage";
export { ReceivablesReportsDirectory } from "./ReceivablesReportsDirectory";
