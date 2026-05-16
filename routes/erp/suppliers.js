// ═══════════════════════════════════════════════════════════════════
// /api/erp/suppliers — Supplier CRUD
//
// Part of the v5.17.1 routes/erp/ split. Mounted at the same prefix
// as the original routes/erp.js so URLs are unchanged.
// Endpoints:
//   GET    /suppliers                (optional ?brandId= and ?activeOnly=)
//   POST   /suppliers                (insert or update)
//   DELETE /suppliers/:id            (hard delete)
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/suppliers', async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly !== 'false';
    const { brandId } = req.query;
    let query = `SELECT s.*, b.name AS brand_name
                 FROM suppliers s LEFT JOIN brands b ON b.id = s.brand_id`;
    const params = [];
    const conds = [];
    if (activeOnly) conds.push('s.is_active = 1');
    if (brandId) { conds.push('s.brand_id = ?'); params.push(brandId); }
    if (conds.length) query += ' WHERE ' + conds.join(' AND ');
    query += ' ORDER BY s.name';

    const [rows] = await db.query(query, params);
    res.json(rows.map(s => ({
      id: s.id, name: s.name, nameEn: s.name_en, vatNumber: s.vat_number,
      phone: s.phone, email: s.email, address: s.address, city: s.city,
      paymentTerms: s.payment_terms, balance: Number(s.balance), isActive: s.is_active,
      brandId: s.brand_id || '', brand_id: s.brand_id || '', brandName: s.brand_name || '',
      createdAt: s.created_at, createdBy: s.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/suppliers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, paymentTerms, username, brandId } = req.body;
    const brand = brandId || null;

    if (id) {
      const [existing] = await db.query('SELECT id FROM suppliers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE suppliers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, payment_terms=?, updated_by=?, brand_id=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           paymentTerms || 'Cash', username || '', brand, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'SUP-' + Date.now();
    await db.query(
      `INSERT INTO suppliers (id, name, name_en, vat_number, phone, email, address, city, payment_terms, created_by, brand_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       paymentTerms || 'Cash', username || '', brand]
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete supplier
router.delete('/suppliers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
