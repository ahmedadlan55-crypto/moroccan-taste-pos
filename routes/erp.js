const router = require('express').Router();
const db = require('../db/connection');
const { ensureCoreAccounts } = require('../lib/glPosting');

// ─── Dashboard ───

router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Today's sales
    const [salesToday] = await db.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_final),0) as total FROM sales WHERE DATE(order_date) = ?', [today]
    );

    // Today's expenses
    const [expensesToday] = await db.query(
      'SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE DATE(expense_date) = ?', [today]
    );

    // Today's purchases
    const [purchasesToday] = await db.query(
      'SELECT COALESCE(SUM(total_price),0) as total FROM purchases WHERE DATE(purchase_date) = ?', [today]
    );

    // Low stock items
    const [lowStock] = await db.query(
      'SELECT COUNT(*) as count FROM inv_items WHERE stock <= min_stock AND active = 1'
    );

    // Active customers
    const [customerCount] = await db.query('SELECT COUNT(*) as count FROM customers WHERE is_active = 1');

    // Active suppliers
    const [supplierCount] = await db.query('SELECT COUNT(*) as count FROM suppliers WHERE is_active = 1');

    // Open shifts
    const [openShifts] = await db.query('SELECT COUNT(*) as count FROM shifts WHERE status = "OPEN"');

    // Monthly sales (last 30 days)
    const [monthlySales] = await db.query(
      'SELECT COALESCE(SUM(total_final),0) as total FROM sales WHERE order_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );

    // Monthly expenses (last 30 days)
    const [monthlyExpenses] = await db.query(
      'SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );

    res.json({
      salesToday: { count: salesToday[0].count, total: Number(salesToday[0].total) },
      expensesToday: Number(expensesToday[0].total),
      purchasesToday: Number(purchasesToday[0].total),
      lowStockCount: lowStock[0].count,
      customerCount: customerCount[0].count,
      supplierCount: supplierCount[0].count,
      openShifts: openShifts[0].count,
      monthlySales: Number(monthlySales[0].total),
      monthlyExpenses: Number(monthlyExpenses[0].total),
      monthlyProfit: Number(monthlySales[0].total) - Number(monthlyExpenses[0].total)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── Customers ───

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
      customerType: c.customer_type, creditLimit: Number(c.credit_limit),
      balance: Number(c.balance), isActive: c.is_active,
      createdAt: c.created_at, createdBy: c.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/customers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, customerType, creditLimit, username } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM customers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE customers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, customer_type=?, credit_limit=?, updated_by=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           customerType || 'B2C', creditLimit || 0, username || '', id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'CUST-' + Date.now();
    await db.query(
      `INSERT INTO customers (id, name, name_en, vat_number, phone, email, address, city, customer_type, credit_limit, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       customerType || 'B2C', creditLimit || 0, username || '']
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

// ─── Suppliers ───

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

// ─── GL Accounts (Chart of Accounts) ───

router.get('/gl/accounts', async (req, res) => {
  try {
    // v5.10.38 — derive `balance` from posted gl_entries (single source of
    // truth) so the COA tree never shows a "zombie" balance that lacks an
    // actual journal. The stored gl_accounts.balance column is exposed as
    // storedBalance for diagnostics only. movementCount lets the UI hide
    // accounts that have never been touched.
    // v5.10.51 — order by display_order (NULL falls to the bottom),
    // code as tiebreaker. The frontend re-sorts using the same rule.
    const [rows] = await db.query(`
      SELECT a.*,
             (SELECT COUNT(*)
                FROM gl_entries e
                JOIN gl_journals j ON j.id = e.journal_id
               WHERE e.account_id = a.id AND j.status = 'posted') AS movement_count,
             (SELECT IFNULL(SUM(e.debit - e.credit), 0)
                FROM gl_entries e
                JOIN gl_journals j ON j.id = e.journal_id
               WHERE e.account_id = a.id AND j.status = 'posted') AS computed_balance
        FROM gl_accounts a
       ORDER BY COALESCE(a.display_order, 99999), a.code`);
    res.json(rows.map(a => ({
      id: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en,
      type: a.type, parentId: a.parent_id, level: a.level,
      isActive: a.is_active,
      isFolder: !!a.is_folder,
      displayOrder: a.display_order == null ? null : Number(a.display_order),
      balance: Number(a.computed_balance || 0),
      storedBalance: Number(a.balance || 0),
      movementCount: Number(a.movement_count || 0)
    })));
  } catch (e) {
    res.json([]);
  }
});

// v5.10.40 — toggle is_folder on an account. Refuses to demote a folder
// that still has children (data integrity).
router.post('/gl/accounts/:id/folder', async (req, res) => {
  try {
    const { isFolder } = req.body;
    const want = !!isFolder;
    const [rows] = await db.query('SELECT id, code FROM gl_accounts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.json({ success: false, error: 'الحساب غير موجود' });
    // Block demotion of root accounts (codes 1-5) — they must always be folders
    if (!want && ['1','2','3','4','5'].indexOf(rows[0].code) >= 0) {
      return res.json({ success: false, error: 'لا يمكن تحويل حساب رئيسي إلى ورقة' });
    }
    if (!want) {
      const [kids] = await db.query('SELECT id FROM gl_accounts WHERE parent_id = ? LIMIT 1', [req.params.id]);
      if (kids.length) return res.json({ success: false, error: 'لا يمكن إلغاء الفولدر — احذف الأبناء أولاً' });
    }
    await db.query('UPDATE gl_accounts SET is_folder = ? WHERE id = ?', [want ? 1 : 0, req.params.id]);
    res.json({ success: true, id: req.params.id, isFolder: want });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.48 — bulk import COA from an Excel file. Match priority:
//   (1) by internal `id` (column "المعرف (لا تحذف)" in the export) —
//       this is THE way to avoid duplicates when codes change in Excel,
//       and the way structural edits (rename/reparent) actually take
//       effect on the existing row instead of creating a sibling.
//   (2) by `code` if id is missing (legacy / hand-built files).
//   (3) otherwise INSERT new.
//
// Side effects we keep consistent in the same transaction:
//   - When a row's code changes, gl_entries.account_code gets the new
//     code so reports and ledger views don't go stale.
//   - codeMap is updated as we go, so children reparented to a renamed
//     parent resolve to the right id within the same batch.
router.post('/gl/accounts/import', async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, error: 'لا توجد صفوف للاستيراد' });
  }
  let inserted = 0, updated = 0, skipped = 0, codeChanges = 0, parentChanges = 0;
  const errors = [];
  try {
    await db.withTransaction(async (conn) => {
      // v5.10.50 — three indices: id (safest), normalized name (the user's
      // preferred identity), code (fallback). Names are trimmed +
      // case-folded so "بنك الراجحي" matches "  بنك الراجحي  ".
      // v5.10.51 — also pull level + display_order so per-row diffs can
      // include them in the response (so the user CAN SEE what changed).
      const [existing] = await conn.query('SELECT id, code, name_ar, parent_id, level, display_order FROM gl_accounts');
      const byId   = {};
      const byCode = {};
      const byName = {};   // normalizedName -> [id, id, ...] (multiple = ambiguous)
      const normName = function(s){ return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); };
      existing.forEach(e => {
        byId[String(e.id)] = {
          id: e.id, code: String(e.code || ''),
          name_ar: String(e.name_ar || ''),
          parent_id: e.parent_id || null,
          level: Number(e.level || 1),
          display_order: e.display_order == null ? null : Number(e.display_order)
        };
        if (e.code) byCode[String(e.code)] = e.id;
        const nn = normName(e.name_ar);
        if (nn) {
          if (!byName[nn]) byName[nn] = [];
          byName[nn].push(e.id);
        }
      });
      function lookupByName(name) {
        const nn = normName(name);
        if (!nn) return null;
        const list = byName[nn] || [];
        if (list.length === 1) return list[0];
        return null;  // 0 = no match, 2+ = ambiguous (caller decides)
      }

      // Sort by level ASC so parents are upserted before children: when a
      // child resolves its parentCode lookup, the parent's row is already
      // in byCode (and any code rename has already been applied).
      const sorted = rows.slice().sort((a, b) => {
        return Number(a['المستوى'] || a.level || 1) - Number(b['المستوى'] || b.level || 1);
      });

      let nameMatches = 0, codeMatches = 0, idMatches = 0;
      let parentByName = 0, parentByCode = 0, parentMissing = 0;
      // v5.10.51 — per-row diffs: every UPDATE that actually changes a
      // tracked field gets pushed here. Surfaces in the response so the
      // user sees exactly what was applied (closes the "changes don't
      // reflect" feedback gap).
      const appliedChanges = [];
      let orderChanges = 0, levelChanges = 0;

      for (const r of sorted) {
        const id     = String(r['المعرف (لا تحذف)'] || r.id || '').trim();
        const code   = String(r['الكود'] || r.code || '').trim();
        if (!code) { skipped++; errors.push({ id, code: '', reason: 'empty-code' }); continue; }
        const nameAr = String(r['الاسم العربي'] || r.nameAr || '').trim();
        const nameEn = String(r['الاسم الإنج'] || r['الاسم الانجليزي'] || r.nameEn || '').trim();
        const type   = String(r['النوع'] || r.type || 'asset').trim();
        const parentName = String(r['اسم الأب'] || r.parentName || '').trim();
        const parentCode = String(r['كود الأب'] || r.parentCode || '').trim();
        const level  = Number(r['المستوى'] || r.level || 1);
        const kindRaw= String(r['النوع الهيكلي'] || r.kind || '').trim();
        const isFolder = (kindRaw === 'رئيسي' || kindRaw === 'folder' || level <= 2) ? 1 : 0;
        // v5.10.51 — read the "الترتيب" cell. Empty/0/non-number → null
        // (means: leave existing display_order alone OR fall back to bottom).
        const orderRaw = r['الترتيب'] != null ? r['الترتيب'] : (r.order != null ? r.order : r.displayOrder);
        const displayOrder = (orderRaw === '' || orderRaw == null || isNaN(Number(orderRaw))) ? null : Number(orderRaw);

        // v5.10.50 — parent resolution: NAME first, code as fallback.
        // The user explicitly asked for name-based matching because they
        // rewire structure in Excel by editing names.
        let parentId = null;
        if (parentName) {
          const pid = lookupByName(parentName);
          if (pid) { parentId = pid; parentByName++; }
          else if (parentCode && byCode[parentCode]) { parentId = byCode[parentCode]; parentByCode++; }
          else { parentMissing++; errors.push({ id, code, reason: 'parent-not-found:' + parentName }); }
        } else if (parentCode) {
          if (byCode[parentCode]) { parentId = byCode[parentCode]; parentByCode++; }
          else { parentMissing++; errors.push({ id, code, reason: 'parent-code-not-found:' + parentCode }); }
        }

        // v5.10.50 — target resolution: id → name → code (the user said
        // "match by name not by code"; id is the safest tier so it wins
        // when present, code is the legacy fallback).
        let target = null, matchedBy = null;
        if (id && byId[id]) { target = byId[id]; matchedBy = 'id'; idMatches++; }
        if (!target && nameAr) {
          const t = lookupByName(nameAr);
          if (t) { target = byId[t]; matchedBy = 'name'; nameMatches++; }
        }
        if (!target && byCode[code]) { target = byId[byCode[code]]; matchedBy = 'code'; codeMatches++; }

        if (target) {
          // Collision: would we steal a code another row owns?
          const claimant = byCode[code];
          if (claimant && claimant !== target.id) {
            skipped++;
            errors.push({ id: target.id, code, reason: 'code-collision-with:' + claimant });
            continue;
          }
          const oldName = target.name_ar;
          const oldCode = target.code;
          const oldLevel = Number(target.level || 1);
          const oldOrder = target.display_order;
          const codeChanged = String(oldCode) !== code;
          const nameChanged = normName(oldName) !== normName(nameAr);
          const parentChanged = String(target.parent_id || '') !== String(parentId || '');
          const levelChanged = oldLevel !== level;
          // v5.10.51 — only treat as a change when the file ACTUALLY
          // specified an order; null means "leave it alone".
          const orderChanged = (displayOrder != null) && (oldOrder !== displayOrder);
          // Effective new order: keep old when file didn't specify
          const effectiveOrder = (displayOrder == null) ? oldOrder : displayOrder;
          await conn.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=?, is_folder=?, display_order=? WHERE id=?',
            [code, nameAr, nameEn, type, parentId, level, isFolder, effectiveOrder, target.id]);
          if (codeChanged) {
            await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [code, target.id]);
            delete byCode[String(oldCode)];
            byCode[code] = target.id;
            target.code = code;
            codeChanges++;
          }
          if (nameChanged) {
            const oldNN = normName(oldName);
            if (oldNN && byName[oldNN]) {
              byName[oldNN] = byName[oldNN].filter(x => x !== target.id);
              if (!byName[oldNN].length) delete byName[oldNN];
            }
            const newNN = normName(nameAr);
            if (newNN) {
              if (!byName[newNN]) byName[newNN] = [];
              if (byName[newNN].indexOf(target.id) < 0) byName[newNN].push(target.id);
            }
            target.name_ar = nameAr;
          }
          if (parentChanged) { target.parent_id = parentId; parentChanges++; }
          if (levelChanged) { target.level = level; levelChanges++; }
          if (orderChanged) { target.display_order = effectiveOrder; orderChanges++; }
          // Build the diff payload for the response (only non-trivial changes)
          if (codeChanged || nameChanged || parentChanged || levelChanged || orderChanged) {
            const diff = {};
            if (codeChanged)   diff.code   = { from: oldCode, to: code };
            if (nameChanged)   diff.name   = { from: oldName, to: nameAr };
            if (levelChanged)  diff.level  = { from: oldLevel, to: level };
            if (orderChanged)  diff.order  = { from: oldOrder, to: effectiveOrder };
            if (parentChanged) diff.parent = { from: byId[String(target.parent_id_was || '')] && byId[String(target.parent_id_was)].code || null, to: parentId };
            appliedChanges.push({ id: target.id, code, name: nameAr, diff });
          }
          updated++;
        } else {
          const newId = id || ('GL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
          // v5.10.51 — insert with display_order if specified, else NULL
          // (will fall to the bottom of its parent group at query time).
          await conn.query(
            'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_folder, display_order) VALUES (?,?,?,?,?,?,?,?,?)',
            [newId, code, nameAr, nameEn, type, parentId, level, isFolder, displayOrder]);
          byCode[code] = newId;
          const nn = normName(nameAr);
          if (nn) {
            if (!byName[nn]) byName[nn] = [];
            byName[nn].push(newId);
          }
          byId[newId] = { id: newId, code: code, name_ar: nameAr, parent_id: parentId, level: level, display_order: displayOrder };
          inserted++;
        }
      }
      console.log('[gl/accounts/import] inserted=' + inserted + ' updated=' + updated + ' skipped=' + skipped +
        ' | match: id=' + idMatches + ' name=' + nameMatches + ' code=' + codeMatches +
        ' | parent: name=' + parentByName + ' code=' + parentByCode + ' missing=' + parentMissing +
        ' | changes: code=' + codeChanges + ' parent=' + parentChanges + ' level=' + levelChanges + ' order=' + orderChanges);
      req._coaImportStats = { idMatches, nameMatches, codeMatches, parentByName, parentByCode, parentMissing };
      req._coaAppliedChanges = appliedChanges;
      req._coaCounters = { codeChanges, parentChanges, levelChanges, orderChanges };
    });

    // v5.10.51 — post-commit verification: re-read each touched id and
    // confirm the new values made it into the DB. Mismatches surface in
    // the server log so silent-rollback bugs become visible.
    const applied = req._coaAppliedChanges || [];
    if (applied.length) {
      const ids = applied.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const [verify] = await db.query(
        'SELECT id, code, level, display_order FROM gl_accounts WHERE id IN (' + placeholders + ')',
        ids);
      const byVerifyId = {};
      verify.forEach(v => { byVerifyId[v.id] = v; });
      let mismatches = 0;
      applied.forEach(c => {
        const v = byVerifyId[c.id];
        if (!v) { mismatches++; console.error('[gl/accounts/import] VERIFY MISSING ' + c.id); return; }
        if (c.diff.code  && String(v.code)  !== String(c.diff.code.to))  { mismatches++; console.error('[gl/accounts/import] VERIFY CODE FAIL '  + c.id + ' want=' + c.diff.code.to  + ' got=' + v.code); }
        if (c.diff.level && Number(v.level) !== Number(c.diff.level.to)) { mismatches++; console.error('[gl/accounts/import] VERIFY LEVEL FAIL ' + c.id + ' want=' + c.diff.level.to + ' got=' + v.level); }
      });
      console.log('[gl/accounts/import] applied ' + applied.length + ' changes, verified ' + (applied.length - mismatches) + ' rows' + (mismatches ? ' (' + mismatches + ' mismatches)' : ''));
    }
    const counters = req._coaCounters || {};
    res.json({
      success: true, inserted, updated, skipped, errors,
      codeChanges:   counters.codeChanges   || 0,
      parentChanges: counters.parentChanges || 0,
      levelChanges:  counters.levelChanges  || 0,
      orderChanges:  counters.orderChanges  || 0,
      appliedChanges: applied,
      matchStats: req._coaImportStats || null
    });
  } catch (e) {
    console.error('[gl/accounts/import] FAILED:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.50 — atomic dedupe: for each group {keepId, deleteIds[]} re-parent
// any children of the deletees to the keeper, refuse to delete any account
// that has gl_entries rows (would orphan the journal), then DELETE the
// rest. Reports counts so the UI can tell the user exactly what happened.
router.post('/gl/accounts/dedupe', async (req, res) => {
  const { groups } = req.body || {};
  if (!Array.isArray(groups) || !groups.length) {
    return res.status(400).json({ success: false, error: 'لا توجد مجموعات للحذف' });
  }
  let deleted = 0, reparented = 0;
  const skipped = [];
  try {
    await db.withTransaction(async (conn) => {
      for (const g of groups) {
        const keepId = String(g.keepId || '').trim();
        const delIds = Array.isArray(g.deleteIds) ? g.deleteIds.map(String) : [];
        if (!keepId || !delIds.length) continue;
        // Ensure keepId actually exists
        const [keepRows] = await conn.query('SELECT id FROM gl_accounts WHERE id = ?', [keepId]);
        if (!keepRows.length) { skipped.push({ id: keepId, reason: 'keep-not-found' }); continue; }
        for (const did of delIds) {
          if (did === keepId) continue;
          // Refuse to delete if account has any gl_entries (would orphan
          // posted journal lines). User must merge entries manually.
          const [entries] = await conn.query('SELECT id FROM gl_entries WHERE account_id = ? LIMIT 1', [did]);
          if (entries.length) { skipped.push({ id: did, reason: 'has-journal-entries' }); continue; }
          // Re-parent any children of the deletee to the keeper.
          const [kids] = await conn.query('SELECT id FROM gl_accounts WHERE parent_id = ?', [did]);
          if (kids.length) {
            await conn.query('UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?', [keepId, did]);
            reparented += kids.length;
          }
          // Refuse if a journal HEADER references it as account_id (rare,
          // but defensive) — none of our journals reference accounts at
          // header level so this is a no-op in practice.
          await conn.query('DELETE FROM gl_accounts WHERE id = ?', [did]);
          deleted++;
          console.log('[gl/accounts/dedupe] deleted ' + did + ' (kept ' + keepId + ', reparented ' + kids.length + ' children)');
        }
      }
    });
    res.json({ success: true, deleted, reparented, skipped });
  } catch (e) {
    console.error('[gl/accounts/dedupe] FAILED:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.45 — move an account under a new parent and (optionally) renumber
// its code based on the new parent's existing children. When renumbering,
// every descendant's code is rewritten with the new prefix in the same
// transaction, and gl_entries.account_code (denormalized) is kept in sync.
// Refuses to make an account its own ancestor (cycle protection).
router.post('/gl/accounts/:id/move', async (req, res) => {
  const { id } = req.params;
  const { parentId, autoRenumber } = req.body || {};
  const willRenumber = !!autoRenumber;
  try {
    const result = await db.withTransaction(async (conn) => {
      const [accRows] = await conn.query('SELECT id, code, parent_id, level FROM gl_accounts WHERE id = ?', [id]);
      if (!accRows.length) throw new Error('الحساب غير موجود');
      const acc = accRows[0];
      if (['1','2','3','4','5'].indexOf(String(acc.code)) >= 0) {
        throw new Error('لا يمكن نقل حساب رئيسي (الجذور 1-5)');
      }

      let newParent = null;
      if (parentId) {
        const [pRows] = await conn.query('SELECT id, code, level FROM gl_accounts WHERE id = ?', [parentId]);
        if (!pRows.length) throw new Error('الأب الجديد غير موجود');
        newParent = pRows[0];
        if (newParent.id === id) throw new Error('لا يمكن جعل الحساب أبًا لنفسه');
        // Cycle check: walk up parentId's chain — if we hit `id`, abort.
        let walkerId = newParent.id, hops = 0; const seen = new Set();
        while (walkerId && hops < 50) {
          if (seen.has(walkerId)) break;
          seen.add(walkerId);
          if (walkerId === id) throw new Error('لا يمكن نقل الحساب تحت أحد أبنائه');
          const [up] = await conn.query('SELECT parent_id FROM gl_accounts WHERE id = ?', [walkerId]);
          if (!up.length || !up[0].parent_id) break;
          walkerId = up[0].parent_id;
          hops++;
        }
      }

      // Compute new code (and cascade to descendants) when autoRenumber=true
      const renumbered = [];
      let newCode = acc.code;
      if (willRenumber && newParent) {
        const [siblings] = await conn.query(
          'SELECT code FROM gl_accounts WHERE parent_id = ? ORDER BY code',
          [newParent.id]);
        if (!siblings.length) {
          newCode = (Number(newParent.level) >= 3) ? (newParent.code + '01') : (newParent.code + '1');
        } else {
          const last = siblings[siblings.length - 1].code;
          const suffix = last.substring(newParent.code.length);
          const nextNum = parseInt(suffix, 10) + 1;
          newCode = newParent.code + String(nextNum).padStart(suffix.length || 1, '0');
        }

        // Cascade rename: every descendant whose code starts with the
        // moving account's old code gets its prefix rewritten to newCode.
        const oldPrefix = acc.code;
        const [descRows] = await conn.query(
          'SELECT id, code FROM gl_accounts WHERE code LIKE ? AND id != ?',
          [oldPrefix + '%', id]);
        for (const d of descRows) {
          if (!String(d.code).startsWith(oldPrefix)) continue;
          const newDescCode = newCode + d.code.substring(oldPrefix.length);
          const [clash] = await conn.query('SELECT id FROM gl_accounts WHERE code = ? AND id != ?', [newDescCode, d.id]);
          if (clash.length) throw new Error('تعارض كود: ' + newDescCode + ' موجود مسبقًا');
          await conn.query('UPDATE gl_accounts SET code = ? WHERE id = ?', [newDescCode, d.id]);
          await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [newDescCode, d.id]);
          renumbered.push({ id: d.id, oldCode: d.code, newCode: newDescCode });
        }
      }

      // Apply main update
      const [mainClash] = await conn.query('SELECT id FROM gl_accounts WHERE code = ? AND id != ?', [newCode, id]);
      if (mainClash.length) throw new Error('تعارض كود: ' + newCode + ' موجود مسبقًا');
      const newLevel = newParent ? (Number(newParent.level) + 1) : 1;
      await conn.query(
        'UPDATE gl_accounts SET code = ?, parent_id = ?, level = ? WHERE id = ?',
        [newCode, parentId || null, newLevel, id]);
      await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [newCode, id]);
      renumbered.push({ id, oldCode: acc.code, newCode });

      console.log('[gl/move] ' + acc.code + ' -> ' + newCode + ' under ' + (newParent ? newParent.code : 'root') + ' (renumbered ' + renumbered.length + ')');
      return { renumbered, oldCode: acc.code, newCode, newParentId: parentId || null };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[gl/move] FAILED:', e.message);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/gl/accounts', async (req, res) => {
  try {
    const { id, code, nameAr, nameEn, type, parentId, level, isFolder } = req.body;
    // v5.10.46 — accept explicit isFolder flag from the frontend modal so
    // L1/L2 main accounts get is_folder=1 even before any child is added.
    const hasFolderFlag = (typeof isFolder === 'boolean');
    const folderInt = hasFolderFlag ? (isFolder ? 1 : 0) : null;

    if (id) {
      const [existing] = await db.query('SELECT id FROM gl_accounts WHERE id = ?', [id]);
      if (existing.length) {
        if (hasFolderFlag) {
          await db.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=?, is_folder=? WHERE id=?',
            [code, nameAr, nameEn || '', type, parentId || null, level || 1, folderInt, id]
          );
        } else {
          await db.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=? WHERE id=?',
            [code, nameAr, nameEn || '', type, parentId || null, level || 1, id]
          );
        }
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'GL-' + Date.now();
    if (hasFolderFlag) {
      await db.query(
        'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_folder) VALUES (?,?,?,?,?,?,?,?)',
        [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1, folderInt]
      );
    } else {
      await db.query(
        'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level) VALUES (?,?,?,?,?,?,?)',
        [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1]
      );
    }

    // v5.10.46 — auto-promote the parent to a folder when a child is
    // inserted under it at L3+ (parent.level >= 2 means new child is L3+).
    // This mirrors what _coaForceFolderConsistency does at deep-repair
    // time, but applies it to the insert hot-path so the user sees the
    // parent flip to folder immediately, without needing to run repair.
    if (parentId) {
      try {
        const [parentRows] = await db.query('SELECT level, is_folder FROM gl_accounts WHERE id = ?', [parentId]);
        if (parentRows.length && Number(parentRows[0].level) >= 2 && !parentRows[0].is_folder) {
          await db.query('UPDATE gl_accounts SET is_folder = 1 WHERE id = ?', [parentId]);
          console.log('[gl/accounts] auto-promoted parent ' + parentId + ' to folder (child at L' + ((Number(parentRows[0].level)||1) + 1) + ')');
        }
      } catch (e) {
        console.error('[gl/accounts] auto-promote parent failed:', e.message);
      }
    }

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete GL account
router.delete('/gl/accounts/:id', async (req, res) => {
  try {
    // Check if account has children
    const [children] = await db.query('SELECT id FROM gl_accounts WHERE parent_id = ?', [req.params.id]);
    if (children.length) return res.json({ success: false, error: 'لا يمكن حذف حساب لديه حسابات فرعية' });
    // Check if account has journal entries
    const [entries] = await db.query('SELECT id FROM gl_entries WHERE account_id = ? LIMIT 1', [req.params.id]);
    if (entries.length) return res.json({ success: false, error: 'لا يمكن حذف حساب مستخدم في قيود محاسبية' });
    await db.query('DELETE FROM gl_accounts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Seed cafe GL accounts (دليل حسابات المقهى)
router.post('/gl/seed', async (req, res) => {
  try {
    const [existing] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    if (existing[0].cnt > 0) return res.json({ success: true, msg: 'already seeded' });

    const accounts = [
      // ═══ 1 الأصول ═══
      {code:'1',name:'الأصول',type:'asset',parent:null,level:1},
      {code:'11',name:'الأصول المتداولة',type:'asset',parent:'1',level:2},
      {code:'111',name:'النقدية والبنوك',type:'asset',parent:'11',level:3},
      {code:'11101',name:'عهدة الكاشير / صناديق نقاط البيع (POS)',type:'asset',parent:'111',level:4},
      {code:'11102',name:'الحسابات البنكية الجارية',type:'asset',parent:'111',level:4},
      {code:'112',name:'المخزون',type:'asset',parent:'11',level:3},
      {code:'11201',name:'مخزون المواد الخام (البن، الحليب، المنكهات)',type:'asset',parent:'112',level:4},
      {code:'11202',name:'مخزون المنتجات الجاهزة (المخبوزات، الحلويات)',type:'asset',parent:'112',level:4},
      {code:'11203',name:'مخزون مواد التغليف والتعبئة (الأكواب، الأكياس)',type:'asset',parent:'112',level:4},
      {code:'11204',name:'مخزون المنتجات تحت التشغيل (WIP)',type:'asset',parent:'112',level:4},
      {code:'11205',name:'مخزون المنتجات التامة (Finished Goods)',type:'asset',parent:'112',level:4},
      {code:'113',name:'الذمم المدينة والأرصدة',type:'asset',parent:'11',level:3},
      {code:'11301',name:'ذمم تطبيقات التوصيل (جاهز، هنقرستيشن..)',type:'asset',parent:'113',level:4},
      {code:'11302',name:'سلف ومقدمات الموظفين',type:'asset',parent:'113',level:4},
      {code:'11303',name:'إيجارات مدفوعة مقدماً',type:'asset',parent:'113',level:4},
      {code:'114',name:'ضريبة المدخلات',type:'asset',parent:'11',level:3},
      {code:'12',name:'الأصول الثابتة',type:'asset',parent:'1',level:2},
      {code:'121',name:'معدات وآلات الكافيه',type:'asset',parent:'12',level:3},
      {code:'122',name:'أجهزة نقاط البيع والأنظمة',type:'asset',parent:'12',level:3},
      {code:'123',name:'الأثاث والديكورات',type:'asset',parent:'12',level:3},
      {code:'124',name:'مجمع إهلاك الأصول الثابتة',type:'asset',parent:'12',level:3},
      // ═══ 2 الالتزامات ═══
      {code:'2',name:'الالتزامات',type:'liability',parent:null,level:1},
      {code:'21',name:'الالتزامات المتداولة',type:'liability',parent:'2',level:2},
      {code:'211',name:'الموردون والدائنون',type:'liability',parent:'21',level:3},
      {code:'21101',name:'موردو المواد الغذائية والبن',type:'liability',parent:'211',level:4},
      {code:'21102',name:'موردو التغليف والمعدات',type:'liability',parent:'211',level:4},
      {code:'212',name:'المصروفات المستحقة',type:'liability',parent:'21',level:3},
      {code:'21201',name:'رواتب وأجور مستحقة',type:'liability',parent:'212',level:4},
      {code:'21202',name:'إيجارات عقود مستحقة الدفع',type:'liability',parent:'212',level:4},
      {code:'21203',name:'فواتير منافع مستحقة',type:'liability',parent:'212',level:4},
      {code:'213',name:'الضرائب',type:'liability',parent:'21',level:3},
      {code:'21301',name:'ضريبة القيمة المضافة المستحقة (VAT)',type:'liability',parent:'213',level:4},
      // ═══ 3 حقوق الملكية ═══
      {code:'3',name:'حقوق الملكية',type:'equity',parent:null,level:1},
      {code:'31',name:'رأس المال',type:'equity',parent:'3',level:2},
      {code:'311',name:'رأس مال الشركاء أو المالك',type:'equity',parent:'31',level:3},
      {code:'32',name:'الأرباح المبقاة',type:'equity',parent:'3',level:2},
      {code:'321',name:'الأرباح أو الخسائر المرحلة',type:'equity',parent:'32',level:3},
      {code:'33',name:'المسحوبات',type:'equity',parent:'3',level:2},
      {code:'331',name:'جاري المالك (المسحوبات الشخصية)',type:'equity',parent:'33',level:3},
      // ═══ 4 الإيرادات ═══
      {code:'4',name:'الإيرادات',type:'revenue',parent:null,level:1},
      {code:'41',name:'الإيرادات التشغيلية',type:'revenue',parent:'4',level:2},
      {code:'411',name:'مبيعات نقاط البيع (POS)',type:'revenue',parent:'41',level:3},
      {code:'41101',name:'مبيعات المشروبات الساخنة والباردة',type:'revenue',parent:'411',level:4},
      {code:'41102',name:'مبيعات المأكولات والحلويات',type:'revenue',parent:'411',level:4},
      {code:'41103',name:'مبيعات منتجات التجزئة',type:'revenue',parent:'411',level:4},
      {code:'412',name:'مبيعات تطبيقات التوصيل',type:'revenue',parent:'41',level:3},
      {code:'41201',name:'مبيعات تطبيقات التوصيل',type:'revenue',parent:'412',level:4},
      {code:'42',name:'الإيرادات الأخرى',type:'revenue',parent:'4',level:2},
      {code:'421',name:'إيرادات خدمات الحفلات الخارجية (Catering)',type:'revenue',parent:'42',level:3},
      {code:'422',name:'إيرادات متنوعة',type:'revenue',parent:'42',level:3},
      // ═══ 5 المصروفات (تشمل COGS + التشغيلية + العمومية) ═══
      {code:'5',name:'المصروفات',type:'expense',parent:null,level:1},
      {code:'51',name:'تكلفة المبيعات (COGS)',type:'expense',parent:'5',level:2},
      {code:'511',name:'تكلفة المواد المستهلكة',type:'expense',parent:'51',level:3},
      {code:'5111',name:'تكلفة البن والمشروبات',type:'expense',parent:'511',level:4},
      {code:'5112',name:'تكلفة المأكولات والحلويات المباعة',type:'expense',parent:'511',level:4},
      {code:'5113',name:'تكلفة مواد التعبئة والتغليف',type:'expense',parent:'511',level:4},
      {code:'512',name:'الهالك والتوالف',type:'expense',parent:'51',level:3},
      {code:'5121',name:'هالك المواد الغذائية والبن',type:'expense',parent:'512',level:4},
      {code:'52',name:'المصروفات التشغيلية',type:'expense',parent:'5',level:2},
      {code:'521',name:'الرواتب والأجور',type:'expense',parent:'52',level:3},
      {code:'522',name:'الإيجارات والمنافع',type:'expense',parent:'52',level:3},
      {code:'5221',name:'إيجارات الفروع',type:'expense',parent:'522',level:4},
      {code:'5222',name:'الكهرباء والماء',type:'expense',parent:'522',level:4},
      {code:'5223',name:'اشتراكات الإنترنت والاتصالات',type:'expense',parent:'522',level:4},
      {code:'523',name:'التشغيل والصيانة',type:'expense',parent:'52',level:3},
      {code:'5231',name:'صيانة مكائن القهوة والمعدات',type:'expense',parent:'523',level:4},
      {code:'5232',name:'أدوات النظافة والتعقيم',type:'expense',parent:'523',level:4},
      {code:'524',name:'التسويق والعمولات',type:'expense',parent:'52',level:3},
      {code:'5241',name:'عمولات تطبيقات التوصيل',type:'expense',parent:'524',level:4},
      {code:'5242',name:'الحملات الإعلانية والتسويق',type:'expense',parent:'524',level:4},
      {code:'53',name:'المصروفات العمومية والإدارية',type:'expense',parent:'5',level:2},
      {code:'531',name:'رسوم اشتراكات الأنظمة والبرامج',type:'expense',parent:'53',level:3},
      {code:'532',name:'الرسوم الحكومية والتراخيص',type:'expense',parent:'53',level:3},
      {code:'533',name:'العمولات البنكية ورسوم شبكات الدفع',type:'expense',parent:'53',level:3},
      {code:'534',name:'مصروفات الضيافة والنثريات',type:'expense',parent:'53',level:3},
    ];

    // Build a code→id map so parent references work
    const codeToId = {};
    for (const a of accounts) {
      const id = 'GL-' + a.code;
      codeToId[a.code] = id;
    }
    for (const a of accounts) {
      const id = codeToId[a.code];
      const parentId = a.parent ? (codeToId[a.parent] || null) : null;
      await db.query(
        'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [id, a.code, a.name, a.type, parentId, a.level]
      );
    }
    res.json({ success: true, count: accounts.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── v5.10.5 — COA inventory classification repair ─────────────────────
// Walks the chart and fixes any account whose name screams "inventory" but
// whose parent_id chain is anchored at code 12 (الأصول الثابتة) instead of
// 112 (المخزون). Idempotent. Also exported as a helper so server.js can
// run it once at boot for self-healing on existing deployments.
async function _repairInventoryClassification(db) {
  const repaired = [];
  // Resolve target parent (112 المخزون). If missing, try to create it under 11.
  let [p112] = await db.query("SELECT id FROM gl_accounts WHERE code = '112'");
  let target112Id = p112.length ? p112[0].id : null;
  if (!target112Id) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11'");
    if (p11.length) {
      target112Id = 'GL-112';
      await db.query(
        "INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)",
        [target112Id, '112', 'المخزون', 'asset', p11[0].id, 3]
      );
    }
  }
  if (!target112Id) return { ok: false, reason: 'no-parent-112', repaired };

  // Find candidates: name contains inventory keywords AND parent chain leads to code 12
  const inventoryRegex = /(مخزون|منتجات تامة|منتجات تحت التشغيل|finished good|wip|raw material)/i;
  const [allAcc] = await db.query(
    "SELECT id, code, name_ar, parent_id FROM gl_accounts WHERE type = 'asset'"
  );
  const byId = Object.fromEntries(allAcc.map(a => [a.id, a]));
  function ancestorCode(id, depth = 0) {
    if (depth > 10) return null;
    const a = byId[id]; if (!a) return null;
    if (a.code === '12') return '12';
    if (a.code === '112') return '112';
    if (!a.parent_id) return a.code;
    return ancestorCode(a.parent_id, depth + 1);
  }
  for (const a of allAcc) {
    if (!inventoryRegex.test(a.name_ar || '')) continue;
    if (a.code === '112') continue;            // skip the target parent itself
    if (String(a.code).startsWith('112')) continue; // already correct
    const anc = ancestorCode(a.parent_id);
    if (anc === '12') {
      // Misclassified — re-parent to 112
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [target112Id, a.id]);
      repaired.push({ id: a.id, code: a.code, name: a.name_ar, oldParent: a.parent_id, newParent: target112Id });
    }
  }
  return { ok: true, repaired };
}
// Expose helper on the router so server.js can run it at boot
router._repairInventoryClassification = _repairInventoryClassification;

router.post('/gl/repair-inventory-classification', async (req, res) => {
  try {
    const r = await _repairInventoryClassification(db);
    res.json({ success: r.ok, fixed: r.repaired.length, repaired: r.repaired, reason: r.reason || null });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.10.35 — General-purpose chart-of-accounts repair. Walks every account
// and re-parents anything that:
//   1. Is an orphan (parent_id points at a deleted/missing row), OR
//   2. Has a name keyword that conflicts with its current branch
//      (e.g. account named "مخزون شيء" parented under fixed-assets tree)
//
// Idempotent: returns { fixed: 0 } when nothing needs changing.
//
// Response:
//   {
//     success, fixed, repaired: [{ id, code, nameAr, oldParentCode,
//       newParentCode, reason }],
//     skipped:  [{ id, code, nameAr, reason }]   // for human review
//   }
router.post('/gl/repair-classification', async (req, res) => {
  try {
    // Keyword → preferred parent code map (ordered: most-specific first)
    // Each entry: [regex, parentCode, label]
    const KEYWORD_RULES = [
      // Inventory must come BEFORE other matchers since "مخزون" is generic
      [/^(مخزون|inventory|raw\s*material|finished\s*goods|wip|تغليف|تعبئة)/i, '112', 'مخزون'],
      [/(عهدة|كاشير|صندوق|cash\s*box|petty\s*cash|نقدية)/i,                   '111', 'النقدية والبنوك'],
      [/(بنك\b|bank\b|حساب\s*جاري)/i,                                          '111', 'النقدية والبنوك'],
      [/(ذمم\s*مدين|عملاء|customers?\s*receivab|تطبيقات\s*التوصيل|سلف.*موظف|prepaid|مدفوعة\s*مقدم)/i, '113', 'الذمم المدينة'],
      [/(ضريبة\s*المدخلات|input\s*vat)/i,                                      '114', 'ضريبة المدخلات'],
      [/(معدات|آلات|أجهزة\s*pos|أثاث|ديكور|مجمع\s*إهلاك|equipment)/i,           '12',  'الأصول الثابتة'],
      [/(ذمم\s*دائن|موردون|suppliers?\s*payab|accounts?\s*payable)/i,           '211', 'الموردون والدائنون'],
      [/(رواتب\s*مستحق|إيجار.*مستحق|منافع\s*مستحق|accrued)/i,                  '212', 'المصروفات المستحقة'],
      [/(ضريبة\s*المخرجات|output\s*vat|زكاة|ضريبة\s*دخل)/i,                    '213', 'الضرائب'],
      [/(قروض|loans?)/i,                                                       '214', 'القروض'],
      [/(رأس\s*المال|capital)/i,                                                '31',  'رأس المال'],
      [/(أرباح\s*محتجزة|أرباح\s*مرحلة|retained\s*earnings)/i,                  '32',  'الأرباح المبقاة'],
      [/(مسحوبات|drawings|جاري\s*المالك)/i,                                    '33',  'المسحوبات'],
      [/(إيرادات.*مبيعات|sales\s*revenue|مبيعات\s*pos|مبيعات\s*المشروبات|مبيعات\s*المأكولات)/i, '411', 'مبيعات نقاط البيع'],
      [/(تطبيقات\s*التوصيل|delivery\s*apps?|جاهز|هنقرستيشن|كيتا|keeta)/i,      '412', 'مبيعات تطبيقات التوصيل'],
      [/(كاترينج|catering|حفلات\s*خارجي)/i,                                    '421', 'إيرادات الحفلات الخارجية'],
      [/(فروقات\s*جرد.*إيراد|stock\s*gain|إيراد.*متنوع)/i,                     '422', 'إيرادات متنوعة'],
      [/(تكلفة\s*المبيعات|cogs|cost\s*of\s*goods|تكلفة\s*البن|تكلفة\s*المواد)/i,'511', 'تكلفة المواد المستهلكة'],
      [/(هدر|تالف|waste|spoilage|فروقات\s*الجرد|stock\s*variance|فروقات\s*الإنتاج)/i, '512', 'الهالك والتوالف'],
      [/(رواتب|أجور|salaries|wages|عمالة)/i,                                   '521', 'الرواتب والأجور'],
      [/(إيجار|rent|كهرباء|ماء|إنترنت|اتصال|utilities)/i,                      '522', 'الإيجارات والمنافع'],
      [/(صيانة|maintenance|تشغيل|نظافة|تعقيم)/i,                               '523', 'التشغيل والصيانة'],
      [/(تسويق|marketing|إعلان|عمولة\s*تطبيق)/i,                               '524', 'التسويق والعمولات'],
      [/(اشتراك|software|نظام|برنامج)/i,                                       '531', 'رسوم الأنظمة والبرامج'],
      [/(رسوم\s*حكومي|تراخيص|licens)/i,                                        '532', 'الرسوم الحكومية والتراخيص'],
      [/(عمولة\s*بنك|رسوم\s*شبكة|رسوم\s*تحويل|merchant\s*fee)/i,               '533', 'العمولات البنكية ورسوم الدفع'],
      [/(ضيافة|نثريات)/i,                                                       '534', 'الضيافة والنثريات'],
      [/(امتياز|franchise|royalty)/i,                                          '533', 'رسوم الامتياز']
    ];

    // 1. Build code→id and id→row maps
    const [allRows] = await db.query(
      'SELECT id, code, name_ar, type, parent_id, level FROM gl_accounts');
    const byCode = {};
    const byId   = {};
    allRows.forEach(r => { byCode[r.code] = r; byId[r.id] = r; });

    const repaired = [];
    const skipped  = [];

    // Helper: resolve preferred parent for a code, walking up if absent
    function resolvePreferredParent(preferredCode) {
      let walk = String(preferredCode || '');
      while (walk.length > 0) {
        if (byCode[walk]) return byCode[walk];
        walk = walk.substring(0, walk.length - 1);
      }
      return null;
    }

    for (const acc of allRows) {
      // Skip top-level roots (codes 1..5)
      if (!acc.parent_id || ['1','2','3','4','5'].includes(acc.code)) continue;

      // (1) Orphan check: parent_id present but no matching row
      let currentParent = byId[acc.parent_id] || null;
      if (!currentParent) {
        // Try to derive parent from code prefix
        const prefix = acc.code.substring(0, acc.code.length - 1);
        const target = resolvePreferredParent(prefix);
        if (target && target.id !== acc.id) {
          await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
            [target.id, target.code.length + 1, acc.id]);
          repaired.push({
            id: acc.id, code: acc.code, nameAr: acc.name_ar,
            oldParentCode: '(orphan)', newParentCode: target.code,
            reason: 'orphan-reparented-by-prefix'
          });
          // refresh local cache so subsequent loops see the new parent
          byId[acc.id].parent_id = target.id;
          continue;
        }
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'orphan-no-prefix-match' });
        continue;
      }

      // (2) Keyword-based reclassification: if the name strongly hints at a
      //     known category, ensure the account sits under that branch.
      const nameForMatch = String(acc.name_ar || '');
      let matchedRule = null;
      for (const [re, parentCode, label] of KEYWORD_RULES) {
        if (re.test(nameForMatch)) { matchedRule = { parentCode, label }; break; }
      }
      if (!matchedRule) continue;

      // Walk up from acc to root collecting parent codes — if matchedRule's
      // root is already an ancestor, the account is correctly placed.
      const rootOfRule = matchedRule.parentCode.charAt(0);   // '1'..'5'
      let walker = currentParent;
      let seenRoot = null;
      const seenIds = new Set();
      while (walker) {
        if (seenIds.has(walker.id)) break;     // cycle guard
        seenIds.add(walker.id);
        if (walker.code === rootOfRule) { seenRoot = walker; break; }
        if (!walker.parent_id) { seenRoot = walker; break; }
        walker = byId[walker.parent_id] || null;
      }

      // Acceptable when account already lives under the right top-level root
      // AND its immediate parent code starts with the matchedRule's parentCode prefix
      const directParentCode = currentParent.code || '';
      const okBranch = (seenRoot && seenRoot.code === rootOfRule);
      const okSubtree = directParentCode.startsWith(matchedRule.parentCode) ||
                        matchedRule.parentCode.startsWith(directParentCode);
      if (okBranch && okSubtree) continue;

      // Otherwise re-parent under the preferred parent
      const target = resolvePreferredParent(matchedRule.parentCode);
      if (!target) {
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'preferred-parent-' + matchedRule.parentCode + '-missing' });
        continue;
      }
      if (target.id === acc.id) continue; // can't be its own parent

      // Don't re-parent a top-level root
      try {
        await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
          [target.id, target.code.length + 1, acc.id]);
        repaired.push({
          id: acc.id, code: acc.code, nameAr: acc.name_ar,
          oldParentCode: directParentCode, newParentCode: target.code,
          reason: 'keyword:' + matchedRule.label
        });
        byId[acc.id].parent_id = target.id;
      } catch (e) {
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'update-error:' + e.message });
      }
    }

    res.json({ success: true, fixed: repaired.length, repaired, skipped });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// v5.10.38 — Deep repair (single atomic endpoint).
// Runs every COA integrity fix in one transaction and returns
// before/after diagnostic counts so the UI can show what changed.
// ───────────────────────────────────────────────────────────────────────

// Keyword → preferred parent code map (ordered: most-specific first).
// Banks regex strengthened over the inline rules used by /gl/repair-
// classification: matches "بنك" anywhere (no \b — Arabic word boundaries
// are unreliable) plus "البنوك / الحساب البنكي / حساب جاري / current account".
const _COA_KEYWORD_RULES = [
  [/^(مخزون|inventory|raw\s*material|finished\s*goods|wip|تغليف|تعبئة)/i, '112', 'مخزون'],
  [/(بنك|bank|البنوك|حساب\s*جاري|current\s*account|الحساب(?:ات)?\s*البنكي)/i, '111', 'النقدية والبنوك'],
  [/(عهدة|كاشير|صندوق|cash\s*box|petty\s*cash|نقدية)/i,                   '111', 'النقدية والبنوك'],
  [/(ذمم\s*مدين|عملاء|customers?\s*receivab|تطبيقات\s*التوصيل|سلف.*موظف|prepaid|مدفوعة\s*مقدم)/i, '113', 'الذمم المدينة'],
  [/(ضريبة\s*المدخلات|input\s*vat)/i,                                      '114', 'ضريبة المدخلات'],
  [/(معدات|آلات|أجهزة\s*pos|أثاث|ديكور|مجمع\s*إهلاك|equipment)/i,           '12',  'الأصول الثابتة'],
  [/(ذمم\s*دائن|موردون|suppliers?\s*payab|accounts?\s*payable)/i,           '211', 'الموردون والدائنون'],
  [/(رواتب\s*مستحق|إيجار.*مستحق|منافع\s*مستحق|accrued)/i,                  '212', 'المصروفات المستحقة'],
  [/(ضريبة\s*المخرجات|output\s*vat|زكاة|ضريبة\s*دخل)/i,                    '213', 'الضرائب'],
  [/(قروض|loans?)/i,                                                       '214', 'القروض'],
  [/(رأس\s*المال|capital)/i,                                               '31',  'رأس المال'],
  [/(أرباح\s*محتجزة|أرباح\s*مرحلة|retained\s*earnings)/i,                  '32',  'الأرباح المبقاة'],
  [/(مسحوبات|drawings|جاري\s*المالك)/i,                                    '33',  'المسحوبات'],
  [/(إيرادات.*مبيعات|sales\s*revenue|مبيعات\s*pos|مبيعات\s*المشروبات|مبيعات\s*المأكولات)/i, '411', 'مبيعات نقاط البيع'],
  [/(تطبيقات\s*التوصيل|delivery\s*apps?|جاهز|هنقرستيشن|كيتا|keeta)/i,      '412', 'مبيعات تطبيقات التوصيل'],
  [/(كاترينج|catering|حفلات\s*خارجي)/i,                                    '421', 'إيرادات الحفلات الخارجية'],
  [/(فروقات\s*جرد.*إيراد|stock\s*gain|إيراد.*متنوع)/i,                     '422', 'إيرادات متنوعة'],
  [/(تكلفة\s*المبيعات|cogs|cost\s*of\s*goods|تكلفة\s*البن|تكلفة\s*المواد)/i,'511', 'تكلفة المواد المستهلكة'],
  [/(هدر|تالف|waste|spoilage|فروقات\s*الجرد|stock\s*variance|فروقات\s*الإنتاج)/i, '512', 'الهالك والتوالف'],
  [/(رواتب|أجور|salaries|wages|عمالة)/i,                                   '521', 'الرواتب والأجور'],
  [/(إيجار|rent|كهرباء|ماء|إنترنت|اتصال|utilities)/i,                      '522', 'الإيجارات والمنافع'],
  [/(صيانة|maintenance|تشغيل|نظافة|تعقيم)/i,                               '523', 'التشغيل والصيانة'],
  [/(تسويق|marketing|إعلان|عمولة\s*تطبيق)/i,                               '524', 'التسويق والعمولات'],
  [/(اشتراك|software|نظام|برنامج)/i,                                       '531', 'رسوم الأنظمة والبرامج'],
  [/(رسوم\s*حكومي|تراخيص|licens)/i,                                        '532', 'الرسوم الحكومية والتراخيص'],
  [/(عمولة\s*بنك|رسوم\s*شبكة|رسوم\s*تحويل|merchant\s*fee)/i,               '533', 'العمولات البنكية ورسوم الدفع'],
  [/(ضيافة|نثريات)/i,                                                       '534', 'الضيافة والنثريات'],
  [/(امتياز|franchise|royalty)/i,                                          '533', 'رسوم الامتياز']
];

const _COA_ROOT_TYPE_BY_CODE = {
  '1': 'asset', '2': 'liability', '3': 'equity', '4': 'revenue', '5': 'expense'
};

function _coaComputeDepth(byId, a, seen) {
  if (!a || !a.parent_id) return 0;
  if (seen.has(a.id)) return 0;
  seen.add(a.id);
  const p = byId[a.parent_id];
  return p ? _coaComputeDepth(byId, p, seen) + 1 : 0;
}

// Snapshot of integrity issues. Used before/after deep-repair to
// quantify what changed.
async function _coaDiagnoseSnapshot(db) {
  const out = {};
  const [orphans] = await db.query(
    `SELECT id FROM gl_accounts
      WHERE parent_id IS NOT NULL
        AND parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
  out.orphans = orphans.length;

  const [tm] = await db.query(
    `SELECT c.id FROM gl_accounts c
       JOIN gl_accounts p ON p.id = c.parent_id
      WHERE c.type IS NOT NULL AND p.type IS NOT NULL AND c.type <> p.type`);
  out.typeMismatch = tm.length;

  const [ctm] = await db.query(
    `SELECT id FROM gl_accounts WHERE code IS NOT NULL AND (
       (LEFT(code,1)='1' AND type<>'asset')      OR
       (LEFT(code,1)='2' AND type<>'liability')  OR
       (LEFT(code,1)='3' AND type<>'equity')     OR
       (LEFT(code,1)='4' AND type<>'revenue')    OR
       (LEFT(code,1)='5' AND type<>'expense'))`);
  out.codeTypeMismatch = ctm.length;

  const [dup] = await db.query(
    `SELECT code FROM gl_accounts WHERE code IS NOT NULL GROUP BY code HAVING COUNT(*) > 1`);
  out.duplicateCodes = dup.length;

  const [bwe] = await db.query(
    `SELECT a.id FROM gl_accounts a
      WHERE ABS(IFNULL(a.balance,0)) > 0.001
        AND NOT EXISTS (SELECT 1 FROM gl_entries e
                          JOIN gl_journals j ON j.id = e.journal_id
                         WHERE e.account_id = a.id AND j.status='posted')`);
  out.balanceWithoutEntries = bwe.length;

  const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
  const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
  let levelMismatch = 0, cycles = 0;
  for (const a of allAccs) {
    const seen = new Set();
    let walker = a, hops = 0, cycled = false;
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) { cycled = true; break; }
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) break;
    }
    if (cycled) { cycles++; continue; }
    const d = _coaComputeDepth(byId, a, new Set());
    if (Number(a.level || 0) !== d) levelMismatch++;
  }
  out.levelMismatch = levelMismatch;
  out.cycles = cycles;
  return out;
}

function _coaResolvePreferredParent(byCode, preferredCode) {
  let walk = String(preferredCode || '');
  while (walk.length > 0) {
    if (byCode[walk]) return byCode[walk];
    walk = walk.substring(0, walk.length - 1);
  }
  return null;
}

// Reparent accounts whose name strongly hints at a known IFRS branch.
// Bug fixes vs. the legacy /gl/repair-classification:
//   (a) orphan reparenting requires type compatibility
//   (b) level computed from target.level, not target.code.length
//   (c) banks regex no longer relies on \b word boundaries
async function _coaRepairByKeywords(db) {
  const [allRows] = await db.query(
    'SELECT id, code, name_ar, type, parent_id, level FROM gl_accounts');
  const byCode = {}, byId = {};
  allRows.forEach(r => { byCode[r.code] = r; byId[r.id] = r; });

  const repaired = [], skipped = [];

  for (const acc of allRows) {
    if (!acc.parent_id || ['1','2','3','4','5'].includes(acc.code)) continue;

    let currentParent = byId[acc.parent_id] || null;
    if (!currentParent) {
      const codeStr = String(acc.code || '');
      const prefix = codeStr.substring(0, Math.max(0, codeStr.length - 1));
      const target = _coaResolvePreferredParent(byCode, prefix);
      if (target && target.id !== acc.id) {
        const targetRootType = _COA_ROOT_TYPE_BY_CODE[String(target.code || '').charAt(0)];
        if (targetRootType && acc.type && acc.type !== targetRootType) {
          skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'type-conflict-needs-manual-review' });
          continue;
        }
        await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
          [target.id, (Number(target.level || 0) + 1), acc.id]);
        repaired.push({
          id: acc.id, code: acc.code, nameAr: acc.name_ar,
          oldParentCode: '(orphan)', newParentCode: target.code,
          reason: 'orphan-reparented-by-prefix'
        });
        byId[acc.id].parent_id = target.id;
        continue;
      }
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'orphan-no-prefix-match' });
      continue;
    }

    const nameForMatch = String(acc.name_ar || '');
    let matchedRule = null;
    for (const [re, parentCode, label] of _COA_KEYWORD_RULES) {
      if (re.test(nameForMatch)) { matchedRule = { parentCode, label }; break; }
    }
    if (!matchedRule) continue;

    const rootOfRule = matchedRule.parentCode.charAt(0);
    let walker = currentParent;
    let seenRoot = null;
    const seenIds = new Set();
    while (walker) {
      if (seenIds.has(walker.id)) break;
      seenIds.add(walker.id);
      if (walker.code === rootOfRule) { seenRoot = walker; break; }
      if (!walker.parent_id) { seenRoot = walker; break; }
      walker = byId[walker.parent_id] || null;
    }

    const directParentCode = currentParent.code || '';
    const okBranch = (seenRoot && seenRoot.code === rootOfRule);
    const okSubtree = directParentCode.startsWith(matchedRule.parentCode) ||
                      matchedRule.parentCode.startsWith(directParentCode);
    if (okBranch && okSubtree) continue;

    const target = _coaResolvePreferredParent(byCode, matchedRule.parentCode);
    if (!target) {
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'preferred-parent-' + matchedRule.parentCode + '-missing' });
      continue;
    }
    if (target.id === acc.id) continue;

    try {
      await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
        [target.id, (Number(target.level || 0) + 1), acc.id]);
      repaired.push({
        id: acc.id, code: acc.code, nameAr: acc.name_ar,
        oldParentCode: directParentCode, newParentCode: target.code,
        reason: 'keyword:' + matchedRule.label
      });
      byId[acc.id].parent_id = target.id;
    } catch (e) {
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'update-error:' + e.message });
    }
  }
  return { repaired, skipped };
}

// v5.10.41 — physically move accounts whose code's first digit doesn't
// match their actual root ancestor. e.g. an account with code 41xxx
// sitting under root 5 (cost of sales) gets re-parented under root 4.
// v5.10.44 — silent try/catch replaced by per-account console.log; the
// returned object now exposes skipped[] (no candidate found) and failed[]
// (DB error during UPDATE) so the caller and Railway logs both see the
// truth instead of a swallowed failure.
async function _coaFixRootCodeMismatch(db) {
  const fixed = [];
  const skipped = [];
  const failed = [];
  const [allAccs] = await db.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
  const byId = {}, byCode = {};
  allAccs.forEach(a => { byId[a.id] = a; byCode[a.code] = a; });

  function ascendantCode(a) {
    let walker = a, hops = 0;
    const seen = new Set();
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) return null;
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) return null;
    }
    return walker ? walker.code : null;
  }

  for (const a of allAccs) {
    const codeStr = String(a.code || '');
    if (!codeStr) { skipped.push({ code: a.code, name: a.name_ar, reason: 'empty-code' }); continue; }
    const codeRoot = codeStr.charAt(0);
    if (['1','2','3','4','5'].indexOf(codeRoot) < 0) {
      skipped.push({ code: a.code, name: a.name_ar, reason: 'non-numeric-root:' + codeRoot });
      continue;
    }
    if (codeStr === codeRoot) continue; // root itself — silent skip
    const actualRoot = ascendantCode(a);
    if (!actualRoot) { skipped.push({ code: a.code, name: a.name_ar, reason: 'no-ancestor-root' }); continue; }
    if (actualRoot === codeRoot) continue; // already correct — silent skip

    let candidate = null;
    let walk = codeStr.substring(0, codeStr.length - 1);
    while (walk.length > 0) {
      const cand = byCode[walk];
      if (cand) {
        const candRoot = ascendantCode(cand);
        if (cand.code === codeRoot || candRoot === codeRoot) { candidate = cand; break; }
      }
      walk = walk.substring(0, walk.length - 1);
    }
    if (!candidate) candidate = byCode[codeRoot] || null;
    if (!candidate || candidate.id === a.id) {
      skipped.push({ code: a.code, name: a.name_ar, reason: 'no-valid-candidate', expectedRoot: codeRoot, actualRoot });
      continue;
    }

    try {
      await db.query('UPDATE gl_accounts SET parent_id = ? WHERE id = ?', [candidate.id, a.id]);
      console.log('[fixRootCodeMismatch] MOVED ' + a.code + ' (' + (a.name_ar || '') + ') from root ' + actualRoot + ' -> under ' + candidate.code);
      fixed.push({
        id: a.id, code: a.code, name: a.name_ar,
        oldRootCode: actualRoot,
        newParentCode: candidate.code,
        expectedRootCode: codeRoot
      });
      byId[a.id].parent_id = candidate.id;
    } catch (e) {
      console.error('[fixRootCodeMismatch] FAILED to move ' + a.code + ' (' + (a.name_ar || '') + '): ' + e.message);
      failed.push({ code: a.code, name: a.name_ar, error: e.message });
    }
  }
  return { fixed, skipped, failed };
}

// v5.10.44 — Last-resort topology guarantee. Runs AFTER all the smart
// helpers. For any account whose code's first digit doesn't match its
// reachable root, force-reparent it directly under the correct root.
// We sacrifice the original sub-hierarchy in exchange for guaranteed
// correctness — better that 41xxx ends up flat under root 4 than to
// keep it under root 5 because the smart helpers couldn't find a
// suitable intermediate parent.
async function _coaBruteForceRootTopology(db) {
  const moved = [];
  const failed = [];
  const [roots] = await db.query("SELECT id, code FROM gl_accounts WHERE code IN ('1','2','3','4','5') AND (parent_id IS NULL OR parent_id = '')");
  const rootIdByCode = {};
  roots.forEach(r => { rootIdByCode[r.code] = r.id; });

  const missingRoots = ['1','2','3','4','5'].filter(c => !rootIdByCode[c]);
  if (missingRoots.length) {
    console.error('[bruteForceTopology] ABORT - missing roots: ' + missingRoots.join(','));
    return { moved, failed, missingRoots };
  }

  const [allAccs] = await db.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
  const byId = {};
  allAccs.forEach(a => { byId[a.id] = a; });

  function reachableRootCode(a) {
    let walker = a, hops = 0;
    const seen = new Set();
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) return null;
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) return null;
    }
    return walker ? String(walker.code || '') : null;
  }

  for (const a of allAccs) {
    const code = String(a.code || '');
    if (!code) continue;
    const expectedRoot = code.charAt(0);
    if (['1','2','3','4','5'].indexOf(expectedRoot) < 0) continue;
    if (code === expectedRoot) continue; // root itself
    const actual = reachableRootCode(a);
    if (actual === expectedRoot) continue; // correctly placed
    const targetRootId = rootIdByCode[expectedRoot];
    if (!targetRootId || targetRootId === a.id) continue;
    try {
      await db.query('UPDATE gl_accounts SET parent_id = ? WHERE id = ?', [targetRootId, a.id]);
      console.log('[bruteForceTopology] MOVED ' + code + ' (' + (a.name_ar || '') + ') -> under root ' + expectedRoot);
      moved.push({ code: a.code, name: a.name_ar, fromRoot: actual, toRoot: expectedRoot });
      byId[a.id].parent_id = targetRootId;
    } catch (e) {
      console.error('[bruteForceTopology] FAILED ' + code + ' (' + (a.name_ar || '') + '): ' + e.message);
      failed.push({ code: a.code, name: a.name_ar, error: e.message });
    }
  }
  return { moved, failed, missingRoots: [] };
}

async function _coaAlignTypeWithParent(db) {
  const fixed = [];
  const [rows] = await db.query('SELECT id, code, type FROM gl_accounts WHERE code IS NOT NULL');
  for (const r of rows) {
    const expected = _COA_ROOT_TYPE_BY_CODE[String(r.code).charAt(0)];
    if (expected && r.type !== expected) {
      await db.query('UPDATE gl_accounts SET type = ? WHERE id = ?', [expected, r.id]);
      fixed.push({ id: r.id, code: r.code, oldType: r.type, newType: expected });
    }
  }
  return fixed;
}

async function _coaFixRootsAndOrphansByPrefix(db) {
  let fixed = 0;
  // Merge legacy code 6 into 5 (if both exist) or rename
  const [acc6] = await db.query("SELECT id FROM gl_accounts WHERE code = '6'");
  if (acc6.length) {
    const [acc5] = await db.query("SELECT id FROM gl_accounts WHERE code = '5'");
    if (acc5.length) {
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?", [acc5[0].id, acc6[0].id]);
      await db.query("DELETE FROM gl_accounts WHERE id = ? AND code = '6'", [acc6[0].id]);
      fixed++;
    } else {
      await db.query("UPDATE gl_accounts SET code = '5', name_ar = 'المصروفات', parent_id = NULL, level = 1 WHERE id = ?", [acc6[0].id]);
      fixed++;
    }
  }
  // Reparent orphans by code prefix (level>1 with no parent)
  const [orphans] = await db.query("SELECT id, code, level FROM gl_accounts WHERE level > 1 AND (parent_id IS NULL OR parent_id = '')");
  for (const o of orphans) {
    let parentCode = String(o.code || '');
    parentCode = parentCode.substring(0, Math.max(0, parentCode.length - 1));
    while (parentCode.length > 0) {
      const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = ?", [parentCode]);
      if (parent.length) {
        await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [parent[0].id, o.id]);
        fixed++;
        break;
      }
      parentCode = parentCode.substring(0, parentCode.length - 1);
    }
  }
  // Ensure roots 1..5 are level 1, parent NULL
  await db.query("UPDATE gl_accounts SET level = 1, parent_id = NULL WHERE code IN ('1','2','3','4','5') AND (level != 1 OR parent_id IS NOT NULL)");
  return fixed;
}

async function _coaAutoFixLevels(db) {
  let orphansPromoted = 0, levelsCorrected = 0;
  const [orphans] = await db.query(
    `SELECT a.id FROM gl_accounts a
      WHERE a.parent_id IS NOT NULL
        AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
  for (const o of orphans) {
    await db.query('UPDATE gl_accounts SET parent_id = NULL, level = 0 WHERE id = ?', [o.id]);
    orphansPromoted++;
  }
  const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
  const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
  for (const a of allAccs) {
    const d = _coaComputeDepth(byId, a, new Set());
    if (Number(a.level || 0) !== d) {
      await db.query('UPDATE gl_accounts SET level = ? WHERE id = ?', [d, a.id]);
      levelsCorrected++;
    }
  }
  return { orphansPromoted, levelsCorrected };
}

// v5.10.43 — defense in depth: even if the boot migration failed, this
// runs at the end of every deep-repair and re-enforces is_folder=1 for
// the 5 main roots and any account that has children. Manual folder
// promotions (is_folder=1 with no children) are preserved.
async function _coaForceFolderConsistency(db) {
  const fixed = { roots: 0, parents: 0 };
  try {
    const [r1] = await db.query("UPDATE gl_accounts SET is_folder = 1 WHERE code IN ('1','2','3','4','5') AND (is_folder = 0 OR is_folder IS NULL)");
    fixed.roots = r1.affectedRows || 0;
  } catch (e) {
    console.error('[deep-repair] _coaForceFolderConsistency roots failed:', e.message);
  }
  try {
    const [parents] = await db.query("SELECT DISTINCT parent_id AS pid FROM gl_accounts WHERE parent_id IS NOT NULL");
    const ids = parents.map(p => p.pid).filter(Boolean);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const [r2] = await db.query(`UPDATE gl_accounts SET is_folder = 1 WHERE id IN (${ph}) AND (is_folder = 0 OR is_folder IS NULL)`, ids);
      fixed.parents = r2.affectedRows || 0;
    }
  } catch (e) {
    console.error('[deep-repair] _coaForceFolderConsistency parents failed:', e.message);
  }
  return fixed;
}

// Rebuild gl_accounts.balance from posted gl_entries — the only safe way
// to guarantee tree balances match the journal.
async function _coaRecomputeBalances(db) {
  await db.query('UPDATE gl_accounts SET balance = 0');
  const [agg] = await db.query(
    `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
      WHERE j.status = 'posted' AND e.account_id IS NOT NULL
      GROUP BY e.account_id`);
  for (const a of agg) {
    const net = (Number(a.d) || 0) - (Number(a.c) || 0);
    await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, a.account_id]);
  }
  return agg.length;
}

// POST /gl/deep-repair — single-shot atomic chart-of-accounts repair.
// v5.10.43 — every step now logs to server console so silent failures
// become visible. If a step throws, the transaction rolls back and the
// HTTP response includes the actual error message + the step that failed.
router.post('/gl/deep-repair', async (req, res) => {
  let lastStep = 'init';
  try {
    const result = await db.withTransaction(async (conn) => {
      console.log('[deep-repair] ========== START ==========');

      lastStep = 'snapshot-before';
      const before = await _coaDiagnoseSnapshot(conn);
      console.log('[deep-repair] step 0: before snapshot — issues:', JSON.stringify(before));

      lastStep = 'ensureCoreAccounts';
      try { await ensureCoreAccounts(conn); } catch(e) { console.error('[deep-repair] ensureCoreAccounts:', e.message); }
      console.log('[deep-repair] step 1: ensureCoreAccounts done');

      lastStep = 'fixRootsAndOrphansByPrefix';
      const treeFixed = await _coaFixRootsAndOrphansByPrefix(conn);
      console.log('[deep-repair] step 2: fixRootsAndOrphansByPrefix → ' + treeFixed + ' rows touched');

      lastStep = 'fixRootCodeMismatch';
      const rootFixesResult = await _coaFixRootCodeMismatch(conn);
      console.log('[deep-repair] step 3: fixRootCodeMismatch → fixed=' + rootFixesResult.fixed.length + ' skipped=' + rootFixesResult.skipped.length + ' failed=' + rootFixesResult.failed.length);

      lastStep = 'repairByKeywords';
      const reclass = await _coaRepairByKeywords(conn);
      console.log('[deep-repair] step 4: repairByKeywords → ' + (reclass.repaired ? reclass.repaired.length : 0) + ' reclassified, ' + (reclass.skipped ? reclass.skipped.length : 0) + ' skipped');

      lastStep = 'alignTypeWithParent';
      const typeFixes = await _coaAlignTypeWithParent(conn);
      console.log('[deep-repair] step 5: alignTypeWithParent → ' + (typeFixes ? typeFixes.length : 0) + ' types corrected');

      lastStep = 'autoFixLevels';
      const lvl = await _coaAutoFixLevels(conn);
      console.log('[deep-repair] step 6: autoFixLevels → ' + lvl.orphansPromoted + ' orphans promoted, ' + lvl.levelsCorrected + ' levels corrected');

      lastStep = 'recomputeBalances';
      const balRecomp = await _coaRecomputeBalances(conn);
      console.log('[deep-repair] step 7: recomputeBalances → ' + balRecomp + ' balances rebuilt from gl_entries');

      // v5.10.44 — last-resort topology guarantee. If any account is still
      // in the wrong root subtree after the smart helpers, force-reparent
      // it directly under the correct root. Better flat-but-correct than
      // hierarchical-but-wrong.
      lastStep = 'bruteForceTopology';
      const brute = await _coaBruteForceRootTopology(conn);
      console.log('[deep-repair] step 7.5: bruteForceTopology → ' + brute.moved.length + ' force-reparented, missingRoots=[' + (brute.missingRoots || []).join(',') + ']');

      lastStep = 'forceFolderConsistency';
      const folderFixes = await _coaForceFolderConsistency(conn);
      console.log('[deep-repair] step 8: forceFolderConsistency → roots=' + folderFixes.roots + ' parents=' + folderFixes.parents);

      // v5.10.44 — final independent verification: walk every account's
      // parent chain and list any whose reachable root still doesn't
      // match its code prefix. This is the truth surfaced to the user.
      lastStep = 'verifyTopology';
      const [verifyAccs] = await conn.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
      const _byIdV = {}; verifyAccs.forEach(a => { _byIdV[a.id] = a; });
      function _walkRootV(a) {
        let w = a, hops = 0; const seen = new Set();
        while (w && w.parent_id) {
          if (seen.has(w.id)) return null;
          seen.add(w.id);
          w = _byIdV[w.parent_id] || null;
          if (++hops > 50) return null;
        }
        return w ? String(w.code || '') : null;
      }
      const stillMisplaced = [];
      for (const a of verifyAccs) {
        const code = String(a.code || '');
        if (!code) continue;
        const expected = code.charAt(0);
        if (['1','2','3','4','5'].indexOf(expected) < 0) continue;
        if (code === expected) continue;
        const actual = _walkRootV(a);
        if (actual && actual !== expected) {
          stillMisplaced.push({ code: a.code, name: a.name_ar, expected, actual });
        } else if (!actual) {
          stillMisplaced.push({ code: a.code, name: a.name_ar, expected, actual: 'orphan-or-cycle' });
        }
      }
      console.log('[deep-repair] FINAL VERIFICATION: ' + stillMisplaced.length + ' accounts still in wrong root');
      if (stillMisplaced.length) console.log(JSON.stringify(stillMisplaced));

      lastStep = 'snapshot-after';
      const after = await _coaDiagnoseSnapshot(conn);
      console.log('[deep-repair] step 9: after snapshot — issues:', JSON.stringify(after));

      console.log('[deep-repair] ========== COMMIT ==========');
      return {
        before, after,
        reclassified: reclass.repaired,
        skipped: reclass.skipped,
        typeFixed: typeFixes,
        rootFixed: rootFixesResult.fixed,
        rootFixSkipped: rootFixesResult.skipped,           // v5.10.44
        rootFixFailed: rootFixesResult.failed,             // v5.10.44
        bruteForcedTopology: brute.moved,                  // v5.10.44
        bruteForcedFailed: brute.failed,                   // v5.10.44
        missingRoots: brute.missingRoots || [],            // v5.10.44
        folderFixed: folderFixes,                          // v5.10.43
        treeFixed,
        orphansPromoted: lvl.orphansPromoted,
        levelsCorrected: lvl.levelsCorrected,
        balancesRecomputed: balRecomp,
        stillMisplaced                                     // v5.10.44 — TRUTH
      };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[deep-repair] ROLLBACK at step "' + lastStep + '":', e.message, e.stack);
    res.status(500).json({ success: false, error: e.message, failedStep: lastStep });
  }
});

// ─── GL Journals ───

router.get('/gl/journals', async (req, res) => {
  try {
    let query = 'SELECT * FROM gl_journals WHERE 1=1';
    const params = [];

    if (req.query.startDate) { query += ' AND journal_date >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate) { query += ' AND journal_date <= ?'; params.push(req.query.endDate); }
    if (req.query.referenceType) { query += ' AND reference_type = ?'; params.push(req.query.referenceType); }
    if (req.query.status) { query += ' AND status = ?'; params.push(req.query.status); }

    query += ' ORDER BY journal_date DESC, created_at DESC LIMIT 500';

    const [journals] = await db.query(query, params);
    const result = [];

    // V5.7.18 — JOIN gl_accounts to ALWAYS surface the human-readable name,
    //           even for OLD entries written before glPosting started
    //           persisting account_name. Falls back gracefully:
    //             COALESCE(persisted_name, joined_name_ar, joined_name_en, code)
    for (const j of journals) {
      const [entries] = await db.query(
        `SELECT
            e.id, e.account_id, e.account_code, e.account_name AS persisted_name,
            e.debit, e.credit, e.description,
            e.branch_id, e.brand_id, e.cost_center_id, e.warehouse_id,
            ga.name_ar AS gl_name_ar, ga.name_en AS gl_name_en, ga.type AS gl_type
         FROM gl_entries e
         LEFT JOIN gl_accounts ga ON ga.id = e.account_id
         WHERE e.journal_id = ?
         ORDER BY e.id`,
        [j.id]
      );
      result.push({
        id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
        referenceType: j.reference_type, referenceId: j.reference_id,
        description: j.description, notes: j.notes || '',
        totalDebit: Number(j.total_debit), totalCredit: Number(j.total_credit),
        periodId: j.period_id, status: j.status,
        createdBy: j.created_by || '', approvedBy: j.approved_by || '', postedBy: j.posted_by || '',
        approvedAt: j.approved_at, postedAt: j.posted_at,
        attachment: j.attachment || '',
        entries: entries.map(e => {
          // Resolve display name: persisted (V5.7.18+) → joined Arabic →
          //                       joined English → fallback to code
          const resolvedName = e.persisted_name && e.persisted_name.trim()
            ? e.persisted_name
            : (e.gl_name_ar || e.gl_name_en || e.account_code || '');
          return {
            id: e.id,
            accountId: e.account_id,
            accountCode: e.account_code,
            accountName: resolvedName,
            accountType: e.gl_type || '',
            debit: Number(e.debit),
            credit: Number(e.credit),
            description: e.description,
            branchId: e.branch_id,
            brandId: e.brand_id,
            costCenterId: e.cost_center_id,
            warehouseId: e.warehouse_id
          };
        })
      });
    }

    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// Create journal entry (status: draft — no balance update until posted)
router.post('/gl/journals', async (req, res) => {
  try {
    const { journalDate, referenceType, referenceId, description, entries, username, attachment, notes, isOpening, costCenterId, costCenterName } = req.body;
    const actualRefType = isOpening ? 'opening' : (referenceType || 'manual');
    const journalId = 'JRN-' + Date.now();

    const [lastJ] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
    let nextNum = 1;
    if (lastJ.length && lastJ[0].journal_number) {
      const match = lastJ[0].journal_number.match(/(\d+)/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const journalNumber = 'JV-' + String(nextNum).padStart(6, '0');

    let totalDebit = 0, totalCredit = 0;
    if (entries && entries.length) {
      for (const entry of entries) {
        totalDebit += Number(entry.debit) || 0;
        totalCredit += Number(entry.credit) || 0;
      }
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.json({ success: false, error: 'القيد غير متوازن (مدين ≠ دائن)' });
    }

    await db.query(
      `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, attachment, notes, cost_center_id, cost_center_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [journalId, journalNumber, journalDate || new Date(), actualRefType, referenceId || '',
       description || '', totalDebit, totalCredit, 'draft', username || '', attachment || null, notes || '', costCenterId || null, costCenterName || '']
    );
    // Audit log
    await auditLog('create_journal', 'gl_journal', journalId, username, { journalNumber, totalDebit, totalCredit, description }, req.ip);

    if (entries && entries.length) {
      for (const entry of entries) {
        const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description, cost_center_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [entryId, journalId, entry.accountId || null, entry.accountCode || '',
           entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '', entry.costCenterId || null]
        );
      }
    }
    // Note: balances NOT updated yet — only on "post"
    res.json({ success: true, id: journalId, journalNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve journal (draft → approved)
router.post('/gl/journals/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    const [jrn] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [req.params.id]);
    if (!jrn.length) return res.json({ success: false, error: 'القيد غير موجود' });
    if (jrn[0].status !== 'draft') return res.json({ success: false, error: 'فقط القيود المسودة يمكن اعتمادها' });
    await db.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?',
      [username || '', new Date(), req.params.id]);
    await auditLog('approve_journal', 'gl_journal', req.params.id, username, {}, req.ip);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// V5.10.0 — Accounting periods: list / create / open / close / soft-close.
// The schema already exists (server.js:2382). These endpoints expose it.
router.get('/periods', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, company_id, period_name, start_date, end_date, status, closed_by, closed_at, notes
       FROM accounting_periods
       ORDER BY start_date DESC LIMIT 200`);
    res.json(rows.map(r => ({
      id: r.id, periodName: r.period_name, startDate: r.start_date, endDate: r.end_date,
      status: r.status, closedBy: r.closed_by || '', closedAt: r.closed_at, notes: r.notes || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/periods', async (req, res) => {
  try {
    const { id, periodName, startDate, endDate, notes } = req.body || {};
    if (!periodName || !startDate || !endDate) return res.json({ success:false, error: 'الاسم والتواريخ مطلوبة' });
    if (id) {
      await db.query(
        `UPDATE accounting_periods SET period_name=?, start_date=?, end_date=?, notes=? WHERE id=?`,
        [periodName, startDate, endDate, notes||null, id]);
      return res.json({ success:true, id });
    }
    const newId = 'PER-' + Date.now();
    await db.query(
      `INSERT INTO accounting_periods (id, company_id, period_name, start_date, end_date, status, notes)
       VALUES (?, 'CO-MAIN', ?, ?, ?, 'open', ?)`,
      [newId, periodName, startDate, endDate, notes||null]);
    res.json({ success:true, id:newId });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// Lock / unlock a period. status ∈ {open, soft_closed, closed}.
router.post('/periods/:id/lock', async (req, res) => {
  try {
    const { status, username } = req.body || {};
    if (!['open','soft_closed','closed'].includes(status)) {
      return res.json({ success:false, error:'الحالة غير صالحة' });
    }
    const [p] = await db.query('SELECT status FROM accounting_periods WHERE id=?', [req.params.id]);
    if (!p.length) return res.json({ success:false, error:'الفترة غير موجودة' });
    if (p[0].status === 'closed' && status !== 'closed') {
      // Re-opening a hard-closed period requires a force flag (audit safety).
      if (!req.body || req.body.force !== true) {
        return res.json({ success:false, error:'الفترة مُقفلة نهائياً — يلزم force=true لإعادة فتحها' });
      }
    }
    if (status === 'open') {
      await db.query('UPDATE accounting_periods SET status=?, closed_by=NULL, closed_at=NULL WHERE id=?',
        [status, req.params.id]);
    } else {
      await db.query('UPDATE accounting_periods SET status=?, closed_by=?, closed_at=NOW() WHERE id=?',
        [status, username||'', req.params.id]);
    }
    res.json({ success:true });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// V5.10.0 — Helper: refuse to post into a closed accounting period.
// `closed` periods are hard-locked (no posting at all). `soft_closed`
// allows admin override via {force:true}. `open` periods accept any post.
async function _checkPeriodOpen(journalDate, allowForce) {
  if (!journalDate) return { ok: true };
  const [p] = await db.query(
    `SELECT id, period_name, status FROM accounting_periods
     WHERE start_date <= ? AND end_date >= ? LIMIT 1`,
    [journalDate, journalDate]);
  if (!p.length) return { ok: true }; // no period defined for that date — allow
  const period = p[0];
  if (period.status === 'open') return { ok: true, period };
  if (period.status === 'soft_closed' && allowForce) return { ok: true, period, forced: true };
  return {
    ok: false,
    period,
    error: period.status === 'closed'
      ? `لا يمكن الترحيل: الفترة «${period.period_name}» مُقفلة نهائياً.`
      : `الفترة «${period.period_name}» مُقفلة (إقفال مبدئي). تواصل مع المحاسب الرئيسي للسماح بالترحيل.`
  };
}

// Post journal (approved → posted) — updates account balances
router.post('/gl/journals/:id/post', async (req, res) => {
  try {
    const { username, force } = req.body || {};
    const [jrn] = await db.query('SELECT status, journal_date FROM gl_journals WHERE id = ?', [req.params.id]);
    if (!jrn.length) return res.json({ success: false, error: 'القيد غير موجود' });
    if (jrn[0].status !== 'approved') return res.json({ success: false, error: 'يجب اعتماد القيد أولاً قبل الترحيل' });

    // V5.10.0 — period lock guard
    const guard = await _checkPeriodOpen(jrn[0].journal_date, !!force);
    if (!guard.ok) return res.json({ success: false, error: guard.error });

    // Update account balances
    const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [req.params.id]);
    for (const e of entries) {
      if (e.account_id) {
        const netAmount = (Number(e.debit) || 0) - (Number(e.credit) || 0);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [netAmount, e.account_id]);
      }
    }
    await db.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?',
      [username || '', new Date(), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Unpost journal (posted → draft) — reverses account balances
router.post('/gl/journals/:id/unpost', async (req, res) => {
  try {
    const [jrn] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [req.params.id]);
    if (!jrn.length) return res.json({ success: false, error: 'القيد غير موجود' });
    if (jrn[0].status !== 'posted') return res.json({ success: false, error: 'القيد ليس مرحّلاً' });

    // Reverse account balances
    const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [req.params.id]);
    for (const e of entries) {
      if (e.account_id) {
        const netAmount = (Number(e.debit) || 0) - (Number(e.credit) || 0);
        await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [netAmount, e.account_id]);
      }
    }
    await db.query('UPDATE gl_journals SET status = "draft", posted_by = NULL, posted_at = NULL, approved_by = NULL, approved_at = NULL WHERE id = ?',
      [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get entries for a specific journal
router.get('/gl/journals/:id/entries', async (req, res) => {
  try {
    const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ? ORDER BY id', [req.params.id]);
    res.json(entries.map(e => ({
      id: e.id, accountId: e.account_id, accountCode: e.account_code,
      accountName: e.account_name, debit: Number(e.debit), credit: Number(e.credit),
      description: e.description
    })));
  } catch (e) { res.json([]); }
});

// Account ledger — get all transactions for a specific account
// ═══════════════════════════════════════════════════════════════════
// GL LEDGER MULTI — Daftra-style دفتر الأستاذ for ALL accounts
// Returns one section per account with: opening + lines + total
// Filters: from, to, accType (main/sub/both), parent, addedBy,
//          scope (all/active/leaf)
// ═══════════════════════════════════════════════════════════════════
router.get('/reports/gl-ledger-multi', async (req, res) => {
  try {
    const { from, to, parent, addedBy, scope, accType } = req.query;

    // Status filter — posted + approved by default
    const statusClause = "j.status IN ('posted','approved')";

    // 1) Load all active accounts (with parent_id)
    const [accts] = await db.query(
      `SELECT id, code, name_ar, type, parent_id
       FROM gl_accounts WHERE is_active = 1 OR is_active IS NULL
       ORDER BY code`);

    // 2) Compute opening balance for each account (entries before 'from')
    const openingMap = {};
    if (from) {
      const [openRows] = await db.query(
        `SELECT e.account_id,
                COALESCE(SUM(e.debit),0)  AS d,
                COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
         WHERE j.journal_date < ? AND ${statusClause}
         GROUP BY e.account_id`,
        [from]);
      openRows.forEach(r => { openingMap[r.account_id] = Number(r.d) - Number(r.c); });
    }

    // 3) Load all entries within the date range with journal info
    let entSql =
      `SELECT e.id, e.journal_id, e.account_id, e.debit, e.credit, e.description AS entry_desc,
              j.journal_number, j.journal_date, j.description AS journal_desc,
              j.reference_type, j.reference_id, j.created_by
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${statusClause}`;
    const params = [];
    if (from) { entSql += ' AND j.journal_date >= ?'; params.push(from); }
    if (to)   { entSql += ' AND j.journal_date <= ?'; params.push(to); }
    if (addedBy) { entSql += ' AND j.created_by = ?'; params.push(addedBy); }
    entSql += ' ORDER BY e.account_id, j.journal_date ASC, j.created_at ASC, e.id ASC';
    const [entries] = await db.query(entSql, params);

    // Group entries by account_id
    const linesByAccount = {};
    entries.forEach(r => {
      if (!linesByAccount[r.account_id]) linesByAccount[r.account_id] = [];
      linesByAccount[r.account_id].push({
        id: r.id,
        journalId: r.journal_id,
        journalNumber: r.journal_number || '',
        date: r.journal_date,
        addedBy: r.created_by || '',
        description: r.entry_desc || r.journal_desc || '',
        referenceType: r.reference_type || '',
        referenceId: r.reference_id || '',
        debit: Number(r.debit) || 0,
        credit: Number(r.credit) || 0
      });
    });

    // 4) Build sections per account (only those with movement OR with opening)
    const childrenSet = new Set();
    accts.forEach(a => { if (a.parent_id) childrenSet.add(a.parent_id); });
    const isMain = (a) => !a.parent_id;
    const isLeaf = (a) => !childrenSet.has(a.id);

    const sections = [];
    accts.forEach(a => {
      const lines = linesByAccount[a.id] || [];
      const opening = Number(openingMap[a.id] || 0);
      // Apply scope filter
      if (scope === 'active' && lines.length === 0 && Math.abs(opening) < 0.005) return;
      if (scope === 'leaf'   && !isLeaf(a)) return;
      // Apply account type filter
      if (accType === 'main' && !isMain(a)) return;
      if (accType === 'sub'  &&  isMain(a)) return;
      // Apply parent filter
      if (parent && a.parent_id !== parent && a.id !== parent) return;
      // Skip empty accounts unless 'all' scope (which is the default)
      if (!scope || scope === 'all') {
        if (lines.length === 0 && Math.abs(opening) < 0.005) return;
      }

      // Compute running balance + totals
      let bal = opening;
      let totalD = 0, totalC = 0;
      const decoratedLines = lines.map(l => {
        bal += (l.debit - l.credit);
        totalD += l.debit;
        totalC += l.credit;
        return Object.assign({}, l, { runningBalance: Math.round(bal*100)/100 });
      });

      sections.push({
        accountId: a.id,
        code: a.code,
        nameAr: a.name_ar,
        type: a.type,
        parentId: a.parent_id || null,
        opening: Math.round(opening * 100) / 100,
        openingDebit:  opening > 0 ?  opening : 0,
        openingCredit: opening < 0 ? -opening : 0,
        totalDebit:    Math.round(totalD * 100) / 100,
        totalCredit:   Math.round(totalC * 100) / 100,
        closingBalance: Math.round((opening + totalD - totalC) * 100) / 100,
        lineCount: decoratedLines.length,
        lines: decoratedLines
      });
    });

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, parent: parent || null, addedBy: addedBy || null, scope: scope || 'all', accType: accType || 'both' },
      sections,
      grandTotals: sections.reduce((g, s) => ({
        debit:   g.debit   + s.totalDebit,
        credit:  g.credit  + s.totalCredit,
        opening: g.opening + s.opening,
        closing: g.closing + s.closingBalance,
        accountCount: g.accountCount + 1,
        lineCount: g.lineCount + s.lineCount
      }), { debit:0, credit:0, opening:0, closing:0, accountCount:0, lineCount:0 })
    });
  } catch (e) {
    console.error('gl-ledger-multi error:', e);
    res.json({ success: false, error: e.message, sections: [] });
  }
});

router.get('/gl/account-ledger/:accountId', async (req, res) => {
  try {
    const accId = req.params.accountId;
    const { startDate, endDate, status, includeDraft } = req.query;

    const [accRows] = await db.query('SELECT * FROM gl_accounts WHERE id = ?', [accId]);
    const acc = accRows.length ? accRows[0] : null;
    if (!acc) return res.json({ success: false, ledger: [], error: 'الحساب غير موجود' });
    const accCode = acc.code || '';
    const accType = acc.type || '';

    // Status filter: by default include posted + approved (active accounting entries)
    const statusClause = (status && status !== 'all')
      ? 'AND j.status = ?'
      : (includeDraft === '1' ? '' : "AND j.status IN ('posted','approved')");
    const statusParams = (status && status !== 'all') ? [status] : [];

    // 1) Opening balance — sum of all entries strictly BEFORE startDate
    let opening = 0;
    if (startDate) {
      const [openRows] = await db.query(
        `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
         WHERE (e.account_id = ? OR (e.account_code = ? AND e.account_code != ''))
           AND j.journal_date < ? ${statusClause}`,
        [accId, accCode, startDate, ...statusParams]
      );
      opening = Number(openRows[0].d || 0) - Number(openRows[0].c || 0);
    }

    // 2) Entries within the date range
    let sql =
      `SELECT e.id, e.journal_id, e.account_id, e.account_code, e.debit, e.credit, e.description,
              j.journal_number, j.journal_date, j.description AS journal_desc, j.status,
              j.reference_type, j.reference_id, j.created_by, j.created_at
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE (e.account_id = ? OR (e.account_code = ? AND e.account_code != ''))
         ${statusClause}`;
    const params = [accId, accCode, ...statusParams];
    if (startDate) { sql += ' AND j.journal_date >= ?'; params.push(startDate); }
    if (endDate)   { sql += ' AND j.journal_date <= ?'; params.push(endDate); }
    sql += ' ORDER BY j.journal_date ASC, j.created_at ASC, e.id ASC';

    const [rows] = await db.query(sql, params);

    let runningBal = opening;
    let totalDebit = 0, totalCredit = 0;
    const ledger = rows.map(r => {
      const d = Number(r.debit) || 0;
      const c = Number(r.credit) || 0;
      runningBal += (d - c);
      totalDebit += d; totalCredit += c;
      return {
        id: r.id, journalId: r.journal_id, journalNumber: r.journal_number,
        journalDate: r.journal_date, journalDesc: r.journal_desc || '',
        entryDesc: r.description || '', referenceType: r.reference_type || '',
        referenceId: r.reference_id || '',
        status: r.status, createdBy: r.created_by || '',
        debit: d, credit: c, balance: runningBal
      };
    });

    res.json({
      success: true,
      account: {
        id: acc.id, code: accCode, nameAr: acc.name_ar, nameEn: acc.name_en || '',
        type: accType, level: acc.level || 0, parentId: acc.parent_id || ''
      },
      accountName: acc.name_ar, accountCode: accCode,
      period: { startDate: startDate || null, endDate: endDate || null },
      opening,
      totals: { debit: totalDebit, credit: totalCredit, net: totalDebit - totalCredit, count: ledger.length },
      closing: runningBal,
      ledger
    });
  } catch (e) { res.json({ success: false, ledger: [], error: e.message }); }
});

// Update journal — edit posted/draft/approved journal entries
router.put('/gl/journals/:id', async (req, res) => {
  try {
    const journalId = req.params.id;
    const { journalDate, description, notes, entries, username } = req.body;

    const [jrnRows] = await db.query('SELECT * FROM gl_journals WHERE id = ?', [journalId]);
    if (!jrnRows.length) return res.json({ success: false, error: 'القيد غير موجود' });
    const jrn = jrnRows[0];

    // Only manual/opening journals can be edited
    if (jrn.reference_type !== 'manual' && jrn.reference_type !== 'opening') {
      return res.json({ success: false, error: 'لا يمكن تعديل القيود التلقائية' });
    }

    // Validate balance
    let totalDebit = 0, totalCredit = 0;
    (entries || []).forEach(e => { totalDebit += Number(e.debit) || 0; totalCredit += Number(e.credit) || 0; });
    if (Math.abs(totalDebit - totalCredit) > 0.01) return res.json({ success: false, error: 'القيد غير متوازن' });

    // Step 1: If posted, reverse old balances
    if (jrn.status === 'posted') {
      const [oldEntries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [journalId]);
      for (const e of oldEntries) {
        if (e.account_id) {
          const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
          await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [reverseAmount, e.account_id]);
        }
      }
    }

    // Step 2: Delete old entries
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [journalId]);

    // Step 3: Update journal header
    await db.query(
      'UPDATE gl_journals SET journal_date=?, description=?, notes=?, total_debit=?, total_credit=? WHERE id=?',
      [journalDate || jrn.journal_date, description || jrn.description, notes || '', totalDebit, totalCredit, journalId]
    );

    // Step 4: Insert new entries
    for (const entry of (entries || [])) {
      const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        'INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
        [entryId, journalId, entry.accountId || null, entry.accountCode || '', entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '']
      );
    }

    // Step 5: If was posted, apply new balances
    if (jrn.status === 'posted') {
      for (const entry of (entries || [])) {
        if (entry.accountId) {
          const netAmount = (Number(entry.debit) || 0) - (Number(entry.credit) || 0);
          await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [netAmount, entry.accountId]);
        }
      }
    }

    res.json({ success: true, journalNumber: jrn.journal_number });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete journal — reverse balances then delete
router.delete('/gl/journals/:id', async (req, res) => {
  try {
    const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [req.params.id]);
    // Reverse account balances
    for (const e of entries) {
      if (e.account_id) {
        const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [reverseAmount, e.account_id]);
      }
    }
    await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [req.params.id]);
    await db.query('DELETE FROM gl_journals WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Repair: fix gl_entries with NULL account_id by matching account_code
router.post('/gl/repair', async (req, res) => {
  try {
    const [nullEntries] = await db.query('SELECT e.id, e.account_code, e.account_name, e.debit, e.credit FROM gl_entries e WHERE e.account_id IS NULL');
    let fixed = 0, created = 0;
    for (const entry of nullEntries) {
      let accId = null;
      // Try to find by code
      if (entry.account_code) {
        const [rows] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [entry.account_code]);
        if (rows.length) accId = rows[0].id;
      }
      // Try by name
      if (!accId && entry.account_name) {
        const [rows] = await db.query('SELECT id FROM gl_accounts WHERE name_ar LIKE ?', ['%' + (entry.account_name||'').substring(0, 20) + '%']);
        if (rows.length) accId = rows[0].id;
      }
      // Auto-create if custody-related (عهدة) and not found
      if (!accId && entry.account_name && entry.account_name.indexOf('عهدة') >= 0) {
        const personName = entry.account_name.replace(/عهدة\s*/, '').trim();
        if (personName) {
          try {
            // Ensure parent account exists
            const parentCode = '1130';
            const [parentRow] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [parentCode]);
            let parentId = null;
            if (!parentRow.length) {
              const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' OR code = '113' ORDER BY code DESC LIMIT 1");
              parentId = p11.length ? p11[0].id : null;
              await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
                ['GL-1130', '1130', 'عهد الموظفين', 'asset', parentId, 3]);
              parentId = 'GL-1130';
            } else { parentId = parentRow[0].id; }
            // Create child account
            const [children] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '1130%' AND code != '1130' ORDER BY code DESC LIMIT 1");
            let nextCode = '11301';
            if (children.length) { nextCode = '1130' + String((parseInt(children[0].code.replace('1130',''))||0) + 1); }
            const newId = 'GL-' + nextCode;
            await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
              [newId, nextCode, entry.account_name, 'asset', parentId, 4]);
            accId = newId;
            created++;
          } catch(e) { /* Production: removed debug log */ }
        }
      }
      // Also handle مصروفات عهدة
      if (!accId && entry.account_name && entry.account_name.indexOf('مصروفات') >= 0) {
        const [expAcc] = await db.query("SELECT id FROM gl_accounts WHERE type = 'expense' ORDER BY code LIMIT 1");
        if (expAcc.length) accId = expAcc[0].id;
      }
      if (accId) {
        await db.query('UPDATE gl_entries SET account_id = ? WHERE id = ?', [accId, entry.id]);
        fixed++;
      }
    }
    // Recalculate all account balances from posted entries
    await db.query('UPDATE gl_accounts SET balance = 0');
    const [allEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE j.status = 'posted' AND e.account_id IS NOT NULL
       GROUP BY e.account_id`
    );
    for (const e of allEntries) {
      const net = (Number(e.d)||0) - (Number(e.c)||0);
      await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, e.account_id]);
    }
    res.json({ success: true, nullFixed: fixed, accountsCreated: created, totalNull: nullEntries.length, balancesRecalculated: allEntries.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Repair: create GL entries for old custody topups that have no journal
// Fix: restructure to 5 main accounts (merge old 6 into 5)
router.post('/gl/fix-tree', async (req, res) => {
  try {
    let fixed = 0;

    // Force exactly 5 root accounts (level=1, parent=NULL)
    // Valid roots: codes 1,2,3,4,5 (or 6 renamed to 5)
    const validRootCodes = ['1','2','3','4','5'];

    // If code 6 exists as root, merge it into code 5
    const [acc6] = await db.query("SELECT id FROM gl_accounts WHERE code = '6'");
    if (acc6.length) {
      const [acc5] = await db.query("SELECT id FROM gl_accounts WHERE code = '5'");
      if (acc5.length) {
        // Move 6's children under 5
        await db.query("UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?", [acc5[0].id, acc6[0].id]);
        // Delete account 6
        await db.query("DELETE FROM gl_accounts WHERE id = ? AND code = '6'", [acc6[0].id]);
        fixed++;
      } else {
        // Rename 6 to become the root المصروفات (acts as 5)
        await db.query("UPDATE gl_accounts SET code = '5', name_ar = 'المصروفات', parent_id = NULL, level = 1 WHERE id = ?", [acc6[0].id]);
        fixed++;
      }
    }

    // Fix any account with level > 1 that has no parent — find correct parent
    const [orphans] = await db.query("SELECT id, code, level FROM gl_accounts WHERE level > 1 AND (parent_id IS NULL OR parent_id = '')");
    for (const o of orphans) {
      // Find parent by code prefix: e.g. code=11 → parent code=1, code=112 → parent code=11
      let parentCode = o.code.substring(0, o.code.length - 1);
      while (parentCode.length > 0) {
        const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = ?", [parentCode]);
        if (parent.length) {
          await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [parent[0].id, o.id]);
          fixed++;
          break;
        }
        parentCode = parentCode.substring(0, parentCode.length - 1);
      }
    }

    // Ensure all root accounts are level 1
    await db.query("UPDATE gl_accounts SET level = 1, parent_id = NULL WHERE code IN ('1','2','3','4','5') AND (level != 1 OR parent_id IS NOT NULL)");

    res.json({ success: true, fixed });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/gl/repair-topups', async (req, res) => {
  try {
    // Find topups without GL journals
    const [topups] = await db.query(
      `SELECT t.*, c.custody_number, c.user_name, c.user_id
       FROM custody_topups t JOIN custodies c ON t.custody_id = c.id
       WHERE NOT EXISTS (SELECT 1 FROM gl_journals j WHERE j.reference_type = 'custody_topup' AND j.reference_id = t.id)`
    );
    let created = 0;
    for (const t of topups) {
      const amt = Number(t.amount) || 0;
      if (amt <= 0) continue;

      // Find custody user GL account
      let custAccId = null;
      const [custAccRows] = await db.query("SELECT id, code FROM gl_accounts WHERE name_ar LIKE ? AND code LIKE '1130%'", ['عهدة ' + (t.user_name||'').substring(0,20) + '%']);
      if (custAccRows.length) custAccId = custAccRows[0].id;
      if (!custAccId) {
        // Create it
        const parentId = 'GL-1130';
        await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
          [parentId, '1130', 'عهد الموظفين', 'asset', null, 3]);
        const [children] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '1130%' AND code != '1130' ORDER BY code DESC LIMIT 1");
        let nextCode = '11301';
        if (children.length) nextCode = '1130' + String((parseInt(children[0].code.replace('1130',''))||0)+1);
        custAccId = 'GL-' + nextCode;
        await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
          [custAccId, nextCode, 'عهدة ' + (t.user_name||''), 'asset', parentId, 4]);
      }

      // Find a default cash account for old topups (11101)
      let cashAccId = null;
      const [cashAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '11101' OR (code LIKE '1110%' AND type='asset') ORDER BY code LIMIT 1");
      if (cashAcc.length) cashAccId = cashAcc[0].id;

      if (!custAccId) continue;

      const jrnId = 'JRN-REPAIR-' + Date.now() + '-' + created;
      const [lastJrn] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
      let jrnNum = 1;
      if (lastJrn.length && lastJrn[0].journal_number) {
        const m = lastJrn[0].journal_number.match(/(\d+)/);
        if (m) jrnNum = parseInt(m[1]) + 1;
      }
      const journalNumber = 'JV-' + String(jrnNum).padStart(6, '0');
      const desc = 'تغذية عهدة ' + (t.custody_number||'') + ' — ' + (t.user_name||'');

      await db.query(
        `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jrnId, journalNumber, t.created_at || new Date(), 'custody_topup', t.id, desc, amt, amt, 'posted', t.created_by||'', 'repair', new Date()]
      );

      // Debit custody account
      await db.query(
        'INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
        ['GLE-R-'+Date.now()+'-'+created+'D', jrnId, custAccId, '', 'عهدة '+(t.user_name||''), amt, 0, desc]
      );

      // Credit cash (if available)
      if (cashAccId) {
        await db.query(
          'INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          ['GLE-R-'+Date.now()+'-'+created+'C', jrnId, cashAccId, '11101', 'الصندوق', 0, amt, desc]
        );
      }
      created++;
    }

    // Recalculate all balances
    await db.query('UPDATE gl_accounts SET balance = 0');
    const [allEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE j.status = 'posted' AND e.account_id IS NOT NULL
       GROUP BY e.account_id`
    );
    for (const e of allEntries) {
      const net = (Number(e.d)||0) - (Number(e.c)||0);
      await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, e.account_id]);
    }

    res.json({ success: true, topupsProcessed: created, totalTopups: topups.length, balancesRecalculated: allEntries.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Cost Centers (مراكز التكلفة) — v5.10.29 ─────────────────────────
// The cost_centers table is auto-created by routes/inventory.js migrations.
// These endpoints supply the master CRUD that AP/AR/budgets/journal entries
// already FK into.

router.get('/cost-centers', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.branchId)  { where.push('cc.branch_id = ?'); params.push(req.query.branchId); }
    if (req.query.activeOnly === '1') where.push('cc.is_active = 1');
    if (req.query.q) {
      where.push('(cc.name_ar LIKE ? OR cc.name_en LIKE ? OR cc.code LIKE ?)');
      params.push('%'+req.query.q+'%', '%'+req.query.q+'%', '%'+req.query.q+'%');
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT cc.*, b.name AS branch_name, p.name_ar AS parent_name
         FROM cost_centers cc
         LEFT JOIN branches b ON b.id = cc.branch_id
         LEFT JOIN cost_centers p ON p.id = cc.parent_id
        ${whereSql}
        ORDER BY cc.code`, params);
    res.json(rows.map(r => ({
      id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en,
      branchId: r.branch_id || '', branchName: r.branch_name || '',
      parentId: r.parent_id || '', parentName: r.parent_name || '',
      isActive: !!r.is_active, notes: r.notes || '',
      createdAt: r.created_at, createdBy: r.created_by || ''
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/cost-centers', async (req, res) => {
  try {
    const b = req.body || {};
    const nameAr = (b.nameAr || '').trim();
    if (!nameAr) return res.status(400).json({ success:false, error:'name-required' });
    const code = (b.code || '').trim() || null;
    if (code) {
      const [dup] = await db.query(
        'SELECT id FROM cost_centers WHERE code = ?' + (b.id ? ' AND id <> ?' : ''),
        b.id ? [code, b.id] : [code]);
      if (dup.length) return res.status(409).json({ success:false, error:'duplicate-code', conflictId: dup[0].id });
    }
    if (b.id) {
      const [exists] = await db.query('SELECT id FROM cost_centers WHERE id = ?', [b.id]);
      if (!exists.length) return res.status(404).json({ success:false, error:'not-found' });
      await db.query(
        `UPDATE cost_centers SET code=?, name_ar=?, name_en=?, branch_id=?, parent_id=?, is_active=?, notes=? WHERE id=?`,
        [code, nameAr, b.nameEn || null, b.branchId || null, b.parentId || null,
         b.isActive !== false, b.notes || null, b.id]);
      return res.json({ success: true, id: b.id });
    }
    const id = b.id || ('CC-' + Date.now() + '-' + Math.random().toString(36).slice(2,5));
    await db.query(
      `INSERT INTO cost_centers (id, code, name_ar, name_en, branch_id, parent_id, is_active, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, code, nameAr, b.nameEn || null, b.branchId || null, b.parentId || null,
       b.isActive !== false, b.notes || null,
       (req.user && req.user.username) || b.username || 'system']);
    res.status(201).json({ success: true, id });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

router.delete('/cost-centers/:id', async (req, res) => {
  try {
    // Check for children first — refuse to delete a parent
    const [kids] = await db.query('SELECT COUNT(*) AS n FROM cost_centers WHERE parent_id = ?', [req.params.id]);
    if (Number(kids[0].n) > 0) {
      return res.status(409).json({ success:false, error:'has-children', childCount: Number(kids[0].n) });
    }
    // Check for usage in gl_entries / budgets / ap_invoice_lines (best-effort)
    let usage = 0;
    try { const [r] = await db.query('SELECT COUNT(*) AS n FROM gl_entries WHERE cost_center_id = ?', [req.params.id]); usage += Number(r[0].n) || 0; } catch(_){}
    try { const [r] = await db.query('SELECT COUNT(*) AS n FROM budgets WHERE cost_center_id = ?', [req.params.id]); usage += Number(r[0].n) || 0; } catch(_){}
    if (usage > 0) {
      // Soft delete: mark inactive
      await db.query('UPDATE cost_centers SET is_active = 0 WHERE id = ?', [req.params.id]);
      return res.json({ success: true, softDeleted: true, usage });
    }
    await db.query('DELETE FROM cost_centers WHERE id = ?', [req.params.id]);
    res.json({ success: true, hardDeleted: true });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// Diagnostic: check GL data
// v5.10.29 — Enhanced. Now surfaces concrete chart-of-accounts integrity
// issues so the operator can see what needs fixing:
//   • orphans: accounts whose parent_id doesn't match any existing account
//   • typeMismatch: accounts whose type ≠ parent's type (e.g. asset under revenue)
//   • levelMismatch: accounts whose stored level disagrees with computed depth
//   • duplicateCodes: same code used by more than one account
//   • unbalancedJournals: posted journals where SUM(debit) ≠ SUM(credit)
//   • orphanEntries: entries pointing at deleted accounts
//   • missingCoreAccounts: required core accounts (CASH/INVENTORY/COGS…) absent
router.get('/gl/diagnose', async (req, res) => {
  try {
    const CORE_CODES = ['1110','1120','1150','1200','2100','2210','3100','4100','5100','5200','5300'];

    const [accs] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    const [jrns] = await db.query('SELECT COUNT(*) AS cnt, status FROM gl_journals GROUP BY status');
    const [nullEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NULL');
    const [validEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NOT NULL');
    const [nonZeroAccs] = await db.query('SELECT code, name_ar, type, balance FROM gl_accounts WHERE balance != 0 ORDER BY code');

    // Orphans: parent_id set but no matching parent row
    const [orphans] = await db.query(
      `SELECT a.id, a.code, a.name_ar, a.type, a.parent_id
         FROM gl_accounts a
        WHERE a.parent_id IS NOT NULL
          AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);

    // Type mismatch with parent
    const [typeMismatch] = await db.query(
      `SELECT c.id, c.code, c.name_ar, c.type AS child_type,
              p.code AS parent_code, p.name_ar AS parent_name, p.type AS parent_type
         FROM gl_accounts c
         JOIN gl_accounts p ON p.id = c.parent_id
        WHERE c.type IS NOT NULL AND p.type IS NOT NULL AND c.type <> p.type`);

    // Duplicate codes
    const [dupCodes] = await db.query(
      `SELECT code, COUNT(*) AS n FROM gl_accounts WHERE code IS NOT NULL GROUP BY code HAVING n > 1`);

    // Unbalanced posted journals
    const [unbalanced] = await db.query(
      `SELECT j.id, j.journal_number, j.journal_date, j.description,
              ROUND(SUM(e.debit), 4)  AS total_debit,
              ROUND(SUM(e.credit), 4) AS total_credit
         FROM gl_journals j JOIN gl_entries e ON e.journal_id = j.id
        WHERE j.status = 'posted'
        GROUP BY j.id
       HAVING ABS(IFNULL(total_debit,0) - IFNULL(total_credit,0)) > 0.01
        ORDER BY j.journal_date DESC LIMIT 20`);

    // Entries pointing at deleted accounts (account_id set but row missing)
    const [orphanEntries] = await db.query(
      `SELECT e.id, e.journal_id, e.account_id, e.account_code, e.account_name, e.debit, e.credit
         FROM gl_entries e
        WHERE e.account_id IS NOT NULL
          AND e.account_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)
        LIMIT 50`);

    // Missing core accounts
    const ph = CORE_CODES.map(() => '?').join(',');
    const [presentCore] = await db.query(
      `SELECT code FROM gl_accounts WHERE code IN (${ph})`, CORE_CODES);
    const presentSet = new Set(presentCore.map(r => r.code));
    const missingCoreAccounts = CORE_CODES.filter(c => !presentSet.has(c));

    // Computed levels: walk parent chain and compare against stored level
    const [allAccs] = await db.query('SELECT id, code, name_ar, parent_id, level FROM gl_accounts');
    const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
    const computeDepth = function(a, seen) {
      if (!a || !a.parent_id) return 0;
      if (seen.has(a.id)) return -1; // cycle
      seen.add(a.id);
      const p = byId[a.parent_id];
      if (!p) return 0;  // orphan; treat as root
      const d = computeDepth(p, seen);
      return d < 0 ? d : d + 1;
    };
    const levelMismatch = [];
    const cycles = [];
    for (const a of allAccs) {
      const d = computeDepth(a, new Set());
      if (d < 0) { cycles.push({ id: a.id, code: a.code, name_ar: a.name_ar }); continue; }
      if (Number(a.level || 0) !== d) {
        levelMismatch.push({ id: a.id, code: a.code, name_ar: a.name_ar, storedLevel: a.level, computedLevel: d });
      }
    }

    const [recentEntries] = await db.query(
      `SELECT e.account_id, e.account_code, e.account_name, e.debit, e.credit, j.journal_number, j.status, j.description
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id ORDER BY j.created_at DESC LIMIT 10`
    );

    // ─── v5.10.38 — three new integrity checks ───

    // (9) code prefix vs type mismatch
    //     e.g. account with code starting "11" (asset family) but type='liability'
    const [codeTypeMismatch] = await db.query(
      `SELECT id, code, name_ar, type FROM gl_accounts
        WHERE code IS NOT NULL AND (
          (LEFT(code,1)='1' AND type<>'asset')      OR
          (LEFT(code,1)='2' AND type<>'liability')  OR
          (LEFT(code,1)='3' AND type<>'equity')     OR
          (LEFT(code,1)='4' AND type<>'revenue')    OR
          (LEFT(code,1)='5' AND type<>'expense'))
        ORDER BY code`);

    // (10) THE USER'S COMPLAINT: balance != 0 but no posted journal entries
    //      means the gl_accounts.balance column is a "zombie" — a number
    //      not backed by any actual journal. Fix = recompute from gl_entries.
    const [balanceWithoutEntries] = await db.query(
      `SELECT a.id, a.code, a.name_ar, a.type, a.balance
         FROM gl_accounts a
        WHERE ABS(IFNULL(a.balance,0)) > 0.001
          AND NOT EXISTS (SELECT 1 FROM gl_entries e
                            JOIN gl_journals j ON j.id = e.journal_id
                           WHERE e.account_id = a.id AND j.status='posted')
        ORDER BY a.code`);

    // (11) account name strongly hints at a category but its placement
    //      disagrees (e.g. "بنك القاهرة" parented under inventory).
    //      Re-uses _COA_KEYWORD_RULES to compute expected root.
    // (12) v5.10.40 — root code mismatch: code starts with digit X but
    //      actual root ancestor is a different digit. Catches cases like
    //      "41 الإيرادات التشغيلية" sitting under root 5 (cost of sales).
    const nameVsPlacementMismatch = [];
    const rootCodeMismatch = [];
    {
      const [allAccs2] = await db.query('SELECT id, code, name_ar, parent_id FROM gl_accounts');
      const byId2 = {}; allAccs2.forEach(a => { byId2[a.id] = a; });
      const ascendantCode = function(a) {
        let walker = a, hops = 0;
        const seen = new Set();
        while (walker && walker.parent_id) {
          if (seen.has(walker.id)) return null;
          seen.add(walker.id);
          walker = byId2[walker.parent_id] || null;
          if (++hops > 50) return null;
        }
        return walker ? walker.code : null;
      };
      for (const a of allAccs2) {
        const codeStr = String(a.code || '');
        const codeRoot = codeStr.charAt(0);
        const actualRoot = ascendantCode(a);

        // (12) — code's first digit must match the root ancestor
        if (codeRoot && actualRoot && ['1','2','3','4','5'].indexOf(codeRoot) >= 0
            && actualRoot !== codeRoot) {
          rootCodeMismatch.push({
            id: a.id, code: a.code, name_ar: a.name_ar,
            expectedRootCode: codeRoot,
            actualRootCode: actualRoot
          });
        }

        // (11) — name keyword vs actual placement
        const name = String(a.name_ar || '');
        if (!name) continue;
        let rule = null;
        for (const [re, parentCode, label] of _COA_KEYWORD_RULES) {
          if (re.test(name)) { rule = { parentCode, label }; break; }
        }
        if (!rule) continue;
        const expectedRoot = rule.parentCode.charAt(0);
        if (actualRoot && actualRoot !== expectedRoot) {
          nameVsPlacementMismatch.push({
            id: a.id, code: a.code, name_ar: a.name_ar,
            expectedParentCode: rule.parentCode, expectedLabel: rule.label,
            actualRootCode: actualRoot
          });
        }
      }
    }

    const issuesCount =
      orphans.length + typeMismatch.length + dupCodes.length +
      unbalanced.length + orphanEntries.length + missingCoreAccounts.length +
      levelMismatch.length + cycles.length +
      codeTypeMismatch.length + balanceWithoutEntries.length +
      nameVsPlacementMismatch.length + rootCodeMismatch.length;

    res.json({
      summary: {
        accounts: accs[0].cnt,
        journals: jrns,
        nullEntries: nullEntries[0].cnt,
        validEntries: validEntries[0].cnt,
        issuesCount,
        healthy: issuesCount === 0
      },
      issues: {
        orphans,
        typeMismatch,
        duplicateCodes: dupCodes,
        unbalancedJournals: unbalanced,
        orphanEntries,
        missingCoreAccounts,
        levelMismatch,
        cycles,
        // v5.10.38
        codeTypeMismatch,
        balanceWithoutEntries,
        nameVsPlacementMismatch,
        // v5.10.40
        rootCodeMismatch
      },
      nonZeroAccounts: nonZeroAccs,
      recentEntries
    });
  } catch(e) { res.json({ error: e.message }); }
});

// v5.10.29 — Auto-fix safe issues found by /gl/diagnose:
//   • orphans → set parent_id to NULL (promote to root)
//   • level mismatches → recompute level from actual parent depth
// Does NOT touch type mismatches (operator decision), duplicate codes
// (need merge strategy), or unbalanced journals (need accounting review).
router.post('/gl/auto-fix', async (req, res) => {
  try {
    const result = { orphansPromoted: 0, levelsCorrected: 0 };

    // 1. Orphans → root
    const [orphans] = await db.query(
      `SELECT a.id FROM gl_accounts a
        WHERE a.parent_id IS NOT NULL
          AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
    for (const o of orphans) {
      await db.query('UPDATE gl_accounts SET parent_id = NULL, level = 0 WHERE id = ?', [o.id]);
      result.orphansPromoted++;
    }

    // 2. Recompute levels for everyone
    const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
    const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
    const depth = function(a, seen) {
      if (!a || !a.parent_id) return 0;
      if (seen.has(a.id)) return 0;
      seen.add(a.id);
      const p = byId[a.parent_id];
      return p ? depth(p, seen) + 1 : 0;
    };
    for (const a of allAccs) {
      const d = depth(a, new Set());
      if (Number(a.level || 0) !== d) {
        await db.query('UPDATE gl_accounts SET level = ? WHERE id = ?', [d, a.id]);
        result.levelsCorrected++;
      }
    }

    res.json({ success: true, ...result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Inventory Method & Valuation ───

// Get/Set inventory method
router.get('/inventory-method', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    res.json({ method: rows.length ? rows[0].setting_value : 'perpetual' });
  } catch(e) { res.json({ method: 'perpetual' }); }
});
router.post('/inventory-method', async (req, res) => {
  try {
    const { method } = req.body;
    if (!['perpetual','periodic'].includes(method)) return res.json({ success: false, error: 'Invalid method' });
    await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('inventory_method',?) ON DUPLICATE KEY UPDATE setting_value=?", [method, method]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Inventory valuation — real-time stock value (per-warehouse or aggregated)
router.get('/inventory-valuation', async (req, res) => {
  try {
    const { brand_id, warehouse_id, by } = req.query; // by = 'warehouse' | 'brand' | 'category'
    const [methodRow] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    const method = methodRow.length ? methodRow[0].setting_value : 'perpetual';

    // If per-warehouse/brand breakdown requested — use warehouse_stock
    if (by === 'warehouse' || by === 'brand' || warehouse_id || brand_id) {
      // Detect whether Phase-3 avg_cost column exists on warehouse_stock
      let hasAvgCost = false;
      try {
        const [cols] = await db.query("SHOW COLUMNS FROM warehouse_stock LIKE 'avg_cost'");
        hasAvgCost = cols.length > 0;
      } catch(e) { hasAvgCost = false; }

      const costExpr = hasAvgCost
        ? 'COALESCE(NULLIF(ws.avg_cost, 0), i.cost, 0)'
        : 'COALESCE(i.cost, 0)';

      let sql = `
        SELECT ws.warehouse_id, w.name AS warehouse_name, w.brand_id, COALESCE(br.name,'') AS brand_name,
               ws.item_id, i.name AS item_name, i.category, i.unit,
               ${costExpr} AS cost,
               COALESCE(ws.qty, 0) AS qty
        FROM warehouse_stock ws
        JOIN warehouses w ON ws.warehouse_id = w.id
        LEFT JOIN brands br ON w.brand_id = br.id
        JOIN inv_items i ON ws.item_id = i.id
        WHERE COALESCE(i.active,1) = 1 AND COALESCE(w.is_active,1) = 1`;
      const params = [];
      if (brand_id) { sql += ' AND w.brand_id = ?'; params.push(brand_id); }
      if (warehouse_id) { sql += ' AND ws.warehouse_id = ?'; params.push(warehouse_id); }
      sql += ' ORDER BY w.name, i.name';
      let rows = [];
      try {
        const [r] = await db.query(sql, params);
        rows = r;
      } catch(e) {
        // warehouse_stock may not exist yet — fall through to inv_items path
        console.warn('[inventory-valuation] warehouse_stock query failed, falling back:', e.message);
        rows = [];
      }

      // If we got rows from warehouse_stock, use them
      if (rows.length) {
        const byBrand = {}, byWarehouse = {}, byCategory = {};
        let totalValue = 0; let totalQty = 0;
        rows.forEach(r => {
          const val = (Number(r.qty)||0) * (Number(r.cost)||0);
          totalValue += val;
          totalQty += Number(r.qty) || 0;

          const bKey = r.brand_id || 'no_brand';
          if (!byBrand[bKey]) byBrand[bKey] = { brandId: r.brand_id, brandName: r.brand_name || 'بدون براند', totalValue: 0, items: 0 };
          byBrand[bKey].totalValue += val; byBrand[bKey].items++;

          if (!byWarehouse[r.warehouse_id]) byWarehouse[r.warehouse_id] = { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, brandName: r.brand_name, totalValue: 0, items: [] };
          byWarehouse[r.warehouse_id].totalValue += val;
          byWarehouse[r.warehouse_id].items.push({ name: r.item_name, qty: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit, category: r.category });

          const cat = r.category || 'أخرى';
          if (!byCategory[cat]) byCategory[cat] = { totalValue: 0, items: [] };
          byCategory[cat].totalValue += val;
          byCategory[cat].items.push({ name: r.item_name, stock: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit });
        });
        return res.json({ method, totalValue, totalQty, itemCount: rows.length, byBrand, byWarehouse, categories: byCategory });
      }
      // If warehouse_stock query returned no rows, fall through to inv_items aggregate
    }

    // Default: aggregate from inv_items (used when no warehouse_stock data yet)
    const [items] = await db.query(
      "SELECT id, name, category, COALESCE(cost,0) AS cost, COALESCE(stock,0) AS stock, unit " +
      "FROM inv_items WHERE COALESCE(active,1) = 1");
    const categories = {};
    const byBrand = {};
    let totalValue = 0;
    items.forEach(i => {
      const cat = i.category || 'أخرى';
      if (!categories[cat]) categories[cat] = { items: [], totalValue: 0 };
      const val = (Number(i.stock)||0) * (Number(i.cost)||0);
      categories[cat].items.push({ name: i.name, stock: Number(i.stock)||0, cost: Number(i.cost)||0, value: val, unit: i.unit });
      categories[cat].totalValue += val;
      totalValue += val;
    });
    res.json({ method, categories, totalValue, itemCount: items.length, byBrand: {}, byWarehouse: {} });
  } catch(e) {
    console.error('[inventory-valuation] error:', e);
    res.json({ method: 'perpetual', categories: {}, totalValue: 0, itemCount: 0, byBrand: {}, byWarehouse: {}, error: e.message });
  }
});

// Sync inventory GL accounts — create accounts for each category under 112
router.post('/gl/sync-inventory', async (req, res) => {
  try {
    // Ensure parent 112 exists
    const [p112] = await db.query("SELECT id FROM gl_accounts WHERE code = '112'");
    let parentId = p112.length ? p112[0].id : null;
    if (!parentId) {
      const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11'");
      parentId = 'GL-112';
      await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [parentId, '112', 'المخزون', 'asset', p11.length ? p11[0].id : null, 3]);
    }

    // Get inventory categories
    const [cats] = await db.query('SELECT DISTINCT category FROM inv_items WHERE active = 1 AND category IS NOT NULL AND category != ""');
    let created = 0;

    // Get existing children of 112
    const [existing] = await db.query("SELECT code, name_ar FROM gl_accounts WHERE code LIKE '112%' AND code != '112' ORDER BY code");
    const existingNames = existing.map(e => e.name_ar.toLowerCase());

    for (const cat of cats) {
      const catName = 'مخزون ' + cat.category;
      if (existingNames.includes(catName.toLowerCase())) continue; // Already exists

      // Find next code
      const [lastChild] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '112%' AND code != '112' ORDER BY code DESC LIMIT 1");
      let nextCode = '11201';
      if (lastChild.length) {
        const num = parseInt(lastChild[0].code.replace('112','')) || 0;
        nextCode = '112' + String(num + 1).padStart(2, '0');
      }
      const id = 'GL-' + nextCode;
      await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [id, nextCode, catName, 'asset', parentId, 4]);

      // Update balance with current stock value for this category
      const [catItems] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE category = ? AND active = 1', [cat.category]);
      const catValue = Number(catItems[0].val) || 0;
      if (catValue > 0) await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [catValue, id]);
      created++;
    }

    // Update ALL existing inventory category balances (perpetual sync)
    const [allInvAccounts] = await db.query("SELECT id, name_ar FROM gl_accounts WHERE code LIKE '112%' AND code != '112'");
    for (const acc of allInvAccounts) {
      // Extract category name from "مخزون X" → "X"
      const catName = (acc.name_ar || '').replace(/^مخزون\s*/, '');
      if (catName) {
        const [catVal] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE category = ? AND active = 1', [catName]);
        await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [Number(catVal[0].val)||0, acc.id]);
      }
    }

    // Update parent 112 balance (total of all inventory)
    const [totalVal] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE active = 1');
    if (parentId) await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [Number(totalVal[0].val)||0, parentId]);

    res.json({ success: true, categoriesCreated: created, totalCategories: cats.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Financial Reports ───

// Trial Balance — Professional (ميزان المراجعة)
// Returns: opening balance + period movement + closing balance for ALL accounts
router.get('/reports/trial-balance', async (req, res) => {
  try {
    const { startDate, endDate, accountType, createdBy } = req.query;
    const [accounts] = await db.query('SELECT * FROM gl_accounts WHERE is_active = 1 ORDER BY code');

    // Build journal filter for period (exclude opening entries — they go to opening balance)
    let jrnWhere = "j.status = 'posted' AND j.reference_type != 'opening'";
    const jrnParams = [];
    if (startDate) { jrnWhere += ' AND DATE(j.journal_date) >= ?'; jrnParams.push(startDate); }
    if (endDate) { jrnWhere += ' AND DATE(j.journal_date) <= ?'; jrnParams.push(endDate); }
    if (createdBy) { jrnWhere += ' AND j.created_by = ?'; jrnParams.push(createdBy); }

    // Get period movements (non-opening posted journals)
    const [periodEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${jrnWhere} GROUP BY e.account_id`, jrnParams
    );
    const periodMap = {};
    periodEntries.forEach(e => { periodMap[e.account_id] = { debit: Number(e.totalDebit)||0, credit: Number(e.totalCredit)||0 }; });

    // Opening balance = ALL opening entries + non-opening entries BEFORE startDate
    let openMap = {};
    // 1. Opening entries (always included regardless of date — IAS 1)
    const [openingEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE j.status = 'posted' AND j.reference_type = 'opening'
       GROUP BY e.account_id`
    );
    openingEntries.forEach(e => {
      openMap[e.account_id] = { debit: Number(e.totalDebit)||0, credit: Number(e.totalCredit)||0 };
    });
    // 2. Non-opening entries before startDate
    if (startDate) {
      const [priorEntries] = await db.query(
        `SELECT e.account_id, SUM(e.debit) AS totalDebit, SUM(e.credit) AS totalCredit
         FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
         WHERE j.status = 'posted' AND j.reference_type != 'opening' AND DATE(j.journal_date) < ?
         GROUP BY e.account_id`, [startDate]
      );
      priorEntries.forEach(e => {
        if (!openMap[e.account_id]) openMap[e.account_id] = { debit: 0, credit: 0 };
        openMap[e.account_id].debit += Number(e.totalDebit)||0;
        openMap[e.account_id].credit += Number(e.totalCredit)||0;
      });
    }

    const typeLabels = {asset:'أصول',liability:'التزامات',equity:'حقوق ملكية',revenue:'إيرادات',expense:'مصروفات'};
    const rows = [];
    let totals = { openDebit:0, openCredit:0, periodDebit:0, periodCredit:0, closeDebit:0, closeCredit:0 };

    accounts.forEach(a => {
      if (accountType && a.type !== accountType) return;

      const open = openMap[a.id] || { debit: 0, credit: 0 };
      const period = periodMap[a.id] || { debit: 0, credit: 0 };

      // Opening net balance
      const openNet = open.debit - open.credit;
      let openDebit = 0, openCredit = 0;
      if (a.type === 'asset' || a.type === 'expense') {
        if (openNet >= 0) openDebit = openNet; else openCredit = Math.abs(openNet);
      } else {
        if (openNet <= 0) openCredit = Math.abs(openNet); else openDebit = openNet;
      }

      // Closing net = opening + period
      const closeNet = openNet + (period.debit - period.credit);
      let closeDebit = 0, closeCredit = 0;
      if (a.type === 'asset' || a.type === 'expense') {
        if (closeNet >= 0) closeDebit = closeNet; else closeCredit = Math.abs(closeNet);
      } else {
        if (closeNet <= 0) closeCredit = Math.abs(closeNet); else closeDebit = closeNet;
      }

      totals.openDebit += openDebit; totals.openCredit += openCredit;
      totals.periodDebit += period.debit; totals.periodCredit += period.credit;
      totals.closeDebit += closeDebit; totals.closeCredit += closeCredit;

      rows.push({
        code: a.code, nameAR: a.name_ar, type: a.type, typeLabel: typeLabels[a.type]||a.type,
        level: a.level, parentId: a.parent_id,
        openDebit, openCredit,
        periodDebit: period.debit, periodCredit: period.credit,
        closeDebit, closeCredit
      });
    });

    res.json({
      isBalanced: Math.abs(totals.closeDebit - totals.closeCredit) < 0.01,
      rows, totals
    });
  } catch (e) { res.json({ isBalanced: false, rows: [], totals: {} }); }
});

// Income Statement — IFRS / IAS 1 (قائمة الدخل)
router.get('/reports/income', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [accounts] = await db.query("SELECT * FROM gl_accounts WHERE is_active = 1 ORDER BY code");

    // Get period balances from gl_entries (not gl_accounts.balance)
    let where = "j.status = 'posted'";
    const params = [];
    if (startDate) { where += ' AND DATE(j.journal_date) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(endDate); }
    const [entries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${where} GROUP BY e.account_id`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = (Number(e.c)||0) - (Number(e.d)||0); }); // credit-positive for revenue

    // Classify accounts by code prefix (IFRS categories)
    // 4x = Revenue, 5x = COGS, 6x = Operating Expenses
    const revenue = [], cogs = [], opex = [], otherIncome = [], otherExpense = [];
    let totalRevenue = 0, totalCOGS = 0, totalOpex = 0, totalOtherInc = 0, totalOtherExp = 0;

    accounts.forEach(a => {
      const net = balMap[a.id] || 0;
      if (net === 0 && !a.code.match(/^[456]/)) return;
      const bal = Math.abs(net);
      const item = { code: a.code, name: a.name_ar, balance: bal, level: a.level };

      if (a.type === 'revenue') {
        if (a.code.startsWith('42')) { otherIncome.push(item); totalOtherInc += bal; }
        else { revenue.push(item); totalRevenue += bal; }
      } else if (a.type === 'expense') {
        if (a.code.startsWith('5')) { cogs.push(item); totalCOGS += bal; }
        else if (a.code.startsWith('62') || a.code.startsWith('63') || a.code.startsWith('64')) { otherExpense.push(item); totalOtherExp += bal; }
        else { opex.push(item); totalOpex += bal; }
      }
    });

    const grossProfit = totalRevenue - totalCOGS;
    const operatingIncome = grossProfit - totalOpex;
    const netIncome = operatingIncome + totalOtherInc - totalOtherExp;

    res.json({
      // IFRS sections
      revenue, totalRevenue,
      cogs, totalCOGS,
      grossProfit,
      opex, totalOpex,
      operatingIncome,
      otherIncome, totalOtherInc,
      otherExpense, totalOtherExp,
      netIncome,
      period: { startDate: startDate || null, endDate: endDate || null }
    });
  } catch (e) { res.json({ revenue:[], cogs:[], opex:[], otherIncome:[], otherExpense:[], totalRevenue:0, totalCOGS:0, grossProfit:0, totalOpex:0, operatingIncome:0, totalOtherInc:0, totalOtherExp:0, netIncome:0 }); }
});

// Balance Sheet — IFRS / IAS 1 (الميزانية العمومية)
//
// V5.10.4 — moved to /reports/balance-sheet-ifrs to escape the legacy
// /reports/balance-sheet handler in routes/erp-core.js (which mounts FIRST
// and was shadowing this endpoint, returning the old V3 shape that the
// v5.10.2 IFRS UI couldn't read).
//
// Filters:
//   asOfDate    — cutoff date (default: today)
//   brandId     — restrict to entries tagged with brand (when column exists)
//   branchId    — restrict to entries tagged with branch (when column exists)
//   showZero    — '1' to include zero-balance accounts (default: only non-zero)
router.get('/reports/balance-sheet-ifrs', async (req, res) => {
  try {
    const { asOfDate, brandId, branchId, showZero } = req.query;
    const includeZero = showZero === '1' || showZero === 'true';
    const [accounts] = await db.query("SELECT * FROM gl_accounts WHERE is_active = 1 ORDER BY code");

    // Detect dimension columns once so the brand/branch filters degrade
    // gracefully when the columns haven't been added to gl_entries yet.
    const [dimCols] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'brand_id'");
    const hasBrandId = dimCols.length > 0;
    const [dimCols2] = await db.query("SHOW COLUMNS FROM gl_entries LIKE 'branch_id'");
    const hasBranchId = dimCols2.length > 0;

    // Get balances from gl_entries up to asOfDate
    let where = "j.status = 'posted'";
    const params = [];
    if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
    if (brandId  && hasBrandId)  { where += ' AND (e.brand_id IS NULL OR e.brand_id = ?)';   params.push(brandId); }
    if (branchId && hasBranchId) { where += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
    const [entries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c, COUNT(e.id) AS cnt
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${where} GROUP BY e.account_id`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = { debit: Number(e.d)||0, credit: Number(e.c)||0, count: Number(e.cnt)||0 }; });

    // V5.10.2 — IFRS / IAS 1 hierarchical classification.
    // Each leaf account carries `id` so the frontend can drill down via
    // the existing /erp/gl/account-ledger/:id endpoint.
    function makeGroup(label, isContra) {
      return { label: label, total: 0, accounts: [], isContra: !!isContra };
    }
    const groups = {
      currentAssets: {
        cash:        makeGroup('النقد وما في حكمه'),
        inventory:   makeGroup('المخزون'),
        receivables: makeGroup('الذمم المدينة'),
        otherCA:     makeGroup('أصول متداولة أخرى')
      },
      nonCurrentAssets: {
        ppe:         makeGroup('الممتلكات والمعدات (PP&E)'),
        accDep:      makeGroup('مجمَّع الإهلاك', true)
      },
      currentLiab: {
        payables:  makeGroup('الذمم الدائنة (موردون)'),
        accrued:   makeGroup('المصروفات المستحقة'),
        taxes:     makeGroup('ضرائب مستحقة'),
        otherCL:   makeGroup('التزامات متداولة أخرى')
      },
      nonCurrentLiab: {
        longTermDebt: makeGroup('قروض ومطلوبات طويلة الأجل')
      },
      equity: {
        capital:      makeGroup('رأس المال'),
        retained:     makeGroup('الأرباح المحتجزة'),
        drawings:     makeGroup('المسحوبات', true),
        periodIncome: makeGroup('صافي ربح/خسارة الفترة')
      }
    };

    function classifyAsset(code) {
      const c = String(code || '');
      if (c.startsWith('1101') || c.startsWith('1102')) return ['currentAssets', 'cash'];
      if (c.startsWith('1125') || c.startsWith('113'))  return ['currentAssets', 'receivables'];
      if (c.startsWith('112'))                          return ['currentAssets', 'inventory'];
      if (c.startsWith('114') || c.startsWith('115'))   return ['currentAssets', 'otherCA'];
      if (c.startsWith('124'))                          return ['nonCurrentAssets', 'accDep'];
      if (c.startsWith('12'))                           return ['nonCurrentAssets', 'ppe'];
      // Anything else under root 1 → other current assets fallback
      if (c.startsWith('11'))                           return ['currentAssets', 'otherCA'];
      return null;
    }
    function classifyLiability(code) {
      const c = String(code || '');
      if (c.startsWith('211')) return ['currentLiab', 'payables'];
      if (c.startsWith('212')) return ['currentLiab', 'accrued'];
      if (c.startsWith('213')) return ['currentLiab', 'taxes'];
      if (c.startsWith('22'))  return ['nonCurrentLiab', 'longTermDebt'];
      if (c.startsWith('21'))  return ['currentLiab', 'otherCL'];
      return null;
    }
    function classifyEquity(code) {
      const c = String(code || '');
      if (c.startsWith('31')) return ['equity', 'capital'];
      if (c.startsWith('32')) return ['equity', 'retained'];
      if (c.startsWith('33')) return ['equity', 'drawings'];
      return ['equity', 'capital'];
    }

    // Backward-compat flat arrays
    const currentAssets = [], nonCurrentAssets = [], currentLiab = [], nonCurrentLiab = [], equityItems = [];
    let totCA = 0, totNCA = 0, totCL = 0, totNCL = 0, totEq = 0;
    let netIncome = 0;

    // v5.10.38 — collect accounts that don't fit any classification rule
    // so the UI can surface a "Unclassified" warning section.
    const unclassified = [];

    accounts.forEach(a => {
      const entry = balMap[a.id] || { debit: 0, credit: 0, count: 0 };
      const net = entry.debit - entry.credit; // debit-normal
      // v5.10.38 — primary filter: no posted journal entries means no
      // display, regardless of stored balance. The COA tree and the
      // balance sheet must agree: numbers shown ⇒ backed by gl_entries.
      if ((entry.count || 0) === 0 && !includeZero) return;
      // Secondary filter: belt-and-suspenders against zombie balances.
      if (Math.abs(net) < 0.001 && !includeZero) return;

      const flatItem = { id: a.id, code: a.code, name: a.name_ar, balance: 0, level: a.level };

      if (a.type === 'asset') {
        flatItem.balance = net;
        const cls = classifyAsset(a.code);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          groups[cls[0]][cls[1]].accounts.push({ id: a.id, code: a.code, nameAr: a.name_ar, balance: net });
          groups[cls[0]][cls[1]].total += net;
        } else {
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: net });
        }
        if (a.code && a.code.startsWith('12')) { nonCurrentAssets.push(flatItem); totNCA += net; }
        else                                    { currentAssets.push(flatItem);   totCA  += net; }
      } else if (a.type === 'liability') {
        flatItem.balance = Math.abs(net);
        const cls = classifyLiability(a.code);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          groups[cls[0]][cls[1]].accounts.push({ id: a.id, code: a.code, nameAr: a.name_ar, balance: Math.abs(net) });
          groups[cls[0]][cls[1]].total += Math.abs(net);
        } else {
          unclassified.push({ id: a.id, code: a.code, nameAr: a.name_ar, type: a.type, balance: Math.abs(net) });
        }
        if (a.code && a.code.startsWith('22')) { nonCurrentLiab.push(flatItem); totNCL += Math.abs(net); }
        else                                    { currentLiab.push(flatItem);    totCL  += Math.abs(net); }
      } else if (a.type === 'equity') {
        flatItem.balance = Math.abs(net);
        const cls = classifyEquity(a.code);
        if (cls && groups[cls[0]] && groups[cls[0]][cls[1]]) {
          groups[cls[0]][cls[1]].accounts.push({ id: a.id, code: a.code, nameAr: a.name_ar, balance: Math.abs(net) });
          groups[cls[0]][cls[1]].total += Math.abs(net);
        }
        equityItems.push(flatItem);
        totEq += Math.abs(net);
      } else if (a.type === 'revenue') {
        netIncome += (entry.credit - entry.debit);
      } else if (a.type === 'expense') {
        netIncome -= (entry.debit - entry.credit);
      }
    });

    // Net income → period income sub-group + flat equity item
    if (Math.abs(netIncome) > 0.01) {
      equityItems.push({ id: '__period_income__', code: '', name: 'صافي ربح/خسارة الفترة', balance: netIncome, level: 3, isComputed: true });
      groups.equity.periodIncome.accounts.push({
        id: '__period_income__', code: '', nameAr: 'صافي ربح/خسارة الفترة',
        balance: netIncome, isComputed: true
      });
      groups.equity.periodIncome.total += netIncome;
      totEq += netIncome;
    }

    const totalAssets = totCA + totNCA;
    const totalLiabilities = totCL + totNCL;

    res.json({
      // Backward-compat shape
      currentAssets, totCA, nonCurrentAssets, totNCA, totalAssets,
      currentLiab, totCL, nonCurrentLiab, totNCL, totalLiabilities,
      equityItems, totEq,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totEq)) < 0.01,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      // V5.10.2 — IFRS hierarchy for the new statement view
      groups: groups,
      // v5.10.38 — accounts that didn't match any classification rule
      unclassified: unclassified
    });
  } catch (e) { res.json({ currentAssets:[], nonCurrentAssets:[], currentLiab:[], nonCurrentLiab:[], equityItems:[], totCA:0, totNCA:0, totCL:0, totNCL:0, totEq:0, totalAssets:0, totalLiabilities:0, netIncome:0, isBalanced:false, groups:{}, unclassified:[] }); }
});

// V5.10.1 — Cash Flow Statement (IAS 7 — Indirect Method)
//
// Builds the third primary financial statement from posted journal entries.
// The indirect method starts with net income and adjusts for:
//   1. Non-cash items (depreciation — code 124)
//   2. Working-capital changes (Δ in current assets / liabilities)
//   3. Investing activities (Δ in fixed assets)
//   4. Financing activities (Δ in equity / drawings / loans)
// The closing reconciliation matches the period's actual cash & bank
// movement (codes 1101 + 1102) — they should agree to the cent if the
// books are clean.
//
// All numbers are pulled from gl_entries joined to posted gl_journals.
// Filters: from/to dates, brandId (entries.brand_id if set), branchId,
// showZero (when '1', keeps zero-amount line items in each section).
//
// V5.10.4 — moved to /reports/cash-flow-ias7 because routes/erp-core.js
// also has a /reports/cash-flow handler (direct method, V3 shape) and the
// frontend v5.10.1 IAS 7 indirect-method UI was being shadowed.
router.get('/reports/cash-flow-ias7', async (req, res) => {
  try {
    const { from, to, brandId, branchId, showZero } = req.query;
    const includeZero = showZero === '1' || showZero === 'true';
    if (!from || !to) return res.json({ error: 'from + to required' });

    // Build a parameterised entry query that we'll reuse twice — once for
    // opening balances (anything before `from`) and once for the period
    // movement (between `from` and `to`).
    function balQuery(asOfClause, params) {
      let sql = `
        SELECT a.id, a.code, a.name_ar, a.type,
               COALESCE(SUM(e.debit), 0)  AS debit,
               COALESCE(SUM(e.credit), 0) AS credit
        FROM gl_accounts a
        LEFT JOIN gl_entries e ON e.account_id = a.id
        LEFT JOIN gl_journals j ON j.id = e.journal_id
        WHERE COALESCE(a.is_active, 1) = 1
          AND (j.status IS NULL OR j.status = 'posted')
          AND (j.id IS NULL OR ${asOfClause})`;
      // Optional brand/branch filter on the entry itself (when columns exist).
      if (brandId)  { sql += ' AND (e.brand_id  IS NULL OR e.brand_id = ?)';  params.push(brandId); }
      if (branchId) { sql += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; params.push(branchId); }
      sql += ' GROUP BY a.id, a.code, a.name_ar, a.type ORDER BY a.code';
      return [sql, params];
    }

    // Opening balances: every posted entry before `from`.
    let [oSql, oParams] = balQuery('DATE(j.journal_date) < ?', [from]);
    const [openingRows] = await db.query(oSql, oParams);

    // Closing balances: every posted entry on or before `to`.
    let [cSql, cParams] = balQuery('DATE(j.journal_date) <= ?', [to]);
    const [closingRows] = await db.query(cSql, cParams);

    // Period revenue / expense (between from..to) — gives us net income.
    const piParams = [from, to];
    let piSql = `
      SELECT a.code, a.type,
             COALESCE(SUM(e.debit), 0)  AS debit,
             COALESCE(SUM(e.credit), 0) AS credit
      FROM gl_accounts a
      JOIN gl_entries e ON e.account_id = a.id
      JOIN gl_journals j ON j.id = e.journal_id
      WHERE j.status = 'posted'
        AND DATE(j.journal_date) >= ? AND DATE(j.journal_date) <= ?
        AND a.type IN ('revenue','expense')`;
    if (brandId)  { piSql += ' AND (e.brand_id  IS NULL OR e.brand_id = ?)';  piParams.push(brandId); }
    if (branchId) { piSql += ' AND (e.branch_id IS NULL OR e.branch_id = ?)'; piParams.push(branchId); }
    piSql += ' GROUP BY a.code, a.type';
    const [piRows] = await db.query(piSql, piParams);
    let netIncome = 0;
    piRows.forEach(r => {
      if (r.type === 'revenue') netIncome += (Number(r.credit)||0) - (Number(r.debit)||0);
      else                      netIncome -= (Number(r.debit)||0)  - (Number(r.credit)||0);
    });

    // Build code→{opening, closing} map for asset/liability/equity accounts.
    const balByCode = {};
    function fillSide(rows, side) {
      rows.forEach(r => {
        const net = (Number(r.debit)||0) - (Number(r.credit)||0); // debit-normal
        if (!balByCode[r.code]) balByCode[r.code] = { code: r.code, nameAr: r.name_ar, type: r.type, opening: 0, closing: 0 };
        balByCode[r.code][side] = net;
      });
    }
    fillSide(openingRows, 'opening');
    fillSide(closingRows, 'closing');
    const balanceSheetCodes = Object.values(balByCode).filter(b => ['asset','liability','equity'].includes(b.type));

    // Helpers — categorise each account by code prefix.
    function category(code) {
      const c = String(code || '');
      // Cash & banks (1101 + 1102)
      if (c.startsWith('1101') || c.startsWith('1102')) return 'cash';
      // Inventory (1102? no — 1102 is bank above; inventory codes are 112* per the seed)
      if (c.startsWith('112')) return 'inventory';
      // Receivables (113, 1125)
      if (c.startsWith('113') || c.startsWith('1125')) return 'receivables';
      // Other current assets (114, 115)
      if (c.startsWith('114') || c.startsWith('115')) return 'otherCurrentAssets';
      // Fixed assets (12x — including accumulated depreciation 124)
      if (c.startsWith('12')) return 'fixedAssets';
      // Current liabilities — payables (211), accrued (212), tax (213)
      if (c.startsWith('211')) return 'payables';
      if (c.startsWith('212') || c.startsWith('213') || c.startsWith('214') || c.startsWith('21')) return 'otherCurrentLiabilities';
      // Equity / drawings / capital movements (3*)
      if (c.startsWith('3')) return 'equity';
      return 'other';
    }

    // Aggregate Δ (closing - opening) by category.
    const deltaByCat = {};
    const lineItemsByCat = {};
    balanceSheetCodes.forEach(b => {
      const delta = (b.closing||0) - (b.opening||0);
      const cat = category(b.code);
      if (!deltaByCat[cat]) deltaByCat[cat] = 0;
      if (!lineItemsByCat[cat]) lineItemsByCat[cat] = [];
      // For asset categories we use the delta as-is (debit-normal: increase = positive).
      // For liability/equity, positive net is "credit balance increased" but we want
      // to expose the same "Δ closing - opening" so the UI can decide signage.
      if (b.type === 'asset') {
        deltaByCat[cat] += delta;
      } else {
        // For liabilities/equity: storage is debit-normal (negative for credit
        // balances), so an increase in liability shows as MORE NEGATIVE delta.
        // Flip sign so positive = "liability went up".
        deltaByCat[cat] += -delta;
      }
      if (includeZero || Math.abs(delta) > 0.01) {
        lineItemsByCat[cat].push({
          code: b.code, name: b.nameAr, opening: b.opening, closing: b.closing, delta: delta
        });
      }
    });

    // Cash Flow assembly (indirect method).
    // Operating activities:
    //   + Net income
    //   - Increase in receivables (uses cash)
    //   - Increase in inventory   (uses cash)
    //   + Increase in payables    (provides cash)
    //   + Increase in accrued     (provides cash)
    //   + Depreciation (non-cash) — pulled from accumulated dep account 124*
    const operating = [];
    operating.push({ label: 'صافي ربح/خسارة الفترة', amount: netIncome, kind: 'subtotal' });
    // Non-cash adjustments — depreciation increase = non-cash add-back
    const depreciationDelta = (lineItemsByCat.fixedAssets||[])
      .filter(x => String(x.code).startsWith('124'))
      .reduce((s, x) => s + Math.abs(x.delta), 0);
    if (depreciationDelta > 0.01) {
      operating.push({ label: 'إضافة: استهلاك الأصول الثابتة (Non-cash)', amount: depreciationDelta });
    }
    // v5.10.4 — when showZero is on, push every standard working-capital
    // line so the user sees the full set even if no movement happened.
    const _zoThr = includeZero ? -1 : 0.01;
    if (includeZero || Math.abs(deltaByCat.receivables||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الذمم المدينة', amount: -(deltaByCat.receivables||0) });
    if (includeZero || Math.abs(deltaByCat.inventory||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في المخزون', amount: -(deltaByCat.inventory||0) });
    if (includeZero || Math.abs(deltaByCat.otherCurrentAssets||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الأصول المتداولة الأخرى', amount: -(deltaByCat.otherCurrentAssets||0) });
    if (includeZero || Math.abs(deltaByCat.payables||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الذمم الدائنة', amount: (deltaByCat.payables||0) });
    if (includeZero || Math.abs(deltaByCat.otherCurrentLiabilities||0) > _zoThr)
      operating.push({ label: 'الزيادة/(النقص) في الالتزامات المتداولة الأخرى', amount: (deltaByCat.otherCurrentLiabilities||0) });
    const operatingTotal = operating.reduce((s, l) => s + (l.amount||0), 0);

    // Investing activities — Δ fixed assets EXCLUDING accumulated depreciation
    const investing = [];
    (lineItemsByCat.fixedAssets||[])
      .filter(x => !String(x.code).startsWith('124'))
      .forEach(x => investing.push({ label: 'صافي حركة ' + x.name, amount: -x.delta, code: x.code }));
    const investingTotal = investing.reduce((s, l) => s + (l.amount||0), 0);

    // Financing activities — Δ equity (capital + drawings + retained)
    const financing = [];
    (lineItemsByCat.equity||[]).forEach(x => {
      // Equity is credit-normal; deltaByCat already flipped sign to "credit increased = positive".
      // For financing display: positive contribution from capital → +; drawings → −.
      // We pass the per-line raw delta with a flipped sign for liabilities/equity:
      const flipped = -x.delta;
      financing.push({ label: x.name, amount: flipped, code: x.code });
    });
    const financingTotal = financing.reduce((s, l) => s + (l.amount||0), 0);

    // Net change in cash should equal cash account closing-opening.
    const netChange = operatingTotal + investingTotal + financingTotal;
    const cashOpening = (lineItemsByCat.cash||[]).reduce((s, x) => s + (x.opening||0), 0);
    const cashClosing = (lineItemsByCat.cash||[]).reduce((s, x) => s + (x.closing||0), 0);
    const actualMovement = cashClosing - cashOpening;
    const reconciliationDiff = netChange - actualMovement;

    res.json({
      from, to,
      netIncome,
      operating: { lines: operating, total: operatingTotal },
      investing: { lines: investing, total: investingTotal },
      financing: { lines: financing, total: financingTotal },
      netChange,
      cashOpening, cashClosing, actualMovement,
      reconciliationDiff,
      isReconciled: Math.abs(reconciliationDiff) < 1.0  // tolerate 1 SAR rounding
    });
  } catch(e) {
    console.error('[cash-flow] error:', e);
    res.json({ error: e.message,
      operating:{lines:[],total:0}, investing:{lines:[],total:0}, financing:{lines:[],total:0},
      netChange:0, cashOpening:0, cashClosing:0, actualMovement:0, reconciliationDiff:0, isReconciled:false });
  }
});

// ─── VAT ───

// Get VAT transactions for period
router.get('/vat/transactions', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.json({ error: 'startDate and endDate required' });

    // Output VAT (from sales)
    const [sales] = await db.query(
      'SELECT id, order_date, total_final, payment_method FROM sales WHERE DATE(order_date) >= ? AND DATE(order_date) <= ?',
      [startDate, endDate]
    );

    // Get VAT rate from settings
    const [settings] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate'");
    const vatRate = settings.length ? Number(settings[0].setting_value) : 15;

    let totalOutputVat = 0;
    const outputTransactions = sales.map(s => {
      const total = Number(s.total_final);
      const vatAmount = total - (total / (1 + vatRate / 100));
      totalOutputVat += vatAmount;
      return { id: s.id, date: s.order_date, type: 'output', total, vatAmount, source: 'sale' };
    });

    // Input VAT (from purchases)
    const [purchases] = await db.query(
      'SELECT id, purchase_date, total_price FROM purchases WHERE DATE(purchase_date) >= ? AND DATE(purchase_date) <= ? AND status = "received"',
      [startDate, endDate]
    );

    let totalInputVat = 0;
    const inputTransactions = purchases.map(p => {
      const total = Number(p.total_price);
      const vatAmount = total - (total / (1 + vatRate / 100));
      totalInputVat += vatAmount;
      return { id: p.id, date: p.purchase_date, type: 'input', total, vatAmount, source: 'purchase' };
    });

    res.json({
      vatRate,
      outputVat: totalOutputVat,
      inputVat: totalInputVat,
      netVat: totalOutputVat - totalInputVat,
      transactions: [...outputTransactions, ...inputTransactions]
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Post VAT journals — creates GL entries + vat_report
router.post('/vat/post', async (req, res) => {
  try {
    const { periodStart, periodEnd, username } = req.body;
    if (!periodStart || !periodEnd) return res.json({ success: false, error: 'حدد الفترة' });

    // Recalculate VAT from actual data
    const [vatSettings] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate'");
    const vatRate = vatSettings.length ? Number(vatSettings[0].setting_value) : 15;

    const [sales] = await db.query('SELECT SUM(total_final) AS total FROM sales WHERE DATE(order_date) >= ? AND DATE(order_date) <= ?', [periodStart, periodEnd]);
    const salesTotal = Number(sales[0].total) || 0;
    const outputVat = salesTotal - (salesTotal / (1 + vatRate / 100));

    const [purchases] = await db.query('SELECT SUM(total_price) AS total FROM purchases WHERE DATE(purchase_date) >= ? AND DATE(purchase_date) <= ? AND status = "received"', [periodStart, periodEnd]);
    const purchaseTotal = Number(purchases[0].total) || 0;
    const inputVat = purchaseTotal - (purchaseTotal / (1 + vatRate / 100));

    const netVat = outputVat - inputVat;

    // Create VAT report
    const reportId = 'VAT-' + Date.now();
    await db.query(
      `INSERT INTO vat_reports (id, period_start, period_end, total_output_vat, total_input_vat, net_vat, status, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [reportId, periodStart, periodEnd, outputVat, inputVat, netVat, 'submitted', username || '']
    );

    // Create GL journal entry for VAT
    // Find VAT GL accounts
    let outputVatAccId = null, inputVatAccId = null;
    const [outAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '21301' OR (name_ar LIKE '%ضريبة%مخرجات%' AND type='liability') ORDER BY code LIMIT 1");
    if (outAcc.length) outputVatAccId = outAcc[0].id;
    else {
      // Try generic VAT account
      const [genAcc] = await db.query("SELECT id FROM gl_accounts WHERE code LIKE '213%' AND type='liability' ORDER BY code LIMIT 1");
      if (genAcc.length) outputVatAccId = genAcc[0].id;
    }

    // Ensure input VAT account exists (1430 or create under 113)
    const [inAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '1430' OR (name_ar LIKE '%ضريبة%مدخلات%' AND type='asset') ORDER BY code LIMIT 1");
    if (inAcc.length) inputVatAccId = inAcc[0].id;
    else {
      // Auto-create input VAT account
      const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '113' OR code = '11' ORDER BY code DESC LIMIT 1");
      inputVatAccId = 'GL-1430';
      await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [inputVatAccId, '1430', 'ضريبة المدخلات', 'asset', p11.length ? p11[0].id : null, 4]);
    }

    let journalNumber = '';
    if (outputVatAccId || inputVatAccId) {
      const jrnId = 'JRN-VAT-' + Date.now();
      const [lastJ] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
      let jrnNum = 1;
      if (lastJ.length && lastJ[0].journal_number) {
        const m = lastJ[0].journal_number.match(/(\d+)/);
        if (m) jrnNum = parseInt(m[1]) + 1;
      }
      journalNumber = 'JV-' + String(jrnNum).padStart(6, '0');
      const desc = 'تسوية ضريبة القيمة المضافة — ' + periodStart + ' إلى ' + periodEnd;
      const now = new Date();

      await db.query(
        `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jrnId, journalNumber, now, 'vat_settlement', reportId, desc,
         Math.abs(netVat), Math.abs(netVat), 'posted', username||'', username||'', now]
      );

      if (netVat > 0 && outputVatAccId) {
        // Net VAT payable: Debit output VAT (reduce liability), Credit cash/payable
        const gle1 = 'GLE-VAT-' + Date.now() + '-1';
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          [gle1, jrnId, outputVatAccId, '21301', 'ضريبة المخرجات', outputVat, 0, 'ضريبة مخرجات — ' + periodStart]);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [outputVat, outputVatAccId]);

        if (inputVatAccId && inputVat > 0) {
          const gle2 = 'GLE-VAT-' + Date.now() + '-2';
          await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
            [gle2, jrnId, inputVatAccId, '1430', 'ضريبة المدخلات', 0, inputVat, 'ضريبة مدخلات — ' + periodStart]);
          await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [inputVat, inputVatAccId]);
        }
      } else if (inputVatAccId && inputVat > 0) {
        const gle1 = 'GLE-VAT-' + Date.now() + '-1';
        await db.query('INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          [gle1, jrnId, inputVatAccId, '1430', 'ضريبة المدخلات', inputVat, 0, 'ضريبة مدخلات — ' + periodStart]);
        await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [inputVat, inputVatAccId]);
      }
    }

    res.json({ success: true, id: reportId, journalNumber, outputVat, inputVat, netVat });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get VAT reports list
router.get('/vat/reports', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM vat_reports ORDER BY period_start DESC');
    res.json(rows.map(r => ({
      id: r.id, periodStart: r.period_start, periodEnd: r.period_end,
      totalOutputVat: Number(r.total_output_vat), totalInputVat: Number(r.total_input_vat),
      netVat: Number(r.net_vat), status: r.status, createdBy: r.created_by
    })));
  } catch(e) { res.json([]); }
});

// Close VAT quarter
router.post('/vat/close-quarter', async (req, res) => {
  try {
    const { reportId, username } = req.body;

    const [existing] = await db.query('SELECT * FROM vat_reports WHERE id = ?', [reportId]);
    if (!existing.length) return res.json({ success: false, error: 'VAT report not found' });

    await db.query('UPDATE vat_reports SET status = "submitted" WHERE id = ?', [reportId]);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Close financial year
router.post('/vat/close-year', async (req, res) => {
  try {
    const { year, username } = req.body;
    const periodId = 'FY-' + year;

    // Close all open periods for the year
    await db.query(
      `UPDATE accounting_periods SET status = 'closed', closed_by = ?, closed_at = NOW()
       WHERE YEAR(start_date) = ? AND status = 'open'`,
      [username || '', year]
    );

    // Close all VAT reports for the year
    await db.query(
      `UPDATE vat_reports SET status = 'closed'
       WHERE YEAR(period_start) = ? AND status != 'closed'`,
      [year]
    );

    res.json({ success: true, closedYear: year });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Audit Log (سجل التدقيق) ───

async function auditLog(action, entityType, entityId, username, details, ip) {
  try {
    const id = 'AUD-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query('INSERT INTO audit_logs (id, action, entity_type, entity_id, username, details, ip_address) VALUES (?,?,?,?,?,?,?)',
      [id, action, entityType||'', entityId||'', username||'', typeof details === 'object' ? JSON.stringify(details) : (details||''), ip||'']);
  } catch(e) { /* Production: removed debug log */ }
}

router.get('/audit-logs', async (req, res) => {
  try {
    // Accept BOTH legacy (entityType/entityId/startDate/endDate/username) and
    // new (entity/from/to/user/action/search) parameter names.
    const q = req.query;
    const entity   = q.entity     || q.entityType || '';
    const entityId = q.entityId   || '';
    const username = q.user       || q.username   || '';
    const action   = q.action     || '';
    const from     = q.from       || q.startDate  || '';
    const to       = q.to         || q.endDate    || '';
    const search   = q.search     || '';
    const lim      = q.limit;

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (entity)   { query += ' AND entity_type = ?'; params.push(entity); }
    if (entityId) { query += ' AND entity_id = ?';   params.push(entityId); }
    if (username) { query += ' AND username = ?';    params.push(username); }
    if (action)   { query += ' AND action = ?';      params.push(action); }
    if (from)     { query += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)       { query += ' AND DATE(created_at) <= ?'; params.push(to); }
    if (search) {
      query += ' AND (details LIKE ? OR entity_id LIKE ?)';
      params.push('%'+search+'%', '%'+search+'%');
    }
    query += ' ORDER BY created_at DESC LIMIT ' + (Number(lim) || 500);

    const [rows] = await db.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entity: r.entity_type,            // alias for new UI
      entityId: r.entity_id,
      documentRef: r.entity_id,         // alias
      reference: r.entity_id,           // alias
      username: r.username,
      details: r.details,
      description: r.details,           // alias
      ip: r.ip_address,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      timestamp: r.created_at
    })));
  } catch(e) { res.json([]); }
});

// ─── Purchase Reports (تقارير المشتريات) ───

router.get('/purchase-reports', async (req, res) => {
  try {
    const { startDate, endDate, supplierId, itemId, reportType } = req.query;
    let where = "p.status = 'received'";
    const params = [];
    if (startDate) { where += ' AND DATE(p.purchase_date) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(p.purchase_date) <= ?'; params.push(endDate); }
    if (supplierId) { where += ' AND p.supplier_id = ?'; params.push(supplierId); }

    const [purchases] = await db.query(
      `SELECT p.id, p.purchase_date, p.supplier_name, p.supplier_id, p.total_price, p.items_json
       FROM purchases p WHERE ${where} ORDER BY p.purchase_date DESC`, params
    );

    // Parse items from each purchase
    const allItems = [];
    purchases.forEach(function(p) {
      const items = JSON.parse(p.items_json || '[]');
      items.forEach(function(it) {
        if (itemId && (it.id || it.itemId) !== itemId) return;
        allItems.push({
          date: p.purchase_date, supplierId: p.supplier_id, supplierName: p.supplier_name,
          itemId: it.id || it.itemId || '', itemName: it.name || it.itemName || '',
          qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice || it.price) || 0,
          total: (Number(it.qty)||0) * (Number(it.unitPrice || it.price)||0),
          unit: it.unit || ''
        });
      });
    });

    let result = {};
    const type = reportType || 'bySupplier';

    if (type === 'bySupplier') {
      const grouped = {};
      allItems.forEach(function(it) {
        if (!grouped[it.supplierName]) grouped[it.supplierName] = { supplier: it.supplierName, totalQty: 0, totalAmount: 0, invoiceCount: 0, items: [] };
        grouped[it.supplierName].totalQty += it.qty;
        grouped[it.supplierName].totalAmount += it.total;
        grouped[it.supplierName].items.push(it);
      });
      // Count unique purchase dates per supplier
      Object.values(grouped).forEach(function(g) {
        g.invoiceCount = new Set(g.items.map(function(i) { return String(i.date).substring(0,10); })).size;
      });
      result = { type: 'bySupplier', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else if (type === 'byItem') {
      const grouped = {};
      allItems.forEach(function(it) {
        if (!grouped[it.itemName]) grouped[it.itemName] = { itemName: it.itemName, unit: it.unit, totalQty: 0, totalAmount: 0, avgPrice: 0, suppliers: new Set() };
        grouped[it.itemName].totalQty += it.qty;
        grouped[it.itemName].totalAmount += it.total;
        grouped[it.itemName].suppliers.add(it.supplierName);
      });
      Object.values(grouped).forEach(function(g) { g.avgPrice = g.totalQty > 0 ? g.totalAmount / g.totalQty : 0; g.supplierCount = g.suppliers.size; delete g.suppliers; });
      result = { type: 'byItem', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else if (type === 'bySupplierItem') {
      const grouped = {};
      allItems.forEach(function(it) {
        var key = it.supplierName + '|' + it.itemName;
        if (!grouped[key]) grouped[key] = { supplierName: it.supplierName, itemName: it.itemName, unit: it.unit, totalQty: 0, totalAmount: 0 };
        grouped[key].totalQty += it.qty;
        grouped[key].totalAmount += it.total;
      });
      result = { type: 'bySupplierItem', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else {
      // detailed — all items with date
      result = { type: 'detailed', rows: allItems, totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    }

    res.json(result);
  } catch(e) { res.json({ type: 'error', rows: [], totalAmount: 0, error: e.message }); }
});

// ─── Brands (البراندات) ───

router.get('/brands', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM brands ORDER BY name');
    res.json(rows.map(b => {
      let linkedBranches = [];
      try { if (b.linked_branches) linkedBranches = JSON.parse(b.linked_branches); } catch(e) {}
      return {
        id: b.id, name: b.name, code: b.code, logo: b.logo, isActive: !!b.is_active,
        linkedBranches: linkedBranches
      };
    }));
  } catch(e) { res.json([]); }
});

router.post('/brands', async (req, res) => {
  try {
    const { id, name, code, logo, isActive, linkedBranches } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    const linkedBranchesJson = Array.isArray(linkedBranches) ? JSON.stringify(linkedBranches) : null;
    if (id) {
      try {
        await db.query('UPDATE brands SET name=?, code=?, logo=?, is_active=?, linked_branches=? WHERE id=?',
          [name, code||'', logo||null, isActive!==false?1:0, linkedBranchesJson, id]);
      } catch(e) {
        // Fallback for older deploys without linked_branches column
        await db.query('UPDATE brands SET name=?, code=?, logo=?, is_active=? WHERE id=?',
          [name, code||'', logo||null, isActive!==false?1:0, id]);
      }
      return res.json({ success: true, id });
    }
    const newId = 'BR-' + Date.now();
    try {
      await db.query('INSERT INTO brands (id, name, code, logo, linked_branches) VALUES (?,?,?,?,?)',
        [newId, name, code||'', logo||null, linkedBranchesJson]);
    } catch(e) {
      await db.query('INSERT INTO brands (id, name, code, logo) VALUES (?,?,?,?)', [newId, name, code||'', logo||null]);
    }
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    // Check if brand has branches
    const [branches] = await db.query('SELECT COUNT(*) AS cnt FROM branches WHERE brand_id = ?', [req.params.id]);
    if (branches[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن حذف براند لديه فروع مرتبطة' });
    await db.query('DELETE FROM brands WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Cost Centers (مراكز التكلفة) ───

router.get('/cost-centers', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM cost_centers ORDER BY code');
    res.json(rows.map(c => ({ id: c.id, code: c.code, name: c.name, type: c.type, parentId: c.parent_id, isActive: c.is_active })));
  } catch(e) { res.json([]); }
});

router.post('/cost-centers', async (req, res) => {
  try {
    const { id, code, name, type, parentId } = req.body;
    if (!code || !name) return res.json({ success: false, error: 'الرمز والاسم مطلوبان' });
    if (id) {
      await db.query('UPDATE cost_centers SET code=?, name=?, type=?, parent_id=? WHERE id=?', [code, name, type||'branch', parentId||null, id]);
      return res.json({ success: true, id });
    }
    const newId = 'CC-' + Date.now();
    await db.query('INSERT INTO cost_centers (id, code, name, type, parent_id) VALUES (?,?,?,?,?)', [newId, code, name, type||'branch', parentId||null]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/cost-centers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM cost_centers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Warehouses (المستودعات المتعددة) ───

router.get('/warehouses-list', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT w.*,
        b.name AS branch_name,
        bd.name AS brand_name,
        cc.name AS cost_center_name
      FROM warehouses w
      LEFT JOIN branches b ON w.branch_id = b.id
      LEFT JOIN brands bd ON w.brand_id = bd.id
      LEFT JOIN cost_centers cc ON w.cost_center_id = cc.id
      ORDER BY w.code`);
    res.json(rows.map(w => {
      let allowedBrands = [];
      try { if (w.allowed_brands) allowedBrands = JSON.parse(w.allowed_brands); } catch(e) {}
      return {
        id: w.id, code: w.code, name: w.name, type: w.type,
        branchId: w.branch_id || '', branchName: w.branch_name||'',
        brandId: w.brand_id || '', brandName: w.brand_name||'',
        costCenterId: w.cost_center_id || '', costCenterName: w.cost_center_name||'',
        location: w.location||'', manager: w.manager||'', isActive: w.is_active,
        // V3: array of allowed brand IDs (multi-brand storage rule)
        allowedBrands: allowedBrands
      };
    }));
  } catch(e) { res.json([]); }
});

router.post('/warehouses-list', async (req, res) => {
  try {
    const { id, code, name, type, brandId, branchId, costCenterId, location, manager, allowedBrands } = req.body;
    if (!code || !name) return res.json({ success: false, error: 'الرمز والاسم مطلوبان' });
    const allowedBrandsJson = Array.isArray(allowedBrands) ? JSON.stringify(allowedBrands) : null;
    if (id) {
      try {
        await db.query('UPDATE warehouses SET code=?, name=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=?, allowed_brands=? WHERE id=?',
          [code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson, id]);
      } catch(e) {
        // Fallback for older deploys without allowed_brands column
        await db.query('UPDATE warehouses SET code=?, name=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=? WHERE id=?',
          [code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', id]);
      }
      return res.json({ success: true, id });
    }
    const newId = 'WH-' + Date.now();
    try {
      await db.query('INSERT INTO warehouses (id, code, name, type, brand_id, branch_id, cost_center_id, location, manager, allowed_brands) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [newId, code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson]);
    } catch(e) {
      await db.query('INSERT INTO warehouses (id, code, name, type, brand_id, branch_id, cost_center_id, location, manager) VALUES (?,?,?,?,?,?,?,?,?)',
        [newId, code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'']);
    }
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/warehouses-list/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM warehouse_stock WHERE warehouse_id = ?', [req.params.id]);
    await db.query('DELETE FROM warehouses WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Warehouse stock
router.get('/warehouse-stock-detail/:whId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ws.*, i.name, i.category, i.unit, i.cost FROM warehouse_stock ws
       JOIN inv_items i ON ws.item_id = i.id WHERE ws.warehouse_id = ? ORDER BY i.name`, [req.params.whId]);
    res.json(rows.map(r => ({ itemId: r.item_id, itemName: r.name, category: r.category, unit: r.unit, qty: Number(r.qty), cost: Number(r.cost) })));
  } catch(e) { res.json([]); }
});

// Warehouse transfers
// v5.10.21 — accepts ?warehouseId (matches either from or to), ?direction
// (in|out — only when warehouseId is set), ?status, ?startDate, ?endDate
// so the unified filter bar in the wh_transfers tab can scope server-side.
router.get('/warehouse-transfers', async (req, res) => {
  try {
    let sql =
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name FROM warehouse_transfers t
       LEFT JOIN warehouses wf ON t.from_warehouse_id = wf.id
       LEFT JOIN warehouses wt ON t.to_warehouse_id = wt.id`;
    const conds = [];
    const params = [];
    const { warehouseId, direction, status, startDate, endDate } = req.query;
    if (warehouseId) {
      if (direction === 'in') {
        conds.push('t.to_warehouse_id = ?');   params.push(warehouseId);
      } else if (direction === 'out') {
        conds.push('t.from_warehouse_id = ?'); params.push(warehouseId);
      } else {
        conds.push('(t.from_warehouse_id = ? OR t.to_warehouse_id = ?)');
        params.push(warehouseId, warehouseId);
      }
    }
    if (status)    { conds.push('t.status = ?');                  params.push(status); }
    if (startDate) { conds.push('DATE(t.transfer_date) >= ?');    params.push(startDate); }
    if (endDate)   { conds.push('DATE(t.transfer_date) <= ?');    params.push(endDate); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY t.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(t => ({
      id: t.id, transferNumber: t.transfer_number, fromWarehouse: t.from_name||'', toWarehouse: t.to_name||'',
      fromId: t.from_warehouse_id, toId: t.to_warehouse_id,
      transferDate: t.transfer_date, status: t.status, items: JSON.parse(t.items_json||'[]'),
      notes: t.notes, createdBy: t.created_by, approvedBy: t.approved_by
    })));
  } catch(e) { res.json([]); }
});

router.post('/warehouse-transfers', async (req, res) => {
  try {
    const { fromWarehouseId, toWarehouseId, items, notes, username } = req.body;
    if (!fromWarehouseId || !toWarehouseId || !items || !items.length) {
      return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
    }
    // v5.10.29 — block same-warehouse transfers; meaningless, would cancel out.
    if (String(fromWarehouseId) === String(toWarehouseId)) {
      return res.status(400).json({ success: false, error: 'لا يمكن التحويل إلى نفس المستودع' });
    }
    // Validate both warehouses exist
    const [whs] = await db.query(
      'SELECT id FROM warehouses WHERE id IN (?, ?)', [fromWarehouseId, toWarehouseId]);
    if (whs.length < 2) {
      return res.status(404).json({ success: false, error: 'أحد المستودعين غير موجود' });
    }
    // v5.10.29 — reject zero/negative quantities up-front so drafts never carry
    // garbage into approval. itemId required.
    for (const it of items) {
      if (!it || !it.itemId) return res.status(400).json({ success: false, error: 'صنف بدون معرّف' });
      const q = Number(it.qty);
      if (!isFinite(q) || q <= 0) {
        return res.status(400).json({ success: false, error: 'الكمية يجب أن تكون أكبر من صفر' });
      }
    }

    const id = 'WT-' + Date.now();
    const [last] = await db.query('SELECT transfer_number FROM warehouse_transfers ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].transfer_number) { const m = last[0].transfer_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
    const transferNumber = 'TR-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO warehouse_transfers (id, transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, items_json, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, transferNumber, fromWarehouseId, toWarehouseId, new Date(), JSON.stringify(items), notes||'', username||'']
    );
    res.status(201).json({ success: true, id, transferNumber });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// v5.10.29 — Atomic approval. Wraps the whole operation in a transaction:
//   1. Validate every line: source qty must cover the requested qty (else 409 + rollback)
//   2. Decrement source warehouse_stock (UPSERT pattern preserved)
//   3. Increment destination warehouse_stock
//   4. Write inventory_movements rows for both sides (out from source, in to dest)
//   5. Mark transfer "completed"
// On any failure all writes roll back, so a partial transfer can never leave
// stock missing or duplicated.
router.post('/warehouse-transfers/:id/approve', async (req, res) => {
  try {
    const { username } = req.body || {};
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.status(404).json({ success: false, error: 'التحويل غير موجود' });
    const t = transfers[0];
    if (t.status !== 'draft') return res.status(409).json({ success: false, error: 'التحويل ليس في حالة مسودة' });

    const items = JSON.parse(t.items_json || '[]').filter(x => x && x.itemId && Number(x.qty) > 0);
    if (!items.length) return res.status(400).json({ success: false, error: 'لا توجد بنود صالحة' });

    // (1) Pre-flight check: source must hold enough stock for every line.
    //     One COALESCE'd query per line — cheap and avoids transaction
    //     entry on a doomed approval.
    const insufficient = [];
    for (const item of items) {
      const [rows] = await db.query(
        'SELECT COALESCE(qty, 0) AS qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?',
        [t.from_warehouse_id, item.itemId]);
      const onHand = rows.length ? Number(rows[0].qty) : 0;
      const need   = Number(item.qty) || 0;
      if (onHand < need) {
        insufficient.push({ itemId: item.itemId, itemName: item.itemName || item.itemId, onHand, need });
      }
    }
    if (insufficient.length) {
      return res.status(409).json({
        success: false,
        error: 'رصيد المصدر غير كافٍ في بعض البنود',
        insufficient
      });
    }

    const runner = async (conn) => {
      const c = conn || db;
      const nowIso = new Date().toISOString().slice(0,19).replace('T',' ');
      const today  = nowIso.slice(0,10);

      for (const item of items) {
        const qty = Number(item.qty) || 0;
        if (qty <= 0) continue;

        // (2) decrement source — UPSERT keeps schema unchanged
        await c.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty - VALUES(qty), last_updated = VALUES(last_updated)',
          ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
           t.from_warehouse_id, item.itemId, qty, nowIso, today, username || '', nowIso]);

        // (3) increment destination
        await c.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty), last_updated = VALUES(last_updated)',
          ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
           t.to_warehouse_id, item.itemId, qty, nowIso, today, username || '', nowIso]);

        // (4) movement log on both sides — keeps the warehouse ledger correct
        const itemName = item.itemName || '';
        const refNote  = 'تحويل ' + (t.transfer_number || t.id);
        try {
          await c.query(
            `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
             nowIso, item.itemId, itemName, 'out', qty,
             'تحويل صادر', username || '', refNote, t.from_warehouse_id]);
          await c.query(
            `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
             nowIso, item.itemId, itemName, 'in', qty,
             'تحويل وارد', username || '', refNote, t.to_warehouse_id]);
        } catch (_) { /* older schemas without warehouse_id; skip */ }
      }

      // (5) mark complete
      await c.query(
        'UPDATE warehouse_transfers SET status = "completed", approved_by = ?, approved_at = ? WHERE id = ?',
        [username || '', nowIso, req.params.id]);
    };

    try {
      if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
      else await runner(null);
    } catch (txErr) {
      console.error('[warehouse-transfers/:id/approve] tx failed:', txErr.message);
      return res.status(500).json({ success: false, error: txErr.message });
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Warehouse Transfers: cancel + view lines (consolidated from legacy) ───

router.post('/warehouse-transfers/:id/cancel', async (req, res) => {
  try {
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.json({ success: false, error: 'التحويل غير موجود' });
    if (transfers[0].status !== 'draft') return res.json({ success: false, error: 'لا يمكن إلغاء تحويل مكتمل' });
    await db.query('UPDATE warehouse_transfers SET status = "cancelled" WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/warehouse-transfer-lines/:id', async (req, res) => {
  try {
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.json([]);
    const items = JSON.parse(transfers[0].items_json || '[]');
    res.json(items.map(item => ({
      itemId: item.itemId, itemName: item.itemName||'',
      qty: Number(item.qty)||0, cost: Number(item.cost)||0
    })));
  } catch(e) { res.json([]); }
});

// ─── Brands: count linked branches + products ───
router.get('/brands-stats', async (req, res) => {
  try {
    const [brands] = await db.query('SELECT * FROM brands ORDER BY name');
    const result = [];
    for (const b of brands) {
      const [branchCount] = await db.query('SELECT COUNT(*) AS cnt FROM branches WHERE brand_id = ?', [b.id]);
      const [menuCount] = await db.query('SELECT COUNT(*) AS cnt FROM menu WHERE brand_id = ?', [b.id]);
      const [empCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_employees WHERE brand_id = ?', [b.id]);
      result.push({
        id: b.id, name: b.name, code: b.code, logo: b.logo, isActive: !!b.is_active,
        branchCount: branchCount[0].cnt, menuCount: menuCount[0].cnt, employeeCount: empCount[0].cnt
      });
    }
    res.json(result);
  } catch(e) { res.json([]); }
});

// ─── LEGACY WAREHOUSE CODE REMOVED — consolidated into /warehouses-list, /warehouse-transfers ───

// ─── Branches (enhanced) ───

// V5.9.4 — branches-full: previously the GET response omitted brandId, so the
// edit modal opened with the brand dropdown reset to "اختر البراند"; saving
// without re-selecting wiped brand_id. We now project every column the form
// reads, and the POST preserves columns the form does not send instead of
// silently rewriting them to defaults (notably `type`).
router.get('/branches-full', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, w.name AS warehouse_name, cc.name AS cost_center_name, br.name AS brand_name
       FROM branches b
       LEFT JOIN warehouses w   ON b.warehouse_id  = w.id
       LEFT JOIN cost_centers cc ON b.cost_center_id = cc.id
       LEFT JOIN brands br      ON b.brand_id      = br.id
       ORDER BY b.name`);
    res.json(rows.map(b => ({
      id: b.id, code: b.code || '', name: b.name || '', location: b.location || '',
      type: b.type || 'main',
      isActive: b.is_active !== 0 && b.is_active !== false,
      brandId: b.brand_id || '', brandName: b.brand_name || '',
      warehouseId: b.warehouse_id || '', warehouseName: b.warehouse_name || '',
      costCenterId: b.cost_center_id || '', costCenterName: b.cost_center_name || '',
      manager: b.manager || '',
      supplyMode: b.supply_mode || 'parent_company',
      companyName: b.company_name || '',
      geoLat: b.geo_lat != null ? Number(b.geo_lat) : null,
      geoLng: b.geo_lng != null ? Number(b.geo_lng) : null,
      geoRadius: b.geo_radius != null ? Number(b.geo_radius) : 100
    })));
  } catch(e) { res.json([]); }
});

router.post('/branches-full', async (req, res) => {
  try {
    const body = req.body || {};
    const id        = body.id;
    const name      = String(body.name || '').trim();
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (name.length > 200) return res.json({ success: false, error: 'الاسم طويل جداً (200 حرف كحد أقصى)' });

    const code        = String(body.code || '').trim().slice(0, 20);
    const companyName = body.companyName ? String(body.companyName).trim().slice(0, 200) : null;
    const location    = String(body.location || '').trim().slice(0, 500);
    const manager     = String(body.manager || '').trim().slice(0, 100);
    const brandId     = body.brandId      ? String(body.brandId).trim()      : null;
    const warehouseId = body.warehouseId  ? String(body.warehouseId).trim()  : null;
    const costCenter  = body.costCenterId ? String(body.costCenterId).trim() : null;

    const allowedSupply = ['parent_company','warehouse','auto'];
    const supplyMode = allowedSupply.includes(body.supplyMode) ? body.supplyMode : 'parent_company';
    const allowedTypes = ['main','branch'];
    const type = allowedTypes.includes(body.type) ? body.type : null; // null → preserve on UPDATE

    // Geo: parse-or-null. Reject obviously bad values rather than persisting NaN.
    const parseGeo = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const geoLat = parseGeo(body.geoLat);
    const geoLng = parseGeo(body.geoLng);
    if (geoLat !== null && (geoLat < -90 || geoLat > 90))   return res.json({ success: false, error: 'خط العرض خارج النطاق المسموح' });
    if (geoLng !== null && (geoLng < -180 || geoLng > 180)) return res.json({ success: false, error: 'خط الطول خارج النطاق المسموح' });
    let geoRadius = parseGeo(body.geoRadius);
    if (geoRadius === null || geoRadius < 10) geoRadius = 100;
    if (geoRadius > 10000) geoRadius = 10000;

    // Optional FK validation: keep dropdowns honest so a stale UI can't silently
    // attach a deleted brand/warehouse/cost-center to a branch.
    const checkExists = async (table, val) => {
      if (!val) return true;
      const [r] = await db.query('SELECT 1 FROM ' + table + ' WHERE id=? LIMIT 1', [val]);
      return r.length > 0;
    };
    if (!(await checkExists('brands',       brandId)))     return res.json({ success: false, error: 'البراند المحدد غير موجود' });
    if (!(await checkExists('warehouses',   warehouseId))) return res.json({ success: false, error: 'المستودع المحدد غير موجود' });
    if (!(await checkExists('cost_centers', costCenter)))  return res.json({ success: false, error: 'مركز التكلفة المحدد غير موجود' });

    if (id) {
      // Use COALESCE for `type` so we don't downgrade an existing branch type
      // when the form doesn't expose a type selector.
      await db.query(
        `UPDATE branches SET brand_id=?, code=?, name=?, company_name=?, location=?,
                             type = COALESCE(?, type),
                             warehouse_id=?, cost_center_id=?, manager=?, supply_mode=?,
                             geo_lat=?, geo_lng=?, geo_radius=?
         WHERE id=?`,
        [brandId, code, name, companyName, location,
         type,
         warehouseId, costCenter, manager, supplyMode,
         geoLat, geoLng, geoRadius, id]);
      return res.json({ success: true, id });
    }

    const newId = 'BR-' + Date.now();
    await db.query(
      `INSERT INTO branches (id, brand_id, code, name, company_name, location, type,
                             warehouse_id, cost_center_id, manager, supply_mode,
                             geo_lat, geo_lng, geo_radius)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, brandId, code, name, companyName, location, type || 'main',
       warehouseId, costCenter, manager, supplyMode,
       geoLat, geoLng, geoRadius]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
