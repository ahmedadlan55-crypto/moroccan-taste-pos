// Sales Analytics Hub — view id → page component.
//
// The view ids are the report ids in lib/reportRegistry; this map is the only
// place a report is bound to a React component, and __tests__/hubRouting.test
// asserts the two sets are identical, so a report cannot be declared without a
// page or a page shipped without a declaration.
//
// One lazily-loaded file per view, so a heavy report's code only loads when it
// is opened. Every page component is prop-less: pages read the shared filter
// state via useUrlFilters(analyticsFilterCodec) themselves (the URL is the
// single source of truth the AnalyticsTopBar also writes to).
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export const VIEW_PAGES: Readonly<
  Record<string, LazyExoticComponent<ComponentType>>
> = {
  // centre 1 — executive summary
  executive: lazy(() => import("./Executive")),
  // centre 2 — items, profitability, modifiers
  items: lazy(() => import("./Items")),
  profitability: lazy(() => import("./Profitability")),
  modifiers: lazy(() => import("./Modifiers")),
  // centre 3 — payments, VAT, reconciliation
  payments: lazy(() => import("./Payments")),
  taxes: lazy(() => import("./Taxes")),
  discounts: lazy(() => import("./Discounts")),
  reconciliation: lazy(() => import("./Reconciliation")),
  // centre 4 — operations
  branches: lazy(() => import("./Branches")),
  channels: lazy(() => import("./Channels")),
  hours: lazy(() => import("./Hours")),
  cashiers: lazy(() => import("./Cashiers")),
  shifts: lazy(() => import("./Shifts")),
  voids: lazy(() => import("./Voids")),
  orders: lazy(() => import("./Orders")),
  // centre 5 — custom explorer
  explorer: lazy(() => import("./Explorer")),
  builder: lazy(() => import("./Builder")),
};
