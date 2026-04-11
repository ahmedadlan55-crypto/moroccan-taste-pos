// ====================================================================
// ERP Frontend Logic — MASTER_ERP_SYSTEM_SPEC Compliant
// ====================================================================

// Bridge: currentUser from POS state
Object.defineProperty(window, 'currentUser', { get: function() { return (typeof state !== 'undefined' && state.user) ? state.user : ''; } });

// ═══════════════════════════════════════
// ERP NAVIGATION
// ═══════════════════════════════════════
const erpSections = [
  'erpDashHome','erpCustomers','erpSuppliers','erpGLAccounts','erpGLJournals',
  'erpPurchaseOrders','erpVATReports','erpZATCA','erpFinReports',
  'erpBranches','erpPeriods','erpAuditLog','erpCreditNotes',
  'erpWarehouses','erpWarehouseStock','erpStockTransfers',
  'erpARAging','erpAPAging','erpCustomerStatement','erpSupplierStatement'
];

function erpNav(sectionId) {
  // Hide all POS admin sections
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  // Hide all ERP dash sections
  document.querySelectorAll('.dash-section').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(sectionId);
  if (target) {
    target.classList.remove('hidden');
    // Load data for the section
    switch(sectionId) {
      case 'erpDashHome': erpLoadDashboard(); break;
      case 'erpCustomers': erpLoadCustomers(); break;
      case 'erpSuppliers': erpLoadSuppliers(); break;
      case 'erpGLAccounts': erpLoadAccounts(); break;
      case 'erpGLJournals': erpLoadJournals(); break;
      case 'erpPurchaseOrders': erpLoadPOs(); break;
      case 'erpVATReports': erpLoadVATReports(); break;
      case 'erpZATCA': erpLoadZATCA(); break;
      case 'erpFinReports': erpShowFinReport('trial'); break;
      case 'erpBranches': erpLoadBranches(); break;
      case 'erpPeriods': erpLoadPeriods(); break;
      case 'erpAuditLog': erpLoadAuditLog(); break;
      case 'erpCreditNotes': erpLoadNotes(); break;
      case 'erpWarehouses': erpLoadWarehouses(); break;
      case 'erpWarehouseStock': erpLoadWarehouseStock(); break;
      case 'erpStockTransfers': erpLoadTransfers(); break;
      case 'erpARAging': erpLoadARAging(); break;
      case 'erpAPAging': erpLoadAPAging(); break;
      case 'erpCustomerStatement': erpLoadCustomerStatementPage(); break;
      case 'erpSupplierStatement': erpLoadSupplierStatementPage(); break;
    }
  }
  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  const activeItem = document.querySelector(`[data-erp-nav="${sectionId}"]`);
  if (activeItem) activeItem.classList.add('active');
}

// ═══════════════════════════════════════
// ERP DASHBOARD
// ═══════════════════════════════════════
function erpLoadDashboard() {
  window._apiBridge.withSuccessHandler(function(data) {
    if (!data || !data.success) return;
    document.getElementById('erpCustCount').textContent = data.counts.customers || 0;
    document.getElementById('erpSupCount').textContent = data.counts.suppliers || 0;
    document.getElementById('erpJrnCount').textContent = data.counts.journals || 0;
    document.getElementById('erpBrCount').textContent = data.counts.branches || 0;
    document.getElementById('erpTotalAssets').textContent = (data.financial.totalAssets||0).toFixed(2);
    document.getElementById('erpTotalLiab').textContent = (data.financial.totalLiabilities||0).toFixed(2);
    document.getElementById('erpTotalEquity').textContent = (data.financial.totalEquity||0).toFixed(2);
    document.getElementById('erpTotalRev').textContent = (data.financial.totalRevenue||0).toFixed(2);
    document.getElementById('erpTotalExp').textContent = (data.financial.totalExpenses||0).toFixed(2);
    const ni = data.financial.netIncome || 0;
    const niEl = document.getElementById('erpNetIncome');
    niEl.textContent = ni.toFixed(2);
    niEl.className = 'fin-val ' + (ni >= 0 ? 'text-green' : 'text-red');
    document.getElementById('erpVATOutput').textContent = (data.vat.totalOutputVAT||0).toFixed(2);
    document.getElementById('erpVATInput').textContent = (data.vat.totalInputVAT||0).toFixed(2);
    document.getElementById('erpVATNet').textContent = (data.vat.netVAT||0).toFixed(2);
  }).getERPDashboardData();
}

// ═══════════════════════════════════════
// CUSTOMERS CRUD
// ═══════════════════════════════════════
let _erpCustomers = [];
function erpLoadCustomers() {
  window._apiBridge.withSuccessHandler(function(list) {
    _erpCustomers = list || [];
    const tbody = document.getElementById('erpCustomersBody');
    if (_erpCustomers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">لا يوجد عملاء</td></tr>';
      return;
    }
    tbody.innerHTML = _erpCustomers.map(c => `<tr>
      <td>${c.id||''}</td><td><strong>${c.name||''}</strong></td><td>${c.vatNumber||'-'}</td>
      <td>${c.phone||'-'}</td><td><span class="badge badge-${c.customerType==='B2B'?'blue':'green'}">${c.customerType||'B2C'}</span></td>
      <td>${(Number(c.balance)||0).toFixed(2)}</td>
      <td><span class="badge badge-${c.isActive!==false?'green':'red'}">${c.isActive!==false?'نشط':'معطل'}</span></td>
      <td><button class="btn-icon" onclick="erpEditCustomer('${c.id}')"><i class="fas fa-edit"></i></button>
      <button class="btn-icon text-red" onclick="erpDeactivateCustomer('${c.id}')"><i class="fas fa-ban"></i></button></td>
    </tr>`).join('');
  }).getCustomers();
}

function erpOpenCustomerModal(data) {
  const d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل عميل' : 'إضافة عميل جديد';
  document.getElementById('erpModalBody').innerHTML = `
    <input type="hidden" id="erpCustID" value="${d.id||''}">
    <div class="form-row"><label>الاسم (عربي) *</label><input class="form-control" id="erpCustName" value="${d.name||''}"></div>
    <div class="form-row"><label>الاسم (إنجليزي)</label><input class="form-control" id="erpCustNameEN" value="${d.nameEn||''}"></div>
    <div class="form-row"><label>الرقم الضريبي</label><input class="form-control" id="erpCustVAT" value="${d.vatNumber||''}"></div>
    <div class="form-row"><label>الهاتف</label><input class="form-control" id="erpCustPhone" value="${d.phone||''}"></div>
    <div class="form-row"><label>البريد الإلكتروني</label><input class="form-control" id="erpCustEmail" value="${d.email||''}"></div>
    <div class="form-row"><label>العنوان</label><input class="form-control" id="erpCustAddr" value="${d.address||''}"></div>
    <div class="form-row"><label>المدينة</label><input class="form-control" id="erpCustCity" value="${d.city||''}"></div>
    <div class="form-row"><label>نوع العميل</label><select class="form-control" id="erpCustType"><option value="B2C" ${d.customerType==='B2C'?'selected':''}>B2C — مستهلك</option><option value="B2B" ${d.customerType==='B2B'?'selected':''}>B2B — شركة</option><option value="B2G" ${d.customerType==='B2G'?'selected':''}>B2G — جهة حكومية</option></select></div>
    <div class="form-row"><label>حد الائتمان</label><input type="number" class="form-control" id="erpCustCredit" value="${d.creditLimit||0}"></div>`;
  document.getElementById('erpModalSaveBtn').onclick = erpSaveCustomer;
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpEditCustomer(id) {
  const c = _erpCustomers.find(x => String(x.id) === String(id));
  if (c) erpOpenCustomerModal(c);
}

function erpSaveCustomer() {
  const data = {
    id: document.getElementById('erpCustID').value || '',
    name: (document.getElementById('erpCustName').value || '').trim(),
    nameEn: document.getElementById('erpCustNameEN').value || '',
    vatNumber: document.getElementById('erpCustVAT').value || '',
    phone: document.getElementById('erpCustPhone').value || '',
    email: document.getElementById('erpCustEmail').value || '',
    address: document.getElementById('erpCustAddr').value || '',
    city: document.getElementById('erpCustCity').value || '',
    customerType: document.getElementById('erpCustType').value || 'B2C',
    creditLimit: Number(document.getElementById('erpCustCredit').value) || 0,
    username: currentUser || ''
  };
  if (!data.name) return showToast('الاسم مطلوب', 'error');
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res && res.success) { showToast('تم الحفظ بنجاح'); erpCloseModal(); erpLoadCustomers(); }
    else showToast((res && res.error) || 'فشل الحفظ', 'error');
  }).withFailureHandler(function(e) {
    loader(false);
    showToast('خطأ في الاتصال: ' + e.message, 'error');
  }).saveCustomer(data, currentUser);
}

function erpDeactivateCustomer(id) {
  if (!confirm('هل تريد تعطيل هذا العميل؟')) return;
  window._apiBridge.withSuccessHandler(function(res) {
    if (res.success) { showToast('تم التعطيل'); erpLoadCustomers(); }
    else showToast(res.error, 'error');
  }).deleteCustomer(id, currentUser);
}

// ═══════════════════════════════════════
// SUPPLIERS CRUD
// ═══════════════════════════════════════
let _erpSuppliers = [];
function erpLoadSuppliers() {
  var tbody = document.getElementById('erpSuppliersBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-msg"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</td></tr>';
  window._apiBridge
    .withSuccessHandler(function(list) {
      _erpSuppliers = list || [];
      erpRenderSuppliersTable(_erpSuppliers);
    })
    .withFailureHandler(function(e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-msg" style="color:red;">خطأ: ' + e.message + '</td></tr>';
    })
    .getSuppliers();
}

function erpFilterSuppliersTable() {
  const q = (document.getElementById('erpSupSearch')?.value || '').toLowerCase();
  const filtered = q ? _erpSuppliers.filter(s => (s.name||'').toLowerCase().includes(q) || (s.phone||'').includes(q) || (s.vatNumber||'').includes(q)) : _erpSuppliers;
  erpRenderSuppliersTable(filtered);
}

function erpRenderSuppliersTable(list) {
  const tbody = document.getElementById('erpSuppliersBody');
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">لا يوجد موردين</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(s => `<tr>
    <td><code style="font-size:11px;">${s.id||''}</code></td>
    <td><strong>${s.name||''}</strong>${s.nameEn ? `<br><small style="color:#64748b;">${s.nameEn}</small>` : ''}</td>
    <td>${s.vatNumber||'—'}</td>
    <td>${s.phone||'—'}</td>
    <td><span class="badge badge-blue">${s.paymentTerms||'Cash'}</span></td>
    <td><strong>${(Number(s.balance)||0).toFixed(2)}</strong></td>
    <td><span class="badge badge-${s.isActive!==false?'green':'red'}">${s.isActive!==false?'نشط':'معطل'}</span></td>
    <td style="white-space:nowrap;">
      <button class="btn-icon" title="تعديل" onclick="erpEditSupplier('${s.id}')"><i class="fas fa-edit"></i></button>
      <button class="btn-icon text-red" title="حذف" onclick="erpDeleteSupplier('${s.id}','${(s.name||'').replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('');
}

function erpOpenSupplierModal(data) {
  const d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل مورد' : 'إضافة مورد جديد';
  document.getElementById('erpModalBody').innerHTML = `
    <input type="hidden" id="erpSupID" value="${d.id||''}">
    <div class="form-row"><label>الاسم (عربي) *</label><input class="form-control" id="erpSupName" value="${d.name||''}"></div>
    <div class="form-row"><label>الاسم (إنجليزي)</label><input class="form-control" id="erpSupNameEN" value="${d.nameEn||''}"></div>
    <div class="form-row"><label>الرقم الضريبي</label><input class="form-control" id="erpSupVAT" value="${d.vatNumber||''}"></div>
    <div class="form-row"><label>الهاتف</label><input class="form-control" id="erpSupPhone" value="${d.phone||''}"></div>
    <div class="form-row"><label>البريد الإلكتروني</label><input class="form-control" id="erpSupEmail" value="${d.email||''}"></div>
    <div class="form-row"><label>العنوان</label><input class="form-control" id="erpSupAddr" value="${d.address||''}"></div>
    <div class="form-row"><label>المدينة</label><input class="form-control" id="erpSupCity" value="${d.city||''}"></div>
    <div class="form-row"><label>شروط الدفع</label><select class="form-control" id="erpSupTerms"><option value="Cash" ${d.paymentTerms==='Cash'?'selected':''}>نقدي</option><option value="Net30" ${d.paymentTerms==='Net30'?'selected':''}>30 يوم</option><option value="Net60" ${d.paymentTerms==='Net60'?'selected':''}>60 يوم</option></select></div>`;
  document.getElementById('erpModalSaveBtn').onclick = erpSaveSupplier;
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpEditSupplier(id) {
  const s = _erpSuppliers.find(x => String(x.id) === String(id));
  if (s) erpOpenSupplierModal(s);
}

function erpSaveSupplier() {
  const data = {
    id: document.getElementById('erpSupID').value || '',
    name: (document.getElementById('erpSupName').value || '').trim(),
    nameEn: document.getElementById('erpSupNameEN').value || '',
    vatNumber: document.getElementById('erpSupVAT').value || '',
    phone: document.getElementById('erpSupPhone').value || '',
    email: document.getElementById('erpSupEmail').value || '',
    address: document.getElementById('erpSupAddr').value || '',
    city: document.getElementById('erpSupCity').value || '',
    paymentTerms: document.getElementById('erpSupTerms').value || 'Cash',
    username: currentUser || ''
  };
  if (!data.name) return showToast('اسم المورد مطلوب', 'error');
  const btn = document.getElementById('erpModalSaveBtn');
  if (btn) btn.disabled = true;
  loader(true);
  window._apiBridge
    .withSuccessHandler(function(res) {
      loader(false);
      if (btn) btn.disabled = false;
      if (res && res.success) {
        showToast('تم حفظ المورد بنجاح');
        erpCloseModal();
        erpLoadSuppliers();
      } else {
        showToast((res && res.error) || 'فشل الحفظ', 'error');
      }
    })
    .withFailureHandler(function(e) {
      loader(false);
      if (btn) btn.disabled = false;
      showToast('خطأ في الاتصال: ' + e.message, 'error');
    })
    .saveSupplier(data, currentUser);
}

function erpDeleteSupplier(id, name) {
  if (!confirm('هل تريد حذف المورد "' + (name||id) + '" نهائياً؟')) return;
  loader(true);
  window._apiBridge
    .withSuccessHandler(function(res) {
      loader(false);
      if (res && res.success) { showToast('تم حذف المورد'); erpLoadSuppliers(); }
      else showToast((res && res.error) || 'خطأ', 'error');
    })
    .withFailureHandler(function(e) { loader(false); showToast('خطأ: ' + e.message, 'error'); })
    .deleteSupplier(id, currentUser);
}

// ═══════════════════════════════════════
// GL ACCOUNTS (دليل الحسابات)
// ═══════════════════════════════════════
let _erpAccounts = [];
function erpLoadAccounts() {
  window._apiBridge.withSuccessHandler(function() {
    erpLoadAccountsList_();
  }).seedCafeGLAccounts();
}
function erpLoadAccountsList_() {
  window._apiBridge.withSuccessHandler(function(list) {
    _erpAccounts = (list || []).map(a => ({
      id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn,
      type: a.type, parentId: a.parentId, level: Number(a.level)||1,
      isActive: a.isActive, balance: Number(a.balance)||0
    }));
    const tbody = document.getElementById('erpAccountsBody');
    if (!_erpAccounts.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد حسابات</td></tr>'; return; }

    const typeLabels = {asset:'أصول',liability:'التزامات',equity:'حقوق ملكية',revenue:'إيرادات',expense:'مصروفات'};
    const typeColors = {asset:'#3b82f6',liability:'#ef4444',equity:'#8b5cf6',revenue:'#16a34a',expense:'#f59e0b'};

    // Build tree-ordered list
    const byParent = {};
    _erpAccounts.forEach(a => {
      const pid = a.parentId || '__root__';
      if (!byParent[pid]) byParent[pid] = [];
      byParent[pid].push(a);
    });
    const ordered = [];
    function walk(pid) {
      const children = byParent[pid] || [];
      children.sort((a,b) => a.code.localeCompare(b.code));
      children.forEach(a => { ordered.push(a); walk(a.id); });
    }
    walk('__root__');
    // Add any orphans not in tree
    _erpAccounts.forEach(a => { if (!ordered.includes(a)) ordered.push(a); });

    tbody.innerHTML = ordered.map(a => {
      const lvl = a.level;
      const indent = lvl > 1 ? (lvl - 1) * 22 : 0;
      const isParent = !!byParent[a.id];
      const weight = lvl <= 2 ? '900' : lvl === 3 ? '700' : '400';
      const bgShade = lvl === 1 ? 'background:rgba(59,130,246,0.04);' : '';
      const treeIcon = isParent
        ? '<i class="fas fa-folder-open" style="color:' + (typeColors[a.type]||'#64748b') + ';margin-left:6px;font-size:12px;"></i>'
        : '<i class="fas fa-file-alt" style="color:#94a3b8;margin-left:6px;font-size:11px;"></i>';
      const bal = a.balance !== 0 ? '<span style="color:' + (a.balance >= 0 ? '#16a34a' : '#ef4444') + ';font-weight:700;">' + a.balance.toFixed(2) + '</span>' : '<span style="color:#cbd5e1;">0.00</span>';

      return '<tr style="' + bgShade + '">' +
        '<td><code style="font-weight:' + weight + ';font-size:' + (lvl<=2?'14px':'12px') + ';">' + a.code + '</code></td>' +
        '<td style="padding-right:' + indent + 'px;font-weight:' + weight + ';font-size:' + (lvl<=2?'14px':'13px') + ';">' + treeIcon + (a.nameAr||'') + '</td>' +
        '<td style="font-size:12px;color:#64748b;">' + (a.nameEn||'') + '</td>' +
        '<td><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:' + (typeColors[a.type]||'#e2e8f0') + '20;color:' + (typeColors[a.type]||'#64748b') + ';">' + (typeLabels[a.type]||a.type) + '</span></td>' +
        '<td style="text-align:center;font-size:12px;">' + lvl + '</td>' +
        '<td style="text-align:left;">' + bal + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="btn-icon" onclick="erpEditAccount(\'' + a.id + '\')" title="تعديل"><i class="fas fa-edit"></i></button> ' +
          '<button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteAccount(\'' + a.id + '\',\'' + a.code + '\',\'' + (a.nameAr||'').replace(/'/g,'') + '\')" title="حذف"><i class="fas fa-trash"></i></button> ' +
          (isParent ? '' : '<button class="btn-icon" style="color:#16a34a;" onclick="erpAddChildAccount(\'' + a.id + '\',\'' + a.code + '\')" title="إضافة فرعي"><i class="fas fa-plus-circle"></i></button>') +
        '</td></tr>';
    }).join('');
  }).getGLAccounts();
}

function erpOpenAccountModal(data) {
  const d = data || {};
  const isEdit = !!d.id;
  document.getElementById('erpModalTitle').textContent = isEdit ? 'تعديل حساب' : 'إضافة حساب جديد';

  // Build parent options grouped by type
  const parentOpts = _erpAccounts
    .filter(a => a.level < 4)
    .sort((a,b) => a.code.localeCompare(b.code))
    .map(a => {
      const indent = '\u00A0\u00A0'.repeat((a.level - 1));
      const sel = d.parentId === a.id ? ' selected' : '';
      return '<option value="' + a.id + '"' + sel + '>' + indent + a.code + ' — ' + a.nameAr + '</option>';
    }).join('');

  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="erpAccID" value="' + (d.id||'') + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>رمز الحساب *</label><input class="form-control" id="erpAccCode" value="' + (d.code||'') + '" ' + (isEdit?'readonly':'') + ' placeholder="مثال: 11201"></div>' +
      '<div class="form-row"><label>النوع *</label><select class="form-control" id="erpAccType">' +
        '<option value="asset"' + (d.type==='asset'?' selected':'') + '>أصول</option>' +
        '<option value="liability"' + (d.type==='liability'?' selected':'') + '>التزامات</option>' +
        '<option value="equity"' + (d.type==='equity'?' selected':'') + '>حقوق ملكية</option>' +
        '<option value="revenue"' + (d.type==='revenue'?' selected':'') + '>إيرادات</option>' +
        '<option value="expense"' + (d.type==='expense'?' selected':'') + '>مصروفات</option></select></div>' +
    '</div>' +
    '<div class="form-row"><label>الاسم (عربي) *</label><input class="form-control" id="erpAccNameAR" value="' + (d.nameAr||'') + '" placeholder="اسم الحساب بالعربي"></div>' +
    '<div class="form-row"><label>الاسم (إنجليزي)</label><input class="form-control" id="erpAccNameEN" value="' + (d.nameEn||'') + '" placeholder="Account name in English"></div>' +
    '<div class="form-row"><label>الحساب الرئيسي (الأب)</label><select class="form-control" id="erpAccParent"><option value="">— حساب رئيسي (بدون أب) —</option>' + parentOpts + '</select></div>' +
    '<input type="hidden" id="erpAccLevel" value="' + (d.level||1) + '">';

  // Auto-set level + auto-generate next code when parent changes
  setTimeout(function() {
    var parentSel = document.getElementById('erpAccParent');
    if (parentSel) parentSel.onchange = function() {
      var pid = parentSel.value;
      var codeEl = document.getElementById('erpAccCode');
      var levelEl = document.getElementById('erpAccLevel');
      if (!pid) {
        levelEl.value = 1;
        if (!isEdit) { codeEl.value = ''; codeEl.placeholder = 'مثال: 11201'; }
        return;
      }
      var parent = _erpAccounts.find(function(a) { return a.id === pid; });
      if (!parent) return;
      levelEl.value = parent.level + 1;

      if (!isEdit) {
        // Find all direct children of this parent and compute next code
        var parentCode = parent.code;
        var children = _erpAccounts.filter(function(a) { return a.parentId === pid; });
        var childCodes = children.map(function(a) { return a.code; }).sort();

        if (!childCodes.length) {
          // No children yet — first child: parentCode + "01" or "1" depending on level
          if (parent.level >= 3) {
            codeEl.value = parentCode + '01';
          } else {
            codeEl.value = parentCode + '1';
          }
        } else {
          // Get last child code and increment
          var lastCode = childCodes[childCodes.length - 1];
          // Extract the suffix after parent code
          var suffix = lastCode.substring(parentCode.length);
          var nextNum = parseInt(suffix, 10) + 1;
          // Keep same suffix length (zero-padded)
          var padded = String(nextNum).padStart(suffix.length, '0');
          codeEl.value = parentCode + padded;
        }
        codeEl.placeholder = '';
      }
    };
  }, 50);

  document.getElementById('erpModalSaveBtn').onclick = erpSaveAccount;
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpEditAccount(id) {
  const a = _erpAccounts.find(x => x.id === id);
  if (a) erpOpenAccountModal(a);
}

function erpAddChildAccount(parentId, parentCode) {
  const parent = _erpAccounts.find(x => x.id === parentId);
  if (!parent) return;
  // Compute next child code
  var children = _erpAccounts.filter(function(a) { return a.parentId === parentId; });
  var childCodes = children.map(function(a) { return a.code; }).sort();
  var nextCode = '';
  if (!childCodes.length) {
    nextCode = parent.level >= 3 ? parentCode + '01' : parentCode + '1';
  } else {
    var lastCode = childCodes[childCodes.length - 1];
    var suffix = lastCode.substring(parentCode.length);
    var nextNum = parseInt(suffix, 10) + 1;
    nextCode = parentCode + String(nextNum).padStart(suffix.length, '0');
  }
  erpOpenAccountModal({
    parentId: parentId,
    type: parent.type,
    level: parent.level + 1,
    code: nextCode
  });
}

function erpDeleteAccount(id, code, name) {
  if (!confirm('هل أنت متأكد من حذف الحساب:\n' + code + ' — ' + name + '?')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم حذف الحساب'); erpLoadAccounts(); }
    else showToast(res.error, true);
  }).deleteGLAccount(id);
}

function erpSaveAccount() {
  const data = {
    id: document.getElementById('erpAccID').value || '',
    code: document.getElementById('erpAccCode').value,
    nameAr: document.getElementById('erpAccNameAR').value,
    nameEn: document.getElementById('erpAccNameEN').value,
    type: document.getElementById('erpAccType').value,
    parentId: document.getElementById('erpAccParent').value,
    level: document.getElementById('erpAccLevel').value
  };
  if (!data.code || !data.nameAr) return showToast('الرمز والاسم مطلوبان', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadAccounts(); }
    else showToast(res.error, true);
  }).saveGLAccount(data, currentUser);
}

// ═══════════════════════════════════════
// GL JOURNALS
// ═══════════════════════════════════════
// ─── Journal cache for viewing entries ───
var _jrnCache = [];

function erpLoadJournals() {
  const filters = {};
  const s = document.getElementById('erpJrnStartDate');
  const e = document.getElementById('erpJrnEndDate');
  if (s && s.value) filters.startDate = s.value;
  if (e && e.value) filters.endDate = e.value;

  window._apiBridge.withSuccessHandler(function(list) {
    _jrnCache = list || [];
    const tbody = document.getElementById('erpJournalsBody');
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد قيود</td></tr>'; return; }
    const refLabels = {manual:'يدوي',custody_expense:'عهدة',sale:'مبيعات',purchase:'مشتريات'};
    tbody.innerHTML = list.map(j => {
      const dt = j.journalDate ? new Date(j.journalDate).toLocaleDateString('en-GB') : '';
      return `<tr>
        <td><code style="font-weight:800;">${j.journalNumber||''}</code></td>
        <td>${dt}</td>
        <td><span class="badge badge-blue">${refLabels[j.referenceType]||j.referenceType||''}</span></td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${j.description||''}</td>
        <td class="text-green" style="font-weight:700;">${(j.totalDebit||0).toFixed(2)}</td>
        <td class="text-red" style="font-weight:700;">${(j.totalCredit||0).toFixed(2)}</td>
        <td><span class="badge badge-green">${j.status||''}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn-icon" onclick="erpViewJournal('${j.id}')" title="تفاصيل"><i class="fas fa-eye"></i></button>
          <button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteJournal('${j.id}','${j.journalNumber||''}')" title="حذف"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  }).getGLJournals(filters);
}

function erpViewJournal(journalId) {
  // Try cache first, then API
  var j = _jrnCache.find(function(x) { return x.id === journalId; });
  if (j && j.entries && j.entries.length) {
    _renderJournalDetail(j.entries);
  } else {
    window._apiBridge.withSuccessHandler(function(entries) {
      _renderJournalDetail(entries || []);
    }).getGLEntries(journalId);
  }
}
function _renderJournalDetail(entries) {
  let html = '<table class="erp-table"><thead><tr><th>رقم الحساب</th><th>اسم الحساب</th><th>الوصف</th><th>مدين</th><th>دائن</th></tr></thead><tbody>';
  let totalD = 0, totalC = 0;
  entries.forEach(function(e) {
    totalD += Number(e.debit)||0; totalC += Number(e.credit)||0;
    html += '<tr><td><code>' + (e.accountCode||'') + '</code></td><td style="font-weight:700;">' + (e.accountName||'') + '</td><td style="color:#64748b;font-size:12px;">' + (e.description||'') + '</td>' +
      '<td class="text-green">' + ((e.debit||0) > 0 ? Number(e.debit).toFixed(2) : '') + '</td>' +
      '<td class="text-red">' + ((e.credit||0) > 0 ? Number(e.credit).toFixed(2) : '') + '</td></tr>';
  });
  html += '<tr class="total-row"><td colspan="3"><strong>الإجمالي</strong></td><td class="text-green"><strong>' + totalD.toFixed(2) + '</strong></td><td class="text-red"><strong>' + totalC.toFixed(2) + '</strong></td></tr>';
  html += '</tbody></table>';
  document.getElementById('erpJournalDetailBody').innerHTML = html;
  document.getElementById('erpJournalDetailModal').classList.remove('hidden');
}

function erpDeleteJournal(id, num) {
  if (!confirm('حذف القيد ' + num + '؟\nسيتم عكس جميع الأرصدة المتأثرة.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم حذف القيد وعكس الأرصدة'); erpLoadJournals(); erpLoadAccountsList_(); }
    else showToast(r.error, true);
  }).deleteGLJournal(id);
}

// ─── Build account path (الأصول → المتداولة → الصندوق) ───
function _getAccountPath(accountId) {
  var path = [];
  var current = _erpAccounts.find(function(a) { return a.id === accountId; });
  while (current) {
    path.unshift(current.nameAr);
    if (!current.parentId) break;
    current = _erpAccounts.find(function(a) { return a.id === current.parentId; });
  }
  return path.join(' → ');
}

// ─── Get leaf accounts (فرعية فقط) ───
function _getLeafAccounts() {
  var parentIds = {};
  _erpAccounts.forEach(function(a) { if (a.parentId) parentIds[a.parentId] = true; });
  return _erpAccounts.filter(function(a) { return !parentIds[a.id]; });
}

// ─── Journal creation modal ───
var _jrnLineCounter = 0;

function erpOpenJournalModal() {
  document.getElementById('erpModalTitle').textContent = 'قيد محاسبي جديد';
  _jrnLineCounter = 0;

  if (_erpAccounts.length === 0) {
    window._apiBridge.withSuccessHandler(function(list) {
      _erpAccounts = (list || []).map(function(a) {
        return { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: a.type, parentId: a.parentId, level: Number(a.level)||1, balance: Number(a.balance)||0 };
      });
      _renderJournalForm();
    }).getGLAccounts();
  } else {
    _renderJournalForm();
  }
}

function _renderJournalForm() {
  var today = new Date().toISOString().split('T')[0];

  document.getElementById('erpModalBody').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>تاريخ القيد *</label><input type="date" class="form-control" id="erpJrnDate" value="' + today + '"></div>' +
      '<div class="form-row"><label>رقم القيد</label><input class="form-control" id="erpJrnNum" placeholder="تلقائي" readonly style="background:#f8fafc;color:#94a3b8;"></div>' +
    '</div>' +
    '<div class="form-row"><label>عنوان القيد / الوصف *</label><input class="form-control" id="erpJrnDesc" placeholder="مثال: تسجيل مبيعات يوم 10/4"></div>' +
    '<div class="form-row"><label>ملاحظات إضافية</label><input class="form-control" id="erpJrnRef" placeholder="اختياري..."></div>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:14px 0;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<h4 style="margin:0;color:#1e293b;"><i class="fas fa-list-ol" style="color:#3b82f6;margin-left:6px;"></i> بنود القيد</h4>' +
      '<button class="btn btn-sm btn-secondary" onclick="erpAddJrnLine()" style="border-radius:10px;"><i class="fas fa-plus"></i> إضافة سطر</button>' +
    '</div>' +
    '<div id="erpJrnLines"></div>' +
    '<div class="jrn-balance-bar" id="erpJrnBalanceInfo">مدين: <strong>0.00</strong> | دائن: <strong>0.00</strong></div>';

  document.getElementById('erpModalSaveBtn').onclick = erpSaveJournal;
  document.getElementById('erpModal').classList.remove('hidden');

  // Add 2 initial lines
  erpAddJrnLine();
  erpAddJrnLine();
}

function erpAddJrnLine() {
  _jrnLineCounter++;
  var leafAccounts = _getLeafAccounts();
  var lineId = 'jln' + _jrnLineCounter;
  var div = document.createElement('div');
  div.className = 'jrn-entry-card';
  div.id = lineId;
  div.innerHTML =
    '<div class="jec-header">' +
      '<span class="jec-num">' + _jrnLineCounter + '</span>' +
      '<button class="btn-icon" style="color:#ef4444;" onclick="erpRemoveJrnLine(\'' + lineId + '\')" title="حذف"><i class="fas fa-trash-alt"></i></button>' +
    '</div>' +
    '<div class="jec-account-wrap">' +
      '<input type="text" class="form-control jec-search" placeholder="ابحث عن حساب..." oninput="erpFilterAccounts(this)">' +
      '<select class="form-control jec-acc" onchange="erpOnAccChange(this)">' +
        '<option value="">— اختر حساب —</option>' +
        leafAccounts.map(function(a) {
          var typeLabels = {asset:'أصول',liability:'التزامات',equity:'ملكية',revenue:'إيرادات',expense:'مصروفات'};
          return '<option value="' + a.id + '" data-code="' + a.code + '" data-name="' + (a.nameAr||'') + '" data-type="' + a.type + '">' + a.code + ' — ' + (a.nameAr||'') + ' (' + (typeLabels[a.type]||'') + ')</option>';
        }).join('') +
      '</select>' +
      '<div class="jec-path"></div>' +
    '</div>' +
    '<div class="jec-amounts">' +
      '<div><label>مدين</label><input type="number" class="form-control jec-debit" step="0.01" min="0" placeholder="0.00" oninput="erpCalcJrnBalance()"></div>' +
      '<div><label>دائن</label><input type="number" class="form-control jec-credit" step="0.01" min="0" placeholder="0.00" oninput="erpCalcJrnBalance()"></div>' +
      '<div style="flex:2;"><label>وصف السطر</label><input type="text" class="form-control jec-desc" placeholder="اختياري..."></div>' +
    '</div>';

  document.getElementById('erpJrnLines').appendChild(div);
}

window.erpRemoveJrnLine = function(lineId) {
  var el = document.getElementById(lineId);
  if (el) el.remove();
  erpCalcJrnBalance();
};

// Searchable account filter
window.erpFilterAccounts = function(input) {
  var val = input.value.toLowerCase();
  var select = input.parentElement.querySelector('.jec-acc');
  var options = select.querySelectorAll('option');
  var visibleCount = 0;
  options.forEach(function(opt) {
    if (!opt.value) { opt.style.display = ''; return; }
    var text = opt.textContent.toLowerCase();
    var show = text.indexOf(val) !== -1;
    opt.style.display = show ? '' : 'none';
    if (show) visibleCount++;
  });
  // Show dropdown only when searching
  if (val && visibleCount > 0) {
    select.size = Math.min(6, visibleCount + 1);
    select.style.display = 'block';
  } else if (!val) {
    select.size = 0;
    select.removeAttribute('size');
    select.style.display = '';
  }
};

// Close dropdown on click outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.jec-account-wrap')) {
    document.querySelectorAll('.jec-acc[size]').forEach(function(s) {
      s.removeAttribute('size');
    });
  }
});

// Show account path on selection
window.erpOnAccChange = function(select) {
  var pathEl = select.parentElement.querySelector('.jec-path');
  var searchEl = select.parentElement.querySelector('.jec-search');
  // Close dropdown
  select.removeAttribute('size');

  if (!select.value) { pathEl.innerHTML = ''; if (searchEl) searchEl.value = ''; return; }
  var opt = select.options[select.selectedIndex];
  var path = _getAccountPath(select.value);
  var typeLabels = {asset:'أصول',liability:'التزامات',equity:'ملكية',revenue:'إيرادات',expense:'مصروفات'};
  var typeBadge = {asset:'#3b82f6',liability:'#ef4444',equity:'#8b5cf6',revenue:'#16a34a',expense:'#f59e0b'};
  var type = opt.dataset.type || '';
  pathEl.innerHTML = '<i class="fas fa-sitemap" style="color:#94a3b8;margin-left:4px;"></i> ' + path +
    ' <span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800;background:' + (typeBadge[type]||'#e2e8f0') + '18;color:' + (typeBadge[type]||'#64748b') + ';">' + (typeLabels[type]||type) + '</span>';
  // Update search field with selected account
  if (searchEl) { searchEl.value = opt.dataset.code + ' — ' + (opt.dataset.name||''); }
};

function erpCalcJrnBalance() {
  var totalD = 0, totalC = 0;
  document.querySelectorAll('.jec-debit').forEach(function(el) { totalD += Number(el.value) || 0; });
  document.querySelectorAll('.jec-credit').forEach(function(el) { totalC += Number(el.value) || 0; });
  var bal = document.getElementById('erpJrnBalanceInfo');
  var balanced = Math.abs(totalD - totalC) < 0.01;
  bal.innerHTML = 'مدين: <strong style="color:#16a34a;">' + totalD.toFixed(2) + '</strong> | دائن: <strong style="color:#ef4444;">' + totalC.toFixed(2) + '</strong> | ' +
    '<span style="display:inline-block;padding:2px 10px;border-radius:8px;font-weight:800;font-size:12px;background:' + (balanced?'#dcfce7':'#fee2e2') + ';color:' + (balanced?'#166534':'#991b1b') + ';">' +
    (balanced?'<i class="fas fa-check-circle"></i> متوازن':'<i class="fas fa-exclamation-triangle"></i> غير متوازن — فرق: ' + Math.abs(totalD - totalC).toFixed(2)) + '</span>';
}

function erpSaveJournal() {
  var lines = document.querySelectorAll('.jrn-entry-card');
  var entries = [];
  lines.forEach(function(line) {
    var sel = line.querySelector('.jec-acc');
    if (!sel || !sel.value) return;
    var opt = sel.options[sel.selectedIndex];
    var debit = Number(line.querySelector('.jec-debit').value) || 0;
    var credit = Number(line.querySelector('.jec-credit').value) || 0;
    var desc = line.querySelector('.jec-desc') ? line.querySelector('.jec-desc').value : '';
    if (debit > 0 || credit > 0) {
      entries.push({
        accountId: sel.value,
        accountCode: opt.dataset.code || '',
        accountName: opt.dataset.name || '',
        debit: debit, credit: credit,
        description: desc
      });
    }
  });
  if (entries.length < 2) return showToast('يجب إدخال بندين على الأقل', true);
  var desc = document.getElementById('erpJrnDesc').value;
  if (!desc) return showToast('عنوان القيد مطلوب', true);

  var totalD = 0, totalC = 0;
  entries.forEach(function(e) { totalD += e.debit; totalC += e.credit; });
  if (Math.abs(totalD - totalC) > 0.01) return showToast('القيد غير متوازن — مدين: ' + totalD.toFixed(2) + ' | دائن: ' + totalC.toFixed(2), true);

  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم إنشاء القيد: ' + res.journalNumber); erpCloseModal(); erpLoadJournals(); }
    else showToast(res.error, true);
  }).createJournalEntry({
    journalDate: document.getElementById('erpJrnDate').value,
    referenceType: 'manual',
    referenceId: document.getElementById('erpJrnRef').value,
    description: desc,
    entries: entries
  }, currentUser);
}

// ═══════════════════════════════════════
// PURCHASE ORDERS — صفحة كاملة
// ═══════════════════════════════════════
let _erpPOAllData = [];
let _erpPOSuppliersList = [];
let _erpPOItemsList = [];
let _erpPOCart = [];

function erpLoadPOs() {
  window._apiBridge.withSuccessHandler(function(list) {
    _erpPOAllData = list || [];
    const s = document.getElementById('erpPOSummary');
    if (s) {
      s.style.display = 'grid';
      document.getElementById('erpPOTotalCount').textContent = _erpPOAllData.length;
      document.getElementById('erpPODraftCount').textContent = _erpPOAllData.filter(function(p){ return p.status === 'draft'; }).length;
      document.getElementById('erpPOApprovedCount').textContent = _erpPOAllData.filter(function(p){ return p.status === 'approved'; }).length;
      document.getElementById('erpPOReceivedCount').textContent = _erpPOAllData.filter(function(p){ return p.status === 'received'; }).length;
      document.getElementById('erpPOTotalValue').textContent = _erpPOAllData.reduce(function(a, p){ return a + (Number(p.totalAfterVat) || 0); }, 0).toFixed(2) + ' ر.س';
    }
    erpRenderPOTable(_erpPOAllData);
  }).getPurchaseOrders({});
}

function erpFilterPOTable() {
  const search = (document.getElementById('erpPOSearch')?.value || '').toLowerCase();
  const status = document.getElementById('erpPOStatusFilter')?.value || '';
  erpRenderPOTable(_erpPOAllData.filter(function(po) {
    return (!search || (po.poNumber || '').toLowerCase().includes(search) || (po.supplierName || '').toLowerCase().includes(search))
      && (!status || po.status === status);
  }));
}

function erpRenderPOTable(list) {
  var tbody = document.getElementById('erpPOBody');
  if (!list || !list.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-msg">لا توجد أوامر شراء</td></tr>'; return; }
  var sc = { draft: 'orange', approved: 'blue', received: 'green', cancelled: 'red' };
  var sl = { draft: 'مسودة', approved: 'معتمد', received: 'مستلم', cancelled: 'ملغي' };
  tbody.innerHTML = list.map(function(po) {
    var safeNum = String(po.poNumber || '').replace(/'/g, "\\'");
    return '<tr>' +
      '<td><code>' + (po.poNumber || '') + '</code></td>' +
      '<td><i class="fas fa-truck" style="color:var(--accent);margin-left:6px;font-size:11px;"></i>' + (po.supplierName || '—') + '</td>' +
      '<td>' + (po.poDate ? new Date(po.poDate).toLocaleDateString('en-GB') : '—') + '</td>' +
      '<td>' + (Number(po.totalBeforeVat) || 0).toFixed(2) + '</td>' +
      '<td><strong>' + (Number(po.totalAfterVat) || 0).toFixed(2) + '</strong></td>' +
      '<td><span class="badge badge-' + (sc[po.status] || 'blue') + '">' + (sl[po.status] || po.status) + '</span></td>' +
      '<td style="font-size:12px;color:#64748b;">' + (po.approvedBy || '—') + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-sm btn-outline" title="عرض" onclick="erpViewPO(\'' + po.id + '\')"><i class="fas fa-eye"></i></button> ' +
        (po.status === 'draft' ? '<button class="btn btn-sm btn-success" title="اعتماد" onclick="erpApprovePO(\'' + po.id + '\')"><i class="fas fa-check"></i></button> ' : '') +
        (po.status === 'approved' ? '<button class="btn btn-sm btn-outline" style="color:#d97706;border-color:#d97706;" title="تراجع" onclick="erpRevertPO(\'' + po.id + '\')"><i class="fas fa-undo"></i></button> ' : '') +
        '<button class="btn btn-sm btn-outline" title="طباعة" onclick="erpPrintPO(\'' + po.id + '\')"><i class="fas fa-print"></i></button> ' +
        (po.status === 'draft' ? '<button class="btn btn-sm btn-danger" title="حذف" onclick="erpDeletePO(\'' + po.id + '\',\'' + safeNum + '\')"><i class="fas fa-trash"></i></button>' : '') +
      '</td>' +
    '</tr>';
  }).join('');
}

function erpRevertPO(poId) {
  if (!confirm('هل تريد التراجع عن اعتماد أمر الشراء؟\nسيتم حذف الفاتورة المرتبطة.')) return;
  loader(true);
  window._apiBridge
    .withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم التراجع');erpLoadPOs();}else showToast(r.error||'خطأ','error'); })
    .withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
    .revertPurchaseOrder(poId, currentUser);
}

// ─── فتح صفحة إنشاء أمر شراء ───
function erpShowPOForm() {
  _erpEditingPOId = null;
  document.getElementById('erpPOListView').classList.add('hidden');
  document.getElementById('erpPOFormView').classList.remove('hidden');
  // Ensure add row and save btn are enabled for new PO
  var addRow = document.querySelector('#erpPOFormView .po-add-row');
  if (addRow) addRow.style.display = 'flex';
  var saveBtn = document.querySelector('#erpPOFormView .btn-primary');
  if (saveBtn) { saveBtn.textContent = ' حفظ أمر الشراء'; saveBtn.disabled = false; }
  // Reset
  document.getElementById('erpPOSupplierInput').value = '';
  document.getElementById('erpPOSupplierId').value = '';
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  var weekLater = new Date(today); weekLater.setDate(weekLater.getDate() + 7);
  var weekStr = weekLater.getFullYear() + '-' + String(weekLater.getMonth()+1).padStart(2,'0') + '-' + String(weekLater.getDate()).padStart(2,'0');
  document.getElementById('erpPODate').value = todayStr;
  document.getElementById('erpPOExpDate').value = weekStr;
  document.getElementById('erpPONotes').value = '';
  document.getElementById('erpPOItemSearch').value = '';
  document.getElementById('erpPOItemId').value = '';
  document.getElementById('erpPOItemNameH').value = '';
  document.getElementById('erpPOItemUnit').value = '';
  document.getElementById('erpPOItemQty').value = '1';
  document.getElementById('erpPOItemPrice').value = '';
  _erpPOCart = [];
  erpRenderPOCart();
  // Load data
  window._apiBridge.withSuccessHandler(function(s){ _erpPOSuppliersList=s||[]; }).withFailureHandler(function(){ _erpPOSuppliersList=[]; }).getSuppliers();
  window._apiBridge.withSuccessHandler(function(i){ _erpPOItemsList=i||[]; }).withFailureHandler(function(){ _erpPOItemsList=[]; }).getInvItems();
}

function erpBackToPOList() {
  document.getElementById('erpPOFormView').classList.add('hidden');
  document.getElementById('erpPOListView').classList.remove('hidden');
}

// ─── بحث المورد ───
function erpFilterPOSuppliers() {
  const q = (document.getElementById('erpPOSupplierInput')?.value || '').toLowerCase();
  const res = document.getElementById('erpPOSupplierResults');
  if (!res) return;
  // Backend returns camelCase: { id, name, phone, ... }
  const f = (_erpPOSuppliersList || []).filter(function(s) {
    return (s.name || '').toLowerCase().includes(q) || (s.phone || '').includes(q);
  });
  res.innerHTML = f.length ? f.slice(0, 15).map(function(s) {
    var safeName = String(s.name || '').replace(/'/g, "\\'");
    return '<div class="sd-result-item" onclick="erpSelectPOSupplier(\'' + s.id + '\',\'' + safeName + '\')">' +
      '<i class="fas fa-truck" style="margin-left:8px;color:var(--accent);font-size:12px;"></i>' + (s.name || '') +
      '<span class="sd-item-meta">' + (s.phone || '') + '</span></div>';
  }).join('') : '<div class="sd-result-item" style="color:#94a3b8;font-style:italic;">لا توجد نتائج — أضف المورد من قسم الموردين أولاً</div>';
  res.classList.add('open');
}
function erpSelectPOSupplier(id, name) {
  document.getElementById('erpPOSupplierInput').value = name;
  document.getElementById('erpPOSupplierId').value = id;
  document.getElementById('erpPOSupplierResults').classList.remove('open');
}

// ─── بحث المادة (searchable dropdown) ───
function erpFilterPOItemSearch() {
  const q = (document.getElementById('erpPOItemSearch')?.value||'').toLowerCase();
  const res = document.getElementById('erpPOItemResults');
  if (!res) return;
  if (!_erpPOItemsList.length) {
    res.innerHTML = '<div class="sd-result-item" style="color:#94a3b8;font-style:italic;">جاري التحميل...</div>';
    res.classList.add('open'); return;
  }
  const f = q ? _erpPOItemsList.filter(i=>(i.name||'').toLowerCase().includes(q)||(i.category||'').toLowerCase().includes(q)) : _erpPOItemsList;
  if (!f.length) {
    res.innerHTML = '<div class="sd-result-item" style="color:#94a3b8;">لا توجد مواد بهذا الاسم</div>';
  } else {
    res.innerHTML = f.slice(0,15).map(function(i){
      var stock = Number(i.stock)||0;
      var cost = Number(i.cost)||0;
      var unit = i.unit||'';
      var bigUnit = i.bigUnit||'';
      var convRate = Number(i.convRate)||1;
      var stockColor = stock <= (Number(i.minStock)||0) ? '#ef4444' : '#16a34a';
      return `<div class="sd-result-item" onclick="erpSelectPOItem('${(i.id||'').toString().replace(/'/g,"\\'")}','${(i.name||'').replace(/'/g,"\\'")}','${cost}','${unit.replace(/'/g,"\\'")}','${stock}','${bigUnit.replace(/'/g,"\\'")}','${convRate}')">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="sd-item-name">${i.name}</span>
          <span style="font-size:11px;color:${stockColor};font-weight:700;">مخزون: ${stock} ${unit}</span>
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">
          <code style="background:#e2e8f0;padding:1px 4px;border-radius:3px;font-size:10px;">${i.id||''}</code>
          ${bigUnit ? ' '+bigUnit+': '+cost.toFixed(2)+' ر.س |' : ''} ${unit||'وحدة'}: ${convRate>1?(cost/convRate).toFixed(2):cost.toFixed(2)} ر.س
        </div>
      </div>`;
    }).join('');
  }
  res.classList.add('open');
}
var _erpPOSelectedItem = null;
function erpSelectPOItem(id, name, cost, unit, stock, bigUnit, convRate) {
  document.getElementById('erpPOItemSearch').value = name;
  document.getElementById('erpPOItemId').value = id;
  document.getElementById('erpPOItemNameH').value = name;
  document.getElementById('erpPOItemResults').classList.remove('open');

  var bigCost = Number(cost) || 0;
  var cv = Number(convRate) || 1;
  var smallCost = cv > 1 ? bigCost / cv : bigCost;

  // Save selected item info for unit switching
  _erpPOSelectedItem = { bigCost: bigCost, smallCost: smallCost, unit: unit||'', bigUnit: bigUnit||'', convRate: cv };

  // Fill unit dropdown with both units
  var unitSel = document.getElementById('erpPOItemUnit');
  unitSel.innerHTML = '';
  if (unit) unitSel.innerHTML += '<option value="small" selected>' + unit + ' (صغرى)</option>';
  if (bigUnit && bigUnit !== unit) unitSel.innerHTML += '<option value="big">' + bigUnit + ' (كبرى)</option>';
  if (!unit && !bigUnit) unitSel.innerHTML = '<option value="">—</option>';

  // Default: small unit price
  document.getElementById('erpPOItemPrice').value = smallCost > 0 ? smallCost.toFixed(2) : '';

  if (smallCost <= 0 && id) {
    var found = _erpPOItemsList.find(function(x){ return String(x.id) === String(id); });
    if (found && Number(found.cost) > 0) {
      var fc = Number(found.cost), fcv = Number(found.convRate) || 1;
      _erpPOSelectedItem.bigCost = fc;
      _erpPOSelectedItem.smallCost = fcv > 1 ? fc / fcv : fc;
      document.getElementById('erpPOItemPrice').value = _erpPOSelectedItem.smallCost.toFixed(2);
    }
  }

  // Show stock info
  var hint = document.getElementById('erpPOStockHint');
  if (hint) {
    var stk = Number(stock)||0;
    hint.innerHTML = '<i class="fas fa-info-circle"></i> المخزون: <b>' + stk + '</b> ' + (unit||'وحدة') +
      (bigUnit && cv > 1 ? ' (= ' + (stk/cv).toFixed(1) + ' ' + bigUnit + ')' : '') +
      ' | صغرى: <b>' + smallCost.toFixed(2) + '</b> | كبرى: <b>' + bigCost.toFixed(2) + '</b>';
    hint.style.display = 'block';
  }
}

// ─── تبديل الوحدة → تحديث السعر ───
function erpPOUnitChanged() {
  if (!_erpPOSelectedItem) return;
  var sel = document.getElementById('erpPOItemUnit');
  var priceEl = document.getElementById('erpPOItemPrice');
  if (sel.value === 'big') {
    priceEl.value = _erpPOSelectedItem.bigCost > 0 ? _erpPOSelectedItem.bigCost.toFixed(2) : '';
  } else {
    priceEl.value = _erpPOSelectedItem.smallCost > 0 ? _erpPOSelectedItem.smallCost.toFixed(2) : '';
  }
}

// ─── إضافة صنف للسلة ───
function erpAddPOItem() {
  var name = (document.getElementById('erpPOItemNameH')?.value||document.getElementById('erpPOItemSearch')?.value||'').trim();
  var id = document.getElementById('erpPOItemId')?.value||'';
  var unit = document.getElementById('erpPOItemUnit')?.value||'';
  var qty = Number(document.getElementById('erpPOItemQty')?.value)||0;
  var price = Number(document.getElementById('erpPOItemPrice')?.value)||0;
  if (!name) return showToast('اختر المادة من القائمة أولاً','error');
  if (qty<=0) return showToast('أدخل الكمية','error');
  // Auto-fill price from item definition if not entered
  if (price<=0 && id) {
    var found = _erpPOItemsList.find(function(x){return String(x.id)===String(id);});
    if (found && Number(found.cost)>0) {
      var fcv = Number(found.convRate)||1;
      price = (unit==='big' && fcv>1) ? Number(found.cost) : (fcv>1 ? Number(found.cost)/fcv : Number(found.cost));
    }
  }
  if (price<=0) return showToast('أدخل سعر الوحدة','error');
  // Get actual unit name from select
  var unitSel = document.getElementById('erpPOItemUnit');
  var unitName = unitSel ? unitSel.options[unitSel.selectedIndex].text.replace(/ \(.*\)$/,'') : unit;
  var itemStock = 0;
  var foundItem = id ? _erpPOItemsList.find(function(x){return String(x.id)===String(id);}) : null;
  if (foundItem) itemStock = Number(foundItem.stock)||0;
  // Capture conv_rate + unit_type so the receive endpoint knows how to convert
  var convRate = _erpPOSelectedItem ? (_erpPOSelectedItem.convRate || 1) : 1;
  var unitType = unit; // 'big' or 'small' from the dropdown <select> value
  _erpPOCart.push({ itemId:id, itemName:name, unit:unitName, unitType:unitType, convRate:convRate, qty:qty, unitPrice:price, total:qty*price, stock:itemStock });
  document.getElementById('erpPOItemSearch').value='';
  document.getElementById('erpPOItemId').value='';
  document.getElementById('erpPOItemNameH').value='';
  document.getElementById('erpPOItemUnit').value='';
  document.getElementById('erpPOItemQty').value='1';
  document.getElementById('erpPOItemPrice').value='';
  var hint = document.getElementById('erpPOStockHint'); if(hint) hint.style.display='none';
  erpRenderPOCart();
}

function erpRenderPOCart() {
  const tb = document.getElementById('erpPOItemsBody');
  if (!_erpPOCart.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px;font-style:italic;">لم تتم إضافة أصناف بعد</td></tr>';
    ['erpPOSubtotal','erpPOVATTotal','erpPOGrandTotal'].forEach(id=>{ const e=document.getElementById(id); if(e) e.textContent='0.00 ر.س'; });
    return;
  }
  let sub = 0;
  tb.innerHTML = _erpPOCart.map((it,i)=>{
    sub += it.total;
    var stockColor = (it.stock!==undefined && it.stock <= it.qty) ? '#ef4444' : '#16a34a';
    return `<tr>
      <td><code style="font-size:11px;color:#64748b;">${it.itemId||'—'}</code></td>
      <td><div style="font-weight:600;">${it.itemName}</div><div style="font-size:11px;color:${stockColor};">مخزون: ${it.stock!==undefined?it.stock:'—'}</div></td>
      <td style="text-align:center;">${it.qty}</td>
      <td style="text-align:center;color:#64748b;">${it.unit||'—'}</td>
      <td style="text-align:center;">${it.unitPrice.toFixed(2)}</td>
      <td style="text-align:center;font-weight:700;color:var(--secondary);">${it.total.toFixed(2)}</td>
      <td style="text-align:center;"><button class="btn-icon text-red" onclick="_erpPOCart.splice(${i},1);erpRenderPOCart()"><i class="fas fa-trash"></i></button></td>
    </tr>`;
  }).join('');
  const vat=sub*0.15;
  document.getElementById('erpPOSubtotal').textContent = sub.toFixed(2)+' ر.س';
  document.getElementById('erpPOVATTotal').textContent = vat.toFixed(2)+' ر.س';
  document.getElementById('erpPOGrandTotal').textContent = (sub+vat).toFixed(2)+' ر.س';
}

// ─── حفظ أمر الشراء (جديد أو تعديل) ───
function erpSavePO() {
  var supplierId = document.getElementById('erpPOSupplierId')?.value||'';
  var supplierName = document.getElementById('erpPOSupplierInput')?.value||'';
  if (!supplierName) return showToast('يجب اختيار المورد','error');
  if (!_erpPOCart.length) return showToast('يجب إضافة صنف واحد على الأقل','error');
  // Hard requirement: every cart item must have an itemId (i.e. the user
  // picked it from the inventory autocomplete, not just typed the name).
  // Otherwise the receive flow can't find the inv_items row to update
  // stock on, and silently skips every line.
  var missing = _erpPOCart.filter(function(i){ return !i.itemId; });
  if (missing.length) {
    return showToast('بعض الأصناف غير مرتبطة بمادة من المخزون — استخدم البحث لاختيار المادة من القائمة: ' + missing.map(function(m){return m.itemName;}).join('، '), 'error');
  }
  var poData = {
    supplierId:supplierId, supplierName:supplierName,
    date: document.getElementById('erpPODate')?.value||'',
    expectedDate: document.getElementById('erpPOExpDate')?.value||'',
    notes: document.getElementById('erpPONotes')?.value||'',
    // Include unit + unitType + convRate so the receive endpoint knows
    // whether to multiply qty × convRate when adding to stock.
    items: _erpPOCart.map(function(i){ return { itemId:i.itemId, itemName:i.itemName, unit:i.unit||'', unitType:i.unitType||'small', convRate:i.convRate||1, qty:i.qty, unitPrice:i.unitPrice }; })
  };
  loader(true);
  if (_erpEditingPOId) {
    // Update existing PO
    window._apiBridge
      .withSuccessHandler(function(r){
        loader(false);
        if (r.success) { showToast('تم تحديث أمر الشراء'); _erpEditingPOId=null; erpBackToPOList(); erpLoadPOs(); }
        else showToast(r.error||'خطأ','error');
      })
      .withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
      .updatePurchaseOrder(_erpEditingPOId, poData, currentUser);
  } else {
    // Create new PO
    window._apiBridge
      .withSuccessHandler(function(r){
        loader(false);
        if (r.success) { showToast('تم إنشاء أمر الشراء: '+r.poNumber); erpBackToPOList(); erpLoadPOs(); }
        else showToast(r.error||'خطأ','error');
      })
      .withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
      .createPurchaseOrder(poData, currentUser);
  }
}

function erpApprovePO(poId) {
  if (!confirm('هل تريد اعتماد أمر الشراء؟\nسيتم تحويله لفاتورة شراء تلقائياً.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r){
    loader(false);
    if (r.success) { showToast('تم الاعتماد وتحويله لفاتورة شراء'); erpLoadPOs(); } else showToast(r.error||'خطأ','error');
  }).approvePurchaseOrder(poId, currentUser);
}

function erpDeletePO(poId, poNumber) {
  if (!confirm('هل تريد حذف أمر الشراء "' + (poNumber||poId) + '" نهائياً؟')) return;
  loader(true);
  window._apiBridge
    .withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم الحذف');erpLoadPOs();}else showToast(r.error||'خطأ','error'); })
    .withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
    .deletePurchaseOrder(poId, currentUser);
}

// ─── تصدير نموذج Excel لأصناف أمر الشراء ───
function erpExportPOTemplate() {
  var wsData = [['الكود','اسم المادة','الكمية','الوحدة','سعر الوحدة']];
  if (_erpPOCart && _erpPOCart.length) {
    _erpPOCart.forEach(function(i){ wsData.push([i.itemId||'', i.itemName, i.qty, i.unit||'', i.unitPrice]); });
  } else {
    wsData.push(['RAW-001', 'مثال: سكر أبيض', 10, 'كجم', 5.50]);
  }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:20},{wch:30},{wch:10},{wch:12},{wch:15}];
  XLSX.utils.book_append_sheet(wb, ws, 'أصناف أمر الشراء');
  XLSX.writeFile(wb, 'نموذج_أمر_شراء_' + new Date().toISOString().split('T')[0] + '.xlsx');
  showToast('تم تصدير النموذج');
}

// ─── استيراد أصناف من Excel ───
function erpImportPOItems(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, {type:'array'});
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, {defval:''});
      if (!rows.length) return showToast('الملف فارغ','error');
      var count = 0, notFound = [];
      rows.forEach(function(r) {
        var code = r['الكود'] || r['Code'] || r['ID'] || r['id'] || '';
        var name = r['اسم المادة'] || r['ItemName'] || r['Name'] || r['name'] || '';
        var qty = Number(r['الكمية'] || r['Qty'] || r['qty']) || 0;
        var unit = r['الوحدة'] || r['Unit'] || r['unit'] || '';
        var price = Number(r['سعر الوحدة'] || r['UnitPrice'] || r['Price'] || r['price']) || 0;
        if ((!name && !code) || qty <= 0) return;
        // Find item in system by code or name
        var found = null;
        if (code) found = _erpPOItemsList.find(function(x){ return String(x.id)===String(code); });
        if (!found && name) found = _erpPOItemsList.find(function(x){ return (x.name||'').toLowerCase()===name.trim().toLowerCase(); });
        if (found) {
          // Calculate small unit price from big unit cost
          var cv = Number(found.convRate)||1;
          var smallPrice = cv > 1 ? Number(found.cost)/cv : Number(found.cost);
          if (!price && smallPrice > 0) price = smallPrice;
          if (!unit) unit = found.unit || found.bigUnit || '';
          _erpPOCart.push({ itemId:found.id, itemName:found.name, unit:unit, qty:qty, unitPrice:price, total:qty*price, stock:Number(found.stock)||0 });
          count++;
        } else {
          notFound.push(name || code);
          _erpPOCart.push({ itemId:code, itemName:name.trim(), unit:unit, qty:qty, unitPrice:price, total:qty*price, stock:0 });
          count++;
        }
      });
      erpRenderPOCart();
      if (notFound.length > 0) {
        var msg = 'تم استيراد ' + count + ' صنف.\n\nالمواد التالية غير موجودة في النظام:\n• ' + notFound.join('\n• ') + '\n\nهل تريد إضافتها للمستودع؟';
        if (confirm(msg)) {
          notFound.forEach(function(n) {
            openRawModal();
            var nameField = document.getElementById('mrName');
            if (nameField) nameField.value = n;
          });
        }
      } else if (count > 0) {
        showToast('تم استيراد ' + count + ' صنف بنجاح');
      } else {
        showToast('لم يتم العثور على أصناف صالحة','error');
      }
    } catch(ex) { showToast('خطأ في قراءة الملف: '+ex.message,'error'); }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

function erpPrintPO(poId) {
  // Backend already returns lines inside each PO object — no separate fetch needed.
  var po = (_erpPOAllData || []).find(function(p) { return String(p.id) === String(poId); });
  if (!po) return showToast('لم يتم العثور على الأمر', 'error');

  var lines = po.lines || [];
  var itemsH = '', totalBefore = 0, totalVat = 0;
  lines.forEach(function(l, i) {
    var lineTotalBefore = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    var lineVat = Number(l.vatAmount) || (lineTotalBefore * 0.15);
    var lineTotal = Number(l.total) || (lineTotalBefore + lineVat);
    totalBefore += lineTotalBefore;
    totalVat += lineVat;
    itemsH += '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + (l.itemName || '') + '</td>' +
      '<td>' + (l.qty || 0) + '</td>' +
      '<td>' + (l.unit || '—') + '</td>' +
      '<td>' + (Number(l.unitPrice) || 0).toFixed(2) + '</td>' +
      '<td>' + lineTotal.toFixed(2) + '</td>' +
    '</tr>';
  });

  var grandTotal = totalBefore + totalVat;
  var dateStr = po.poDate ? new Date(po.poDate).toLocaleDateString('en-GB') : '—';

  var w = window.open('', '_blank', 'width=800,height=700');
  if (!w) return showToast('السماح بالنوافذ المنبثقة مطلوب للطباعة', 'error');
  w.document.write(
    '<html dir="rtl"><head><meta charset="UTF-8"><title>أمر شراء ' + (po.poNumber || '') + '</title>' +
    '<style>body{font-family:Arial,sans-serif;direction:rtl;padding:30px;color:#1e293b;}h2{text-align:center;margin-bottom:6px;}' +
    '.meta{display:flex;justify-content:space-between;margin:14px 0;font-size:13px;}' +
    'table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;}' +
    'th,td{border:1px solid #ddd;padding:8px 10px;text-align:right;}th{background:#f1f5f9;font-weight:700;}' +
    '.ts{margin-top:10px;}.ts table{width:280px;margin-right:auto;border:none;}.ts td{border:none;padding:4px 8px;}' +
    '.g{font-weight:800;font-size:15px;background:#eff6ff;}' +
    '.sig{display:flex;justify-content:space-between;margin-top:50px;font-size:13px;}.sig div{text-align:center;min-width:150px;}</style></head><body>' +
    '<h2>أمر شراء</h2>' +
    '<div class="meta"><div><strong>رقم:</strong> ' + (po.poNumber || '') + '</div><div><strong>التاريخ:</strong> ' + dateStr + '</div></div>' +
    '<p><strong>المورد:</strong> ' + (po.supplierName || '—') + '</p>' +
    (po.notes ? '<p><strong>ملاحظات:</strong> ' + po.notes + '</p>' : '') +
    '<table><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>' +
    '<tbody>' + (itemsH || '<tr><td colspan="6" style="text-align:center;color:#999;">لا توجد أصناف</td></tr>') + '</tbody></table>' +
    '<div class="ts"><table>' +
      '<tr><td>قبل الضريبة</td><td>' + totalBefore.toFixed(2) + '</td></tr>' +
      '<tr><td>ضريبة 15%</td><td>' + totalVat.toFixed(2) + '</td></tr>' +
      '<tr class="g"><td>الإجمالي</td><td>' + grandTotal.toFixed(2) + '</td></tr>' +
    '</table></div>' +
    '<div class="sig"><div><p>_________________</p><p>توقيع المشتري</p></div><div><p>_________________</p><p>توقيع المورد</p></div></div>' +
    '</body></html>'
  );
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
}

// ─── عرض/تعديل أمر شراء ───
var _erpEditingPOId = null;
function erpViewPO(poId) {
  var po = (_erpPOAllData || []).find(function(p) { return String(p.id) === String(poId); });
  if (!po) return showToast('لم يتم العثور على الأمر', 'error');
  _erpEditingPOId = poId;
  var isDraft = po.status === 'draft';

  // Show form view
  document.getElementById('erpPOListView').classList.add('hidden');
  document.getElementById('erpPOFormView').classList.remove('hidden');

  // Fill fields (camelCase from backend)
  document.getElementById('erpPOSupplierInput').value = po.supplierName || '';
  document.getElementById('erpPOSupplierId').value = po.supplierId || '';
  document.getElementById('erpPODate').value = po.poDate ? String(po.poDate).substring(0, 10) : '';
  document.getElementById('erpPOExpDate').value = po.expectedDate ? String(po.expectedDate).substring(0, 10) : '';
  document.getElementById('erpPONotes').value = po.notes || '';

  // Disable fields if not draft
  ['erpPOSupplierInput', 'erpPODate', 'erpPOExpDate', 'erpPONotes'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.readOnly = !isDraft;
  });

  // Lines are already embedded in the PO object — no extra fetch
  _erpPOCart = (po.lines || []).map(function(l) {
    var qty = Number(l.qty) || 0;
    var unitPrice = Number(l.unitPrice) || 0;
    return {
      itemId: l.itemId || '',
      itemName: l.itemName || '',
      unit: l.unit || '',
      unitType: l.unitType || 'small',
      convRate: Number(l.convRate) || 1,
      qty: qty,
      unitPrice: unitPrice,
      total: qty * unitPrice
    };
  });
  erpRenderPOCart();

  // Hide/show add-item row and save button based on status
  var addRow = document.querySelector('#erpPOFormView .po-add-row');
  if (addRow) addRow.style.display = isDraft ? 'flex' : 'none';
  var saveBtn = document.querySelector('#erpPOFormView .btn-primary');
  if (saveBtn) {
    saveBtn.textContent = isDraft ? ' حفظ التعديلات' : ' عرض فقط (معتمد)';
    saveBtn.disabled = !isDraft;
  }

  // Load suppliers + items for dropdowns (used when editing)
  window._apiBridge.withSuccessHandler(function(s) { _erpPOSuppliersList = s || []; }).getSuppliers();
  window._apiBridge.withSuccessHandler(function(i) { _erpPOItemsList = i || []; }).getInvItems();
}

// ═══════════════════════════════════════
// VAT REPORTS
// ═══════════════════════════════════════
var _erpVATQuarter = 0;
function erpLoadVATReports() {
  // Populate year selector
  var ySel = document.getElementById('erpVATYear');
  if (ySel && !ySel.options.length) {
    var cy = new Date().getFullYear();
    for (var y=cy;y>=cy-3;y--) ySel.innerHTML += '<option value="'+y+'">'+y+'</option>';
  }

  // Auto-populate the current quarter date range so KPI cards aren't empty on first visit
  var startInput = document.getElementById('erpVATStart');
  var endInput   = document.getElementById('erpVATEnd');
  if (startInput && !startInput.value) {
    var now = new Date();
    var qIdx = Math.floor(now.getMonth() / 3); // 0..3
    var qStart = new Date(now.getFullYear(), qIdx * 3, 1);
    var qEnd   = new Date(now.getFullYear(), qIdx * 3 + 3, 0);
    var fmt = function(d){ return d.toISOString().split('T')[0]; };
    startInput.value = fmt(qStart);
    if (endInput) endInput.value = fmt(qEnd);
    // Auto-fetch the current quarter data
    if (typeof erpLoadVATDetail === 'function') erpLoadVATDetail();
  }

  // Load reports list (endpoint may be missing → catch-all returns [])
  window._apiBridge.withSuccessHandler(function(list) {
    var tbody = document.getElementById('erpVATReportsBody');
    if (!tbody) return;
    if (!list || !list.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد تقارير محفوظة</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function(r) {
      // Tolerate either camelCase or PascalCase keys
      var id     = r.id || r.ID || '';
      var pStart = r.periodStart || r.PeriodStart || '';
      var pEnd   = r.periodEnd   || r.PeriodEnd   || '';
      var outVat = Number(r.totalOutputVat || r.TotalOutputVAT || 0);
      var inVat  = Number(r.totalInputVat  || r.TotalInputVAT  || 0);
      var netVat = Number(r.netVat || r.NetVAT || (outVat - inVat));
      var status = r.status || r.Status || 'draft';
      var stColor = status === 'submitted' ? 'green' : (status === 'closed' ? 'blue' : 'orange');
      return '<tr>' +
        '<td><code>' + id + '</code></td>' +
        '<td>' + pStart + '</td>' +
        '<td>' + pEnd + '</td>' +
        '<td style="color:#ef4444;">' + outVat.toFixed(2) + '</td>' +
        '<td style="color:#16a34a;">' + inVat.toFixed(2) + '</td>' +
        '<td><strong>' + netVat.toFixed(2) + '</strong></td>' +
        '<td><span class="badge badge-' + stColor + '">' + status + '</span></td>' +
      '</tr>';
    }).join('');
  }).getVATReports();
}

function erpLoadVATQuarter(q) {
  _erpVATQuarter = q;
  var year = document.getElementById('erpVATYear')?.value || new Date().getFullYear();
  var qDates = {1:['01-01','03-31'],2:['04-01','06-30'],3:['07-01','09-30'],4:['10-01','12-31']};
  document.getElementById('erpVATStart').value = year+'-'+qDates[q][0];
  document.getElementById('erpVATEnd').value = year+'-'+qDates[q][1];
  erpLoadVATDetail();
}

function erpLoadVATDetail() {
  var sd = document.getElementById('erpVATStart').value;
  var ed = document.getElementById('erpVATEnd').value;
  if (!sd||!ed) return showToast('حدد الفترة','error');
  loader(true);
  window._apiBridge
    .withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
    .withSuccessHandler(function(res) {
      loader(false);
      if (!res || res.error) return showToast((res && res.error) || 'فشل تحميل البيانات','error');

      // Backend returns: { vatRate, outputVat, inputVat, netVat, transactions: [{id, date, type, total, vatAmount, source}] }
      var output = Number(res.outputVat) || 0;
      var input  = Number(res.inputVat)  || 0;
      var net    = (res.netVat !== undefined) ? Number(res.netVat) : (output - input);

      document.getElementById('erpVATOutDetail').textContent = output.toFixed(2);
      document.getElementById('erpVATInDetail').textContent = input.toFixed(2);
      var netEl = document.getElementById('erpVATNetDetail');
      netEl.textContent = net.toFixed(2);
      netEl.style.color = net > 0 ? '#ef4444' : (net < 0 ? '#16a34a' : '#64748b');
      var stEl = document.getElementById('erpVATStatus');
      stEl.textContent = net > 0 ? 'مستحق للهيئة' : (net < 0 ? 'مستحق للمنشأة' : 'متوازن');
      stEl.style.color = net > 0 ? '#ef4444' : (net < 0 ? '#16a34a' : '#64748b');

      var tbody = document.getElementById('erpVATTransBody');
      var txns = Array.isArray(res.transactions) ? res.transactions : [];
      if (!txns.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد عمليات في هذه الفترة</td></tr>';
        return;
      }

      tbody.innerHTML = txns.map(function(t) {
        var isOutput = String(t.type).toLowerCase() === 'output' || String(t.source).toLowerCase() === 'sale';
        var typeColor = isOutput ? 'red' : 'green';
        var typeLabel = isOutput ? 'بيع' : 'شراء';
        var total = Number(t.total) || 0;
        var vatAmount = Number(t.vatAmount) || 0;
        var netAmount = total - vatAmount;
        var dateStr = '';
        try {
          var dt = new Date(t.date);
          dateStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        } catch (e) { dateStr = String(t.date || ''); }

        return '<tr>' +
          '<td>' + dateStr + '</td>' +
          '<td><span class="badge badge-' + typeColor + '">' + typeLabel + '</span></td>' +
          '<td><code style="font-size:11px;">' + (t.id || '') + '</code></td>' +
          '<td>' + total.toFixed(2) + '</td>' +
          '<td>' + netAmount.toFixed(2) + '</td>' +
          '<td style="color:#ef4444;font-weight:700;">' + (isOutput ? vatAmount.toFixed(2) : '—') + '</td>' +
          '<td style="color:#16a34a;font-weight:700;">' + (isOutput ? '—' : vatAmount.toFixed(2)) + '</td>' +
        '</tr>';
      }).join('');
    }).getVATTransactions(sd, ed);
}

function erpPostVAT() {
  var sd = document.getElementById('erpVATStart').value;
  var ed = document.getElementById('erpVATEnd').value;
  if (!sd||!ed) return showToast('حدد الفترة أولاً','error');
  if (!confirm('ترحيل العمليات الضريبية من '+sd+' إلى '+ed+'؟\nسيتم إنشاء قيود محاسبية.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r){
    loader(false);
    if (r.success) { showToast('تم ترحيل العمليات: '+r.journalNumber); erpLoadVATDetail(); }
    else showToast(r.error,'error');
  }).withFailureHandler(function(e){loader(false);showToast(e.message,'error');}).postVATJournals(sd, ed, currentUser);
}

function erpCreateVATReport() {
  var sd = document.getElementById('erpVATStart').value;
  var ed = document.getElementById('erpVATEnd').value;
  if (!sd||!ed) return showToast('حدد فترة التقرير','error');
  loader(true);
  window._apiBridge.withSuccessHandler(function(res){
    loader(false);
    if (res.success) { showToast('تم إنشاء التقرير الضريبي'); erpLoadVATReports(); }
    else showToast(res.error,'error');
  }).createVATReport(sd, ed, currentUser);
}

function erpCloseQuarter() {
  var year = document.getElementById('erpVATYear')?.value || new Date().getFullYear();
  var q = _erpVATQuarter || (Math.ceil((new Date().getMonth()+1)/3));
  if (!confirm('إقفال الربع Q'+q+' لسنة '+year+'؟\nسيتم:\n- إنشاء تقرير ضريبي\n- ترحيل القيود\n- تسوية الضريبة')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r){
    loader(false);
    if (r.success) { showToast('تم إقفال Q'+q+' — صافي الضريبة: '+r.net.toFixed(2)); erpLoadVATDetail(); }
    else showToast(r.error,'error');
  }).withFailureHandler(function(e){loader(false);showToast(e.message,'error');}).closeVATQuarter(String(year), q, currentUser);
}

function erpCloseYear() {
  var year = document.getElementById('erpVATYear')?.value || new Date().getFullYear();
  if (!confirm('⚠️ إقفال السنة المالية '+year+'؟\n\nسيتم:\n- التحقق من توازن ميزان المراجعة\n- تصفير حسابات الإيرادات والمصروفات\n- ترحيل الأرباح/الخسائر للأرباح المبقاة\n- إغلاق الفترة المحاسبية\n\nهذا الإجراء لا يمكن التراجع عنه!')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r){
    loader(false);
    if (r.success) { showToast('تم إقفال السنة '+year+' — صافي الدخل: '+r.netIncome+' | قيد: '+r.journalNumber); erpLoadVATReports(); }
    else showToast(r.error,'error');
  }).withFailureHandler(function(e){loader(false);showToast(e.message,'error');}).closeFinancialYear(String(year), currentUser);
}

// ═══════════════════════════════════════
// ZATCA
// ═══════════════════════════════════════
function erpLoadZATCA() {
  window._apiBridge.withSuccessHandler(function(list) {
    const arr = list || [];
    document.getElementById('erpZATCASent').textContent = arr.filter(z => z.Status==='reported'||z.Status==='cleared').length;
    document.getElementById('erpZATCAPending').textContent = arr.filter(z => z.Status==='pending_clearance').length;
    document.getElementById('erpZATCARejected').textContent = arr.filter(z => z.Status==='rejected').length;
    const tbody = document.getElementById('erpZATCABody');
    if (arr.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد فواتير</td></tr>'; return; }
    tbody.innerHTML = arr.slice(0,100).map(z => {
      const statusColors = {reported:'green',cleared:'green',pending_clearance:'orange',rejected:'red'};
      return `<tr>
        <td>${z.InvoiceID||''}</td><td>${z.InvoiceType||''}</td>
        <td><code title="${z.UUID||''}">${(z.UUID||'').substring(0,8)}...</code></td>
        <td><code title="${z.Hash||''}">${(z.Hash||'').substring(0,12)}...</code></td>
        <td><span class="badge badge-${statusColors[z.Status]||'blue'}">${z.Status}</span></td>
        <td>${z.CreatedAt ? new Date(z.CreatedAt).toLocaleDateString('ar-SA') : ''}</td>
      </tr>`;
    }).join('');
  }).getZATCAInvoices({});
}

// ═══════════════════════════════════════
// FINANCIAL REPORTS
// ═══════════════════════════════════════
function erpShowFinReport(type) {
  document.querySelectorAll('.erp-tab').forEach(t => t.classList.remove('active'));
  event && event.target && event.target.classList.add('active');
  const container = document.getElementById('erpFinReportContent');
  container.innerHTML = '<p style="text-align:center;padding:20px;">جاري التحميل...</p>';

  if (type === 'trial') {
    window._apiBridge.withSuccessHandler(function(data) {
      let html = `<div class="report-status ${data.isBalanced?'balanced':'unbalanced'}">${data.isBalanced?'الميزان متوازن':'الميزان غير متوازن!'}</div>
        <table class="erp-table"><thead><tr><th>الرمز</th><th>الحساب</th><th>النوع</th><th>مدين</th><th>دائن</th></tr></thead><tbody>`;
      (data.rows||[]).forEach(r => {
        html += `<tr><td><code>${r.code}</code></td><td>${r.nameAR}</td><td>${r.type}</td>
          <td class="text-green">${r.debit>0?r.debit.toFixed(2):''}</td>
          <td class="text-red">${r.credit>0?r.credit.toFixed(2):''}</td></tr>`;
      });
      html += `<tr class="total-row"><td colspan="3"><strong>الإجمالي</strong></td><td class="text-green"><strong>${(data.totalDebit||0).toFixed(2)}</strong></td><td class="text-red"><strong>${(data.totalCredit||0).toFixed(2)}</strong></td></tr></tbody></table>`;
      container.innerHTML = html;
    }).getTrialBalance();
  } else if (type === 'income') {
    window._apiBridge.withSuccessHandler(function(data) {
      let html = '<h3>الإيرادات</h3><table class="erp-table"><thead><tr><th>الرمز</th><th>الحساب</th><th>المبلغ</th></tr></thead><tbody>';
      (data.revenue||[]).forEach(r => { html += `<tr><td><code>${r.code}</code></td><td>${r.name}</td><td class="text-green">${(r.balance||0).toFixed(2)}</td></tr>`; });
      html += `<tr class="total-row"><td colspan="2"><strong>إجمالي الإيرادات</strong></td><td class="text-green"><strong>${(data.totalRevenue||0).toFixed(2)}</strong></td></tr></tbody></table>`;
      html += '<h3>المصروفات</h3><table class="erp-table"><thead><tr><th>الرمز</th><th>الحساب</th><th>المبلغ</th></tr></thead><tbody>';
      (data.expenses||[]).forEach(r => { html += `<tr><td><code>${r.code}</code></td><td>${r.name}</td><td class="text-red">${(r.balance||0).toFixed(2)}</td></tr>`; });
      html += `<tr class="total-row"><td colspan="2"><strong>إجمالي المصروفات</strong></td><td class="text-red"><strong>${(data.totalExpenses||0).toFixed(2)}</strong></td></tr></tbody></table>`;
      html += `<div class="net-income-banner ${data.netIncome>=0?'profit':'loss'}"><span>صافي الدخل</span><strong>${(data.netIncome||0).toFixed(2)} SAR</strong></div>`;
      container.innerHTML = html;
    }).getIncomeStatement({});
  } else if (type === 'balance') {
    window._apiBridge.withSuccessHandler(function(data) {
      let html = '<div class="balance-sheet-grid"><div><h3>الأصول</h3><table class="erp-table"><tbody>';
      (data.assets||[]).forEach(r => { html += `<tr><td>${r.name}</td><td>${(r.balance||0).toFixed(2)}</td></tr>`; });
      html += `<tr class="total-row"><td><strong>إجمالي الأصول</strong></td><td><strong>${(data.totalAssets||0).toFixed(2)}</strong></td></tr></tbody></table></div>`;
      html += '<div><h3>الالتزامات</h3><table class="erp-table"><tbody>';
      (data.liabilities||[]).forEach(r => { html += `<tr><td>${r.name}</td><td>${(r.balance||0).toFixed(2)}</td></tr>`; });
      html += `<tr class="total-row"><td><strong>إجمالي الالتزامات</strong></td><td><strong>${(data.totalLiabilities||0).toFixed(2)}</strong></td></tr></tbody></table>`;
      html += '<h3>حقوق الملكية</h3><table class="erp-table"><tbody>';
      (data.equity||[]).forEach(r => { html += `<tr><td>${r.name}</td><td>${(r.balance||0).toFixed(2)}</td></tr>`; });
      html += `<tr class="total-row"><td><strong>إجمالي حقوق الملكية</strong></td><td><strong>${(data.totalEquity||0).toFixed(2)}</strong></td></tr></tbody></table></div></div>`;
      html += `<div class="report-status ${data.isBalanced?'balanced':'unbalanced'}">${data.isBalanced?'الميزانية متوازنة':'الميزانية غير متوازنة!'}</div>`;
      container.innerHTML = html;
    }).getBalanceSheet();
  }
}

// ═══════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════
function erpLoadBranches() {
  window._apiBridge.withSuccessHandler(function(list) {
    const tbody = document.getElementById('erpBranchesBody');
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد فروع</td></tr>'; return; }
    tbody.innerHTML = list.map(b => `<tr>
      <td><code>${b.Code||''}</code></td><td>${b.Name||''}</td><td>${b.Location||''}</td>
      <td>${b.Type||''}</td>
      <td><span class="badge badge-${b.IsActive!==false?'green':'red'}">${b.IsActive!==false?'نشط':'معطل'}</span></td>
      <td><button class="btn-icon" onclick="erpEditBranch('${b.ID}')"><i class="fas fa-edit"></i></button></td>
    </tr>`).join('');
  }).getBranches();
}

function erpOpenBranchModal(data) {
  const d = data || {};
  document.getElementById('erpModalTitle').textContent = d.ID ? 'تعديل فرع' : 'إضافة فرع جديد';
  document.getElementById('erpModalBody').innerHTML = `
    <input type="hidden" id="erpBrID" value="${d.ID||''}">
    <div class="form-row"><label>الاسم *</label><input class="form-control" id="erpBrName" value="${d.Name||''}"></div>
    <div class="form-row"><label>الرمز *</label><input class="form-control" id="erpBrCode" value="${d.Code||''}"></div>
    <div class="form-row"><label>الموقع</label><input class="form-control" id="erpBrLoc" value="${d.Location||''}"></div>
    <div class="form-row"><label>النوع</label><select class="form-control" id="erpBrType"><option value="main" ${d.Type==='main'?'selected':''}>رئيسي</option><option value="sub" ${d.Type==='sub'?'selected':''}>فرعي</option><option value="virtual" ${d.Type==='virtual'?'selected':''}>افتراضي</option></select></div>`;
  document.getElementById('erpModalSaveBtn').onclick = function() {
    const bd = { ID: document.getElementById('erpBrID').value, Name: document.getElementById('erpBrName').value, Code: document.getElementById('erpBrCode').value, Location: document.getElementById('erpBrLoc').value, Type: document.getElementById('erpBrType').value };
    if (!bd.Name || !bd.Code) return showToast('الاسم والرمز مطلوبان', 'error');
    loader(true);
    window._apiBridge.withSuccessHandler(function(res) { loader(false); if (res.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadBranches(); } else showToast(res.error, 'error'); }).saveBranch(bd, currentUser);
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpEditBranch(id) {
  window._apiBridge.withSuccessHandler(function(list) {
    const b = (list||[]).find(x => String(x.ID) === String(id));
    if (b) erpOpenBranchModal(b);
  }).getBranches();
}

// ═══════════════════════════════════════
// ACCOUNTING PERIODS
// ═══════════════════════════════════════
function erpLoadPeriods() {
  window._apiBridge.withSuccessHandler(function(list) {
    const tbody = document.getElementById('erpPeriodsBody');
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">لا توجد فترات</td></tr>'; return; }
    tbody.innerHTML = list.map(p => `<tr>
      <td>${p.Name||''}</td><td>${p.StartDate||''}</td><td>${p.EndDate||''}</td>
      <td><span class="badge badge-${p.Status==='open'?'green':'red'}">${p.Status==='open'?'مفتوحة':'مغلقة'}</span></td>
      <td>${p.Status==='open'?`<button class="btn btn-sm btn-danger" onclick="erpClosePeriod('${p.ID}')"><i class="fas fa-lock"></i> إقفال</button>`:''}</td>
    </tr>`).join('');
  }).getAccountingPeriods();
}

function erpOpenPeriodModal() {
  document.getElementById('erpModalTitle').textContent = 'فترة محاسبية جديدة';
  document.getElementById('erpModalBody').innerHTML = `
    <div class="form-row"><label>الاسم *</label><input class="form-control" id="erpPerName" placeholder="مثال: يناير 2026"></div>
    <div class="form-row"><label>تاريخ البداية *</label><input type="date" class="form-control" id="erpPerStart"></div>
    <div class="form-row"><label>تاريخ النهاية *</label><input type="date" class="form-control" id="erpPerEnd"></div>`;
  document.getElementById('erpModalSaveBtn').onclick = function() {
    const d = { Name: document.getElementById('erpPerName').value, StartDate: document.getElementById('erpPerStart').value, EndDate: document.getElementById('erpPerEnd').value };
    if (!d.Name || !d.StartDate || !d.EndDate) return showToast('جميع الحقول مطلوبة', 'error');
    loader(true);
    window._apiBridge.withSuccessHandler(function(res) { loader(false); if (res.success) { showToast('تم الإنشاء'); erpCloseModal(); erpLoadPeriods(); } else showToast(res.error, 'error'); }).saveAccountingPeriod(d, currentUser);
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpClosePeriod(id) {
  if (!confirm('هل تريد إقفال هذه الفترة المحاسبية؟ لن تتمكن من تسجيل قيود فيها بعد الإقفال.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم الإقفال'); erpLoadPeriods(); }
    else showToast(res.error, 'error');
  }).closePeriod(id, currentUser);
}

// ═══════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════
function erpLoadAuditLog() {
  const filters = {};
  const u = document.getElementById('erpAuditUser');
  const a = document.getElementById('erpAuditAction');
  if (u && u.value) filters.username = u.value;
  if (a && a.value) filters.action = a.value;

  window._apiBridge.withSuccessHandler(function(list) {
    const tbody = document.getElementById('erpAuditBody');
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد سجلات</td></tr>'; return; }
    tbody.innerHTML = list.slice(0,200).map(l => `<tr>
      <td>${l.Timestamp ? new Date(l.Timestamp).toLocaleString('ar-SA') : ''}</td>
      <td>${l.Username||''}</td>
      <td><span class="badge badge-blue">${l.Action||''}</span></td>
      <td>${l.TableName||''}</td><td><code>${l.RecordID||''}</code></td>
      <td><small>${(l.NewValue||'').substring(0,50)}</small></td>
    </tr>`).join('');
  }).getAuditLogs(filters);
}

// ═══════════════════════════════════════
// CREDIT/DEBIT NOTES
// ═══════════════════════════════════════
function erpLoadNotes() {
  const tbody = document.getElementById('erpNotesBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">جاري التحميل...</td></tr>';

  window._apiBridge.withSuccessHandler(function(creditList) {
    window._apiBridge.withSuccessHandler(function(debitList) {
      let allNotes = [];
      (creditList || []).forEach(n => { n._type = 'credit'; allNotes.push(n); });
      (debitList || []).forEach(n => { n._type = 'debit'; allNotes.push(n); });

      if (allNotes.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد إشعارات</td></tr>'; return; }
      tbody.innerHTML = allNotes.map(n => `<tr>
        <td>${n.NoteNumber||n.ID||''}</td>
        <td><span class="badge badge-${n._type==='credit'?'green':'orange'}">${n._type==='credit'?'دائن':'مدين'}</span></td>
        <td>${n.OriginalInvoiceID||''}</td><td>${n.CustomerName||''}</td>
        <td>${n.Reason||''}</td><td>${(Number(n.TotalAfterVAT)||0).toFixed(2)}</td>
        <td><span class="badge badge-green">${n.Status||''}</span></td>
      </tr>`).join('');
    }).getDebitNotes();
  }).getCreditNotes();
}

function erpOpenCreditNoteModal() {
  document.getElementById('erpModalTitle').textContent = 'إشعار دائن جديد';
  document.getElementById('erpModalBody').innerHTML = `
    <div class="form-row"><label>رقم الفاتورة الأصلية *</label><input class="form-control" id="erpCNInvoice"></div>
    <div class="form-row"><label>العميل</label><input class="form-control" id="erpCNCustomer"></div>
    <div class="form-row"><label>السبب *</label><input class="form-control" id="erpCNReason" placeholder="سبب الإشعار"></div>
    <div class="form-row"><label>المبلغ قبل الضريبة *</label><input type="number" class="form-control" id="erpCNAmount" step="0.01"></div>`;
  document.getElementById('erpModalSaveBtn').onclick = function() {
    const d = { originalInvoiceId: document.getElementById('erpCNInvoice').value, customerName: document.getElementById('erpCNCustomer').value, reason: document.getElementById('erpCNReason').value, totalBeforeVAT: document.getElementById('erpCNAmount').value };
    if (!d.reason || !d.totalBeforeVAT) return showToast('السبب والمبلغ مطلوبان', 'error');
    loader(true);
    window._apiBridge.withSuccessHandler(function(res) { loader(false); if (res.success) { showToast('تم إنشاء الإشعار الدائن: '+res.noteNumber); erpCloseModal(); erpLoadNotes(); } else showToast(res.error, 'error'); }).createCreditNote(d, currentUser);
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function erpOpenDebitNoteModal() {
  document.getElementById('erpModalTitle').textContent = 'إشعار مدين جديد';
  document.getElementById('erpModalBody').innerHTML = `
    <div class="form-row"><label>رقم الفاتورة الأصلية *</label><input class="form-control" id="erpDNInvoice"></div>
    <div class="form-row"><label>العميل</label><input class="form-control" id="erpDNCustomer"></div>
    <div class="form-row"><label>السبب *</label><input class="form-control" id="erpDNReason" placeholder="سبب الإشعار"></div>
    <div class="form-row"><label>المبلغ قبل الضريبة *</label><input type="number" class="form-control" id="erpDNAmount" step="0.01"></div>`;
  document.getElementById('erpModalSaveBtn').onclick = function() {
    const d = { originalInvoiceId: document.getElementById('erpDNInvoice').value, customerName: document.getElementById('erpDNCustomer').value, reason: document.getElementById('erpDNReason').value, totalBeforeVAT: document.getElementById('erpDNAmount').value };
    if (!d.reason || !d.totalBeforeVAT) return showToast('السبب والمبلغ مطلوبان', 'error');
    loader(true);
    window._apiBridge.withSuccessHandler(function(res) { loader(false); if (res.success) { showToast('تم إنشاء الإشعار المدين: '+res.noteNumber); erpCloseModal(); erpLoadNotes(); } else showToast(res.error, 'error'); }).createDebitNote(d, currentUser);
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

// ═══════════════════════════════════════
// WAREHOUSES (المستودعات) §16
// ═══════════════════════════════════════

function erpLoadWarehouses() {
  const tbody = document.getElementById('erpWarehousesBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">جاري التحميل...</td></tr>';
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد مستودعات</td></tr>'; return; }
    const typeMap = { main: 'رئيسي', sub: 'فرعي', virtual: 'افتراضي', transit: 'عبور' };
    tbody.innerHTML = list.map(w => `<tr>
      <td><code>${w.Code||''}</code></td>
      <td>${w.NameAR||w.NameEN||''}</td>
      <td><span class="badge badge-blue">${typeMap[w.Type] || w.Type || ''}</span></td>
      <td>${w.BranchID||'—'}</td>
      <td>${w.Location||''}</td>
      <td><span class="badge badge-${w.IsActive!==false?'green':'red'}">${w.IsActive!==false?'فعال':'معطل'}</span></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="erpEditWarehouse('${w.ID}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm btn-danger" onclick="erpDeleteWarehouse('${w.ID}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
  }).getWarehouses();
}

function erpOpenWarehouseModal(data) {
  const isEdit = data && data.ID;
  document.getElementById('erpModalTitle').textContent = isEdit ? 'تعديل مستودع' : 'مستودع جديد';

  window._apiBridge.withSuccessHandler(function(branches) {
    const brOpts = (branches||[]).map(b => `<option value="${b.ID}" ${data&&data.BranchID===b.ID?'selected':''}>${b.Name||b.Code}</option>`).join('');
    document.getElementById('erpModalBody').innerHTML = `
      <div class="form-row"><label>الرمز *</label><input class="form-control" id="erpWhCode" value="${data?data.Code||'':''}" ${isEdit?'disabled':''}></div>
      <div class="form-row"><label>الاسم بالعربي *</label><input class="form-control" id="erpWhNameAR" value="${data?data.NameAR||'':''}"></div>
      <div class="form-row"><label>الاسم بالإنجليزي</label><input class="form-control" id="erpWhNameEN" value="${data?data.NameEN||'':''}"></div>
      <div class="form-row"><label>النوع *</label>
        <select class="form-control" id="erpWhType">
          <option value="main" ${data&&data.Type==='main'?'selected':''}>رئيسي</option>
          <option value="sub" ${data&&data.Type==='sub'?'selected':''}>فرعي</option>
          <option value="virtual" ${data&&data.Type==='virtual'?'selected':''}>افتراضي</option>
          <option value="transit" ${data&&data.Type==='transit'?'selected':''}>عبور</option>
        </select>
      </div>
      <div class="form-row"><label>الفرع</label><select class="form-control" id="erpWhBranch"><option value="">— بدون —</option>${brOpts}</select></div>
      <div class="form-row"><label>الموقع</label><input class="form-control" id="erpWhLocation" value="${data?data.Location||'':''}"></div>
      <div class="form-row"><label><input type="checkbox" id="erpWhNegStock" ${data&&data.AllowNegativeStock?'checked':''}> السماح بالمخزون السالب</label></div>
      <div class="form-row"><label><input type="checkbox" id="erpWhActive" ${!data||data.IsActive!==false?'checked':''}> فعال</label></div>
      <input type="hidden" id="erpWhID" value="${data?data.ID||'':''}">`;

    document.getElementById('erpModalSaveBtn').onclick = function() {
      const d = {
        ID: document.getElementById('erpWhID').value || undefined,
        Code: document.getElementById('erpWhCode').value,
        NameAR: document.getElementById('erpWhNameAR').value,
        NameEN: document.getElementById('erpWhNameEN').value,
        Type: document.getElementById('erpWhType').value,
        BranchID: document.getElementById('erpWhBranch').value,
        Location: document.getElementById('erpWhLocation').value,
        AllowNegativeStock: document.getElementById('erpWhNegStock').checked,
        IsActive: document.getElementById('erpWhActive').checked
      };
      if (!d.Code || !d.NameAR) return showToast('الرمز والاسم مطلوبان', 'error');
      loader(true);
      window._apiBridge.withSuccessHandler(function(res) {
        loader(false);
        if (res.success) { showToast('تم حفظ المستودع'); erpCloseModal(); erpLoadWarehouses(); }
        else showToast(res.error, 'error');
      }).saveWarehouse(d, currentUser);
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getBranches();
}

function erpEditWarehouse(id) {
  window._apiBridge.withSuccessHandler(function(list) {
    const wh = (list||[]).find(w => w.ID === id);
    if (wh) erpOpenWarehouseModal(wh);
  }).getWarehouses();
}

function erpDeleteWarehouse(id) {
  if (!confirm('هل أنت متأكد من حذف هذا المستودع؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم حذف المستودع'); erpLoadWarehouses(); }
    else showToast(res.error, 'error');
  }).deleteWarehouse(id, currentUser);
}

// ═══════════════════════════════════════
// WAREHOUSE STOCK (أرصدة المستودعات)
// ═══════════════════════════════════════

function erpLoadWarehouseStock() {
  const whFilter = document.getElementById('erpStockWhFilter').value;
  const tbody = document.getElementById('erpWarehouseStockBody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">جاري التحميل...</td></tr>';

  // تحميل قائمة المستودعات للفلتر
  window._apiBridge.withSuccessHandler(function(warehouses) {
    const sel = document.getElementById('erpStockWhFilter');
    if (sel.options.length <= 1) {
      (warehouses||[]).forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.ID; opt.textContent = w.NameAR || w.Code;
        sel.appendChild(opt);
      });
    }
  }).getWarehouses();

  window._apiBridge.withSuccessHandler(function(stock) {
    if (!stock || stock.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد أرصدة</td></tr>'; return; }
    tbody.innerHTML = stock.map(s => {
      const qty = Number(s.Qty)||0;
      const cost = Number(s.AvgCost)||0;
      return `<tr>
        <td>${s.WarehouseName||''}</td>
        <td>${s.ItemName||''}</td>
        <td>${qty}</td>
        <td>${cost.toFixed(2)}</td>
        <td>${(qty*cost).toFixed(2)}</td>
        <td>${s.LastUpdated ? new Date(s.LastUpdated).toLocaleDateString('ar-SA') : ''}</td>
      </tr>`;
    }).join('');
  }).getWarehouseStock(whFilter || null);
}

// ═══════════════════════════════════════
// STOCK TRANSFERS (التحويلات) §16.9
// ═══════════════════════════════════════

function erpLoadTransfers() {
  const tbody = document.getElementById('erpTransfersBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">جاري التحميل...</td></tr>';
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list || list.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد تحويلات</td></tr>'; return; }
    const statusMap = { draft: 'مسودة', completed: 'مكتمل', cancelled: 'ملغي' };
    const statusColor = { draft: 'orange', completed: 'green', cancelled: 'red' };
    tbody.innerHTML = list.map(t => `<tr>
      <td><code>${t.TransferNumber||''}</code></td>
      <td>${t.FromWarehouseName||''}</td>
      <td>${t.ToWarehouseName||''}</td>
      <td>${t.TransferDate ? new Date(t.TransferDate).toLocaleDateString('ar-SA') : ''}</td>
      <td><span class="badge badge-${statusColor[t.Status]||'blue'}">${statusMap[t.Status]||t.Status}</span></td>
      <td>${t.RequestedBy||''}</td>
      <td>
        ${t.Status==='draft'?`<button class="btn btn-sm btn-success" onclick="erpApproveTransfer('${t.ID}')"><i class="fas fa-check"></i> اعتماد</button>
        <button class="btn btn-sm btn-danger" onclick="erpCancelTransfer('${t.ID}')"><i class="fas fa-times"></i> إلغاء</button>`:''}
        <button class="btn btn-sm btn-secondary" onclick="erpViewTransferLines('${t.ID}')"><i class="fas fa-eye"></i></button>
      </td>
    </tr>`).join('');
  }).getStockTransfers({});
}

var erpTransferItems = [];

function erpOpenTransferModal() {
  erpTransferItems = [];
  document.getElementById('erpModalTitle').textContent = 'تحويل مخزون جديد';

  window._apiBridge.withSuccessHandler(function(warehouses) {
    const whOpts = (warehouses||[]).filter(w=>w.IsActive!==false).map(w => `<option value="${w.ID}">${w.NameAR||w.Code}</option>`).join('');

    window._apiBridge.withSuccessHandler(function(items) {
      const itemOpts = (items||[]).map(it => `<option value="${it.ID}">${it.Name}</option>`).join('');

      document.getElementById('erpModalBody').innerHTML = `
        <div class="form-row"><label>من مستودع *</label><select class="form-control" id="erpTrFrom"><option value="">اختر</option>${whOpts}</select></div>
        <div class="form-row"><label>إلى مستودع *</label><select class="form-control" id="erpTrTo"><option value="">اختر</option>${whOpts}</select></div>
        <div class="form-row"><label>ملاحظات</label><input class="form-control" id="erpTrNotes"></div>
        <hr>
        <h4 style="margin:8px 0">الأصناف</h4>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <select class="form-control" id="erpTrItemSel" style="flex:2"><option value="">اختر صنف</option>${itemOpts}</select>
          <input type="number" class="form-control" id="erpTrItemQty" placeholder="الكمية" min="1" style="flex:1">
          <button class="btn btn-success btn-sm" onclick="erpAddTransferItem()"><i class="fas fa-plus"></i></button>
        </div>
        <table class="erp-table" style="font-size:13px;"><thead><tr><th>الصنف</th><th>الكمية</th><th></th></tr></thead>
        <tbody id="erpTrItemsBody"><tr><td colspan="3" class="empty-msg">لم تُضف أصناف بعد</td></tr></tbody></table>`;

      document.getElementById('erpModalSaveBtn').onclick = function() {
        const fromId = document.getElementById('erpTrFrom').value;
        const toId = document.getElementById('erpTrTo').value;
        if (!fromId || !toId) return showToast('اختر المستودعات', 'error');
        if (fromId === toId) return showToast('لا يمكن التحويل لنفس المستودع', 'error');
        if (erpTransferItems.length === 0) return showToast('أضف أصناف', 'error');
        loader(true);
        window._apiBridge.withSuccessHandler(function(res) {
          loader(false);
          if (res.success) { showToast('تم إنشاء التحويل: ' + res.transferNumber); erpCloseModal(); erpLoadTransfers(); }
          else showToast(res.error, 'error');
        }).createStockTransfer({
          fromWarehouseId: fromId, toWarehouseId: toId,
          items: erpTransferItems, notes: document.getElementById('erpTrNotes').value
        }, currentUser);
      };
      document.getElementById('erpModal').classList.remove('hidden');
    }).getInvItems();
  }).getWarehouses();
}

function erpAddTransferItem() {
  const sel = document.getElementById('erpTrItemSel');
  const qty = Number(document.getElementById('erpTrItemQty').value);
  if (!sel.value || !qty || qty <= 0) return showToast('اختر صنف وأدخل كمية', 'error');
  erpTransferItems.push({ itemId: sel.value, itemName: sel.options[sel.selectedIndex].text, qty });
  sel.value = ''; document.getElementById('erpTrItemQty').value = '';
  erpRenderTransferItems();
}

function erpRemoveTransferItem(idx) {
  erpTransferItems.splice(idx, 1);
  erpRenderTransferItems();
}

function erpRenderTransferItems() {
  const tbody = document.getElementById('erpTrItemsBody');
  if (erpTransferItems.length === 0) { tbody.innerHTML = '<tr><td colspan="3" class="empty-msg">لم تُضف أصناف بعد</td></tr>'; return; }
  tbody.innerHTML = erpTransferItems.map((it,i) => `<tr>
    <td>${it.itemName}</td><td>${it.qty}</td>
    <td><button class="btn btn-sm btn-danger" onclick="erpRemoveTransferItem(${i})"><i class="fas fa-times"></i></button></td>
  </tr>`).join('');
}

function erpApproveTransfer(id) {
  if (!confirm('هل أنت متأكد من اعتماد هذا التحويل؟ سيتم خصم وإضافة الكميات فوراً.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم اعتماد التحويل'); erpLoadTransfers(); }
    else showToast(res.error, 'error');
  }).approveStockTransfer(id, currentUser);
}

function erpCancelTransfer(id) {
  if (!confirm('هل أنت متأكد من إلغاء هذا التحويل؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم إلغاء التحويل'); erpLoadTransfers(); }
    else showToast(res.error, 'error');
  }).cancelStockTransfer(id, currentUser);
}

function erpViewTransferLines(transferId) {
  window._apiBridge.withSuccessHandler(function(lines) {
    const body = document.getElementById('erpJournalDetailBody');
    if (!lines || lines.length === 0) {
      body.innerHTML = '<p>لا توجد بنود</p>';
    } else {
      body.innerHTML = '<table class="erp-table" style="font-size:13px;"><thead><tr><th>الصنف</th><th>المطلوب</th><th>المرسل</th><th>المستلم</th><th>التكلفة</th></tr></thead><tbody>' +
        lines.map(l => `<tr><td>${l.ItemName||''}</td><td>${l.RequestedQty||0}</td><td>${l.SentQty||0}</td><td>${l.ReceivedQty||0}</td><td>${(Number(l.UnitCost)||0).toFixed(2)}</td></tr>`).join('') +
        '</tbody></table>';
    }
    document.getElementById('erpJournalDetailModal').classList.remove('hidden');
  }).getStockTransferLines(transferId);
}

// ═══════════════════════════════════════
// AR/AP AGING (أعمار الذمم) §19.6.7/8
// ═══════════════════════════════════════

function erpLoadARAging() {
  const tbody = document.getElementById('erpARAgingBody');
  const tfoot = document.getElementById('erpARAgingFoot');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">جاري التحميل...</td></tr>';
  tfoot.innerHTML = '';
  window._apiBridge.withSuccessHandler(function(res) {
    if (!res.success || !res.rows || res.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد ذمم مستحقة</td></tr>'; return;
    }
    tbody.innerHTML = res.rows.map(r => `<tr>
      <td>${r.customerName}</td><td>${r.vatNumber||''}</td>
      <td>${r.current.toFixed(2)}</td><td>${r.days30.toFixed(2)}</td>
      <td>${r.days60.toFixed(2)}</td><td>${r.days90.toFixed(2)}</td>
      <td>${r.over90.toFixed(2)}</td><td><strong>${r.totalBalance.toFixed(2)}</strong></td>
    </tr>`).join('');
    const t = res.totals;
    tfoot.innerHTML = `<tr style="font-weight:bold;background:#f0f4f8;">
      <td>الإجمالي</td><td></td>
      <td>${t.current.toFixed(2)}</td><td>${t.days30.toFixed(2)}</td>
      <td>${t.days60.toFixed(2)}</td><td>${t.days90.toFixed(2)}</td>
      <td>${t.over90.toFixed(2)}</td><td>${t.totalBalance.toFixed(2)}</td>
    </tr>`;
  }).getARAging();
}

function erpLoadAPAging() {
  const tbody = document.getElementById('erpAPAgingBody');
  const tfoot = document.getElementById('erpAPAgingFoot');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">جاري التحميل...</td></tr>';
  tfoot.innerHTML = '';
  window._apiBridge.withSuccessHandler(function(res) {
    if (!res.success || !res.rows || res.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد ذمم مستحقة</td></tr>'; return;
    }
    tbody.innerHTML = res.rows.map(r => `<tr>
      <td>${r.supplierName}</td><td>${r.vatNumber||''}</td>
      <td>${r.current.toFixed(2)}</td><td>${r.days30.toFixed(2)}</td>
      <td>${r.days60.toFixed(2)}</td><td>${r.days90.toFixed(2)}</td>
      <td>${r.over90.toFixed(2)}</td><td><strong>${r.totalBalance.toFixed(2)}</strong></td>
    </tr>`).join('');
    const t = res.totals;
    tfoot.innerHTML = `<tr style="font-weight:bold;background:#f0f4f8;">
      <td>الإجمالي</td><td></td>
      <td>${t.current.toFixed(2)}</td><td>${t.days30.toFixed(2)}</td>
      <td>${t.days60.toFixed(2)}</td><td>${t.days90.toFixed(2)}</td>
      <td>${t.over90.toFixed(2)}</td><td>${t.totalBalance.toFixed(2)}</td>
    </tr>`;
  }).getAPAging();
}

// ═══════════════════════════════════════
// CUSTOMER/SUPPLIER STATEMENTS §19.6.5/6
// ═══════════════════════════════════════

function erpLoadCustomerStatementPage() {
  // تحميل قائمة العملاء للفلتر
  window._apiBridge.withSuccessHandler(function(list) {
    const sel = document.getElementById('erpStmtCustId');
    if (sel.options.length <= 1) {
      (list||[]).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.ID; opt.textContent = c.Name || c.NameEN;
        sel.appendChild(opt);
      });
    }
  }).getCustomers();
}

function erpLoadCustomerStatement() {
  const custId = document.getElementById('erpStmtCustId').value;
  if (!custId) return showToast('اختر العميل', 'error');
  const from = document.getElementById('erpStmtCustFrom').value;
  const to = document.getElementById('erpStmtCustTo').value;
  const tbody = document.getElementById('erpCustStmtBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">جاري التحميل...</td></tr>';

  window._apiBridge.withSuccessHandler(function(res) {
    if (!res.success) { showToast(res.error, 'error'); tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">خطأ في التحميل</td></tr>'; return; }

    // معلومات العميل
    document.getElementById('erpCustStmtInfo').innerHTML = `
      <div style="display:flex;gap:20px;padding:8px;background:#f8fafc;border-radius:6px;">
        <span><strong>العميل:</strong> ${res.customer.name}</span>
        <span><strong>الرقم الضريبي:</strong> ${res.customer.vatNumber||'—'}</span>
        <span><strong>الهاتف:</strong> ${res.customer.phone||'—'}</span>
      </div>`;

    if (!res.transactions || res.transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد حركات</td></tr>';
    } else {
      tbody.innerHTML = res.transactions.map(t => `<tr>
        <td>${t.date}</td><td><span class="badge badge-blue">${t.type}</span></td>
        <td><code>${t.reference}</code></td><td>${t.description}</td>
        <td>${t.debit ? t.debit.toFixed(2) : '—'}</td>
        <td>${t.credit ? t.credit.toFixed(2) : '—'}</td>
        <td><strong>${t.balance.toFixed(2)}</strong></td>
      </tr>`).join('');
    }

    document.getElementById('erpCustStmtSummary').innerHTML = `
      <div class="fin-card"><span class="fin-label">إجمالي المدين</span><span class="fin-val">${res.summary.totalDebit.toFixed(2)}</span></div>
      <div class="fin-card"><span class="fin-label">إجمالي الدائن</span><span class="fin-val">${res.summary.totalCredit.toFixed(2)}</span></div>
      <div class="fin-card highlight"><span class="fin-label">الرصيد الختامي</span><span class="fin-val">${res.summary.closingBalance.toFixed(2)}</span></div>`;
  }).getCustomerStatement(custId, from, to);
}

var _erpStmtSupList = [];
var _erpSupStmtData = null;

function erpLoadSupplierStatementPage() {
  window._apiBridge.withSuccessHandler(function(list) {
    _erpStmtSupList = list || [];
  }).getSuppliers();
}

function erpFilterStmtSuppliers() {
  var q = (document.getElementById('erpStmtSupSearch')?.value || '').toLowerCase();
  var res = document.getElementById('erpStmtSupResults');
  if (!res) return;
  // Backend returns camelCase fields
  var filtered = (_erpStmtSupList || []).filter(function(s) {
    return (s.name || '').toLowerCase().includes(q) || (s.phone || '').includes(q);
  });
  if (!filtered.length) {
    res.innerHTML = '<div class="sd-result-item" style="color:#94a3b8;">لا توجد نتائج</div>';
  } else {
    res.innerHTML = filtered.slice(0, 15).map(function(s) {
      var safe = String(s.name || '').replace(/'/g, "\\'");
      return '<div class="sd-result-item" onclick="erpSelectStmtSup(\'' + s.id + '\',\'' + safe + '\')">' +
        '<i class="fas fa-truck" style="margin-left:8px;color:var(--accent);font-size:12px;"></i>' + (s.name || '') +
        '<span class="sd-item-meta">' + (s.phone || '') + '</span></div>';
    }).join('');
  }
  res.classList.add('open');
}
function erpSelectStmtSup(id, name) {
  document.getElementById('erpStmtSupSearch').value = name;
  document.getElementById('erpStmtSupId').value = id;
  document.getElementById('erpStmtSupResults').classList.remove('open');
}

function erpLoadSupplierStatement() {
  var supId = document.getElementById('erpStmtSupId').value;
  if (!supId) return showToast('اختر المورد', 'error');
  var from = document.getElementById('erpStmtSupFrom').value;
  var to = document.getElementById('erpStmtSupTo').value;
  var tbody = document.getElementById('erpSupStmtBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</td></tr>';

  window._apiBridge
    .withSuccessHandler(function(res) {
      _erpSupStmtData = res;
      if (!res.success) { showToast(res.error, 'error'); tbody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="color:red;">'+res.error+'</td></tr>'; return; }

      document.getElementById('erpSupStmtInfo').innerHTML =
        '<div style="display:flex;gap:16px;padding:12px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;flex-wrap:wrap;">'+
        '<div><i class="fas fa-truck" style="color:var(--accent);margin-left:6px;"></i><strong>'+res.supplier.name+'</strong></div>'+
        '<div><i class="fas fa-id-card" style="color:#64748b;margin-left:4px;"></i> '+(res.supplier.vatNumber||'—')+'</div>'+
        '<div><i class="fas fa-phone" style="color:#64748b;margin-left:4px;"></i> '+(res.supplier.phone||'—')+'</div>'+
        '</div>';

      // Summary cards
      var bal = res.summary.closingBalance;
      var balColor = bal > 0 ? '#ef4444' : (bal < 0 ? '#16a34a' : '#64748b');
      var balLabel = bal > 0 ? 'مستحق للمورد' : (bal < 0 ? 'لصالحنا' : 'متطابق');
      document.getElementById('erpSupStmtSummary').innerHTML =
        '<div class="fin-card"><span class="fin-label">إجمالي المدين (مدفوعات)</span><span class="fin-val text-green">'+res.summary.totalDebit.toFixed(2)+'</span></div>'+
        '<div class="fin-card"><span class="fin-label">إجمالي الدائن (مشتريات)</span><span class="fin-val text-red">'+res.summary.totalCredit.toFixed(2)+'</span></div>'+
        '<div class="fin-card highlight"><span class="fin-label">الرصيد ('+balLabel+')</span><span class="fin-val" style="color:'+balColor+'">'+Math.abs(bal).toFixed(2)+'</span></div>';

      if (!res.transactions || !res.transactions.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد حركات في هذه الفترة</td></tr>';
      } else {
        tbody.innerHTML = res.transactions.map(function(t){
          var typeColors = {'أمر شراء':'blue','فاتورة شراء':'purple','سند صرف':'green','قيد محاسبي':'orange'};
          var bc = typeColors[t.type]||'blue';
          return '<tr>'+
            '<td>'+t.date+'</td>'+
            '<td><span class="badge badge-'+bc+'">'+t.type+'</span></td>'+
            '<td><code style="font-size:11px;">'+( t.reference||'')+'</code></td>'+
            '<td>'+t.description+'</td>'+
            '<td style="color:#16a34a;font-weight:700;">'+(t.debit?t.debit.toFixed(2):'—')+'</td>'+
            '<td style="color:#ef4444;font-weight:700;">'+(t.credit?t.credit.toFixed(2):'—')+'</td>'+
            '<td><strong>'+t.balance.toFixed(2)+'</strong></td>'+
            '</tr>';
        }).join('');
      }
    })
    .withFailureHandler(function(e) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="color:red;">خطأ: '+e.message+'</td></tr>'; })
    .getSupplierStatement(supId, from, to);
}

function erpExportSupStmt() {
  if (!_erpSupStmtData || !_erpSupStmtData.success) return showToast('اعرض كشف الحساب أولاً','error');
  var d = _erpSupStmtData;
  var wsData = [['كشف حساب المورد: '+d.supplier.name],['الرقم الضريبي: '+(d.supplier.vatNumber||'—'),'الهاتف: '+(d.supplier.phone||'—')],[], ['التاريخ','النوع','المرجع','الوصف','مدين','دائن','الرصيد']];
  (d.transactions||[]).forEach(function(t){ wsData.push([t.date,t.type,t.reference,t.description,t.debit||0,t.credit||0,t.balance]); });
  wsData.push([]);
  wsData.push(['','','','إجمالي المدين',d.summary.totalDebit,'إجمالي الدائن',d.summary.totalCredit]);
  wsData.push(['','','','','','الرصيد الختامي',d.summary.closingBalance]);
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:12},{wch:14},{wch:16},{wch:30},{wch:12},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws, 'كشف حساب');
  XLSX.writeFile(wb, 'كشف_حساب_'+d.supplier.name+'_'+new Date().toISOString().split('T')[0]+'.xlsx');
}

function erpPrintSupStmt() {
  if (!_erpSupStmtData || !_erpSupStmtData.success) return showToast('اعرض كشف الحساب أولاً','error');
  var d = _erpSupStmtData;
  var w = window.open('','_blank','width=800,height=700');
  var rows = (d.transactions||[]).map(function(t,i){
    return '<tr><td>'+(i+1)+'</td><td>'+t.date+'</td><td>'+t.type+'</td><td>'+( t.reference||'')+'</td><td>'+t.description+'</td><td>'+(t.debit?t.debit.toFixed(2):'')+'</td><td>'+(t.credit?t.credit.toFixed(2):'')+'</td><td style="font-weight:700;">'+t.balance.toFixed(2)+'</td></tr>';
  }).join('');
  w.document.write('<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>كشف حساب '+d.supplier.name+'</title>'+
    '<style>body{font-family:Arial;direction:rtl;padding:20px;font-size:12px;color:#1e293b;}h2{text-align:center;margin-bottom:4px;}'+
    '.info{display:flex;justify-content:space-between;margin:12px 0;font-size:12px;background:#f8fafc;padding:8px 12px;border-radius:6px;}'+
    'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{border:1px solid #ddd;padding:6px 8px;text-align:right;font-size:11px;}'+
    'th{background:#f1f5f9;font-weight:700;}.summary{display:flex;justify-content:space-around;margin-top:12px;font-size:13px;font-weight:700;}'+
    '.summary div{text-align:center;padding:8px 16px;border-radius:8px;border:1px solid #e2e8f0;}</style></head><body>'+
    '<h2>كشف حساب المورد</h2><h3 style="text-align:center;color:#64748b;margin-bottom:12px;">'+d.supplier.name+'</h3>'+
    '<div class="info"><span>الرقم الضريبي: '+(d.supplier.vatNumber||'—')+'</span><span>الهاتف: '+(d.supplier.phone||'—')+'</span><span>التاريخ: '+new Date().toLocaleDateString('ar-SA')+'</span></div>'+
    '<table><thead><tr><th>#</th><th>التاريخ</th><th>النوع</th><th>المرجع</th><th>الوصف</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<div class="summary"><div>إجمالي المدين: '+d.summary.totalDebit.toFixed(2)+'</div><div>إجمالي الدائن: '+d.summary.totalCredit.toFixed(2)+'</div><div style="background:#eff6ff;border-color:#93c5fd;">الرصيد: '+d.summary.closingBalance.toFixed(2)+'</div></div>'+
    '</body></html>');
  w.document.close();
  setTimeout(function(){w.print();},400);
}

// ═══════════════════════════════════════
// PRINT STATEMENT (طباعة كشف حساب)
// ═══════════════════════════════════════

function erpPrintStatement(type) {
  const containerId = type === 'customer' ? 'erpCustomerStatement' : 'erpSupplierStatement';
  const el = document.getElementById(containerId);
  const printWin = window.open('', '_blank');
  printWin.document.write(`<html dir="rtl"><head><title>كشف حساب</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;direction:rtl}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:right;font-size:12px}th{background:#f0f4f8}
    .section-title{font-size:18px;margin-bottom:10px}.fin-grid{display:flex;gap:15px;margin:10px 0}.fin-card{padding:8px;background:#f8fafc;border-radius:4px}.fin-label{font-size:11px;color:#666}.fin-val{font-weight:bold}
    @media print{button{display:none}}</style></head><body>${el.innerHTML}<scr`+`ipt>window.print();<\/scr`+`ipt></body></html>`);
  printWin.document.close();
}

// ═══════════════════════════════════════
// EXPORT CSV (تصدير التقارير) §19.9
// ═══════════════════════════════════════

function erpExportReport(reportType) {
  loader(true);
  const filters = {};
  if (reportType === 'warehouse_stock') {
    const whId = document.getElementById('erpStockWhFilter');
    if (whId) filters.warehouseId = whId.value || null;
  }
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (!res.success) { showToast(res.error || 'خطأ في التصدير', 'error'); return; }
    // تنزيل CSV
    const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = res.filename || 'report.csv';
    link.click();
    showToast('تم تصدير التقرير');
  }).exportReportCSV(reportType, filters);
}

// ═══════════════════════════════════════
// MODAL UTILS
// ═══════════════════════════════════════
function erpCloseModal() {
  document.getElementById('erpModal').classList.add('hidden');
  // Reset modal width (PO form widens it)
  const box = document.querySelector('#erpModal .modal-box');
  if (box) box.style.maxWidth = '';
}
function erpModalSave() {
  // Placeholder — each modal sets its own save handler
}
