// modules/menu — Menu & Recipes domain (Closure Sprint v2). ONE lazy module chunk
// backs every /menu/* manifest item. The router registers one exact route per
// path (no `/:id`), so this component branches on the pathname's last segment to
// pick the section — exactly like modules/sales/index.tsx. Brand scope + item
// selection live in the query string (?brandId=, ?item=) so they survive refresh.
import { useLocation } from "react-router-dom";
import { Hub } from "./Hub";
import { BrandMenu } from "./BrandMenu";
import { RecipesBom } from "./RecipesBom";
import { PriceLists } from "./PriceLists";
import { Combos } from "./Combos";
import { SemiFinished } from "./SemiFinished";

type Section = "hub" | "brand" | "recipes-bom" | "price-lists" | "combos" | "semi-finished";

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

  switch (section) {
    case "brand": return <BrandMenu />;
    case "recipes-bom": return <RecipesBom />;
    case "price-lists": return <PriceLists />;
    case "combos": return <Combos />;
    case "semi-finished": return <SemiFinished />;
    case "hub":
    default: return <Hub />;
  }
}
