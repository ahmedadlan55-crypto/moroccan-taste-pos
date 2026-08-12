import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { RequireAuth } from "./providers";
import { AppShell } from "./shell/AppShell";
import { CapGuard } from "./shell/CapGuard";
import { NotFound } from "./shell/NotFound";
import { LoginPage } from "./pages/Login";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { NAV_ITEMS } from "./navigation/manifest";

// ── Lazy module loaders ─────────────────────────────────────────────────────
// One code-split chunk per module folder; every nav item that routes into a
// module shares that module's lazy component. Domain agents overwrite
// src/modules/<module>/index.tsx with the real page(s) — the loader + the
// manifest entries stay the same, so nothing here changes when a module lands.
const MODULE_LOADERS: Record<string, () => Promise<{ default: ComponentType }>> = {
  overview: () => import("@/modules/overview"),
  sales: () => import("@/modules/sales"),
  customers: () => import("@/modules/customers"),
  "pos-admin": () => import("@/modules/pos-admin"),
  menu: () => import("@/modules/menu"),
  inventory: () => import("@/modules/inventory"),
  purchasing: () => import("@/modules/purchasing"),
  accounting: () => import("@/modules/accounting"),
  banking: () => import("@/modules/banking"),
  people: () => import("@/modules/people"),
  workflow: () => import("@/modules/workflow"),
  reports: () => import("@/modules/reports"),
  administration: () => import("@/modules/administration"),
  production: () => import("@/modules/production"),
};

const MODULE_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = Object.fromEntries(
  Object.entries(MODULE_LOADERS).map(([key, loader]) => [key, lazy(loader)]),
);

// The app mounts under /app in production and at root in dev. The basename is
// derived from Vite's injected BASE_URL so every route + deep link stays correct
// in both modes.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

// ── Route contract (consumed by the architecture tests) ─────────────────────
/**
 * Every route path string the router registers: one exact path per nav item,
 * PLUS a `<path>/*` splat for each item that OWNS its subtree (subRoutes:true),
 * so deep New/Details/Edit URLs mount the module instead of 404-ing.
 */
export const ROUTE_PATHS: ReadonlySet<string> = new Set<string>(
  NAV_ITEMS.flatMap((i) => (i.subRoutes ? [i.path, `${i.path}/*`] : [i.path])),
);
/**
 * Base paths of the subtree-owning items (subRoutes:true). A registered route is
 * legitimate — not an orphan — when it IS or lives UNDER one of these, so the
 * architecture coverage test can accept the splat routes without weakening.
 */
export const SUBROUTE_BASE_PATHS: ReadonlySet<string> = new Set<string>(
  NAV_ITEMS.filter((i) => i.subRoutes).map((i) => i.path),
);
// ── Retired-surface redirects (Sales Analytics Hub rationalization) ─────────
// The ONE allow-listed place old report paths may live forever: each retired
// screen keeps its deep links working by redirecting into the hub, carrying its
// query params along. `params` maps old param name → new param name; any param
// NOT in the map passes through unchanged (so foreign params like ?doc= survive).
// NOTE (release note, mandated by the rationalization doc §7): the old
// /accounting/sales-analytics page SENT brandId/branchId but the old backend
// read `brand`/`branch` — the filters never worked. The redirect carries the
// values into the hub where they filter FOR REAL for the first time; that is a
// correction, not a regression.
export interface RedirectSpec {
  from: string;
  to: string;
  /** old param name → new param name. Unmapped params pass through unchanged. */
  params?: Record<string, string>;
}

export const REDIRECTS: readonly RedirectSpec[] = [
  {
    from: "/accounting/sales-analytics",
    to: "/reports/sales/executive",
    params: { from: "from", to: "to", brandId: "brandId", branchId: "branchId" },
  },
  {
    from: "/pos-admin/reports",
    to: "/reports/sales/shifts",
    params: { from: "from", to: "to" },
  },
  // The recipe screen became a real catalog at /menu/recipes with deep-linkable
  // detail pages. Old links keep working; ?item= carried the selected product
  // and becomes ?productId= on the new surface.
  {
    from: "/menu/recipes-bom",
    to: "/menu/recipes",
    params: { item: "productId", brandId: "brandId" },
  },
];

/** Query-preserving redirect: maps params per the spec, passes the rest through.
 *  Exported for the data-driven redirect test (app/__tests__/redirects.test.tsx). */
export function RedirectWithParams({ spec }: { spec: RedirectSpec }) {
  const { search } = useLocation();
  const incoming = new URLSearchParams(search);
  const next = new URLSearchParams();
  for (const [key, value] of incoming.entries()) {
    next.append(spec.params?.[key] ?? key, value);
  }
  const qs = next.toString();
  return <Navigate to={{ pathname: spec.to, search: qs ? `?${qs}` : "" }} replace />;
}

/** Non-nav paths that are allowed to exist as routes (redirects + login + not-found). */
export const REDIRECT_PATHS: ReadonlySet<string> = new Set<string>([
  "/",
  "/login",
  // Units & barcodes are managed inside the item card (Units/Barcodes tabs), so
  // the standalone destination is a redirect, not a screen. Kept as an allowlisted
  // route so old deep links resolve instead of 404-ing.
  "/inventory/units-barcodes",
  // Retired report surfaces — derived from the ONE redirect table above so the
  // architecture test keeps covering them without a second source of truth.
  ...REDIRECTS.map((r) => r.from),
]);
/** The index route redirects to this path. */
export const INDEX_REDIRECT = "/overview";

export function AppRouter() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        {/* Public login (outside the auth gate) — the entry point when /app is
            the default and the user has no session yet. */}
        <Route path="login" element={<LoginPage />} />
        {/* Outside the shell on purpose: a user forced here by must_change_password
            must not be able to reach the app until the password is changed. */}
        <Route path="change-password" element={<ChangePasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          {/* Index → the overview screen. */}
          <Route index element={<Navigate to={INDEX_REDIRECT.replace(/^\//, "")} replace />} />

          {/* Units & barcodes moved into the item card — redirect the old path. */}
          <Route path="inventory/units-barcodes" element={<Navigate to="/inventory/items" replace />} />

          {/* Retired report surfaces → the Sales Analytics Hub, query preserved. */}
          {REDIRECTS.map((spec) => (
            <Route
              key={spec.from}
              path={spec.from.replace(/^\//, "")}
              element={<RedirectWithParams spec={spec} />}
            />
          ))}

          {/* One lazy, capability-gated route per manifest item. Items that OWN
              their subtree (subRoutes) additionally register a `<path>/*` splat,
              so deep URLs (/inventory/items/new, /inventory/items/:id, .../edit)
              mount the SAME module — which dispatches internally on the pathname.
              Every non-subRoutes item registers exactly one exact route, unchanged. */}
          {NAV_ITEMS.flatMap((item) => {
            const Page = MODULE_COMPONENTS[item.module];
            if (!Page) return [];
            const base = item.path.replace(/^\//, "");
            const element = (
              <CapGuard cap={item.cap} capsAny={item.capsAny}>
                <Page />
              </CapGuard>
            );
            const routes = [<Route key={item.id} path={base} element={element} />];
            if (item.subRoutes) {
              routes.push(<Route key={`${item.id}:splat`} path={`${base}/*`} element={element} />);
            }
            return routes;
          })}

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

