// modules/production — Production / manufacturing orders (SD4 MERGE POINT).
//
// One manifest leaf routes here (/inventory/production, grouped under المخزون).
// The warehouse app used separate routes for the list / detail / create-edit
// wizard; the unified shell has no splat, so this module switches on a small
// search-param protocol on the single registered path:
//   (none)                → orders list
//   ?new=1 [&edit=<id>]   → create / edit wizard
//   ?doc=<id>             → order detail page
import { useSearchParams } from "react-router-dom";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { ProductionPage } from "./features/production/ProductionPage";
import { ProductionCreateWizard } from "./features/production/ProductionCreateWizard";
import { ProductionDetailPage } from "./features/production/ProductionDetailPage";

function Section() {
  const [sp] = useSearchParams();
  if (sp.get("new") === "1") return <ProductionCreateWizard />;
  if (sp.get("doc")) return <ProductionDetailPage />;
  return <ProductionPage />;
}

export default function ProductionModule() {
  return (
    <WarehouseModuleProviders>
      <Section />
    </WarehouseModuleProviders>
  );
}
