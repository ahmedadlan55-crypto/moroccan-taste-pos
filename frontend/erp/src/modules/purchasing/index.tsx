// modules/purchasing — Procure-to-Pay / suppliers (SD4 MERGE POINT).
//
// The warehouse app hosted P2P under one section with an <Outlet> layout + tab
// sub-nav and route-based detail/create pages. The unified shell registers each
// purchasing manifest leaf exactly (no splat), so this module renders the shared
// ProcurementLayout (tabs + the PROCUREMENT_P2P_ENABLE gate) around the page for
// the current path, and rides the same search-param protocol for sub-views:
//   ?doc=<id>  → detail page      ?new=1 → order create page
import { useLocation, useSearchParams } from "react-router-dom";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { ProcurementLayout } from "./features/procurement/ProcurementLayout";
import {
  SuppliersPage, OrdersPage, ReceiptsListPage, InvoicesListPage, PaymentsListPage, ReturnsPage,
} from "./features/procurement/ProcurementPages";
import {
  SupplierDetailPage, OrderDetailPage, ReceiptDetailPage, InvoiceDetailPage, PaymentDetailPage, ReturnDetailPage,
} from "./features/procurement/DetailPages";
import { OrderCreatePage } from "./features/procurement/OrderCreatePage";
import { RequisitionsPage } from "./requisitions/RequisitionsPage";

function Section() {
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const doc = sp.get("doc");
  const isNew = sp.get("new") === "1";

  switch (pathname) {
    case "/purchasing/suppliers":
      return doc ? <SupplierDetailPage /> : <SuppliersPage />;
    case "/purchasing/requisitions":
      return <RequisitionsPage />;
    case "/purchasing/orders":
      return isNew ? <OrderCreatePage /> : doc ? <OrderDetailPage /> : <OrdersPage />;
    case "/purchasing/receiving":
      return doc ? <ReceiptDetailPage /> : <ReceiptsListPage />;
    case "/purchasing/invoices":
      return doc ? <InvoiceDetailPage /> : <InvoicesListPage />;
    case "/purchasing/payments":
      return doc ? <PaymentDetailPage /> : <PaymentsListPage />;
    case "/purchasing/returns":
      return doc ? <ReturnDetailPage /> : <ReturnsPage />;
    default:
      return <SuppliersPage />;
  }
}

export default function PurchasingModule() {
  return (
    <WarehouseModuleProviders>
      <ProcurementLayout>
        <Section />
      </ProcurementLayout>
    </WarehouseModuleProviders>
  );
}
