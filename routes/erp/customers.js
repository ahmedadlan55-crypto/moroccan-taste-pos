// ═══════════════════════════════════════════════════════════════════
// /api/erp/customers — Customer CRUD + autocomplete search
//
// Part of the v5.17.1 routes/erp/ split. Mounted at the same prefix
// as the original routes/erp.js so URLs are unchanged.
// Endpoints:
//   GET    /customers
//   GET    /customers/search?q=…   (v5.11.4 — POS autocomplete)
//   POST   /customers              (insert or update)
//   DELETE /customers/:id          (soft-delete — sets is_active = 0)
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/customers', async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly !== 'false';
    let query = 'SELECT * FROM customers';
    if (activeOnly) query += ' WHERE is_active = 1';
    query += ' ORDER BY name';

    const [rows] = await db.query(query);
    res.json(rows.map(c => ({
      id: c.id, name: c.name, nameEn: c.name_en, vatNumber: c.vat_number,
      phone: c.phone, email: c.email, address: c.address, city: c.city,
      gender: c.gender || 'unknown',
      customerType: c.customer_type, creditLimit: Number(c.credit_limit),
      balance: Number(c.balance), isActive: c.is_active,
      createdAt: c.created_at, createdBy: c.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

// v5.11.4 — autocomplete for POS customer panel + ERP sales filter.
// Matches phone (LIKE) OR name (LIKE) OR name_en (LIKE). Returns up to
// 8 rows ordered so an exact phone match floats to the top.
router.get('/customers/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = '%' + q + '%';
    const [rows] = await db.query(
      `SELECT id, name, name_en, phone, gender, customer_type
         FROM customers
        WHERE is_active = 1
          AND (phone LIKE ? OR name LIKE ? OR name_en LIKE ?)
        ORDER BY (phone = ?) DESC, name
        LIMIT 8`,
      [like, like, like, q]
    );
    res.json(rows.map(c => ({
      id: c.id, name: c.name, nameEn: c.name_en,
      phone: c.phone || '', gender: c.gender || 'unknown',
      customerType: c.customer_type || 'B2C'
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/customers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, customerType, creditLimit, gender, username } = req.body;
    const safeGender = (gender === 'male' || gender === 'female') ? gender : 'unknown';

    if (id) {
      const [existing] = await db.query('SELECT id FROM customers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE customers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, customer_type=?, credit_limit=?, gender=?, updated_by=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           customerType || 'B2C', creditLimit || 0, safeGender, username || '', id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'CUST-' + Date.now();
    await db.query(
      `INSERT INTO customers (id, name, name_en, vat_number, phone, email, address, city, customer_type, credit_limit, gender, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       customerType || 'B2C', creditLimit || 0, safeGender, username || '']
    );

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Deactivate customer (soft delete)
router.delete('/customers/:id', async (req, res) => {
  try {
    await db.query('UPDATE customers SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
