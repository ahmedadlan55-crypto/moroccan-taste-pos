// modules/menu — Menu & Recipes domain (Closure Sprint v2). ONE lazy module chunk
// backs every /menu/* manifest item. The router registers an exact route per path
// AND, for the subtree-owning brand item (manifest subRoutes:true), a `/menu/brand/*`
// splat — so this component picks the section from the FIRST segment after /menu
// (not the last): /menu/brand/new|:id must resolve to the brand section, not fall
// through to the hub. Brand scope + item selection live in the query string
// (?brandId=, ?item=) so they survive refresh.
import { useLocation } from "react-router-dom";
import { Hub } from "./Hub";
import { BrandMenu } from "./BrandMenu";
import { RecipesBom } from "./RecipesBom";
import { PriceLists } from "./PriceLists";
import { Combos } from "./Combos";
import { SemiFinished } from "./SemiFinished";
import { ImageManager } from "./ImageManager";
import { CategoryTranslations } from "./CategoryTranslations";

type Section = "hub" | "brand" | "recipes-bom" | "price-lists" | "combos" | "semi-finished" | "images" | "categories";

function sectionFromPath(pathname: string): Section {
  // First segment after /menu, not the last: brand owns a subtree (subRoutes:true),
  // so /menu/brand/new|:id stays in the brand section. Every non-subtree item is a
  // single level, so first-after-menu == last segment and its behaviour is unchanged.
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const seg = parts[parts.indexOf("menu") + 1] ?? "";
  switch (seg) {
    case "brand": return "brand";
    case "recipes-bom": return "recipes-bom";
    case "price-lists": return "price-lists";
    case "combos": return "combos";
    case "semi-finished": return "semi-finished";
    case "images": return "images";
    case "categories": return "categories";
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
    case "images": return <ImageManager />;
    case "categories": return <CategoryTranslations />;
    case "hub":
    default: return <Hub />;
  }
}
