// modules/pos-admin — POS administration domain (نقاط البيع). The parent router
// (src/app/router.tsx) registers EACH manifest 'pos-admin' path as its own exact
// route that renders this ONE lazy module component — there is no splat route, so
// a descendant <Routes> can't distinguish the five paths. We therefore resolve the
// active page from the current pathname (the same pattern ModulePlaceholder uses),
// keeping the shared router/manifest untouched.
import { type ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { PauseCircle, RefreshCw } from "lucide-react";
import { RegisterPage } from "./pages/RegisterPage";
import { ShiftsPage } from "./pages/ShiftsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { DeferredNoticePage } from "./pages/DeferredNoticePage";

function ParkedOrdersPage() {
  return (
    <DeferredNoticePage
      icon={PauseCircle}
      title="الطلبات المعلقة تُدار من الكاشير"
      body="الطلبات المعلقة (المحفوظة مؤقتًا) حالة تشغيلية تعيش داخل تطبيق نقطة البيع ولا يوجد لها مصدر بيانات في الواجهة الخلفية — استكملها من شاشة الكاشير."
    />
  );
}

function DeviceSyncPage() {
  return (
    <DeferredNoticePage
      icon={RefreshCw}
      title="مزامنة الأجهزة تُدار من الكاشير"
      body="مزامنة أجهزة نقاط البيع تُنفَّذ داخل تطبيق الكاشير على كل جهاز، ولا تملك الواجهة الخلفية نقطة نهاية للتحكم بها — افتح تطبيق نقطة البيع للمزامنة."
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
  const Page = PAGES[pathname] ?? RegisterPage;
  return <Page />;
}

export default PosAdminModule;
