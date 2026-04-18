const router = require('express').Router();
const db = require('../db/connection');

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
    let query = 'SELECT * FROM suppliers';
    if (activeOnly) query += ' WHERE is_active = 1';
    query += ' ORDER BY name';

    const [rows] = await db.query(query);
    res.json(rows.map(s => ({
      id: s.id, name: s.name, nameEn: s.name_en, vatNumber: s.vat_number,
      phone: s.phone, email: s.email, address: s.address, city: s.city,
      paymentTerms: s.payment_terms, balance: Number(s.balance), isActive: s.is_active,
      createdAt: s.created_at, createdBy: s.created_by
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/suppliers', async (req, res) => {
  try {
    const { id, name, nameEn, vatNumber, phone, email, address, city, paymentTerms, username } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM suppliers WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          `UPDATE suppliers SET name=?, name_en=?, vat_number=?, phone=?, email=?, address=?, city=?, payment_terms=?, updated_by=? WHERE id=?`,
          [name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
           paymentTerms || 'Cash', username || '', id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'SUP-' + Date.now();
    await db.query(
      `INSERT INTO suppliers (id, name, name_en, vat_number, phone, email, address, city, payment_terms, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameEn || '', vatNumber || '', phone || '', email || '', address || '', city || '',
       paymentTerms || 'Cash', username || '']
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
    const [rows] = await db.query('SELECT * FROM gl_accounts ORDER BY code');
    res.json(rows.map(a => ({
      id: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en,
      type: a.type, parentId: a.parent_id, level: a.level,
      isActive: a.is_active, balance: Number(a.balance)
    })));
  } catch (e) {
    res.json([]);
  }
});

router.post('/gl/accounts', async (req, res) => {
  try {
    const { id, code, nameAr, nameEn, type, parentId, level } = req.body;

    if (id) {
      const [existing] = await db.query('SELECT id FROM gl_accounts WHERE id = ?', [id]);
      if (existing.length) {
        await db.query(
          'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=? WHERE id=?',
          [code, nameAr, nameEn || '', type, parentId || null, level || 1, id]
        );
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'GL-' + Date.now();
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level) VALUES (?,?,?,?,?,?,?)',
      [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1]
    );

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

    for (const j of journals) {
      const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ?', [j.id]);
      result.push({
        id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
        referenceType: j.reference_type, referenceId: j.reference_id,
        description: j.description, notes: j.notes || '',
        totalDebit: Number(j.total_debit), totalCredit: Number(j.total_credit),
        periodId: j.period_id, status: j.status,
        createdBy: j.created_by || '', approvedBy: j.approved_by || '', postedBy: j.posted_by || '',
        approvedAt: j.approved_at, postedAt: j.posted_at,
        attachment: j.attachment || '',
        entries: entries.map(e => ({
          id: e.id, accountId: e.account_id, accountCode: e.account_code,
          accountName: e.account_name, debit: Number(e.debit), credit: Number(e.credit),
          description: e.description
        }))
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

// Post journal (approved → posted) — updates account balances
router.post('/gl/journals/:id/post', async (req, res) => {
  try {
    const { username } = req.body;
    const [jrn] = await db.query('SELECT status FROM gl_journals WHERE id = ?', [req.params.id]);
    if (!jrn.length) return res.json({ success: false, error: 'القيد غير موجود' });
    if (jrn[0].status !== 'approved') return res.json({ success: false, error: 'يجب اعتماد القيد أولاً قبل الترحيل' });

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

// Diagnostic: check GL data
router.get('/gl/diagnose', async (req, res) => {
  try {
    const [accs] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    const [jrns] = await db.query('SELECT COUNT(*) AS cnt, status FROM gl_journals GROUP BY status');
    const [nullEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NULL');
    const [validEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NOT NULL');
    const [nonZeroAccs] = await db.query('SELECT code, name_ar, balance FROM gl_accounts WHERE balance != 0 ORDER BY code');
    const [recentEntries] = await db.query(
      `SELECT e.account_id, e.account_code, e.account_name, e.debit, e.credit, j.journal_number, j.status, j.description
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id ORDER BY j.created_at DESC LIMIT 10`
    );
    res.json({ accounts: accs[0].cnt, journals: jrns, nullEntries: nullEntries[0].cnt, validEntries: validEntries[0].cnt, nonZeroAccounts: nonZeroAccs, recentEntries });
  } catch(e) { res.json({ error: e.message }); }
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
      let sql = `
        SELECT ws.warehouse_id, w.name AS warehouse_name, w.brand_id, COALESCE(br.name,'') AS brand_name,
               ws.item_id, i.name AS item_name, i.category, i.unit, i.cost,
               ws.qty
        FROM warehouse_stock ws
        JOIN warehouses w ON ws.warehouse_id = w.id
        LEFT JOIN brands br ON w.brand_id = br.id
        JOIN inv_items i ON ws.item_id = i.id
        WHERE i.active = 1 AND w.is_active = 1`;
      const params = [];
      if (brand_id) { sql += ' AND w.brand_id = ?'; params.push(brand_id); }
      if (warehouse_id) { sql += ' AND ws.warehouse_id = ?'; params.push(warehouse_id); }
      const [rows] = await db.query(sql, params);

      const byBrand = {}, byWarehouse = {}, byCategory = {};
      let totalValue = 0; let totalQty = 0;
      rows.forEach(r => {
        const val = (Number(r.qty)||0) * (Number(r.cost)||0);
        totalValue += val;
        totalQty += Number(r.qty) || 0;

        // By brand
        const bKey = r.brand_id || 'no_brand';
        if (!byBrand[bKey]) byBrand[bKey] = { brandId: r.brand_id, brandName: r.brand_name || 'بدون براند', totalValue: 0, items: 0 };
        byBrand[bKey].totalValue += val; byBrand[bKey].items++;

        // By warehouse
        if (!byWarehouse[r.warehouse_id]) byWarehouse[r.warehouse_id] = { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, brandName: r.brand_name, totalValue: 0, items: [] };
        byWarehouse[r.warehouse_id].totalValue += val;
        byWarehouse[r.warehouse_id].items.push({ name: r.item_name, qty: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit, category: r.category });

        // By category
        const cat = r.category || 'أخرى';
        if (!byCategory[cat]) byCategory[cat] = { totalValue: 0, items: [] };
        byCategory[cat].totalValue += val;
        byCategory[cat].items.push({ name: r.item_name, stock: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit });
      });
      return res.json({ method, totalValue, totalQty, itemCount: rows.length, byBrand, byWarehouse, categories: byCategory });
    }

    // Default: aggregate from inv_items
    const [items] = await db.query('SELECT id, name, category, cost, stock, unit FROM inv_items WHERE active = 1');
    const categories = {};
    let totalValue = 0;
    items.forEach(i => {
      const cat = i.category || 'أخرى';
      if (!categories[cat]) categories[cat] = { items: [], totalValue: 0 };
      const val = (Number(i.stock)||0) * (Number(i.cost)||0);
      categories[cat].items.push({ name: i.name, stock: Number(i.stock)||0, cost: Number(i.cost)||0, value: val, unit: i.unit });
      categories[cat].totalValue += val;
      totalValue += val;
    });
    res.json({ method, categories, totalValue, itemCount: items.length });
  } catch(e) { res.json({ method: 'perpetual', categories: {}, totalValue: 0, itemCount: 0, error: e.message }); }
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
router.get('/reports/balance-sheet', async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const [accounts] = await db.query("SELECT * FROM gl_accounts WHERE is_active = 1 ORDER BY code");

    // Get balances from gl_entries up to asOfDate
    let where = "j.status = 'posted'";
    const params = [];
    if (asOfDate) { where += ' AND DATE(j.journal_date) <= ?'; params.push(asOfDate); }
    const [entries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${where} GROUP BY e.account_id`, params
    );
    const balMap = {};
    entries.forEach(e => { balMap[e.account_id] = { debit: Number(e.d)||0, credit: Number(e.c)||0 }; });

    // IFRS classification
    // Current assets: 11x (cash, inventory, receivables)
    // Non-current assets: 12x (fixed assets)
    // Current liabilities: 21x
    // Non-current liabilities: 22x (if any)
    // Equity: 3x
    const currentAssets = [], nonCurrentAssets = [], currentLiab = [], nonCurrentLiab = [], equityItems = [];
    let totCA = 0, totNCA = 0, totCL = 0, totNCL = 0, totEq = 0;

    // Calculate net income from revenue/expense accounts for equity section
    let netIncome = 0;

    accounts.forEach(a => {
      const entry = balMap[a.id] || { debit: 0, credit: 0 };
      const net = entry.debit - entry.credit; // positive = debit balance
      if (net === 0) return;

      const item = { code: a.code, name: a.name_ar, balance: 0, level: a.level };

      if (a.type === 'asset') {
        item.balance = net; // assets are debit-normal
        if (a.code.startsWith('12')) { nonCurrentAssets.push(item); totNCA += item.balance; }
        else { currentAssets.push(item); totCA += item.balance; }
      } else if (a.type === 'liability') {
        item.balance = Math.abs(net); // liabilities are credit-normal
        if (a.code.startsWith('22')) { nonCurrentLiab.push(item); totNCL += item.balance; }
        else { currentLiab.push(item); totCL += item.balance; }
      } else if (a.type === 'equity') {
        item.balance = Math.abs(net);
        equityItems.push(item); totEq += item.balance;
      } else if (a.type === 'revenue') {
        netIncome += (entry.credit - entry.debit); // revenue credit-normal
      } else if (a.type === 'expense') {
        netIncome -= (entry.debit - entry.credit); // expenses reduce income
      }
    });

    // Add net income to equity
    if (Math.abs(netIncome) > 0.01) {
      equityItems.push({ code: '', name: 'صافي ربح/خسارة الفترة', balance: netIncome, level: 3, isComputed: true });
      totEq += netIncome;
    }

    const totalAssets = totCA + totNCA;
    const totalLiabilities = totCL + totNCL;

    res.json({
      currentAssets, totCA, nonCurrentAssets, totNCA, totalAssets,
      currentLiab, totCL, nonCurrentLiab, totNCL, totalLiabilities,
      equityItems, totEq,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totEq)) < 0.01,
      asOfDate: asOfDate || new Date().toISOString().split('T')[0]
    });
  } catch (e) { res.json({ currentAssets:[], nonCurrentAssets:[], currentLiab:[], nonCurrentLiab:[], equityItems:[], totCA:0, totNCA:0, totCL:0, totNCL:0, totEq:0, totalAssets:0, totalLiabilities:0, netIncome:0, isBalanced:false }); }
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
    const { entityType, entityId, username, startDate, endDate, limit: lim } = req.query;
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (entityType) { query += ' AND entity_type = ?'; params.push(entityType); }
    if (entityId) { query += ' AND entity_id = ?'; params.push(entityId); }
    if (username) { query += ' AND username = ?'; params.push(username); }
    if (startDate) { query += ' AND DATE(created_at) >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND DATE(created_at) <= ?'; params.push(endDate); }
    query += ' ORDER BY created_at DESC LIMIT ' + (Number(lim) || 200);
    const [rows] = await db.query(query, params);
    res.json(rows.map(r => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      username: r.username, details: r.details, ip: r.ip_address, createdAt: r.created_at
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
    res.json(rows.map(b => ({ id: b.id, name: b.name, code: b.code, logo: b.logo, isActive: !!b.is_active })));
  } catch(e) { res.json([]); }
});

router.post('/brands', async (req, res) => {
  try {
    const { id, name, code, logo, isActive } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query('UPDATE brands SET name=?, code=?, logo=?, is_active=? WHERE id=?', [name, code||'', logo||null, isActive!==false?1:0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'BR-' + Date.now();
    await db.query('INSERT INTO brands (id, name, code, logo) VALUES (?,?,?,?)', [newId, name, code||'', logo||null]);
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
    res.json(rows.map(w => ({
      id: w.id, code: w.code, name: w.name, type: w.type,
      branchId: w.branch_id || '', branchName: w.branch_name||'',
      brandId: w.brand_id || '', brandName: w.brand_name||'',
      costCenterId: w.cost_center_id || '', costCenterName: w.cost_center_name||'',
      location: w.location||'', manager: w.manager||'', isActive: w.is_active
    })));
  } catch(e) { res.json([]); }
});

router.post('/warehouses-list', async (req, res) => {
  try {
    const { id, code, name, type, brandId, branchId, costCenterId, location, manager } = req.body;
    if (!code || !name) return res.json({ success: false, error: 'الرمز والاسم مطلوبان' });
    if (id) {
      await db.query('UPDATE warehouses SET code=?, name=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=? WHERE id=?',
        [code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', id]);
      return res.json({ success: true, id });
    }
    const newId = 'WH-' + Date.now();
    await db.query('INSERT INTO warehouses (id, code, name, type, brand_id, branch_id, cost_center_id, location, manager) VALUES (?,?,?,?,?,?,?,?,?)',
      [newId, code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'']);
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
router.get('/warehouse-transfers', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name FROM warehouse_transfers t
       LEFT JOIN warehouses wf ON t.from_warehouse_id = wf.id
       LEFT JOIN warehouses wt ON t.to_warehouse_id = wt.id ORDER BY t.created_at DESC LIMIT 200`);
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
    if (!fromWarehouseId || !toWarehouseId || !items || !items.length) return res.json({ success: false, error: 'بيانات ناقصة' });

    const id = 'WT-' + Date.now();
    const [last] = await db.query('SELECT transfer_number FROM warehouse_transfers ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].transfer_number) { const m = last[0].transfer_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
    const transferNumber = 'TR-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO warehouse_transfers (id, transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, items_json, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, transferNumber, fromWarehouseId, toWarehouseId, new Date(), JSON.stringify(items), notes||'', username||'']
    );
    res.json({ success: true, id, transferNumber });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/warehouse-transfers/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.json({ success: false, error: 'التحويل غير موجود' });
    const t = transfers[0];
    if (t.status !== 'draft') return res.json({ success: false, error: 'التحويل ليس في حالة مسودة' });

    const items = JSON.parse(t.items_json || '[]');

    // Move stock between warehouses
    for (const item of items) {
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      // Decrease from source
      await db.query(
        'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty - ?',
        ['WS-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), t.from_warehouse_id, item.itemId, -qty, qty]
      );
      // Increase in destination
      await db.query(
        'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty + ?',
        ['WS-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), t.to_warehouse_id, item.itemId, qty, qty]
      );
    }

    await db.query('UPDATE warehouse_transfers SET status = "completed", approved_by = ? WHERE id = ?', [username||'', req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
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

router.get('/branches-full', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, w.name AS warehouse_name, cc.name AS cost_center_name
       FROM branches b LEFT JOIN warehouses w ON b.warehouse_id = w.id
       LEFT JOIN cost_centers cc ON b.cost_center_id = cc.id ORDER BY b.name`);
    res.json(rows.map(b => ({
      id: b.id, code: b.code, name: b.name, location: b.location, type: b.type, isActive: b.is_active !== false,
      warehouseId: b.warehouse_id, warehouseName: b.warehouse_name||'', costCenterId: b.cost_center_id, costCenterName: b.cost_center_name||'',
      manager: b.manager||'', supplyMode: b.supply_mode||'parent_company',
      geoLat: b.geo_lat ? Number(b.geo_lat) : null, geoLng: b.geo_lng ? Number(b.geo_lng) : null,
      geoRadius: b.geo_radius || 100
    })));
  } catch(e) { res.json([]); }
});

router.post('/branches-full', async (req, res) => {
  try {
    const { id, brandId, code, name, location, type, warehouseId, costCenterId, manager, supplyMode, geoLat, geoLng, geoRadius } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(
        'UPDATE branches SET brand_id=?, code=?, name=?, location=?, type=?, warehouse_id=?, cost_center_id=?, manager=?, supply_mode=?, geo_lat=?, geo_lng=?, geo_radius=? WHERE id=?',
        [brandId||null, code||'', name, location||'', type||'main', warehouseId||null, costCenterId||null, manager||'', supplyMode||'parent_company', geoLat||null, geoLng||null, geoRadius||100, id]);
      return res.json({ success: true, id });
    }
    const newId = 'BR-' + Date.now();
    await db.query(
      'INSERT INTO branches (id, brand_id, code, name, location, type, warehouse_id, cost_center_id, manager, supply_mode, geo_lat, geo_lng, geo_radius) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId, brandId||null, code||'', name, location||'', type||'main', warehouseId||null, costCenterId||null, manager||'', supplyMode||'parent_company', geoLat||null, geoLng||null, geoRadius||100]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
