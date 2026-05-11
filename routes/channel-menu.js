/**
 * Channel Menu Items — V5.4
 * Per-sales-channel + per-branch menu management.
 *
 *   GET  /channel-menus/channels                 — channels list with item counts
 *   GET  /channel-menus/:channelId               — items for a channel (optionally ?branchId=)
 *   GET  /channel-menus/:channelId/available-items — items NOT yet in this channel (for picker)
 *   POST /channel-menus/:channelId/items         — bulk add { itemIds: [...] , branchId? }
 *   PUT  /channel-menus/:channelId/items/:itemId — update availability/price/limit
 *   DELETE /channel-menus/:channelId/items/:itemId
 *   POST /channel-menus/:channelId/copy-from/:srcChannelId — copy menu from another channel
 *   GET  /channel-menus/branches-for/:channelId  — branches that have customized menu in this channel
 */
const router = require('express').Router();
const db = require('../db/connection');

function _id(){ return 'CMI-' + Date.now() + '-' + Math.random().toString(36).slice(2,7); }

router.get('/channels', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.id, c.code, c.name, c.channel_type, c.is_active,
             COUNT(DISTINCT cmi.menu_item_id) AS item_count,
             SUM(CASE WHEN cmi.is_available=1 THEN 1 ELSE 0 END) AS available_count
      FROM sales_channels c
      LEFT JOIN channel_menu_items cmi ON cmi.channel_id = c.id
      GROUP BY c.id, c.code, c.name, c.channel_type, c.is_active
      ORDER BY c.is_active DESC, c.name`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:channelId', async (req, res) => {
  try {
    const branchId = req.query.branchId || null;
    const conds = ['cmi.channel_id = ?'];
    const params = [req.params.channelId];
    if (branchId) { conds.push('(cmi.branch_id = ? OR cmi.branch_id IS NULL)'); params.push(branchId); }

    // v5.10.27 — Resolve the price list assigned to this channel (if any)
    // and load its items so the cashier honors price-list prices instead
    // of always falling back to menu.price. Previously the price list
    // assignment on sales_channels was only used as a label.
    let priceList = null;
    let priceListMap = {};
    try {
      const [chRows] = await db.query(
        `SELECT sc.price_list_id, pl.name AS pl_name, pl.is_active AS pl_active
           FROM sales_channels sc
           LEFT JOIN price_lists pl ON pl.id = sc.price_list_id
          WHERE sc.id = ? LIMIT 1`,
        [req.params.channelId]);
      if (chRows.length && chRows[0].price_list_id && chRows[0].pl_active !== 0) {
        priceList = {
          id: chRows[0].price_list_id,
          name: chRows[0].pl_name || ''
        };
        const today = new Date().toISOString().slice(0, 10);
        const [plItems] = await db.query(
          `SELECT item_id, item_name, item_category, price, min_price, valid_from, valid_to
             FROM price_list_items
            WHERE price_list_id = ?
              AND (valid_from IS NULL OR valid_from <= ?)
              AND (valid_to   IS NULL OR valid_to   >= ?)`,
          [priceList.id, today, today]);
        plItems.forEach(li => {
          if (li.item_id) priceListMap[li.item_id] = {
            price: Number(li.price) || 0,
            minPrice: Number(li.min_price) || 0,
            category: li.item_category || null,
            name: li.item_name || null
          };
        });
      }
    } catch(_) { /* schema diff — fall back to legacy behavior */ }

    const [rows] = await db.query(`
      SELECT cmi.*,
             m.name AS item_name, m.price AS base_price, m.category, m.cost,
             m.is_semi_finished, m.production_warehouse_id, m.sales_warehouse_id AS item_default_sales_wh,
             w.name AS sales_wh_name,
             br.name AS branch_name,
             b.name AS bom_name
      FROM channel_menu_items cmi
      LEFT JOIN menu m ON m.id = cmi.menu_item_id
      LEFT JOIN warehouses w ON w.id = cmi.sales_warehouse_id
      LEFT JOIN branches br ON br.id = cmi.branch_id
      LEFT JOIN bom b ON b.id = cmi.bom_id
      WHERE ${conds.join(' AND ')}
        AND m.id IS NOT NULL    /* v5.15.3 — skip orphaned rows whose menu_item_id no longer exists */
      ORDER BY cmi.sort_order, m.category, m.name`, params);

    res.json({
      // v5.10.27 — Wrap items in an envelope so the cashier can show
      // "أسعار قائمة X" badge alongside the products grid.
      priceList: priceList,
      items: rows.map(r => {
        // v5.10.27 — Price priority:
        //   override_price (per-channel manual)
        //   > price_list_items.price (if channel has a price list)
        //   > menu.price (the original catalog price)
        const plEntry = priceListMap[r.menu_item_id];
        const plPrice = plEntry ? plEntry.price : null;
        const effectivePrice =
          (r.override_price != null) ? Number(r.override_price) :
          (plPrice != null)          ? plPrice :
                                        (Number(r.base_price) || 0);
        // If the price list provides a category for this item, prefer it
        // over the global menu.category — admins use price-list categories
        // to override how items are grouped for a specific channel.
        const effectiveCategory = (plEntry && plEntry.category) ? plEntry.category : r.category;
        return {
          id: r.id, channelId: r.channel_id, branchId: r.branch_id,
          menuItemId: r.menu_item_id, itemName: r.item_name,
          category: effectiveCategory,
          menuCategory: r.category,                 // original menu category (for debug/admin)
          basePrice: Number(r.base_price)||0,
          overridePrice: r.override_price != null ? Number(r.override_price) : null,
          priceListPrice: plPrice,                  // v5.10.27 — visible in admin tooling
          priceListMinPrice: plEntry ? plEntry.minPrice : null,
          priceSource:
            (r.override_price != null) ? 'override' :
            (plPrice != null)          ? 'priceList' :
                                          'menu',
          effectivePrice: effectivePrice,
          cost: Number(r.cost)||0,
          isAvailable: !!r.is_available,
          dailyLimit: r.daily_limit, soldToday: r.sold_today || 0,
          sortOrder: r.sort_order || 100,
          salesWarehouseId: r.sales_warehouse_id, salesWarehouseName: r.sales_wh_name,
          bomId: r.bom_id, bomName: r.bom_name,
          isSemiFinished: !!r.is_semi_finished,
          branchName: r.branch_name, notes: r.notes
        };
      })
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:channelId/available-items', async (req, res) => {
  try {
    const branchId = req.query.branchId || null;
    const brandId = req.query.brandId || null;
    // V5-FIX: menu table doesn't have is_active column in all schema variants —
    // skip that filter; instead just exclude items already in the channel.
    const conds = ['1=1'];
    const params = [];
    if (brandId) { conds.push('m.brand_id = ?'); params.push(brandId); }
    let exclude = `AND m.id NOT IN (
      SELECT menu_item_id FROM channel_menu_items
      WHERE channel_id = ? ${branchId ? 'AND (branch_id = ? OR branch_id IS NULL)' : ''}
    )`;
    const exParams = branchId ? [req.params.channelId, branchId] : [req.params.channelId];
    const [rows] = await db.query(`
      SELECT m.id, m.name, m.price, m.category, m.cost,
             COALESCE(m.is_semi_finished, 0) AS is_semi_finished,
             m.production_warehouse_id, m.sales_warehouse_id,
             br.name AS brand_name
      FROM menu m
      LEFT JOIN brands br ON br.id = m.brand_id
      WHERE ${conds.join(' AND ')} ${exclude}
      ORDER BY m.category, m.name LIMIT 500`,
      [...params, ...exParams]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:channelId/items', async (req, res) => {
  try {
    const { itemIds, branchId, defaults } = req.body || {};
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return res.status(400).json({ error: 'itemIds required' });
    }
    const ch = req.params.channelId;
    const d = defaults || {};
    let added = 0;
    for (const itemId of itemIds) {
      try {
        await db.query(`
          INSERT IGNORE INTO channel_menu_items
            (id, channel_id, branch_id, menu_item_id, is_available,
             override_price, daily_limit, sort_order, sales_warehouse_id, bom_id, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [_id(), ch, branchId || null, itemId,
            d.is_available !== false ? 1 : 0,
            d.override_price != null ? d.override_price : null,
            d.daily_limit || null,
            d.sort_order || 100,
            d.sales_warehouse_id || null,
            d.bom_id || null,
            d.notes || null]);
        added++;
      } catch(_e) { /* duplicate — skip */ }
    }
    res.json({ success: true, added, requested: itemIds.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:channelId/items/:itemId', async (req, res) => {
  try {
    const fields = ['is_available','override_price','daily_limit','sort_order',
                    'sales_warehouse_id','bom_id','notes','branch_id'];
    const set = []; const params = [];
    for (const f of fields) {
      if (f in req.body) {
        set.push(`${f}=?`);
        params.push(f === 'is_available' ? (req.body[f] ? 1 : 0) : req.body[f]);
      }
    }
    if (!set.length) return res.json({ success: true, noop: true });
    params.push(req.params.channelId, req.params.itemId);
    const branchClause = req.body.branchId !== undefined && req.body.branchId !== null
      ? 'AND (branch_id = ? OR branch_id IS NULL)' : '';
    if (branchClause) params.push(req.body.branchId);
    await db.query(`UPDATE channel_menu_items SET ${set.join(',')}
       WHERE channel_id = ? AND menu_item_id = ? ${branchClause}`, params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:channelId/items/:itemId', async (req, res) => {
  try {
    const branchId = req.query.branchId || null;
    const params = [req.params.channelId, req.params.itemId];
    let extra = '';
    if (branchId) { extra = 'AND branch_id = ?'; params.push(branchId); }
    await db.query(`DELETE FROM channel_menu_items
                    WHERE channel_id = ? AND menu_item_id = ? ${extra}`, params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:channelId/copy-from/:srcChannelId', async (req, res) => {
  try {
    const branchId = (req.body && req.body.branchId) || null;
    const [src] = await db.query(`SELECT * FROM channel_menu_items
                                  WHERE channel_id = ? ${branchId?'AND (branch_id=? OR branch_id IS NULL)':''}`,
      branchId ? [req.params.srcChannelId, branchId] : [req.params.srcChannelId]);
    let copied = 0;
    for (const r of src) {
      try {
        await db.query(`
          INSERT IGNORE INTO channel_menu_items
            (id, channel_id, branch_id, menu_item_id, is_available, override_price,
             daily_limit, sort_order, sales_warehouse_id, bom_id, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [_id(), req.params.channelId, branchId || r.branch_id, r.menu_item_id,
            r.is_available, r.override_price, r.daily_limit, r.sort_order,
            r.sales_warehouse_id, r.bom_id, r.notes]);
        copied++;
      } catch(_) {}
    }
    res.json({ success: true, copied, total_source: src.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/branches-for/:channelId', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT b.id, b.name, b.code,
             COUNT(cmi.id) AS customized_count
      FROM branches b
      LEFT JOIN channel_menu_items cmi ON cmi.branch_id = b.id AND cmi.channel_id = ?
      GROUP BY b.id, b.name, b.code
      ORDER BY customized_count DESC, b.name`, [req.params.channelId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
