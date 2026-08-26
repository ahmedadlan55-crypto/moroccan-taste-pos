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
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Barcode, FileQuestion } from "lucide-react";
import { PageHeader, EmptyState, StateShell } from "@/shared/ui";
import { useT } from "@/i18n";
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
import { OperationsHubPage } from "./features/operations/OperationsHubPage";
import { OperationDetailPage } from "./features/operations/OperationDetailPage";

// Sections that filter their data by the shared scope but have no in-page
// warehouse picker — surface the persistent scope selector for them.
const SCOPE_FIRST = new Set<string>([
  "/inventory",
  "/inventory/balances",
  "/inventory/lots-expiry",
  "/inventory/replenishment",
]);

// Legacy `?view=<id>` deep links. Those list pages used to open the document in
// a detail DRAWER; the document detail is now a real route under the operations
// centre, so an old bookmark / shared link resolves to the SAME document instead
// of silently doing nothing. The value is the operations `documentType` — the
// list page's own doc family, not a guess.
const LEGACY_VIEW_TYPE: Record<string, string> = {
  "/inventory/transfers": "transfer",
  "/inventory/receiving": "receipt",
  "/inventory/issues": "issue",
  "/inventory/adjustments": "adjustment",
};

function LotsExpiry() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "expiry" ? "expiry" : "lots";
  const go = (target: "lots" | "expiry") => {
    const n = new URLSearchParams(sp);
    if (target === "lots") n.delete("tab");
    else n.set("tab", "expiry");
    setSp(n, { replace: true });
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(["lots", "expiry"] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            onClick={() => go(tabId)}
            className={`min-h-11 rounded-xl border px-4 text-sm font-extrabold transition ${
              tab === tabId ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tabId === "lots" ? t("inventoryRest.hub.lotsTab") : t("inventoryRest.hub.expiryTab")}
          </button>
        ))}
      </div>
      {tab === "expiry" ? <ExpiryPage /> : <LotsPage />}
    </div>
  );
}

function UnitsBarcodes() {
  const t = useT();
  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.hub.unitsBarcodes.eyebrow")}
        title={t("inventoryRest.hub.unitsBarcodes.title")}
        subtitle={t("inventoryRest.hub.unitsBarcodes.subtitle")}
      />
      <EmptyState
        icon={<Barcode className="h-6 w-6" />}
        title={t("inventoryRest.hub.unitsBarcodes.emptyTitle")}
        body={t("inventoryRest.hub.unitsBarcodes.emptyBody")}
      />
    </div>
  );
}

// A half-written operations path (`/inventory/operations/transfer` with no id)
// is a broken link, not an empty document — say so with the not-found state the
// closure gate recognises rather than rendering a hollow page.
function OperationsPathInvalid() {
  const t = useT();
  return (
    <StateShell
      state="not-found"
      icon={<FileQuestion className="h-6 w-6" />}
      title={t("operations.detail.notFoundTitle")}
      body={t("operations.detail.notFoundBody")}
    />
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

  // ── legacy drawer deep links ──
  // Runs BEFORE any section renders so `?view=` can never re-open a drawer.
  const viewId = sp.get("view");
  if (viewId && LEGACY_VIEW_TYPE[route]) {
    return (
      <Navigate
        to={`/inventory/operations/${LEGACY_VIEW_TYPE[route]}/${encodeURIComponent(viewId)}`}
        replace
      />
    );
  }

  // The operations centre OWNS its subtree (manifest subRoutes:true), so the
  // shell mounts this module for /inventory/operations/:type/:id as well. The
  // document detail is a REAL full page — never a drawer, never a side panel.
  if (route === "/inventory/operations") return <OperationsHubPage />;
  if (route.startsWith("/inventory/operations/")) {
    // MATCH on the normalized (lower-cased) route, but read the id from the RAW
    // pathname. Document ids carry meaningful case — `STK-0a71624b4013` — and
    // `normalizeRoutePath` lower-cases the whole string. Looking a document up
    // as `stk-0a71624b4013` happens to work only because MySQL's default
    // collation is case-insensitive; that is luck, not design, and it breaks the
    // moment a column uses a binary or `_bin` collation. `documentType` is a
    // fixed lower-case vocabulary, so taking it from the normalized copy is safe.
    const rawParts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const opsIndex = rawParts.findIndex((p) => p.toLowerCase() === "operations");
    const docType = (rawParts[opsIndex + 1] || "").toLowerCase();
    const docId = rawParts[opsIndex + 2] ? decodeURIComponent(rawParts[opsIndex + 2]) : "";
    if (docType && docId) return <OperationDetailPage documentType={docType} documentId={docId} />;
    return <OperationsPathInvalid />;
  }

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
