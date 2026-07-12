import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { WarehouseScopeProvider } from "./warehouse-scope-provider";
import { RequireAuth } from "./require-auth";
import { AppShell } from "@/components/app-shell/AppShell";
import { LoadingState } from "@/components/states/States";
// Route-level code splitting: every feature page is lazy so each section
// downloads on first visit and no chunk exceeds Vite's 500KB budget. The App
// Shell (sidebar/topbar/providers) above stays eager and stable.
const DashboardPage = lazy(() => import("@/features/dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const WarehousesPage = lazy(() => import("@/features/warehouses/WarehousesPage").then((m) => ({ default: m.WarehousesPage })));
const InventoryPage = lazy(() => import("@/features/inventory/InventoryPage").then((m) => ({ default: m.InventoryPage })));
const TransfersPage = lazy(() => import("@/features/transfers/TransfersPage").then((m) => ({ default: m.TransfersPage })));
const TransferCreateWizard = lazy(() => import("@/features/transfers/TransferCreateWizard").then((m) => ({ default: m.TransferCreateWizard })));
// Receipts / Issues / Adjustments each export the page + its wizard from one
// file — share the dynamic import so each pair lands in a single chunk.
const R = () => import("@/features/receipts/ReceiptsPage");
const ReceiptsPage = lazy(() => R().then((m) => ({ default: m.ReceiptsPage })));
const ReceiptWizard = lazy(() => R().then((m) => ({ default: m.ReceiptWizard })));
const PurchaseReceivingPage = lazy(() => import("@/features/purchase-receiving/PurchaseReceivingPage").then((m) => ({ default: m.PurchaseReceivingPage })));
const PurchaseReceiveWizard = lazy(() => import("@/features/purchase-receiving/PurchaseReceiveWizard").then((m) => ({ default: m.PurchaseReceiveWizard })));
const I = () => import("@/features/issues/IssuesPage");
const IssuesPage = lazy(() => I().then((m) => ({ default: m.IssuesPage })));
const IssueWizard = lazy(() => I().then((m) => ({ default: m.IssueWizard })));
const A = () => import("@/features/adjustments/AdjustmentsPage");
const AdjustmentsPage = lazy(() => A().then((m) => ({ default: m.AdjustmentsPage })));
const AdjustmentWizard = lazy(() => A().then((m) => ({ default: m.AdjustmentWizard })));
const StocktakesPage = lazy(() => import("@/features/stocktakes/StocktakesPage").then((m) => ({ default: m.StocktakesPage })));
const StocktakeWizard = lazy(() => import("@/features/stocktakes/StocktakeWizard").then((m) => ({ default: m.StocktakeWizard })));
const CountingWorkspace = lazy(() => import("@/features/stocktakes/CountingWorkspace").then((m) => ({ default: m.CountingWorkspace })));
const ItemsPage = lazy(() => import("@/features/items/ItemsPage").then((m) => ({ default: m.ItemsPage })));
const ItemWizard = lazy(() => import("@/features/items/ItemWizard").then((m) => ({ default: m.ItemWizard })));
const ReplenishmentPage = lazy(() => import("@/features/replenishment/ReplenishmentPage").then((m) => ({ default: m.ReplenishmentPage })));
const LotsPage = lazy(() => import("@/features/lots/LotsPage").then((m) => ({ default: m.LotsPage })));
const ExpiryPage = lazy(() => import("@/features/expiry/ExpiryPage").then((m) => ({ default: m.ExpiryPage })));
const NegativePolicyPage = lazy(() => import("@/features/negative-policy/NegativePolicyPage").then((m) => ({ default: m.NegativePolicyPage })));
const DeficitsPage = lazy(() => import("@/features/negative-policy/DeficitsPage").then((m) => ({ default: m.DeficitsPage })));
const ProductionPage = lazy(() => import("@/features/production/ProductionPage").then((m) => ({ default: m.ProductionPage })));
const ProductionCreateWizard = lazy(() => import("@/features/production/ProductionCreateWizard").then((m) => ({ default: m.ProductionCreateWizard })));
const ProductionDetailPage = lazy(() => import("@/features/production/ProductionDetailPage").then((m) => ({ default: m.ProductionDetailPage })));
// Analytics + Reports pull in the heavy recharts bundle — lazy-loaded like the
// rest so the initial entry stays light.
const AnalyticsPage = lazy(() => import("@/features/analytics/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const ReportsPage = lazy(() => import("@/features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ReportDetailPage = lazy(() => import("@/features/reports/ReportDetailPage").then((m) => ({ default: m.ReportDetailPage })));
// Procurement / P2P module — lazy-loaded (its own chunk, kept out of the initial
// bundle). The page components share one chunk (ProcurementPages).
const ProcurementLayout = lazy(() => import("@/features/procurement/ProcurementLayout").then((m) => ({ default: m.ProcurementLayout })));
const P = () => import("@/features/procurement/ProcurementPages");
const D = () => import("@/features/procurement/DetailPages");
const ProcurementDashboard = lazy(() => P().then((m) => ({ default: m.ProcurementDashboard })));
const SuppliersPage = lazy(() => P().then((m) => ({ default: m.SuppliersPage })));
const OrdersPage = lazy(() => P().then((m) => ({ default: m.OrdersPage })));
const ReceiptsListPage = lazy(() => P().then((m) => ({ default: m.ReceiptsListPage })));
const InvoicesListPage = lazy(() => P().then((m) => ({ default: m.InvoicesListPage })));
const PaymentsListPage = lazy(() => P().then((m) => ({ default: m.PaymentsListPage })));
const ReturnsListPage = lazy(() => P().then((m) => ({ default: m.ReturnsPage })));
const ProcurementReportsPage = lazy(() => P().then((m) => ({ default: m.ProcurementReportsPage })));
const SupplierDetailPage = lazy(() => D().then((m) => ({ default: m.SupplierDetailPage })));
const OrderDetailPage = lazy(() => D().then((m) => ({ default: m.OrderDetailPage })));
const ReceiptDetailPage = lazy(() => D().then((m) => ({ default: m.ReceiptDetailPage })));
const InvoiceDetailPage = lazy(() => D().then((m) => ({ default: m.InvoiceDetailPage })));
const PaymentDetailPage = lazy(() => D().then((m) => ({ default: m.PaymentDetailPage })));
const ReturnDetailPage = lazy(() => D().then((m) => ({ default: m.ReturnDetailPage })));
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
            <Route index element={<Lazy><DashboardPage /></Lazy>} />
            <Route path="warehouses" element={<Lazy><WarehousesPage /></Lazy>} />
            <Route path="inventory" element={<Lazy><InventoryPage /></Lazy>} />
            <Route path="items" element={<Lazy><ItemsPage /></Lazy>} />
            <Route path="items/new" element={<Lazy><ItemWizard /></Lazy>} />
            <Route path="replenishment" element={<Lazy><ReplenishmentPage /></Lazy>} />
            <Route path="lots" element={<Lazy><LotsPage /></Lazy>} />
            <Route path="lots/:id" element={<Lazy><LotsPage /></Lazy>} />
            <Route path="expiry" element={<Lazy><ExpiryPage /></Lazy>} />
            <Route path="receipts" element={<Lazy><ReceiptsPage /></Lazy>} />
            <Route path="receipts/new" element={<Lazy><ReceiptWizard /></Lazy>} />
            <Route path="purchase-receiving" element={<Lazy><PurchaseReceivingPage /></Lazy>} />
            <Route path="purchase-receiving/:purchaseId" element={<Lazy><PurchaseReceiveWizard /></Lazy>} />
            <Route path="issues" element={<Lazy><IssuesPage /></Lazy>} />
            <Route path="issues/new" element={<Lazy><IssueWizard /></Lazy>} />
            <Route path="transfers" element={<Lazy><TransfersPage /></Lazy>} />
            <Route path="transfers/new" element={<Lazy><TransferCreateWizard /></Lazy>} />
            <Route path="stocktakes" element={<Lazy><StocktakesPage /></Lazy>} />
            <Route path="stocktakes/new" element={<Lazy><StocktakeWizard /></Lazy>} />
            <Route path="stocktakes/:id/count" element={<Lazy><CountingWorkspace /></Lazy>} />
            <Route path="adjustments" element={<Lazy><AdjustmentsPage /></Lazy>} />
            <Route path="adjustments/new" element={<Lazy><AdjustmentWizard /></Lazy>} />
            <Route path="production" element={<Lazy><ProductionPage /></Lazy>} />
            <Route path="production/new" element={<Lazy><ProductionCreateWizard /></Lazy>} />
            <Route path="production/:id" element={<Lazy><ProductionDetailPage /></Lazy>} />
            <Route path="production/:id/edit" element={<Lazy><ProductionCreateWizard /></Lazy>} />
            <Route path="analytics" element={<Lazy><AnalyticsPage /></Lazy>} />
            <Route path="reports" element={<Lazy><ReportsPage /></Lazy>} />
            <Route path="reports/:reportType" element={<Lazy><ReportDetailPage /></Lazy>} />
            <Route path="negative-policy" element={<Lazy><NegativePolicyPage /></Lazy>} />
            <Route path="deficits" element={<Lazy><DeficitsPage /></Lazy>} />
            {/* Procurement / P2P — one section, internal tabs. */}
            <Route path="purchasing" element={<Lazy><ProcurementLayout /></Lazy>}>
              <Route index element={<Lazy><ProcurementDashboard /></Lazy>} />
              <Route path="suppliers" element={<Lazy><SuppliersPage /></Lazy>} />
              <Route path="suppliers/:id" element={<Lazy><SupplierDetailPage /></Lazy>} />
              <Route path="orders" element={<Lazy><OrdersPage /></Lazy>} />
              <Route path="orders/new" element={<Lazy><OrderCreatePage /></Lazy>} />
              <Route path="orders/:id" element={<Lazy><OrderDetailPage /></Lazy>} />
              <Route path="receipts" element={<Lazy><ReceiptsListPage /></Lazy>} />
              <Route path="receipts/:id" element={<Lazy><ReceiptDetailPage /></Lazy>} />
              <Route path="invoices" element={<Lazy><InvoicesListPage /></Lazy>} />
              <Route path="invoices/:id" element={<Lazy><InvoiceDetailPage /></Lazy>} />
              <Route path="payments" element={<Lazy><PaymentsListPage /></Lazy>} />
              <Route path="payments/:id" element={<Lazy><PaymentDetailPage /></Lazy>} />
              <Route path="returns" element={<Lazy><ReturnsListPage /></Lazy>} />
              <Route path="returns/:id" element={<Lazy><ReturnDetailPage /></Lazy>} />
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
