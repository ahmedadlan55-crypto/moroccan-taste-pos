/**
 * routes/saved-views.js — Sprint 3 (A2): per-user saved DataTable views.
 *
 * Backs the DataTable "Saved Views" control: a user saves a named bundle of
 * filters + visible columns + sort for a given module and re-applies it later.
 * A view may be marked is_shared so teammates can APPLY it too — but a shared
 * view is still owned by its creator and only the creator can edit or delete it.
 *
 * Table: saved_views (created in server.js runMigrations, block "15) Saved
 * Views", ~line 6547) — columns: id, username, module, name, is_default,
 * is_shared, filters_json, columns_json, sort_json, created_at.
 *
 * IDENTITY: `username` is ALWAYS taken from the verified JWT (req.user.username
 * set by verifyToken) — never from a query string or request body. A user can
 * only create rows as themselves, and can only edit/delete rows they own.
 *
 * JSON FIELDS (filtersJson / columnsJson / sortJson) are opaque JSON VALUES: the
 * client sends any JSON-serializable value (object, array, string, or null) and
 * gets the SAME value back — the API JSON.stringify's on write and JSON.parse's
 * on read (a legacy plain-text value that isn't valid JSON is returned verbatim;
 * an absent/undefined field is stored as SQL NULL and read back as null).
 *
 * ENDPOINTS
 *   GET    /api/saved-views?module=<m>  → { success, data:[ view … ] }
 *          the caller's OWN views for that module PLUS any is_shared=1 view for
 *          that module from anyone.
 *   POST   /api/saved-views            → { success, data: view }  (201) create own
 *          body { module, name, isDefault?, isShared?, filtersJson?, columnsJson?, sortJson? }
 *   PUT    /api/saved-views/:id         → { success, data: view }  update own only
 *          (404 if no such row; 403 if the row belongs to someone else — a
 *          shared view owned by another user is visible but NOT editable)
 *   DELETE /api/saved-views/:id         → { success:true }         delete own only
 *          (404 if no such row; 403 if owned by someone else)
 *
 * Per-row shape: { id, name, module, isDefault, isShared, filtersJson,
 *                  columnsJson, sortJson }
 *
 * WIRING NOTE — integration owner: add this ONE line to server.js in the
 * "API Routes" block, next to the other bilingual-i18n mounts (near
 * app.use('/api/cashier-readiness', …) around line 671). Do NOT mount under a
 * '/menu*' path — the global /api gate's naive `p.startsWith('/menu')` match
 * would make it PUBLIC. '/saved-views' does not start with '/menu' (nor
 * '/settings' / '/auth/'), so the global gate hard-verifies the JWT; this router
 * additionally chains its own verifyToken (defense-in-depth + self-
 * authenticating in the hermetic test):
 *
 *   app.use('/api/saved-views', require('./routes/saved-views'));
 */
'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const verifyToken = require('./authMiddleware');

// Opaque-JSON-value helpers — see the JSON FIELDS note above.
function serializeJsonField(v) {
  if (v === undefined) return null; // absent → SQL NULL
  try {
    return JSON.stringify(v);
  } catch (_) {
    return null;
  }
}
function parseJsonField(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw; // tolerate a legacy plain-text value that isn't valid JSON
  }
}

function mapRow(r) {
  return {
    id: r.id,
    name: r.name,
    module: r.module,
    isDefault: !!Number(r.is_default),
    isShared: !!Number(r.is_shared),
    filtersJson: parseJsonField(r.filters_json),
    columnsJson: parseJsonField(r.columns_json),
    sortJson: parseJsonField(r.sort_json)
  };
}

function genId() {
  return 'SV-' + crypto.randomBytes(8).toString('hex');
}

// GET /api/saved-views?module=<m> — own views for the module + shared ones.
router.get('/', verifyToken, async (req, res) => {
  const module = (req.query.module || '').toString().trim();
  if (!module) {
    return res.status(400).json({ success: false, error: 'module مطلوب' });
  }
  try {
    const username = req.user.username; // token-derived ONLY
    const [rows] = await db.query(
      `SELECT id, username, module, name, is_default, is_shared,
              filters_json, columns_json, sort_json
         FROM saved_views
        WHERE module = ? AND (username = ? OR is_shared = 1)
        ORDER BY is_default DESC, name ASC`,
      [module, username]
    );
    return res.json({ success: true, data: rows.map(mapRow) });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'تعذر تحميل الطرق المحفوظة' });
  }
});

// POST /api/saved-views — create a view owned by the token user.
router.post('/', verifyToken, async (req, res) => {
  const b = req.body || {};
  const module = (b.module || '').toString().trim();
  const name = (b.name || '').toString().trim();
  if (!module || !name) {
    return res.status(400).json({ success: false, error: 'module و name مطلوبان' });
  }
  try {
    const username = req.user.username; // token-derived ONLY
    const id = genId();
    await db.query(
      `INSERT INTO saved_views
         (id, username, module, name, is_default, is_shared, filters_json, columns_json, sort_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        username,
        module,
        name,
        b.isDefault ? 1 : 0,
        b.isShared ? 1 : 0,
        serializeJsonField(b.filtersJson),
        serializeJsonField(b.columnsJson),
        serializeJsonField(b.sortJson)
      ]
    );
    const [rows] = await db.query(
      `SELECT id, username, module, name, is_default, is_shared,
              filters_json, columns_json, sort_json FROM saved_views WHERE id = ?`,
      [id]
    );
    return res.status(201).json({ success: true, data: mapRow(rows[0]) });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'تعذر إنشاء الطريقة المحفوظة' });
  }
});

// PUT /api/saved-views/:id — update, own rows only (partial: absent fields kept).
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const username = req.user.username; // token-derived ONLY
    const [rows] = await db.query(
      `SELECT id, username, module, name, is_default, is_shared,
              filters_json, columns_json, sort_json FROM saved_views WHERE id = ?`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'الطريقة المحفوظة غير موجودة' });
    }
    if (rows[0].username !== username) {
      // A shared view owned by someone else is visible but NOT editable.
      return res.status(403).json({ success: false, error: 'لا يمكنك تعديل طريقة مستخدم آخر' });
    }
    const cur = rows[0];
    const b = req.body || {};
    const name = b.name !== undefined ? (b.name || '').toString().trim() || cur.name : cur.name;
    const isDefault = b.isDefault !== undefined ? (b.isDefault ? 1 : 0) : cur.is_default;
    const isShared = b.isShared !== undefined ? (b.isShared ? 1 : 0) : cur.is_shared;
    const filters = b.filtersJson !== undefined ? serializeJsonField(b.filtersJson) : cur.filters_json;
    const columns = b.columnsJson !== undefined ? serializeJsonField(b.columnsJson) : cur.columns_json;
    const sort = b.sortJson !== undefined ? serializeJsonField(b.sortJson) : cur.sort_json;
    await db.query(
      `UPDATE saved_views
          SET name = ?, is_default = ?, is_shared = ?,
              filters_json = ?, columns_json = ?, sort_json = ?
        WHERE id = ? AND username = ?`,
      [name, isDefault, isShared, filters, columns, sort, req.params.id, username]
    );
    const [after] = await db.query(
      `SELECT id, username, module, name, is_default, is_shared,
              filters_json, columns_json, sort_json FROM saved_views WHERE id = ?`,
      [req.params.id]
    );
    return res.json({ success: true, data: mapRow(after[0]) });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'تعذر تحديث الطريقة المحفوظة' });
  }
});

// DELETE /api/saved-views/:id — delete, own rows only.
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const username = req.user.username; // token-derived ONLY
    const [rows] = await db.query('SELECT username FROM saved_views WHERE id = ?', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'الطريقة المحفوظة غير موجودة' });
    }
    if (rows[0].username !== username) {
      return res.status(403).json({ success: false, error: 'لا يمكنك حذف طريقة مستخدم آخر' });
    }
    await db.query('DELETE FROM saved_views WHERE id = ? AND username = ?', [req.params.id, username]);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'تعذر حذف الطريقة المحفوظة' });
  }
});

module.exports = router;
