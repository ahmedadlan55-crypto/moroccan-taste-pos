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

    const [sales] = await db.query('SELECT payment_method, total_final, kita_service_fee FROM sales WHERE shift_id = ?', [shiftId]);

    let theoreticalCash = 0;
    let theoreticalCard = 0;
    let theoreticalKita = 0;
    let orderCount = sales.length;

    for (const sale of sales) {
      const total = Number(sale.total_final);
      const pm = (sale.payment_method || '').toLowerCase();

      if (pm.includes('/')) {
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

    res.json({
      theoreticalCash, theoreticalCard, theoreticalKita,
      totalTheoretical: theoreticalCash + theoreticalCard + theoreticalKita,
      orderCount
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
