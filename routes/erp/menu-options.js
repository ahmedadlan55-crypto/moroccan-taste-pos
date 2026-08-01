// ═══════════════════════════════════════════════════════════════════
// /api/erp/menu-options — read-only item source for pickers
//
// The sales-analytics top bar can scope a report to specific menu items
// (registry dimension `menu_item`), but the only item list the back office
// served was the paginated admin grid (/api/menu/list — prices, margins,
// image hashes, channel counts), which is far too heavy to feed a combobox.
// This is the sibling of /erp/brands and /erp/branches-full: ids and names,
// nothing else. Image blobs and price/cost history are deliberately absent —
// menu.image_data is a base64 data URL that would outweigh the useful bytes
// by orders of magnitude on a few hundred rows.
//
// Access matches those neighbouring option endpoints: the global /api gate
// authenticates, and middleware/posPortalScope keeps POS-only roles out of
// every /erp path by default. No extra per-route capability — this is the
// same name list every back-office picker already renders.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

// The sellable-catalog predicate, identical to the cashier bootstrap's
// (routes/auth.js): finished goods only — semi-finished production outputs
// are not menu items — and a soft-deleted row must never resurface through
// a picker and pin a filter to an item nobody can sell.
const SELLABLE = `m.active = 1
                    AND COALESCE(m.is_deleted, 0) = 0
                    AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)`;

// A restaurant menu runs to the low hundreds; the cap only exists so a
// mis-seeded catalog can never turn a picker fetch into a full table dump.
const MAX_ROWS = 2000;
const DEFAULT_LIMIT = 50;

// SERVER-SIDE SEARCH AND PAGING
//   The picker used to fetch the whole catalog once and search it in the
//   browser, which is fine at 200 items and is not what the cap is for: at the
//   2,000-row ceiling the response silently truncated, so an item past the cut
//   simply could not be found and the picker gave no sign that it had stopped
//   looking.
//
//   `q` searches BOTH names — an English-speaking user typing "chicken" must
//   match a row whose Arabic name is the primary one, and vice versa. `id` is
//   matched too so a pasted item id resolves.
//
//   BACKWARD COMPATIBLE BY DESIGN: with no query parameters the response is the
//   same JSON ARRAY it has always been, so any existing caller is unaffected.
//   A caller that passes `limit` or `offset` is asking to page, and gets an
//   envelope with `hasMore` — because a page without that flag cannot be told
//   apart from the end of the list, which is the defect being fixed.
function clampInt(v, dflt, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.min(n, max);
}

router.get('/menu-options', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const paging = req.query.limit != null || req.query.offset != null;
    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, MAX_ROWS);
    const offset = clampInt(req.query.offset, 0, 1_000_000);

    const where = [SELLABLE];
    const params = [];
    if (q) {
      where.push('(m.name LIKE ? OR m.name_en LIKE ? OR m.id = ?)');
      const like = `%${q}%`;
      params.push(like, like, q);
    }
    const whereSql = where.join(' AND ');

    // Fetch ONE more than asked for: that extra row is the only honest way to
    // answer "is there another page?" without a second COUNT over the same
    // predicate.
    const take = paging ? limit + 1 : MAX_ROWS;
    const [rows] = await db.query(
      `SELECT m.id, m.name, m.name_en
         FROM menu m
        WHERE ${whereSql}
        ORDER BY m.name
        LIMIT ? OFFSET ?`,
      [...params, take, offset]);

    const hasMore = paging && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(m => ({
      id: m.id,
      name: m.name || '',
      nameEn: m.name_en || '',
    }));

    if (!paging) {
      // Unpaged callers keep the historical shape. `truncated` cannot ride on a
      // bare array, which is precisely why the paged form exists.
      return res.json(items);
    }
    res.json({ items, hasMore, limit, offset });
  } catch (e) {
    // Same degradation as /brands and /branches-full: an empty picker beats a
    // 500 that takes the whole filter bar down with it. The shape still has to
    // match what the caller asked for, or the client's own parse throws and
    // undoes the degradation.
    const paging = req.query.limit != null || req.query.offset != null;
    res.json(paging ? { items: [], hasMore: false, limit: 0, offset: 0 } : []);
  }
});

module.exports = router;
