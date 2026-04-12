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
    const { journalDate, referenceType, referenceId, description, entries, username, attachment, notes, isOpening } = req.body;
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
      `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, attachment, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [journalId, journalNumber, journalDate || new Date(), actualRefType, referenceId || '',
       description || '', totalDebit, totalCredit, 'draft', username || '', attachment || null, notes || '']
    );

    if (entries && entries.length) {
      for (const entry of entries) {
        const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
           VALUES (?,?,?,?,?,?,?,?)`,
          [entryId, journalId, entry.accountId || null, entry.accountCode || '',
           entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '']
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
          } catch(e) { console.log('[REPAIR] GL create error:', e.message); }
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
    // If old structure exists (code 6 as root), merge into code 5
    const [acc6] = await db.query("SELECT id FROM gl_accounts WHERE code = '6' AND (parent_id IS NULL OR parent_id = '')");
    const [acc5root] = await db.query("SELECT id FROM gl_accounts WHERE code = '5' AND (parent_id IS NULL OR parent_id = '')");

    if (acc6.length) {
      if (!acc5root.length) {
        // Rename code 6 → make it the main المصروفات (code 5)
        // First check if there's a code 5 that's a child (COGS under 6)
        const [acc5child] = await db.query("SELECT id FROM gl_accounts WHERE code = '5' AND parent_id IS NOT NULL");
        if (acc5child.length) {
          // Old COGS (code 5) was under code 6 — make it level 2 under new structure
          // Rename code 6 to be the root المصروفات
          await db.query("UPDATE gl_accounts SET name_ar = 'المصروفات', parent_id = NULL, level = 1 WHERE id = ?", [acc6[0].id]);
          await db.query("UPDATE gl_accounts SET parent_id = ?, level = 2 WHERE id = ?", [acc6[0].id, acc5child[0].id]);
          fixed++;
        }
      } else {
        // Both code 5 (root) and code 6 (root) exist — move 6's children under 5
        await db.query("UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?", [acc5root[0].id, acc6[0].id]);
        await db.query("DELETE FROM gl_accounts WHERE id = ?", [acc6[0].id]);
        fixed++;
      }
    }

    // Fix any orphaned children with old 61x, 62x codes — reparent them
    const [old61] = await db.query("SELECT id FROM gl_accounts WHERE code = '61'");
    const [old62] = await db.query("SELECT id FROM gl_accounts WHERE code = '62'");
    // These might still reference old parent — fix if needed

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

// Inventory valuation — real-time stock value from inv_items
router.get('/inventory-valuation', async (req, res) => {
  try {
    const [items] = await db.query('SELECT id, name, category, cost, stock, unit FROM inv_items WHERE active = 1');
    const [methodRow] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    const method = methodRow.length ? methodRow[0].setting_value : 'perpetual';

    // Group by category
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
  } catch(e) { res.json({ method: 'perpetual', categories: {}, totalValue: 0, itemCount: 0 }); }
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

    // Update parent 112 balance
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

module.exports = router;
