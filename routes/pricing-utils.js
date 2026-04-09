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
      r.qty_used * (CASE WHEN i.conv_rate > 1 THEN i.cost / i.conv_rate ELSE i.cost END)
    ), 0) AS computed_cost
    FROM recipe r
    JOIN inv_items i ON r.inv_item_id = i.id
    WHERE r.menu_id = ?
  `, [menuId]);

  const computedCost = Number(rows[0].computed_cost) || 0;

  // Update computed_cost on the menu row
  await db.query('UPDATE menu SET computed_cost = ? WHERE id = ?', [computedCost, menuId]);

  // If variable pricing, auto-update the selling price
  const [menuRows] = await db.query('SELECT pricing_mode, markup_pct FROM menu WHERE id = ?', [menuId]);
  if (menuRows.length && menuRows[0].pricing_mode === 'variable') {
    const markup = Number(menuRows[0].markup_pct) || 0;
    const newPrice = Math.round(computedCost * (1 + markup / 100) * 100) / 100;
    await db.query('UPDATE menu SET price = ? WHERE id = ?', [newPrice, menuId]);
  }

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

module.exports = { recomputeMenuCost, recomputeMenuCostsForItems, recomputeAllMenuCosts };
