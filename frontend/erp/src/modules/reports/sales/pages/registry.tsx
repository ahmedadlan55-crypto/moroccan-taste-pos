// Sales Analytics Hub — segment → page-component registry.
//
// One lazily-loaded file per segment so the two pages waves (1–8 and 9–16) own
// disjoint files, and so a heavy page's code only loads when its tab mounts.
// Every page component is prop-less: pages read the shared filter state via
// useUrlFilters(analyticsFilterCodec) themselves (the URL is the single source
// of truth the AnalyticsTopBar also writes to).
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export const SEGMENT_PAGES: Readonly<
  Record<string, LazyExoticComponent<ComponentType>>
> = {
  executive: lazy(() => import("./Executive")),
  explorer: lazy(() => import("./Explorer")),
  items: lazy(() => import("./Items")),
  modifiers: lazy(() => import("./Modifiers")),
  payments: lazy(() => import("./Payments")),
  cashiers: lazy(() => import("./Cashiers")),
  branches: lazy(() => import("./Branches")),
  hours: lazy(() => import("./Hours")),
  orders: lazy(() => import("./Orders")),
  discounts: lazy(() => import("./Discounts")),
  voids: lazy(() => import("./Voids")),
  shifts: lazy(() => import("./Shifts")),
  taxes: lazy(() => import("./Taxes")),
  profitability: lazy(() => import("./Profitability")),
  reconciliation: lazy(() => import("./Reconciliation")),
  builder: lazy(() => import("./Builder")),
};
