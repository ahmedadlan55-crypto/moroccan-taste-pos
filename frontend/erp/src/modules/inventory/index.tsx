// modules/inventory — Inventory domain (SD4 MERGE POINT).
//
// The unified shell registers ONE exact route per manifest leaf and renders this
// module component for each. There is no shell-level splat, so this module owns a
// pathname switch (the section) plus a small search-param protocol for the flows
// that were separate routes in the warehouse app:
//   ?new=1                → create wizard (edit variant carries ?edit=<id>)
//   ?count=<id>           → stocktake counting workspace
//   ?view=<id> / ?doc=<id>→ detail (rendered INLINE by the list pages as drawers)
// Every scope-aware page reads the shared Warehouse Scope (?wh) via the locally
// mounted providers; the scope-first sections expose a WarehouseScopeSelect since
// the unified Topbar has no scope slot.
import { useLocation, useSearchParams } from "react-router-dom";
import { Barcode } from "lucide-react";
import { PageHeader, EmptyState } from "@/shared/ui";
import { WarehouseModuleProviders } from "./lib/providers";
import { WarehouseScopeSelect } from "./lib/WarehouseScopeSelect";

import { DashboardPage } from "./features/dashboard/DashboardPage";
import { InventoryPage } from "./features/inventory/InventoryPage";
import { ItemsPage } from "./features/items/ItemsPage";
import { ItemWizard } from "./features/items/ItemWizard";
import { WarehousesPage } from "./features/warehouses/WarehousesPage";
import { TransfersPage } from "./features/transfers/TransfersPage";
import { TransferCreateWizard } from "./features/transfers/TransferCreateWizard";
import { ReceiptsPage, ReceiptWizard } from "./features/receipts/ReceiptsPage";
import { IssuesPage, IssueWizard } from "./features/issues/IssuesPage";
import { AdjustmentsPage, AdjustmentWizard } from "./features/adjustments/AdjustmentsPage";
import { StocktakesPage } from "./features/stocktakes/StocktakesPage";
import { StocktakeWizard } from "./features/stocktakes/StocktakeWizard";
import { CountingWorkspace } from "./features/stocktakes/CountingWorkspace";
import { ReplenishmentPage } from "./features/replenishment/ReplenishmentPage";
import { LotsPage } from "./features/lots/LotsPage";
import { ExpiryPage } from "./features/expiry/ExpiryPage";

// Sections that filter their data by the shared scope but have no in-page
// warehouse picker — surface the persistent scope selector for them.
const SCOPE_FIRST = new Set<string>([
  "/inventory",
  "/inventory/balances",
  "/inventory/lots-expiry",
  "/inventory/replenishment",
]);

function LotsExpiry() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "expiry" ? "expiry" : "lots";
  const go = (t: "lots" | "expiry") => {
    const n = new URLSearchParams(sp);
    if (t === "lots") n.delete("tab");
    else n.set("tab", "expiry");
    setSp(n, { replace: true });
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(["lots", "expiry"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => go(t)}
            className={`min-h-10 rounded-xl border px-4 text-sm font-extrabold transition ${
              tab === t ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t === "lots" ? "الدفعات (التشغيلات)" : "تحذيرات الصلاحية"}
          </button>
        ))}
      </div>
      {tab === "expiry" ? <ExpiryPage /> : <LotsPage />}
    </div>
  );
}

function UnitsBarcodes() {
  return (
    <div>
      <PageHeader
        eyebrow="البيانات الرئيسية"
        title="الوحدات والباركود"
        subtitle="تُدار وحدات القياس والباركود لكل صنف من داخل بطاقة الصنف (تبويبا «الوحدات» و«الباركود»)."
      />
      <EmptyState
        icon={<Barcode className="h-6 w-6" />}
        title="تُدار من بطاقة الصنف"
        body="افتح صنفًا من «الأصناف» ثم انتقل إلى تبويب الوحدات أو الباركود لإضافة العبوات والأكواد وإدارتها."
      />
    </div>
  );
}

function Section() {
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const isNew = sp.get("new") === "1";
  const countId = sp.get("count");

  switch (pathname) {
    case "/inventory":
      return <DashboardPage />;
    case "/inventory/items":
      return isNew ? <ItemWizard /> : <ItemsPage />;
    case "/inventory/units-barcodes":
      return <UnitsBarcodes />;
    case "/inventory/warehouses":
      return <WarehousesPage />;
    case "/inventory/balances":
      return <InventoryPage />;
    case "/inventory/transfers":
      return isNew ? <TransferCreateWizard /> : <TransfersPage />;
    case "/inventory/receiving":
      return isNew ? <ReceiptWizard /> : <ReceiptsPage />;
    case "/inventory/issues":
      return isNew ? <IssueWizard /> : <IssuesPage />;
    case "/inventory/adjustments":
      return isNew ? <AdjustmentWizard /> : <AdjustmentsPage />;
    case "/inventory/stocktakes":
      return countId ? <CountingWorkspace /> : isNew ? <StocktakeWizard /> : <StocktakesPage />;
    case "/inventory/lots-expiry":
      return <LotsExpiry />;
    case "/inventory/replenishment":
      return <ReplenishmentPage />;
    default:
      return <InventoryPage />;
  }
}

export default function InventoryModule() {
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const overlay = sp.get("new") === "1" || !!sp.get("count");
  const showScope = SCOPE_FIRST.has(pathname) && !overlay;
  return (
    <WarehouseModuleProviders>
      {showScope && (
        <div className="mb-4 flex justify-end">
          <WarehouseScopeSelect />
        </div>
      )}
      <Section />
    </WarehouseModuleProviders>
  );
}
