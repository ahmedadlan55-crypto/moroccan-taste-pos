/**
 * Path → screen for the /menu/recipes subtree.
 *
 * The manifest leaf `mn-recipes` owns its subtree (`subRoutes: true`), so the
 * shell registers `/menu/recipes` AND `/menu/recipes/*` onto the ONE lazy menu
 * module chunk. The module resolves the section from the first segment after
 * `/menu`; this component resolves the deeper segments:
 *
 *   /menu/recipes                      → catalog
 *   /menu/recipes/:source/:productId   → the full-page recipe (deep-linkable)
 *
 * An unknown/incomplete tail falls back to the catalog rather than rendering a
 * detail page for a product id that does not exist.
 */
import { RecipesCatalogPage } from "./RecipesCatalogPage";
import { RecipeDetailPage } from "./RecipeDetailPage";

const VALID_SOURCES = new Set(["menu", "inv"]);

export function RecipesSection({ pathname }: { pathname: string }) {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const idx = parts.indexOf("recipes");
  const source = idx >= 0 ? decodeURIComponent(parts[idx + 1] ?? "") : "";
  const productId = idx >= 0 ? decodeURIComponent(parts[idx + 2] ?? "") : "";
  if (VALID_SOURCES.has(source) && productId) {
    return <RecipeDetailPage key={`${source}:${productId}`} source={source} productId={productId} />;
  }
  return <RecipesCatalogPage />;
}
