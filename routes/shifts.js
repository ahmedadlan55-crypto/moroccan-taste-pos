const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════════════════════════════════
// V5.7.17 — Shared payment-aggregation helper used by ALL shift
//   endpoints (close-v3, closing-data, closing-data-v3, the new
//   thermal report). Centralizing this guarantees the SAME
//   computation everywhere — the variance you see in the UI is the
//   variance saved to DB and shown on the printed receipt.
//
//   Returns: {
//     methods: [{ id, name, nameAr, icon, color, groupType, expectedAmount, count }],
//     expectedById: { [methodId]: amount },
//     expectedTotal: number,
//     unmatchedTotal: number,
//     unmatchedDetails: [{ raw, normalized, amount }],
//     soldItems: [{ name, qty, price, total }],
//     orderCount: number
//   }
// ═══════════════════════════════════════════════════════════════════
function _normPM(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}
const _ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
const _CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
const _KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

async function aggregateShiftPayments(shiftId) {
  // 1. Pull all active payment methods (with backward-compat fallback)
  let methods = [];
  try {
    const [rows] = await db.query(
      "SELECT id, name, name_ar, icon, color, group_type, sort_order FROM payment_methods " +
      "WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
    );
    methods = rows;
  } catch (_) {
    try {
      const [rows] = await db.query(
        "SELECT id, name, name_ar FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, name"
      );
      methods = rows;
    } catch (__) { methods = []; }
  }

  // 2. Build exact + alias lookup tables
  const exactLookup = {};
  const aliasLookup = {};
  function indexExact(m) {
    [_normPM(m.name), _normPM(m.name_ar), String(m.id)].forEach(k => {
      if (k && !exactLookup[k]) exactLookup[k] = m;
    });
    String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
      const k = _normPM(p);
      if (k && !exactLookup[k]) exactLookup[k] = m;
    });
  }
  function indexAlias(m) {
    let aliases = [];
    const gt = m.group_type;
    if (gt === 'electronic' || gt === 'card') aliases = _ELECTRONIC_ALIASES;
    else if (gt === 'cash' || _normPM(m.name) === 'cash') aliases = _CASH_ALIASES;
    else if (gt === 'voucher' || _normPM(m.name) === 'kita') aliases = _KITA_ALIASES;
    aliases.map(_normPM).forEach(k => {
      if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
    });
  }
  methods.forEach(indexExact);
  methods.forEach(indexAlias);
  // Synthetic fallbacks for fresh DBs where methods table is empty
  function ensureSynth(syntheticId, name, name_ar, group_type) {
    const aliasKey = _normPM(name);
    if (exactLookup[aliasKey] || aliasLookup[aliasKey]) return;
    const synth = { id: syntheticId, name, name_ar, group_type, _synthetic: true };
    methods.push(synth);
    indexExact(synth);
    indexAlias(synth);
  }
  ensureSynth('_cash',       'Cash',       'نقدي / كاش', 'cash');
  ensureSynth('_electronic', 'Card / Mada','شبكة / مدى', 'electronic');
  ensureSynth('_kita',       'Kita',       'كيتا / آجل', 'voucher');

  // 3. Pull sales for this shift + aggregate per method.id
  // v6.11.0 — Exclude voided + credit-note rows so the shift's expected total
  // matches what the cashier actually collected. Without this filter, a void
  // would still count toward "expected cash" and the shift would never
  // balance unless the cashier returned the money — which they didn't.
  const [sales] = await db.query(
    "SELECT id, payment_method, total_final, kita_service_fee FROM sales " +
    "WHERE shift_id = ? AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))",
    [shiftId]
  );
  const expectedById = {};
  const countById    = {};
  let expectedTotal  = 0;
  let unmatchedTotal = 0;
  const unmatchedDetails = [];
  function credit(rawMethod, amount) {
    const key = _normPM(rawMethod);
    const m = exactLookup[key] || aliasLookup[key];
    if (m) {
      expectedById[m.id] = (expectedById[m.id] || 0) + amount;
      countById[m.id]    = (countById[m.id]    || 0) + 1;
    } else {
      unmatchedTotal += amount;
      unmatchedDetails.push({ raw: rawMethod, normalized: key, amount });
    }
    expectedTotal += amount;
  }
  for (const sale of sales) {
    const total = Number(sale.total_final) || 0;
    const pmRaw = sale.payment_method || 'cash';
    if (String(pmRaw).includes('/') && String(pmRaw).includes(':')) {
      // Split-payment syntax requires BOTH '/' AND ':' (else "مدى/شبكة"
      // would be misparsed as split — see V5.7.14 fix)
      for (const part of String(pmRaw).split('/')) {
        const [m, a] = part.split(':');
        credit(m, Number(a) || 0);
      }
    } else {
      credit(pmRaw, total);
    }
  }

  // 4. Aggregate sold items
  let soldItems = [];
  try {
    const [items] = await db.query(
      'SELECT si.item_name AS name, si.qty, si.price, si.total ' +
      'FROM sales_items si JOIN sales s ON s.id = si.order_id ' +
      'WHERE s.shift_id = ? ORDER BY si.item_name',
      [shiftId]
    );
    const agg = {};
    for (const it of items) {
      const n = String(it.name || 'غير معروف');
      if (!agg[n]) agg[n] = { name: n, qty: 0, price: Number(it.price) || 0, total: 0 };
      agg[n].qty   += Number(it.qty)   || 0;
      agg[n].total += Number(it.total) || 0;
    }
    soldItems = Object.values(agg).sort((a, b) => b.qty - a.qty);
  } catch (_) {}

  return {
    methods: methods
      .filter(m => !m._synthetic || (expectedById[m.id] || 0) > 0)
      .map(m => ({
        id: m.id, name: m.name, nameAr: m.name_ar,
        icon: m.icon || 'fa-money-bill', color: m.color || '#3b82f6',
        groupType: m.group_type,
        expectedAmount: expectedById[m.id] || 0,
        count: countById[m.id] || 0
      })),
    expectedById,
    expectedTotal,
    unmatchedTotal,
    unmatchedDetails,
    soldItems,
    orderCount: sales.length,
    rawSales: sales
  };
}

// Open shift
router.post('/open', async (req, res) => {
  try {
    const { username, geoLat, geoLng, geoAddress, deviceInfo, device } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';

    // Check if user already has an open shift
    const [existing] = await db.query('SELECT id FROM shifts WHERE username = ? AND status = "OPEN"', [username]);
    if (existing.length) {
      return res.json({ success: true, shiftId: existing[0].id });
    }

    const shiftId = 'SH-' + Date.now();
    const now = new Date();

    // v5.12.2 — accept structured device { brand, model, os, ua, mobile }
    // sent by /shared/device-info.js, fall back to legacy raw deviceInfo
    // string for backwards compatibility with older clients.
    const dev = device && typeof device === 'object' ? device : {};
    const rawUA = (dev.ua || deviceInfo || '').toString();

    await db.query(
      'INSERT INTO shifts (id, username, start_time, status, geo_lat, geo_lng, geo_address, device_info, device_brand, device_model, device_os, ip_address) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        shiftId, username, now, 'OPEN',
        geoLat || null, geoLng || null, geoAddress || '',
        rawUA,
        (dev.brand || '').toString().slice(0, 50),
        (dev.model || '').toString().slice(0, 120),
        (dev.os    || '').toString().slice(0, 80),
        ip
      ]
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

    // V5.7.17 — use the SHARED matcher so the variance saved here is
    //   identical to what the UI shows during the close flow. The
    //   previous implementation rolled its own (broken) matcher that
    //   missed Mada and any non-cash/card/kita method.
    const agg = await aggregateShiftPayments(shiftId);
    const expectedById = agg.expectedById;
    const expectedTotal = agg.expectedTotal;
    const methods = agg.methods;

    // ── 1. Sum cash from denominations ──
    let cashCounted = 0;
    const denomList = Array.isArray(denominations) ? denominations : [];
    for (const d of denomList) {
      cashCounted += (Number(d.value) || 0) * (Number(d.count) || 0);
    }
    cashCounted += Number(openingFloat || 0);

    // ── 2. Map incoming paymentTotals → actualsById (canonical key) ──
    //   Frontend sends BOTH `String(method.id)` AND name-based keys for the
    //   same method (defensive redundancy). To avoid double-counting, we
    //   process id keys FIRST (so they win) and skip name keys whose id
    //   was already credited. last-write-wins per method.id.
    const incoming = paymentTotals || {};
    const actualsById = {}; // { methodId: amount }
    const incomingKeys = Object.keys(incoming);
    // Pass 1: id-keyed (highest priority)
    incomingKeys.forEach(rawKey => {
      const amount = Number(incoming[rawKey]) || 0;
      const directIdHit = methods.find(m => String(m.id) === String(rawKey));
      if (directIdHit) actualsById[directIdHit.id] = amount;  // replace, not add
    });
    // Pass 2: name-keyed (only fills gaps not already filled by id)
    incomingKeys.forEach(rawKey => {
      const amount = Number(incoming[rawKey]) || 0;
      const k = _normPM(rawKey);
      // If the key is itself a numeric id we already handled, skip
      const directIdHit = methods.find(m => String(m.id) === String(rawKey));
      if (directIdHit) return;
      const nameHit = methods.find(m => _normPM(m.name) === k || _normPM(m.nameAr) === k);
      if (nameHit && actualsById[nameHit.id] == null) {
        actualsById[nameHit.id] = amount;
        return;
      }
      // Special: explicit 'cash' alias → first cash-group method
      if ((k === 'cash' || _CASH_ALIASES.indexOf(k) >= 0)) {
        const cashMethod = methods.find(m => m.groupType === 'cash');
        if (cashMethod && actualsById[cashMethod.id] == null) actualsById[cashMethod.id] = amount;
      }
    });

    // ── 3. Cash from denominations overrides any explicit 'cash' actual ──
    //   (the cashier counted real notes; that's authoritative)
    if (cashCounted > 0) {
      const cashMethod = methods.find(m => m.groupType === 'cash');
      if (cashMethod) actualsById[cashMethod.id] = cashCounted;
    }

    // ── 4. Compute totals + variance ──
    let actualTotal = 0;
    Object.keys(actualsById).forEach(k => { actualTotal += actualsById[k]; });
    const variance = actualTotal - expectedTotal;

    // ── 5. Build per-method breakdown (saved + returned) ──
    const breakdown = methods.map(m => ({
      id: m.id,
      name: m.name,
      nameAr: m.nameAr,
      groupType: m.groupType,
      expected: expectedById[m.id] || 0,
      actual: actualsById[m.id] || 0,
      variance: (actualsById[m.id] || 0) - (expectedById[m.id] || 0)
    }));

    // ── 6. Persist denominations ──
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

    // ── 7. Compose payment_totals_json ──
    //   Stored shape (V5.7.17+ canonical):  { expectedById, actualsById, breakdown }
    //   Plus legacy aliases (expected, actuals) so older client builds still work.
    const legacyExpected = {};
    const legacyActuals  = {};
    methods.forEach(m => {
      const nameKey = _normPM(m.name) || _normPM(m.nameAr) || String(m.id);
      legacyExpected[nameKey] = expectedById[m.id] || 0;
      legacyActuals[nameKey]  = actualsById[m.id] || 0;
    });

    // ── V5.7.19 — properly compute per-group totals so the admin shifts
    //   list (which still reads diff_cash/diff_card/diff_kita columns)
    //   shows accurate per-group variance, not all-zeros. Without this,
    //   the user could only see the NET diff and couldn't tell that a
    //   "+31 net" was actually "+31 cash surplus AND -31 mada deficit".
    const cashMethods = methods.filter(m => (m.groupType || '').toLowerCase() === 'cash');
    const cardMethods = methods.filter(m => {
      const gt = (m.groupType || '').toLowerCase();
      return gt === 'electronic' || gt === 'card';
    });
    const kitaMethods = methods.filter(m => {
      const gt = (m.groupType || '').toLowerCase();
      return gt === 'voucher' || _normPM(m.name) === 'kita';
    });
    const sumExp = arr => arr.reduce((s, m) => s + (expectedById[m.id] || 0), 0);
    const sumAct = arr => arr.reduce((s, m) => s + (actualsById[m.id]   || 0), 0);
    const cashExpected = sumExp(cashMethods);
    const cardExpected = sumExp(cardMethods);
    const kitaExpected = sumExp(kitaMethods);
    // Cash actual: prefer counted denominations (authoritative); fall back to method actuals
    const cashActual   = cashCounted > 0 ? cashCounted : sumAct(cashMethods);
    const cardActual   = sumAct(cardMethods);
    const kitaActual   = sumAct(kitaMethods);
    const diffCash = cashActual - cashExpected;
    const diffCard = cardActual - cardExpected;
    const diffKita = kitaActual - kitaExpected;

    const paymentTotalsJson = JSON.stringify({
      version: 'v5.7.19',
      expectedById, actualsById, breakdown,
      // legacy aliases — older clients read these
      expected: legacyExpected, actuals: legacyActuals
    });

    // ── 8. Update the shift row (now writes ALL legacy per-group columns) ──
    await db.query(
      `UPDATE shifts SET
         end_time = ?, status = 'closed',
         opening_float = ?, expected_total = ?, actual_total = ?, variance_total = ?,
         payment_totals_json = ?, denominations_json = ?, cashier_notes = ?,
         total_theoretical = ?,
         theoretical_cash = ?, theoretical_card = ?, theoretical_kita = ?,
         actual_cash = ?,      actual_card = ?,      actual_kita = ?,
         diff_cash = ?,        diff_card = ?,        diff_kita = ?
       WHERE id = ?`,
      [
        now,
        Number(openingFloat || 0), expectedTotal, actualTotal, variance,
        paymentTotalsJson, JSON.stringify(denomList), notes || '',
        expectedTotal,
        cashExpected, cardExpected, kitaExpected,
        cashActual,   cardActual,   kitaActual,
        diffCash,     diffCard,     diffKita,
        shiftId
      ]
    );

    res.json({
      success: true,
      shiftId,
      expected: legacyExpected, actuals: legacyActuals,
      expectedById, actualsById, breakdown,
      expectedTotal, actualTotal, variance,
      cashCounted, denominations: denomList,
      orderCount: agg.orderCount,
      soldItems: agg.soldItems,
      methods: agg.methods
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Closing data v3 — returns expected totals per dynamic payment method
// V5.7.14 — uses the same robust matcher as /closing-data (Arabic
// normalization + alias fallback + unmatched bucket).
router.get('/closing-data-v3/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // Pull all enabled methods so the cashier sees the full reconciliation grid
    const [methods] = await db.query(
      "SELECT id, name, name_ar, icon, color, group_type FROM payment_methods WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
    );
    const [sales] = await db.query('SELECT payment_method, total_final FROM sales WHERE shift_id = ?', [shiftId]);

    function norm(s) {
      return String(s || '').toLowerCase()
        .replace(/[ً-ْ]/g, '')
        .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
    }
    const exactLookup = {};
    const aliasLookup = {};
    const ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
    const CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
    const KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

    methods.forEach(m => {
      [norm(m.name), norm(m.name_ar), String(m.id)].forEach(k => {
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
      String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = norm(p);
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
    });
    methods.forEach(m => {
      let aliases = [];
      const gt = m.group_type;
      if (gt === 'electronic' || gt === 'card') aliases = ELECTRONIC_ALIASES;
      else if (gt === 'cash' || norm(m.name) === 'cash') aliases = CASH_ALIASES;
      else if (gt === 'voucher' || norm(m.name) === 'kita') aliases = KITA_ALIASES;
      aliases.map(norm).forEach(k => {
        if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
      });
    });

    const expectedById = {};
    let expectedTotal = 0;
    let orderCount = sales.length;
    let unmatchedTotal = 0;
    function credit(rawMethod, amount) {
      const key = norm(rawMethod);
      const m = exactLookup[key] || aliasLookup[key];
      if (m) expectedById[m.id] = (expectedById[m.id] || 0) + amount;
      else   unmatchedTotal += amount;
      expectedTotal += amount;
    }
    for (const s of sales) {
      const total = Number(s.total_final) || 0;
      const pmRaw = s.payment_method || 'cash';
      if (String(pmRaw).includes('/') && String(pmRaw).includes(':')) {
        for (const part of String(pmRaw).split('/')) {
          const [m, a] = part.split(':');
          credit(m, Number(a) || 0);
        }
      } else {
        credit(pmRaw, total);
      }
    }

    // Back-compat 'expected' shape — keyed by lowercased name
    const expected = {};
    methods.forEach(m => { expected[(m.name || '').toLowerCase()] = expectedById[m.id] || 0; });

    res.json({
      methods: methods.map(m => ({
        id: m.id, name: m.name, nameAr: m.name_ar, icon: m.icon, color: m.color,
        groupType: m.group_type,
        expectedAmount: expectedById[m.id] || 0
      })),
      expected, expectedTotal, orderCount, unmatchedTotal
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// V5.7.17 — Full shift report endpoint. ONE round-trip returns:
//   shift meta + cashier name + branch + saved actuals (parsed) +
//   live aggregation (items, methods, expected) + denominations.
//   Used by the new thermal-printer report on close + reprint.
router.get('/:shiftId/full-report', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // 1. Shift row
    const [shifts] = await db.query('SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shifts.length) return res.status(404).json({ error: 'Shift not found' });
    const s = shifts[0];

    // 2. Cashier display name from user_meta
    let cashierName = s.username || '';
    let cashierEmpNo = '';
    try {
      const [meta] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (meta.length && meta[0].setting_value) {
        const map = JSON.parse(meta[0].setting_value || '{}');
        const me = map[s.username] || {};
        if (me.name)  cashierName  = me.name;
        if (me.empNo) cashierEmpNo = me.empNo;
      }
    } catch (_) {}

    // 3. Branch info (per V5.7.9 receipt extension)
    let branchName = '', branchAddress = '', branchCompanyName = '';
    try {
      let branchId = s.branch_id;
      if (!branchId) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [s.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName        = br[0].name || '';
          branchAddress     = br[0].location || '';
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) {}

    // 4. Company info from settings
    let companyName = 'Moroccan Taste', taxNumber = '', currency = 'SAR';
    let companyPhone = '', companyEmail = '', companyLogo = '';
    try {
      const [setRows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyPhone','CompanyEmail','logo')"
      );
      const map = {};
      setRows.forEach(r => { map[r.setting_key] = r.setting_value; });
      companyName  = map.CompanyName  || companyName;
      taxNumber    = map.TaxNumber    || '';
      currency     = map.Currency     || 'SAR';
      companyPhone = map.CompanyPhone || '';
      companyEmail = map.CompanyEmail || '';
      companyLogo  = map.logo         || '';
    } catch (_) {}

    // 5. Live aggregation (items + methods + expected)
    const agg = await aggregateShiftPayments(shiftId);

    // 6. Saved actuals (parsed)
    let savedActuals = {};
    let savedExpected = {};
    let savedBreakdown = null;
    try {
      if (s.payment_totals_json) {
        const parsed = typeof s.payment_totals_json === 'string'
          ? JSON.parse(s.payment_totals_json) : s.payment_totals_json;
        if (parsed) {
          savedActuals   = parsed.actualsById || parsed.actuals || {};
          savedExpected  = parsed.expectedById || parsed.expected || {};
          savedBreakdown = parsed.breakdown || null;
        }
      }
    } catch (_) {}

    // 7. Build a per-method actual-vs-expected table that PREFERS the saved
    //    breakdown (what the cashier confirmed at close) and falls back to
    //    re-aggregation if the saved data is missing/old.
    const methodsTable = agg.methods.map(m => {
      let actual = null;
      // 1. Try saved by id
      if (savedBreakdown) {
        const b = savedBreakdown.find(x => String(x.id) === String(m.id));
        if (b) actual = Number(b.actual) || 0;
      }
      // 2. Try savedActuals by id
      if (actual == null && savedActuals[m.id] != null)            actual = Number(savedActuals[m.id]) || 0;
      if (actual == null && savedActuals[String(m.id)] != null)    actual = Number(savedActuals[String(m.id)]) || 0;
      // 3. Try savedActuals by name
      if (actual == null) {
        const k = _normPM(m.name);
        if (savedActuals[k] != null) actual = Number(savedActuals[k]) || 0;
      }
      // 4. Legacy fields
      if (actual == null) {
        if (m.groupType === 'cash')                                          actual = Number(s.actual_cash) || 0;
        else if (m.groupType === 'electronic' || m.groupType === 'card')    actual = Number(s.actual_card) || 0;
        else if (m.groupType === 'voucher' || _normPM(m.name) === 'kita')   actual = Number(s.actual_kita) || 0;
        else                                                                 actual = 0;
      }
      const expected = m.expectedAmount;
      return {
        id: m.id, name: m.name, nameAr: m.nameAr,
        icon: m.icon, color: m.color, groupType: m.groupType,
        expected, actual, variance: actual - expected, count: m.count
      };
    });

    // 8. Denominations
    let denominations = [];
    try {
      const [dr] = await db.query(
        'SELECT denomination, kind, count FROM shift_close_denominations WHERE shift_id = ? ORDER BY denomination DESC',
        [shiftId]
      );
      denominations = dr.map(d => ({
        value: Number(d.denomination), kind: d.kind, count: Number(d.count)
      }));
    } catch (_) {
      // Fallback to denominations_json
      try {
        if (s.denominations_json) denominations = JSON.parse(s.denominations_json);
      } catch (_) {}
    }

    const totalActual   = methodsTable.reduce((sum, m) => sum + m.actual,   0);
    const totalExpected = methodsTable.reduce((sum, m) => sum + m.expected, 0);
    const totalVariance = totalActual - totalExpected;

    res.json({
      shiftId: s.id,
      status: s.status,
      cashier: { username: s.username, name: cashierName, empNo: cashierEmpNo },
      branch: { name: branchName, address: branchAddress, companyName: branchCompanyName },
      company: {
        name: companyName, nameAr: 'المذاق المغربي',
        taxNumber, currency, phone: companyPhone, email: companyEmail, logo: companyLogo
      },
      times: {
        start: s.start_time, end: s.end_time,
        durationMs: (s.end_time && s.start_time) ? (new Date(s.end_time) - new Date(s.start_time)) : null
      },
      financials: {
        openingFloat: Number(s.opening_float || 0),
        expectedTotal: totalExpected,
        actualTotal:   totalActual,
        variance:      totalVariance,
        unmatched:     agg.unmatchedTotal
      },
      methods: methodsTable,
      soldItems: agg.soldItems,
      denominations,
      orderCount: agg.orderCount,
      itemsCount: agg.soldItems.reduce((s, i) => s + (Number(i.qty) || 0), 0),
      notes: s.cashier_notes || '',
      // Diagnostics for the rare cases when aggregation skips a sale
      unmatchedDetails: agg.unmatchedDetails
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// V5.7.19 — Thermal-printer-friendly HTML page for a shift report.
//   Wired to the admin shifts list "🖨 طباعة" button: opens in a new tab,
//   auto-prints, sized for 80mm thermal paper but degrades cleanly on A4.
//   Uses the SAME data source as /full-report (single round-trip).
router.get('/:shiftId/full-report-print', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // Re-use the JSON endpoint logic by hitting it internally
    const reqStub = { params: { shiftId } };
    let payload = null;
    const resStub = {
      json: function(data) { payload = data; return this; },
      status: function() { return this; }
    };
    // Call the handler we registered earlier — find it by hand-walking the stack
    // (we can't do internal redirect, so re-execute the data-build inline)
    const [shifts] = await db.query('SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shifts.length) return res.status(404).send('Shift not found');
    const s = shifts[0];
    let cashierName = s.username || '', cashierEmpNo = '';
    try {
      const [meta] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (meta.length && meta[0].setting_value) {
        const map = JSON.parse(meta[0].setting_value || '{}');
        const me = map[s.username] || {};
        if (me.name)  cashierName  = me.name;
        if (me.empNo) cashierEmpNo = me.empNo;
      }
    } catch (_) {}
    let branchName = '', branchAddress = '', branchCompanyName = '';
    try {
      let branchId = s.branch_id;
      if (!branchId) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [s.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName = br[0].name || '';
          branchAddress = br[0].location || '';
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) {}
    let companyName = 'Moroccan Taste', taxNumber = '', currency = 'SAR';
    let companyPhone = '', companyEmail = '', companyLogo = '';
    try {
      const [setRows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyPhone','CompanyEmail','logo')"
      );
      const map = {};
      setRows.forEach(r => { map[r.setting_key] = r.setting_value; });
      companyName  = map.CompanyName  || companyName;
      taxNumber    = map.TaxNumber    || '';
      currency     = map.Currency     || 'SAR';
      companyPhone = map.CompanyPhone || '';
      companyEmail = map.CompanyEmail || '';
      companyLogo  = map.logo         || '';
    } catch (_) {}

    const agg = await aggregateShiftPayments(shiftId);
    let savedActuals = {}, savedBreakdown = null;
    try {
      if (s.payment_totals_json) {
        const parsed = typeof s.payment_totals_json === 'string'
          ? JSON.parse(s.payment_totals_json) : s.payment_totals_json;
        if (parsed) {
          savedActuals   = parsed.actualsById || parsed.actuals || {};
          savedBreakdown = parsed.breakdown || null;
        }
      }
    } catch (_) {}
    const norm = _normPM;
    const methodsTable = agg.methods.map(m => {
      let actual = null;
      if (savedBreakdown) {
        const b = savedBreakdown.find(x => String(x.id) === String(m.id));
        if (b) actual = Number(b.actual) || 0;
      }
      if (actual == null && savedActuals[m.id] != null)         actual = Number(savedActuals[m.id]) || 0;
      if (actual == null && savedActuals[String(m.id)] != null) actual = Number(savedActuals[String(m.id)]) || 0;
      if (actual == null) {
        const k = norm(m.name);
        if (savedActuals[k] != null) actual = Number(savedActuals[k]) || 0;
      }
      if (actual == null) {
        if (m.groupType === 'cash')                                          actual = Number(s.actual_cash) || 0;
        else if (m.groupType === 'electronic' || m.groupType === 'card')    actual = Number(s.actual_card) || 0;
        else if (m.groupType === 'voucher' || norm(m.name) === 'kita')      actual = Number(s.actual_kita) || 0;
        else                                                                 actual = 0;
      }
      return { id: m.id, name: m.name, nameAr: m.nameAr, icon: m.icon, color: m.color,
               groupType: m.groupType, expected: m.expectedAmount,
               actual, variance: actual - m.expectedAmount, count: m.count };
    });
    let denominations = [];
    try {
      const [dr] = await db.query(
        'SELECT denomination, kind, count FROM shift_close_denominations WHERE shift_id = ? ORDER BY denomination DESC',
        [shiftId]
      );
      denominations = dr.map(d => ({ value: Number(d.denomination), kind: d.kind, count: Number(d.count) }));
    } catch (_) {
      try { if (s.denominations_json) denominations = JSON.parse(s.denominations_json); } catch (_) {}
    }
    const totalActual   = methodsTable.reduce((sum, m) => sum + m.actual,   0);
    const totalExpected = methodsTable.reduce((sum, m) => sum + m.expected, 0);
    const totalVariance = totalActual - totalExpected;

    // Render the thermal HTML inline (mirror of POS-side printShiftThermalReport)
    const fmt = v => Number(v || 0).toFixed(2);
    const fmtDt = v => { try { return new Date(v).toLocaleString('ar-SA'); } catch(e) { return v || '—'; } };
    const fmtDur = ms => {
      if (!ms || ms < 0) return '—';
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      return (h > 0 ? h + 'س ' : '') + m + 'د';
    };
    const durationMs = (s.end_time && s.start_time) ? (new Date(s.end_time) - new Date(s.start_time)) : null;
    const itemsCount = agg.soldItems.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
    const denomsFiltered = denominations.filter(x => Number(x.count) > 0).sort((a, b) => Number(b.value) - Number(a.value));
    const sumDenoms = denomsFiltered.reduce((sum, x) => sum + Number(x.value) * Number(x.count), 0);

    function row(label, value, opts = {}) {
      return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;${opts.border?'border-bottom:1px dashed #999;':''}">
                <span style="color:#000;${opts.bold?'font-weight:700;':''}">${label}</span>
                <span style="color:#000;font-family:monospace;${opts.bold?'font-weight:800;':''}">${value}</span>
              </div>`;
    }

    const headerHtml =
      (companyLogo ? `<div style="text-align:center;margin-bottom:6px;"><img src="${companyLogo}" style="max-width:90px;max-height:90px;object-fit:contain;"></div>` : '') +
      `<div style="text-align:center;font-size:13px;font-weight:700;direction:rtl;margin-bottom:1px;">المذاق المغربي</div>` +
      `<div style="text-align:center;font-size:18px;font-weight:900;direction:ltr;margin-bottom:${branchCompanyName?'2':'6'}px;">${companyName}</div>` +
      (branchCompanyName ? `<div style="text-align:center;font-size:12px;font-weight:700;color:#000;direction:rtl;margin-bottom:6px;border-bottom:1px solid #d4d4d4;padding-bottom:6px;">${branchCompanyName}</div>` : '') +
      `<div style="text-align:center;font-size:11px;direction:rtl;margin-bottom:2px;">تقرير إقفال الوردية</div>` +
      `<div style="text-align:center;font-size:10px;color:#444;margin-bottom:6px;">SHIFT CLOSING REPORT</div>` +
      (taxNumber ? `<div style="text-align:center;font-size:10px;font-family:monospace;color:#444;margin-bottom:4px;">${taxNumber}</div>` : '') +
      (branchName ? `<div style="text-align:center;font-size:11px;font-weight:700;direction:ltr;">${branchName.toUpperCase()}</div>` : '') +
      (branchAddress ? `<div style="text-align:center;font-size:9px;color:#666;direction:rtl;margin-bottom:4px;">${branchAddress}</div>` : '');

    const metaHtml = `<div style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin:8px 0;">
      ${row('رقم الوردية', s.id, { bold: true })}
      ${row('الكاشير', `${cashierName}${cashierEmpNo && cashierEmpNo !== cashierName ? ' (' + cashierEmpNo + ')' : ''}`, { bold: true })}
      ${row('وقت الفتح', fmtDt(s.start_time))}
      ${row('وقت الإغلاق', fmtDt(s.end_time))}
      ${row('مدة الوردية', fmtDur(durationMs))}
      ${row('عدد الفواتير', String(agg.orderCount || 0), { bold: true })}
      ${row('عدد الأصناف', String(itemsCount), { bold: true })}
    </div>`;

    let itemsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">الأصناف المباعة | ITEMS SOLD</div>`;
    if (!agg.soldItems.length) itemsHtml += `<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لا توجد أصناف —</div>`;
    else {
      itemsHtml += `<table style="width:100%;border-collapse:collapse;font-size:10.5px;">
        <thead><tr style="border-bottom:1px solid #000;">
          <th style="text-align:right;padding:3px 0;font-size:10px;">الصنف</th>
          <th style="text-align:center;padding:3px 0;font-size:10px;">الكمية</th>
          <th style="text-align:center;padding:3px 0;font-size:10px;">السعر</th>
          <th style="text-align:left;padding:3px 0;font-size:10px;">الإجمالي</th>
        </tr></thead><tbody>`;
      agg.soldItems.forEach(it => {
        itemsHtml += `<tr>
          <td style="padding:2px 0;">${it.name || '—'}</td>
          <td style="text-align:center;padding:2px 0;">${Number(it.qty) || 0}</td>
          <td style="text-align:center;padding:2px 0;font-family:monospace;">${fmt(it.price)}</td>
          <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:700;">${fmt(it.total)}</td>
        </tr>`;
      });
      itemsHtml += `</tbody></table>`;
    }

    let denomsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">فئات النقد | CASH BREAKDOWN</div>`;
    if (!denomsFiltered.length) denomsHtml += `<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لم يُسجَّل نقد —</div>`;
    else {
      denomsHtml += `<table style="width:100%;border-collapse:collapse;font-size:10.5px;">`;
      denomsFiltered.forEach(x => {
        const subtotal = Number(x.value) * Number(x.count);
        const faceLabel = Number(x.value) < 1 ? `${Number(x.value) * 100} هـ` : `${Number(x.value)} SAR`;
        denomsHtml += `<tr>
          <td style="padding:2px 0;font-weight:700;">${faceLabel}</td>
          <td style="text-align:center;padding:2px 0;">×</td>
          <td style="text-align:center;padding:2px 0;font-weight:700;">${Number(x.count)}</td>
          <td style="text-align:center;padding:2px 0;">=</td>
          <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">${fmt(subtotal)}</td>
        </tr>`;
      });
      denomsHtml += `</table>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;font-size:11px;font-weight:800;display:flex;justify-content:space-between;">
          <span>إجمالي النقد المعدود:</span>
          <span style="font-family:monospace;">${fmt(sumDenoms)} ${currency}</span>
        </div>`;
    }

    let methodsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">تسوية طرق الدفع | PAYMENT RECONCILIATION</div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
        <thead><tr style="border-bottom:1px solid #000;">
          <th style="text-align:right;padding:3px 0;font-size:9.5px;">الطريقة</th>
          <th style="text-align:center;padding:3px 0;font-size:9.5px;">المتوقع</th>
          <th style="text-align:center;padding:3px 0;font-size:9.5px;">الفعلي</th>
          <th style="text-align:left;padding:3px 0;font-size:9.5px;">الفرق</th>
        </tr></thead><tbody>`;
    methodsTable.forEach(m => {
      const diffPrefix = m.variance > 0 ? '+' : '';
      methodsHtml += `<tr>
        <td style="padding:2px 0;font-weight:700;">${m.nameAr || m.name}</td>
        <td style="text-align:center;padding:2px 0;font-family:monospace;">${fmt(m.expected)}</td>
        <td style="text-align:center;padding:2px 0;font-family:monospace;font-weight:700;">${fmt(m.actual)}</td>
        <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">${diffPrefix}${fmt(m.variance)}</td>
      </tr>`;
    });
    methodsHtml += `<tr style="border-top:1px solid #000;font-weight:900;">
        <td style="padding:3px 0;">الإجمالي</td>
        <td style="text-align:center;padding:3px 0;font-family:monospace;">${fmt(totalExpected)}</td>
        <td style="text-align:center;padding:3px 0;font-family:monospace;">${fmt(totalActual)}</td>
        <td style="text-align:left;padding:3px 0;font-family:monospace;">${totalVariance > 0 ? '+' : ''}${fmt(totalVariance)}</td>
      </tr></tbody></table>`;

    // V5.7.21 — offsetting-variances warning REMOVED per user direction:
    //   when net = 0, the report reads "balanced" regardless of
    //   per-method offsetting diffs. Per-method numbers are still in
    //   the table above for transparency.

    const varianceLabel = Math.abs(totalVariance) < 0.01 ? 'متطابق ✓' : (totalVariance < 0 ? 'عجز' : 'زيادة');
    const summaryHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">ملخص الإغلاق | SUMMARY</div>
      <div style="border:1.5px solid #000;padding:6px 8px;margin:4px 0;">
        ${row('الرصيد الافتتاحي', `${fmt(s.opening_float)} ${currency}`)}
        ${row('إجمالي المبيعات (متوقع)', `${fmt(totalExpected)} ${currency}`, { bold: true })}
        ${row('إجمالي الجرد الفعلي', `${fmt(totalActual)} ${currency}`, { bold: true })}
        ${row(`الفرق (${varianceLabel})`, `${totalVariance > 0 ? '+' : ''}${fmt(totalVariance)} ${currency}`, { bold: true })}
      </div>`;

    const notesHtml = s.cashier_notes
      ? `<div style="margin-top:8px;padding:6px;border:1px dashed #999;font-size:10px;direction:rtl;">
           <div style="font-weight:700;margin-bottom:3px;">📝 ملاحظات:</div>
           <div style="white-space:pre-wrap;">${s.cashier_notes}</div>
         </div>`
      : '';

    const sigHtml = `<div style="margin-top:12px;display:flex;gap:6px;justify-content:space-between;">
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">المستلم</div></div>
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">${cashierName || s.username}</div></div>
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">الإدارة</div></div>
    </div>`;

    const footerHtml = `<div style="text-align:center;margin-top:8px;font-size:9px;color:#444;border-top:1px dashed #000;padding-top:4px;">
      وثيقة موثّقة آلياً — Moroccan Taste POS<br>
      طُبع: ${fmtDt(new Date())}
      ${companyPhone ? `<br>Tel: ${companyPhone}` : ''}
      ${companyEmail ? `<br>Email: ${companyEmail}` : ''}
    </div>`;

    // V5.7.21 — read user's language from query param OR cookie OR
    //   fallback to ar. Embed the translator so English mode flips
    //   labels before window.print() runs.
    const userLang = (req.query.lang === 'en' || req.query.lang === 'ar') ? req.query.lang : 'ar';
    const dirAttr = userLang === 'en' ? 'ltr' : 'rtl';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="${userLang}" dir="${dirAttr}"><head><meta charset="UTF-8">
      <title>Shift Report — ${s.id}</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        body{font-family:"Helvetica Neue",Arial,"Segoe UI",sans-serif;padding:10px;width:300px;margin:0 auto;font-size:12px;color:#000;background:#fff;}
        table{border-collapse:collapse;}
        @media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}
      </style>
      <script src="/shared/dynamic-i18n.js?v=2"></script>
      </head><body>
      ${headerHtml}${metaHtml}${itemsHtml}${denomsHtml}${methodsHtml}${summaryHtml}${notesHtml}${sigHtml}${footerHtml}
      <script>(function(){
        try {
          // V5.7.21 — same lang-aware print-trigger as the POS-side window
          var saved = '';
          try { saved = localStorage.getItem('pos_lang') || localStorage.getItem('emp_lang') || ''; } catch(e){}
          var lang = ${JSON.stringify(userLang)} || saved || 'ar';
          if (lang === 'en' && window.DynamicI18N) {
            window.DynamicI18N.translatePage('en').then(function(){
              setTimeout(function(){ window.print(); }, 300);
            }).catch(function(){ setTimeout(function(){ window.print(); }, 500); });
          } else {
            setTimeout(function(){ window.print(); }, 400);
          }
        } catch(e) { setTimeout(function(){ window.print(); }, 400); }
      })();<\/script>
      </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
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
      // V5.7.17 — surface the rich JSONs so the printed report has full data
      paymentTotalsJson: s.payment_totals_json || null,
      denominationsJson: s.denominations_json || null,
      cashierNotes:      s.cashier_notes || '',
      openingFloat:      Number(s.opening_float || 0),
      expectedTotal:     Number(s.expected_total || 0),
      actualTotal:       Number(s.actual_total || 0),
      varianceTotal:     Number(s.variance_total || 0),
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

    // ── 3. SMART MATCHER (V5.7.14 — robust Arabic normalization) ──
    //   Two-tier lookup:
    //     (a) EXACT match on normalized name / name_ar / id  ← strict, wins first
    //     (b) ALIAS match (mada/visa/...) only if no exact match found
    //   Arabic normalization unifies common variant characters that the
    //   user types interchangeably:
    //     ى (U+0649 alif maksura) → ي (U+064A yaa)   (مدى ↔ مدي)
    //     ة (U+0629 taa marbuta)  → ه                 (شبكة ↔ شبكه)
    //     أ إ آ ا → ا                                 (any alif form)
    //     diacritics  ً ٌ ٍ َ ُ ِ ّ ْ → stripped
    //     trailing whitespace + lowercase
    //   This made "مدي 37 sales" + "مدى/شبكة 5 sales" both resolve cleanly
    //   to whichever method the cashier intended (the bug where 32 of 37
    //   Mada sales fell through to "unmatched").
    function norm(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[ً-ْ]/g, '')      // strip diacritics
        .replace(/[أإآا]/g, 'ا')               // unify alif forms
        .replace(/ى/g, 'ي')                   // alif maksura → yaa
        .replace(/ة/g, 'ه')                   // taa marbuta → haa
        .trim();
    }
    const exactLookup = {};   // exact name / name_ar / id keys
    const aliasLookup = {};   // group-based aliases (mada, visa, …)
    const ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
    const CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
    const KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

    function indexMethodExact(m) {
      [norm(m.name), norm(m.name_ar), String(m.id)].forEach(k => {
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
      // Tokens of name_ar split on common separators
      String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = norm(p);
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
    }
    function indexMethodAlias(m) {
      let aliases = [];
      const gt = m.group_type;
      if (gt === 'electronic' || gt === 'card')   aliases = ELECTRONIC_ALIASES;
      else if (gt === 'cash' || norm(m.name) === 'cash') aliases = CASH_ALIASES;
      else if (gt === 'voucher' || norm(m.name) === 'kita') aliases = KITA_ALIASES;
      aliases.map(norm).forEach(k => {
        // Don't overwrite an exact match with an alias
        if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
      });
    }
    // Pass 1: exact keys for every method (first-seen wins on ties)
    methods.forEach(indexMethodExact);
    // Pass 2: aliases (only fill keys not claimed by exact)
    methods.forEach(indexMethodAlias);
    // Fallback synthetic methods so reports never lose data when no method exists at all
    function ensureSynthetic(syntheticId, name, name_ar, group_type) {
      const aliasKey = norm(name);
      if (exactLookup[aliasKey] || aliasLookup[aliasKey]) return;
      const synth = { id: syntheticId, name, name_ar, group_type, _synthetic: true };
      methods.push(synth);
      indexMethodExact(synth);
      indexMethodAlias(synth);
    }
    ensureSynthetic('_cash',       'Cash',       'نقدي / كاش',  'cash');
    ensureSynthetic('_electronic', 'Card / Mada','شبكة / مدى',  'electronic');
    ensureSynthetic('_kita',       'Kita',       'كيتا / آجل',  'voucher');

    function findMethod(rawKey) {
      // Try exact first, then alias
      return exactLookup[rawKey] || aliasLookup[rawKey] || null;
    }

    // ── 4. Aggregate sale totals per matched method ──
    const expectedById = {}; // method.id → amount
    const countById = {};    // method.id → number of sales attributed
    let expectedTotal = 0;
    let unmatchedTotal = 0;
    const unmatchedDetails = []; // for debugging — methods that didn't resolve
    function credit(rawMethod, amount) {
      const key = norm(rawMethod);
      const m = findMethod(key);
      if (m) {
        expectedById[m.id] = (expectedById[m.id] || 0) + amount;
        countById[m.id]    = (countById[m.id]    || 0) + 1;
      } else {
        unmatchedTotal += amount;
        unmatchedDetails.push({ raw: rawMethod, normalized: key, amount });
      }
      expectedTotal += amount;
    }
    for (const sale of sales) {
      const total = Number(sale.total_final) || 0;
      const pmRaw = sale.payment_method || 'cash';
      if (String(pmRaw).includes('/') && String(pmRaw).includes(':')) {
        // Split-payment syntax: "cash:50/card:30"  (must contain BOTH / and :)
        for (const part of String(pmRaw).split('/')) {
          const [m, a] = part.split(':');
          credit(m, Number(a) || 0);
        }
      } else {
        // Single payment — handles names like "مدى/شبكة" that contain '/'
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

    // V5.7.14 — surface unmatched as its OWN method row so the cashier
    //          immediately sees there's a gap between sales and the report.
    const unmatchedRow = unmatchedTotal > 0 ? [{
      id: '__unmatched',
      name: 'Unmatched',
      nameAr: 'غير مصنّف',
      icon: 'fa-question-circle',
      color: '#f59e0b',
      groupType: 'unmatched',
      expectedAmount: unmatchedTotal,
      count: unmatchedDetails.length,
      _isUnmatched: true,
      // Sample of the raw payment_method strings that fell through (top 5)
      sample: Array.from(new Set(unmatchedDetails.map(d => d.raw))).slice(0, 5)
    }] : [];

    res.json({
      // ── New rich shape ──
      methods: methods
        .filter(m => !m._synthetic || (expectedById[m.id] || 0) > 0)
        .map(m => ({
          id: m.id, name: m.name, nameAr: m.name_ar,
          icon: m.icon || 'fa-money-bill', color: m.color || '#3b82f6',
          groupType: m.group_type,
          expectedAmount: expectedById[m.id] || 0,
          count: countById[m.id] || 0
        }))
        .concat(unmatchedRow),
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
