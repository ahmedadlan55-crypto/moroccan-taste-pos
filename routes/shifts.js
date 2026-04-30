const router = require('express').Router();
const db = require('../db/connection');

// Open shift
router.post('/open', async (req, res) => {
  try {
    const { username, geoLat, geoLng, geoAddress, deviceInfo } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';

    // Check if user already has an open shift
    const [existing] = await db.query('SELECT id FROM shifts WHERE username = ? AND status = "OPEN"', [username]);
    if (existing.length) {
      return res.json({ success: true, shiftId: existing[0].id });
    }

    const shiftId = 'SH-' + Date.now();
    const now = new Date();

    await db.query(
      'INSERT INTO shifts (id, username, start_time, status, geo_lat, geo_lng, geo_address, device_info, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [shiftId, username, now, 'OPEN', geoLat||null, geoLng||null, geoAddress||'', deviceInfo||'', ip]
    );

    res.json({ success: true, shiftId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Close shift
router.post('/close', async (req, res) => {
  try {
    const { shiftId, actualCash, actualCard, actualKita } = req.body;
    const now = new Date();

    // Get theoretical totals from sales
    const [sales] = await db.query('SELECT payment_method, total_final, kita_service_fee FROM sales WHERE shift_id = ?', [shiftId]);

    let theoreticalCash = 0;
    let theoreticalCard = 0;
    let theoreticalKita = 0;

    for (const sale of sales) {
      const total = Number(sale.total_final);
      const pm = (sale.payment_method || '').toLowerCase();

      if (pm.includes('/')) {
        // Split payment
        const parts = sale.payment_method.split('/');
        for (const part of parts) {
          const [method, amount] = part.split(':');
          const val = Number(amount) || 0;
          if (method.toLowerCase() === 'cash') theoreticalCash += val;
          else if (method.toLowerCase() === 'card') theoreticalCard += val;
          else if (method.toLowerCase() === 'kita') theoreticalKita += val;
        }
      } else if (pm === 'cash') {
        theoreticalCash += total;
      } else if (pm === 'card') {
        theoreticalCard += total;
      } else if (pm === 'kita') {
        theoreticalKita += total;
      }
    }

    const totalTheoretical = theoreticalCash + theoreticalCard + theoreticalKita;
    const diffCash = (Number(actualCash) || 0) - theoreticalCash;
    const diffCard = (Number(actualCard) || 0) - theoreticalCard;
    const diffKita = (Number(actualKita) || 0) - theoreticalKita;

    await db.query(
      `UPDATE shifts SET end_time = ?, status = 'closed',
       total_theoretical = ?, theoretical_cash = ?, theoretical_card = ?, theoretical_kita = ?,
       actual_cash = ?, actual_card = ?, actual_kita = ?,
       diff_cash = ?, diff_card = ?, diff_kita = ?
       WHERE id = ?`,
      [now, totalTheoretical, theoreticalCash, theoreticalCard, theoreticalKita,
       actualCash || 0, actualCard || 0, actualKita || 0,
       diffCash, diffCard, diffKita, shiftId]
    );

    res.json({
      success: true,
      theoreticalCash, theoreticalCard, theoreticalKita,
      diffCash, diffCard, diffKita, totalTheoretical
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// V3 — Enhanced shift close: dynamic payment methods + cash denominations
// Body: {
//   shiftId,
//   openingFloat: <number>,
//   denominations: [{ value, count, kind: 'note'|'coin' }...],
//   paymentTotals: { <pmId>: <actualAmount>, ... },
//   notes
// }
// ═══════════════════════════════════════════════════════════════════
router.post('/close-v3', async (req, res) => {
  try {
    const { shiftId, openingFloat, denominations, paymentTotals, notes } = req.body;
    if (!shiftId) return res.json({ success: false, error: 'shiftId مطلوب' });
    const now = new Date();

    // 1. Build expected totals from sales (per payment method)
    const [sales] = await db.query('SELECT payment_method, total_final FROM sales WHERE shift_id = ?', [shiftId]);
    const expected = {}; // { method: amount }
    let expectedTotal = 0;
    for (const s of sales) {
      const total = Number(s.total_final) || 0;
      const pm = (s.payment_method || 'cash').toLowerCase();
      if (pm.includes('/')) {
        for (const part of pm.split('/')) {
          const [m, a] = part.split(':');
          const val = Number(a) || 0;
          expected[m] = (expected[m] || 0) + val;
          expectedTotal += val;
        }
      } else {
        expected[pm] = (expected[pm] || 0) + total;
        expectedTotal += total;
      }
    }

    // 2. Sum cash from denominations (if provided)
    let cashCounted = 0;
    const denomList = Array.isArray(denominations) ? denominations : [];
    for (const d of denomList) {
      cashCounted += (Number(d.value) || 0) * (Number(d.count) || 0);
    }
    cashCounted += Number(openingFloat || 0); // Returns the opening float on top of counted

    // 3. Variance per method
    const actuals = paymentTotals || {};
    if (cashCounted > 0 && actuals.cash == null) actuals.cash = cashCounted;
    let actualTotal = 0;
    for (const k in actuals) actualTotal += Number(actuals[k] || 0);
    const variance = actualTotal - expectedTotal;

    // 4. Persist denominations
    await db.query('DELETE FROM shift_close_denominations WHERE shift_id = ?', [shiftId]);
    for (let i = 0; i < denomList.length; i++) {
      const d = denomList[i];
      const cnt = Number(d.count) || 0;
      if (cnt > 0) {
        const did = 'DEN-' + shiftId + '-' + i;
        await db.query(
          'INSERT INTO shift_close_denominations (id, shift_id, denomination, kind, count) VALUES (?,?,?,?,?)',
          [did, shiftId, Number(d.value) || 0, d.kind || 'note', cnt]
        );
      }
    }

    // 5. Update the shift row with full close data
    await db.query(
      `UPDATE shifts SET
         end_time = ?, status = 'closed',
         opening_float = ?, expected_total = ?, actual_total = ?, variance_total = ?,
         payment_totals_json = ?, denominations_json = ?, cashier_notes = ?,
         total_theoretical = ?, theoretical_cash = ?, actual_cash = ?, diff_cash = ?
       WHERE id = ?`,
      [
        now,
        Number(openingFloat || 0), expectedTotal, actualTotal, variance,
        JSON.stringify({ expected, actuals }), JSON.stringify(denomList), notes || '',
        expectedTotal, expected.cash || 0, actuals.cash || 0, (Number(actuals.cash || 0) - (expected.cash || 0)),
        shiftId
      ]
    );

    res.json({
      success: true,
      shiftId,
      expected, actuals, expectedTotal, actualTotal, variance,
      cashCounted, denominations: denomList,
      orderCount: sales.length
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Closing data v3 — returns expected totals per dynamic payment method
router.get('/closing-data-v3/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // Pull all enabled methods so the cashier sees the full reconciliation grid
    const [methods] = await db.query(
      "SELECT id, name, name_ar, icon, color, group_type FROM payment_methods WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
    );
    const [sales] = await db.query('SELECT payment_method, total_final FROM sales WHERE shift_id = ?', [shiftId]);

    const expected = {}; // keyed by method code (lowercased name)
    let expectedTotal = 0;
    let orderCount = sales.length;
    for (const s of sales) {
      const total = Number(s.total_final) || 0;
      const pm = (s.payment_method || 'cash').toLowerCase();
      if (pm.includes('/')) {
        for (const part of pm.split('/')) {
          const [m, a] = part.split(':');
          const val = Number(a) || 0;
          expected[m] = (expected[m] || 0) + val;
          expectedTotal += val;
        }
      } else {
        expected[pm] = (expected[pm] || 0) + total;
        expectedTotal += total;
      }
    }
    res.json({
      methods: methods.map(m => ({
        id: m.id, name: m.name, nameAr: m.name_ar, icon: m.icon, color: m.color,
        groupType: m.group_type,
        expectedAmount: expected[(m.name||'').toLowerCase()] || expected[m.id] || 0
      })),
      expected, expectedTotal, orderCount
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Get all shifts
router.get('/', async (req, res) => {
  try {
    let query = 'SELECT * FROM shifts WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND DATE(start_time) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND DATE(start_time) <= ?'; params.push(req.query.endDate); }
    if (req.query.username) { query += ' AND username = ?'; params.push(req.query.username); }
    if (req.query.status) { query += ' AND status = ?'; params.push(req.query.status); }

    query += ' ORDER BY start_time DESC LIMIT 200';

    const [rows] = await db.query(query, params);
    // Get user display names
    let userMap = {};
    try {
      const [meta] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (meta.length) userMap = JSON.parse(meta[0].setting_value || '{}');
    } catch(e) {}
    res.json(rows.map(s => ({
      id: s.id, username: s.username,
      displayName: (userMap[s.username] && userMap[s.username].name) || s.username,
      startTime: s.start_time, endTime: s.end_time, status: s.status,
      totalTheoretical: Number(s.total_theoretical),
      theoreticalCash: Number(s.theoretical_cash),
      theoreticalCard: Number(s.theoretical_card),
      theoreticalKita: Number(s.theoretical_kita),
      actualCash: Number(s.actual_cash),
      actualCard: Number(s.actual_card),
      actualKita: Number(s.actual_kita),
      diffCash: Number(s.diff_cash),
      diffCard: Number(s.diff_card),
      diffKita: Number(s.diff_kita),
      geoLat: s.geo_lat ? Number(s.geo_lat) : null,
      geoLng: s.geo_lng ? Number(s.geo_lng) : null,
      geoAddress: s.geo_address || '',
      deviceInfo: s.device_info || '',
      ipAddress: s.ip_address || ''
    })));
  } catch (e) {
    res.json([]);
  }
});

// Get closing data (theoretical totals for a shift)
router.get('/closing-data/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // ── 1. Pull all active payment methods (drives the dynamic table) ──
    let methods = [];
    try {
      const [rows] = await db.query(
        "SELECT id, name, name_ar, icon, color, group_type FROM payment_methods " +
        "WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
      );
      methods = rows;
    } catch (_) {
      // Legacy DB without payment_methods.show_in_shift_close column
      try {
        const [rows] = await db.query(
          "SELECT id, name, name_ar FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, name"
        );
        methods = rows;
      } catch (__) { methods = []; }
    }

    // ── 2. Pull sales for this shift ──
    const [sales] = await db.query(
      'SELECT id, payment_method, total_final, kita_service_fee FROM sales WHERE shift_id = ?',
      [shiftId]
    );
    const orderCount = sales.length;

    // ── 3. Build a SMART MATCHER from sales.payment_method strings to method.id ──
    //    Sales rows store payment_method as a free-form string ("mada", "Visa",
    //    "Card", "كاش", "kita", or split syntax "cash:50/card:30").
    //    Many systems use 'mada' on the wire but the registry has name='Card'
    //    + name_ar='مدى/شبكة' → previously this fell through and Mada totals
    //    showed as 0. We now build a lookup keyed by:
    //      • name (lowercased) → e.g. 'card'
    //      • name_ar (raw)     → e.g. 'مدى/شبكة'
    //      • each token of name_ar split on /  → 'مدى', 'شبكة'
    //      • group_type        → 'cash' / 'electronic' / etc.
    //      • known aliases     → mada/visa/master/network → 'electronic' group
    //      • method.id (string)
    function norm(s) { return String(s || '').toLowerCase().trim(); }
    const lookup = {}; // string-key → method object (the canonical row to credit)
    const ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى'];
    const CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
    const KITA_ALIASES = ['kita','كيتا','آجل','ajl'];
    function indexMethod(m) {
      const keys = new Set();
      keys.add(norm(m.name));
      keys.add(norm(m.name_ar));
      keys.add(String(m.id));
      // Split name_ar on common separators (/، -)
      String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => keys.add(norm(p)));
      // group_type-based aliases (so a sale with payment_method='mada'
      // resolves to whichever method has group_type='electronic')
      if (m.group_type === 'electronic' || m.group_type === 'card') {
        ELECTRONIC_ALIASES.forEach(a => keys.add(a));
      } else if (m.group_type === 'cash' || norm(m.name) === 'cash') {
        CASH_ALIASES.forEach(a => keys.add(a));
      } else if (m.group_type === 'voucher' || norm(m.name) === 'kita') {
        KITA_ALIASES.forEach(a => keys.add(a));
      }
      keys.forEach(k => { if (k && !lookup[k]) lookup[k] = m; });
    }
    methods.forEach(indexMethod);
    // Fallback synthetic methods so reports never lose data when a known
    // payment string has NO matching row in payment_methods (e.g. fresh DB).
    function ensure(syntheticId, name, name_ar, group_type) {
      // Only add if no method already claims any of its aliases
      const aliasKey = norm(name);
      if (lookup[aliasKey]) return;
      const synth = { id: syntheticId, name, name_ar, group_type, _synthetic: true };
      methods.push(synth);
      indexMethod(synth);
    }
    ensure('_cash',       'Cash',       'نقدي / كاش',  'cash');
    ensure('_electronic', 'Card / Mada','شبكة / مدى',  'electronic');
    ensure('_kita',       'Kita',       'كيتا / آجل',  'voucher');

    // ── 4. Aggregate sale totals per matched method ──
    const expectedById = {}; // method.id → amount
    let expectedTotal = 0;
    let unmatchedTotal = 0;
    const unmatchedDetails = []; // for debugging — methods that didn't resolve
    function credit(rawMethod, amount) {
      const key = norm(rawMethod);
      const m = lookup[key];
      if (m) {
        expectedById[m.id] = (expectedById[m.id] || 0) + amount;
      } else {
        unmatchedTotal += amount;
        unmatchedDetails.push({ raw: rawMethod, amount });
      }
      expectedTotal += amount;
    }
    for (const sale of sales) {
      const total = Number(sale.total_final) || 0;
      const pmRaw = sale.payment_method || 'cash';
      if (String(pmRaw).includes('/')) {
        // Split-payment syntax: "cash:50/card:30"
        for (const part of String(pmRaw).split('/')) {
          const [m, a] = part.split(':');
          credit(m, Number(a) || 0);
        }
      } else {
        credit(pmRaw, total);
      }
    }

    // ── 5. Aggregate sold items (the missing piece — items table on report) ──
    let soldItems = [];
    try {
      const [items] = await db.query(
        'SELECT si.item_name AS name, si.qty, si.price, si.total ' +
        'FROM sales_items si JOIN sales s ON s.id = si.order_id ' +
        'WHERE s.shift_id = ? ORDER BY si.item_name',
        [shiftId]
      );
      // Group by name (server-side aggregation matches the report's behavior)
      const agg = {};
      for (const it of items) {
        const n = String(it.name || 'غير معروف');
        if (!agg[n]) agg[n] = { name: n, qty: 0, price: Number(it.price) || 0, total: 0 };
        agg[n].qty   += Number(it.qty)   || 0;
        agg[n].total += Number(it.total) || 0;
      }
      soldItems = Object.values(agg).sort((a, b) => b.qty - a.qty);
    } catch (_) { soldItems = []; }

    // ── 6. Back-compat shape (theoreticalCash/Card/Kita) ──
    //      Old POS clients still read these. Map by group_type.
    let theoreticalCash = 0, theoreticalCard = 0, theoreticalKita = 0;
    methods.forEach(m => {
      const amt = expectedById[m.id] || 0;
      const gt = m.group_type;
      if (gt === 'cash')                                   theoreticalCash += amt;
      else if (gt === 'electronic' || gt === 'card')       theoreticalCard += amt;
      else if (gt === 'voucher' || norm(m.name) === 'kita') theoreticalKita += amt;
      else                                                  theoreticalCash += amt; // safe default
    });

    res.json({
      // ── New rich shape ──
      methods: methods
        .filter(m => !m._synthetic || (expectedById[m.id] || 0) > 0)
        .map(m => ({
          id: m.id, name: m.name, nameAr: m.name_ar,
          icon: m.icon || 'fa-money-bill', color: m.color || '#3b82f6',
          groupType: m.group_type,
          expectedAmount: expectedById[m.id] || 0
        })),
      soldItems: soldItems,
      unmatchedTotal: unmatchedTotal,
      unmatchedDetails: unmatchedDetails,
      // ── Legacy shape (back-compat) ──
      theoreticalCash, theoreticalCard, theoreticalKita,
      totalTheoretical: expectedTotal,
      orderCount: orderCount
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE shift
// - Hard-delete by default
// - ?unlinkSales=1 to detach sales from this shift (set shift_id=NULL)
//   instead of keeping them linked to a deleted shift
// - Refuses to delete shifts with linked sales unless ?force=1 is passed
// ═══════════════════════════════════════════════════════════════════
router.delete('/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const force = req.query.force === '1' || req.query.force === 'true';
    const unlinkSales = req.query.unlinkSales === '1' || req.query.unlinkSales === 'true';

    // Confirm the shift exists
    const [rows] = await db.query('SELECT id, status FROM shifts WHERE id = ?', [shiftId]);
    if (!rows.length) return res.json({ success: false, error: 'المناوبة غير موجودة' });

    // Count linked sales for safety
    const [cntRows] = await db.query('SELECT COUNT(*) AS c FROM sales WHERE shift_id = ?', [shiftId]);
    const linkedCount = Number(cntRows[0].c || 0);

    if (linkedCount > 0 && !force && !unlinkSales) {
      return res.json({
        success: false,
        requiresConfirm: true,
        linkedSales: linkedCount,
        error: 'المناوبة مرتبطة بـ '+linkedCount+' عملية بيع — أضف force=1 لحذفها مع فصل المبيعات، أو unlinkSales=1 لفصل المبيعات فقط ثم الحذف.'
      });
    }

    // Unlink sales (set shift_id = NULL) rather than cascade-deleting them —
    // losing sales data is almost always a bigger problem than losing a shift record.
    if (linkedCount > 0) {
      await db.query('UPDATE sales SET shift_id = NULL WHERE shift_id = ?', [shiftId]);
    }

    await db.query('DELETE FROM shifts WHERE id = ?', [shiftId]);
    res.json({ success: true, deleted: shiftId, unlinkedSales: linkedCount });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Bulk delete
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids, unlinkSales } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'لم يُحدَّد أي معرّف' });
    const placeholders = ids.map(() => '?').join(',');
    if (unlinkSales) {
      await db.query('UPDATE sales SET shift_id = NULL WHERE shift_id IN ('+placeholders+')', ids);
    }
    const [r] = await db.query('DELETE FROM shifts WHERE id IN ('+placeholders+')', ids);
    res.json({ success: true, deleted: r.affectedRows || ids.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
