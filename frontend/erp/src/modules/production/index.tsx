// modules/production — Production / manufacturing (SD4 MERGE POINT).
//
// The manifest leaf `inv-production` OWNS its subtree (subRoutes: true), so the
// shell registers `/inventory/production` AND `/inventory/production/*` against
// this module. Everything below is therefore a REAL URL, resolved from the
// pathname (the convention every subtree-owning module here follows — see
// modules/inventory, modules/menu, modules/reports):
//
//   /inventory/production               orders list (+ ?view=batches panel)
//   /inventory/production/new           multi-product create (production document)
//   /inventory/production/:id           single production-order detail
//   /inventory/production/:id/edit      draft order edit (single-order wizard)
//   /inventory/production/batches/:id   production-document detail
//
// The retired query protocol still resolves, so existing links, bookmarks and
// printed documents keep working — it REDIRECTS (replace) onto the real URL:
//   ?new=1            → /inventory/production/new
//   ?new=1&edit=<id>  → /inventory/production/<id>/edit
//   ?doc=<id>         → /inventory/production/<id>
//
// NOTE: ids are read from the RAW pathname, never from a lower-cased copy —
// `normalizeRoutePath` exists to make SEGMENT matching case/slash tolerant, and
// running an id through it would silently mangle `POV2-AbC…`.
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { NotFound } from "@/app/shell/NotFound";
import { ProductionPage } from "./features/production/ProductionPage";
import { ProductionCreateWizard } from "./features/production/ProductionCreateWizard";
import { ProductionDetailPage } from "./features/production/ProductionDetailPage";
import { ProductionBatchCreatePage } from "./features/batches/ProductionBatchCreatePage";
import { ProductionBatchDetailPage } from "./features/batches/ProductionBatchDetailPage";

export const PRODUCTION_BASE = "/inventory/production";

/** Path segments AFTER `/inventory/production`, with ids left untouched. */
function subSegments(pathname: string): string[] {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === "production");
  return i < 0 ? [] : parts.slice(i + 1);
}

function Section() {
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const seg = subSegments(pathname);

  // ── retired query protocol → real URLs ──
  if (seg.length === 0) {
    if (sp.get("new") === "1") {
      const editId = sp.get("edit");
      return (
        <Navigate
          to={editId ? `${PRODUCTION_BASE}/${encodeURIComponent(editId)}/edit` : `${PRODUCTION_BASE}/new`}
          replace
        />
      );
    }
    const doc = sp.get("doc");
    if (doc) return <Navigate to={`${PRODUCTION_BASE}/${encodeURIComponent(doc)}`} replace />;
    return <ProductionPage />;
  }

  const head = seg[0];
  const headKey = head.toLowerCase();

  if (headKey === "new") return <ProductionBatchCreatePage />;

  if (headKey === "batches") {
    const batchId = seg[1];
    // A bare /batches is not a document — send it to the documents list.
    if (!batchId) return <Navigate to={`${PRODUCTION_BASE}?view=batches`} replace />;
    return <ProductionBatchDetailPage batchId={decodeURIComponent(batchId)} />;
  }

  const id = decodeURIComponent(head);
  if (seg.length === 1) return <ProductionDetailPage orderId={id} />;
  if (seg.length === 2 && seg[1].toLowerCase() === "edit") return <ProductionCreateWizard editId={id} />;

  // Never fall back to the list: an unmapped path used to silently render the
  // WRONG screen. NotFound carries data-state="not-found", which the closure
  // gate fails on — so a missing route surfaces as a defect.
  return <NotFound />;
}

export default function ProductionModule() {
  return (
    <WarehouseModuleProviders>
      <Section />
    </WarehouseModuleProviders>
  );
}
