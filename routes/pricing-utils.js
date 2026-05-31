/**
 * Pricing utilities — shared cost recomputation logic.
 * Used by routes/menu.js (after recipe save) and routes/purchases.js (after receive).
 */
const db = require('../db/connection');

/**
 * Recompute a single menu item's cost from its recipe ingredients.
 * If pricing_mode = 'variable', also updates menu.price automatically.
 */
async function recomputeMenuCost(menuId) {
  // Sum recipe ingredient costs (using small-unit cost)
  const [rows] = await db.query(`
    SELECT COALESCE(SUM(
      r.qty_used * i.cost
    ), 0) AS computed_cost
    FROM recipe r
    JOIN inv_items i ON r.inv_item_id = i.id
    WHERE r.menu_id = ?
  `, [menuId]);

  const computedCost = Number(rows[0].computed_cost) || 0;

  // Update computed_cost on the menu row.
  // IMPORTANT: we NEVER auto-update menu.price — the selling price is
  // always manual. Only the COST is auto-computed from recipes.
  await db.query('UPDATE menu SET computed_cost = ? WHERE id = ?', [computedCost, menuId]);

  return computedCost;
}

/**
 * Recompute menu costs for all products that use ANY of the given inv_item IDs.
 * Called after a purchase receive changes raw-material costs.
 */
async function recomputeMenuCostsForItems(invItemIds) {
  if (!invItemIds || !invItemIds.length) return 0;

  // Find all menu items that reference these raw materials
  const placeholders = invItemIds.map(() => '?').join(',');
  const [affected] = await db.query(
    `SELECT DISTINCT menu_id FROM recipe WHERE inv_item_id IN (${placeholders})`,
    invItemIds
  );

  let count = 0;
  for (const row of affected) {
    await recomputeMenuCost(row.menu_id);
    count++;
  }
  return count;
}

/**
 * Recompute ALL menu items that have at least one recipe ingredient.
 * Used by the manual "recompute all" button in settings.
 */
async function recomputeAllMenuCosts() {
  const [menuIds] = await db.query('SELECT DISTINCT menu_id FROM recipe');
  let count = 0;
  for (const row of menuIds) {
    await recomputeMenuCost(row.menu_id);
    count++;
  }
  return count;
}

/**
 * v7.1 — Cascade cost recompute: re-derive SEMI-finished costs FIRST, then
 * finished menu items. Semis live in inv_items (kind='semi') and their recipe
 * is a BOM (bom.product_id = semi id). They are costed at WAC on production, so
 * when a raw material's price changes the semi's stored inv_items.cost goes
 * stale; this re-derives it from its active BOM so finished products that consume
 * the semi (via the recipe table) pick up the new cost on the next recompute.
 *
 * Graceful: the semi pass is isolated in try/catch — on ANY error it still runs
 * the finished recompute (the previous behavior), so callers never break.
 */
async function recomputeSemiThenFinished(invItemIds) {
  if (!invItemIds || !invItemIds.length) return { semis: 0, finished: 0 };
  const ph = invItemIds.map(() => '?').join(',');
  const touched = invItemIds.slice();
  let semis = 0;
  try {
    // Semis whose ACTIVE BOM consumes any of the changed raw materials.
    const [affSemis] = await db.query(
      `SELECT DISTINCT b.product_id AS semi_id, b.id AS bom_id, COALESCE(b.yield_quantity,1) AS yield_q
         FROM bom b
         JOIN bom_lines bl ON bl.bom_id = b.id
         JOIN inv_items s  ON s.id = b.product_id AND s.kind = 'semi'
        WHERE b.is_active = 1 AND bl.component_item_id IN (${ph})`,
      invItemIds
    );
    for (const s of affSemis) {
      // Same BOM cost formula used by routes/menu.js recipe-bom recompute.
      const [agg] = await db.query(
        `SELECT COALESCE(SUM(bl.quantity * COALESCE(i.cost,0) * (1 + COALESCE(bl.waste_pct,0)/100)), 0) AS total
           FROM bom_lines bl LEFT JOIN inv_items i ON i.id = bl.component_item_id
          WHERE bl.bom_id = ?`, [s.bom_id]);
      const cost = Number(agg[0].total || 0) / Math.max(1, Number(s.yield_q) || 1);
      await db.query('UPDATE inv_items SET cost = ? WHERE id = ?', [cost, s.semi_id]);
      touched.push(s.semi_id);
      semis++;
    }
  } catch (e) {
    console.warn('[pricing] semi cost cascade skipped:', e.message);
  }
  // Finished menu items that consume the changed raws OR the now-updated semis.
  const finished = await recomputeMenuCostsForItems(touched);
  return { semis, finished };
}

module.exports = { recomputeMenuCost, recomputeMenuCostsForItems, recomputeAllMenuCosts, recomputeSemiThenFinished };
