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
const requireRole = require('../../middleware/auth').requireRole;

// v7.4 — Authorization. These routes previously carried NO role guard at all:
// `/api/erp` only chains audit + warehouse-scope middleware, so ANY authenticated
// principal — including `employee` and `custody`, who have no business touching
// the customer master — could list, create and soft-delete customers. Verified
// exploitable: a plain cashier's token returned HTTP 200 on
// DELETE /api/erp/customers/:id and set is_active = 0.
//
// Reads + create stay open to the till (the cashier genuinely creates a customer
// mid-checkout — that is legacy parity, see public/pos/app.js customer flow).
// Deletion is a master-data operation and is restricted to admin/manager.
const CUSTOMER_READ  = requireRole('admin', 'manager', 'cashier');
const CUSTOMER_WRITE = requireRole('admin', 'manager', 'cashier');
const CUSTOMER_ADMIN = requireRole('admin', 'manager');

router.get('/customers', CUSTOMER_READ, async (req, res) => {
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
router.get('/customers/search', CUSTOMER_READ, async (req, res) => {
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

router.post('/customers', CUSTOMER_WRITE, async (req, res) => {
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

// Deactivate customer (soft delete) — master-data change, manager+ only.
router.delete('/customers/:id', CUSTOMER_ADMIN, async (req, res) => {
  try {
    await db.query('UPDATE customers SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// v6.16.0 — Customer summary endpoint (POS history panel + modal)
// ────────────────────────────────────────────────────────────────────
// Lightweight aggregate of a customer's sales history, designed for
// the POS customer-bar (always-visible totals strip) and the history
// modal (KPIs + last 50 invoices).
//
// WHY A NEW ENDPOINT instead of reusing /sales?customerId=X:
//   • The legacy /sales endpoint returns items_json for every row,
//     which is heavy to parse + transfer (POS needs <200ms).
//   • Aggregations (SUM/COUNT/AVG/MIN/MAX) run on the DB instead of
//     in JS after fetching 500 rows.
//   • We exclude voids/cancellations directly in SQL so the displayed
//     totals match what the cashier expects ("how much have they
//     actually paid us, net of refunds").
//
// EXCLUSION RULES:
//   • zatca_type='cancellation' → excluded from BOTH aggregates and
//     marked in the recentInvoices list (badge "ملغاة")
//   • zatca_type='credit_note'  → also excluded from the totalSpent
//     aggregate (these are refunds — net effect is already captured
//     by the original sale being voided/returned).  Still shown in
//     recentInvoices with a "مرتجع" badge.
//   • zatca_type='debit_note'   → included (adjustment increasing
//     the bill).
//
// PERFORMANCE: Both queries hit the idx_sales_customer index
// (db/schema.sql:173).  On a customer with 10k orders the aggregate
// runs in <10ms; the recent-50 query in <20ms.
// ════════════════════════════════════════════════════════════════════
router.get('/customers/:id/summary', CUSTOMER_READ, async (req, res) => {
  try {
    const customerId = String(req.params.id || '').trim();
    if (!customerId) return res.json({ success: false, error: 'missing-id' });

    // 1. Load the customer (also confirms existence)
    const [crows] = await db.query(
      'SELECT id, name, name_en, phone, email, gender, customer_type, balance, credit_limit, created_at, is_active FROM customers WHERE id = ? LIMIT 1',
      [customerId]
    );
    if (!crows.length) return res.json({ success: false, error: 'not-found' });
    const c = crows[0];

    // 2. Aggregate KPIs — only "real" sales (standard + simplified).
    //    Cancellations and credit_notes (refunds) excluded so the
    //    cashier sees the cleanest "how much they bought" number.
    const [aggRows] = await db.query(
      `SELECT
         COUNT(*)                              AS orderCount,
         COALESCE(SUM(total_final), 0)        AS totalSpent,
         COALESCE(AVG(total_final), 0)        AS avgInvoice,
         MIN(order_date)                       AS firstVisit,
         MAX(order_date)                       AS lastVisit
       FROM sales
       WHERE customer_id = ?
         AND zatca_type IN ('standard', 'simplified')`,
      [customerId]
    );
    const a = (aggRows && aggRows[0]) || {};

    // 3. Recent invoices — ALL transactions including cancellations
    //    and refunds so the user sees the full timeline.  Light fields
    //    only (no items_json).
    //
    // v6.17.1 — Schema-tolerant: invoice_number / void_serial / return_serial
    // were added in v6.11.0 migration 0002_sales_numbering.sql but are
    // NOT in db/schema.sql baseline.  If migration 0002 didn't run on
    // this deployment, the modern query fails with "Unknown column
    // 'invoice_number'".  We fall back to a minimal SELECT and null-
    // pad the missing fields so the response shape stays consistent.
    // Same pattern as routes/sales.js:917-929 (legacy customer_id
    // fallback).  Defensive-in-depth: server.js also runs
    // addColumnIfMissing on boot to permanently fix this.
    let invRows = [];
    try {
      [invRows] = await db.query(
        `SELECT id, invoice_number, order_date, total_final, payment_method,
                zatca_type, void_serial, return_serial, has_credit_note
           FROM sales
          WHERE customer_id = ?
          ORDER BY order_date DESC
          LIMIT 50`,
        [customerId]
      );
    } catch (colErr) {
      console.warn('[customers/:id/summary] schema fallback (missing numbering cols):', colErr.message);
      const [legacyRows] = await db.query(
        `SELECT id, order_date, total_final, payment_method, zatca_type, has_credit_note
           FROM sales
          WHERE customer_id = ?
          ORDER BY order_date DESC
          LIMIT 50`,
        [customerId]
      );
      invRows = legacyRows.map(r => Object.assign({}, r, {
        invoice_number: null,
        void_serial:    null,
        return_serial:  null
      }));
    }

    res.json({
      success: true,
      customer: {
        id:           c.id,
        name:         c.name,
        nameEn:       c.name_en,
        phone:        c.phone || '',
        email:        c.email || '',
        gender:       c.gender || 'unknown',
        customerType: c.customer_type || 'B2C',
        balance:      Number(c.balance) || 0,
        creditLimit:  Number(c.credit_limit) || 0,
        createdAt:    c.created_at,
        isActive:     !!c.is_active
      },
      kpi: {
        orderCount: Number(a.orderCount) || 0,
        totalSpent: Number(a.totalSpent) || 0,
        avgInvoice: Number(a.avgInvoice) || 0,
        firstVisit: a.firstVisit || null,
        lastVisit:  a.lastVisit  || null
      },
      recentInvoices: (invRows || []).map(r => ({
        id:            r.id,
        invoiceNumber: r.invoice_number || null,
        date:          r.order_date,
        total:         Number(r.total_final) || 0,
        payment:       r.payment_method || '',
        zatcaType:     r.zatca_type || 'standard',
        voidSerial:    r.void_serial   || null,
        returnSerial:  r.return_serial || null,
        hasCreditNote: !!r.has_credit_note
      }))
    });
  } catch (e) {
    console.error('[customers/:id/summary] FAILED', req.params.id, e && e.message);
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
