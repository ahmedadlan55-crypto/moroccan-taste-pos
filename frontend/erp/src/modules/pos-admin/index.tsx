// modules/pos-admin — POS administration domain (نقاط البيع). The parent router
// (src/app/router.tsx) registers EACH manifest 'pos-admin' path as its own exact
// route that renders this ONE lazy module component — there is no splat route, so
// a descendant <Routes> can't distinguish the five paths. We therefore resolve the
// active page from the current pathname, keeping the shared router/manifest
// untouched.
import { type ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { PauseCircle, RefreshCw } from "lucide-react";
import { normalizeRoutePath } from "@/shared/lib";
import { useT } from "@/i18n";
import { NotFound } from "@/app/shell/NotFound";
import { RegisterPage } from "./pages/RegisterPage";
import { ShiftsPage } from "./pages/ShiftsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { DeferredNoticePage } from "./pages/DeferredNoticePage";

function ParkedOrdersPage() {
  const t = useT();
  return (
    <DeferredNoticePage
      icon={PauseCircle}
      title={t("posAdmin.deferred.parkedTitle")}
      body={t("posAdmin.deferred.parkedBody")}
    />
  );
}

function DeviceSyncPage() {
  const t = useT();
  return (
    <DeferredNoticePage
      icon={RefreshCw}
      title={t("posAdmin.deferred.deviceTitle")}
      body={t("posAdmin.deferred.deviceBody")}
    />
  );
}

// Manifest path → page. Kept in sync with the 'pos-admin' group in the manifest.
const PAGES: Record<string, ComponentType> = {
  "/pos-admin/register": RegisterPage,
  "/pos-admin/shifts": ShiftsPage,
  "/pos-admin/parked-orders": ParkedOrdersPage,
  "/pos-admin/devices": DeviceSyncPage,
  "/pos-admin/reports": ReportsPage,
};

export function PosAdminModule() {
  const { pathname } = useLocation();
  // Never fall back to RegisterPage: that silently rendered the WRONG screen for
  // an unmapped path (e.g. a trailing slash) instead of saying so.
  const Page = PAGES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}

export default PosAdminModule;
