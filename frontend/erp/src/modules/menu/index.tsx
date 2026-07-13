// modules/menu — Menu & Recipes domain (Closure Sprint v2). ONE lazy module chunk
// backs every /menu/* manifest item (hub, brand menu, recipe-BOM, price-lists,
// combos, semi-finished). The router registers one exact route per path, so this
// component branches on the pathname to pick the section.
//
// SCAFFOLD: this file is the batch-0 landing pad so the lazy import + build
// resolve. The MENU domain agent overwrites it (and adds sibling files under
// modules/menu/**) with the real screens on /api/menu/* + /api/channel-menus/*.
import { useLocation } from "react-router-dom";
import { PageHeader } from "@/shared/ui";

type Section = "hub" | "brand" | "recipes-bom" | "price-lists" | "combos" | "semi-finished";

const META: Record<Section, { title: string; subtitle: string }> = {
  hub: { title: "لوحة القوائم", subtitle: "نظرة عامة على قوائم العلامات التجارية والفروع." },
  brand: { title: "قائمة العلامة التجارية", subtitle: "أصناف القائمة والأسعار لكل علامة تجارية." },
  "recipes-bom": { title: "الوصفات ومكوّنات التصنيع", subtitle: "وصفات الأصناف وقوائم مكوّناتها (BOM)." },
  "price-lists": { title: "قوائم الأسعار", subtitle: "قوائم الأسعار وتحديثاتها الجماعية." },
  combos: { title: "الوجبات المركّبة", subtitle: "الوجبات والعروض المركّبة من عدة أصناف." },
  "semi-finished": { title: "المنتجات نصف المصنّعة", subtitle: "الأصناف الوسيطة الناتجة عن الإنتاج." },
};

function sectionFromPath(pathname: string): Section {
  const seg = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  switch (seg) {
    case "brand": return "brand";
    case "recipes-bom": return "recipes-bom";
    case "price-lists": return "price-lists";
    case "combos": return "combos";
    case "semi-finished": return "semi-finished";
    case "hub":
    default: return "hub";
  }
}

export default function MenuModule() {
  const { pathname } = useLocation();
  const section = sectionFromPath(pathname);
  const meta = META[section];
  return (
    <div>
      <PageHeader eyebrow="القوائم والوصفات" title={meta.title} subtitle={meta.subtitle} />
    </div>
  );
}
