'use strict';
/**
 * routes/product-images.js — bilingual-i18n-images (Owner C): bulk product
 * image management API.
 *
 * NOT mounted under /menu*. server.js's global /api gate does a naive
 * prefix-match on the literal string '/menu' (`if (p.startsWith('/menu'))
 * return next();`) to keep the public POS catalog reads token-free — mounting
 * this router at /api/menu* would silently inherit that exemption and make
 * every route here (including the writes) public. Intended mount path:
 *
 *     app.use('/api/product-images', require('./routes/product-images'));
 *
 * Auth model (every route, including the list): verifyToken (self-verifying,
 * same as routes/menu.js — this path is not exempted by the global gate
 * either way, so this is defense-in-depth) → MGR (admin/manager, matching
 * routes/menu.js's existing write-gate pattern) → requireCapability
 * ('menu.image.manage') layered on top, so a future non-manager role can be
 * granted (or a manager revoked) image-management access independently of
 * the blanket MGR role gate.
 */
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const verifyToken = require('./authMiddleware');
const requireCapability = require('../middleware/requireCapability');
const { imageDataError } = require('../lib/imageValidation');
const { logAudit } = require('../lib/auditLogger');

const MGR = verifyToken.requireRole('admin', 'manager');
const CAP = requireCapability('menu.image.manage');

// Every route in this router is management-only — applied once for the whole
// router rather than repeated on each handler.
router.use(verifyToken, MGR, CAP);

const MAX_BULK_ITEMS = 100;
const _isSeedRow = (id) => typeof id === 'string' && id.startsWith('SEED-');
const _sha1 = (v) => (v ? crypto.createHash('sha1').update(v).digest('hex') : null);

// GET /api/product-images — paginated list, filterable. NEVER selects
// image_data itself (see itemImage.api.test.js's "the 66MB rule" for why:
// the blob rides only as a content hash + byte length).
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    const conds = ["id NOT LIKE 'SEED-%'"];
    const params = [];

    if (req.query.hasImage === 'true') conds.push('image_data IS NOT NULL');
    else if (req.query.hasImage === 'false') conds.push('image_data IS NULL');

    if (req.query.brandId) { conds.push('brand_id = ?'); params.push(req.query.brandId); }
    if (req.query.category) { conds.push('category = ?'); params.push(req.query.category); }
    if (req.query.q) {
      const like = '%' + String(req.query.q).slice(0, 200) + '%';
      conds.push('(name LIKE ? OR name_en LIKE ?)');
      params.push(like, like);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    const [[countRow]] = await db.query(`SELECT COUNT(*) AS total FROM menu ${where}`, params);
    const total = Number(countRow.total) || 0;

    const [rows] = await db.query(
      `SELECT id, name, name_en, category, brand_id,
              SUBSTRING(SHA2(image_data,256),1,8) AS image_ver,
              LENGTH(image_data) AS image_bytes
         FROM menu ${where}
        ORDER BY category, name
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]);

    res.json({
      success: true,
      page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map(r => ({
        id: r.id,
        name: r.name,
        nameEn: r.name_en || '',
        category: r.category,
        brandId: r.brand_id || '',
        imageVer: r.image_ver || null,
        imageBytes: r.image_bytes == null ? 0 : Number(r.image_bytes)
      }))
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/product-images/bulk — body: { items: [{menuId, imageData}], dryRun }
// Each valid item is written in its OWN transaction so one bad row never
// rolls back the good ones. dryRun validates + reports without writing.
router.post('/bulk', async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : null;
    const dryRun = !!body.dryRun;
    if (!items || !items.length) {
      return res.status(400).json({ success: false, error: 'items[] مطلوب' });
    }
    if (items.length > MAX_BULK_ITEMS) {
      return res.status(400).json({
        success: false,
        code: 'BULK_LIMIT_EXCEEDED',
        error: `الحد الأقصى ${MAX_BULK_ITEMS} صنف لكل دفعة`
      });
    }

    const username = (req.user && req.user.username) || 'system';
    const results = [];

    for (const it of (items || [])) {
      const menuId = it && it.menuId;
      const imageData = it && it.imageData;

      if (!menuId || typeof menuId !== 'string') {
        results.push({ menuId: menuId || null, ok: false, code: 'MISSING_MENU_ID', error: 'menuId مطلوب' });
        continue;
      }
      if (_isSeedRow(menuId)) {
        results.push({ menuId, ok: false, code: 'SEED_ROW_EXCLUDED', error: 'صفوف SEED مستثناة من إدارة الصور بالجملة' });
        continue;
      }
      const imgErr = imageDataError(imageData);
      if (imgErr) {
        results.push({ menuId, ok: false, code: 'INVALID_IMAGE', error: imgErr });
        continue;
      }

      try {
        if (dryRun) {
          // Validate-only — no write, but still confirm the row exists so a
          // dry run surfaces the same failure a real run would hit.
          const [rows] = await db.query('SELECT image_data FROM menu WHERE id = ?', [menuId]);
          if (!rows.length) {
            results.push({ menuId, ok: false, code: 'MENU_NOT_FOUND', error: 'الصنف غير موجود' });
            continue;
          }
          const beforeSha1 = _sha1(rows[0].image_data);
          const afterSha1 = _sha1(imageData || null);
          results.push({ menuId, ok: true, dryRun: true, before: beforeSha1, after: afterSha1 });
          continue;
        }

        const outcome = await db.withTransaction(async (conn) => {
          const [rows] = await conn.query('SELECT image_data FROM menu WHERE id = ? FOR UPDATE', [menuId]);
          if (!rows.length) {
            const e = new Error('الصنف غير موجود');
            e.code = 'MENU_NOT_FOUND';
            throw e;
          }
          const beforeSha1 = _sha1(rows[0].image_data);
          const newVal = imageData || null;
          await conn.query('UPDATE menu SET image_data = ? WHERE id = ?', [newVal, menuId]);
          return { beforeSha1, afterSha1: _sha1(newVal) };
        });

        await logAudit('bulk_image_upload', 'menu_image', menuId, username,
          { before: outcome.beforeSha1, after: outcome.afterSha1, dryRun: false }, req.ip);

        results.push({ menuId, ok: true, dryRun: false, before: outcome.beforeSha1, after: outcome.afterSha1 });
      } catch (e) {
        results.push({ menuId, ok: false, code: e.code || 'WRITE_FAILED', error: e.message });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    res.json({
      success: true,
      dryRun,
      total: items.length,
      succeeded,
      failed: results.length - succeeded,
      results
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PUT /api/product-images/:menuId — single replace.
router.put('/:menuId', async (req, res) => {
  try {
    const menuId = req.params.menuId;
    const imageData = req.body ? req.body.imageData : undefined;

    if (_isSeedRow(menuId)) {
      return res.status(400).json({ success: false, code: 'SEED_ROW_EXCLUDED', error: 'صفوف SEED مستثناة من إدارة الصور بالجملة' });
    }
    const imgErr = imageDataError(imageData);
    if (imgErr) return res.status(400).json({ success: false, error: imgErr });

    const username = (req.user && req.user.username) || 'system';
    const outcome = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT image_data FROM menu WHERE id = ? FOR UPDATE', [menuId]);
      if (!rows.length) {
        const e = new Error('الصنف غير موجود');
        e.code = 'MENU_NOT_FOUND';
        throw e;
      }
      const beforeSha1 = _sha1(rows[0].image_data);
      const newVal = imageData || null;
      await conn.query('UPDATE menu SET image_data = ? WHERE id = ?', [newVal, menuId]);
      return { beforeSha1, afterSha1: _sha1(newVal) };
    });

    await logAudit('product_image_replace', 'menu_image', menuId, username,
      { before: outcome.beforeSha1, after: outcome.afterSha1, dryRun: false }, req.ip);

    res.json({ success: true, menuId, before: outcome.beforeSha1, after: outcome.afterSha1 });
  } catch (e) {
    if (e.code === 'MENU_NOT_FOUND') return res.status(404).json({ success: false, error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/product-images/:menuId — clears the stored image (image_data = NULL).
router.delete('/:menuId', async (req, res) => {
  try {
    const menuId = req.params.menuId;
    if (_isSeedRow(menuId)) {
      return res.status(400).json({ success: false, code: 'SEED_ROW_EXCLUDED', error: 'صفوف SEED مستثناة من إدارة الصور بالجملة' });
    }
    const username = (req.user && req.user.username) || 'system';
    const outcome = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT image_data FROM menu WHERE id = ? FOR UPDATE', [menuId]);
      if (!rows.length) {
        const e = new Error('الصنف غير موجود');
        e.code = 'MENU_NOT_FOUND';
        throw e;
      }
      const beforeSha1 = _sha1(rows[0].image_data);
      await conn.query('UPDATE menu SET image_data = NULL WHERE id = ?', [menuId]);
      return { beforeSha1 };
    });

    await logAudit('product_image_delete', 'menu_image', menuId, username,
      { before: outcome.beforeSha1, after: null, dryRun: false }, req.ip);

    res.json({ success: true, menuId, before: outcome.beforeSha1, after: null });
  } catch (e) {
    if (e.code === 'MENU_NOT_FOUND') return res.status(404).json({ success: false, error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
