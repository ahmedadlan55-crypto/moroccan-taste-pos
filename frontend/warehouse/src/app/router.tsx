import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { WarehouseScopeProvider } from "./warehouse-scope-provider";
import { RequireAuth } from "./require-auth";
import { AppShell } from "@/components/app-shell/AppShell";
import { LoadingState } from "@/components/states/States";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { WarehousesPage } from "@/features/warehouses/WarehousesPage";
import { InventoryPage } from "@/features/inventory/InventoryPage";
import { TransfersPage } from "@/features/transfers/TransfersPage";
import { TransferCreateWizard } from "@/features/transfers/TransferCreateWizard";
import { ReceiptsPage, ReceiptWizard } from "@/features/receipts/ReceiptsPage";
import { PurchaseReceivingPage } from "@/features/purchase-receiving/PurchaseReceivingPage";
import { PurchaseReceiveWizard } from "@/features/purchase-receiving/PurchaseReceiveWizard";
import { IssuesPage, IssueWizard } from "@/features/issues/IssuesPage";
import { AdjustmentsPage, AdjustmentWizard } from "@/features/adjustments/AdjustmentsPage";
import { StocktakesPage } from "@/features/stocktakes/StocktakesPage";
import { StocktakeWizard } from "@/features/stocktakes/StocktakeWizard";
import { CountingWorkspace } from "@/features/stocktakes/CountingWorkspace";
import { ItemsPage } from "@/features/items/ItemsPage";
import { ItemWizard } from "@/features/items/ItemWizard";
import { ReplenishmentPage } from "@/features/replenishment/ReplenishmentPage";
import { LotsPage } from "@/features/lots/LotsPage";
import { ExpiryPage } from "@/features/expiry/ExpiryPage";
import { NegativePolicyPage } from "@/features/negative-policy/NegativePolicyPage";
import { DeficitsPage } from "@/features/negative-policy/DeficitsPage";
import { ProductionPage } from "@/features/production/ProductionPage";
import { ProductionCreateWizard } from "@/features/production/ProductionCreateWizard";
import { ProductionDetailPage } from "@/features/production/ProductionDetailPage";
// Analytics + Reports pull in the heavy recharts bundle — lazy-load them so the
// initial dashboard/inventory entry stays light; the rest stay eager.
const AnalyticsPage = lazy(() => import("@/features/analytics/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const ReportsPage = lazy(() => import("@/features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ReportDetailPage = lazy(() => import("@/features/reports/ReportDetailPage").then((m) => ({ default: m.ReportDetailPage })));
// Procurement / P2P module — lazy-loaded (its own chunk, kept out of the initial
// bundle). The page components share one chunk (ProcurementPages).
const ProcurementLayout = lazy(() => import("@/features/procurement/ProcurementLayout").then((m) => ({ default: m.ProcurementLayout })));
const P = () => import("@/features/procurement/ProcurementPages");
const ProcurementDashboard = lazy(() => P().then((m) => ({ default: m.ProcurementDashboard })));
const SuppliersPage = lazy(() => P().then((m) => ({ default: m.SuppliersPage })));
const SupplierDetailPage = lazy(() => P().then((m) => ({ default: m.SupplierDetailPage })));
const OrdersPage = lazy(() => P().then((m) => ({ default: m.OrdersPage })));
const OrderDetailPage = lazy(() => P().then((m) => ({ default: m.OrderDetailPage })));
const ReceiptsListPage = lazy(() => P().then((m) => ({ default: m.ReceiptsListPage })));
const InvoicesListPage = lazy(() => P().then((m) => ({ default: m.InvoicesListPage })));
const PaymentsListPage = lazy(() => P().then((m) => ({ default: m.PaymentsListPage })));
const ReturnsListPage = lazy(() => P().then((m) => ({ default: m.ReturnsPage })));
const ProcurementReportsPage = lazy(() => P().then((m) => ({ default: m.ProcurementReportsPage })));
const OrderCreatePage = lazy(() => import("@/features/procurement/OrderCreatePage").then((m) => ({ default: m.OrderCreatePage })));
// Suspense wrapper for the lazy (code-split) routes.
function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

// The app is mounted under /warehouse-v2 in production (Strangler — runs beside
// the legacy UI) and at root in dev. The basename is derived from Vite's
// injected BASE_URL so every route + deep link stays correct in both modes.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

export function AppRouter() {
  return (
    <BrowserRouter basename={BASENAME}>
      <WarehouseScopeProvider>
        <Routes>
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="warehouses" element={<WarehousesPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route path="items/new" element={<ItemWizard />} />
            <Route path="replenishment" element={<ReplenishmentPage />} />
            <Route path="lots" element={<LotsPage />} />
            <Route path="lots/:id" element={<LotsPage />} />
            <Route path="expiry" element={<ExpiryPage />} />
            <Route path="receipts" element={<ReceiptsPage />} />
            <Route path="receipts/new" element={<ReceiptWizard />} />
            <Route path="purchase-receiving" element={<PurchaseReceivingPage />} />
            <Route path="purchase-receiving/:purchaseId" element={<PurchaseReceiveWizard />} />
            <Route path="issues" element={<IssuesPage />} />
            <Route path="issues/new" element={<IssueWizard />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="transfers/new" element={<TransferCreateWizard />} />
            <Route path="stocktakes" element={<StocktakesPage />} />
            <Route path="stocktakes/new" element={<StocktakeWizard />} />
            <Route path="stocktakes/:id/count" element={<CountingWorkspace />} />
            <Route path="adjustments" element={<AdjustmentsPage />} />
            <Route path="adjustments/new" element={<AdjustmentWizard />} />
            <Route path="production" element={<ProductionPage />} />
            <Route path="production/new" element={<ProductionCreateWizard />} />
            <Route path="production/:id" element={<ProductionDetailPage />} />
            <Route path="production/:id/edit" element={<ProductionCreateWizard />} />
            <Route path="analytics" element={<Lazy><AnalyticsPage /></Lazy>} />
            <Route path="reports" element={<Lazy><ReportsPage /></Lazy>} />
            <Route path="reports/:reportType" element={<Lazy><ReportDetailPage /></Lazy>} />
            <Route path="negative-policy" element={<NegativePolicyPage />} />
            <Route path="deficits" element={<DeficitsPage />} />
            {/* Procurement / P2P — one section, internal tabs. */}
            <Route path="purchasing" element={<Lazy><ProcurementLayout /></Lazy>}>
              <Route index element={<Lazy><ProcurementDashboard /></Lazy>} />
              <Route path="suppliers" element={<Lazy><SuppliersPage /></Lazy>} />
              <Route path="suppliers/:id" element={<Lazy><SupplierDetailPage /></Lazy>} />
              <Route path="orders" element={<Lazy><OrdersPage /></Lazy>} />
              <Route path="orders/new" element={<Lazy><OrderCreatePage /></Lazy>} />
              <Route path="orders/:id" element={<Lazy><OrderDetailPage /></Lazy>} />
              <Route path="receipts" element={<Lazy><ReceiptsListPage /></Lazy>} />
              <Route path="invoices" element={<Lazy><InvoicesListPage /></Lazy>} />
              <Route path="payments" element={<Lazy><PaymentsListPage /></Lazy>} />
              <Route path="returns" element={<Lazy><ReturnsListPage /></Lazy>} />
              <Route path="reports" element={<Lazy><ProcurementReportsPage /></Lazy>} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </WarehouseScopeProvider>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <div className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="text-2xl font-extrabold text-slate-900">404</div>
      <p className="text-sm font-medium text-slate-500">الصفحة غير موجودة.</p>
      <Link className="text-sm font-bold text-teal-700 hover:underline" to="/">
        العودة إلى مركز المستودعات
      </Link>
    </div>
  );
}
