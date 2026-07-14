import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth } from "./providers";
import { AppShell } from "./shell/AppShell";
import { CapGuard } from "./shell/CapGuard";
import { NotFound } from "./shell/NotFound";
import { LoginPage } from "./pages/Login";
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
/** Every leaf route path the router registers (one per nav item). */
export const ROUTE_PATHS: ReadonlySet<string> = new Set(NAV_ITEMS.map((i) => i.path));
/** Non-nav paths that are allowed to exist as routes (redirects + login + not-found). */
export const REDIRECT_PATHS: ReadonlySet<string> = new Set<string>([
  "/",
  "/login",
  // Units & barcodes are managed inside the item card (Units/Barcodes tabs), so
  // the standalone destination is a redirect, not a screen. Kept as an allowlisted
  // route so old deep links resolve instead of 404-ing.
  "/inventory/units-barcodes",
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

          {/* One lazy, capability-gated route per manifest item. */}
          {NAV_ITEMS.map((item) => {
            const Page = MODULE_COMPONENTS[item.module];
            if (!Page) return null;
            return (
              <Route
                key={item.id}
                path={item.path.replace(/^\//, "")}
                element={
                  <CapGuard cap={item.cap}>
                    <Page />
                  </CapGuard>
                }
              />
            );
          })}

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

