const router = require('express').Router();
const db = require('../db/connection');
// v7.1 SECURITY — the global /api guard (server.js) blanket-exempts /settings so
// the login page can READ branding (company name/logo) before auth. That left
// every settings WRITE (company info, tax number, payment methods, discounts,
// service fees) fully public. Re-verify the JWT on writes only; GET routes stay
// public so the login/branding flow is unaffected.
const verifyToken = require('./authMiddleware');
// v7.5 SECURITY — settings writes change GL routing, fees, discounts and the
// strings rendered raw in POS/print surfaces. Cashier tokens must not be able
// to touch them: writes are admin/manager only.
const MGR = verifyToken.requireRole('admin', 'manager');
// The canonical-key resolver. Writes fan out to every spelling a reader uses, so
// a value saved here always reaches the receipt/ZATCA path (see lib/settingsKeys).
const { normalizeSettingsWrite } = require('../lib/settingsKeys');
const invoiceIdentity = require('../lib/invoiceIdentity');

// GET /api/settings/invoice-identity?branchId=&brandId=
// The resolved seller block for a scope, WITH the source of every field, so the
// invoice-settings screen can show where each value comes from and whether it is
// editable here or derived from companies/brands/branches.
//
// Explicitly token-gated: server.js exempts the whole /settings prefix from the
// global API guard (so the login page can read branding before auth), which means
// anything added here is public unless it says otherwise. This returns the
// company's tax identity — it is not public.
// Declared BEFORE '/' so it can never be shadowed by a broader matcher.
router.get('/invoice-identity', verifyToken, MGR, async (req, res) => {
  try {
    const scope = { branchId: req.query.branchId || null, brandId: req.query.brandId || null };
    const { identity, sources, receiptSettings } = await invoiceIdentity.resolveIdentity(db, scope);
    const [branches] = await db.query('SELECT id, name FROM branches ORDER BY name').catch(() => [[]]);
    const [brands] = await db.query('SELECT id, name FROM brands ORDER BY name').catch(() => [[]]);
    // The print toggles (settings.ReceiptShowFields): parsed for the editor's
    // switches AND raw so the screen can tell "explicitly configured" apart
    // from "all-true defaults".
    let showFieldsRaw = null;
    try {
      const [sf] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'ReceiptShowFields' LIMIT 1");
      if (sf.length) showFieldsRaw = sf[0].setting_value;
    } catch (_) { /* settings table missing → defaults */ }
    res.json({
      success: true, scope, identity, sources, branches, brands,
      showFields: invoiceIdentity.showFields(showFieldsRaw),
      showFieldsRaw,
      receiptSettings,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/settings/invoice-identity-scope — scoped identity overrides.
//
// The invoice-settings screen previews per-scope but every write used to be
// GLOBAL (PUT /settings). This endpoint edits the ONLY columns resolveIdentity
// actually reads from the scope tables — nothing is invented:
//   branch scope (branches.id):  address            → branches.location
//                                branchCompanyName  → branches.company_name
//   brand scope  (brands.id):    brandName          → brands.name
//                                logo               → brands.logo
// Every other identity field has no scoped column and stays global-only —
// honest, and the screen says so instead of silently disabling.
//
// Same gate as the other identity surfaces: token + admin/manager (the
// /settings prefix is exempt from the global /api guard, so it must be
// explicit here).
const SCOPE_COLUMNS = Object.freeze({
  branch: Object.freeze({ address: 'location', branchCompanyName: 'company_name' }),
  brand: Object.freeze({ brandName: 'name', logo: 'logo' }),
});
// brands.logo is LONGTEXT and carries data-URLs; the screen compresses to
// ≤100KB (≈137K base64 chars). Cap generously above that, not at infinity.
const SCOPE_VALUE_MAX = Object.freeze({ address: 500, branchCompanyName: 200, brandName: 200, logo: 200000 });

router.put('/invoice-identity-scope', verifyToken, MGR, async (req, res) => {
  try {
    const body = req.body || {};
    const branchId = body.branchId ? String(body.branchId).trim() : null;
    const brandId = body.brandId ? String(body.brandId).trim() : null;
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
    if (!fields || !Object.keys(fields).length) {
      return res.status(400).json({ success: false, error: 'fields مطلوب: القيم المراد تخصيصها' });
    }

    // Split the payload into per-table column sets, rejecting anything that is
    // not a genuinely scoped field (a whitelist, so no column name ever comes
    // from the request).
    const updates = { branch: {}, brand: {} };
    for (const [field, raw] of Object.entries(fields)) {
      const scope = SCOPE_COLUMNS.branch[field] ? 'branch' : (SCOPE_COLUMNS.brand[field] ? 'brand' : null);
      if (!scope) {
        return res.status(400).json({ success: false, error: `الحقل "${field}" لا يملك عمودًا على مستوى الفرع/العلامة — يُحفظ من الإعدادات العامة فقط.` });
      }
      const value = String(raw == null ? '' : raw);
      if (value.length > SCOPE_VALUE_MAX[field]) {
        return res.status(400).json({ success: false, error: `قيمة "${field}" أطول من الحد المسموح (${SCOPE_VALUE_MAX[field]}).` });
      }
      updates[scope][field] = value;
    }
    if (Object.keys(updates.branch).length && !branchId) {
      return res.status(400).json({ success: false, error: 'تخصيص حقول الفرع يتطلب branchId.' });
    }
    if (Object.keys(updates.brand).length && !brandId) {
      return res.status(400).json({ success: false, error: 'تخصيص حقول العلامة التجارية يتطلب brandId.' });
    }
    // brands.name is the brand's actual NOT NULL name (the brands screen lists
    // it) — blanking it via this side door would break that screen.
    if ('brandName' in updates.brand && !updates.brand.brandName.trim()) {
      return res.status(400).json({ success: false, error: 'اسم العلامة التجارية لا يمكن أن يكون فارغًا.' });
    }

    const applied = [];
    for (const [scope, table, id] of [['branch', 'branches', branchId], ['brand', 'brands', brandId]]) {
      const cols = Object.entries(updates[scope]);
      if (!cols.length) continue;
      // Existence check up-front: UPDATE affectedRows can be 0 for a same-value
      // write, so it cannot distinguish "row missing" from "already that value".
      const [row] = await db.query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
      if (!row.length) {
        return res.status(404).json({ success: false, error: `${scope === 'branch' ? 'الفرع' : 'العلامة التجارية'} غير موجود: ${id}` });
      }
      await db.query(
        `UPDATE ${table} SET ${cols.map(([f]) => `${SCOPE_COLUMNS[scope][f]} = ?`).join(', ')} WHERE id = ?`,
        cols.map(([, v]) => v).concat([id])
      );
      applied.push({ scope, id, fields: cols.map(([f]) => f) });
    }

    res.json({ success: true, applied });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all settings
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT setting_key, setting_value FROM settings');
    const settings = {};
    rows.forEach(s => { settings[s.setting_key] = s.setting_value; });
    res.json(settings);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Update settings
router.put('/', verifyToken, MGR, async (req, res) => {
  try {
    // Was: write each key verbatim. camelCase payloads from the React admin
    // landed in rows no reader looks at, so company/tax edits never reached a
    // printed invoice. normalizeSettingsWrite resolves each key to its canonical
    // spelling, coerces booleans to '1'/'0', and keeps aliases in sync.
    for (const [key, value] of normalizeSettingsWrite(req.body)) {
      await db.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, value, value]
      );
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get payment methods
router.get('/payment-methods', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_methods ORDER BY sort_order');
    res.json(rows.map(p => ({
      ID: p.id, Name: p.name, NameAR: p.name_ar, Icon: p.icon,
      IsActive: p.is_active, ServiceFeeRate: Number(p.service_fee_rate), SortOrder: p.sort_order
    })));
  } catch (e) {
    res.json([]);
  }
});

// Save payment methods
router.put('/payment-methods', verifyToken, MGR, async (req, res) => {
  try {
    const { methods } = req.body;
    if (!methods || !methods.length) return res.json({ success: false, error: 'No methods provided' });

    for (const m of methods) {
      if (m.ID) {
        await db.query(
          'UPDATE payment_methods SET name=?, name_ar=?, icon=?, is_active=?, service_fee_rate=?, sort_order=? WHERE id=?',
          [m.Name, m.NameAR || '', m.Icon || 'fa-money-bill', m.IsActive !== false, m.ServiceFeeRate || 0, m.SortOrder || 0, m.ID]
        );
      } else {
        await db.query(
          'INSERT INTO payment_methods (name, name_ar, icon, is_active, service_fee_rate, sort_order) VALUES (?,?,?,?,?,?)',
          [m.Name, m.NameAR || '', m.Icon || 'fa-money-bill', m.IsActive !== false, m.ServiceFeeRate || 0, m.SortOrder || 0]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete a single payment method
router.delete('/payment-methods/:id', verifyToken, MGR, async (req, res) => {
  try {
    await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get discounts
router.get('/discounts', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'discounts'");
    if (rows.length && rows[0].setting_value) {
      res.json(JSON.parse(rows[0].setting_value));
    } else {
      res.json([]);
    }
  } catch (e) {
    res.json([]);
  }
});

// Recompute all menu costs from current ingredient prices
router.post('/recompute-costs', verifyToken, MGR, async (req, res) => {
  try {
    const { recomputeAllMenuCosts } = require('./pricing-utils');
    const count = await recomputeAllMenuCosts();
    res.json({ success: true, recomputed: count });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════
// ADVANCED DISCOUNTS (v2)
// ═══════════════════════════════════════

router.get('/discounts-v2', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM discounts_v2 ORDER BY display_order, name');
    res.json(rows.map(d => ({
      id: d.id, name: d.name, type: d.type, value: Number(d.value), maxAmount: Number(d.max_amount),
      minOrder: Number(d.min_order), requireApproval: !!d.require_approval, requireCode: !!d.require_code,
      code: d.code, enabled: !!d.enabled, displayOrder: d.display_order,
      validFrom: d.valid_from, validTo: d.valid_to, applyOn: d.apply_on, color: d.color
    })));
  } catch(e) { res.json([]); }
});

router.post('/discounts-v2', verifyToken, MGR, async (req, res) => {
  try {
    const { id, name, type, value, maxAmount, minOrder, requireApproval, requireCode, code, enabled, displayOrder, validFrom, validTo, applyOn, color } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(
        `UPDATE discounts_v2 SET name=?, type=?, value=?, max_amount=?, min_order=?, require_approval=?, require_code=?, code=?, enabled=?, display_order=?, valid_from=?, valid_to=?, apply_on=?, color=? WHERE id=?`,
        [name, type||'percentage', value||0, maxAmount||0, minOrder||0, requireApproval?1:0, requireCode?1:0, code||'', enabled!==false?1:0, displayOrder||0, validFrom||null, validTo||null, applyOn||'invoice', color||'#8b5cf6', id]
      );
      return res.json({ success: true, id });
    }
    const newId = 'DISC-' + Date.now();
    await db.query(
      `INSERT INTO discounts_v2 (id, name, type, value, max_amount, min_order, require_approval, require_code, code, enabled, display_order, valid_from, valid_to, apply_on, color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, type||'percentage', value||0, maxAmount||0, minOrder||0, requireApproval?1:0, requireCode?1:0, code||'', enabled!==false?1:0, displayOrder||0, validFrom||null, validTo||null, applyOn||'invoice', color||'#8b5cf6']
    );
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/discounts-v2/:id', verifyToken, MGR, async (req, res) => {
  try {
    await db.query('DELETE FROM branch_discounts WHERE discount_id = ?', [req.params.id]);
    await db.query('DELETE FROM discounts_v2 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Enhanced payment methods with new fields (v3 — group, GL, cost center, fees, advanced flags)
router.get('/payment-methods-full', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_methods ORDER BY sort_order, name');
    res.json(rows.map(p => ({
      id: p.id, name: p.name, nameAr: p.name_ar, icon: p.icon, isActive: !!p.is_active,
      serviceFeeRate: Number(p.service_fee_rate||0), sortOrder: p.sort_order,
      type: p.type||'standard', requireReference: !!p.require_reference,
      requireTransactionNumber: !!p.require_transaction_number, requireTerminal: !!p.require_terminal,
      allowRefund: p.allow_refund!==0, allowCancel: p.allow_cancel!==0, color: p.color||'#3b82f6',
      // New v3 fields
      groupType: p.group_type||'cash',
      glAccountId: p.gl_account_id||null,
      costCenterId: p.cost_center_id||null,
      allowManualTotal: !!p.allow_manual_total,
      showInShiftClose: p.show_in_shift_close!==0,
      showInReports: p.show_in_reports!==0,
      serviceFeeType: p.service_fee_type||'none',
      serviceFeeValue: Number(p.service_fee_value||0),
      description: p.description||''
    })));
  } catch(e) { res.json([]); }
});

router.post('/payment-methods-full', verifyToken, MGR, async (req, res) => {
  try {
    const {
      id, name, nameAr, icon, isActive, serviceFeeRate, sortOrder, type,
      requireReference, requireTransactionNumber, requireTerminal,
      allowRefund, allowCancel, color,
      groupType, glAccountId, costCenterId, allowManualTotal, showInShiftClose, showInReports,
      serviceFeeType, serviceFeeValue, description
    } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    const params = [
      name, nameAr||name, icon||'fa-money-bill', isActive!==false?1:0,
      serviceFeeRate||0, sortOrder||0, type||'standard',
      requireReference?1:0, requireTransactionNumber?1:0, requireTerminal?1:0,
      allowRefund!==false?1:0, allowCancel!==false?1:0, color||'#3b82f6',
      groupType||'cash', glAccountId||null, costCenterId||null,
      allowManualTotal?1:0, showInShiftClose!==false?1:0, showInReports!==false?1:0,
      serviceFeeType||'none', serviceFeeValue||0, description||''
    ];
    if (id) {
      await db.query(
        `UPDATE payment_methods SET
           name=?, name_ar=?, icon=?, is_active=?, service_fee_rate=?, sort_order=?, type=?,
           require_reference=?, require_transaction_number=?, require_terminal=?,
           allow_refund=?, allow_cancel=?, color=?,
           group_type=?, gl_account_id=?, cost_center_id=?,
           allow_manual_total=?, show_in_shift_close=?, show_in_reports=?,
           service_fee_type=?, service_fee_value=?, description=?
         WHERE id=?`,
        params.concat([id])
      );
      return res.json({ success: true, id });
    }
    // payment_methods.id is INT AUTO_INCREMENT — let MySQL assign the id
    const [result] = await db.query(
      `INSERT INTO payment_methods (
         name, name_ar, icon, is_active, service_fee_rate, sort_order, type,
         require_reference, require_transaction_number, require_terminal,
         allow_refund, allow_cancel, color,
         group_type, gl_account_id, cost_center_id,
         allow_manual_total, show_in_shift_close, show_in_reports,
         service_fee_type, service_fee_value, description
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params
    );
    res.json({ success: true, id: result.insertId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Single-method delete (v3)
router.delete('/payment-methods-full/:id', verifyToken, MGR, async (req, res) => {
  try {
    await db.query('DELETE FROM branch_payment_methods WHERE payment_method_id = ?', [req.params.id]);
    await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// DISCOUNTS v2 — Enhanced with GL link + scope + permissions
// ═══════════════════════════════════════════════════════════════════
router.get('/discounts-v2-full', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM discounts_v2 ORDER BY display_order, name');
    res.json(rows.map(d => ({
      id: d.id, name: d.name, type: d.type, value: Number(d.value||0),
      maxAmount: Number(d.max_amount||0), minOrder: Number(d.min_order||0),
      requireApproval: !!d.require_approval, requireCode: !!d.require_code,
      code: d.code, enabled: !!d.enabled, displayOrder: d.display_order,
      validFrom: d.valid_from, validTo: d.valid_to, applyOn: d.apply_on, color: d.color||'#8b5cf6',
      // v2 extended fields
      glAccountId: d.gl_account_id||null,
      discountScope: d.discount_scope||'invoice',
      minRole: d.min_role||'cashier',
      maxPerInvoice: Number(d.max_per_invoice||0),
      showInPos: d.show_in_pos!==0,
      icon: d.icon||'fa-tag',
      description: d.description||''
    })));
  } catch(e) { res.json([]); }
});

router.post('/discounts-v2-full', verifyToken, MGR, async (req, res) => {
  try {
    const {
      id, name, type, value, maxAmount, minOrder, requireApproval, requireCode, code,
      enabled, displayOrder, validFrom, validTo, applyOn, color,
      glAccountId, discountScope, minRole, maxPerInvoice, showInPos, icon, description
    } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    const params = [
      name, type||'percentage', value||0, maxAmount||0, minOrder||0,
      requireApproval?1:0, requireCode?1:0, code||'',
      enabled!==false?1:0, displayOrder||0, validFrom||null, validTo||null,
      applyOn||'invoice', color||'#8b5cf6',
      glAccountId||null, discountScope||'invoice', minRole||'cashier',
      maxPerInvoice||0, showInPos!==false?1:0, icon||'fa-tag', description||''
    ];
    if (id) {
      await db.query(
        `UPDATE discounts_v2 SET
           name=?, type=?, value=?, max_amount=?, min_order=?,
           require_approval=?, require_code=?, code=?,
           enabled=?, display_order=?, valid_from=?, valid_to=?,
           apply_on=?, color=?,
           gl_account_id=?, discount_scope=?, min_role=?,
           max_per_invoice=?, show_in_pos=?, icon=?, description=?
         WHERE id=?`,
        params.concat([id])
      );
      return res.json({ success: true, id });
    }
    const newId = 'DISC-' + Date.now();
    await db.query(
      `INSERT INTO discounts_v2 (
         id, name, type, value, max_amount, min_order,
         require_approval, require_code, code,
         enabled, display_order, valid_from, valid_to,
         apply_on, color,
         gl_account_id, discount_scope, min_role,
         max_per_invoice, show_in_pos, icon, description
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId].concat(params)
    );
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
