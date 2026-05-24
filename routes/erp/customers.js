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
// 20 rows ordered so an exact phone match floats to the top.
//
// v6.15.1 — Critical fixes after the v6.15.0 modal-driven UX release
// surfaced "I added a customer but search couldn't find them":
//   1. Arabic normalisation: the saved name may contain أ/إ/آ/ٱ but the
//      cashier searches with ا (or vice-versa).  We now normalise BOTH
//      sides via a SQL REPLACE chain so the LIKE still matches.  Same
//      for ة↔ه and ى↔ي (extremely common confusion).
//   2. Phone normalisation: cashier might type "0501234567" but the
//      saved value is "501234567" (no leading zero) or "+966501234567".
//      We strip non-digits from both sides for the phone comparison.
//   3. Empty query (length 0 or 1) now returns the 20 most recently
//      created customers — used by the search-modal empty state so the
//      cashier always sees at least the just-added customer.
//   4. Increased LIMIT 8 → 20 since the modal can scroll.
router.get('/customers/search', async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim();

    // SQL_AR_NORM(col) builds a normalisation chain that works on MySQL
    // 5.7 AND 8.0+ (no REGEXP_REPLACE — that's 8.0-only).  Maps:
    //   أ إ آ ٱ  → ا   (alef variants)
    //   ة         → ه   (taa marboota ↔ haa confusion)
    //   ى         → ي   (alef maksoora ↔ yaa)
    // Combined with LOWER() for Latin case-insensitivity.
    const SQL_AR_NORM = function (col) {
      return (
        "LOWER(" +
          "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(" +
            col +
            ",'أ','ا'),'إ','ا'),'آ','ا'),'ٱ','ا'),'ة','ه'),'ى','ي'" +
        ")"
      );
    };
    const arNormJs = function (s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي');
    };
    const stripPhone = function (s) { return String(s || '').replace(/\D+/g, ''); };

    // Empty/short query → return the 20 most recent active customers so
    // the modal's empty state shows something useful (and the cashier
    // can verify "the customer I just added is in the list").
    if (qRaw.length < 2) {
      const [recent] = await db.query(
        `SELECT id, name, name_en, phone, gender, customer_type
           FROM customers
          WHERE is_active = 1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`
      );
      return res.json(recent.map(c => ({
        id: c.id, name: c.name, nameEn: c.name_en,
        phone: c.phone || '', gender: c.gender || 'unknown',
        customerType: c.customer_type || 'B2C'
      })));
    }

    const qNorm   = arNormJs(qRaw);
    const qDigits = stripPhone(qRaw);
    const likeName  = '%' + qNorm + '%';

    const conditions = [
      SQL_AR_NORM('name')    + ' LIKE ?',
      SQL_AR_NORM('name_en') + ' LIKE ?',
      'phone LIKE ?',  // raw phone column — matches partial dial-pad input
    ];
    const params = [likeName, likeName, '%' + qRaw + '%'];

    // If the query contains digits, also search by digit-stripped phone.
    // (Most phones are saved digits-only, but some legacy rows might
    // have "+966 50 ..." or spaces — this still misses those.  A future
    // migration could normalise the column in place.)
    if (qDigits && qDigits !== qRaw) {
      conditions.push('phone LIKE ?');
      params.push('%' + qDigits + '%');
    }

    const whereCustomerMatch = '(' + conditions.join(' OR ') + ')';

    // ORDER BY: exact phone match first, then name
    params.push(qRaw);

    const [rows] = await db.query(
      `SELECT id, name, name_en, phone, gender, customer_type
         FROM customers
        WHERE is_active = 1
          AND ${whereCustomerMatch}
        ORDER BY (phone = ?) DESC, name
        LIMIT 20`,
      params
    );

    res.json(rows.map(c => ({
      id: c.id, name: c.name, nameEn: c.name_en,
      phone: c.phone || '', gender: c.gender || 'unknown',
      customerType: c.customer_type || 'B2C'
    })));
  } catch (e) {
    // v6.15.1 — log so we can see WHY search fails when the cashier reports
    // "I can't find a customer I just added".
    console.error('[customers/search] FAILED q=', req.query.q, e && e.message);
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
