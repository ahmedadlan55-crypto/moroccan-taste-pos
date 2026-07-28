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

router.get('/menu-options', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.name, m.name_en
         FROM menu m
        WHERE ${SELLABLE}
        ORDER BY m.name
        LIMIT ${MAX_ROWS}`);
    res.json(rows.map(m => ({
      id: m.id,
      name: m.name || '',
      nameEn: m.name_en || '',
    })));
  } catch (e) {
    // Same degradation as /brands and /branches-full: an empty picker beats a
    // 500 that takes the whole filter bar down with it.
    res.json([]);
  }
});

module.exports = router;
