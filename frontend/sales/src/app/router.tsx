import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { RequireAuth } from "./require-auth";
import { useServerFlags } from "./server-flags";
import { useCan } from "./permission-provider";
import { AppShell } from "@/components/app-shell/AppShell";
import { LoadingState, ErrorState } from "@/components/states/States";
// Route-level code splitting: every feature page is lazy so each section
// downloads on first visit and no chunk exceeds Vite's 500KB budget. The App
// Shell (sidebar/topbar/providers) above stays eager and stable.
const DashboardPage = lazy(() => import("@/features/dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const CustomersPage = lazy(() => import("@/features/customers/CustomersPage").then((m) => ({ default: m.CustomersPage })));
const CustomerDetailPage = lazy(() => import("@/features/customers/CustomerDetailPage").then((m) => ({ default: m.CustomerDetailPage })));
const OrdersPage = lazy(() => import("@/features/orders/OrdersPage").then((m) => ({ default: m.OrdersPage })));
const OrderDetailPage = lazy(() => import("@/features/orders/OrderDetailPage").then((m) => ({ default: m.OrderDetailPage })));
const InvoicesPage = lazy(() => import("@/features/invoices/InvoicesPage").then((m) => ({ default: m.InvoicesPage })));
const InvoiceDetailPage = lazy(() => import("@/features/invoices/InvoiceDetailPage").then((m) => ({ default: m.InvoiceDetailPage })));
const PaymentsPage = lazy(() => import("@/features/payments/PaymentsPage").then((m) => ({ default: m.PaymentsPage })));
const PaymentDetailPage = lazy(() => import("@/features/payments/PaymentDetailPage").then((m) => ({ default: m.PaymentDetailPage })));
const ReturnsPage = lazy(() => import("@/features/returns/ReturnsPage").then((m) => ({ default: m.ReturnsPage })));
const ReturnDetailPage = lazy(() => import("@/features/returns/ReturnDetailPage").then((m) => ({ default: m.ReturnDetailPage })));
const ReportsPage = lazy(() => import("@/features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ReportDetailPage = lazy(() => import("@/features/reports/ReportDetailPage").then((m) => ({ default: m.ReportDetailPage })));

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

// When ORDER_TO_CASH_ENABLE is off the whole section is dormant — never a broken UI.
function DormantNotice() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6" dir="rtl">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-extrabold text-slate-900">قسم «المبيعات والعملاء» غير مُفعّل</h1>
        <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
          هذه الوحدة الموحّدة قيد التهيئة ولم تُفعّل بعد. يُرجى استخدام الشاشات الحالية من النظام الأساسي.
        </p>
      </div>
    </div>
  );
}

function PermissionDenied() {
  return (
    <div className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="text-2xl font-extrabold text-slate-900">صلاحية غير كافية</div>
      <p className="text-sm font-medium text-slate-500">لا تملك صلاحية الوصول إلى قسم المبيعات والعملاء.</p>
    </div>
  );
}

function O2CGuard({ children }: { children: React.ReactNode }) {
  const { orderToCashEnabled, loading, error } = useServerFlags();
  const canView = useCan("o2c.view");
  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={null} onRetry={() => window.location.reload()} />;
  if (!orderToCashEnabled) return <DormantNotice />;
  if (!canView) return <PermissionDenied />;
  return <>{children}</>;
}

export function AppRouter() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route
          element={
            <RequireAuth>
              <O2CGuard>
                <AppShell />
              </O2CGuard>
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Lazy><DashboardPage /></Lazy>} />
          <Route path="customers" element={<Lazy><CustomersPage /></Lazy>} />
          <Route path="customers/:id" element={<Lazy><CustomerDetailPage /></Lazy>} />
          <Route path="orders" element={<Lazy><OrdersPage /></Lazy>} />
          <Route path="orders/:id" element={<Lazy><OrderDetailPage /></Lazy>} />
          <Route path="invoices" element={<Lazy><InvoicesPage /></Lazy>} />
          <Route path="invoices/:id" element={<Lazy><InvoiceDetailPage /></Lazy>} />
          <Route path="payments" element={<Lazy><PaymentsPage /></Lazy>} />
          <Route path="payments/:id" element={<Lazy><PaymentDetailPage /></Lazy>} />
          <Route path="returns" element={<Lazy><ReturnsPage /></Lazy>} />
          <Route path="returns/:id" element={<Lazy><ReturnDetailPage /></Lazy>} />
          <Route path="reports" element={<Lazy><ReportsPage /></Lazy>} />
          <Route path="reports/:type" element={<Lazy><ReportDetailPage /></Lazy>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <div className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="text-2xl font-extrabold text-slate-900">404</div>
      <p className="text-sm font-medium text-slate-500">الصفحة غير موجودة.</p>
      <Link className="text-sm font-bold text-teal-700 hover:underline" to="/dashboard">
        العودة إلى لوحة المبيعات
      </Link>
    </div>
  );
}
