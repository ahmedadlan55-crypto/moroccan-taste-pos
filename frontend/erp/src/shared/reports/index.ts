// `@/shared/reports` — the document-shaped renderers.
//
// A SEPARATE barrel from `@/shared/ui` on purpose. `shared/ui` is the app's
// component kit: primitives, controls, overlays — things a screen is built out
// of. What lives here is built out of ACCOUNTING rules instead (server totals,
// hierarchy, comparative periods, what may and may not be filtered out of a
// printed copy), and mixing the two would invite the next contributor to "just
// add a subtotal row" to DataTable — which this exists precisely to avoid.
export * from "./StatementTable";
