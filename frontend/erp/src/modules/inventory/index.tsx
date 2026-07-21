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
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import { WarehouseModuleProviders } from "./lib/providers";
import { WarehouseScopeSelect } from "./lib/WarehouseScopeSelect";

import { DashboardPage } from "./features/dashboard/DashboardPage";
import { InventoryPage } from "./features/inventory/InventoryPage";
import { ItemsPage } from "./features/items/ItemsPage";
import { ItemFormPage } from "./features/items/ItemFormPage";
import { ItemDetailPage } from "./features/items/ItemDetailPage";
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
import { InventoryMethodPage } from "./features/method/InventoryMethodPage";
import { WastePage } from "./features/waste/WastePage";

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

  // Normalised: react-router matches a route ignoring a trailing slash and case,
  // but useLocation().pathname returns it RAW — so "/inventory/items/" used to
  // fall through this switch to the default and render the wrong screen.
  const route = normalizeRoutePath(pathname);

  // Items OWNS its subtree (manifest subRoutes:true), so the shell mounts this
  // module for /inventory/items/new, /inventory/items/:id and .../:id/edit too.
  // D1 resolves each deeper segment to its real full-page screen:
  //   .../new          → ItemFormPage (create)
  //   .../<id>/edit    → ItemFormPage (edit, reads :id)
  //   .../<id>         → ItemDetailPage (read, reads :id)
  if (route.startsWith("/inventory/items/")) {
    const parts = route.slice("/inventory/items/".length).split("/").filter(Boolean);
    const seg = parts[0] ?? "";
    if (seg === "new") return <ItemFormPage mode="create" />;
    if (seg && parts[1] === "edit") return <ItemFormPage mode="edit" itemId={seg} />;
    if (seg) return <ItemDetailPage itemId={seg} />;
    return <ItemsPage />;
  }

  switch (route) {
    case "/inventory":
      return <DashboardPage />;
    case "/inventory/method":
      return <InventoryMethodPage />;
    case "/inventory/waste":
      return <WastePage />;
    case "/inventory/items":
      // Create/edit/detail are real routes now (…/new, …/:id, …/:id/edit); the
      // legacy ?new=1 overlay redirects to the full-page create screen.
      return isNew ? <ItemFormPage mode="create" /> : <ItemsPage />;
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
      // Never fall back to InventoryPage: an unmapped path silently rendered the
      // WRONG screen instead of saying so. NotFound carries data-state="not-found",
      // which the closure gate fails on — so a missing route surfaces as a defect.
      return <NotFound />;
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
