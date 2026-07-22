/**
 * routes/user-preferences.js — Sprint 3 (A2): per-user UI preferences.
 *
 * One row per user in `user_preferences` (PK = username), holding a free-form
 * JSON blob (prefs_json). Today it carries the UI language ({ "language":
 * "ar" | "en" }) but is deliberately open-ended so any later UI preference
 * (column widths, table density, …) can be persisted without a schema change.
 *
 * IDENTITY: `username` is ALWAYS taken from the verified JWT (req.user.username
 * set by verifyToken). It is NEVER read from a query string or request body —
 * a caller can only ever read/write their OWN preferences. A `username` key that
 * happens to appear in the PUT body is treated as an ordinary preference key on
 * the caller's own row; it can never redirect the write to another user.
 *
 * PUT is a SHALLOW MERGE: the incoming object's keys are merged OVER the stored
 * prefs (incoming wins), so `PUT {language:'en'}` sets/overwrites only
 * `language` and leaves every other stored key intact — a partial update, never
 * a wholesale replace. The merged object is persisted and returned.
 *
 * WIRING NOTE — integration owner: add this ONE line to server.js in the
 * "API Routes" block, next to the other bilingual-i18n mounts (near
 * app.use('/api/cashier-readiness', …) around line 671). Do NOT mount it under
 * a '/menu*' path — the global /api gate in server.js does a naive
 * `p.startsWith('/menu')` prefix match that would make it PUBLIC. '/user-
 * preferences' does not start with '/menu' (nor '/settings' / '/auth/'), so the
 * global gate hard-verifies the JWT; this router additionally chains its own
 * verifyToken (defense-in-depth + self-authenticating in the hermetic test):
 *
 *   app.use('/api/user-preferences', require('./routes/user-preferences'));
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const verifyToken = require('./authMiddleware');

// Parse a stored prefs_json string into a plain object. NULL / '' / invalid
// JSON / a non-object JSON value (array, number, string, null) ALL collapse to
// {} — an honest empty default, never a crash and never a non-object leaking to
// the client.
function parsePrefs(raw) {
  if (raw == null) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return {};
  } catch (_) {
    return {};
  }
}

// GET /api/user-preferences → the token-user's preferences object (or {}).
router.get('/', verifyToken, async (req, res) => {
  try {
    const username = req.user.username; // token-derived ONLY
    const [rows] = await db.query(
      'SELECT prefs_json FROM user_preferences WHERE username = ? LIMIT 1',
      [username]
    );
    return res.json(rows.length ? parsePrefs(rows[0].prefs_json) : {});
  } catch (e) {
    return res.status(500).json({ error: 'تعذر تحميل تفضيلات المستخدم' });
  }
});

// PUT /api/user-preferences — body is a plain JSON object; shallow-merge it over
// the stored prefs and upsert. Read-merge-write runs inside a transaction with a
// row lock so a concurrent PUT can't lose a key. Returns the full merged object.
router.put('/', verifyToken, async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'يجب أن يكون جسم الطلب كائن JSON' });
  }
  try {
    const username = req.user.username; // token-derived ONLY
    let merged;
    await db.withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT prefs_json FROM user_preferences WHERE username = ? LIMIT 1 FOR UPDATE',
        [username]
      );
      const current = rows.length ? parsePrefs(rows[0].prefs_json) : {};
      merged = Object.assign({}, current, incoming); // shallow merge (incoming wins)
      await conn.query(
        'INSERT INTO user_preferences (username, prefs_json) VALUES (?, ?) ' +
          'ON DUPLICATE KEY UPDATE prefs_json = VALUES(prefs_json)',
        [username, JSON.stringify(merged)]
      );
    });
    return res.json(merged);
  } catch (e) {
    return res.status(500).json({ error: 'تعذر حفظ تفضيلات المستخدم' });
  }
});

module.exports = router;
