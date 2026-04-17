// ====================================================================
// ERP Frontend Logic — MASTER_ERP_SYSTEM_SPEC Compliant
// ====================================================================

// ─── Professional Confirm Dialog ───
function erpConfirm(title, message, onOk, opts) {
  opts = opts || {};
  var color = opts.color || '#1e40af';
  var icon = opts.icon || 'fa-question-circle';
  var okText = opts.okText || 'تأكيد';
  var cancelText = opts.cancelText || 'إلغاء';
  var id = 'erpConfirmDlg';
  var old = document.getElementById(id); if (old) old.remove();
  var div = document.createElement('div');
  div.id = id;
  // Inject keyframes if not already
  if (!document.getElementById('erpConfirmCSS')) {
    var st = document.createElement('style'); st.id = 'erpConfirmCSS';
    st.textContent = '@keyframes erpFadeIn{from{opacity:0}to{opacity:1}}@keyframes erpScaleIn{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}';
    document.head.appendChild(st);
  }
  div.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;animation:erpFadeIn .15s ease;';
  div.innerHTML =
    '<div style="background:#fff;border-radius:16px;padding:28px;width:420px;max-width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.15);animation:erpScaleIn .2s ease;">' +
      '<div style="width:56px;height:56px;border-radius:50%;background:' + color + '15;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;"><i class="fas ' + icon + '" style="font-size:24px;color:' + color + ';"></i></div>' +
      '<h3 style="margin:0 0 8px;font-size:17px;color:#0f172a;">' + title + '</h3>' +
      '<p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.6;">' + message + '</p>' +
      '<div style="display:flex;gap:10px;justify-content:center;">' +
        '<button id="erpConfirmOk" style="padding:10px 32px;border-radius:10px;border:none;background:' + color + ';color:#fff;font-weight:800;font-size:14px;cursor:pointer;">' + okText + '</button>' +
        '<button id="erpConfirmCancel" style="padding:10px 24px;border-radius:10px;border:2px solid #e5e7eb;background:#fff;color:#64748b;font-weight:700;font-size:14px;cursor:pointer;">' + cancelText + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(div);
  div.querySelector('#erpConfirmOk').onclick = function() { div.remove(); if (onOk) onOk(); };
  div.querySelector('#erpConfirmCancel').onclick = function() { div.remove(); };
  div.addEventListener('click', function(e) { if (e.target === div) div.remove(); });
}

// Bridge: currentUser from POS state
Object.defineProperty(window, 'currentUser', { get: function() { return (typeof state !== 'undefined' && state.user) ? state.user : ''; } });

// ═══════════════════════════════════════
// ERP NAVIGATION
// ═══════════════════════════════════════
const erpSections = [
  'erpDashHome','erpCustomers','erpSuppliers','erpGLAccounts','erpGLJournals',
  'erpPurchaseOrders','erpVATReports','erpZATCA','erpInventoryMethod','erpFinReports','erpPurchaseReports','erpBrands','erpCostCenters','erpMultiWarehouses',
  'erpBranches','erpPeriods','erpAuditLog','erpCreditNotes',
  /* legacy warehouse sections removed */
  'erpARAging','erpAPAging','erpCustomerStatement','erpSupplierStatement',
  'erpWfPositions','erpWfTypes','erpWfDefs','erpWfInbox',
  'erpHrDashboard','erpHrEmployees','erpHrDepartments','erpHrAttendance','erpHrLeave','erpHrPayroll','erpHrAdvances',
  'erpHrShifts','erpHrOvertime','erpHrExceptions'
];

function erpNav(sectionId) {
  // Save last section for persistence across refreshes
  try { localStorage.setItem('pos_last_section', 'erp:' + sectionId); } catch(e) {}
  // Lazy-mount the section on first access
  if (typeof mountSection === 'function') mountSection(sectionId);
  // Update active state on sidebar
  document.querySelectorAll('[data-erp-nav]').forEach(el => el.classList.remove('active'));
  var activeNavEl = document.querySelector('[data-erp-nav="'+sectionId+'"]');
  if (activeNavEl) {
    activeNavEl.classList.add('active');
    // Auto-open parent submenu if collapsed
    var parent = activeNavEl.closest('.submenu');
    if (parent && !parent.classList.contains('open')) {
      parent.classList.add('open');
      var toggle = parent.previousElementSibling;
      if (toggle && toggle.classList.contains('has-submenu')) toggle.classList.add('open');
    }
  }
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
      case 'erpInventoryMethod': erpLoadInventoryMethod(); break;
      case 'erpFinReports': erpBackToReportsHub(); break;
      case 'erpBrands': erpLoadBrands(); break;
      case 'erpPurchaseReports': erpInitPurchaseReports(); break;
      case 'erpCostCenters': erpLoadCostCenters(); break;
      case 'erpMultiWarehouses': erpLoadMultiWarehouses(); break;
      case 'erpBranches': erpLoadBranchesFull(); break;
      case 'erpPeriods': erpLoadPeriods(); break;
      case 'erpAuditLog': erpLoadAuditLog(); break;
      case 'erpCreditNotes': erpLoadNotes(); break;
      /* legacy warehouse nav cases removed */
      case 'erpARAging': erpLoadARAging(); break;
      case 'erpAPAging': erpLoadAPAging(); break;
      case 'erpCustomerStatement': erpLoadCustomerStatementPage(); break;
      case 'erpSupplierStatement': erpLoadSupplierStatementPage(); break;
      case 'erpWfPositions': wfLoadPositions(); break;
      case 'erpWfTypes': wfLoadTypes(); break;
      case 'erpWfDefs': wfInitDefs(); break;
      case 'erpWfInbox': wfLoadInbox(); break;
      case 'erpHrDashboard': hrLoadDashboard(); break;
      case 'erpHrEmployees': hrLoadEmployees(); break;
      case 'erpHrDepartments': hrLoadDepartments(); break;
      case 'erpHrAttendance': hrLoadAttendance(); break;
      case 'erpHrLeave': hrLoadLeaveRequests(); break;
      case 'erpHrPayroll': hrLoadPayrollRuns(); break;
      case 'erpHrAdvances': hrLoadAdvances(); break;
      case 'erpHrShifts': hrLoadShifts(); break;
      case 'erpHrOvertime': hrLoadOvertimeEntries(); break;
      case 'erpHrExceptions': hrLoadExceptions(); break;
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
// GL ACCOUNTS — Tree View (دليل الحسابات)
// ═══════════════════════════════════════
let _erpAccounts = [];
var _coaSelectedId = null;

function erpLoadAccounts() {
  window._apiBridge.withSuccessHandler(function() {
    erpLoadAccountsList_();
  }).seedCafeGLAccounts();
}
function erpLoadAccountsList_() {
  // Sync inventory values to GL first (perpetual method)
  window._apiBridge.withSuccessHandler(function() {
    // Then load accounts
    window._apiBridge.withSuccessHandler(function(list) {
      _erpAccounts = (list || []).map(a => ({
        id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn,
        type: a.type, parentId: a.parentId, level: Number(a.level)||1,
        isActive: a.isActive, balance: Number(a.balance)||0
      }));
      _coaBuildTree();
      if (_coaSelectedId) coaSelectNode(_coaSelectedId);
    }).getGLAccounts();
  }).syncInventoryGL();
}

// ─── Build children map ───
function _coaChildrenOf(parentId) {
  return _erpAccounts.filter(a => (a.parentId||null) === (parentId||null)).sort((a,b) => a.code.localeCompare(b.code));
}
function _coaIsGroup(id) { return _erpAccounts.some(a => a.parentId === id); }

// ─── Build Tree Sidebar ───
function _coaBuildTree() {
  var container = document.getElementById('coaTreeBody');
  if (!container) return;

  // Find ONLY the 5 main roots by code (1,2,3,4,5)
  var mainCodes = ['1','2','3','4','5'];
  var roots = _erpAccounts.filter(function(a) {
    return mainCodes.indexOf(a.code) >= 0;
  }).sort(function(a,b) { return a.code.localeCompare(b.code); });

  // If no accounts with exact codes 1-5, fallback to level=1
  if (!roots.length) {
    roots = _erpAccounts.filter(function(a) { return a.level === 1; }).sort(function(a,b) { return a.code.localeCompare(b.code); });
  }

  // Final fallback: accounts with no parent
  if (!roots.length) roots = _coaChildrenOf(null);

  container.innerHTML = roots.map(function(a) { return _coaRenderNode(a, false); }).join('');
}

function _coaRenderNode(acc, open) {
  var children = _coaChildrenOf(acc.id);
  var isGroup = children.length > 0;
  var lvl = acc.level || 1;
  var chevronDir = open ? 'fa-chevron-down' : 'fa-chevron-left';
  var toggle = isGroup ? '<span class="coa-node-toggle"><i class="fas ' + chevronDir + '"></i></span>' : '<span style="width:16px;display:inline-block;"></span>';
  var iconSize = lvl <= 1 ? 18 : lvl === 2 ? 16 : lvl === 3 ? 14 : 12;
  var icon = isGroup
    ? '<i class="fas fa-folder" style="color:#f59e0b;font-size:' + iconSize + 'px;"></i>'
    : '<i class="fas fa-file-alt" style="color:#3b82f6;font-size:' + iconSize + 'px;"></i>';
  var fontW = lvl <= 1 ? 900 : lvl === 2 ? 800 : lvl === 3 ? 600 : 400;
  var fontSize = lvl <= 1 ? 15 : lvl === 2 ? 14 : lvl === 3 ? 13 : 12;
  var activeClass = _coaSelectedId === acc.id ? ' active' : '';

  var html = '<div class="coa-node" data-id="' + acc.id + '" data-level="' + lvl + '">';
  html += '<div class="coa-node-row' + activeClass + '" style="font-weight:' + fontW + ';font-size:' + fontSize + 'px;" onclick="coaSelectNode(\'' + acc.id + '\')">';
  html += toggle + ' ' + icon + ' ';
  html += '<span class="coa-node-name">' + (acc.nameAr||'') + '</span>';
  // Show balance on the side
  if (acc.balance && acc.balance !== 0) {
    var balColor = acc.balance > 0 ? '#16a34a' : '#ef4444';
    html += '<span style="font-size:10px;font-weight:800;color:' + balColor + ';margin-inline-start:auto;white-space:nowrap;">' + Number(acc.balance).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + '</span>';
  }
  html += '</div>';
  if (isGroup) {
    html += '<div class="coa-node-children' + (open ? ' open' : '') + '" style="margin-inline-start:30px;padding-inline-start:10px;border-inline-start:2px dotted #cbd5e1;">';
    html += children.map(function(c) { return _coaRenderNode(c, false); }).join('');
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// ─── Tree: Toggle expand/collapse ───
document.addEventListener('click', function(e) {
  var toggle = e.target.closest('.coa-node-toggle');
  if (toggle && toggle.querySelector('i')) {
    e.stopPropagation();
    var node = toggle.closest('.coa-node');
    var children = node.querySelector('.coa-node-children');
    if (children) {
      children.classList.toggle('open');
      var icon = toggle.querySelector('i');
      icon.className = children.classList.contains('open') ? 'fas fa-chevron-down' : 'fas fa-chevron-left';
    }
  }
});

// ─── Tree: Select node ───
window.coaSelectNode = function(id) {
  _coaSelectedId = id;
  // Highlight in tree
  document.querySelectorAll('.coa-node-row').forEach(r => r.classList.remove('active'));
  var row = document.querySelector('.coa-node[data-id="' + id + '"] > .coa-node-row');
  if (row) row.classList.add('active');
  // Expand parent chain
  var acc = _erpAccounts.find(a => a.id === id);
  if (acc) {
    var parent = acc;
    while (parent && parent.parentId) {
      var parentNode = document.querySelector('.coa-node[data-id="' + parent.parentId + '"] > .coa-node-children');
      if (parentNode) parentNode.classList.add('open');
      parent = _erpAccounts.find(a => a.id === parent.parentId);
    }
  }

  var isGroup = _coaIsGroup(id);
  var main = document.getElementById('coaMainContent');
  if (isGroup) {
    _coaShowGroup(id, main);
  } else {
    _coaShowAccount(id, main);
  }
};

// ─── Show Group (children as cards) ───
function _coaShowGroup(id, container) {
  var acc = _erpAccounts.find(a => a.id === id);
  if (!acc) return;
  var children = _coaChildrenOf(id);
  var typeNature = {asset:'debit',expense:'debit',liability:'credit',equity:'credit',revenue:'credit'};
  var natureLabels = {debit:'مدين',credit:'دائن'};
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };

  var html = '<div class="coa-group-header">';
  html += '<div class="coa-group-title"><i class="fas fa-folder-open"></i> ' + (acc.nameAr||'') + ' <span class="coa-group-code">#' + acc.code + '</span></div>';
  html += '<div style="display:flex;gap:6px;">';
  html += '<button class="btn btn-sm btn-primary" onclick="erpAddChildAccount(\'' + acc.id + '\',\'' + acc.code + '\')" style="border-radius:10px;"><i class="fas fa-plus"></i> إضافة حساب</button>';
  html += '<button class="btn btn-sm btn-light" onclick="erpEditAccount(\'' + acc.id + '\')" style="border-radius:10px;"><i class="fas fa-edit"></i></button>';
  html += '</div></div>';

  if (!children.length) {
    html += '<div class="coa-empty"><i class="fas fa-inbox"></i><p>هذا الحساب فارغ</p></div>';
    html += '<button class="coa-add-btn" onclick="erpAddChildAccount(\'' + acc.id + '\',\'' + acc.code + '\')"><i class="fas fa-plus-circle"></i> أضف حساب</button>';
  } else {
    html += '<div class="coa-cards">';
    children.forEach(function(c) {
      var isChild = _coaIsGroup(c.id);
      var nature = typeNature[c.type] || 'debit';
      html += '<div class="coa-card" onclick="coaSelectNode(\'' + c.id + '\')">';
      html += '<i class="fas ' + (isChild?'fa-folder':'fa-file-alt') + ' coa-card-icon' + (isChild?'':' leaf') + '"></i>';
      html += '<div class="coa-card-body">';
      html += '<div class="coa-card-name">' + (c.nameAr||'') + '</div>';
      html += '<div class="coa-card-sub"><span class="coa-card-code">#' + c.code + '</span>';
      html += '<span class="coa-card-nature ' + nature + '">' + (natureLabels[nature]||'') + '</span></div>';
      html += '</div>';
      if (c.balance) html += '<div class="coa-card-bal">' + fmt(c.balance) + '</div>';
      html += '<span class="coa-card-menu" onclick="event.stopPropagation();coaCardMenu(\'' + c.id + '\',this)" title="خيارات">&#8943;</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<button class="coa-add-btn" onclick="erpAddChildAccount(\'' + acc.id + '\',\'' + acc.code + '\')"><i class="fas fa-plus-circle"></i> أضف حساب</button>';
  }
  container.innerHTML = html;
}

// ─── Show Account Detail (transactions) ───
function _coaShowAccount(id, container) {
  var acc = _erpAccounts.find(a => a.id === id);
  if (!acc) return;
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var balColor = acc.balance >= 0 ? '#16a34a' : '#ef4444';

  var html = '<div class="coa-acc-header">';
  html += '<div><div class="coa-acc-name"><i class="fas fa-file-alt" style="color:#3b82f6;margin-left:8px;"></i>' + (acc.nameAr||'') + '</div>';
  html += '<span class="coa-acc-code-badge">#' + acc.code + '</span></div>';
  html += '<div class="coa-acc-bal-box"><div class="coa-acc-bal-label">الرصيد</div><div class="coa-acc-bal-val" style="color:' + balColor + ';">' + fmt(acc.balance) + '</div></div>';
  html += '</div>';

  // Action buttons
  html += '<div style="display:flex;gap:6px;margin-bottom:16px;">';
  html += '<button class="btn btn-sm btn-light" onclick="erpEditAccount(\'' + acc.id + '\')" style="border-radius:10px;"><i class="fas fa-edit"></i> تعديل</button>';
  html += '<button class="btn btn-sm btn-light" style="border-radius:10px;color:#ef4444;" onclick="erpDeleteAccount(\'' + acc.id + '\',\'' + acc.code + '\',\'' + (acc.nameAr||'').replace(/'/g,'') + '\')"><i class="fas fa-trash"></i> حذف</button>';
  html += '<button class="coa-add-btn" onclick="erpAddChildAccount(\'' + acc.id + '\',\'' + acc.code + '\')"><i class="fas fa-plus-circle"></i> إضافة فرعي</button>';
  html += '</div>';

  // Transactions table
  html += '<h4 style="font-size:15px;font-weight:800;color:#1e293b;margin-bottom:10px;"><i class="fas fa-list-alt" style="color:#3b82f6;margin-left:6px;"></i> حركات الحساب</h4>';
  html += '<div id="coaTransLoading" style="text-align:center;padding:20px;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
  html += '<div id="coaTransTable"></div>';
  container.innerHTML = html;

  // Load transactions for this account
  _coaLoadTransactions(id);
}

function _coaLoadTransactions(accountId) {
  // Use dedicated account ledger endpoint — queries gl_entries directly by account_id/code
  window._apiBridge.withSuccessHandler(function(res) {
    var loadingEl = document.getElementById('coaTransLoading');
    if (loadingEl) loadingEl.style.display = 'none';
    var tableEl = document.getElementById('coaTransTable');
    if (!tableEl) return;
    var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };

    var rows = (res && res.ledger) || [];
    if (!rows.length) {
      tableEl.innerHTML = '<div class="coa-empty"><i class="fas fa-inbox"></i><p>لا توجد حركات لهذا الحساب</p></div>';
      return;
    }

    var refLabels = { manual: 'يدوي', opening: 'افتتاحي', sale: 'مبيعات', purchase: 'مشتريات', custody: 'عهدة', inventory: 'مخزون' };
    var refColors = { manual: '#3b82f6', opening: '#7c3aed', sale: '#10b981', purchase: '#f59e0b', custody: '#ec4899', inventory: '#06b6d4' };

    var html = '<div style="overflow-x:auto;border-radius:12px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 12px;">التاريخ</th><th>القيد</th><th>النوع</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>';
    rows.forEach(function(r) {
      var dt = '';
      try { dt = new Date(r.journalDate).toLocaleDateString('en-GB'); } catch(e) {}
      var balColor = r.balance >= 0 ? '#16a34a' : '#ef4444';
      var refType = r.referenceType || 'manual';
      var typeBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:' + (refColors[refType]||'#94a3b8') + '15;color:' + (refColors[refType]||'#94a3b8') + ';">' + (refLabels[refType]||refType) + '</span>';
      html += '<tr style="cursor:pointer;border-bottom:1px solid #f1f5f9;" onclick="erpViewJournal(\'' + r.journalId + '\')" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">';
      html += '<td style="padding:8px 12px;">' + dt + '</td>';
      html += '<td><code style="color:#3b82f6;font-weight:700;">' + (r.journalNumber||'') + '</code></td>';
      html += '<td>' + typeBadge + '</td>';
      html += '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + (r.journalDesc || r.entryDesc || '') + '</td>';
      html += '<td style="font-weight:700;color:#16a34a;">' + (r.debit ? fmt(r.debit) : '') + '</td>';
      html += '<td style="font-weight:700;color:#ef4444;">' + (r.credit ? fmt(r.credit) : '') + '</td>';
      html += '<td style="font-weight:800;color:' + balColor + ';">' + fmt(r.balance) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    tableEl.innerHTML = html;
  }).getAccountLedger(accountId);
}

// ─── Card context menu ───
window.coaCardMenu = function(id, el) {
  var acc = _erpAccounts.find(a => a.id === id);
  if (!acc) return;
  // Simple: edit or delete
  var choice = confirm('تعديل حساب "' + (acc.nameAr||'') + '"?\n\nاضغط إلغاء للحذف.');
  if (choice) { erpEditAccount(id); }
  else {
    if (confirm('حذف "' + acc.code + ' — ' + (acc.nameAr||'') + '"؟')) erpDeleteAccount(id, acc.code, acc.nameAr||'');
  }
};

// ─── Tree search filter ───
window.coaFilterTree = function(query) {
  var q = (query||'').toLowerCase();
  document.querySelectorAll('.coa-node').forEach(function(node) {
    var name = (node.querySelector('.coa-node-name')||{}).textContent || '';
    if (!q || name.toLowerCase().indexOf(q) >= 0) {
      node.style.display = '';
      // Also expand parents
      var parent = node.parentElement;
      while (parent && parent.classList) {
        if (parent.classList.contains('coa-node-children')) parent.classList.add('open');
        parent = parent.parentElement;
      }
    } else {
      // Only hide if no matching children
      var hasMatch = node.querySelector('.coa-node-name') && Array.from(node.querySelectorAll('.coa-node-name')).some(function(n) { return n.textContent.toLowerCase().indexOf(q) >= 0; });
      node.style.display = hasMatch ? '' : 'none';
    }
  });
};

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
    if (res.success) {
      showToast('تم حذف الحساب');
      if (_coaSelectedId === id) _coaSelectedId = null;
      erpLoadAccounts();
    } else showToast(res.error, true);
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
// ─── Journal cache ───
var _jrnCache = [];
var _jrnListHTML = ''; // Stores original journal list HTML

function erpLoadJournals() {
  // Restore original list HTML if we were in form mode
  if (_jrnListHTML) {
    var sec = document.getElementById('erpGLJournals');
    if (sec && !document.getElementById('erpJournalsBody')) {
      sec.innerHTML = _jrnListHTML;
    }
  }
  var filters = {};
  var s = document.getElementById('erpJrnStartDate');
  var e = document.getElementById('erpJrnEndDate');
  var st = document.getElementById('erpJrnStatusFilter');
  if (s && s.value) filters.startDate = s.value;
  if (e && e.value) filters.endDate = e.value;
  if (st && st.value) filters.status = st.value;

  window._apiBridge.withSuccessHandler(function(list) {
    _jrnCache = list || [];
    var tbody = document.getElementById('erpJournalsBody');

    // Stats
    var total = list.length, drafts = 0, approved = 0, posted = 0;
    list.forEach(function(j) {
      if (j.status === 'draft') drafts++;
      else if (j.status === 'approved') approved++;
      else if (j.status === 'posted') posted++;
    });
    var _s = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    _s('jrnStatTotal', total); _s('jrnStatDraft', drafts); _s('jrnStatApproved', approved); _s('jrnStatPosted', posted);

    if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;color:#cbd5e1;"></i>لا توجد قيود</td></tr>'; return; }

    var statusBadge = function(s) {
      if (s === 'draft') return '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:800;background:#fef3c7;color:#92400e;"><i class="fas fa-pencil-alt"></i> مسودة</span>';
      if (s === 'approved') return '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:800;background:#e0e7ff;color:#4338ca;"><i class="fas fa-check"></i> معتمد</span>';
      return '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:800;background:#dcfce7;color:#166534;"><i class="fas fa-check-double"></i> مرحّل</span>';
    };

    tbody.innerHTML = list.map(function(j) {
      var dt = j.journalDate ? new Date(j.journalDate).toLocaleDateString('en-GB') : '';
      var actions = '<button class="btn-icon" onclick="erpViewJournal(\'' + j.id + '\')" title="عرض"><i class="fas fa-eye"></i></button> ';
      actions += '<button class="btn-icon" style="color:#3b82f6;" onclick="erpPrintJournal(\'' + j.id + '\')" title="طباعة"><i class="fas fa-print"></i></button> ';
      var isDev = state.currentUser && (state.currentUser.isDeveloper || state.role === 'admin');
      if (j.status === 'draft') {
        actions += '<button class="btn-icon" style="color:#8b5cf6;" onclick="erpApproveJournal(\'' + j.id + '\')" title="اعتماد"><i class="fas fa-check-circle"></i></button> ';
        if (isDev) actions += '<button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteJournal(\'' + j.id + '\',\'' + (j.journalNumber||'') + '\')" title="حذف"><i class="fas fa-trash"></i></button>';
      } else if (j.status === 'approved') {
        actions += '<button class="btn-icon" style="color:#16a34a;" onclick="erpPostJournal(\'' + j.id + '\')" title="ترحيل"><i class="fas fa-share-square"></i></button> ';
        if (isDev) actions += '<button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteJournal(\'' + j.id + '\',\'' + (j.journalNumber||'') + '\')" title="حذف"><i class="fas fa-trash"></i></button>';
      } else if (j.status === 'posted') {
        actions += '<button class="btn-icon" style="color:#f59e0b;" onclick="erpUnpostJournal(\'' + j.id + '\')" title="إلغاء الترحيل"><i class="fas fa-undo"></i></button> ';
        if (isDev) actions += '<button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteJournal(\'' + j.id + '\',\'' + (j.journalNumber||'') + '\')" title="حذف (مطور)"><i class="fas fa-trash"></i></button>';
      }
      return '<tr style="' + (j.status==='draft'?'background:rgba(254,243,199,0.15);':'') + '">' +
        '<td><code style="font-weight:800;color:#1e40af;">' + (j.journalNumber||'') + '</code><div style="font-size:10px;color:#94a3b8;margin-top:2px;"><i class="fas fa-user" style="margin-left:2px;"></i>' + (j.createdBy||'') + '</div></td>' +
        '<td style="font-size:13px;">' + dt + '</td>' +
        '<td style="font-weight:600;">' + (j.description||'') + '</td>' +
        '<td style="font-weight:800;color:#16a34a;">' + (j.totalDebit||0).toFixed(2) + '</td>' +
        '<td style="font-weight:800;color:#ef4444;">' + (j.totalCredit||0).toFixed(2) + '</td>' +
        '<td>' + statusBadge(j.status) + '</td>' +
        '<td style="white-space:nowrap;">' + actions + '</td></tr>';
    }).join('');
  }).getGLJournals(filters);
}

function erpViewJournal(journalId) {
  // Always fetch fresh from full journal list to get all fields
  window._apiBridge.withSuccessHandler(function(allJournals) {
    var j = (allJournals||[]).find(function(x) { return x.id === journalId; });
    if (j) {
      _renderJournalDetail(j);
    } else {
      // Fallback: fetch entries only
      window._apiBridge.withSuccessHandler(function(entries) {
        _renderJournalDetail({ id: journalId, entries: entries || [], journalNumber: '—', description: '', journalDate: '', status: 'posted', createdBy: '' });
      }).getGLEntries(journalId);
    }
  }).getGLJournals({});
}

function _renderJournalDetail(j) {
  var entries = j.entries || [];
  var dt = j.journalDate ? new Date(j.journalDate).toLocaleDateString('en-GB') : '—';
  var statusLabels = {draft:'مسودة',approved:'معتمد',posted:'مرحّل'};
  var statusColors = {draft:'#f59e0b',approved:'#8b5cf6',posted:'#16a34a'};

  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px;">' +
    '<div style="background:#f8fafc;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">رقم القيد</span><strong style="font-size:15px;color:#1e40af;">' + (j.journalNumber||'—') + '</strong></div>' +
    '<div style="background:#f8fafc;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">التاريخ</span><strong>' + dt + '</strong></div>' +
    '<div style="background:#f8fafc;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">الحالة</span><strong style="color:' + (statusColors[j.status]||'#64748b') + ';">' + (statusLabels[j.status]||j.status||'—') + '</strong></div>' +
    '<div style="background:#f0fdf4;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">أنشأه</span><strong style="color:#16a34a;">' + (j.createdBy||'—') + '</strong></div>' +
    (j.approvedBy ? '<div style="background:#eff6ff;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">اعتمده</span><strong style="color:#1e40af;">' + j.approvedBy + '</strong></div>' : '') +
    (j.postedBy ? '<div style="background:#f0fdf4;padding:10px 12px;border-radius:12px;"><span style="font-size:10px;color:#64748b;display:block;">رحّله</span><strong style="color:#166534;">' + j.postedBy + '</strong></div>' : '') +
    '</div>';

  if (j.description) html += '<div style="margin-bottom:12px;padding:8px 14px;background:#eff6ff;border-radius:10px;font-weight:700;color:#1e40af;font-size:13px;"><i class="fas fa-file-alt" style="margin-left:6px;"></i>' + j.description + '</div>';

  html += '<table class="erp-table" style="font-size:13px;"><thead><tr><th style="width:90px;">رقم الحساب</th><th>اسم الحساب</th><th>البيان</th><th style="width:100px;">مدين</th><th style="width:100px;">دائن</th></tr></thead><tbody>';
  var totalD = 0, totalC = 0;
  entries.forEach(function(e) {
    totalD += Number(e.debit)||0; totalC += Number(e.credit)||0;
    html += '<tr><td><code style="font-weight:700;">' + (e.accountCode||'') + '</code></td><td style="font-weight:700;">' + (e.accountName||'') + '</td><td style="color:#64748b;font-size:12px;">' + (e.description||'') + '</td>' +
      '<td style="font-weight:800;color:#16a34a;">' + ((e.debit||0) > 0 ? Number(e.debit).toFixed(2) : '') + '</td>' +
      '<td style="font-weight:800;color:#ef4444;">' + ((e.credit||0) > 0 ? Number(e.credit).toFixed(2) : '') + '</td></tr>';
  });
  html += '<tr style="background:#f1f5f9;"><td colspan="3" style="font-weight:900;">الإجمالي</td><td style="font-weight:900;color:#16a34a;">' + totalD.toFixed(2) + '</td><td style="font-weight:900;color:#ef4444;">' + totalC.toFixed(2) + '</td></tr>';
  html += '</tbody></table>';

  // Action buttons
  var isManual = !j.referenceType || j.referenceType === 'manual' || j.referenceType === 'opening';
  html += '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;flex-wrap:wrap;">';
  html += '<button class="btn btn-sm btn-secondary" onclick="erpPrintJournal(\'' + j.id + '\')" style="border-radius:10px;"><i class="fas fa-print"></i> طباعة</button>';
  // Show edit button for ALL manual/opening journals regardless of status
  if (isManual) {
    html += '<button class="btn btn-sm" onclick="erpEditJournal(\'' + j.id + '\')" style="border-radius:10px;background:#3b82f6;color:#fff;"><i class="fas fa-edit"></i> تعديل</button>';
  }
  if (j.status === 'draft') {
    html += '<button class="btn btn-sm" onclick="erpApproveJournal(\'' + j.id + '\');erpCloseDetailModal();" style="border-radius:10px;background:#8b5cf6;color:#fff;"><i class="fas fa-check-circle"></i> اعتماد</button>';
  }
  if (j.status === 'approved') {
    html += '<button class="btn btn-sm" onclick="erpPostJournal(\'' + j.id + '\');erpCloseDetailModal();" style="border-radius:10px;background:#16a34a;color:#fff;"><i class="fas fa-share-square"></i> ترحيل</button>';
  }
  html += '</div>';

  // Store for print
  window._viewingJournal = j;

  document.getElementById('erpJournalDetailBody').innerHTML = html;
  document.getElementById('erpJournalDetailModal').classList.remove('hidden');
}

function erpCloseDetailModal() { document.getElementById('erpJournalDetailModal').classList.add('hidden'); }

// ─── Edit Journal (draft only) ───
var _editingJournalId = null;
function erpEditJournal(journalId) {
  var j = window._viewingJournal || _jrnCache.find(function(x) { return x.id === journalId; });
  if (!j) return showToast('القيد غير موجود', true);
  var isManual = !j.referenceType || j.referenceType === 'manual' || j.referenceType === 'opening';
  if (!isManual) return showToast('لا يمكن تعديل القيود التلقائية', true);
  _editingJournalId = journalId;
  erpCloseDetailModal();

  // Open the journal creation modal with pre-filled data
  if (_erpAccounts.length === 0) {
    window._apiBridge.withSuccessHandler(function(list) {
      _erpAccounts = (list || []).map(function(a) {
        return { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: a.type, parentId: a.parentId, level: Number(a.level)||1, balance: Number(a.balance)||0 };
      });
      _renderEditJournalForm(j);
    }).getGLAccounts();
  } else {
    _renderEditJournalForm(j);
  }
}

function _renderEditJournalForm(j) {
  document.getElementById('erpModalTitle').textContent = 'تعديل القيد — ' + (j.journalNumber||'');
  _jrnLineCounter = 0;
  var dt = j.journalDate ? new Date(j.journalDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  document.getElementById('erpModalBody').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>تاريخ القيد *</label><input type="date" class="form-control" id="erpJrnDate" value="' + dt + '"></div>' +
      '<div class="form-row"><label>رقم القيد</label><input class="form-control" id="erpJrnNum" value="' + (j.journalNumber||'') + '" readonly style="background:#f8fafc;color:#94a3b8;"></div>' +
    '</div>' +
    '<div class="form-row"><label>عنوان القيد / الوصف *</label><input class="form-control" id="erpJrnDesc" value="' + (j.description||'') + '"></div>' +
    '<div class="form-row"><label>ملاحظات إضافية</label><input class="form-control" id="erpJrnRef" value="' + (j.notes||'') + '"></div>' +
    '<div class="form-row" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);">' +
      '<input type="checkbox" id="erpJrnIsOpening" style="width:18px;height:18px;accent-color:#f59e0b;"' + (j.referenceType==='opening'?' checked':'') + '>' +
      '<label for="erpJrnIsOpening" style="margin:0;cursor:pointer;font-weight:700;color:#92400e;"><i class="fas fa-flag" style="margin-left:4px;color:#f59e0b;"></i> قيد افتتاحي</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:14px 0;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<h4 style="margin:0;color:#1e293b;"><i class="fas fa-list-ol" style="color:#3b82f6;margin-left:6px;"></i> بنود القيد</h4>' +
      '<button class="btn btn-sm btn-secondary" onclick="erpAddJrnLine()" style="border-radius:10px;"><i class="fas fa-plus"></i> إضافة سطر</button>' +
    '</div>' +
    '<div id="erpJrnLines"></div>' +
    '<div class="jrn-balance-bar" id="erpJrnBalanceInfo">مدين: <strong>0.00</strong> | دائن: <strong>0.00</strong></div>';

  document.getElementById('erpModalSaveBtn').onclick = erpSaveEditedJournal;
  document.getElementById('erpModal').classList.remove('hidden');

  // Add existing entries as lines
  (j.entries||[]).forEach(function(e) {
    erpAddJrnLine();
    var lines = document.querySelectorAll('.jrn-entry-card');
    var lastLine = lines[lines.length - 1];
    if (lastLine) {
      var sel = lastLine.querySelector('.jec-acc');
      if (sel) {
        // Select the right option
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === e.accountId) { sel.selectedIndex = i; break; }
        }
        erpOnAccChange(sel);
      }
      var debitEl = lastLine.querySelector('.jec-debit');
      var creditEl = lastLine.querySelector('.jec-credit');
      var descEl = lastLine.querySelector('.jec-desc');
      if (debitEl && e.debit > 0) debitEl.value = e.debit;
      if (creditEl && e.credit > 0) creditEl.value = e.credit;
      if (descEl) descEl.value = e.description || '';
    }
  });
  erpCalcJrnBalance();
}

function erpSaveEditedJournal() {
  var journalId = _editingJournalId;
  if (!journalId) return erpSaveJournal();

  // Gather entries
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
      entries.push({ accountId: sel.value, accountCode: opt.dataset.code || '', accountName: opt.dataset.name || '', debit: debit, credit: credit, description: desc });
    }
  });
  if (entries.length < 2) return showToast('يجب إدخال بندين على الأقل', true);
  var desc = document.getElementById('erpJrnDesc').value;
  if (!desc) return showToast('عنوان القيد مطلوب', true);
  var totalD = 0, totalC = 0;
  entries.forEach(function(e) { totalD += e.debit; totalC += e.credit; });
  if (Math.abs(totalD - totalC) > 0.01) return showToast('القيد غير متوازن', true);

  loader(true);
  // Use PUT endpoint — handles balance reversal/reapplication for posted journals
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    _editingJournalId = null;
    if (res.success) {
      showToast('تم تعديل القيد: ' + (res.journalNumber || ''));
      erpCloseModal();
      erpLoadJournals();
    } else showToast(res.error, true);
  }).updateGLJournal(journalId, {
    journalDate: document.getElementById('erpJrnDate').value,
    description: desc,
    notes: document.getElementById('erpJrnRef') ? document.getElementById('erpJrnRef').value : '',
    entries: entries,
    username: currentUser
  });
}

function erpApproveJournal(id) {
  erpConfirm('اعتماد القيد', 'هل تريد اعتماد هذا القيد؟', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r.success) { showToast('تم اعتماد القيد'); erpLoadJournals(); } else showToast(r.error, true);
    }).approveGLJournal(id, currentUser);
  }, {icon:'fa-check-circle', color:'#8b5cf6', okText:'اعتماد'});
}

function erpPostJournal(id) {
  erpConfirm('ترحيل القيد', 'سيتم ترحيل القيد إلى ميزان المراجعة ودفتر الأستاذ وتحديث أرصدة الحسابات.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r.success) { showToast('تم ترحيل القيد وتحديث الأرصدة'); erpLoadJournals(); erpLoadAccountsList_(); } else showToast(r.error, true);
    }).postGLJournal(id, currentUser);
  }, {icon:'fa-share-square', color:'#16a34a', okText:'ترحيل'});
}

function erpUnpostJournal(id) {
  erpConfirm('إلغاء الترحيل', 'سيتم عكس أرصدة الحسابات وإرجاع القيد لحالة مسودة.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r && r.success) { showToast('تم إلغاء الترحيل — القيد أصبح مسودة'); erpLoadJournals(); erpLoadAccountsList_(); }
      else showToast((r && r.error) || 'فشل إلغاء الترحيل', true);
    }).unpostGLJournal(id, currentUser);
  }, {icon:'fa-undo', color:'#f59e0b', okText:'إلغاء الترحيل'});
}

function erpDeleteJournal(id, num) {
  erpConfirm('حذف القيد ' + num, 'سيتم عكس جميع الأرصدة المتأثرة وحذف القيد نهائياً.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r.success) { showToast('تم حذف القيد'); erpLoadJournals(); erpLoadAccountsList_(); } else showToast(r.error, true);
    }).deleteGLJournal(id);
  }, {icon:'fa-trash-alt', color:'#ef4444', okText:'حذف'});
}

function erpPrintJournal(journalId) {
  var j = window._viewingJournal || _jrnCache.find(function(x) { return x.id === journalId; });
  if (!j) return showToast('القيد غير موجود — افتح التفاصيل أولاً', true);
  var dt = j.journalDate ? new Date(j.journalDate).toLocaleDateString('en-GB') : '';
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var statusLabels = {draft:'مسودة',approved:'معتمد',posted:'مرحّل'};
  var rows = (j.entries||[]).map(function(e) {
    return '<tr><td style="font-weight:700;">' + (e.accountCode||'') + '</td><td style="font-weight:700;">' + (e.accountName||'') + '</td><td>' + (e.description||'') + '</td>' +
      '<td style="font-weight:800;color:#16a34a;">' + ((e.debit||0)>0?Number(e.debit).toFixed(2):'') + '</td>' +
      '<td style="font-weight:800;color:#ef4444;">' + ((e.credit||0)>0?Number(e.credit).toFixed(2):'') + '</td></tr>';
  }).join('');
  var w = window.open('','_blank');
  w.document.write(
    '<html dir="rtl"><head><meta charset="UTF-8"><title>قيد ' + (j.journalNumber||'') + '</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:30px;color:#1e293b;font-size:13px;}' +
    'h2{text-align:center;margin-bottom:4px;}h3{text-align:center;color:#64748b;margin-bottom:16px;}' +
    '.info{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:16px;}.info div{background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #e2e8f0;}.info .lbl{font-size:10px;color:#64748b;}.info .val{font-weight:700;}' +
    'table{width:100%;border-collapse:collapse;margin:12px 0;}th,td{border:1px solid #ddd;padding:8px;text-align:right;}th{background:#f1f5f9;font-weight:700;}' +
    '.sig{display:flex;justify-content:space-around;margin-top:40px;}.sig div{text-align:center;}.sig .line{width:120px;border-bottom:1px solid #94a3b8;padding-top:40px;margin:0 auto;}.sig .cap{font-size:11px;color:#64748b;margin-top:4px;}' +
    '@media print{body{padding:10px;}}</style></head><body>' +
    '<h2>' + company + '</h2><h3>قيد يومية — ' + (j.journalNumber||'') + '</h3>' +
    '<div class="info">' +
      '<div><div class="lbl">رقم القيد</div><div class="val">' + (j.journalNumber||'') + '</div></div>' +
      '<div><div class="lbl">التاريخ</div><div class="val">' + dt + '</div></div>' +
      '<div><div class="lbl">الحالة</div><div class="val">' + (statusLabels[j.status]||j.status) + '</div></div>' +
      '<div><div class="lbl">أنشأه</div><div class="val">' + (j.createdBy||'') + '</div></div>' +
      (j.approvedBy ? '<div><div class="lbl">اعتمده</div><div class="val">' + j.approvedBy + '</div></div>' : '') +
      (j.postedBy ? '<div><div class="lbl">رحّله</div><div class="val">' + j.postedBy + '</div></div>' : '') +
    '</div>' +
    (j.description ? '<p style="margin-bottom:12px;font-weight:700;background:#eff6ff;padding:8px 12px;border-radius:8px;">' + j.description + '</p>' : '') +
    '<table><thead><tr><th>رقم الحساب</th><th>اسم الحساب</th><th>البيان</th><th>مدين</th><th>دائن</th></tr></thead><tbody>' + rows +
    '<tr style="background:#f1f5f9;font-weight:900;"><td colspan="3">الإجمالي</td><td>' + (j.totalDebit||0).toFixed(2) + '</td><td>' + (j.totalCredit||0).toFixed(2) + '</td></tr>' +
    '</tbody></table>' +
    '<div class="sig"><div><div class="line"></div><div class="cap">المحاسب</div></div><div><div class="line"></div><div class="cap">المدير المالي</div></div><div><div class="line"></div><div class="cap">المدير العام</div></div></div>' +
    '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
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

// ─── Journal creation — full page form ───
var _jrnLineCounter = 0;
var _jrnCostCenters = [];
var _jrnSelectedType = 'GL';
var _jrnTypes = [{code:'GL',name:'يومية عامة'},{code:'OB',name:'افتتاحية'},{code:'RENT',name:'إدارة التأجير'}];

function erpOpenJournalModal() {
  _jrnLineCounter = 0;
  _jrnSelectedType = 'GL';
  // Load cost centers
  window._apiBridge.withSuccessHandler(function(ccs) { _jrnCostCenters = ccs || []; }).getCostCenters();
  if (_erpAccounts.length === 0) {
    loader(true);
    window._apiBridge.withSuccessHandler(function(list) {
      loader(false);
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
  var typeName = (_jrnTypes.find(function(t){return t.code===_jrnSelectedType;})||{}).name || 'يومية عامة';

  // Save original list HTML so we can restore it
  var section = document.getElementById('erpGLJournals');
  if (!_jrnListHTML) _jrnListHTML = section.innerHTML;
  section.innerHTML =
    '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:0;margin:10px 0;">' +
      // Title bar
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:2px solid #0ea5e9;background:#f8fafc;border-radius:12px 12px 0 0;">' +
        '<h3 style="margin:0;font-size:16px;color:#0f172a;"><i class="fas fa-file-invoice" style="color:#0ea5e9;margin-left:8px;"></i> القيود اليومية العامة</h3>' +
        '<button onclick="erpLoadJournals()" style="padding:6px 16px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;font-size:13px;font-weight:700;color:#64748b;"><i class="fas fa-arrow-right" style="margin-left:4px;"></i> رجوع للقائمة</button>' +
      '</div>' +
      // Header fields
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:12px;padding:16px 20px;background:#f1f5f9;border-bottom:1px solid #e5e7eb;">' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">رقم الحركة *</label><input class="form-control" id="erpJrnNum" placeholder="تلقائي" readonly style="background:#e2e8f0;color:#94a3b8;"></div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">التاريخ *</label><input type="date" class="form-control" id="erpJrnDate" value="' + today + '"></div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">اليومية *</label><div style="display:flex;gap:4px;"><input class="form-control" id="erpJrnTypeName" value="' + typeName + '" readonly style="background:#e0f2fe;color:#0369a1;font-weight:700;cursor:pointer;" onclick="erpOpenJrnTypePicker()"><button onclick="erpOpenJrnTypePicker()" style="padding:6px 10px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;"><i class="fas fa-pen"></i></button></div></div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">النظام</label><input class="form-control" value="الحسابات العامة" readonly style="background:#f8fafc;color:#64748b;"></div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">نوع الحركة</label><select class="form-control" id="erpJrnMovType"><option value="general">عام</option><option value="opening">افتتاحي</option><option value="closing">إقفال</option><option value="adjustment">تسوية</option></select></div>' +
      '</div>' +
      // Description fields
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 20px;border-bottom:1px solid #e5e7eb;">' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">الوصف * (عربي)</label><input class="form-control" id="erpJrnDesc" placeholder="وصف القيد بالعربي..."></div>' +
        '<div><label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px;">الوصف * (إنجليزي)</label><input class="form-control" id="erpJrnDescEn" placeholder="Description in English..."></div>' +
      '</div>' +
      // Toolbar
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid #e5e7eb;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span style="font-size:14px;font-weight:800;color:#1e293b;">تفاصيل القيد اليومي</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button onclick="erpAddJrnLine()" style="width:30px;height:30px;border-radius:50%;border:none;background:#0ea5e9;color:#fff;cursor:pointer;font-size:14px;" title="إضافة سطر"><i class="fas fa-plus"></i></button>' +
          '<label for="erpExcelUpload" style="width:30px;height:30px;border-radius:50%;border:1px solid #e5e7eb;background:#fff;color:#16a34a;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;" title="استيراد من Excel"><i class="fas fa-file-excel"></i></label>' +
          '<input type="file" id="erpExcelUpload" accept=".xlsx,.xls,.csv" onchange="erpImportExcel(this)" style="display:none;">' +
        '</div>' +
      '</div>' +
      // Table
      '<div style="overflow-x:auto;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px;" id="erpJrnTable">' +
          '<thead><tr style="background:#f8fafc;border-bottom:2px solid #e5e7eb;">' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;white-space:nowrap;">رقم الحساب</th>' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;white-space:nowrap;">اسم الحساب</th>' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;white-space:nowrap;width:120px;">مدين</th>' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;white-space:nowrap;width:120px;">دائن</th>' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;">الوصف</th>' +
            '<th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569;white-space:nowrap;">مركز التكلفة</th>' +
            '<th style="padding:10px 4px;text-align:center;font-weight:700;color:#475569;width:50px;">خيارات</th>' +
          '</tr></thead>' +
          '<tbody id="erpJrnLines"></tbody>' +
          '<tfoot><tr style="background:#f1f5f9;border-top:2px solid #cbd5e1;">' +
            '<td colspan="2" style="padding:10px 8px;font-weight:800;color:#1e293b;">مجموع</td>' +
            '<td style="padding:10px 8px;"><input class="form-control" id="erpJrnTotalD" readonly style="background:#ecfdf5;color:#166534;font-weight:900;text-align:center;border:none;" value="0.00"></td>' +
            '<td style="padding:10px 8px;"><input class="form-control" id="erpJrnTotalC" readonly style="background:#fef2f2;color:#991b1b;font-weight:900;text-align:center;border:none;" value="0.00"></td>' +
            '<td style="padding:10px 8px;font-weight:700;color:#64748b;">الفرق</td>' +
            '<td style="padding:10px 8px;"><input class="form-control" id="erpJrnDiff" readonly style="font-weight:900;text-align:center;border:none;" value="0.00"></td>' +
            '<td></td>' +
          '</tr></tfoot>' +
        '</table>' +
      '</div>' +
      // Paste hint
      '<div style="padding:8px 20px;background:#fffbeb;border-top:1px solid #fde68a;font-size:11px;color:#92400e;">' +
        '<i class="fas fa-lightbulb" style="margin-left:4px;"></i> نسخ من Excel: حدد الأعمدة (رقم الحساب | مدين | دائن | الوصف) ثم الصق هنا بـ Ctrl+V' +
      '</div>' +
      // Action buttons
      '<div style="display:flex;align-items:center;gap:8px;padding:16px 20px;border-top:1px solid #e5e7eb;background:#f8fafc;border-radius:0 0 12px 12px;">' +
        '<button onclick="erpSaveJournal(false)" style="padding:10px 28px;border-radius:8px;border:none;background:#1e40af;color:#fff;font-weight:800;font-size:14px;cursor:pointer;"><i class="fas fa-save" style="margin-left:6px;"></i> حفظ</button>' +
        '<button onclick="erpSaveJournal(true)" style="padding:10px 20px;border-radius:8px;border:2px solid #1e40af;background:#fff;color:#1e40af;font-weight:800;font-size:14px;cursor:pointer;"><i class="fas fa-plus" style="margin-left:6px;"></i> حفظ و جديد</button>' +
        '<button onclick="erpSaveAndPost()" style="padding:10px 20px;border-radius:8px;border:none;background:#ef4444;color:#fff;font-weight:800;font-size:14px;cursor:pointer;"><i class="fas fa-check-double" style="margin-left:6px;"></i> حفظ وترحيل</button>' +
        '<button onclick="erpLoadJournals()" style="padding:10px 20px;border-radius:8px;border:2px solid #e5e7eb;background:#fff;color:#475569;font-weight:800;font-size:14px;cursor:pointer;">إلغاء</button>' +
      '</div>' +
    '</div>';

  // Add 2 initial lines
  erpAddJrnLine();
  erpAddJrnLine();

  // Setup paste listener on the whole section (catches Ctrl+V anywhere in the form)
  var section = document.getElementById('erpGLJournals');
  if (section) section.addEventListener('paste', erpPasteFromExcel);
}

function erpAddJrnLine(prefill) {
  _jrnLineCounter++;
  var lineId = 'jln' + _jrnLineCounter;
  var tr = document.createElement('tr');
  tr.id = lineId;
  tr.style.borderBottom = '1px solid #f1f5f9';
  var p = prefill || {};
  tr.innerHTML =
    '<td style="padding:6px 4px;position:relative;">' +
      '<input type="text" class="form-control jec-code" placeholder="رقم أو اسم..." value="' + (p.code||'') + '" style="font-size:13px;padding:8px;" oninput="erpSearchAccount(this)" onfocus="erpSearchAccount(this)">' +
      '<input type="hidden" class="jec-acc-id" value="' + (p.id||'') + '">' +
      '<div class="jec-dropdown" style="display:none;position:absolute;top:100%;right:0;left:0;z-index:100;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);"></div>' +
    '</td>' +
    '<td style="padding:6px 4px;position:relative;"><input type="text" class="form-control jec-acc-name" placeholder="ابحث بالاسم..." value="' + (p.name||'') + '" style="font-size:13px;padding:8px;" oninput="erpSearchAccountByName(this)" onfocus="erpSearchAccountByName(this)"><div class="jec-dropdown-name" style="display:none;position:absolute;top:100%;right:0;left:0;z-index:100;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);"></div></td>' +
    '<td style="padding:6px 4px;"><input type="number" class="form-control jec-debit" step="0.01" min="0" placeholder="0" value="' + (p.debit||'') + '" style="font-size:13px;padding:8px;text-align:center;" oninput="erpCalcJrnBalance()"></td>' +
    '<td style="padding:6px 4px;"><input type="number" class="form-control jec-credit" step="0.01" min="0" placeholder="0" value="' + (p.credit||'') + '" style="font-size:13px;padding:8px;text-align:center;" oninput="erpCalcJrnBalance()"></td>' +
    '<td style="padding:6px 4px;"><input type="text" class="form-control jec-desc" placeholder="" value="' + (p.desc||'') + '" style="font-size:13px;padding:8px;"></td>' +
    '<td style="padding:6px 4px;"><select class="form-control jec-cc" style="font-size:12px;padding:6px;"><option value="">—</option>' + _jrnCostCenters.map(function(c){return '<option value="'+c.id+'" data-name="'+(c.name||'')+'">'+c.code+' — '+(c.name||'')+'</option>';}).join('') + '</select></td>' +
    '<td style="padding:6px 4px;text-align:center;"><button style="width:28px;height:28px;border-radius:6px;border:1px solid #fecaca;background:#fee2e2;color:#ef4444;cursor:pointer;font-size:11px;" onclick="erpRemoveJrnLine(\'' + lineId + '\')" title="حذف"><i class="fas fa-trash"></i></button></td>';
  document.getElementById('erpJrnLines').appendChild(tr);

  // Auto-match account if prefilled
  if (p.code && !p.id) _matchAccountByCode(tr, p.code);
}

function _matchAccountByCode(tr, code) {
  var leafs = _getLeafAccounts();
  var codeTrim = (code+'').trim();
  var match = leafs.find(function(a) { return a.code === codeTrim; }) ||
              leafs.find(function(a) { return (a.nameAr||'').indexOf(codeTrim) !== -1; }) ||
              leafs.find(function(a) { return (a.code||'').indexOf(codeTrim) !== -1; });
  if (match) {
    tr.querySelector('.jec-acc-id').value = match.id;
    tr.querySelector('.jec-acc-name').value = match.nameAr || '';
    tr.querySelector('.jec-code').value = match.code;
    tr.querySelector('.jec-code').style.color = '#166534';
  } else {
    tr.querySelector('.jec-code').style.color = '#dc2626';
  }
}

window.erpRemoveJrnLine = function(lineId) {
  var el = document.getElementById(lineId);
  if (el) el.remove();
  erpCalcJrnBalance();
};

// Account search dropdown for table rows
window.erpSearchAccount = function(input) {
  var val = input.value.toLowerCase().trim();
  var dd = input.parentElement.querySelector('.jec-dropdown');
  if (!val || val.length < 1) { dd.style.display = 'none'; return; }
  var leafs = _getLeafAccounts();
  var matches = leafs.filter(function(a) {
    return (a.code||'').indexOf(val) !== -1 || (a.nameAr||'').toLowerCase().indexOf(val) !== -1 || (a.nameEn||'').toLowerCase().indexOf(val) !== -1;
  }).slice(0, 10);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(function(a) {
    return '<div style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;" onmousedown="erpPickAccount(this,\'' + a.id + '\',\'' + a.code + '\',\'' + (a.nameAr||'').replace(/'/g,'') + '\')">' +
      '<span style="font-weight:700;color:#0f172a;">' + a.code + '</span><span style="color:#64748b;">' + (a.nameAr||'') + '</span></div>';
  }).join('');
  dd.style.display = 'block';
};

window.erpPickAccount = function(el, id, code, name) {
  var tr = el.closest('tr');
  tr.querySelector('.jec-acc-id').value = id;
  tr.querySelector('.jec-code').value = code;
  tr.querySelector('.jec-code').style.color = '#166534';
  tr.querySelector('.jec-acc-name').value = name;
  tr.querySelector('.jec-dropdown').style.display = 'none';
  var dd2 = tr.querySelector('.jec-dropdown-name'); if (dd2) dd2.style.display = 'none';
};

// Search by account NAME (اسم الحساب column)
window.erpSearchAccountByName = function(input) {
  var val = input.value.toLowerCase().trim();
  var dd = input.parentElement.querySelector('.jec-dropdown-name');
  if (!val || val.length < 1) { dd.style.display = 'none'; return; }
  var leafs = _getLeafAccounts();
  var matches = leafs.filter(function(a) {
    return (a.nameAr||'').toLowerCase().indexOf(val) !== -1 || (a.nameEn||'').toLowerCase().indexOf(val) !== -1 || (a.code||'').indexOf(val) !== -1;
  }).slice(0, 10);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(function(a) {
    return '<div style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;" onmousedown="erpPickAccount(this,\'' + a.id + '\',\'' + a.code + '\',\'' + (a.nameAr||'').replace(/'/g,'') + '\')">' +
      '<span style="color:#64748b;">' + (a.nameAr||'') + '</span><span style="font-weight:700;color:#0f172a;">' + a.code + '</span></div>';
  }).join('');
  dd.style.display = 'block';
};

// Close dropdowns on click outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.jec-dropdown') && !e.target.closest('.jec-dropdown-name') && !e.target.classList.contains('jec-code') && !e.target.classList.contains('jec-acc-name')) {
    document.querySelectorAll('.jec-dropdown, .jec-dropdown-name').forEach(function(d) { d.style.display = 'none'; });
  }
});

function erpCalcJrnBalance() {
  var totalD = 0, totalC = 0;
  document.querySelectorAll('#erpJrnLines .jec-debit').forEach(function(el) { totalD += Number(el.value) || 0; });
  document.querySelectorAll('#erpJrnLines .jec-credit').forEach(function(el) { totalC += Number(el.value) || 0; });
  var diff = Math.abs(totalD - totalC);
  var dEl = document.getElementById('erpJrnTotalD'); if (dEl) dEl.value = totalD.toFixed(2);
  var cEl = document.getElementById('erpJrnTotalC'); if (cEl) cEl.value = totalC.toFixed(2);
  var diffEl = document.getElementById('erpJrnDiff');
  if (diffEl) {
    diffEl.value = diff.toFixed(2);
    diffEl.style.background = diff < 0.01 ? '#dcfce7' : '#fee2e2';
    diffEl.style.color = diff < 0.01 ? '#166534' : '#991b1b';
  }
}

function _gatherJrnEntries() {
  var rows = document.querySelectorAll('#erpJrnLines tr');
  var entries = [];
  rows.forEach(function(row) {
    var accId = row.querySelector('.jec-acc-id');
    if (!accId || !accId.value) return;
    var debit = Number(row.querySelector('.jec-debit').value) || 0;
    var credit = Number(row.querySelector('.jec-credit').value) || 0;
    var desc = row.querySelector('.jec-desc') ? row.querySelector('.jec-desc').value : '';
    var code = row.querySelector('.jec-code') ? row.querySelector('.jec-code').value : '';
    var name = row.querySelector('.jec-acc-name') ? row.querySelector('.jec-acc-name').value : '';
    if (debit > 0 || credit > 0) {
      var ccSel = row.querySelector('.jec-cc');
      var ccId = ccSel ? ccSel.value : '';
      var ccName = ccSel && ccSel.value ? (ccSel.options[ccSel.selectedIndex].getAttribute('data-name')||'') : '';
      entries.push({ accountId: accId.value, accountCode: code, accountName: name, debit: debit, credit: credit, description: desc, costCenterId: ccId, costCenterName: ccName });
    }
  });
  return entries;
}

function erpSaveJournal(andNew) {
  var entries = _gatherJrnEntries();
  if (entries.length < 2) return showToast('يجب إدخال بندين على الأقل', true);
  var desc = document.getElementById('erpJrnDesc').value;
  if (!desc) return showToast('الوصف مطلوب', true);

  var totalD = 0, totalC = 0;
  entries.forEach(function(e) { totalD += e.debit; totalC += e.credit; });
  if (Math.abs(totalD - totalC) > 0.01) return showToast('القيد غير متوازن — فرق: ' + Math.abs(totalD - totalC).toFixed(2), true);

  var movType = (document.getElementById('erpJrnMovType')||{}).value || 'general';
  var isOpening = _jrnSelectedType === 'OB' || movType === 'opening';

  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) {
      showToast('تم إنشاء القيد: ' + res.journalNumber);
      if (andNew) { _jrnLineCounter = 0; _renderJournalForm(); }
      else erpLoadJournals();
    } else showToast(res.error, true);
  }).createJournalEntry({
    journalDate: document.getElementById('erpJrnDate').value,
    referenceType: isOpening ? 'opening' : 'manual',
    referenceId: '',
    description: desc,
    notes: (document.getElementById('erpJrnDescEn')||{}).value || '',
    attachment: window._jrnAttachmentData || '',
    isOpening: isOpening,
    entries: entries
  }, currentUser);
}

function erpSaveAndPost() {
  var entries = _gatherJrnEntries();
  if (entries.length < 2) return showToast('يجب إدخال بندين على الأقل', true);
  var desc = document.getElementById('erpJrnDesc').value;
  if (!desc) return showToast('الوصف مطلوب', true);
  var totalD = 0, totalC = 0;
  entries.forEach(function(e) { totalD += e.debit; totalC += e.credit; });
  if (Math.abs(totalD - totalC) > 0.01) return showToast('القيد غير متوازن', true);
  var movType = (document.getElementById('erpJrnMovType')||{}).value || 'general';
  var isOpening = _jrnSelectedType === 'OB' || movType === 'opening';

  erpConfirm('حفظ وترحيل', 'سيتم حفظ القيد وترحيله مباشرة وتحديث أرصدة الحسابات.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(res) {
      if (!res.success) { loader(false); return showToast(res.error, true); }
      window._apiBridge.withSuccessHandler(function() {
        window._apiBridge.withSuccessHandler(function() {
          loader(false);
          showToast('تم حفظ وترحيل القيد: ' + res.journalNumber);
          erpLoadJournals();
        }).postGLJournal(res.id, currentUser);
      }).approveGLJournal(res.id, currentUser);
    }).createJournalEntry({
    journalDate: document.getElementById('erpJrnDate').value,
    referenceType: isOpening ? 'opening' : 'manual',
    description: desc,
    notes: (document.getElementById('erpJrnDescEn')||{}).value || '',
    isOpening: isOpening,
    entries: entries
  }, currentUser);
  }, {icon:'fa-check-double', color:'#ef4444', okText:'حفظ وترحيل'});
}

// ─── Attachment handler ───
window._jrnAttachmentData = '';
window.erpPickAttachment = function(input) {
  var f = input.files[0]; if (!f) return;
  var isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
  var r = new FileReader();
  r.onload = function(ev) {
    if (isPdf) {
      window._jrnAttachmentData = ev.target.result;
      document.getElementById('jrnAttachPrev').innerHTML = '<div style="padding:8px;background:#f1f5f9;border-radius:8px;text-align:center;font-size:12px;"><i class="fas fa-file-pdf" style="color:#ef4444;font-size:20px;"></i><br>' + f.name + '</div>';
    } else {
      var img = new Image();
      img.onload = function() {
        var c = document.createElement('canvas'), mx = 1200, w = img.width, h = img.height;
        if (w > mx || h > mx) { var sc = Math.min(mx/w, mx/h); w *= sc; h *= sc; }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        window._jrnAttachmentData = c.toDataURL('image/jpeg', 0.82);
        document.getElementById('jrnAttachPrev').innerHTML = '<img src="' + window._jrnAttachmentData + '" style="max-width:120px;max-height:80px;border-radius:8px;border:1px solid #e2e8f0;">';
      };
      img.src = ev.target.result;
    }
  };
  r.readAsDataURL(f);
};

// ─── Excel Paste (Ctrl+V) ───
function erpPasteFromExcel(e) {
  var text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text || text.indexOf('\t') === -1) return; // Not tabular data
  e.preventDefault();
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  if (!lines.length) return;
  // Clear existing empty rows
  var tbody = document.getElementById('erpJrnLines');
  var existingRows = tbody.querySelectorAll('tr');
  var hasData = false;
  existingRows.forEach(function(r) {
    var d = Number(r.querySelector('.jec-debit').value)||0;
    var c = Number(r.querySelector('.jec-credit').value)||0;
    if (d > 0 || c > 0) hasData = true;
  });
  if (!hasData) { tbody.innerHTML = ''; _jrnLineCounter = 0; }
  var added = 0;
  lines.forEach(function(line) {
    var cols = line.split('\t').map(function(c) { return c.trim(); });
    if (cols.length < 2) return;
    // Smart column detection:
    // Could be: code|debit|credit|desc  OR  code|name|debit|credit|desc
    var code = cols[0] || '';
    var debit = '', credit = '', desc = '', name = '';
    // Check if cols[1] is a number — if not, it's the account name
    var col1IsNum = !isNaN(parseFloat((cols[1]||'').replace(/[^0-9.\-]/g,''))) && (cols[1]||'').replace(/[^0-9.\-\s]/g,'').trim() !== '';
    if (col1IsNum) {
      // Format: code | debit | credit | desc
      debit = cols[1] || ''; credit = cols[2] || ''; desc = cols[3] || '';
    } else {
      // Format: code | name | debit | credit | desc
      name = cols[1] || ''; debit = cols[2] || ''; credit = cols[3] || ''; desc = cols[4] || '';
    }
    debit = parseFloat((debit+'').replace(/[^0-9.\-]/g,'')) || '';
    credit = parseFloat((credit+'').replace(/[^0-9.\-]/g,'')) || '';
    erpAddJrnLine({ code: code, name: name, debit: debit, credit: credit, desc: desc });
    added++;
  });
  erpCalcJrnBalance();
  showToast('تم لصق ' + added + ' سطر من Excel');
}

// ─── Excel File Import ───
window.erpImportExcel = function(input) {
  var f = input.files[0]; if (!f) return;
  var ext = f.name.split('.').pop().toLowerCase();
  if (ext === 'csv') {
    var reader = new FileReader();
    reader.onload = function(e) { _parseExcelData(e.target.result, 'csv'); };
    reader.readAsText(f);
  } else {
    // Load SheetJS from CDN if not available
    if (typeof XLSX === 'undefined') {
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js';
      s.onload = function() { _readXlsx(f); };
      document.head.appendChild(s);
    } else { _readXlsx(f); }
  }
  input.value = '';
};

function _readXlsx(f) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var wb = XLSX.read(e.target.result, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var csv = XLSX.utils.sheet_to_csv(ws);
    _parseExcelData(csv, 'csv');
  };
  reader.readAsArrayBuffer(f);
}

function _parseExcelData(text, type) {
  var sep = type === 'csv' ? ',' : '\t';
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  if (!lines.length) return showToast('ملف فارغ', true);
  // Skip header row if first cell looks like a header
  var first = lines[0].split(sep)[0].trim().toLowerCase();
  if (first === 'account' || first === 'رقم الحساب' || first === 'الحساب' || first === 'code') lines.shift();
  var tbody = document.getElementById('erpJrnLines');
  tbody.innerHTML = ''; _jrnLineCounter = 0;
  var added = 0;
  lines.forEach(function(line) {
    var cols = line.split(sep).map(function(c) { return c.trim().replace(/^"|"$/g, ''); });
    if (cols.length < 2) return;
    var code = cols[0]||'';
    var col1IsNum = !isNaN(parseFloat((cols[1]||'').replace(/[^0-9.\-]/g,''))) && (cols[1]||'').replace(/[^0-9.\-\s]/g,'').trim() !== '';
    var debit, credit, desc, name = '';
    if (col1IsNum) { debit = cols[1]||''; credit = cols[2]||''; desc = cols[3]||''; }
    else { name = cols[1]||''; debit = cols[2]||''; credit = cols[3]||''; desc = cols[4]||''; }
    debit = parseFloat((debit+'').replace(/[^0-9.\-]/g,'')) || '';
    credit = parseFloat((credit+'').replace(/[^0-9.\-]/g,'')) || '';
    erpAddJrnLine({ code: code, name: name, debit: debit, credit: credit, desc: desc });
    added++;
  });
  erpCalcJrnBalance();
  showToast('تم استيراد ' + added + ' سطر من الملف');
}

// ─── Journal Type Picker ───
window.erpOpenJrnTypePicker = function() {
  var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:6000;display:flex;align-items:center;justify-content:center;" id="jrnTypePicker" onclick="if(event.target===this)this.remove()">' +
    '<div style="background:#fff;border-radius:16px;padding:24px;width:400px;max-width:90%;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:16px;"><h3 style="margin:0;">فضلا اختر يومية</h3><button onclick="document.getElementById(\'jrnTypePicker\').remove()" style="border:none;background:none;font-size:18px;cursor:pointer;">&times;</button></div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr style="border-bottom:2px solid #e5e7eb;"><th style="padding:10px;text-align:right;">تعريف</th><th style="padding:10px;text-align:right;">الإسم</th></tr></thead>' +
        '<tbody>' + _jrnTypes.map(function(t) {
          return '<tr style="border-bottom:1px solid #f1f5f9;cursor:pointer;" onclick="erpSelectJrnType(\'' + t.code + '\',\'' + t.name + '\')" onmouseover="this.style.background=\'#f1f5f9\'" onmouseout="this.style.background=\'\'">' +
            '<td style="padding:12px;font-weight:700;">' + t.code + '</td><td style="padding:12px;">' + t.name + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
    '</div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
};

window.erpSelectJrnType = function(code, name) {
  _jrnSelectedType = code;
  var el = document.getElementById('erpJrnTypeName'); if (el) el.value = name;
  var picker = document.getElementById('jrnTypePicker'); if (picker) picker.remove();
  // Auto-set movement type for opening
  if (code === 'OB') {
    var mov = document.getElementById('erpJrnMovType'); if (mov) mov.value = 'opening';
  }
};

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
        '<button class="btn btn-sm btn-danger" title="حذف" onclick="erpDeletePO(\'' + po.id + '\',\'' + safeNum + '\')"><i class="fas fa-trash"></i></button>' +
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
// FINANCIAL REPORTS — Professional
// ═══════════════════════════════════════
var _finCurrentTab = 'trial';

// Back to reports hub
window.erpBackToReportsHub = function() {
  var hub = document.getElementById('finReportsHub');
  var filters = document.getElementById('finFilters');
  var content = document.getElementById('erpFinReportContent');
  if (hub) hub.style.display = '';
  if (filters) filters.style.display = 'none';
  if (content) content.innerHTML = '';
};

function erpShowFinReport(type, btn) {
  _finCurrentTab = type;

  // Hide hub, show filters + content
  var hub = document.getElementById('finReportsHub');
  var filtersEl = document.getElementById('finFilters');
  if (hub) hub.style.display = 'none';
  if (filtersEl) filtersEl.style.display = 'flex';

  erpApplyFinFilters();
}

function erpApplyFinFilters() {
  var container = document.getElementById('erpFinReportContent');
  container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-spinner fa-spin" style="font-size:24px;"></i><p style="margin-top:10px;">جاري التحميل...</p></div>';

  var filters = {};
  var s = document.getElementById('finStartDate');
  var e = document.getElementById('finEndDate');
  var t = document.getElementById('finAccType');
  var c = document.getElementById('finCreatedBy');
  if (s && s.value) filters.startDate = s.value;
  if (e && e.value) filters.endDate = e.value;
  if (t && t.value) filters.accountType = t.value;
  if (c && c.value) filters.createdBy = c.value;

  if (_finCurrentTab === 'trial') _renderTrialBalance(container, filters);
  else if (_finCurrentTab === 'income') _renderIncomeStatement(container);
  else if (_finCurrentTab === 'balance') _renderBalanceSheet(container);
  else if (_finCurrentTab === 'pnl') _renderIncomeStatement(container); // P&L = Income Statement
  else if (_finCurrentTab === 'cashflow') _renderCashFlow(container);
  else if (_finCurrentTab === 'assets') _renderAssetsReport(container);
}

// Cash Flow Report (التدفقات النقدية)
function _renderCashFlow(container) {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  // Cash flow = movements in cash/bank accounts (111xx)
  window._apiBridge.withSuccessHandler(function(data) {
    var rows = (data.rows || []).filter(function(r) { return r.code && r.code.indexOf('111') === 0; });
    var html = '<h3 style="color:#06b6d4;margin-bottom:12px;"><i class="fas fa-exchange-alt" style="margin-left:6px;"></i> تقرير التدفقات النقدية</h3>';
    html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">الحساب</th><th>رصيد أول</th><th>تدفقات داخلة</th><th>تدفقات خارجة</th><th>الرصيد النهائي</th></tr></thead><tbody>';
    var totOpen = 0, totIn = 0, totOut = 0, totClose = 0;
    rows.forEach(function(r) {
      var openBal = (r.openDebit||0) - (r.openCredit||0);
      var closeBal = (r.closeDebit||0) - (r.closeCredit||0);
      totOpen += openBal; totIn += r.periodDebit||0; totOut += r.periodCredit||0; totClose += closeBal;
      html += '<tr><td style="font-weight:700;padding:8px 14px;">' + r.nameAR + ' <code style="color:#94a3b8;">' + r.code + '</code></td>' +
        '<td style="text-align:start;">' + fmt(openBal) + '</td><td style="text-align:start;color:#16a34a;">' + fmt(r.periodDebit) + '</td>' +
        '<td style="text-align:start;color:#ef4444;">' + fmt(r.periodCredit) + '</td><td style="text-align:start;font-weight:800;">' + fmt(closeBal) + '</td></tr>';
    });
    html += '<tr style="background:#0f172a;color:#fff;font-weight:900;"><td style="padding:10px 14px;">الإجمالي</td><td style="text-align:start;">' + fmt(totOpen) + '</td><td style="text-align:start;">' + fmt(totIn) + '</td><td style="text-align:start;">' + fmt(totOut) + '</td><td style="text-align:start;">' + fmt(totClose) + '</td></tr>';
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }).getTrialBalance({});
}

// Assets Report (تقرير الأصول)
function _renderAssetsReport(container) {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  window._apiBridge.withSuccessHandler(function(data) {
    var rows = (data.rows || []).filter(function(r) { return r.type === 'asset'; });
    var html = '<h3 style="color:#8b5cf6;margin-bottom:12px;"><i class="fas fa-building" style="margin-left:6px;"></i> تقرير الأصول</h3>';
    html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">الرمز</th><th>اسم الحساب</th><th>رصيد أول مدين</th><th>رصيد أول دائن</th><th>حركة مدين</th><th>حركة دائن</th><th>رصيد نهائي مدين</th><th>رصيد نهائي دائن</th></tr></thead><tbody>';
    var tot = {od:0,oc:0,pd:0,pc:0,cd:0,cc:0};
    rows.forEach(function(r) {
      tot.od+=r.openDebit||0; tot.oc+=r.openCredit||0; tot.pd+=r.periodDebit||0; tot.pc+=r.periodCredit||0; tot.cd+=r.closeDebit||0; tot.cc+=r.closeCredit||0;
      var indent = ((r.level||1)-1)*14;
      html += '<tr><td style="padding:8px 14px;"><code>' + r.code + '</code></td><td style="padding-right:' + indent + 'px;font-weight:' + (r.level<=2?'800':'400') + ';">' + r.nameAR + '</td>' +
        '<td style="text-align:start;">' + fmt(r.openDebit) + '</td><td style="text-align:start;">' + fmt(r.openCredit) + '</td>' +
        '<td style="text-align:start;">' + fmt(r.periodDebit) + '</td><td style="text-align:start;">' + fmt(r.periodCredit) + '</td>' +
        '<td style="text-align:start;font-weight:700;">' + fmt(r.closeDebit) + '</td><td style="text-align:start;font-weight:700;">' + fmt(r.closeCredit) + '</td></tr>';
    });
    html += '<tr style="background:#0f172a;color:#fff;font-weight:900;"><td colspan="2" style="padding:10px 14px;">الإجمالي</td>' +
      '<td style="text-align:start;">' + fmt(tot.od) + '</td><td style="text-align:start;">' + fmt(tot.oc) + '</td>' +
      '<td style="text-align:start;">' + fmt(tot.pd) + '</td><td style="text-align:start;">' + fmt(tot.pc) + '</td>' +
      '<td style="text-align:start;">' + fmt(tot.cd) + '</td><td style="text-align:start;">' + fmt(tot.cc) + '</td></tr>';
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }).getTrialBalance({accountType: 'asset'});
}

function _renderTrialBalance(container, filters) {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var typeLabels = {asset:'أصول',liability:'التزامات',equity:'حقوق ملكية',revenue:'إيرادات',expense:'مصروفات'};
  var typeIcons = {asset:'fa-coins',liability:'fa-hand-holding-usd',equity:'fa-gem',revenue:'fa-chart-line',expense:'fa-receipt'};
  var typeBg = {asset:'#dbeafe',liability:'#fee2e2',equity:'#f3e8ff',revenue:'#dcfce7',expense:'#fef3c7'};
  var typeFg = {asset:'#1e40af',liability:'#991b1b',equity:'#7c3aed',revenue:'#166534',expense:'#92400e'};

  window._apiBridge.withSuccessHandler(function(data) {
    var rows = data.rows || [];
    var tot = data.totals || {};

    // Toolbar: status + actions
    var statusBg = data.isBalanced ? '#dcfce7' : '#fee2e2';
    var statusFg = data.isBalanced ? '#166534' : '#991b1b';
    var html = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;">';
    html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;font-weight:800;font-size:13px;background:' + statusBg + ';color:' + statusFg + ';"><i class="fas ' + (data.isBalanced?'fa-check-circle':'fa-exclamation-triangle') + '"></i> ' + (data.isBalanced?'الميزان متوازن':'الميزان غير متوازن!') + '</div>';
    html += '<div style="display:flex;gap:6px;">';
    html += '<button class="btn btn-sm btn-secondary" onclick="erpPrintFinReport()" style="border-radius:10px;"><i class="fas fa-print"></i> طباعة</button>';
    html += '<button class="btn btn-sm btn-secondary" onclick="erpExportTrialBalance()" style="border-radius:10px;"><i class="fas fa-file-excel"></i> تصدير Excel</button>';
    html += '<button class="btn btn-sm" onclick="erpRepairGL()" style="border-radius:10px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;" title="إصلاح القيود المعلقة"><i class="fas fa-wrench"></i> إصلاح</button>';
    html += '</div></div>';

    if (filters.startDate || filters.endDate) {
      html += '<div style="padding:8px 14px;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:12px;font-weight:700;margin-bottom:12px;display:inline-block;"><i class="fas fa-calendar-alt" style="margin-left:4px;"></i> الفترة: ' + (filters.startDate||'البداية') + ' → ' + (filters.endDate||'الآن') + '</div>';
    }

    // Toggle: show leaf accounts only
    var leafOnly = window._tbLeafOnly || false;
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">';
    html += '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:700;color:#334155;"><input type="checkbox" id="tbLeafToggle" ' + (leafOnly?'checked':'') + ' onchange="window._tbLeafOnly=this.checked;erpApplyFinFilters();" style="width:16px;height:16px;accent-color:#1e40af;"> عرض الحسابات الفرعية فقط</label>';
    html += '<span style="font-size:11px;color:#94a3b8;"><i class="fas fa-info-circle"></i> الحسابات الرئيسية (المجاميع) تظهر باللون الأزرق</span>';
    html += '</div>';

    // Determine which accounts are parents (have children)
    // Build a set of all parentId values — any account whose code appears as another's parent is a "parent account"
    var parentIds = {};
    rows.forEach(function(r) { if (r.parentId) parentIds[r.parentId] = true; });
    // Map code→id so we can check if a row's code is someone's parent
    var parentCodes = {};
    rows.forEach(function(r) { if (parentIds[r.code]) parentCodes[r.code] = true; });

    // Table
    html += '<div id="trialBalanceTable" style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#0f172a;color:#fff;">' +
      '<th rowspan="2" style="padding:10px 12px;border:1px solid #1e293b;width:80px;text-align:center;">الرمز</th>' +
      '<th rowspan="2" style="padding:10px 12px;border:1px solid #1e293b;">اسم الحساب</th>' +
      '<th colspan="2" style="padding:8px;border:1px solid #1e293b;text-align:center;background:#1e3a5f;">رصيد أول المدة</th>' +
      '<th colspan="2" style="padding:8px;border:1px solid #1e293b;text-align:center;background:#4c1d95;">حركة الفترة</th>' +
      '<th colspan="2" style="padding:8px;border:1px solid #1e293b;text-align:center;background:#065f46;">الرصيد النهائي</th>' +
      '</tr><tr style="background:#1e293b;color:#cbd5e1;">' +
      '<th style="padding:6px 10px;border:1px solid #334155;width:95px;">مدين</th><th style="padding:6px 10px;border:1px solid #334155;width:95px;">دائن</th>' +
      '<th style="padding:6px 10px;border:1px solid #334155;width:95px;">مدين</th><th style="padding:6px 10px;border:1px solid #334155;width:95px;">دائن</th>' +
      '<th style="padding:6px 10px;border:1px solid #334155;width:95px;">مدين</th><th style="padding:6px 10px;border:1px solid #334155;width:95px;">دائن</th>' +
      '</tr></thead><tbody>';

    var lastType = '';
    var visIdx = 0;
    rows.forEach(function(r) {
      // Check if this account is a parent (has children)
      var isParentAcc = !!parentCodes[r.code] || r.level <= 1;

      // In leaf-only mode, skip parent accounts (but keep type headers)
      if (leafOnly && isParentAcc) return;

      if (r.type !== lastType) {
        lastType = r.type;
        html += '<tr style="background:' + (typeBg[r.type]||'#f8fafc') + ';"><td colspan="8" style="padding:8px 14px;font-weight:900;font-size:13px;color:' + (typeFg[r.type]||'#1e293b') + ';border:1px solid #e2e8f0;"><i class="fas ' + (typeIcons[r.type]||'fa-folder') + '" style="margin-left:8px;"></i>' + (typeLabels[r.type]||r.type) + '</td></tr>';
      }
      var indent = r.level > 1 ? (r.level - 1) * 16 : 0;
      var hasData = r.openDebit || r.openCredit || r.periodDebit || r.periodCredit || r.closeDebit || r.closeCredit;
      var stripe = visIdx % 2 === 0 ? '#fff' : '#f8fafc';
      visIdx++;

      // Parent accounts: blue background, bold
      var rowBg, nameColor, weight, fontSize;
      if (isParentAcc) {
        rowBg = '#eff6ff';
        nameColor = '#1e40af';
        weight = '800';
        fontSize = '13px';
      } else {
        rowBg = hasData ? stripe : '#fafafa';
        nameColor = '#1e293b';
        weight = '400';
        fontSize = '12px';
      }
      var rowStyle = 'background:' + rowBg + ';' + (!hasData && !isParentAcc ? 'opacity:0.45;' : '');

      var cell = function(val, color) { return '<td style="padding:5px 10px;text-align:start;border:1px solid #e2e8f0;color:' + color + ';font-weight:' + (val?'700':'400') + ';">' + (val ? fmt(val) : '-') + '</td>'; };

      html += '<tr style="' + rowStyle + '">' +
        '<td style="text-align:center;padding:5px 8px;border:1px solid #e2e8f0;"><code style="font-weight:700;font-size:11px;color:' + (isParentAcc?'#1e40af':'#475569') + ';">' + r.code + '</code></td>' +
        '<td style="padding:5px 10px;padding-right:' + (10+indent) + 'px;font-weight:' + weight + ';font-size:' + fontSize + ';border:1px solid #e2e8f0;color:' + nameColor + ';">' + (isParentAcc?'<i class="fas fa-folder" style="margin-left:4px;font-size:10px;color:#3b82f6;"></i> ':'') + r.nameAR + '</td>' +
        cell(r.openDebit, '#1e40af') + cell(r.openCredit, '#1e40af') +
        cell(r.periodDebit, '#7c3aed') + cell(r.periodCredit, '#7c3aed') +
        cell(r.closeDebit, '#065f46') + cell(r.closeCredit, '#065f46') +
        '</tr>';
    });

    // Totals
    var totCell = function(val) { return '<td style="padding:8px 10px;text-align:start;border:1px solid #334155;font-size:13px;">' + fmt(val) + '</td>'; };
    html += '<tr style="background:#0f172a;color:#fff;font-weight:900;">' +
      '<td colspan="2" style="padding:8px 12px;border:1px solid #334155;font-size:14px;">الإجمالي</td>' +
      totCell(tot.openDebit) + totCell(tot.openCredit) +
      totCell(tot.periodDebit) + totCell(tot.periodCredit) +
      totCell(tot.closeDebit) + totCell(tot.closeCredit) +
      '</tr></tbody></table></div>';

    // Store data for export
    window._trialBalanceData = { rows: rows, totals: tot, filters: filters };
    container.innerHTML = html;
  }).getTrialBalance(filters);
}

// Repair GL: fix NULL entries + create missing topup journals + recalculate
window.erpRepairGL = function() {
  if (!confirm('إصلاح شامل:\n1. ربط القيود المعلقة بالحسابات\n2. إنشاء قيود تغذية العهد المفقودة\n3. إعادة حساب جميع الأرصدة\n\nمتابعة؟')) return;
  loader(true);
  // Step 0: Fix tree structure (COGS under expenses)
  fetch('/api/erp/gl/fix-tree', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r) { return r.json(); })
    .then(function() {
      // Step 1: Fix NULL entries
      window._apiBridge.withSuccessHandler(function(r1) {
        // Step 2: Create missing topup journals
        fetch('/api/erp/gl/repair-topups', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
          .then(function(r) { return r.json(); })
          .then(function(r2) {
            loader(false);
            var msg = 'تم الإصلاح. ';
            if (r1.success) msg += r1.nullFixed + ' قيد تم ربطه. ';
            if (r2.success && r2.topupsProcessed) msg += r2.topupsProcessed + ' تغذية. ';
            msg += 'الأرصدة محدّثة.';
            showToast(msg);
            erpApplyFinFilters();
            erpLoadAccountsList_();
          })
          .catch(function() { loader(false); showToast('خطأ في الإصلاح', true); });
      }).repairGLEntries();
    }).catch(function() { loader(false); });
};

// Export Trial Balance to Excel
window.erpExportTrialBalance = function() {
  var data = window._trialBalanceData;
  if (!data || !data.rows) return showToast('لا توجد بيانات للتصدير', true);
  // Build CSV
  var csv = '\uFEFF'; // BOM for Arabic
  csv += 'الرمز,اسم الحساب,النوع,رصيد أول مدين,رصيد أول دائن,حركة مدين,حركة دائن,رصيد نهائي مدين,رصيد نهائي دائن\n';
  data.rows.forEach(function(r) {
    csv += '"' + r.code + '","' + (r.nameAR||'') + '","' + (r.typeLabel||'') + '",' +
      (r.openDebit||0) + ',' + (r.openCredit||0) + ',' +
      (r.periodDebit||0) + ',' + (r.periodCredit||0) + ',' +
      (r.closeDebit||0) + ',' + (r.closeCredit||0) + '\n';
  });
  var t = data.totals;
  csv += '"","الإجمالي","",' + (t.openDebit||0) + ',' + (t.openCredit||0) + ',' + (t.periodDebit||0) + ',' + (t.periodCredit||0) + ',' + (t.closeDebit||0) + ',' + (t.closeCredit||0) + '\n';

  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'trial_balance_' + new Date().toISOString().split('T')[0] + '.csv';
  link.click();
};

// ─── Income Statement — IFRS / IAS 1 ───
function _renderIncomeStatement(container) {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var filters = {};
  var s = document.getElementById('finStartDate'), e = document.getElementById('finEndDate');
  if (s && s.value) filters.startDate = s.value;
  if (e && e.value) filters.endDate = e.value;

  window._apiBridge.withSuccessHandler(function(d) {
    var profitColor = function(v) { return v >= 0 ? '#16a34a' : '#ef4444'; };
    var line = function(label, val, bold, bg, color) {
      var style = (bold?'font-weight:900;font-size:14px;':'font-weight:600;') + (bg?'background:'+bg+';':'') + (color?'color:'+color+';':'');
      return '<tr style="'+style+'"><td style="padding:8px 14px;">' + label + '</td><td style="text-align:start;padding:8px 14px;white-space:nowrap;">' + fmt(val) + '</td></tr>';
    };
    var items = function(list) {
      return (list||[]).map(function(r) {
        var indent = (r.level||3) > 2 ? ((r.level-2)*16) : 0;
        return '<tr><td style="padding:6px 14px;padding-right:' + (14+indent) + 'px;color:#475569;"><code style="color:#94a3b8;margin-left:6px;font-size:11px;">' + r.code + '</code>' + r.name + '</td><td style="text-align:start;padding:6px 14px;">' + fmt(r.balance) + '</td></tr>';
      }).join('');
    };

    var period = (filters.startDate || filters.endDate) ? '<div style="padding:8px 14px;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:12px;font-weight:700;margin-bottom:12px;display:inline-block;"><i class="fas fa-calendar-alt" style="margin-left:4px;"></i> ' + (filters.startDate||'البداية') + ' → ' + (filters.endDate||'الآن') + '</div>' : '';

    var html = period + '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';

    // Header
    html += '<thead><tr style="background:#1e293b;color:#fff;"><th style="padding:10px 14px;text-align:right;">البند</th><th style="padding:10px 14px;text-align:start;width:150px;">المبلغ (SAR)</th></tr></thead><tbody>';

    // 1. Revenue
    html += '<tr style="background:#f0fdf4;"><td colspan="2" style="padding:8px 14px;font-weight:900;color:#166534;font-size:14px;"><i class="fas fa-arrow-trend-up" style="margin-left:6px;"></i> الإيرادات</td></tr>';
    html += items(d.revenue);
    html += line('إجمالي الإيرادات', d.totalRevenue, true, '#dcfce7', '#166534');

    // 2. Cost of Sales (COGS)
    html += '<tr style="background:#fef3c7;"><td colspan="2" style="padding:8px 14px;font-weight:900;color:#92400e;font-size:14px;"><i class="fas fa-boxes-stacked" style="margin-left:6px;"></i> تكلفة المبيعات</td></tr>';
    html += items(d.cogs);
    html += line('إجمالي تكلفة المبيعات', d.totalCOGS, true, '#fef3c7', '#92400e');

    // 3. Gross Profit
    html += '<tr style="background:#1e40af;color:#fff;font-weight:900;font-size:15px;"><td style="padding:10px 14px;">مجمل الربح (Gross Profit)</td><td style="text-align:start;padding:10px 14px;">' + fmt(d.grossProfit) + '</td></tr>';

    // 4. Operating Expenses
    html += '<tr style="background:#fee2e2;"><td colspan="2" style="padding:8px 14px;font-weight:900;color:#991b1b;font-size:14px;"><i class="fas fa-arrow-trend-down" style="margin-left:6px;"></i> المصروفات التشغيلية</td></tr>';
    html += items(d.opex);
    html += line('إجمالي المصروفات التشغيلية', d.totalOpex, true, '#fee2e2', '#991b1b');

    // 5. Operating Income
    html += '<tr style="background:#7c3aed;color:#fff;font-weight:900;font-size:15px;"><td style="padding:10px 14px;">الربح التشغيلي (Operating Income)</td><td style="text-align:start;padding:10px 14px;">' + fmt(d.operatingIncome) + '</td></tr>';

    // 6. Other Income
    if ((d.otherIncome||[]).length) {
      html += '<tr style="background:#f0fdf4;"><td colspan="2" style="padding:8px 14px;font-weight:800;color:#166534;"><i class="fas fa-plus-circle" style="margin-left:6px;"></i> إيرادات أخرى</td></tr>';
      html += items(d.otherIncome);
      html += line('إجمالي إيرادات أخرى', d.totalOtherInc, false, '#f0fdf4', '#166534');
    }

    // 7. Other Expenses
    if ((d.otherExpense||[]).length) {
      html += '<tr style="background:#fef2f2;"><td colspan="2" style="padding:8px 14px;font-weight:800;color:#991b1b;"><i class="fas fa-minus-circle" style="margin-left:6px;"></i> مصروفات أخرى</td></tr>';
      html += items(d.otherExpense);
      html += line('إجمالي مصروفات أخرى', d.totalOtherExp, false, '#fef2f2', '#991b1b');
    }

    // 8. Net Income
    var niColor = d.netIncome >= 0 ? '#166534' : '#991b1b';
    var niBg = d.netIncome >= 0 ? '#16a34a' : '#ef4444';
    html += '<tr style="background:' + niBg + ';color:#fff;font-weight:900;font-size:16px;"><td style="padding:12px 14px;"><i class="fas fa-star" style="margin-left:6px;"></i> صافي الدخل (Net Income)</td><td style="text-align:start;padding:12px 14px;font-size:18px;">' + fmt(d.netIncome) + '</td></tr>';

    html += '</tbody></table></div>';
    container.innerHTML = html;
  }).getIncomeStatement(filters);
}

// ─── Balance Sheet — IFRS / IAS 1 ───
function _renderBalanceSheet(container) {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var filters = {};
  var e = document.getElementById('finEndDate');
  if (e && e.value) filters.asOfDate = e.value;

  window._apiBridge.withSuccessHandler(function(d) {
    var section = function(title, icon, color, items, total, totalLabel) {
      var h = '<tr style="background:' + color + '12;"><td colspan="3" style="padding:8px 14px;font-weight:900;color:' + color + ';font-size:14px;"><i class="fas ' + icon + '" style="margin-left:6px;"></i> ' + title + '</td></tr>';
      (items||[]).forEach(function(r) {
        var indent = (r.level||3) > 2 ? ((r.level-2)*16) : 0;
        var style = r.isComputed ? 'font-style:italic;color:#7c3aed;' : '';
        h += '<tr style="' + style + '"><td style="padding:6px 14px;"><code style="color:#94a3b8;font-size:11px;margin-left:6px;">' + (r.code||'') + '</code></td><td style="padding:6px 14px;padding-right:' + (14+indent) + 'px;font-weight:600;">' + r.name + '</td><td style="text-align:start;padding:6px 14px;font-weight:700;">' + fmt(r.balance) + '</td></tr>';
      });
      h += '<tr style="background:' + color + '18;font-weight:900;"><td colspan="2" style="padding:8px 14px;">' + totalLabel + '</td><td style="text-align:start;padding:8px 14px;color:' + color + ';font-size:15px;">' + fmt(total) + '</td></tr>';
      return h;
    };

    var statusBg = d.isBalanced ? '#dcfce7' : '#fee2e2';
    var statusColor = d.isBalanced ? '#166534' : '#991b1b';
    var statusBorder = d.isBalanced ? '#bbf7d0' : '#fecaca';

    var html = '<div style="padding:10px 16px;border-radius:12px;margin-bottom:14px;font-weight:800;font-size:13px;background:' + statusBg + ';color:' + statusColor + ';border:1px solid ' + statusBorder + ';display:flex;justify-content:space-between;align-items:center;">' +
      '<span><i class="fas ' + (d.isBalanced?'fa-check-circle':'fa-exclamation-triangle') + '" style="margin-left:6px;"></i>' + (d.isBalanced?'الميزانية متوازنة':'الميزانية غير متوازنة!') + '</span>' +
      '<span>كما في: ' + (d.asOfDate||'') + '</span></div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">';

    // Left: Assets
    html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#1e293b;color:#fff;"><th style="padding:10px 14px;" colspan="3">الأصول (Assets)</th></tr></thead><tbody>';
    html += section('الأصول المتداولة', 'fa-coins', '#3b82f6', d.currentAssets, d.totCA, 'إجمالي الأصول المتداولة');
    html += section('الأصول غير المتداولة', 'fa-building', '#1e40af', d.nonCurrentAssets, d.totNCA, 'إجمالي الأصول غير المتداولة');
    html += '<tr style="background:#1e293b;color:#fff;font-weight:900;font-size:15px;"><td colspan="2" style="padding:10px 14px;">إجمالي الأصول</td><td style="text-align:start;padding:10px 14px;">' + fmt(d.totalAssets) + '</td></tr>';
    html += '</tbody></table></div>';

    // Right: Liabilities + Equity
    html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#1e293b;color:#fff;"><th style="padding:10px 14px;" colspan="3">الالتزامات وحقوق الملكية</th></tr></thead><tbody>';
    html += section('الالتزامات المتداولة', 'fa-clock', '#ef4444', d.currentLiab, d.totCL, 'إجمالي الالتزامات المتداولة');
    if ((d.nonCurrentLiab||[]).length) {
      html += section('الالتزامات غير المتداولة', 'fa-landmark', '#b91c1c', d.nonCurrentLiab, d.totNCL, 'إجمالي الالتزامات غير المتداولة');
    }
    html += '<tr style="background:#ef4444;color:#fff;font-weight:900;"><td colspan="2" style="padding:8px 14px;">إجمالي الالتزامات</td><td style="text-align:start;padding:8px 14px;">' + fmt(d.totalLiabilities) + '</td></tr>';
    html += section('حقوق الملكية', 'fa-gem', '#8b5cf6', d.equityItems, d.totEq, 'إجمالي حقوق الملكية');
    html += '<tr style="background:#1e293b;color:#fff;font-weight:900;font-size:15px;"><td colspan="2" style="padding:10px 14px;">إجمالي الالتزامات + حقوق الملكية</td><td style="text-align:start;padding:10px 14px;">' + fmt(d.totalLiabilities + d.totEq) + '</td></tr>';
    html += '</tbody></table></div>';

    html += '</div>';
    container.innerHTML = html;
  }).getBalanceSheet(filters);
}

function erpPrintFinReport() {
  var content = document.getElementById('erpFinReportContent');
  if (!content) return;
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var titles = {trial:'ميزان المراجعة',income:'قائمة الدخل',balance:'الميزانية العمومية'};
  var w = window.open('','_blank');
  w.document.write('<html dir="rtl"><head><meta charset="UTF-8"><title>' + (titles[_finCurrentTab]||'') + '</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:20px;color:#1e293b;font-size:12px;}' +
    'h2{text-align:center;margin-bottom:4px;}h3{margin:12px 0 6px;}' +
    'table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ddd;padding:6px 8px;text-align:right;}th{background:#f1f5f9;font-weight:700;}' +
    'code{font-weight:700;} .text-green{color:#16a34a;} .text-red{color:#ef4444;}' +
    '@media print{body{padding:10px;font-size:11px;}}</style></head><body>' +
    '<h2>' + company + '</h2><h3 style="text-align:center;color:#64748b;margin-bottom:14px;">' + (titles[_finCurrentTab]||'') + ' — ' + new Date().toLocaleDateString('en-GB') + '</h3>' +
    content.innerHTML + '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
}

// ═══════════════════════════════════════
// INVENTORY METHOD & VALUATION (نوع الجرد)
// ═══════════════════════════════════════
function erpLoadInventoryMethod() {
  window._apiBridge.withSuccessHandler(function(data) {
    var method = data.method || 'perpetual';
    // Highlight selected method
    var perpCard = document.getElementById('invMethodPerpetual');
    var periCard = document.getElementById('invMethodPeriodic');
    if (perpCard) perpCard.style.cssText = method === 'perpetual' ? 'cursor:pointer;background:#f0fdf4;border:2px solid #16a34a;border-radius:16px;padding:18px;' : 'cursor:pointer;background:#f8fafc;border:2px solid #e2e8f0;border-radius:16px;padding:18px;opacity:0.7;';
    if (periCard) periCard.style.cssText = method === 'periodic' ? 'cursor:pointer;background:#eff6ff;border:2px solid #3b82f6;border-radius:16px;padding:18px;' : 'cursor:pointer;background:#f8fafc;border:2px solid #e2e8f0;border-radius:16px;padding:18px;opacity:0.7;';
    // Load valuation
    erpLoadInventoryValuation();
  }).getInventoryMethod();
}

window.erpSetInvMethod = function(method) {
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم تغيير نوع الجرد إلى: ' + (method==='perpetual'?'مستمر':'دوري')); erpLoadInventoryMethod(); }
    else showToast(r.error, true);
  }).setInventoryMethod({ method: method });
};

function erpLoadInventoryValuation() {
  var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  window._apiBridge.withSuccessHandler(function(data) {
    var container = document.getElementById('invValuationContent');
    var html = '';

    // Summary card
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">';
    html += '<div style="background:#eff6ff;padding:16px;border-radius:14px;text-align:center;"><div style="font-size:12px;color:#1e40af;font-weight:700;">إجمالي قيمة المخزون</div><div style="font-size:24px;font-weight:900;color:#1e40af;">' + fmt(data.totalValue) + ' SAR</div></div>';
    html += '<div style="background:#f0fdf4;padding:16px;border-radius:14px;text-align:center;"><div style="font-size:12px;color:#166534;font-weight:700;">عدد الأصناف</div><div style="font-size:24px;font-weight:900;color:#16a34a;">' + (data.itemCount||0) + '</div></div>';
    html += '<div style="background:#fef3c7;padding:16px;border-radius:14px;text-align:center;"><div style="font-size:12px;color:#92400e;font-weight:700;">نوع الجرد</div><div style="font-size:24px;font-weight:900;color:#f59e0b;">' + (data.method==='perpetual'?'مستمر':'دوري') + '</div></div>';
    html += '</div>';

    // Categories table
    var cats = data.categories || {};
    var catNames = Object.keys(cats);
    if (catNames.length) {
      html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
      html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">التصنيف</th><th style="padding:10px 14px;">عدد الأصناف</th><th style="padding:10px 14px;text-align:start;">القيمة الإجمالية</th></tr></thead><tbody>';
      catNames.forEach(function(cat) {
        var c = cats[cat];
        html += '<tr style="border-bottom:1px solid #e2e8f0;">';
        html += '<td style="padding:10px 14px;font-weight:800;"><i class="fas fa-box" style="color:#3b82f6;margin-left:6px;"></i>' + cat + '</td>';
        html += '<td style="padding:10px 14px;">' + c.items.length + ' صنف</td>';
        html += '<td style="padding:10px 14px;text-align:start;font-weight:800;color:#1e40af;">' + fmt(c.totalValue) + '</td>';
        html += '</tr>';
        // Show items under each category
        c.items.forEach(function(item) {
          html += '<tr style="background:#f8fafc;border-bottom:1px solid #f1f5f9;">';
          html += '<td style="padding:6px 14px;padding-right:30px;font-size:12px;color:#475569;">' + item.name + '</td>';
          html += '<td style="padding:6px 14px;font-size:12px;">' + item.stock + ' ' + (item.unit||'') + '</td>';
          html += '<td style="padding:6px 14px;text-align:start;font-size:12px;font-weight:700;">' + fmt(item.value) + '</td>';
          html += '</tr>';
        });
      });
      html += '<tr style="background:#0f172a;color:#fff;font-weight:900;"><td style="padding:10px 14px;">الإجمالي</td><td></td><td style="padding:10px 14px;text-align:start;font-size:15px;">' + fmt(data.totalValue) + '</td></tr>';
      html += '</tbody></table></div>';
    } else {
      html += '<div style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-inbox" style="font-size:32px;margin-bottom:8px;"></i><p>لا توجد أصناف مخزون</p></div>';
    }

    container.innerHTML = html;
  }).getInventoryValuation();
}

window.erpSyncInventoryGL = function() {
  if (!confirm('مزامنة تصنيفات المخزون مع دليل الحسابات؟\nسيتم إنشاء حسابات فرعية تحت "112 المخزون" لكل تصنيف.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم المزامنة: ' + r.categoriesCreated + ' تصنيف جديد'); erpLoadAccountsList_(); erpLoadInventoryValuation(); }
    else showToast(r.error, true);
  }).syncInventoryGL();
};

// ═══════════════════════════════════════
// BRANDS (البراندات)
// ═══════════════════════════════════════
var _brandsList = [];
function erpLoadBrands() {
  // Use brands-stats endpoint to get actual counts
  window._apiBridge.withSuccessHandler(function(list) {
    _brandsList = list || [];
    var tb = document.getElementById('erpBrandsBody');
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد براندات</td></tr>'; return; }
    tb.innerHTML = list.map(function(b) {
      var logoHtml = b.logo ? '<img src="' + b.logo + '" style="width:36px;height:36px;border-radius:8px;object-fit:cover;">' : '<i class="fas fa-store" style="font-size:24px;color:#94a3b8;"></i>';
      return '<tr>' +
        '<td>' + logoHtml + '</td>' +
        '<td style="font-weight:800;font-size:14px;">' + b.name + '</td>' +
        '<td><code>' + (b.code||'') + '</code></td>' +
        '<td style="text-align:center;font-weight:700;color:#1e40af;">' + (b.branchCount||0) + ' <span style="font-size:10px;color:#94a3b8;">فرع</span></td>' +
        '<td style="text-align:center;font-weight:700;color:#16a34a;">' + (b.menuCount||0) + ' <span style="font-size:10px;color:#94a3b8;">منتج</span></td>' +
        '<td>' + (b.isActive ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">معطّل</span>') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="btn-icon" onclick="erpEditBrand(\'' + b.id + '\')"><i class="fas fa-edit"></i></button> ' +
          '<button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteBrand(\'' + b.id + '\',\'' + (b.name||'').replace(/'/g,'') + '\')"><i class="fas fa-trash"></i></button>' +
        '</td></tr>';
    }).join('');
  }).getBrandsStats();
}

function erpOpenBrandModal(data) {
  var d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل براند' : 'إضافة براند جديد';
  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="brandID" value="' + (d.id||'') + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>اسم البراند *</label><input class="form-control" id="brandName" value="' + (d.name||'') + '"></div>' +
      '<div class="form-row"><label>الرمز</label><input class="form-control" id="brandCode" value="' + (d.code||'') + '" placeholder="MT"></div>' +
    '</div>' +
    '<div class="form-row"><label>شعار البراند</label><div style="display:flex;gap:10px;align-items:center;"><label style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;cursor:pointer;background:rgba(59,130,246,0.06);color:#3b82f6;font-size:13px;font-weight:700;border:1.5px dashed rgba(59,130,246,0.2);" for="brandLogoFile"><i class="fas fa-image"></i> رفع شعار</label><input type="file" id="brandLogoFile" accept="image/*" onchange="handleBrandLogo(this)" style="display:none;"><div id="brandLogoPreview">' + (d.logo ? '<img src="' + d.logo + '" style="width:50px;height:50px;border-radius:8px;object-fit:cover;">' : '') + '</div></div></div>';
  document.getElementById('erpModalSaveBtn').onclick = erpSaveBrand;
  document.getElementById('erpModal').classList.remove('hidden');
}

window._brandLogoData = '';
window.handleBrandLogo = function(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var c = document.createElement('canvas'), mx = 400, w = img.width, h = img.height;
      if (w > mx || h > mx) { var sc = Math.min(mx/w, mx/h); w *= sc; h *= sc; }
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      window._brandLogoData = c.toDataURL('image/jpeg', 0.85);
      document.getElementById('brandLogoPreview').innerHTML = '<img src="' + window._brandLogoData + '" style="width:50px;height:50px;border-radius:8px;object-fit:cover;">';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
};

function erpEditBrand(id) { var b = _brandsList.find(function(x){return x.id===id;}); if(b) { window._brandLogoData = b.logo||''; erpOpenBrandModal(b); } }

function erpSaveBrand() {
  var data = { id: document.getElementById('brandID').value, name: document.getElementById('brandName').value, code: document.getElementById('brandCode').value, logo: window._brandLogoData || '' };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadBrands(); } else showToast(r.error, true); }).saveBrand(data);
}

function erpDeleteBrand(id, name) {
  if (!confirm('حذف البراند "' + name + '"؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحذف'); erpLoadBrands(); } else showToast(r.error, true); }).deleteBrand(id);
}

// ═══════════════════════════════════════
// PURCHASE REPORTS (تقارير المشتريات)
// ═══════════════════════════════════════
function erpInitPurchaseReports() {
  // Populate supplier + item dropdowns
  window._apiBridge.withSuccessHandler(function(suppliers) {
    var sel = document.getElementById('prRepSupplier');
    if (sel) { sel.innerHTML = '<option value="">الكل</option>' + (suppliers||[]).map(function(s) { return '<option value="' + s.id + '">' + (s.name||'') + '</option>'; }).join(''); }
  }).getSuppliers();
  window._apiBridge.withSuccessHandler(function(items) {
    var sel = document.getElementById('prRepItem');
    if (sel) { sel.innerHTML = '<option value="">الكل</option>' + (items||[]).map(function(i) { return '<option value="' + i.id + '">' + (i.name||'') + '</option>'; }).join(''); }
  }).getInvItems();
}

window.erpLoadPurchaseReport = function() {
  var filters = {
    startDate: (document.getElementById('prRepStart')||{}).value || '',
    endDate: (document.getElementById('prRepEnd')||{}).value || '',
    supplierId: (document.getElementById('prRepSupplier')||{}).value || '',
    itemId: (document.getElementById('prRepItem')||{}).value || '',
    reportType: (document.getElementById('prRepType')||{}).value || 'bySupplier'
  };
  var container = document.getElementById('prRepContent');
  container.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-spinner fa-spin" style="font-size:24px;"></i></div>';

  window._apiBridge.withSuccessHandler(function(data) {
    var fmt = function(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var rows = data.rows || [];
    if (!rows.length) { container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;"></i>لا توجد بيانات</div>'; return; }

    var html = '<div style="padding:10px 16px;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:13px;font-weight:700;margin-bottom:14px;"><i class="fas fa-coins" style="margin-left:6px;"></i> إجمالي المشتريات: <strong>' + fmt(data.totalAmount) + ' SAR</strong> | ' + rows.length + ' سجل</div>';

    html += '<div style="overflow-x:auto;border-radius:14px;border:1px solid #e2e8f0;"><table style="width:100%;border-collapse:collapse;font-size:13px;">';

    if (data.type === 'bySupplier') {
      html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">المورد</th><th>عدد الفواتير</th><th>إجمالي الكمية</th><th>إجمالي المبلغ</th></tr></thead><tbody>';
      rows.forEach(function(r) { html += '<tr><td style="font-weight:700;padding:8px 14px;">' + r.supplier + '</td><td style="text-align:center;">' + r.invoiceCount + '</td><td style="text-align:center;">' + r.totalQty + '</td><td style="font-weight:800;color:#1e40af;text-align:start;">' + fmt(r.totalAmount) + '</td></tr>'; });
    } else if (data.type === 'byItem') {
      html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">الصنف</th><th>الوحدة</th><th>إجمالي الكمية</th><th>متوسط السعر</th><th>عدد الموردين</th><th>إجمالي المبلغ</th></tr></thead><tbody>';
      rows.forEach(function(r) { html += '<tr><td style="font-weight:700;padding:8px 14px;">' + r.itemName + '</td><td>' + (r.unit||'') + '</td><td style="text-align:center;">' + r.totalQty + '</td><td style="text-align:center;">' + fmt(r.avgPrice) + '</td><td style="text-align:center;">' + (r.supplierCount||0) + '</td><td style="font-weight:800;color:#1e40af;text-align:start;">' + fmt(r.totalAmount) + '</td></tr>'; });
    } else if (data.type === 'bySupplierItem') {
      html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">المورد</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>المبلغ</th></tr></thead><tbody>';
      rows.forEach(function(r) { html += '<tr><td style="font-weight:700;padding:8px 14px;">' + r.supplierName + '</td><td style="font-weight:600;">' + r.itemName + '</td><td>' + (r.unit||'') + '</td><td style="text-align:center;">' + r.totalQty + '</td><td style="font-weight:800;color:#1e40af;text-align:start;">' + fmt(r.totalAmount) + '</td></tr>'; });
    } else {
      html += '<thead><tr style="background:#0f172a;color:#fff;"><th style="padding:10px 14px;">التاريخ</th><th>المورد</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>المبلغ</th></tr></thead><tbody>';
      rows.forEach(function(r) {
        var dt = r.date ? new Date(r.date).toLocaleDateString('en-GB') : '';
        html += '<tr><td style="padding:8px 14px;">' + dt + '</td><td style="font-weight:700;">' + r.supplierName + '</td><td>' + r.itemName + '</td><td>' + (r.unit||'') + '</td><td style="text-align:center;">' + r.qty + '</td><td style="text-align:center;">' + fmt(r.unitPrice) + '</td><td style="font-weight:800;color:#1e40af;text-align:start;">' + fmt(r.total) + '</td></tr>';
      });
    }

    html += '<tr style="background:#0f172a;color:#fff;font-weight:900;"><td colspan="' + (data.type==='detailed'?6:data.type==='byItem'?5:data.type==='bySupplierItem'?4:3) + '" style="padding:10px 14px;">الإجمالي</td><td style="text-align:start;font-size:15px;">' + fmt(data.totalAmount) + '</td></tr>';
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }).getPurchaseReports(filters);
};

window.erpPrintPurchaseReport = function() {
  var content = document.getElementById('prRepContent');
  if (!content) return;
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var w = window.open('','_blank');
  w.document.write('<html dir="rtl"><head><meta charset="UTF-8"><title>تقرير المشتريات</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:20px;color:#1e293b;font-size:12px;}h2{text-align:center;margin-bottom:4px;}table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ddd;padding:6px 8px;text-align:right;}th{background:#f1f5f9;font-weight:700;}@media print{body{padding:10px;}}</style></head><body><h2>' + company + '</h2><h3 style="text-align:center;color:#64748b;margin-bottom:14px;">تقرير المشتريات — ' + new Date().toLocaleDateString('en-GB') + '</h3>' + content.innerHTML + '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
};

// ═══════════════════════════════════════
// COST CENTERS (مراكز التكلفة)
// ═══════════════════════════════════════
var _ccList = [];
function erpLoadCostCenters() {
  window._apiBridge.withSuccessHandler(function(list) {
    _ccList = list || [];
    var tb = document.getElementById('erpCCBody');
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="empty-msg">لا توجد مراكز تكلفة</td></tr>'; return; }
    var typeLabels = {branch:'فرع',department:'قسم',project:'مشروع'};
    tb.innerHTML = list.map(function(c) {
      return '<tr><td><code>' + c.code + '</code></td><td style="font-weight:700;">' + c.name + '</td>' +
        '<td><span class="badge badge-blue">' + (typeLabels[c.type]||c.type) + '</span></td>' +
        '<td>' + (c.isActive ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">معطّل</span>') + '</td>' +
        '<td><button class="btn-icon" onclick="erpEditCC(\'' + c.id + '\')"><i class="fas fa-edit"></i></button> <button class="btn-icon" style="color:#ef4444;" onclick="erpDeleteCC(\'' + c.id + '\')"><i class="fas fa-trash"></i></button></td></tr>';
    }).join('');
  }).getCostCenters();
}
function erpOpenCostCenterModal(data) {
  var d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل مركز تكلفة' : 'إضافة مركز تكلفة';
  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="ccID" value="' + (d.id||'') + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>الرمز *</label><input class="form-control" id="ccCode" value="' + (d.code||'') + '"></div>' +
      '<div class="form-row"><label>النوع</label><select class="form-control" id="ccType"><option value="branch"' + (d.type==='branch'?' selected':'') + '>فرع</option><option value="department"' + (d.type==='department'?' selected':'') + '>قسم</option><option value="project"' + (d.type==='project'?' selected':'') + '>مشروع</option></select></div>' +
    '</div>' +
    '<div class="form-row"><label>الاسم *</label><input class="form-control" id="ccName" value="' + (d.name||'') + '"></div>';
  document.getElementById('erpModalSaveBtn').onclick = erpSaveCC;
  document.getElementById('erpModal').classList.remove('hidden');
}
function erpEditCC(id) { var c = _ccList.find(function(x){return x.id===id;}); if(c) erpOpenCostCenterModal(c); }
function erpSaveCC() {
  var data = { id: document.getElementById('ccID').value, code: document.getElementById('ccCode').value, name: document.getElementById('ccName').value, type: document.getElementById('ccType').value };
  if (!data.code || !data.name) return showToast('الرمز والاسم مطلوبان', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadCostCenters(); } else showToast(r.error, true); }).saveCostCenter(data);
}
function erpDeleteCC(id) {
  if (!confirm('حذف مركز التكلفة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحذف'); erpLoadCostCenters(); } else showToast(r.error, true); }).deleteCostCenter(id);
}

// ═══════════════════════════════════════
// MULTI-WAREHOUSES (المستودعات المتعددة)
// ═══════════════════════════════════════
var _whList = [];
var _whTypeLabels = {branch:'فرعي',main:'رئيسي',production:'إنتاج',waste:'هدر',raw:'مواد خام',finished:'مواد تامة'};

function whSwitchTab(tab) {
  var tabMap = { warehouses: 'whTabWarehouses', transfers: 'whTabTransfers', stock: 'whTabStock' };
  // Hide all tab contents
  Object.values(tabMap).forEach(function(id) { document.getElementById(id).style.display = 'none'; });
  // Show selected
  document.getElementById(tabMap[tab]).style.display = 'block';
  // Update tab button styles
  var btns = document.querySelectorAll('.whTabBtn');
  btns.forEach(function(b) { b.style.background = ''; b.style.color = '#64748b'; b.classList.remove('whTabActive'); });
  var idx = { warehouses: 0, transfers: 1, stock: 2 };
  btns[idx[tab]].style.background = '#0d47a1';
  btns[idx[tab]].style.color = '#fff';
  btns[idx[tab]].classList.add('whTabActive');
  if (tab === 'stock') whLoadStockTab();
}

function _whStatCard(bg, iconBg, iconColor, icon, label, value) {
  return '<div style="background:' + bg + ';border:1px solid ' + iconBg + ';border-radius:16px;padding:20px;display:flex;align-items:center;gap:14px;">' +
    '<div style="width:48px;height:48px;border-radius:14px;background:' + iconBg + ';color:' + iconColor + ';display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;"><i class="fas ' + icon + '"></i></div>' +
    '<div><div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:4px;">' + label + '</div><div style="font-size:26px;font-weight:900;color:#0f172a;">' + value + '</div></div></div>';
}

function erpLoadMultiWarehouses() {
  // Load warehouses → render cards
  window._apiBridge.withSuccessHandler(function(list) {
    _whList = list || [];
    var grid = document.getElementById('whCardsGrid');
    var activeCount = list.filter(function(w) { return w.isActive; }).length;
    var types = {};
    list.forEach(function(w) { types[w.type] = true; });
    // Update stats with inline-styled cards
    document.getElementById('whStatsRow').innerHTML =
      _whStatCard('linear-gradient(135deg,#eff6ff,#dbeafe)', '#dbeafe', '#1e40af', 'fa-warehouse', 'إجمالي المستودعات', list.length) +
      _whStatCard('linear-gradient(135deg,#f0fdf4,#dcfce7)', '#dcfce7', '#166534', 'fa-check-circle', 'المستودعات النشطة', activeCount) +
      _whStatCard('linear-gradient(135deg,#fefce8,#fef9c3)', '#fef9c3', '#854d0e', 'fa-layer-group', 'أنواع المستودعات', Object.keys(types).length) +
      _whStatCard('linear-gradient(135deg,#faf5ff,#f3e8ff)', '#f3e8ff', '#7c3aed', 'fa-exchange-alt', 'تحويلات معلقة', '<span id="whStatPending">0</span>');
    if (!list.length) { grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;font-style:italic;">لا توجد مستودعات — اضغط "مستودع جديد"</div>'; return; }
    grid.innerHTML = list.map(function(w) {
      var btnS = 'width:34px;height:34px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;';
      return '<div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:18px;padding:20px;transition:all 0.2s;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
          '<div style="font-size:16px;font-weight:800;color:#1e293b;">' + w.name + '</div>' +
          '<span class="badge badge-blue">' + (_whTypeLabels[w.type]||w.type) + '</span>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b;"><i class="fas fa-code-branch" style="width:16px;text-align:center;color:#94a3b8;"></i> ' + (w.branchName||'بدون فرع') + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b;"><i class="fas fa-user" style="width:16px;text-align:center;color:#94a3b8;"></i> ' + (w.manager||'بدون مدير') + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b;"><i class="fas fa-hashtag" style="width:16px;text-align:center;color:#94a3b8;"></i> <code>' + w.code + '</code></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px solid #f1f5f9;">' +
          (w.isActive ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">معطّل</span>') +
          '<div style="display:flex;gap:6px;">' +
            '<button style="' + btnS + '" onclick="erpEditWH(\'' + w.id + '\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
            '<button style="' + btnS + 'color:#3b82f6;" onclick="erpViewWHStock(\'' + w.id + '\',\'' + (w.name||'').replace(/'/g,'') + '\')" title="أرصدة"><i class="fas fa-boxes"></i></button>' +
            '<button style="' + btnS + 'color:#ef4444;" onclick="erpDeleteWH(\'' + w.id + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    // Populate stock tab filter
    var sel = document.getElementById('whStockWhFilter');
    if (sel && sel.options.length <= 1) {
      list.forEach(function(w) { var o = document.createElement('option'); o.value = w.id; o.textContent = w.name; sel.appendChild(o); });
    }
  }).getWarehousesList();
  // Load transfers → render timeline
  window._apiBridge.withSuccessHandler(function(list) {
    var container = document.getElementById('whTransferList');
    var pendingCount = 0;
    if (!list || !list.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;font-style:italic;">لا توجد تحويلات — اضغط "تحويل جديد"</div>';
      document.getElementById('whStatPending').textContent = '0';
      return;
    }
    var sBadge = function(s) { return s==='completed'?'<span class="badge badge-green">مكتمل</span>':s==='draft'?'<span class="badge badge-yellow">مسودة</span>':s==='cancelled'?'<span class="badge badge-red">ملغي</span>':'<span class="badge">'+s+'</span>'; };
    var iconBgs = { draft: '#fef9c3', completed: '#dcfce7', cancelled: '#fee2e2' };
    var iconClrs = { draft: '#ca8a04', completed: '#16a34a', cancelled: '#dc2626' };
    container.innerHTML = list.map(function(t) {
      if (t.status === 'draft') pendingCount++;
      var dt = t.transferDate ? new Date(t.transferDate).toLocaleDateString('en-GB') : '';
      var actions = '';
      if (t.status === 'draft') actions = '<button class="btn btn-success btn-sm" onclick="erpApproveTransfer(\'' + t.id + '\')"><i class="fas fa-check"></i> اعتماد</button> <button class="btn btn-danger btn-sm" onclick="erpCancelTransfer(\'' + t.id + '\')"><i class="fas fa-times"></i> إلغاء</button>';
      return '<div style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;margin-bottom:8px;">' +
        '<div style="width:42px;height:42px;border-radius:12px;background:' + (iconBgs[t.status]||'#eff6ff') + ';color:' + (iconClrs[t.status]||'#3b82f6') + ';display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;"><i class="fas fa-exchange-alt"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:700;color:#1e293b;font-size:14px;display:flex;align-items:center;gap:6px;">' + t.fromWarehouse + ' <span style="color:#3b82f6;font-size:12px;"><i class="fas fa-arrow-left"></i></span> ' + t.toWarehouse + '</div>' +
          '<div style="font-size:12px;color:#94a3b8;margin-top:2px;"><code>' + (t.transferNumber||'') + '</code> &bull; ' + dt + '</div>' +
        '</div>' +
        sBadge(t.status) +
        '<div style="display:flex;gap:6px;flex-shrink:0;">' + actions + '</div>' +
      '</div>';
    }).join('');
    document.getElementById('whStatPending').textContent = pendingCount;
  }).getWarehouseTransfers();
}

var _whStockData = [];
function whLoadStockTab() {
  var whId = document.getElementById('whStockWhFilter').value;
  var tb = document.getElementById('whStockBody');
  tb.innerHTML = '<tr><td colspan="4" class="empty-msg">جاري التحميل...</td></tr>';
  if (!whId) {
    // Load all warehouses stock
    window._apiBridge.withSuccessHandler(function(list) {
      _whStockData = list || [];
      if (!list.length) { tb.innerHTML = '<tr><td colspan="4" class="empty-msg">لا توجد أرصدة</td></tr>'; return; }
      tb.innerHTML = list.map(function(s) {
        return '<tr><td>' + (s.WarehouseName||'') + '</td><td style="font-weight:700;">' + (s.ItemName||'') + '</td><td style="font-weight:800;color:#1e40af;">' + s.Qty + '</td><td>' + (s.Unit||'') + '</td></tr>';
      }).join('');
    }).getWarehouseStock();
  } else {
    window._apiBridge.withSuccessHandler(function(items) {
      _whStockData = (items||[]).map(function(i) { return { WarehouseName: '', ItemName: i.itemName, Qty: i.qty, Unit: i.unit||'' }; });
      if (!items.length) { tb.innerHTML = '<tr><td colspan="4" class="empty-msg">لا توجد أرصدة لهذا المستودع</td></tr>'; return; }
      var whName = (document.getElementById('whStockWhFilter').selectedOptions[0]||{}).textContent||'';
      tb.innerHTML = items.map(function(i) {
        return '<tr><td>' + whName + '</td><td style="font-weight:700;">' + i.itemName + '</td><td style="font-weight:800;color:#1e40af;">' + i.qty + '</td><td>' + (i.unit||'') + '</td></tr>';
      }).join('');
    }).getWarehouseStockDetail(whId);
  }
}

function whFilterStockTable() {
  var q = (document.getElementById('whStockSearch').value||'').toLowerCase();
  var tb = document.getElementById('whStockBody');
  var filtered = _whStockData.filter(function(s) { return !q || (s.ItemName||'').toLowerCase().indexOf(q) > -1; });
  if (!filtered.length) { tb.innerHTML = '<tr><td colspan="4" class="empty-msg">لا توجد نتائج</td></tr>'; return; }
  tb.innerHTML = filtered.map(function(s) {
    return '<tr><td>' + (s.WarehouseName||'') + '</td><td style="font-weight:700;">' + (s.ItemName||'') + '</td><td style="font-weight:800;color:#1e40af;">' + s.Qty + '</td><td>' + (s.Unit||'') + '</td></tr>';
  }).join('');
}
function erpOpenWarehouseModal(data) {
  var d = data || {};
  // Load branches + brands + cost centers for dropdowns
  Promise.all([
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getBranchesFull(); }),
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getBrands(); }),
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getCostCenters(); })
  ]).then(function(results) {
    var branches = results[0]||[], brands = results[1]||[], ccs = results[2]||[];
    var brOpts = branches.map(function(b) { return '<option value="' + b.id + '"' + (d.branchId===b.id?' selected':'') + '>' + b.name + '</option>'; }).join('');
    var brandOpts = brands.map(function(b) { return '<option value="' + b.id + '"' + (d.brandId===b.id?' selected':'') + '>' + b.name + '</option>'; }).join('');
    var ccOpts = ccs.map(function(c) { return '<option value="' + c.id + '"' + (d.costCenterId===c.id?' selected':'') + '>' + c.code + ' — ' + c.name + '</option>'; }).join('');
    document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل مستودع' : 'مستودع جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="whID" value="' + (d.id||'') + '">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الرمز *</label><input class="form-control" id="whCode" value="' + (d.code||'') + '"></div>' +
        '<div class="form-row"><label>النوع</label><select class="form-control" id="whType"><option value="branch">فرعي</option><option value="main">رئيسي</option><option value="production">إنتاج</option><option value="waste">هدر</option><option value="raw">مواد خام</option><option value="finished">مواد تامة</option></select></div>' +
      '</div>' +
      '<div class="form-row"><label>الاسم *</label><input class="form-control" id="whName" value="' + (d.name||'') + '"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>البراند</label><select class="form-control" id="whBrand"><option value="">— بدون —</option>' + brandOpts + '</select></div>' +
        '<div class="form-row"><label>الفرع</label><select class="form-control" id="whBranch"><option value="">— بدون —</option>' + brOpts + '</select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>مركز التكلفة</label><select class="form-control" id="whCC"><option value="">— بدون —</option>' + ccOpts + '</select></div>' +
        '<div class="form-row"><label>المدير</label><input class="form-control" id="whManager" value="' + (d.manager||'') + '"></div>' +
      '</div>' +
      '<div class="form-row"><label>الموقع</label><input class="form-control" id="whLocation" value="' + (d.location||'') + '"></div>';
    if (d.type) document.getElementById('whType').value = d.type;
    document.getElementById('erpModalSaveBtn').onclick = erpSaveWH;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}
function erpEditWH(id) { var w = _whList.find(function(x){return x.id===id;}); if(w) erpOpenWarehouseModal(w); }
function erpSaveWH() {
  var data = { id: document.getElementById('whID').value, code: document.getElementById('whCode').value, name: document.getElementById('whName').value, type: document.getElementById('whType').value, brandId: (document.getElementById('whBrand')||{}).value||'', branchId: document.getElementById('whBranch').value, costCenterId: (document.getElementById('whCC')||{}).value||'', manager: document.getElementById('whManager').value, location: document.getElementById('whLocation').value };
  if (!data.code || !data.name) return showToast('الرمز والاسم مطلوبان', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadMultiWarehouses(); } else showToast(r.error, true); }).saveWarehouse(data);
}
function erpDeleteWH(id) {
  if (!confirm('حذف المستودع وجميع أرصدته؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحذف'); erpLoadMultiWarehouses(); } else showToast(r.error, true); }).deleteWarehouse(id);
}
function erpViewWHStock(whId, whName) {
  loader(true);
  window._apiBridge.withSuccessHandler(function(items) {
    loader(false);
    var html = '<h3 style="margin-bottom:10px;">أرصدة مستودع: ' + whName + '</h3>';
    if (!items.length) { html += '<p style="color:#94a3b8;text-align:center;padding:20px;">لا توجد أرصدة</p>'; }
    else {
      html += '<table class="erp-table" style="font-size:13px;"><thead><tr><th>المادة</th><th>التصنيف</th><th>الكمية</th><th>الوحدة</th></tr></thead><tbody>';
      items.forEach(function(i) { html += '<tr><td style="font-weight:700;">' + i.itemName + '</td><td>' + (i.category||'') + '</td><td style="font-weight:800;color:#1e40af;">' + i.qty + '</td><td>' + (i.unit||'') + '</td></tr>'; });
      html += '</tbody></table>';
    }
    document.getElementById('erpModalTitle').textContent = 'أرصدة المستودع';
    document.getElementById('erpModalBody').innerHTML = html;
    document.getElementById('erpModalSaveBtn').style.display = 'none';
    document.getElementById('erpModal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('erpModalSaveBtn').style.display = ''; }, 100);
  }).getWarehouseStockDetail(whId);
}
var _trAllItems = [];
var _trCart = [];

function erpOpenTransferModal() {
  _trCart = [];
  Promise.all([
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getWarehousesList(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getInvItems(); })
  ]).then(function(results) {
    var whs = results[0] || [];
    _trAllItems = results[1] || [];
    var opts = whs.map(function(w) { return '<option value="' + w.id + '">' + w.name + '</option>'; }).join('');

    document.getElementById('erpModalTitle').textContent = 'تحويل بين مستودعات';
    var box = document.querySelector('#erpModal .modal-box');
    if (box) box.style.maxWidth = '750px';

    document.getElementById('erpModalBody').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>من مستودع *</label><select class="form-control" id="trFrom">' + opts + '</select></div>' +
        '<div class="form-row"><label>إلى مستودع *</label><select class="form-control" id="trTo">' + opts + '</select></div>' +
      '</div>' +
      '<div class="form-row"><label>ملاحظات</label><input class="form-control" id="trNotes" placeholder="اختياري"></div>' +
      '<div style="border-top:1px solid #e2e8f0;margin:14px 0;padding-top:14px;">' +
        '<div style="position:relative;margin-bottom:10px;">' +
          '<i class="fas fa-search" style="position:absolute;top:12px;right:12px;color:#94a3b8;"></i>' +
          '<input type="text" id="trSearch" class="form-control" style="padding-right:36px;" placeholder="ابحث عن مادة..." oninput="_trFilterItems()" onfocus="_trFilterItems()">' +
          '<div id="trSearchResults" style="position:absolute;top:100%;left:0;right:0;z-index:200;background:rgba(255,255,255,0.98);border:1.5px solid #e2e8f0;border-radius:0 0 14px 14px;max-height:220px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.12);"></div>' +
        '</div>' +
      '</div>' +
      '<div style="max-height:300px;overflow-y:auto;">' +
        '<table class="erp-table" style="font-size:13px;">' +
          '<thead><tr><th>المادة</th><th style="text-align:center;">الرصيد</th><th style="text-align:center;">الوحدة الكبرى</th><th style="text-align:center;">الكمية كبرى</th><th style="text-align:center;">الوحدة الصغرى</th><th style="text-align:center;">الكمية صغرى</th><th style="text-align:center;">التكلفة</th><th></th></tr></thead>' +
          '<tbody id="trCartBody"><tr><td colspan="8" class="empty-msg">ابحث وأضف المواد</td></tr></tbody>' +
        '</table>' +
      '</div>';

    document.getElementById('erpModalSaveBtn').onclick = erpSubmitTransfer;
    document.getElementById('erpModal').classList.remove('hidden');

    // Close dropdown on outside click
    setTimeout(function() {
      document.addEventListener('click', function _trClose(e) {
        if (!e.target.closest('#trSearch') && !e.target.closest('#trSearchResults')) {
          var r = document.getElementById('trSearchResults');
          if (r) r.style.display = 'none';
        }
      });
    }, 100);
  });
}

function _trFilterItems() {
  var q = (document.getElementById('trSearch').value || '').toLowerCase();
  var box = document.getElementById('trSearchResults');
  var cartIds = _trCart.map(function(c) { return c.id; });
  var available = _trAllItems.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = q ? available.filter(function(i) {
    return (i.name||'').toLowerCase().indexOf(q) >= 0 || (i.category||'').toLowerCase().indexOf(q) >= 0;
  }) : available;

  if (!matches.length) { box.innerHTML = '<div style="padding:12px;color:#94a3b8;text-align:center;">لا توجد نتائج</div>'; box.style.display = 'block'; return; }
  box.innerHTML = matches.map(function(i) {
    var stk = Number(i.stock) || 0;
    var stkColor = stk <= (Number(i.minStock)||0) ? '#ef4444' : '#16a34a';
    var bigU = i.bigUnit || i.big_unit || '';
    var convR = Number(i.convRate || i.conv_rate) || 1;
    var bigStk = bigU && convR > 1 ? Math.floor(stk / convR) : '';
    var smallStk = bigU && convR > 1 ? (stk % convR) : stk;
    return '<div onclick="_trAddItem(\'' + i.id + '\')" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(226,232,240,0.5);display:flex;justify-content:space-between;align-items:center;" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">' +
      '<div><span style="font-weight:700;">' + i.name + '</span>' + (i.category ? '<div style="font-size:11px;color:#94a3b8;">' + i.category + '</div>' : '') + '</div>' +
      '<div style="text-align:left;"><span style="font-size:12px;color:' + stkColor + ';font-weight:800;">' + stk + ' ' + (i.unit||'') + '</span>' +
      (bigU && convR > 1 ? '<div style="font-size:10px;color:#64748b;">' + bigStk + ' ' + bigU + ' + ' + smallStk + ' ' + (i.unit||'') + '</div>' : '') +
      '</div></div>';
  }).join('');
  box.style.display = 'block';
}

function _trAddItem(id) {
  var item = _trAllItems.find(function(i) { return i.id === id; });
  if (!item || _trCart.some(function(c) { return c.id === id; })) return;
  _trCart.push({
    id: item.id, name: item.name, unit: item.unit || '',
    bigUnit: item.bigUnit || item.big_unit || '',
    convRate: Number(item.convRate || item.conv_rate) || 1,
    stock: Number(item.stock) || 0, cost: Number(item.cost) || 0,
    _bigInput: '', _smallInput: ''
  });
  document.getElementById('trSearch').value = '';
  document.getElementById('trSearchResults').style.display = 'none';
  _trRenderCart();
}

function _trUpdateDual(idx, bigVal, smallVal) {
  if (!_trCart[idx]) return;
  if (bigVal !== null && bigVal !== undefined) _trCart[idx]._bigInput = bigVal === '' ? '' : Number(bigVal);
  if (smallVal !== null && smallVal !== undefined) _trCart[idx]._smallInput = smallVal === '' ? '' : Number(smallVal);
  _trRenderCart();
}

function _trRemoveItem(idx) {
  _trCart.splice(idx, 1);
  _trRenderCart();
}

function _trRenderCart() {
  var tb = document.getElementById('trCartBody');
  if (!_trCart.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-msg">ابحث وأضف المواد</td></tr>'; return; }
  tb.innerHTML = _trCart.map(function(c, i) {
    var hasBig = c.bigUnit && c.convRate > 1;
    var bigStk = hasBig ? Math.floor(c.stock / c.convRate) : '';
    var smallStk = hasBig ? (c.stock % c.convRate) : c.stock;
    var inputS = 'width:60px;padding:5px;text-align:center;font-weight:800;border:1.5px solid #e2e8f0;border-radius:8px;';
    return '<tr>' +
      '<td style="font-weight:700;">' + c.name + '</td>' +
      '<td style="text-align:center;font-weight:800;color:#1e40af;">' + c.stock + '</td>' +
      '<td style="text-align:center;color:#64748b;">' + (hasBig ? c.bigUnit + ' <span style="font-size:11px;color:#94a3b8;">(' + bigStk + ')</span>' : '—') + '</td>' +
      '<td style="text-align:center;">' + (hasBig ? '<input type="number" min="0" step="1" style="' + inputS + '" value="' + (c._bigInput === '' ? '' : c._bigInput) + '" oninput="_trUpdateDual(' + i + ',this.value,null)" placeholder="0">' : '—') + '</td>' +
      '<td style="text-align:center;color:#64748b;">' + (c.unit || '') + ' <span style="font-size:11px;color:#94a3b8;">(' + smallStk + ')</span></td>' +
      '<td style="text-align:center;"><input type="number" min="0" step="0.01" style="' + inputS + '" value="' + (c._smallInput === '' ? '' : c._smallInput) + '" oninput="_trUpdateDual(' + i + ',null,this.value)" placeholder="0"></td>' +
      '<td style="text-align:center;font-size:12px;color:#64748b;">' + c.cost.toFixed(2) + '</td>' +
      '<td><button style="width:28px;height:28px;border-radius:6px;border:1px solid #fecaca;background:#fee2e2;color:#ef4444;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;" onclick="_trRemoveItem(' + i + ')"><i class="fas fa-times"></i></button></td>' +
    '</tr>';
  }).join('');
}

function erpSubmitTransfer() {
  var from = document.getElementById('trFrom').value, to = document.getElementById('trTo').value;
  if (from === to) return showToast('اختر مستودعين مختلفين', true);
  if (!_trCart.length) return showToast('أضف مواد أولاً', true);
  // Build items with calculated quantities
  var items = _trCart.map(function(c) {
    var b = Number(c._bigInput) || 0;
    var s = Number(c._smallInput) || 0;
    var total = (c.bigUnit && c.convRate > 1) ? (b * c.convRate + s) : s;
    return { itemId: c.id, itemName: c.name, qty: total, cost: c.cost };
  }).filter(function(i) { return i.qty > 0; });
  if (!items.length) return showToast('أدخل كميات المواد', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم إنشاء التحويل: ' + r.transferNumber); erpCloseModal(); erpLoadMultiWarehouses(); }
    else showToast(r.error, true);
  }).createWarehouseTransfer({ fromWarehouseId: from, toWarehouseId: to, items: items, notes: document.getElementById('trNotes').value, username: currentUser });
}
function erpApproveTransfer(id) {
  if (!confirm('اعتماد التحويل وتحديث الأرصدة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم اعتماد التحويل'); erpLoadMultiWarehouses(); } else showToast(r.error, true); }).approveWarehouseTransfer(id, { username: currentUser });
}

function erpCancelTransfer(id) {
  if (!confirm('إلغاء هذا التحويل؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم إلغاء التحويل'); erpLoadMultiWarehouses(); } else showToast(r.error, true); }).cancelWarehouseTransfer(id);
}

// ═══════════════════════════════════════
// BRANCHES (Enhanced — إدارة الفروع)
// ═══════════════════════════════════════
function erpLoadBranchesFull() {
  window._apiBridge.withSuccessHandler(function(list) {
    var tb = document.getElementById('erpBranchesBody');
    if (!list || !list.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-msg">لا توجد فروع</td></tr>'; return; }
    var supplyLabels = {parent_company:'الشركة الأم',warehouse:'المستودع الرئيسي',auto:'تلقائي'};
    tb.innerHTML = list.map(function(b) {
      return '<tr><td><code>' + (b.code||'') + '</code></td><td style="font-weight:700;">' + b.name + '</td><td>' + (b.location||'—') + '</td>' +
        '<td>' + (b.warehouseName||'—') + '</td><td>' + (b.costCenterName||'—') + '</td><td>' + (b.manager||'—') + '</td>' +
        '<td><span class="badge badge-blue">' + (supplyLabels[b.supplyMode]||b.supplyMode) + '</span></td>' +
        '<td><button class="btn-icon" onclick="erpEditBranchFull(\'' + b.id + '\')"><i class="fas fa-edit"></i></button></td></tr>';
    }).join('');
  }).getBranchesFull();
}
var _brFullList = [];
function erpOpenBranchFullModal(data) {
  var d = data || {};
  // Load warehouses + cost centers + brands for dropdowns
  Promise.all([
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getWarehousesList(); }),
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getCostCenters(); }),
    new Promise(function(res) { window._apiBridge.withSuccessHandler(res).getBrands(); })
  ]).then(function(results) {
    var whs = results[0]||[], ccs = results[1]||[], brands = results[2]||[];
    var whOpts = whs.map(function(w) { return '<option value="' + w.id + '"' + (d.warehouseId===w.id?' selected':'') + '>' + w.name + '</option>'; }).join('');
    var ccOpts = ccs.map(function(c) { return '<option value="' + c.id + '"' + (d.costCenterId===c.id?' selected':'') + '>' + c.code + ' — ' + c.name + '</option>'; }).join('');
    var brandOpts = brands.map(function(b) { return '<option value="' + b.id + '"' + (d.brandId===b.id?' selected':'') + '>' + b.name + '</option>'; }).join('');
    document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل فرع' : 'إضافة فرع';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="brfID" value="' + (d.id||'') + '">' +
      '<div class="form-row"><label>البراند *</label><select class="form-control" id="brfBrand"><option value="">— اختر البراند —</option>' + brandOpts + '</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الرمز</label><input class="form-control" id="brfCode" value="' + (d.code||'') + '"></div>' +
        '<div class="form-row"><label>الاسم *</label><input class="form-control" id="brfName" value="' + (d.name||'') + '"></div>' +
      '</div>' +
      '<div class="form-row"><label>الموقع</label><input class="form-control" id="brfLocation" value="' + (d.location||'') + '"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>المستودع المرتبط</label><select class="form-control" id="brfWH"><option value="">— بدون —</option>' + whOpts + '</select></div>' +
        '<div class="form-row"><label>مركز التكلفة</label><select class="form-control" id="brfCC"><option value="">— بدون —</option>' + ccOpts + '</select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>المدير</label><input class="form-control" id="brfManager" value="' + (d.manager||'') + '"></div>' +
        '<div class="form-row"><label>إعدادات التوريد</label><select class="form-control" id="brfSupply"><option value="parent_company"' + (d.supplyMode==='parent_company'?' selected':'') + '>الشركة الأم</option><option value="warehouse"' + (d.supplyMode==='warehouse'?' selected':'') + '>المستودع الرئيسي</option><option value="auto"' + (d.supplyMode==='auto'?' selected':'') + '>تلقائي</option></select></div>' +
      '</div>' +
      '<div style="border-top:1px solid #e2e8f0;margin-top:14px;padding-top:14px;">' +
        '<h4 style="font-size:14px;font-weight:800;color:#1e293b;margin-bottom:10px;"><i class="fas fa-map-marker-alt" style="color:#ef4444;"></i> موقع الفرع (للبصمة)</h4>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">' +
          '<div class="form-row"><label>خط العرض (Lat)</label><input type="number" step="0.0000001" class="form-control" id="brfGeoLat" value="' + (d.geoLat||'') + '" placeholder="24.7136"></div>' +
          '<div class="form-row"><label>خط الطول (Lng)</label><input type="number" step="0.0000001" class="form-control" id="brfGeoLng" value="' + (d.geoLng||'') + '" placeholder="46.6753"></div>' +
          '<div class="form-row"><label>نطاق (متر)</label><input type="number" class="form-control" id="brfGeoRadius" value="' + (d.geoRadius||100) + '" placeholder="100"></div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button type="button" class="btn btn-sm btn-light" onclick="brfGetMyLocation()"><i class="fas fa-crosshairs"></i> تحديد موقعي (GPS)</button>' +
          '<button type="button" class="btn btn-sm" style="background:#4285f4;color:#fff;" onclick="brfOpenMap()"><i class="fas fa-map-marked-alt"></i> اختر من الخريطة</button>' +
        '</div>' +
        '<div id="brfMapContainer" style="display:none;margin-top:8px;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;height:250px;"></div>' +
      '</div>';
    document.getElementById('erpModalSaveBtn').onclick = erpSaveBranchFull;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}
function erpEditBranchFull(id) {
  window._apiBridge.withSuccessHandler(function(list) {
    var b = (list||[]).find(function(x){return x.id===id;});
    if (b) erpOpenBranchFullModal(b);
  }).getBranchesFull();
}
function brfGetMyLocation() {
  if (!navigator.geolocation) return showToast('المتصفح لا يدعم تحديد الموقع', true);
  showToast('جاري تحديد الموقع...');
  navigator.geolocation.getCurrentPosition(function(pos) {
    document.getElementById('brfGeoLat').value = pos.coords.latitude.toFixed(7);
    document.getElementById('brfGeoLng').value = pos.coords.longitude.toFixed(7);
    showToast('تم تحديد الموقع ✓');
  }, function() { showToast('فشل تحديد الموقع', true); }, {enableHighAccuracy:true, timeout:10000});
}

window.brfOpenMap = function() {
  var container = document.getElementById('brfMapContainer');
  var lat = Number(document.getElementById('brfGeoLat').value) || 24.7136;
  var lng = Number(document.getElementById('brfGeoLng').value) || 46.6753;
  if (container.style.display === 'none') {
    container.style.display = 'block';
    container.innerHTML = '<iframe id="brfMapFrame" style="width:100%;height:100%;border:0;" src="https://maps.google.com/maps?q='+lat+','+lng+'&z=17&output=embed"></iframe>' +
      '<div style="padding:8px;background:#fff;display:flex;gap:6px;align-items:center;">' +
        '<input type="number" step="0.0000001" class="form-control" id="brfMapLat" value="'+lat+'" placeholder="Lat" style="flex:1;font-size:12px;">' +
        '<input type="number" step="0.0000001" class="form-control" id="brfMapLng" value="'+lng+'" placeholder="Lng" style="flex:1;font-size:12px;">' +
        '<button class="btn btn-sm btn-primary" onclick="brfApplyMapCoords()" style="white-space:nowrap;">تطبيق</button>' +
        '<button class="btn btn-sm btn-light" onclick="brfRefreshMap()" style="white-space:nowrap;"><i class="fas fa-sync"></i></button>' +
      '</div>';
  } else {
    container.style.display = 'none';
  }
};
window.brfApplyMapCoords = function() {
  var lat = document.getElementById('brfMapLat').value;
  var lng = document.getElementById('brfMapLng').value;
  document.getElementById('brfGeoLat').value = lat;
  document.getElementById('brfGeoLng').value = lng;
  showToast('تم تحديث الإحداثيات');
  brfRefreshMap();
};
window.brfRefreshMap = function() {
  var lat = document.getElementById('brfMapLat').value || document.getElementById('brfGeoLat').value;
  var lng = document.getElementById('brfMapLng').value || document.getElementById('brfGeoLng').value;
  var f = document.getElementById('brfMapFrame');
  if (f) f.src = 'https://maps.google.com/maps?q='+lat+','+lng+'&z=17&output=embed';
};

function erpSaveBranchFull() {
  var data = {
    id: document.getElementById('brfID').value,
    brandId: (document.getElementById('brfBrand')||{}).value||'',
    code: document.getElementById('brfCode').value,
    name: document.getElementById('brfName').value,
    location: document.getElementById('brfLocation').value,
    warehouseId: document.getElementById('brfWH').value,
    costCenterId: document.getElementById('brfCC').value,
    manager: document.getElementById('brfManager').value,
    supplyMode: document.getElementById('brfSupply').value,
    geoLat: document.getElementById('brfGeoLat').value || null,
    geoLng: document.getElementById('brfGeoLng').value || null,
    geoRadius: Number(document.getElementById('brfGeoRadius').value) || 100
  };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحفظ'); erpCloseModal(); erpLoadBranchesFull(); } else showToast(r.error, true); }).saveBranchFull(data);
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
  var filters = {};
  var u = document.getElementById('erpAuditUser');
  var a = document.getElementById('erpAuditAction');
  if (u && u.value) filters.username = u.value;
  if (a && a.value) filters.entityType = a.value;

  window._apiBridge.withSuccessHandler(function(list) {
    var tbody = document.getElementById('erpAuditBody');
    if (!list || !list.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد سجلات</td></tr>'; return; }
    var actionLabels = {create_journal:'إنشاء قيد',approve_journal:'اعتماد قيد',post_journal:'ترحيل قيد',delete_journal:'حذف قيد',create_expense:'إنشاء مصروف',approve_expense:'اعتماد مصروف',create_shortage:'طلب نقص',approve_shortage:'اعتماد نقص',receive_approve:'اعتماد استلام'};
    tbody.innerHTML = list.map(function(l) {
      var dt = l.createdAt ? new Date(l.createdAt).toLocaleString('en-GB') : '';
      var details = '';
      try { var d = JSON.parse(l.details||'{}'); details = Object.keys(d).slice(0,3).map(function(k){ return k+': '+d[k]; }).join(', '); } catch(e) { details = (l.details||'').substring(0,60); }
      return '<tr>' +
        '<td style="font-size:12px;">' + dt + '</td>' +
        '<td style="font-weight:700;">' + (l.username||'') + '</td>' +
        '<td><span class="badge badge-blue">' + (actionLabels[l.action]||l.action) + '</span></td>' +
        '<td>' + (l.entityType||'') + '</td>' +
        '<td><code style="font-size:11px;">' + (l.entityId||'') + '</code></td>' +
        '<td style="font-size:11px;color:#64748b;max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + details + '</td></tr>';
    }).join('');
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

function erpOpenWarehouseModalLegacy(data) {
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
      }).saveWarehouseLegacy(d, currentUser);
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getBranches();
}

function erpEditWarehouse(id) {
  window._apiBridge.withSuccessHandler(function(list) {
    const wh = (list||[]).find(w => w.ID === id);
    if (wh) erpOpenWarehouseModalLegacy(wh);
  }).getWarehouses();
}

function erpDeleteWarehouse(id) {
  if (!confirm('هل أنت متأكد من حذف هذا المستودع؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(res) {
    loader(false);
    if (res.success) { showToast('تم حذف المستودع'); erpLoadWarehouses(); }
    else showToast(res.error, 'error');
  }).deleteWarehouseLegacy(id, currentUser);
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

function erpOpenTransferModalLegacy() {
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

// ═══════════════════════════════════════
// WORKFLOW ENGINE — نظام المعاملات الداخلية
// ═══════════════════════════════════════

// ─── المناصب (Positions) ───
var _wfPositions = [];
function wfLoadPositions() {
  var grid = document.getElementById('wfPositionsGrid');
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
  window._apiBridge.withSuccessHandler(function(list) {
    _wfPositions = list || [];
    if (!list.length) { grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;font-style:italic;">لا توجد مناصب — اضغط "منصب جديد"</div>'; return; }
    var maxLevel = Math.max.apply(null, list.map(function(p) { return p.level || 0; })) || 1;
    var btnS = 'width:32px;height:32px;border-radius:8px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;';
    grid.innerHTML = list.map(function(p) {
      var pct = Math.round(((p.level || 0) / maxLevel) * 100);
      return '<div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:16px;padding:18px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
          '<div style="font-size:15px;font-weight:800;color:#1e293b;"><i class="fas fa-id-badge" style="color:#3b82f6;margin-left:6px;"></i> ' + p.name + '</div>' +
          (p.isActive !== false ? '<span class="badge badge-green">فعال</span>' : '<span class="badge badge-red">معطل</span>') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
          '<span style="font-size:12px;font-weight:700;color:#64748b;white-space:nowrap;">المستوى ' + (p.level || 0) + '</span>' +
          '<div style="height:6px;border-radius:3px;background:#e2e8f0;flex:1;max-width:120px;overflow:hidden;"><div style="height:100%;border-radius:3px;background:linear-gradient(90deg,#3b82f6,#8b5cf6);width:' + pct + '%;"></div></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9;">' +
          '<span style="font-size:12px;color:#94a3b8;">الصلاحية: ' + (p.level||0) + '</span>' +
          '<div style="display:flex;gap:6px;">' +
            '<button style="' + btnS + '" onclick="wfEditPosition(\'' + p.id + '\')"><i class="fas fa-edit"></i></button>' +
            '<button style="' + btnS + 'color:#ef4444;" onclick="wfDeletePosition(\'' + p.id + '\')"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }).getWfPositions();
}

function wfOpenPositionModal(data) {
  var d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل منصب' : 'منصب جديد';
  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="wfPosId" value="' + (d.id || '') + '">' +
    '<div class="form-row"><label>اسم المنصب *</label><input class="form-control" id="wfPosName" value="' + (d.name || '') + '"></div>' +
    '<div class="form-row"><label>المستوى (الأعلى = أكثر صلاحية)</label><input type="number" class="form-control" id="wfPosLevel" value="' + (d.level || 0) + '" min="0" max="100"></div>';
  document.getElementById('erpModalSaveBtn').onclick = function() {
    var name = document.getElementById('wfPosName').value;
    if (!name) return showToast('اسم المنصب مطلوب', true);
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r.success) { showToast('تم الحفظ'); erpCloseModal(); wfLoadPositions(); }
      else showToast(r.error, true);
    }).saveWfPosition({ id: document.getElementById('wfPosId').value || undefined, name: name, level: Number(document.getElementById('wfPosLevel').value) || 0 });
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function wfEditPosition(id) {
  var p = _wfPositions.find(function(x) { return x.id === id; });
  if (p) wfOpenPositionModal(p);
}

function wfDeletePosition(id) {
  if (!confirm('حذف هذا المنصب؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم الحذف'); wfLoadPositions(); }
    else showToast(r.error, true);
  }).deleteWfPosition(id);
}

// ─── أنواع المعاملات (Transaction Types) ───
var _wfTypes = [];
function wfLoadTypes() {
  var grid = document.getElementById('wfTypesGrid');
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
  window._apiBridge.withSuccessHandler(function(list) {
    _wfTypes = list || [];
    if (!list.length) { grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;font-style:italic;">لا توجد أنواع — اضغط "نوع جديد"</div>'; return; }
    var icons = { EXPENSE: 'fa-money-bill-wave', PURCHASE: 'fa-shopping-cart', ASSET: 'fa-building', PAYMENT: 'fa-credit-card' };
    var colors = { EXPENSE: '#dc2626', PURCHASE: '#2563eb', ASSET: '#7c3aed', PAYMENT: '#059669' };
    grid.innerHTML = list.map(function(t) {
      var icon = icons[t.code] || 'fa-file-alt';
      var color = colors[t.code] || '#2563eb';
      return '<div style="display:flex;align-items:center;gap:14px;padding:18px;border:1.5px solid #e2e8f0;border-radius:16px;background:#fff;">' +
        '<div style="width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:' + color + '15;color:' + color + ';"><i class="fas ' + icon + '"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:15px;font-weight:800;color:#1e293b;">' + t.name + '</div>' +
          '<div style="font-size:12px;color:#94a3b8;font-family:monospace;margin-top:2px;">' + (t.code || '') + '</div>' +
        '</div>' +
        (t.isActive !== false ? '<span class="badge badge-green">فعال</span>' : '<span class="badge badge-red">معطل</span>') +
        ' <button class="btn-icon" style="margin-right:8px;" onclick="wfEditType(\'' + t.id + '\')"><i class="fas fa-edit"></i></button>' +
      '</div>';
    }).join('');
  }).getWfTypes();
}

function wfOpenTypeModal(data) {
  var d = data || {};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل نوع معاملة' : 'نوع معاملة جديد';
  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="wfTypeId" value="' + (d.id || '') + '">' +
    '<div class="form-row"><label>اسم النوع *</label><input class="form-control" id="wfTypeName" value="' + (d.name || '') + '"></div>' +
    '<div class="form-row"><label>الرمز *</label><input class="form-control" id="wfTypeCode" value="' + (d.code || '') + '" placeholder="مثال: EXPENSE, PURCHASE"></div>';
  document.getElementById('erpModalSaveBtn').onclick = function() {
    var name = document.getElementById('wfTypeName').value;
    var code = document.getElementById('wfTypeCode').value;
    if (!name || !code) return showToast('الاسم والرمز مطلوبان', true);
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) {
      loader(false);
      if (r.success) { showToast('تم الحفظ'); erpCloseModal(); wfLoadTypes(); }
      else showToast(r.error, true);
    }).saveWfType({ id: document.getElementById('wfTypeId').value || undefined, name: name, code: code });
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function wfEditType(id) {
  var t = _wfTypes.find(function(x) { return x.id === id; });
  if (t) wfOpenTypeModal(t);
}

// ─── خطوات سير العمل (Workflow Definitions) ───
var _wfDefs = [];
function wfInitDefs() {
  // Populate the type filter dropdown
  var sel = document.getElementById('wfDefsTypeFilter');
  window._apiBridge.withSuccessHandler(function(types) {
    _wfTypes = types || [];
    // Keep existing value
    var curVal = sel.value;
    sel.innerHTML = '<option value="">— اختر نوع المعاملة —</option>';
    types.forEach(function(t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name + ' (' + t.code + ')';
      sel.appendChild(opt);
    });
    if (curVal) { sel.value = curVal; wfLoadDefs(); }
  }).getWfTypes();
}

function wfLoadDefs() {
  var typeId = document.getElementById('wfDefsTypeFilter').value;
  var container = document.getElementById('wfDefsContainer');
  if (!typeId) { container.innerHTML = '<div class="wf-pipeline-empty">اختر نوع المعاملة أولاً</div>'; return; }
  container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
  window._apiBridge.withSuccessHandler(function(list) {
    _wfDefs = list || [];
    if (!list.length) { container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;font-style:italic;background:#f8fafc;border-radius:14px;border:1px dashed #e2e8f0;">لا توجد خطوات — اضغط "خطوة جديدة"</div>'; return; }
    var circleS = 'width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;position:relative;z-index:1;';
    var bodyS = 'text-align:center;margin-top:10px;padding:12px 14px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;min-width:140px;box-shadow:0 2px 8px rgba(0,0,0,0.02);';
    var permOn = 'width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:#dcfce7;color:#16a34a;';
    var permOff = 'width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:#f1f5f9;color:#cbd5e1;';
    var sBtn = 'width:28px;height:28px;border-radius:6px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;font-size:12px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;';
    var html = '<div style="display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:20px 10px;">';
    list.forEach(function(w, i) {
      if (i > 0) html += '<div style="display:flex;align-items:center;padding-top:14px;color:#94a3b8;font-size:18px;min-width:32px;justify-content:center;"><i class="fas fa-chevron-left"></i></div>';
      var cBg = w.isFinal ? 'linear-gradient(135deg,#f0fdf4,#dcfce7)' : 'linear-gradient(135deg,#eff6ff,#dbeafe)';
      var cBorder = w.isFinal ? '2.5px solid #86efac' : '2.5px solid #93c5fd';
      var cColor = w.isFinal ? '#166534' : '#1e40af';
      html += '<div style="display:flex;flex-direction:column;align-items:center;min-width:160px;max-width:200px;flex-shrink:0;">' +
        '<div style="' + circleS + 'background:' + cBg + ';border:' + cBorder + ';color:' + cColor + ';">' + w.stepOrder + '</div>' +
        '<div style="' + bodyS + '">' +
          '<div style="font-size:13px;font-weight:800;color:#1e293b;margin-bottom:6px;">' + w.stepName + '</div>' +
          '<div style="font-size:11.5px;color:#64748b;font-weight:600;">' + (w.positionName || 'أي منصب') + '</div>' +
          '<div style="display:flex;gap:4px;justify-content:center;margin-top:6px;">' +
            '<div style="' + (w.canEditAmount ? permOn : permOff) + '" title="تعديل المبلغ"><i class="fas fa-edit"></i></div>' +
            '<div style="' + (w.canReturn ? permOn : permOff) + '" title="إرجاع"><i class="fas fa-undo"></i></div>' +
            (w.isFinal ? '<div style="' + permOn + '" title="نهائية"><i class="fas fa-flag-checkered"></i></div>' : '') +
          '</div>' +
          '<div style="display:flex;gap:4px;justify-content:center;margin-top:8px;">' +
            '<button style="' + sBtn + '" onclick="wfEditDef(\'' + w.id + '\')"><i class="fas fa-edit"></i></button>' +
            '<button style="' + sBtn + 'color:#ef4444;" onclick="wfDeleteDef(\'' + w.id + '\')"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
  }).getWfDefs(typeId);
}

function wfOpenDefModal(data) {
  var d = data || {};
  var typeId = document.getElementById('wfDefsTypeFilter').value;
  if (!typeId && !d.id) return showToast('اختر نوع المعاملة أولاً', true);
  // Load positions for dropdown
  window._apiBridge.withSuccessHandler(function(positions) {
    var posOpts = (positions || []).map(function(p) {
      return '<option value="' + p.id + '"' + (d.positionId === p.id ? ' selected' : '') + '>' + p.name + ' (مستوى ' + p.level + ')</option>';
    }).join('');
    document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل خطوة' : 'خطوة جديدة';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="wfDefId" value="' + (d.id || '') + '">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>ترتيب الخطوة *</label><input type="number" class="form-control" id="wfDefOrder" value="' + (d.stepOrder || (_wfDefs.length + 1)) + '" min="1"></div>' +
        '<div class="form-row"><label>اسم الخطوة *</label><input class="form-control" id="wfDefName" value="' + (d.stepName || '') + '"></div>' +
      '</div>' +
      '<div class="form-row"><label>المنصب المطلوب للموافقة</label><select class="form-control" id="wfDefPosition"><option value="">— أي منصب —</option>' + posOpts + '</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">' +
        '<div class="form-row"><label><input type="checkbox" id="wfDefEditAmt" ' + (d.canEditAmount ? 'checked' : '') + '> السماح بتعديل المبلغ</label></div>' +
        '<div class="form-row"><label><input type="checkbox" id="wfDefReturn" ' + (d.canReturn !== false ? 'checked' : '') + '> السماح بالإرجاع للخطوة السابقة</label></div>' +
        '<div class="form-row"><label><input type="checkbox" id="wfDefFinal" ' + (d.isFinal ? 'checked' : '') + '> خطوة نهائية (إغلاق تلقائي)</label></div>' +
      '</div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var stepName = document.getElementById('wfDefName').value;
      if (!stepName) return showToast('اسم الخطوة مطلوب', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) { showToast('تم الحفظ'); erpCloseModal(); wfLoadDefs(); }
        else showToast(r.error, true);
      }).saveWfDef({
        id: document.getElementById('wfDefId').value || undefined,
        transactionTypeId: typeId,
        stepOrder: Number(document.getElementById('wfDefOrder').value) || 1,
        stepName: stepName,
        positionId: document.getElementById('wfDefPosition').value || null,
        canEditAmount: document.getElementById('wfDefEditAmt').checked,
        canReturn: document.getElementById('wfDefReturn').checked,
        isFinal: document.getElementById('wfDefFinal').checked
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getWfPositions();
}

function wfEditDef(id) {
  var d = _wfDefs.find(function(x) { return x.id === id; });
  if (d) wfOpenDefModal(d);
}

function wfDeleteDef(id) {
  if (!confirm('حذف هذه الخطوة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم الحذف'); wfLoadDefs(); }
    else showToast(r.error, true);
  }).deleteWfDef(id);
}

// ─── صندوق المعاملات (Transaction Inbox) ───
function wfLoadInbox() {
  var tb = document.getElementById('wfInboxBody');
  tb.innerHTML = '<tr><td colspan="9" class="empty-msg"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</td></tr>';
  var status = (document.getElementById('wfInboxStatusFilter') || {}).value || '';
  var params = {};
  if (status) params.status = status;
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list || !list.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty-msg">لا توجد معاملات</td></tr>';
      document.getElementById('wfInboxStats').innerHTML = '';
      return;
    }
    // Build stats bar
    var counts = { pending: 0, in_progress: 0, approved: 0, rejected: 0, closed: 0 };
    var statusLabelsAr = { pending: 'قيد الانتظار', in_progress: 'قيد التنفيذ', approved: 'معتمدة', rejected: 'مرفوضة', closed: 'مغلقة' };
    list.forEach(function(t) { if (counts.hasOwnProperty(t.status)) counts[t.status]++; });
    var dotClrs = { pending: '#f59e0b', in_progress: '#3b82f6', approved: '#10b981', rejected: '#ef4444', closed: '#6b7280' };
    var statsHtml = '';
    Object.keys(counts).forEach(function(k) {
      statsHtml += '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;font-weight:700;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + (dotClrs[k]||'#94a3b8') + ';flex-shrink:0;"></span>' +
        '<span>' + statusLabelsAr[k] + '</span><span style="font-weight:900;color:#0f172a;">' + counts[k] + '</span></div>';
    });
    document.getElementById('wfInboxStats').innerHTML = statsHtml;

    var statusColors = { pending: 'yellow', in_progress: 'blue', approved: 'green', rejected: 'red', closed: 'gray' };
    var dotColors = { pending: '#f59e0b', in_progress: '#3b82f6', approved: '#10b981', rejected: '#ef4444', closed: '#6b7280' };
    tb.innerHTML = list.map(function(t) {
      var dt = t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : '';
      var canAct = t.status === 'pending' || t.status === 'in_progress';
      var actions = '<div class="wf-inbox-actions">' +
        '<button class="btn btn-sm btn-light" onclick="wfViewTxn(\'' + t.id + '\')"><i class="fas fa-eye"></i></button>';
      if (canAct) {
        actions += '<button class="btn btn-sm btn-success" onclick="wfTxnAction(\'' + t.id + '\',\'approve\')" title="موافقة"><i class="fas fa-check"></i></button>';
        actions += '<button class="btn btn-sm btn-danger" onclick="wfTxnAction(\'' + t.id + '\',\'reject\')" title="رفض"><i class="fas fa-times"></i></button>';
        actions += '<button class="btn btn-sm" style="background:#fef3c7;color:#92400e;" onclick="wfTxnAction(\'' + t.id + '\',\'return\')" title="إرجاع"><i class="fas fa-undo"></i></button>';
        actions += '<button class="btn btn-sm" style="background:#f3e8ff;color:#7c3aed;" onclick="wfForwardTxn(\'' + t.id + '\')" title="تحويل"><i class="fas fa-share"></i></button>';
      }
      actions += '</div>';
      return '<tr class="wf-inbox-row">' +
        '<td><span class="wf-status-dot" style="background:' + (dotColors[t.status]||'#94a3b8') + ';"></span> <span class="badge badge-' + (statusColors[t.status]||'blue') + '">' + (statusLabelsAr[t.status]||t.status) + '</span></td>' +
        '<td><span class="wf-txn-number">' + (t.txnNumber||'') + '</span></td>' +
        '<td><span class="badge badge-blue">' + (t.typeName||'') + '</span></td>' +
        '<td style="font-weight:700;max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + t.title + '</td>' +
        '<td style="font-size:12px;">' + (t.createdBy||'') + '</td>' +
        '<td><span class="wf-txn-amount">' + (Number(t.amount)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</span></td>' +
        '<td>' + (t.currentStepName||'—') + '</td>' +
        '<td>' + (t.currentPositionName||'—') + '</td>' +
        '<td style="font-size:12px;color:#64748b;">' + dt + '</td>' +
        '<td>' + actions + '</td>' +
      '</tr>';
    }).join('');
  }).getWfTransactions(params);
}

function wfOpenNewTxnModal() {
  // Load transaction types and branches
  Promise.all([
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getWfTypes(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getBranchesFull(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getBrands(); })
  ]).then(function(results) {
    var types = results[0] || [], branches = results[1] || [], brands = results[2] || [];
    var typeOpts = types.map(function(t) { return '<option value="' + t.id + '">' + t.name + '</option>'; }).join('');
    var branchOpts = branches.map(function(b) { return '<option value="' + b.id + '">' + b.name + '</option>'; }).join('');
    var brandOpts = brands.map(function(b) { return '<option value="' + b.id + '">' + b.name + '</option>'; }).join('');
    document.getElementById('erpModalTitle').textContent = 'معاملة جديدة';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="form-row"><label>نوع المعاملة *</label><select class="form-control" id="wfNewType">' + typeOpts + '</select></div>' +
      '<div class="form-row"><label>العنوان *</label><input class="form-control" id="wfNewTitle" placeholder="وصف مختصر للمعاملة"></div>' +
      '<div class="form-row"><label>التفاصيل</label><textarea class="form-control" id="wfNewDesc" rows="3" placeholder="تفاصيل إضافية (اختياري)"></textarea></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>المبلغ</label><input type="number" class="form-control" id="wfNewAmount" step="0.01" min="0" value="0"></div>' +
        '<div class="form-row"><label>البراند</label><select class="form-control" id="wfNewBrand"><option value="">— اختياري —</option>' + brandOpts + '</select></div>' +
      '</div>' +
      '<div class="form-row"><label>الفرع</label><select class="form-control" id="wfNewBranch"><option value="">— اختياري —</option>' + branchOpts + '</select></div>' +
      '<div class="form-row"><label>مرفق (رابط أو وصف)</label><input class="form-control" id="wfNewAttach" placeholder="اختياري"></div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var title = document.getElementById('wfNewTitle').value;
      var typeId = document.getElementById('wfNewType').value;
      if (!title) return showToast('العنوان مطلوب', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) {
          showToast('تم إنشاء المعاملة: ' + (r.txnNumber || ''));
          erpCloseModal();
          wfLoadInbox();
        } else showToast(r.error, true);
      }).createWfTransaction({
        transactionTypeId: typeId,
        title: title,
        description: document.getElementById('wfNewDesc').value,
        amount: Number(document.getElementById('wfNewAmount').value) || 0,
        brandId: document.getElementById('wfNewBrand').value || null,
        branchId: document.getElementById('wfNewBranch').value || null,
        attachment: document.getElementById('wfNewAttach').value || null,
        username: currentUser
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function wfViewTxn(id) {
  loader(true);
  window._apiBridge.withSuccessHandler(function(txn) {
    loader(false);
    if (txn.error) return showToast(txn.error, true);
    var sMap = { pending:'قيد الانتظار', in_progress:'قيد التنفيذ', approved:'معتمدة', rejected:'مرفوضة', closed:'مغلقة' };
    var sClr = { pending:'#f59e0b', in_progress:'#0ea5e9', approved:'#10b981', rejected:'#ef4444', closed:'#6b7280' };
    var aMap = { create:'إنشاء', approve:'موافقة', reject:'رفض', return:'إرجاع', close:'إغلاق', forward:'تحويل' };
    var aClr = { create:'#0ea5e9', approve:'#10b981', reject:'#ef4444', return:'#f59e0b', close:'#6b7280', forward:'#8b5cf6' };
    var aIcon = { create:'fa-plus-circle', approve:'fa-check-circle', reject:'fa-times-circle', return:'fa-undo', close:'fa-lock', forward:'fa-share' };
    var sc = sClr[txn.status]||'#6b7280';

    // Status banner
    var html = '<div style="padding:12px;border-radius:12px;background:'+sc+'15;border:1px solid '+sc+'30;text-align:center;margin-bottom:14px;"><span style="font-size:14px;font-weight:800;color:'+sc+';"><i class="fas fa-circle" style="font-size:8px;margin-left:6px;"></i> '+(sMap[txn.status]||txn.status)+'</span></div>';

    // Info grid
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">';
    var f = function(l,v,c) { return '<div style="padding:8px 12px;background:#f8fafc;border-radius:8px;"><span style="font-size:11px;color:#94a3b8;display:block;">'+l+'</span><span style="font-size:13px;font-weight:700;color:'+(c||'#1e293b')+';">'+v+'</span></div>'; };
    html += f('رقم المعاملة', txn.txnNumber||'');
    html += f('النوع', txn.typeName||'');
    html += f('المرسل', (txn.senderName||txn.createdBy||'')+(txn.senderPosition?' — <span style="color:#0ea5e9;">'+txn.senderPosition+'</span>':''));
    html += f('المبلغ', Number(txn.amount||0).toLocaleString('en',{minimumFractionDigits:2}), '#1e40af');
    if (txn.accountName) html += f('الحساب المحاسبي', (txn.accountCode||'')+' — '+txn.accountName);
    if (txn.costCenterName) html += f('مركز التكلفة', txn.costCenterName);
    if (txn.recipientUsername) html += f('المستلم', txn.recipientUsername);
    html += f('التاريخ', txn.createdAt ? new Date(txn.createdAt).toLocaleDateString('ar-SA',{day:'numeric',month:'long',year:'numeric'}) : '');
    html += '</div>';

    if (txn.description) html += '<div style="padding:10px 14px;border-radius:10px;background:#f1f5f9;font-size:13px;color:#475569;margin-bottom:12px;">'+txn.description+'</div>';
    if (txn.attachment && typeof txn.attachment === 'string' && txn.attachment.startsWith('data:')) {
      html += '<a href="'+txn.attachment+'" download style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:12px;font-weight:700;margin-bottom:12px;text-decoration:none;"><i class="fas fa-download"></i> تحميل مرفق المعاملة</a>';
    }

    // Timeline
    html += '<div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:8px;"><div style="font-size:14px;font-weight:800;color:#1e293b;margin-bottom:10px;"><i class="fas fa-route" style="color:#0ea5e9;margin-left:6px;"></i> سير المعاملة</div>';
    if (txn.logs && txn.logs.length) {
      txn.logs.forEach(function(l, i) {
        var c = aClr[l.actionType]||'#6b7280';
        var icon = aIcon[l.actionType]||'fa-circle';
        var dt = l.createdAt ? new Date(l.createdAt).toLocaleString('ar-SA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
        var isLast = i === txn.logs.length - 1;
        html += '<div style="display:flex;gap:12px;position:relative;">';
        html += '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;"><div style="width:32px;height:32px;border-radius:50%;background:'+c+'15;display:flex;align-items:center;justify-content:center;"><i class="fas '+icon+'" style="font-size:14px;color:'+c+';"></i></div>';
        if (!isLast) html += '<div style="width:2px;flex:1;background:'+c+'25;min-height:16px;"></div>';
        html += '</div>';
        html += '<div style="flex:1;padding-bottom:'+(isLast?'0':'14')+'px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-weight:800;color:'+c+';font-size:13px;">'+(aMap[l.actionType]||l.actionType)+'</span><span style="font-size:11px;color:#94a3b8;">'+dt+'</span></div>';
        html += '<div style="font-size:12px;color:#64748b;margin-top:2px;">'+(l.actionBy||'')+(l.positionName?' — <span style="font-weight:700;color:#1e40af;">'+l.positionName+'</span>':'')+'</div>';
        if (l.note) html += '<div style="margin-top:4px;padding:6px 10px;border-radius:8px;background:#f1f5f9;font-size:12px;color:#334155;">'+l.note+'</div>';
        if (l.attachment && typeof l.attachment === 'string' && l.attachment.startsWith('data:')) html += '<a href="'+l.attachment+'" download style="display:inline-flex;align-items:center;gap:4px;margin-top:4px;font-size:11px;color:#0ea5e9;font-weight:700;"><i class="fas fa-paperclip"></i> مرفق</a>';
        html += '</div></div>';
      });
    } else { html += '<p style="color:#94a3b8;text-align:center;font-size:13px;">لا توجد إجراءات بعد</p>'; }
    html += '</div>';

    document.getElementById('erpModalTitle').textContent = txn.txnNumber || 'تفاصيل المعاملة';
    document.getElementById('erpModalBody').innerHTML = html;
    document.getElementById('erpModalSaveBtn').style.display = 'none';
    document.getElementById('erpModal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('erpModalSaveBtn').style.display = ''; }, 100);
  }).getWfTransaction(id);
}

function wfTxnAction(id, action) {
  var actionNames = { approve: 'الموافقة على', reject: 'رفض', return: 'إرجاع', close: 'إغلاق' };
  var aClrs = { approve: '#16a34a', reject: '#ef4444', return: '#f59e0b', close: '#6b7280' };
  var aIcons = { approve: 'fa-check-circle', reject: 'fa-times-circle', return: 'fa-undo', close: 'fa-lock' };

  // Show action dialog with note + attachment
  var dlgId = 'wfActionDlg';
  var old = document.getElementById(dlgId); if (old) old.remove();
  var div = document.createElement('div');
  div.id = dlgId;
  div.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
  div.innerHTML =
    '<div style="background:#fff;border-radius:16px;padding:24px;width:440px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,.15);">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
        '<div style="width:40px;height:40px;border-radius:50%;background:'+(aClrs[action]||'#6b7280')+'15;display:flex;align-items:center;justify-content:center;"><i class="fas '+(aIcons[action]||'fa-cog')+'" style="color:'+(aClrs[action]||'#6b7280')+';"></i></div>' +
        '<h3 style="margin:0;font-size:16px;">'+(actionNames[action]||action)+' المعاملة</h3>' +
      '</div>' +
      '<div style="margin-bottom:12px;"><label style="font-size:12px;font-weight:700;color:#475569;">التعليق '+(action==='reject'?'(مطلوب) *':'(اختياري)')+'</label><textarea id="wfActNote" rows="3" style="width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;resize:none;margin-top:4px;" placeholder="اكتب تعليقك هنا..."></textarea></div>' +
      '<div style="margin-bottom:16px;"><label style="font-size:12px;font-weight:700;color:#475569;">مرفق (اختياري)</label><input type="file" id="wfActFile" accept=".pdf,.jpg,.jpeg,.png" style="width:100%;padding:8px;border:1.5px solid #e5e7eb;border-radius:10px;margin-top:4px;font-size:13px;"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button id="wfActOk" style="padding:10px 24px;border-radius:10px;border:none;background:'+(aClrs[action]||'#6b7280')+';color:#fff;font-weight:800;font-size:14px;cursor:pointer;">'+(actionNames[action]||action)+'</button>' +
        '<button id="wfActCancel" style="padding:10px 20px;border-radius:10px;border:2px solid #e5e7eb;background:#fff;color:#64748b;font-weight:700;font-size:14px;cursor:pointer;">إلغاء</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(div);
  div.querySelector('#wfActCancel').onclick = function() { div.remove(); };
  div.addEventListener('click', function(e) { if (e.target === div) div.remove(); });

  div.querySelector('#wfActOk').onclick = function() {
    var note = document.getElementById('wfActNote').value;
    if (action === 'reject' && !note) { showToast('سبب الرفض مطلوب', true); return; }
    var fileInput = document.getElementById('wfActFile');
    var doSend = function(attachment) {
      div.remove();
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) {
          var statusLabels = { pending: 'قيد الانتظار', in_progress: 'قيد التنفيذ', approved: 'معتمدة', rejected: 'مرفوضة', closed: 'مغلقة' };
          showToast('تم — الحالة الجديدة: ' + (statusLabels[r.newStatus] || r.newStatus));
          wfLoadInbox();
        } else showToast(r.error, true);
      }).wfTransactionAction(id, { action: action, username: currentUser, note: note, attachment: attachment || '' });
    };
    if (fileInput.files && fileInput.files[0]) {
      var r = new FileReader(); r.onload = function(e) { doSend(e.target.result); }; r.readAsDataURL(fileInput.files[0]);
    } else doSend('');
  };
}

// ═══════════════════════════════════════
// HR MODULE — نظام الموارد البشرية
// ═══════════════════════════════════════

// Forward transaction to another user
function wfForwardTxn(id) {
  // Load eligible users for forwarding
  fetch('/api/workflow/eligible-users', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r) { return r.json(); })
    .then(function(users) {
      var dlgId = 'wfForwardDlg';
      var old = document.getElementById(dlgId); if (old) old.remove();
      var div = document.createElement('div');
      div.id = dlgId;
      div.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
      div.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:24px;width:440px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,.15);">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;"><div style="width:40px;height:40px;border-radius:50%;background:#f3e8ff;display:flex;align-items:center;justify-content:center;"><i class="fas fa-share" style="color:#7c3aed;"></i></div><h3 style="margin:0;">تحويل المعاملة</h3></div>' +
          '<div style="margin-bottom:12px;"><label style="font-size:12px;font-weight:700;color:#475569;">تحويل إلى *</label><select id="wfFwdUser" style="width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-top:4px;"><option value="">— اختر —</option>' +
          (users||[]).map(function(u) { return '<option value="' + u.username + '">' + (u.fullName||u.username) + ' — ' + (u.positionName||'') + '</option>'; }).join('') +
          '</select></div>' +
          '<div style="margin-bottom:16px;"><label style="font-size:12px;font-weight:700;color:#475569;">ملاحظة (اختياري)</label><textarea id="wfFwdNote" rows="2" style="width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;resize:none;margin-top:4px;"></textarea></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="wfFwdOk" style="padding:10px 24px;border-radius:10px;border:none;background:#7c3aed;color:#fff;font-weight:800;font-size:14px;cursor:pointer;">تحويل</button>' +
            '<button onclick="document.getElementById(\'wfForwardDlg\').remove()" style="padding:10px 20px;border-radius:10px;border:2px solid #e5e7eb;background:#fff;color:#64748b;font-weight:700;cursor:pointer;">إلغاء</button>' +
          '</div></div>';
      document.body.appendChild(div);
      div.addEventListener('click', function(e) { if (e.target === div) div.remove(); });
      document.getElementById('wfFwdOk').onclick = function() {
        var forwardTo = document.getElementById('wfFwdUser').value;
        if (!forwardTo) return showToast('اختر المستلم', true);
        var note = document.getElementById('wfFwdNote').value || '';
        div.remove();
        loader(true);
        window._apiBridge.withSuccessHandler(function(r) {
          loader(false);
          if (r.success) { showToast('تم تحويل المعاملة'); wfLoadInbox(); }
          else showToast(r.error, true);
        }).wfTransactionAction(id, { action: 'forward', username: currentUser, note: 'تحويل إلى ' + forwardTo + (note ? ' — ' + note : ''), forwardTo: forwardTo });
      };
    });
}

function _hrStatCard(bg, iconBg, iconClr, icon, label, value) {
  return '<div style="background:' + bg + ';border:1px solid ' + iconBg + ';border-radius:16px;padding:20px;display:flex;align-items:center;gap:14px;">' +
    '<div style="width:48px;height:48px;border-radius:14px;background:' + iconBg + ';color:' + iconClr + ';display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;"><i class="fas ' + icon + '"></i></div>' +
    '<div><div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:4px;">' + label + '</div><div style="font-size:26px;font-weight:900;color:#0f172a;">' + value + '</div></div></div>';
}

// ─── Dashboard ───
function hrLoadDashboard() {
  // Load KPIs from new endpoint
  window._apiBridge.withSuccessHandler(function(d) {
    document.getElementById('hrDashStats').innerHTML =
      _hrStatCard('linear-gradient(135deg,#eff6ff,#dbeafe)','#dbeafe','#1e40af','fa-users','إجمالي النشطين', d.totalActive||0) +
      _hrStatCard('linear-gradient(135deg,#f0fdf4,#dcfce7)','#dcfce7','#166534','fa-user-check','الحاضرون اليوم', d.presentToday||0) +
      _hrStatCard('linear-gradient(135deg,#fef2f2,#fee2e2)','#fee2e2','#991b1b','fa-user-times','الغائبون اليوم', d.absentToday||0) +
      _hrStatCard('linear-gradient(135deg,#eff6ff,#dbeafe)','#dbeafe','#1e40af','fa-umbrella-beach','في إجازة', d.onLeaveToday||0);

    // Second row KPIs
    var extraStats = document.getElementById('hrDashExtraStats');
    if (!extraStats) {
      extraStats = document.createElement('div');
      extraStats.id = 'hrDashExtraStats';
      extraStats.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;';
      document.getElementById('hrDashStats').parentNode.insertBefore(extraStats, document.getElementById('hrDashStats').nextSibling);
    }
    extraStats.innerHTML =
      _hrStatCard('linear-gradient(135deg,#fef3c7,#fde68a)','#fde68a','#92400e','fa-clock','متأخرون اليوم', d.lateToday||0) +
      _hrStatCard('linear-gradient(135deg,#fef3c7,#fde68a)','#fde68a','#92400e','fa-business-time','ساعات إضافي الشهر', (d.monthOvertimeHours||0).toFixed(1)) +
      _hrStatCard('linear-gradient(135deg,#faf5ff,#f3e8ff)','#f3e8ff','#7c3aed','fa-hourglass-half','إضافي معلّق', d.pendingOT||0) +
      _hrStatCard('linear-gradient(135deg,#fef2f2,#fee2e2)','#fee2e2','#991b1b','fa-clock','ساعات تأخير الشهر', (d.monthLateHours||0).toFixed(1));

    // Attendance breakdown
    document.getElementById('hrDashAttendance').innerHTML =
      '<div style="display:flex;gap:16px;flex-wrap:wrap;">' +
        '<div><span style="font-size:24px;font-weight:900;color:#16a34a;">' + (d.presentToday||0) + '</span> <span style="color:#64748b;">حاضر</span></div>' +
        '<div><span style="font-size:24px;font-weight:900;color:#ef4444;">' + (d.absentToday||0) + '</span> <span style="color:#64748b;">غائب</span></div>' +
        '<div><span style="font-size:24px;font-weight:900;color:#f59e0b;">' + (d.lateToday||0) + '</span> <span style="color:#64748b;">متأخر</span></div>' +
        '<div><span style="font-size:24px;font-weight:900;color:#0ea5e9;">' + (d.onLeaveToday||0) + '</span> <span style="color:#64748b;">إجازة</span></div>' +
      '</div>';
  }).getHrDashboardV2();

  // Load alerts from new endpoint
  window._apiBridge.withSuccessHandler(function(alerts) {
    var html = '';
    if (!alerts || !alerts.length) {
      html = '<div style="color:#94a3b8;text-align:center;padding:20px;">لا توجد تنبيهات 🎉</div>';
    } else {
      html = alerts.map(function(a) {
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:'+(a.color||'#94a3b8')+'15;border-right:4px solid '+(a.color||'#94a3b8')+';border-radius:8px;font-size:13px;margin-bottom:6px;">' +
          '<i class="fas '+(a.icon||'fa-info-circle')+'" style="color:'+(a.color||'#94a3b8')+';"></i>' +
          '<span>'+a.title+'</span></div>';
      }).join('');
    }
    document.getElementById('hrDashAlerts').innerHTML = html;
  }).getHrDashboardAlerts();
}

// ─── Employees ───
var _hrEmployees = [];
function hrLoadEmployees() {
  var tb = document.getElementById('hrEmployeesBody');
  tb.innerHTML = '<tr><td colspan="8" class="empty-msg"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</td></tr>';
  var params = {};
  var st = (document.getElementById('hrEmpStatusFilter')||{}).value;
  if (st) params.status = st;
  window._apiBridge.withSuccessHandler(function(list) {
    _hrEmployees = list || [];
    hrRenderEmployees(list);
  }).getHrEmployees(params);
}

function hrFilterEmployees() {
  var q = (document.getElementById('hrEmpSearch').value||'').toLowerCase();
  var filtered = _hrEmployees.filter(function(e) {
    return !q || (e.fullName||'').toLowerCase().indexOf(q)>=0 || (e.employeeNumber||'').toLowerCase().indexOf(q)>=0;
  });
  hrRenderEmployees(filtered);
}

function hrRenderEmployees(list) {
  var tb = document.getElementById('hrEmployeesBody');
  if (!list||!list.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-msg">لا يوجد موظفون</td></tr>'; return; }
  var statusLabels = {active:'نشط',suspended:'مجمد',terminated:'منتهي',on_leave:'في إجازة'};
  var statusColors = {active:'green',suspended:'orange',terminated:'red',on_leave:'blue'};
  var btnS = 'width:32px;height:32px;border-radius:8px;border:1px solid #e2e8f0;background:#f8fafc;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;';
  tb.innerHTML = list.map(function(e) {
    return '<tr>' +
      '<td><code style="font-weight:700;">' + (e.employeeNumber||'') + '</code></td>' +
      '<td style="font-weight:800;color:#1e293b;">' + (e.fullName||'') + '</td>' +
      '<td>' + (e.jobTitle||'—') + '</td>' +
      '<td>' + (e.departmentName||'—') + '</td>' +
      '<td>' + (e.branchName||'—') + '</td>' +
      '<td style="font-weight:700;color:#1e40af;">' + (Number(e.basicSalary)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</td>' +
      '<td><span class="badge badge-' + (statusColors[e.status]||'blue') + '">' + (statusLabels[e.status]||e.status) + '</span></td>' +
      '<td><div style="display:flex;gap:4px;">' +
        '<button style="' + btnS + 'color:#3b82f6;" onclick="hrViewEmployee(\'' + e.id + '\')" title="عرض الملف"><i class="fas fa-eye"></i></button>' +
        '<button style="' + btnS + 'color:#f59e0b;" onclick="hrEditEmployee(\'' + e.id + '\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
        (e.status === 'active' ? '<button style="' + btnS + (e.ignoreLateMonth===new Date().toISOString().slice(0,7)?'background:#dcfce7;border-color:#86efac;':'') + 'color:#f59e0b;" onclick="hrToggleIgnoreLate(\'' + e.id + '\',\'' + (e.fullName||'').replace(/'/g,'') + '\')" title="' + (e.ignoreLateMonth===new Date().toISOString().slice(0,7)?'إلغاء تجاهل التأخير':'تجاهل التأخير هذا الشهر') + '"><i class="fas fa-clock"></i></button>' : '') +
        (e.status === 'active' ? '<button style="' + btnS + 'color:#ef4444;" onclick="hrTerminateEmployee(\'' + e.id + '\')" title="إنهاء خدمة"><i class="fas fa-user-slash"></i></button>' : '') +
        (e.status === 'suspended' ? '<button style="' + btnS + 'color:#10b981;" onclick="hrActivateEmployee(\'' + e.id + '\')" title="تنشيط"><i class="fas fa-play-circle"></i></button>' : '') +
        '<button style="' + btnS + 'color:#dc2626;" onclick="hrDeleteEmployee(\'' + e.id + '\',\'' + (e.fullName||'').replace(/'/g,'') + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

function hrViewEmployee(id) {
  loader(true);
  window._apiBridge.withSuccessHandler(function(emp) {
    loader(false);
    if (!emp || emp.error) return showToast(emp.error||'خطأ', true);
    var statusLabels = {active:'نشط',suspended:'مجمد',terminated:'منتهي',on_leave:'في إجازة'};
    var empTypeLabels = {full_time:'دوام كامل',part_time:'دوام جزئي',hourly:'بالساعة',contract:'عقد'};
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
      '<div><strong>الرقم الوظيفي:</strong> <code>' + (emp.employeeNumber||'') + '</code></div>' +
      '<div><strong>الاسم:</strong> ' + (emp.fullName||'') + '</div>' +
      '<div><strong>الهوية:</strong> ' + (emp.nationalId||'—') + '</div>' +
      '<div><strong>الجوال:</strong> ' + (emp.phone||'—') + '</div>' +
      '<div><strong>البريد:</strong> ' + (emp.email||'—') + '</div>' +
      '<div><strong>الوظيفة:</strong> ' + (emp.jobTitle||'—') + '</div>' +
      '<div><strong>القسم:</strong> ' + (emp.departmentName||'—') + '</div>' +
      '<div><strong>الفرع:</strong> ' + (emp.branchName||'—') + '</div>' +
      '<div><strong>نوع التوظيف:</strong> ' + (empTypeLabels[emp.employmentType]||emp.employmentType) + '</div>' +
      '<div><strong>الحالة:</strong> <span class="badge badge-' + (emp.status==='active'?'green':'red') + '">' + (statusLabels[emp.status]||emp.status) + '</span></div>' +
      '<div><strong>تاريخ التعيين:</strong> ' + (emp.hireDate ? new Date(emp.hireDate).toLocaleDateString('en-GB') : '—') + '</div>' +
      '<div><strong>الراتب الأساسي:</strong> <span style="font-weight:900;color:#1e40af;">' + (Number(emp.basicSalary)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</span></div>' +
    '</div>';
    // Bank info
    if (emp.bankName || emp.bankIban) {
      html += '<div style="background:#f8fafc;padding:12px;border-radius:10px;margin-bottom:12px;"><strong><i class="fas fa-university"></i> البنك:</strong> ' + (emp.bankName||'') + ' | IBAN: ' + (emp.bankIban||'') + '</div>';
    }
    // Emergency contact
    if (emp.emergencyContactName) {
      html += '<div style="background:#fef2f2;padding:12px;border-radius:10px;margin-bottom:12px;"><strong><i class="fas fa-phone-alt"></i> طوارئ:</strong> ' + emp.emergencyContactName + ' — ' + (emp.emergencyContactPhone||'') + ' (' + (emp.emergencyContactRelation||'') + ')</div>';
    }
    // Leave balances
    if (emp.leaveBalances && emp.leaveBalances.length) {
      html += '<h4 style="margin:14px 0 8px;"><i class="fas fa-calendar-check" style="color:#3b82f6;"></i> أرصدة الإجازات</h4>';
      html += '<div style="display:flex;gap:10px;flex-wrap:wrap;">';
      emp.leaveBalances.forEach(function(lb) {
        html += '<div style="padding:10px 16px;background:#f0fdf4;border:1px solid #dcfce7;border-radius:10px;text-align:center;">' +
          '<div style="font-size:12px;font-weight:700;color:#64748b;">' + lb.leaveTypeName + '</div>' +
          '<div style="font-size:20px;font-weight:900;color:#166534;">' + lb.remaining + '</div>' +
          '<div style="font-size:10px;color:#94a3b8;">من ' + lb.total + ' يوم</div></div>';
      });
      html += '</div>';
    }
    // Action buttons
    html += '<div style="display:flex;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0;flex-wrap:wrap;">';
    html += '<button class="btn btn-sm" style="background:#3b82f6;color:#fff;border-radius:10px;padding:8px 16px;" onclick="erpCloseModal();hrEditEmployee(\'' + id + '\')"><i class="fas fa-edit"></i> تعديل</button>';
    if (emp.status === 'active') {
      html += '<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border-radius:10px;padding:8px 16px;" onclick="hrSuspendEmployee(\'' + id + '\')"><i class="fas fa-pause-circle"></i> تجميد</button>';
      html += '<button class="btn btn-sm" style="background:#ef4444;color:#fff;border-radius:10px;padding:8px 16px;" onclick="hrTerminateEmployee(\'' + id + '\')"><i class="fas fa-user-slash"></i> إنهاء خدمة</button>';
    } else if (emp.status === 'suspended') {
      html += '<button class="btn btn-sm" style="background:#10b981;color:#fff;border-radius:10px;padding:8px 16px;" onclick="hrActivateEmployee(\'' + id + '\')"><i class="fas fa-play-circle"></i> تنشيط</button>';
    }
    html += '<button class="btn btn-sm" style="background:#dc2626;color:#fff;border-radius:10px;padding:8px 16px;" onclick="hrDeleteEmployee(\'' + id + '\',\'' + (emp.fullName||'').replace(/'/g,'') + '\')"><i class="fas fa-trash"></i> حذف</button>';
    html += '</div>';

    document.getElementById('erpModalTitle').textContent = 'ملف الموظف: ' + (emp.fullName||'');
    document.getElementById('erpModalBody').innerHTML = html;
    var box = document.querySelector('#erpModal .modal-box');
    if (box) box.style.maxWidth = '700px';
    document.getElementById('erpModalSaveBtn').style.display = 'none';
    document.getElementById('erpModal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('erpModalSaveBtn').style.display = ''; if(box) box.style.maxWidth=''; }, 100);
  }).getHrEmployee(id);
}

function hrOpenEmployeeModal(data) {
  var d = data || {};
  Promise.all([
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getHrDepartments(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getBranchesFull(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getBrands(); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getWfPositions(); })
  ]).then(function(res) {
    var depts = res[0]||[], branches = res[1]||[], brands = res[2]||[], positions = res[3]||[];
    var deptOpts = depts.map(function(x){return '<option value="'+x.id+'"'+(d.departmentId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var brOpts = branches.map(function(x){return '<option value="'+x.id+'"'+(d.branchId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var brandOpts = brands.map(function(x){return '<option value="'+x.id+'"'+(d.brandId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var posOpts = positions.map(function(x){return '<option value="'+x.id+'"'+(d.positionId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل موظف' : 'إضافة موظف جديد';
    var box = document.querySelector('#erpModal .modal-box');
    if (box) box.style.maxWidth = '700px';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="hrEmpId" value="'+(d.id||'')+'">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الاسم الأول *</label><input class="form-control" id="hrEmpFirst" value="'+(d.firstName||'')+'"></div>' +
        '<div class="form-row"><label>اسم العائلة</label><input class="form-control" id="hrEmpLast" value="'+(d.lastName||'')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>رقم الهوية</label><input class="form-control" id="hrEmpNatId" value="'+(d.nationalId||'')+'"></div>' +
        '<div class="form-row"><label>الجوال</label><input class="form-control" id="hrEmpPhone" value="'+(d.phone||'')+'"></div>' +
        '<div class="form-row"><label>البريد</label><input class="form-control" id="hrEmpEmail" value="'+(d.email||'')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الفرع</label><select class="form-control" id="hrEmpBranch"><option value="">—</option>'+brOpts+'</select></div>' +
        '<div class="form-row"><label>البراند</label><select class="form-control" id="hrEmpBrand"><option value="">—</option>'+brandOpts+'</select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>القسم</label><select class="form-control" id="hrEmpDept"><option value="">—</option>'+deptOpts+'</select></div>' +
        '<div class="form-row"><label>المنصب</label><select class="form-control" id="hrEmpPos"><option value="">—</option>'+posOpts+'</select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>المسمى الوظيفي</label><input class="form-control" id="hrEmpTitle" value="'+(d.jobTitle||'')+'"></div>' +
        '<div class="form-row"><label>نوع التوظيف</label><select class="form-control" id="hrEmpType"><option value="full_time">دوام كامل</option><option value="part_time">دوام جزئي</option><option value="hourly">بالساعة</option><option value="contract">عقد</option></select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الراتب الأساسي</label><input type="number" class="form-control" id="hrEmpSalary" value="'+(d.basicSalary||0)+'" step="0.01"></div>' +
        '<div class="form-row"><label>بدل سكن</label><input type="number" class="form-control" id="hrEmpHousing" value="'+(d.housingAllowance||0)+'" step="0.01"></div>' +
        '<div class="form-row"><label>بدل نقل</label><input type="number" class="form-control" id="hrEmpTransport" value="'+(d.transportAllowance||0)+'" step="0.01"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>تاريخ التعيين</label><input type="date" class="form-control" id="hrEmpHireDate" value="'+(d.hireDate&&String(d.hireDate).length>5?String(d.hireDate).split('T')[0]:'')+'"></div>' +
        '<div class="form-row"><label>نهاية العقد</label><input type="date" class="form-control" id="hrEmpContractEnd" value="'+(d.contractEndDate&&String(d.contractEndDate).length>5?String(d.contractEndDate).split('T')[0]:'')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label><i class="fas fa-clock" style="color:#10b981;"></i> بداية الدوام</label><input type="time" class="form-control" id="hrEmpWorkStart" value="'+(d.workStart||'08:00')+'"></div>' +
        '<div class="form-row"><label><i class="fas fa-clock" style="color:#ef4444;"></i> نهاية الدوام</label><input type="time" class="form-control" id="hrEmpWorkEnd" value="'+(d.workEnd||'17:00')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>البنك</label><input class="form-control" id="hrEmpBank" value="'+(d.bankName||'')+'"></div>' +
        '<div class="form-row"><label>رقم الحساب</label><input class="form-control" id="hrEmpBankAcc" value="'+(d.bankAccount||'')+'"></div>' +
        '<div class="form-row"><label>IBAN</label><input class="form-control" id="hrEmpIban" value="'+(d.bankIban||'')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>جهة اتصال طوارئ</label><input class="form-control" id="hrEmpEmgName" value="'+(d.emergencyContactName||'')+'"></div>' +
        '<div class="form-row"><label>جوال الطوارئ</label><input class="form-control" id="hrEmpEmgPhone" value="'+(d.emergencyContactPhone||'')+'"></div>' +
        '<div class="form-row"><label>صلة القرابة</label><input class="form-control" id="hrEmpEmgRel" value="'+(d.emergencyContactRelation||'')+'"></div>' +
      '</div>' +
      (!d.id ? '<div class="form-row" style="margin-top:8px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;"><input type="checkbox" id="hrEmpCreateUser" checked style="width:18px;height:18px;accent-color:#3b82f6;"> <span style="font-weight:700;color:#1e40af;">إنشاء حساب دخول للنظام تلقائياً</span></label></div>' : '') +
      '<div class="form-row"><label>ملاحظات</label><textarea class="form-control" id="hrEmpNotes" rows="2">'+(d.notes||'')+'</textarea></div>';
    if (d.employmentType) document.getElementById('hrEmpType').value = d.employmentType;
    document.getElementById('erpModalSaveBtn').onclick = hrSaveEmployee;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function hrEditEmployee(id) {
  // Load FULL employee data (not from list which has limited fields)
  loader(true);
  window._apiBridge.withSuccessHandler(function(emp) {
    loader(false);
    if (emp && !emp.error) {
      hrOpenEmployeeModal(emp);
    } else {
      showToast('فشل تحميل بيانات الموظف', true);
    }
  }).getHrEmployee(id);
}

function hrToggleIgnoreLate(id, name) {
  erpConfirm('تجاهل التأخير', 'تجاهل جميع تأخيرات "' + name + '" لهذا الشهر؟\nسيحصل على راتبه كاملاً بدون خصم تأخير.', function() {
    loader(true);
    fetch('/api/hr/employees/' + id + '/ignore-late', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r) { return r.json(); })
      .then(function(r) {
        loader(false);
        if (r.success) { showToast(r.ignored ? 'تم تجاهل التأخير لهذا الشهر' : 'تم إلغاء تجاهل التأخير'); hrLoadEmployees(); }
        else showToast(r.error, true);
      });
  }, { icon: 'fa-clock', color: '#f59e0b', okText: 'تأكيد' });
}

function hrTerminateEmployee(id) {
  var reason = prompt('سبب إنهاء الخدمة:');
  if (reason === null) return;
  if (!confirm('تأكيد إنهاء خدمة هذا الموظف؟ سيتم إيقاف حسابه أيضاً.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم إنهاء خدمة الموظف'); erpCloseModal(); hrLoadEmployees(); }
    else showToast(r.error, true);
  }).terminateEmployee(id, { terminationReason: reason, terminationDate: new Date().toISOString().split('T')[0] });
}

function hrSuspendEmployee(id) {
  if (!confirm('تأكيد تجميد هذا الموظف؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم تجميد الموظف'); erpCloseModal(); hrLoadEmployees(); }
    else showToast(r.error, true);
  }).suspendEmployee(id);
}

function hrActivateEmployee(id) {
  if (!confirm('تأكيد إعادة تنشيط هذا الموظف؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم تنشيط الموظف'); erpCloseModal(); hrLoadEmployees(); }
    else showToast(r.error, true);
  }).activateEmployee(id);
}

function hrDeleteEmployee(id, name) {
  if (!confirm('تأكيد حذف الموظف "' + name + '"؟\n\nسيتم إيقاف حسابه وحذف بياناته.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم حذف الموظف'); erpCloseModal(); hrLoadEmployees(); }
    else showToast(r.error, true);
  }).deleteHrEmployee(id);
}

function hrSaveEmployee() {
  var id = document.getElementById('hrEmpId').value;
  var data = {
    firstName: document.getElementById('hrEmpFirst').value,
    lastName: document.getElementById('hrEmpLast').value,
    nationalId: document.getElementById('hrEmpNatId').value,
    phone: document.getElementById('hrEmpPhone').value,
    email: document.getElementById('hrEmpEmail').value,
    branchId: document.getElementById('hrEmpBranch').value,
    brandId: document.getElementById('hrEmpBrand').value,
    departmentId: document.getElementById('hrEmpDept').value,
    positionId: document.getElementById('hrEmpPos').value,
    jobTitle: document.getElementById('hrEmpTitle').value,
    employmentType: document.getElementById('hrEmpType').value,
    basicSalary: Number(document.getElementById('hrEmpSalary').value)||0,
    housingAllowance: Number(document.getElementById('hrEmpHousing').value)||0,
    transportAllowance: Number(document.getElementById('hrEmpTransport').value)||0,
    hireDate: document.getElementById('hrEmpHireDate').value,
    contractEndDate: document.getElementById('hrEmpContractEnd').value,
    workStart: document.getElementById('hrEmpWorkStart').value || '08:00',
    workEnd: document.getElementById('hrEmpWorkEnd').value || '17:00',
    bankName: document.getElementById('hrEmpBank').value,
    bankAccount: document.getElementById('hrEmpBankAcc').value,
    bankIban: document.getElementById('hrEmpIban').value,
    emergencyContactName: document.getElementById('hrEmpEmgName').value,
    emergencyContactPhone: document.getElementById('hrEmpEmgPhone').value,
    emergencyContactRelation: document.getElementById('hrEmpEmgRel').value,
    notes: document.getElementById('hrEmpNotes').value,
    createUser: document.getElementById('hrEmpCreateUser') ? document.getElementById('hrEmpCreateUser').checked : false
  };
  if (!data.firstName) return showToast('الاسم الأول مطلوب', true);
  loader(true);
  if (id) {
    window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم التحديث');erpCloseModal();hrLoadEmployees();}else showToast(r.error,true); }).updateHrEmployee(id, data);
  } else {
    window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم إضافة الموظف: '+(r.employeeNumber||''));erpCloseModal();hrLoadEmployees();}else showToast(r.error,true); }).saveHrEmployee(data);
  }
}

// ─── Departments ───
var _hrDepts = [];
function hrLoadDepartments() {
  var grid = document.getElementById('hrDepartmentsGrid');
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i></div>';
  window._apiBridge.withSuccessHandler(function(list) {
    _hrDepts = list||[];
    if (!list.length) { grid.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;grid-column:1/-1;">لا توجد أقسام</div>'; return; }
    grid.innerHTML = list.map(function(d) {
      return '<div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:16px;padding:18px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-size:15px;font-weight:800;color:#1e293b;"><i class="fas fa-building" style="color:#3b82f6;margin-left:6px;"></i> ' + d.name + '</div>' +
          '<code style="color:#94a3b8;">' + (d.code||'') + '</code>' +
        '</div>' +
        '<div style="font-size:13px;color:#64748b;">الفرع: ' + (d.branchName||'—') + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9;">' +
          '<span style="font-size:13px;font-weight:700;color:#1e40af;">' + (d.employeeCount||0) + ' موظف</span>' +
          '<div style="display:flex;gap:4px;">' +
            '<button style="width:32px;height:32px;border-radius:8px;border:1px solid #e2e8f0;background:#f8fafc;color:#3b82f6;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;" onclick="hrEditDept(\''+d.id+'\')"><i class="fas fa-edit"></i></button>' +
          '</div>' +
        '</div></div>';
    }).join('');
  }).getHrDepartments();
}

function hrOpenDeptModal(data) {
  var d = data||{};
  document.getElementById('erpModalTitle').textContent = d.id ? 'تعديل قسم' : 'قسم جديد';
  window._apiBridge.withSuccessHandler(function(branches) {
    var brOpts = (branches||[]).map(function(b){return '<option value="'+b.id+'"'+(d.branchId===b.id?' selected':'')+'>'+b.name+'</option>';}).join('');
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="hrDeptId" value="'+(d.id||'')+'">' +
      '<div class="form-row"><label>اسم القسم *</label><input class="form-control" id="hrDeptName" value="'+(d.name||'')+'"></div>' +
      '<div class="form-row"><label>الرمز</label><input class="form-control" id="hrDeptCode" value="'+(d.code||'')+'" placeholder="تلقائي — اتركه فارغاً" style="background:'+(d.code?'#fff':'#f8fafc')+';color:'+(d.code?'#000':'#94a3b8')+';"></div>' +
      '<div class="form-row"><label>الفرع</label><select class="form-control" id="hrDeptBranch"><option value="">—</option>'+brOpts+'</select></div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var name = document.getElementById('hrDeptName').value;
      if (!name) return showToast('اسم القسم مطلوب', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الحفظ');erpCloseModal();hrLoadDepartments();}else showToast(r.error,true); }).saveHrDepartment({
        id: document.getElementById('hrDeptId').value||undefined, name: name,
        code: document.getElementById('hrDeptCode').value, branchId: document.getElementById('hrDeptBranch').value
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getBranchesFull();
}
function hrEditDept(id) { var d=_hrDepts.find(function(x){return x.id===id;}); if(d) hrOpenDeptModal(d); }

// ─── Attendance ───
function hrLoadAttendance() {
  var tb = document.getElementById('hrAttBody');
  tb.innerHTML = '<tr><td colspan="9" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  var params = {};
  var dt = (document.getElementById('hrAttDate')||{}).value;
  if (dt) params.date = dt;
  var br = (document.getElementById('hrAttBranch')||{}).value;
  if (br) params.branch_id = br;
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list||!list.length) { tb.innerHTML='<tr><td colspan="9" class="empty-msg">لا توجد سجلات</td></tr>'; document.getElementById('hrAttSummary').innerHTML=''; return; }
    // Summary stats cards
    var totalEmp = list.length;
    var totalHrs = list.reduce(function(s,a){return s+(Number(a.totalHours)||0);},0);
    var totalLateMin = list.reduce(function(s,a){return s+(Number(a.lateMinutes)||0);},0);
    var lateCount = list.filter(function(a){return (a.lateMinutes||0)>0;}).length;
    var avgHrs = totalEmp ? (totalHrs/totalEmp).toFixed(1) : '0';
    var sm = document.getElementById('hrAttSummary');
    sm.innerHTML =
      '<div style="background:#fff;border-radius:14px;padding:16px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:28px;font-weight:900;color:#0f172a;">' + totalEmp + '</div><div style="font-size:12px;color:#64748b;margin-top:4px;"><i class="fas fa-users" style="color:#3b82f6;"></i> سجلات</div></div>' +
      '<div style="background:#fff;border-radius:14px;padding:16px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:28px;font-weight:900;color:#0ea5e9;">' + totalHrs.toFixed(1) + '</div><div style="font-size:12px;color:#64748b;margin-top:4px;"><i class="fas fa-clock" style="color:#0ea5e9;"></i> إجمالي الساعات</div></div>' +
      '<div style="background:#fff;border-radius:14px;padding:16px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:28px;font-weight:900;color:#10b981;">' + avgHrs + '</div><div style="font-size:12px;color:#64748b;margin-top:4px;"><i class="fas fa-chart-bar" style="color:#10b981;"></i> متوسط ساعات</div></div>' +
      '<div style="background:#fff;border-radius:14px;padding:16px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:28px;font-weight:900;color:' + (lateCount>0?'#ef4444':'#10b981') + ';">' + (totalLateMin/60).toFixed(1) + '</div><div style="font-size:12px;color:#64748b;margin-top:4px;"><i class="fas fa-exclamation-triangle" style="color:#f59e0b;"></i> ساعات تأخير (' + lateCount + ' موظف)</div></div>';
    var srcLabels = {fingerprint:'بصمة',pos:'POS',app:'تطبيق',manual:'يدوي'};
    var statusLabels = {present:'حاضر',absent:'غائب',leave:'إجازة',holiday:'عطلة',weekend:'إجازة أسبوعية'};
    var statusColors = {present:'green',absent:'red',leave:'blue',holiday:'purple',weekend:'gray'};
    tb.innerHTML = list.map(function(a) {
      var ci = a.clockIn ? new Date(a.clockIn).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '—';
      var co = a.clockOut ? new Date(a.clockOut).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '—';
      var deviceHtml = a.deviceName ? '<div style="font-size:10px;color:#64748b;"><i class="fas fa-mobile-alt" style="color:#3b82f6;"></i> ' + a.deviceName + '</div>' : '';
      var locInHtml = a.geoAddressIn ? '<div style="font-size:10px;color:#64748b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + a.geoAddressIn + '"><i class="fas fa-map-marker-alt" style="color:#10b981;"></i> ' + a.geoAddressIn + '</div>' : '';
      var locOutHtml = a.geoAddressOut ? '<div style="font-size:10px;color:#64748b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + a.geoAddressOut + '"><i class="fas fa-map-marker-alt" style="color:#ef4444;"></i> ' + a.geoAddressOut + '</div>' : '';
      var isDev = state && state.isDeveloper;
      var delBtn = isDev ? '<button style="width:28px;height:28px;border-radius:6px;border:1px solid #fecaca;background:#fee2e2;color:#ef4444;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center;" onclick="hrDeleteAttendance(\'' + a.id + '\',\'' + (a.employeeName||'').replace(/'/g,'') + '\')" title="حذف البصمة"><i class="fas fa-trash"></i></button>' : '';
      return '<tr>' +
        '<td style="font-weight:700;">' + (a.employeeName||'') + '</td>' +
        '<td>' + (a.attendanceDate ? new Date(a.attendanceDate).toLocaleDateString('en-GB') : '') + '</td>' +
        '<td style="color:#16a34a;font-weight:700;">' + ci + locInHtml + '</td>' +
        '<td style="color:#ef4444;font-weight:700;">' + co + locOutHtml + '</td>' +
        '<td style="font-weight:700;">' + (Number(a.totalHours)||0).toFixed(1) + 'h</td>' +
        '<td>' + (a.lateMinutes > 0 ? '<span style="color:#ef4444;font-weight:700;">' + a.lateMinutes + ' د</span>' : '—') + '</td>' +
        '<td>' + deviceHtml + '</td>' +
        '<td><span class="badge badge-blue">' + (srcLabels[a.source]||a.source) + '</span></td>' +
        '<td>' + delBtn + '</td>' +
      '</tr>';
    }).join('');
  }).getHrAttendance(params);
}

function hrDeleteAttendance(id, empName) {
  if (!confirm('حذف بصمة "' + empName + '"؟\n\nسيتم حذفها من قاعدة البيانات نهائياً.')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم حذف البصمة'); hrLoadAttendance(); }
    else showToast((r && r.error) || 'فشل الحذف', true);
  }).deleteHrAttendance(id);
}

function hrImportAttendance() {
  document.getElementById('erpModalTitle').textContent = 'استيراد سجلات البصمة';
  document.getElementById('erpModalBody').innerHTML =
    '<div style="margin-bottom:14px;padding:14px;background:#eff6ff;border:1px solid #dbeafe;border-radius:12px;">' +
      '<p style="font-weight:700;color:#1e40af;margin-bottom:8px;"><i class="fas fa-info-circle"></i> صيغة الملف المطلوبة (CSV):</p>' +
      '<code style="display:block;background:#fff;padding:10px;border-radius:8px;font-size:12px;direction:ltr;text-align:left;">' +
        'employeeNumber,date,clockIn,clockOut<br>' +
        'EMP-00001,2026-04-16,08:00,17:00<br>' +
        'EMP-00002,2026-04-16,08:15,16:45' +
      '</code>' +
    '</div>' +
    '<div class="form-row"><label>اختر ملف CSV</label><input type="file" id="hrAttFile" accept=".csv" class="form-control"></div>' +
    '<div id="hrAttPreview" style="margin-top:10px;"></div>';
  document.getElementById('erpModalSaveBtn').onclick = function() {
    var file = document.getElementById('hrAttFile').files[0];
    if (!file) return showToast('اختر ملف CSV', true);
    var reader = new FileReader();
    reader.onload = function(e) {
      var lines = e.target.result.split('\\n').filter(function(l) { return l.trim(); });
      if (lines.length < 2) return showToast('الملف فارغ', true);
      var records = [];
      for (var i = 1; i < lines.length; i++) {
        var cols = lines[i].split(',');
        if (cols.length >= 4) {
          records.push({ employeeNumber: cols[0].trim(), date: cols[1].trim(), clockIn: cols[2].trim(), clockOut: cols[3].trim() });
        }
      }
      if (!records.length) return showToast('لا توجد بيانات صالحة', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) {
          showToast('تم استيراد ' + r.imported + ' سجل' + (r.errors && r.errors.length ? ' (' + r.errors.length + ' أخطاء)' : ''));
          erpCloseModal();
          hrLoadAttendance();
        } else showToast(r.error, true);
      }).importHrAttendance(records);
    };
    reader.readAsText(file);
  };
  document.getElementById('erpModal').classList.remove('hidden');
}

function hrAddManualAttendance() {
  // Load employees for dropdown
  window._apiBridge.withSuccessHandler(function(emps) {
    var empOpts = (emps||[]).map(function(e) { return '<option value="' + e.id + '">' + (e.fullName||e.employeeNumber) + '</option>'; }).join('');
    document.getElementById('erpModalTitle').textContent = 'تسجيل حضور يدوي';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="form-row"><label>الموظف *</label><select class="form-control" id="hrManAttEmp">' + empOpts + '</select></div>' +
      '<div class="form-row"><label>التاريخ *</label><input type="date" class="form-control" id="hrManAttDate" value="' + new Date().toISOString().split('T')[0] + '"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>وقت الحضور</label><input type="time" class="form-control" id="hrManAttIn" value="08:00"></div>' +
        '<div class="form-row"><label>وقت الانصراف</label><input type="time" class="form-control" id="hrManAttOut" value="17:00"></div>' +
      '</div>' +
      '<div class="form-row"><label>ملاحظات</label><input class="form-control" id="hrManAttNotes" placeholder="اختياري"></div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var empId = document.getElementById('hrManAttEmp').value;
      var attDate = document.getElementById('hrManAttDate').value;
      var clockIn = document.getElementById('hrManAttIn').value;
      var clockOut = document.getElementById('hrManAttOut').value;
      if (!empId || !attDate) return showToast('اختر الموظف والتاريخ', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) { showToast('تم تسجيل الحضور'); erpCloseModal(); hrLoadAttendance(); }
        else showToast(r.error, true);
      }).clockHrAttendance({
        employeeId: empId, date: attDate, clockIn: clockIn, clockOut: clockOut,
        notes: document.getElementById('hrManAttNotes').value, source: 'manual'
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getHrEmployees({});
}

// ─── Leave Requests ───
var _hrLeaveRequests = [];
function hrLoadLeaveRequests() {
  var tb = document.getElementById('hrLeaveBody');
  tb.innerHTML = '<tr><td colspan="8" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  var params = {};
  var st = (document.getElementById('hrLeaveStatus')||{}).value;
  if (st) params.status = st;
  window._apiBridge.withSuccessHandler(function(list) {
    _hrLeaveRequests = list || [];
    if (!list||!list.length) { tb.innerHTML='<tr><td colspan="8" class="empty-msg">لا توجد طلبات</td></tr>'; return; }
    var statusLabels = {pending:'معلّقة',branch_approved:'معتمد مدير',hr_approved:'معتمد HR',rejected:'مرفوضة',cancelled:'ملغاة'};
    var statusColors = {pending:'yellow',branch_approved:'blue',hr_approved:'green',rejected:'red',cancelled:'gray'};
    tb.innerHTML = list.map(function(l) {
      var canApprove = l.status==='pending'||l.status==='branch_approved';
      var actions = '<button style="width:30px;height:30px;border-radius:8px;border:1px solid #e2e8f0;background:#f8fafc;color:#3b82f6;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;" onclick="hrViewLeaveDetail(\''+l.id+'\')"><i class="fas fa-eye"></i></button> ';
      if (canApprove) {
        var level = l.status==='pending' ? 'branch' : 'hr';
        actions += '<button class="btn btn-success btn-sm" onclick="hrApproveLeave(\''+l.id+'\',\''+level+'\')"><i class="fas fa-check"></i></button> ';
        actions += '<button class="btn btn-danger btn-sm" onclick="hrRejectLeave(\''+l.id+'\')"><i class="fas fa-times"></i></button>';
      }
      return '<tr>' +
        '<td><code>' + (l.requestNumber||'') + '</code></td>' +
        '<td style="font-weight:700;">' + (l.employeeName||'') + '</td>' +
        '<td><span class="badge badge-blue">' + (l.leaveTypeName||'') + '</span></td>' +
        '<td>' + (l.startDate ? new Date(l.startDate).toLocaleDateString('en-GB') : '') + '</td>' +
        '<td>' + (l.endDate ? new Date(l.endDate).toLocaleDateString('en-GB') : '') + '</td>' +
        '<td style="font-weight:700;">' + (l.daysCount||0) + '</td>' +
        '<td><span class="badge badge-' + (statusColors[l.status]||'blue') + '">' + (statusLabels[l.status]||l.status) + '</span></td>' +
        '<td style="white-space:nowrap;">' + actions + '</td>' +
      '</tr>';
    }).join('');
  }).getLeaveRequests(params);
}

function hrOpenLeaveRequestModal() {
  Promise.all([
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getHrEmployees({status:'active'}); }),
    new Promise(function(r) { window._apiBridge.withSuccessHandler(r).getHrLeaveTypes(); })
  ]).then(function(res) {
    var emps = res[0]||[], types = res[1]||[];
    var empOpts = emps.map(function(e){return '<option value="'+e.id+'">'+e.fullName+' ('+e.employeeNumber+')</option>';}).join('');
    var typeOpts = types.map(function(t){return '<option value="'+t.id+'">'+t.name+' ('+t.defaultDays+' يوم)</option>';}).join('');
    document.getElementById('erpModalTitle').textContent = 'طلب إجازة جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="form-row"><label>الموظف *</label><select class="form-control" id="hrLeaveEmp">'+empOpts+'</select></div>' +
      '<div class="form-row"><label>نوع الإجازة *</label><select class="form-control" id="hrLeaveType">'+typeOpts+'</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>من تاريخ *</label><input type="date" class="form-control" id="hrLeaveStart"></div>' +
        '<div class="form-row"><label>إلى تاريخ *</label><input type="date" class="form-control" id="hrLeaveEnd"></div>' +
      '</div>' +
      '<div class="form-row"><label>السبب</label><textarea class="form-control" id="hrLeaveReason" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var empId = document.getElementById('hrLeaveEmp').value;
      var typeId = document.getElementById('hrLeaveType').value;
      var start = document.getElementById('hrLeaveStart').value;
      var end = document.getElementById('hrLeaveEnd').value;
      if (!empId||!typeId||!start||!end) return showToast('جميع الحقول مطلوبة', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم تقديم الطلب');erpCloseModal();hrLoadLeaveRequests();}else showToast(r.error,true); }).createLeaveRequest({
        employeeId:empId, leaveTypeId:typeId, startDate:start, endDate:end, reason:document.getElementById('hrLeaveReason').value
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function hrApproveLeave(id, level) {
  if (!confirm('موافقة على الإجازة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تمت الموافقة');hrLoadLeaveRequests();}else showToast(r.error,true); }).approveLeaveRequest(id, {username:currentUser, level:level});
}

function hrRejectLeave(id) {
  var reason = prompt('سبب الرفض:');
  if (reason===null) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الرفض');hrLoadLeaveRequests();}else showToast(r.error,true); }).rejectLeaveRequest(id, {username:currentUser, reason:reason});
}

function hrViewLeaveDetail(id) {
  // Find the leave request and show details
  var req = (_hrLeaveRequests||[]).find(function(r) { return r.id === id; });
  if (!req) return showToast('الطلب غير موجود', true);
  var statusLabels = { pending: 'قيد الانتظار', branch_approved: 'موافق من المدير', hr_approved: 'معتمدة', rejected: 'مرفوضة' };
  var statusColors = { pending: '#f59e0b', branch_approved: '#3b82f6', hr_approved: '#16a34a', rejected: '#ef4444' };
  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div><strong>رقم الطلب:</strong> <code>' + (req.requestNumber||req.request_number||'') + '</code></div>' +
    '<div><strong>الموظف:</strong> ' + (req.employeeName||req.employee_name||'') + '</div>' +
    '<div><strong>النوع:</strong> ' + (req.leaveTypeName||req.leave_type_name||'') + '</div>' +
    '<div><strong>عدد الأيام:</strong> <span style="font-weight:900;color:#1e40af;">' + (req.daysCount||req.days_count||0) + '</span></div>' +
    '<div><strong>من:</strong> ' + (req.startDate||req.start_date ? new Date(req.startDate||req.start_date).toLocaleDateString('en-GB') : '') + '</div>' +
    '<div><strong>إلى:</strong> ' + (req.endDate||req.end_date ? new Date(req.endDate||req.end_date).toLocaleDateString('en-GB') : '') + '</div>' +
    '<div><strong>الحالة:</strong> <span style="color:' + (statusColors[req.status]||'#64748b') + ';font-weight:800;">' + (statusLabels[req.status]||req.status) + '</span></div>' +
    '</div>';
  if (req.reason) html += '<div style="margin-top:12px;"><strong>السبب:</strong><p style="padding:8px;background:#f8fafc;border-radius:8px;margin-top:4px;">' + req.reason + '</p></div>';
  if (req.rejectionReason||req.rejection_reason) html += '<div style="margin-top:8px;padding:10px;background:#fee2e2;border-radius:8px;"><strong style="color:#ef4444;">سبب الرفض:</strong> ' + (req.rejectionReason||req.rejection_reason) + '</div>';
  document.getElementById('erpModalTitle').textContent = 'تفاصيل طلب الإجازة';
  document.getElementById('erpModalBody').innerHTML = html;
  document.getElementById('erpModalSaveBtn').style.display = 'none';
  document.getElementById('erpModal').classList.remove('hidden');
  setTimeout(function() { document.getElementById('erpModalSaveBtn').style.display = ''; }, 100);
}

// ─── Payroll ───
function hrLoadPayrollRuns() {
  var tb = document.getElementById('hrPayrollBody');
  tb.innerHTML = '<tr><td colspan="9" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list||!list.length) { tb.innerHTML='<tr><td colspan="9" class="empty-msg">لا توجد دورات رواتب</td></tr>'; return; }
    var statusLabels = {draft:'مسودة',calculated:'محسوبة',approved:'معتمدة',paid:'مدفوعة'};
    var statusColors = {draft:'yellow',calculated:'blue',approved:'green',paid:'purple'};
    var months = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    tb.innerHTML = list.map(function(r) {
      var actions = '<button class="btn btn-sm btn-light" onclick="hrViewPayrollItems(\''+r.id+'\')" title="عرض"><i class="fas fa-eye"></i></button> ';
      if (r.status==='draft') actions += '<button class="btn btn-sm btn-primary" onclick="hrCalculatePayroll(\''+r.id+'\')"><i class="fas fa-calculator"></i> حساب</button> ';
      if (r.status==='calculated') {
        actions += '<button class="btn btn-sm btn-success" onclick="hrApprovePayroll(\''+r.id+'\')"><i class="fas fa-check"></i> اعتماد</button> ';
        actions += '<button class="btn btn-sm" style="background:#f59e0b;color:#fff;" onclick="hrRecalculatePayroll(\''+r.id+'\')" title="إعادة احتساب"><i class="fas fa-sync-alt"></i></button>';
      }
      if (r.status==='approved') actions += ' <button class="btn btn-sm" style="background:#f59e0b;color:#fff;" onclick="hrRecalculatePayroll(\''+r.id+'\')" title="إعادة احتساب"><i class="fas fa-sync-alt"></i></button>';
      if (r.status==='calculated' || r.status==='approved' || r.status==='paid') actions += ' <button class="btn btn-sm" style="background:#16a34a;color:#fff;" onclick="hrExportPayroll(\''+r.id+'\')" title="تصدير Excel"><i class="fas fa-file-excel"></i></button>';
      var m = r.periodMonth || r.month;
      var y = r.periodYear || r.year;
      return '<tr>' +
        '<td><code>' + (r.runNumber || r.run_number || '') + '</code></td>' +
        '<td style="font-weight:700;">' + (months[m]||m||'') + ' ' + (y||'') + '</td>' +
        '<td>' + (r.branchName||'كل الفروع') + '</td>' +
        '<td style="font-weight:700;">' + (r.employeeCount||0) + '</td>' +
        '<td style="color:#16a34a;font-weight:700;">' + (Number(r.totalGross)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</td>' +
        '<td style="color:#ef4444;">' + (Number(r.totalDeductions)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</td>' +
        '<td style="font-weight:900;color:#1e40af;">' + (Number(r.totalNet)||0).toLocaleString('en',{minimumFractionDigits:2}) + '</td>' +
        '<td><span class="badge badge-' + (statusColors[r.status]||'blue') + '">' + (statusLabels[r.status]||r.status) + '</span></td>' +
        '<td style="white-space:nowrap;">' + actions + '</td>' +
      '</tr>';
    }).join('');
  }).getPayrollRuns();
}

function hrOpenPayrollRunModal() {
  var now = new Date();
  document.getElementById('erpModalTitle').textContent = 'دورة رواتب جديدة';
  window._apiBridge.withSuccessHandler(function(branches) {
    var brOpts = (branches||[]).map(function(b){return '<option value="'+b.id+'">'+b.name+'</option>';}).join('');
    document.getElementById('erpModalBody').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>الشهر *</label><select class="form-control" id="hrPrMonth">' +
          '<option value="1">يناير</option><option value="2">فبراير</option><option value="3">مارس</option><option value="4">أبريل</option>' +
          '<option value="5">مايو</option><option value="6">يونيو</option><option value="7">يوليو</option><option value="8">أغسطس</option>' +
          '<option value="9">سبتمبر</option><option value="10">أكتوبر</option><option value="11">نوفمبر</option><option value="12">ديسمبر</option>' +
        '</select></div>' +
        '<div class="form-row"><label>السنة *</label><input type="number" class="form-control" id="hrPrYear" value="'+now.getFullYear()+'"></div>' +
      '</div>' +
      '<div class="form-row"><label>الفرع</label><select class="form-control" id="hrPrBranch"><option value="">كل الفروع</option>'+brOpts+'</select></div>';
    document.getElementById('hrPrMonth').value = now.getMonth() + 1;
    document.getElementById('erpModalSaveBtn').onclick = function() {
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم إنشاء الدورة');erpCloseModal();hrLoadPayrollRuns();}else showToast(r.error,true); }).createPayrollRun({
        month: Number(document.getElementById('hrPrMonth').value),
        year: Number(document.getElementById('hrPrYear').value),
        branchId: document.getElementById('hrPrBranch').value
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getBranchesFull();
}

function hrCalculatePayroll(id) {
  erpConfirm('حساب الرواتب', 'سيتم احتساب الرواتب من الحضور والإجازات والاستثناءات.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم حساب الرواتب لـ '+(r.employeeCount||r.count||0)+' موظف');hrLoadPayrollRuns();}else showToast(r.error,true); }).calculatePayroll(id, {username:currentUser});
  }, { icon:'fa-calculator', color:'#1e40af', okText:'حساب' });
}

function hrRecalculatePayroll(id) {
  erpConfirm('إعادة احتساب الرواتب', 'سيتم حذف البنود الحالية وإعادة الاحتساب من جديد بناءً على آخر البيانات (الحضور، الاستثناءات، السلف).', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم إعادة الاحتساب لـ '+(r.employeeCount||r.count||0)+' موظف');hrLoadPayrollRuns();}else showToast(r.error,true); }).calculatePayroll(id, {username:currentUser});
  }, { icon:'fa-sync-alt', color:'#f59e0b', okText:'إعادة احتساب' });
}

function hrApprovePayroll(id) {
  if (!confirm('اعتماد هذه الدورة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الاعتماد');hrLoadPayrollRuns();}else showToast(r.error,true); }).approvePayroll(id, {username:currentUser});
}

function hrViewPayrollItems(id) {
  loader(true);
  window._apiBridge.withSuccessHandler(function(items) {
    loader(false);
    if (!items||!items.length) return showToast('لا توجد بنود — اضغط زر "حساب" أولاً', true);
    var totals = { basic:0, allow:0, ot:0, gross:0, ded:0, net:0 };
    var html = '<div style="display:flex;justify-content:space-between;margin-bottom:10px;align-items:center;">';
    html += '<span style="font-size:12px;color:#64748b;">إجمالي الموظفين: <b>'+items.length+'</b></span>';
    html += '<button class="btn btn-sm" style="background:#16a34a;color:#fff;border-radius:8px;" onclick="hrExportPayroll(\''+id+'\')"><i class="fas fa-file-excel"></i> تصدير Excel</button>';
    html += '</div>';
    html += '<div style="max-height:400px;overflow-y:auto;"><table class="erp-table" style="font-size:12px;">' +
      '<thead><tr><th>الرقم</th><th>الموظف</th><th>الأساسي</th><th>البدلات</th><th>الإضافي</th><th>الإجمالي</th><th>الخصومات</th><th>الصافي</th></tr></thead><tbody>';
    items.forEach(function(p) {
      var allowances = (Number(p.housingAllowance)||0)+(Number(p.transportAllowance)||0)+(Number(p.otherAllowance)||0);
      totals.basic += Number(p.basicSalary)||0;
      totals.allow += allowances;
      totals.ot += Number(p.overtimeAmount)||0;
      totals.gross += Number(p.grossSalary)||0;
      totals.ded += Number(p.totalDeductions)||0;
      totals.net += Number(p.netSalary)||0;
      html += '<tr><td><code style="font-size:11px;">'+(p.employeeNumber||'')+'</code></td>' +
        '<td style="font-weight:700;">'+(p.employeeName||'—')+'</td>' +
        '<td>'+(Number(p.basicSalary)||0).toFixed(2)+'</td>' +
        '<td>'+allowances.toFixed(2)+'</td>' +
        '<td style="color:#16a34a;">'+(Number(p.overtimeAmount)||0).toFixed(2)+'</td>' +
        '<td style="font-weight:700;">'+(Number(p.grossSalary)||0).toFixed(2)+'</td>' +
        '<td style="color:#ef4444;">'+(Number(p.totalDeductions)||0).toFixed(2)+'</td>' +
        '<td style="font-weight:900;color:#1e40af;">'+(Number(p.netSalary)||0).toFixed(2)+'</td></tr>';
    });
    // Totals row
    html += '<tr style="background:#f1f5f9;font-weight:900;">' +
      '<td colspan="2" style="text-align:center;">الإجمالي</td>' +
      '<td>'+totals.basic.toFixed(2)+'</td>' +
      '<td>'+totals.allow.toFixed(2)+'</td>' +
      '<td style="color:#16a34a;">'+totals.ot.toFixed(2)+'</td>' +
      '<td>'+totals.gross.toFixed(2)+'</td>' +
      '<td style="color:#ef4444;">'+totals.ded.toFixed(2)+'</td>' +
      '<td style="color:#1e40af;font-size:14px;">'+totals.net.toFixed(2)+'</td></tr>';
    html += '</tbody></table></div>';
    document.getElementById('erpModalTitle').textContent = 'بنود الرواتب';
    document.getElementById('erpModalBody').innerHTML = html;
    var box = document.querySelector('#erpModal .modal-box');
    if (box) box.style.maxWidth = '900px';
    document.getElementById('erpModalSaveBtn').style.display = 'none';
    document.getElementById('erpModal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('erpModalSaveBtn').style.display = ''; if(box) box.style.maxWidth=''; }, 100);
  }).getPayrollItems(id);
}

window.hrExportPayroll = function(id) {
  var url = '/api/hr/payroll-runs/' + id + '/export';
  var token = localStorage.getItem('pos_token');
  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) { return r.blob().then(function(blob) { return { blob: blob, headers: r.headers }; }); })
    .then(function(res) {
      var link = document.createElement('a');
      link.href = URL.createObjectURL(res.blob);
      link.download = 'payroll_' + id + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      showToast('تم التصدير');
    }).catch(function(){ showToast('فشل التصدير', true); });
};

// ─── Advances ───
function hrLoadAdvances() {
  var tb = document.getElementById('hrAdvancesBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list||!list.length) { tb.innerHTML='<tr><td colspan="7" class="empty-msg">لا توجد سلف</td></tr>'; return; }
    var statusLabels = {pending:'معلقة',approved:'معتمدة',rejected:'مرفوضة',deducted:'مخصومة'};
    var statusColors = {pending:'yellow',approved:'green',rejected:'red',deducted:'purple'};
    tb.innerHTML = list.map(function(a) {
      var actions = '';
      if (a.status==='pending') {
        actions = '<button class="btn btn-success btn-sm" onclick="hrApproveAdvance(\''+a.id+'\')"><i class="fas fa-check"></i></button> ' +
          '<button class="btn btn-danger btn-sm" onclick="hrRejectAdvance(\''+a.id+'\')"><i class="fas fa-times"></i></button>';
      }
      return '<tr>' +
        '<td style="font-weight:700;">'+(a.employeeName||'')+'</td>' +
        '<td style="font-weight:900;color:#1e40af;">'+(Number(a.amount)||0).toLocaleString('en',{minimumFractionDigits:2})+'</td>' +
        '<td>'+(a.requestDate ? new Date(a.requestDate).toLocaleDateString('en-GB') : '')+'</td>' +
        '<td>'+(a.deductionMonths||1)+' شهر</td>' +
        '<td style="color:#ef4444;font-weight:700;">'+(Number(a.remainingAmount)||0).toLocaleString('en',{minimumFractionDigits:2})+'</td>' +
        '<td><span class="badge badge-'+(statusColors[a.status]||'blue')+'">'+(statusLabels[a.status]||a.status)+'</span></td>' +
        '<td style="white-space:nowrap;">'+actions+'</td>' +
      '</tr>';
    }).join('');
  }).getHrAdvances({});
}

function hrOpenAdvanceModal() {
  window._apiBridge.withSuccessHandler(function(emps) {
    var empOpts = (emps||[]).map(function(e){return '<option value="'+e.id+'">'+e.fullName+' ('+e.employeeNumber+')</option>';}).join('');
    document.getElementById('erpModalTitle').textContent = 'طلب سلفة جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="form-row"><label>الموظف *</label><select class="form-control" id="hrAdvEmp">'+empOpts+'</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>المبلغ *</label><input type="number" class="form-control" id="hrAdvAmount" min="1" step="0.01"></div>' +
        '<div class="form-row"><label>عدد أشهر الخصم</label><input type="number" class="form-control" id="hrAdvMonths" min="1" value="1"></div>' +
      '</div>' +
      '<div class="form-row"><label>ملاحظات</label><textarea class="form-control" id="hrAdvNotes" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = function() {
      var empId = document.getElementById('hrAdvEmp').value;
      var amount = Number(document.getElementById('hrAdvAmount').value);
      if (!empId||!amount) return showToast('الموظف والمبلغ مطلوبان', true);
      loader(true);
      window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم تقديم الطلب');erpCloseModal();hrLoadAdvances();}else showToast(r.error,true); }).createAdvance({
        employeeId:empId, amount:amount, requestDate:new Date().toISOString().split('T')[0],
        deductionMonths:Number(document.getElementById('hrAdvMonths').value)||1, notes:document.getElementById('hrAdvNotes').value
      });
    };
    document.getElementById('erpModal').classList.remove('hidden');
  }).getHrEmployees({status:'active'});
}

function hrApproveAdvance(id) {
  if (!confirm('اعتماد السلفة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الاعتماد');hrLoadAdvances();}else showToast(r.error,true); }).approveAdvance(id, {username:currentUser});
}

function hrRejectAdvance(id) {
  if (!confirm('رفض السلفة؟')) return;
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الرفض');hrLoadAdvances();}else showToast(r.error,true); }).rejectAdvance(id, {username:currentUser});
}

// ═══════════════════════════════════════════════════════════════
// HR SHIFTS
// ═══════════════════════════════════════════════════════════════
var _hrShifts = [];
function hrLoadShifts() {
  var c = document.getElementById('hrShiftsList');
  c.innerHTML = '<div style="text-align:center;padding:30px;"><i class="fas fa-spinner fa-spin"></i></div>';
  window._apiBridge.withSuccessHandler(function(list) {
    _hrShifts = list || [];
    if (!list.length) { c.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;">لا توجد شفتات — اضغط "شفت جديد"</div>'; return; }
    var days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    c.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;">' +
      list.map(function(s) {
        var workDaysArr = (s.workDays||'').split(',').map(function(x){return days[parseInt(x)]||x;}).join(', ');
        return '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;"><div><h3 style="font-size:15px;font-weight:800;margin:0;color:#0f172a;">'+s.name+(s.isDefault?' <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:#dcfce7;color:#166534;">افتراضي</span>':'')+'</h3><div style="font-size:11px;color:#94a3b8;margin-top:2px;">'+(s.code||'')+'</div></div>' +
            '<div style="display:flex;gap:4px;"><button class="btn-icon" style="color:#3b82f6;" onclick="hrEditShift(\''+s.id+'\')" title="تعديل"><i class="fas fa-edit"></i></button><button class="btn-icon" style="color:#ef4444;" onclick="hrDeleteShift(\''+s.id+'\')" title="حذف"><i class="fas fa-trash"></i></button></div></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;"><div><span style="color:#94a3b8;">البداية:</span> <b style="color:#10b981;">'+s.startTime+'</b></div><div><span style="color:#94a3b8;">النهاية:</span> <b style="color:#ef4444;">'+s.endTime+'</b></div><div><span style="color:#94a3b8;">الاستراحة:</span> <b>'+s.breakMinutes+' د</b></div><div><span style="color:#94a3b8;">سماحية التأخير:</span> <b>'+s.graceLateMinutes+' د</b></div></div>' +
          '<div style="font-size:11px;color:#64748b;margin-top:10px;"><i class="fas fa-calendar" style="margin-left:4px;"></i> '+workDaysArr+'</div>' +
          (s.allowOvertimeAfter||s.allowOvertimeBefore?'<div style="font-size:11px;color:#f59e0b;margin-top:4px;"><i class="fas fa-clock"></i> مسموح إضافي'+(s.allowOvertimeBefore?' قبل':'')+(s.allowOvertimeAfter?' بعد':'')+' الدوام</div>':'') +
        '</div>';
      }).join('') + '</div>';
  }).getHrShifts();
}

function hrOpenShiftModal() { hrEditShift(null); }
function hrEditShift(id) {
  var s = id ? _hrShifts.find(function(x){return x.id===id;}) : null;
  var d = s || { startTime:'08:00', endTime:'17:00', breakMinutes:60, graceLateMinutes:5, graceEarlyLeaveMinutes:0, workDays:'0,1,2,3,4', allowOvertimeAfter:true };
  var days = [['0','الأحد'],['1','الاثنين'],['2','الثلاثاء'],['3','الأربعاء'],['4','الخميس'],['5','الجمعة'],['6','السبت']];
  var selectedDays = (d.workDays||'').split(',');
  document.getElementById('erpModalTitle').textContent = id ? 'تعديل شفت' : 'شفت جديد';
  document.getElementById('erpModalBody').innerHTML =
    '<input type="hidden" id="shId" value="'+(d.id||'')+'">' +
    '<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>اسم الشفت *</label><input class="form-control" id="shName" value="'+(d.name||'')+'"></div>' +
      '<div class="form-row"><label>الرمز</label><input class="form-control" id="shCode" value="'+(d.code||'')+'"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>بداية الدوام *</label><input type="time" class="form-control" id="shStart" value="'+d.startTime+'"></div>' +
      '<div class="form-row"><label>نهاية الدوام *</label><input type="time" class="form-control" id="shEnd" value="'+d.endTime+'"></div>' +
      '<div class="form-row"><label>الاستراحة (د)</label><input type="number" class="form-control" id="shBreak" value="'+d.breakMinutes+'"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-row"><label>سماحية التأخير (د)</label><input type="number" class="form-control" id="shGraceL" value="'+d.graceLateMinutes+'"></div>' +
      '<div class="form-row"><label>سماحية الانصراف المبكر (د)</label><input type="number" class="form-control" id="shGraceE" value="'+d.graceEarlyLeaveMinutes+'"></div>' +
    '</div>' +
    '<div class="form-row"><label>أيام العمل</label><div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      days.map(function(dy) {
        return '<label style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;background:#fff;"><input type="checkbox" class="shDay" value="'+dy[0]+'"'+(selectedDays.indexOf(dy[0])>=0?' checked':'')+'> '+dy[1]+'</label>';
      }).join('') + '</div></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">' +
      '<label style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#f8fafc;border-radius:8px;cursor:pointer;"><input type="checkbox" id="shOtBefore"'+(d.allowOvertimeBefore?' checked':'')+'> إضافي قبل الدوام</label>' +
      '<label style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#f8fafc;border-radius:8px;cursor:pointer;"><input type="checkbox" id="shOtAfter"'+(d.allowOvertimeAfter?' checked':'')+'> إضافي بعد الدوام</label>' +
      '<label style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#fef3c7;border-radius:8px;cursor:pointer;"><input type="checkbox" id="shDefault"'+(d.isDefault?' checked':'')+'> شفت افتراضي</label>' +
    '</div>';
  document.getElementById('erpModalSaveBtn').onclick = hrSaveShift;
  document.getElementById('erpModal').classList.remove('hidden');
}

function hrSaveShift() {
  var workDays = [];
  document.querySelectorAll('.shDay:checked').forEach(function(c){ workDays.push(c.value); });
  var data = {
    id: document.getElementById('shId').value || undefined,
    name: document.getElementById('shName').value,
    code: document.getElementById('shCode').value,
    startTime: document.getElementById('shStart').value + ':00',
    endTime: document.getElementById('shEnd').value + ':00',
    breakMinutes: Number(document.getElementById('shBreak').value)||60,
    graceLateMinutes: Number(document.getElementById('shGraceL').value)||5,
    graceEarlyLeaveMinutes: Number(document.getElementById('shGraceE').value)||0,
    workDays: workDays.join(','),
    allowOvertimeBefore: document.getElementById('shOtBefore').checked,
    allowOvertimeAfter: document.getElementById('shOtAfter').checked,
    isDefault: document.getElementById('shDefault').checked,
    username: currentUser
  };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الحفظ');erpCloseModal();hrLoadShifts();}else showToast(r.error,true); }).saveHrShift(data);
}

function hrDeleteShift(id) {
  erpConfirm('حذف الشفت', 'هل أنت متأكد من حذف هذا الشفت؟', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r) { loader(false); if(r.success){showToast('تم الحذف');hrLoadShifts();}else showToast(r.error,true); }).deleteHrShift(id);
  }, { icon:'fa-trash', color:'#ef4444', okText:'حذف' });
}

// ═══════════════════════════════════════════════════════════════
// HR OVERTIME ENTRIES
// ═══════════════════════════════════════════════════════════════
function hrLoadOvertimeEntries() {
  var tb = document.getElementById('hrOtEntriesBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  var params = {};
  var st = (document.getElementById('hrOtStatusFilter')||{}).value;
  if (st) params.status = st;
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد سجلات إضافي</td></tr>'; return; }
    var sMap = {pending:'معلقة',approved:'معتمدة',rejected:'مرفوضة'};
    var sClr = {pending:'#f59e0b',approved:'#10b981',rejected:'#ef4444'};
    tb.innerHTML = list.map(function(o) {
      var dt = o.entryDate ? new Date(o.entryDate).toLocaleDateString('en-GB') : '';
      var hrs = Math.floor(o.minutes/60) + ':' + String(o.minutes%60).padStart(2,'0');
      var actions = '';
      if (o.status === 'pending') {
        actions = '<button class="btn btn-sm btn-success" onclick="hrApproveOt(\''+o.id+'\')"><i class="fas fa-check"></i></button> ' +
                  '<button class="btn btn-sm btn-danger" onclick="hrRejectOt(\''+o.id+'\')"><i class="fas fa-times"></i></button>';
      }
      return '<tr>' +
        '<td style="font-weight:700;">'+(o.employeeName||'')+'<div style="font-size:10px;color:#94a3b8;">'+(o.employeeNumber||'')+'</div></td>' +
        '<td>'+dt+'</td>' +
        '<td style="font-weight:800;color:#0ea5e9;">'+hrs+'</td>' +
        '<td><span class="badge" style="background:#fef3c7;color:#92400e;">'+o.multiplier+'x</span></td>' +
        '<td style="font-size:12px;">'+(o.ruleName||'—')+'</td>' +
        '<td><span class="badge" style="background:'+sClr[o.status]+'20;color:'+sClr[o.status]+';">'+(sMap[o.status]||o.status)+'</span></td>' +
        '<td>'+actions+'</td>' +
      '</tr>';
    }).join('');
  }).getHrOvertimeEntries(params);
}

function hrApproveOt(id) {
  erpConfirm('اعتماد الإضافي', 'هل توافق على هذه الساعات الإضافية؟', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم الاعتماد');hrLoadOvertimeEntries();}else showToast(r.error,true); }).approveOvertime(id, currentUser);
  }, { icon:'fa-check-circle', color:'#10b981', okText:'اعتماد' });
}

function hrRejectOt(id) {
  erpConfirm('رفض الإضافي', 'سيتم رفض هذه الساعات الإضافية.', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم الرفض');hrLoadOvertimeEntries();}else showToast(r.error,true); }).rejectOvertime(id, currentUser, '');
  }, { icon:'fa-times-circle', color:'#ef4444', okText:'رفض' });
}

function hrOpenOtRulesModal() {
  loader(true);
  window._apiBridge.withSuccessHandler(function(rules) {
    loader(false);
    document.getElementById('erpModalTitle').textContent = 'قواعد الإضافي';
    var html = '<div style="font-size:12px;color:#64748b;margin-bottom:10px;">قواعد حساب الإضافي حسب نوع اليوم</div>';
    html += '<div style="display:flex;flex-direction:column;gap:10px;">';
    (rules||[]).forEach(function(r) {
      var typeLabel = {workday:'يوم عمل',restday:'يوم راحة',holiday:'عطلة رسمية'}[r.dayType]||r.dayType;
      html += '<div style="padding:12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;align-items:center;">';
      html += '<div><b>'+r.name+'</b><div style="font-size:11px;color:#94a3b8;">'+typeLabel+'</div></div>';
      html += '<div><span style="font-size:11px;color:#94a3b8;">المعامل</span><div style="font-weight:800;color:#f59e0b;">'+r.multiplier+'x</div></div>';
      html += '<div><span style="font-size:11px;color:#94a3b8;">الحد الأدنى</span><div style="font-weight:700;">'+r.minMinutes+' د</div></div>';
      html += '<div><span style="font-size:11px;color:#94a3b8;">اعتماد</span><div>'+(r.requireApproval?'<span style="color:#10b981;">✓</span>':'<span style="color:#ef4444;">✗</span>')+'</div></div>';
      html += '</div>';
    });
    html += '</div><p style="font-size:11px;color:#64748b;margin-top:12px;"><i class="fas fa-info-circle"></i> لتعديل القواعد استخدم API: POST /api/hr/overtime-rules</p>';
    document.getElementById('erpModalBody').innerHTML = html;
    document.getElementById('erpModalSaveBtn').style.display = 'none';
    document.getElementById('erpModal').classList.remove('hidden');
    setTimeout(function(){ document.getElementById('erpModalSaveBtn').style.display=''; }, 100);
  }).getHrOvertimeRules();
}

// ═══════════════════════════════════════════════════════════════
// HR EXCEPTIONS
// ═══════════════════════════════════════════════════════════════
function hrLoadExceptions() {
  var tb = document.getElementById('hrExcBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  var params = {};
  var t = document.getElementById('hrExcTypeFilter').value;
  if (t) params.type = t;
  if (document.getElementById('hrExcActiveOnly').checked) params.active = '1';
  window._apiBridge.withSuccessHandler(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد استثناءات</td></tr>'; return; }
    var tMap = {ignore_late:'تجاهل تأخير',ignore_early_leave:'تجاهل انصراف مبكر',ignore_overtime:'تجاهل إضافي',adjust_attendance:'تعديل حضور',grant_day:'منح يوم',excuse_absence:'تبرير غياب'};
    var tClr = {ignore_late:'#f59e0b',ignore_early_leave:'#f59e0b',ignore_overtime:'#8b5cf6',adjust_attendance:'#0ea5e9',grant_day:'#10b981',excuse_absence:'#16a34a'};
    tb.innerHTML = list.map(function(x) {
      var sd = x.startDate ? new Date(x.startDate).toLocaleDateString('en-GB') : '';
      var ed = x.endDate ? new Date(x.endDate).toLocaleDateString('en-GB') : '';
      return '<tr><td style="font-weight:700;">'+(x.employeeName||'')+'<div style="font-size:10px;color:#94a3b8;">'+(x.employeeNumber||'')+'</div></td>' +
        '<td><span class="badge" style="background:'+tClr[x.type]+'20;color:'+tClr[x.type]+';">'+(tMap[x.type]||x.type)+'</span></td>' +
        '<td>'+sd+'</td><td>'+ed+'</td>' +
        '<td style="font-size:12px;">'+(x.reason||'—')+'</td>' +
        '<td style="font-size:11px;color:#64748b;">'+(x.createdBy||'')+'</td>' +
        '<td><button class="btn-icon" style="color:#ef4444;" onclick="hrDeleteException(\''+x.id+'\')" title="حذف"><i class="fas fa-trash"></i></button></td></tr>';
    }).join('');
  }).getHrExceptions(params);
}

function hrOpenExceptionModal() {
  loader(true);
  window._apiBridge.withSuccessHandler(function(emps) {
    loader(false);
    var empOpts = (emps||[]).map(function(e){return '<option value="'+e.id+'">'+(e.fullName||'')+' — '+(e.employeeNumber||'')+'</option>';}).join('');
    var today = new Date().toISOString().slice(0,10);
    document.getElementById('erpModalTitle').textContent = 'استثناء جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="form-row"><label>الموظف *</label><select class="form-control" id="excEmp"><option value="">— اختر —</option>'+empOpts+'</select></div>' +
      '<div class="form-row"><label>نوع الاستثناء *</label><select class="form-control" id="excType" onchange="hrExcTypeChanged()">' +
        '<option value="ignore_late">تجاهل التأخير</option>' +
        '<option value="ignore_early_leave">تجاهل الانصراف المبكر</option>' +
        '<option value="ignore_overtime">تجاهل الإضافي</option>' +
        '<option value="adjust_attendance">تعديل الحضور (ساعات محددة)</option>' +
        '<option value="grant_day">منح يوم عمل</option>' +
        '<option value="excuse_absence">تبرير غياب (مأذون/مرضي بدون خصم)</option>' +
      '</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>من تاريخ *</label><input type="date" class="form-control" id="excStart" value="'+today+'"></div>' +
        '<div class="form-row"><label>إلى تاريخ *</label><input type="date" class="form-control" id="excEnd" value="'+today+'"></div>' +
      '</div>' +
      '<div id="excAdjustFields" style="display:none;"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>وقت الدخول الجديد</label><input type="time" class="form-control" id="excNewIn"></div>' +
        '<div class="form-row"><label>وقت الخروج الجديد</label><input type="time" class="form-control" id="excNewOut"></div>' +
      '</div></div>' +
      '<div class="form-row"><label>السبب</label><textarea class="form-control" id="excReason" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = hrSaveException;
    document.getElementById('erpModal').classList.remove('hidden');
  }).getHrEmployees({ status: 'active' });
}

window.hrExcTypeChanged = function() {
  var t = document.getElementById('excType').value;
  document.getElementById('excAdjustFields').style.display = t === 'adjust_attendance' ? 'block' : 'none';
};

function hrSaveException() {
  var data = {
    employeeId: document.getElementById('excEmp').value,
    type: document.getElementById('excType').value,
    startDate: document.getElementById('excStart').value,
    endDate: document.getElementById('excEnd').value,
    newClockIn: document.getElementById('excNewIn').value || null,
    newClockOut: document.getElementById('excNewOut').value || null,
    reason: document.getElementById('excReason').value,
    username: currentUser
  };
  if (!data.employeeId || !data.type || !data.startDate || !data.endDate) return showToast('البيانات ناقصة', true);
  loader(true);
  window._apiBridge.withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم إضافة الاستثناء');erpCloseModal();hrLoadExceptions();}else showToast(r.error,true); }).saveHrException(data);
}

function hrDeleteException(id) {
  erpConfirm('حذف الاستثناء', 'هل أنت متأكد؟', function() {
    loader(true);
    window._apiBridge.withSuccessHandler(function(r){ loader(false); if(r.success){showToast('تم الحذف');hrLoadExceptions();}else showToast(r.error,true); }).deleteHrException(id);
  }, { icon:'fa-trash', color:'#ef4444', okText:'حذف' });
}
