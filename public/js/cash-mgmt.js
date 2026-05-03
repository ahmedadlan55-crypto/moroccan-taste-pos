// ═══════════════════════════════════════════════════════════════
// CASH MANAGEMENT MODULE — Modern UI
// ═══════════════════════════════════════════════════════════════

var _cashBoxes = [], _bankAccounts = [];

function _cashAPI(method, path, body) {
  var token = localStorage.getItem('pos_token');
  var opts = { method: method, headers: { 'Authorization': 'Bearer ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch('/api/cash' + path, opts).then(function(r) { return r.json(); });
}

function _fmt(v) { return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────
function cashLoadDashboard() {
  _cashAPI('GET', '/summary').then(function(d) {
    document.getElementById('cashDashKpis').innerHTML =
      _cashKpi('#dcfce7','#166534','fa-cash-register','إجمالي الصناديق', _fmt(d.cashTotal), d.cashBoxCount + ' صندوق') +
      _cashKpi('#dbeafe','#1e40af','fa-university','إجمالي البنوك', _fmt(d.bankTotal), d.bankCount + ' حساب') +
      _cashKpi('#ecfdf5','#10b981','fa-arrow-down','قبض الشهر', _fmt(d.monthReceipts), 'إجمالي المقبوضات') +
      _cashKpi('#fef2f2','#ef4444','fa-arrow-up','صرف الشهر', _fmt(d.monthPayments), 'إجمالي المدفوعات');
  });
  _cashAPI('GET', '/cash-boxes').then(function(list) {
    var h = '';
    if (!list.length) h = '<div style="color:#94a3b8;text-align:center;padding:10px;">لا توجد صناديق</div>';
    else h = list.map(function(b) {
      return '<div style="display:flex;justify-content:space-between;padding:10px;border-bottom:1px solid #f1f5f9;"><span style="font-weight:700;">'+b.name+'</span><span style="color:#16a34a;font-weight:800;">'+_fmt(b.balance)+'</span></div>';
    }).join('');
    document.getElementById('cashDashBoxes').innerHTML = h;
  });
  _cashAPI('GET', '/bank-accounts').then(function(list) {
    var h = '';
    if (!list.length) h = '<div style="color:#94a3b8;text-align:center;padding:10px;">لا توجد حسابات بنكية</div>';
    else h = list.map(function(b) {
      return '<div style="display:flex;justify-content:space-between;padding:10px;border-bottom:1px solid #f1f5f9;"><span style="font-weight:700;">'+b.bankName+'</span><span style="color:#1e40af;font-weight:800;">'+_fmt(b.balance)+'</span></div>';
    }).join('');
    document.getElementById('cashDashBanks').innerHTML = h;
  });
}

function _cashKpi(bg, color, icon, label, val, sub) {
  return '<div style="background:' + bg + ';border-radius:16px;padding:20px;border:1px solid ' + color + '20;">' +
    '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px;">' +
      '<div><div style="font-size:12px;font-weight:700;color:' + color + ';opacity:0.8;">' + label + '</div>' +
      '<div style="font-size:24px;font-weight:900;color:' + color + ';margin-top:4px;">' + val + '</div></div>' +
      '<i class="fas ' + icon + '" style="font-size:28px;color:' + color + ';opacity:0.3;"></i>' +
    '</div><div style="font-size:11px;color:' + color + ';opacity:0.7;">' + sub + '</div></div>';
}

// ─────────────────────────────────────────────────────────────
// Cash Boxes Grid
// ─────────────────────────────────────────────────────────────
function cashLoadBoxes() {
  var c = document.getElementById('cashBoxesGrid');
  c.innerHTML = '<div style="text-align:center;padding:30px;"><i class="fas fa-spinner fa-spin"></i></div>';
  _cashAPI('GET', '/cash-boxes').then(function(list) {
    _cashBoxes = list || [];
    if (!list.length) { c.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-cash-register" style="font-size:48px;opacity:0.3;"></i><p>لا توجد صناديق — اضغط "صندوق جديد"</p></div>'; return; }
    c.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">' +
      list.map(function(b) {
        var tMap = {main:'رئيسي',branch:'فرعي',petty:'نثرية'};
        var tClr = {main:'#3b82f6',branch:'#16a34a',petty:'#f59e0b'};
        return '<div style="background:linear-gradient(135deg,#fff,#f0fdf4);border:1px solid #dcfce7;border-radius:16px;padding:18px;position:relative;box-shadow:0 2px 4px rgba(0,0,0,.04);">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">' +
            '<div><div style="font-size:14px;font-weight:800;color:#0f172a;">'+b.name+'</div>' +
              '<div style="font-size:11px;color:#64748b;margin-top:2px;">' + (b.code||'') + '</div></div>' +
            '<span style="padding:2px 8px;border-radius:6px;background:'+tClr[b.type]+'20;color:'+tClr[b.type]+';font-size:10px;font-weight:800;">'+(tMap[b.type]||b.type)+'</span>' +
          '</div>' +
          '<div style="font-size:28px;font-weight:900;color:#16a34a;margin:8px 0;">'+_fmt(b.balance)+' <span style="font-size:14px;color:#94a3b8;">'+b.currency+'</span></div>' +
          (b.branchName?'<div style="font-size:11px;color:#64748b;"><i class="fas fa-code-branch"></i> '+b.branchName+'</div>':'') +
          (b.keeperUsername?'<div style="font-size:11px;color:#64748b;"><i class="fas fa-user"></i> '+b.keeperUsername+'</div>':'') +
          '<div style="display:flex;gap:6px;margin-top:14px;">' +
            '<button class="btn btn-sm" style="background:#dcfce7;color:#166534;border-radius:8px;flex:1;" onclick="cashEditBox(\''+b.id+'\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
            '<button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border-radius:8px;" onclick="cashDeleteBox(\''+b.id+'\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div></div>';
      }).join('') + '</div>';
  });
}

function cashOpenBoxModal() { cashEditBox(null); }
function cashEditBox(id) {
  var b = id ? _cashBoxes.find(function(x){return x.id===id;}) : null;
  var d = b || { type:'branch', currency:'SAR' };
  // V5.9.13 — also load the GL accounts under root 1101 (النقدية) so the
  // user picks the box's GL account explicitly instead of relying on the
  // implicit auto-create that ran on first transaction.
  Promise.all([
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res).getBranchesFull(); }),
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res).getBrands(); }),
    _cashAPI('GET', '/gl-accounts-tree?root=1101')
  ]).then(function(r) {
    var brs = r[0]||[], brands = r[1]||[], glAccs = Array.isArray(r[2]) ? r[2] : [];
    var brOpts = brs.map(function(x){return '<option value="'+x.id+'"'+(d.branchId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var brandOpts = brands.map(function(x){return '<option value="'+x.id+'"'+(d.brandId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    // Build a labelled GL options list. Indent by level so the tree is visible
    // even inside a flat <select>.
    var glOpts = '<option value="">— تلقائي (سيُنشأ عند الحفظ) —</option>' +
      glAccs.filter(function(a){ return a.code !== '1101'; }) // hide the root itself
            .map(function(a) {
              var pad = a.level && a.level > 3 ? '— '.repeat(Math.max(0, a.level - 3)) : '';
              var sel = (d.glAccountId && d.glAccountId === a.id) ? ' selected' : '';
              return '<option value="'+a.id+'"'+sel+'>'+pad+a.code+' — '+(a.nameAr||'')+'</option>';
            }).join('');
    document.getElementById('erpModalTitle').textContent = id ? 'تعديل صندوق' : 'صندوق جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="cbId" value="'+(d.id||'')+'">' +
      '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>اسم الصندوق *</label><input class="form-control" id="cbName" value="'+(d.name||'')+'"></div>' +
        '<div class="form-row"><label>الرمز</label><input class="form-control" id="cbCode" value="'+(d.code||'')+'"></div>' +
        '<div class="form-row"><label>النوع</label><select class="form-control" id="cbType"><option value="main"'+(d.type==='main'?' selected':'')+'>رئيسي</option><option value="branch"'+(d.type==='branch'?' selected':'')+'>فرعي</option><option value="petty"'+(d.type==='petty'?' selected':'')+'>نثرية</option></select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>البراند</label><select class="form-control" id="cbBrand"><option value="">—</option>'+brandOpts+'</select></div>' +
        '<div class="form-row"><label>الفرع</label><select class="form-control" id="cbBranch"><option value="">—</option>'+brOpts+'</select></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>أمين الصندوق (username)</label><input class="form-control" id="cbKeeper" value="'+(d.keeperUsername||'')+'"></div>' +
        '<div class="form-row"><label>العملة</label><input class="form-control" id="cbCurrency" value="'+(d.currency||'SAR')+'"></div>' +
      '</div>' +
      '<div class="form-row" style="margin-top:6px;">' +
        '<label><i class="fas fa-book" style="color:#7f1d1d;margin-inline-end:4px;"></i> حساب الأستاذ (1101 — النقدية)</label>' +
        '<select class="form-control" id="cbGlAccount" style="font-family:ui-monospace,Menlo,monospace;">'+glOpts+'</select>' +
        '<small style="color:#94a3b8;font-size:11px;display:block;margin-top:3px;">اختر الحساب من شجرة الحسابات. اتركه افتراضياً ليُنشأ تلقائياً تحت 1101.</small>' +
      '</div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSaveBox;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}
function cashSaveBox() {
  var data = {
    id: document.getElementById('cbId').value || undefined,
    name: document.getElementById('cbName').value,
    code: document.getElementById('cbCode').value,
    type: document.getElementById('cbType').value,
    brandId: document.getElementById('cbBrand').value,
    branchId: document.getElementById('cbBranch').value,
    keeperUsername: document.getElementById('cbKeeper').value,
    currency: document.getElementById('cbCurrency').value || 'SAR',
    glAccountId: (document.getElementById('cbGlAccount')||{}).value || '',
    username: currentUser
  };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  _cashAPI('POST', '/cash-boxes', data).then(function(r) {
    loader(false);
    if (r.success) { showToast('تم الحفظ'); erpCloseModal(); cashLoadBoxes(); }
    else showToast(r.error, true);
  });
}
function cashDeleteBox(id) {
  erpConfirm('حذف الصندوق', 'هل أنت متأكد؟', function() {
    loader(true);
    _cashAPI('DELETE', '/cash-boxes/'+id).then(function(r) { loader(false); showToast('تم الحذف'); cashLoadBoxes(); });
  }, {icon:'fa-trash',color:'#ef4444',okText:'حذف'});
}

// ─────────────────────────────────────────────────────────────
// Bank Accounts Grid
// ─────────────────────────────────────────────────────────────
function cashLoadBanks() {
  var c = document.getElementById('bankAccountsGrid');
  c.innerHTML = '<div style="text-align:center;padding:30px;"><i class="fas fa-spinner fa-spin"></i></div>';
  _cashAPI('GET', '/bank-accounts').then(function(list) {
    _bankAccounts = list || [];
    if (!list.length) { c.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-university" style="font-size:48px;opacity:0.3;"></i><p>لا توجد حسابات بنكية</p></div>'; return; }
    c.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;">' +
      list.map(function(b) {
        return '<div style="background:linear-gradient(135deg,#fff,#eff6ff);border:1px solid #dbeafe;border-radius:16px;padding:18px;box-shadow:0 2px 4px rgba(0,0,0,.04);">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">' +
            '<div style="flex:1;"><div style="font-size:14px;font-weight:800;color:#0f172a;">'+b.bankName+'</div>' +
              (b.accountName?'<div style="font-size:11px;color:#64748b;margin-top:2px;">'+b.accountName+'</div>':'') + '</div>' +
            '<i class="fas fa-university" style="color:#3b82f6;font-size:20px;"></i>' +
          '</div>' +
          '<div style="font-size:28px;font-weight:900;color:#1e40af;margin:8px 0;">'+_fmt(b.balance)+' <span style="font-size:14px;color:#94a3b8;">'+b.currency+'</span></div>' +
          (b.accountNumber?'<div style="font-size:11px;color:#64748b;"><i class="fas fa-hashtag"></i> '+b.accountNumber+'</div>':'') +
          (b.iban?'<div style="font-size:11px;color:#64748b;font-family:monospace;"><i class="fas fa-barcode"></i> '+b.iban+'</div>':'') +
          '<div style="display:flex;gap:6px;margin-top:14px;">' +
            '<button class="btn btn-sm" style="background:#dbeafe;color:#1e40af;border-radius:8px;flex:1;" onclick="cashEditBank(\''+b.id+'\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
            '<button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border-radius:8px;" onclick="cashDeleteBank(\''+b.id+'\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div></div>';
      }).join('') + '</div>';
  });
}

function cashOpenBankModal() { cashEditBank(null); }
function cashEditBank(id) {
  var b = id ? _bankAccounts.find(function(x){return x.id===id;}) : null;
  var d = b || { currency:'SAR' };
  // V5.9.13 — also fetch GL accounts under root 1102 (البنوك) for the picker.
  Promise.all([
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res).getBrands(); }),
    _cashAPI('GET', '/gl-accounts-tree?root=1102')
  ]).then(function(r) {
    var brands = r[0]||[], glAccs = Array.isArray(r[1]) ? r[1] : [];
    var brandOpts = brands.map(function(x){return '<option value="'+x.id+'"'+(d.brandId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var glOpts = '<option value="">— تلقائي (سيُنشأ عند الحفظ) —</option>' +
      glAccs.filter(function(a){ return a.code !== '1102'; })
            .map(function(a) {
              var pad = a.level && a.level > 3 ? '— '.repeat(Math.max(0, a.level - 3)) : '';
              var sel = (d.glAccountId && d.glAccountId === a.id) ? ' selected' : '';
              return '<option value="'+a.id+'"'+sel+'>'+pad+a.code+' — '+(a.nameAr||'')+'</option>';
            }).join('');
    document.getElementById('erpModalTitle').textContent = id ? 'تعديل حساب بنكي' : 'حساب بنكي جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<input type="hidden" id="baId" value="'+(d.id||'')+'">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>اسم البنك *</label><input class="form-control" id="baBankName" value="'+(d.bankName||'')+'" placeholder="الراجحي، الأهلي..."></div>' +
        '<div class="form-row"><label>اسم الحساب</label><input class="form-control" id="baAccName" value="'+(d.accountName||'')+'"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>رقم الحساب</label><input class="form-control" id="baAccNum" value="'+(d.accountNumber||'')+'"></div>' +
        '<div class="form-row"><label>IBAN</label><input class="form-control" id="baIban" value="'+(d.iban||'')+'" style="font-family:monospace;"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>البراند</label><select class="form-control" id="baBrand"><option value="">—</option>'+brandOpts+'</select></div>' +
        '<div class="form-row"><label>العملة</label><input class="form-control" id="baCurrency" value="'+(d.currency||'SAR')+'"></div>' +
      '</div>' +
      '<div class="form-row" style="margin-top:6px;">' +
        '<label><i class="fas fa-book" style="color:#1e40af;margin-inline-end:4px;"></i> حساب الأستاذ (1102 — البنوك)</label>' +
        '<select class="form-control" id="baGlAccount" style="font-family:ui-monospace,Menlo,monospace;">'+glOpts+'</select>' +
        '<small style="color:#94a3b8;font-size:11px;display:block;margin-top:3px;">اختر حساب البنك من شجرة الحسابات. اتركه افتراضياً ليُنشأ تلقائياً تحت 1102.</small>' +
      '</div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSaveBank;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}
function cashSaveBank() {
  var data = {
    id: document.getElementById('baId').value || undefined,
    bankName: document.getElementById('baBankName').value,
    accountName: document.getElementById('baAccName').value,
    accountNumber: document.getElementById('baAccNum').value,
    iban: document.getElementById('baIban').value,
    brandId: document.getElementById('baBrand').value,
    currency: document.getElementById('baCurrency').value || 'SAR',
    glAccountId: (document.getElementById('baGlAccount')||{}).value || ''
  };
  if (!data.bankName) return showToast('اسم البنك مطلوب', true);
  loader(true);
  _cashAPI('POST', '/bank-accounts', data).then(function(r) {
    loader(false);
    if (r.success) { showToast('تم الحفظ'); erpCloseModal(); cashLoadBanks(); }
    else showToast(r.error, true);
  });
}
function cashDeleteBank(id) {
  erpConfirm('حذف الحساب البنكي', 'هل أنت متأكد؟', function() {
    loader(true);
    _cashAPI('DELETE', '/bank-accounts/'+id).then(function() { loader(false); showToast('تم الحذف'); cashLoadBanks(); });
  }, {icon:'fa-trash',color:'#ef4444',okText:'حذف'});
}

// ─────────────────────────────────────────────────────────────
// Helper: destination/source picker (cash box or bank account)
// ─────────────────────────────────────────────────────────────
function _cashDestinationSelect(elId, label, selectedType, selectedId) {
  var html = '<label>' + label + ' *</label>' +
    '<select class="form-control" id="' + elId + '" style="margin-bottom:6px;">' +
      '<optgroup label="🏦 الصناديق">' +
        _cashBoxes.map(function(b){return '<option value="cash:'+b.id+'"'+(selectedType==='cash'&&selectedId===b.id?' selected':'')+'>'+b.name+' — '+_fmt(b.balance)+'</option>';}).join('') +
      '</optgroup>' +
      '<optgroup label="💳 البنوك">' +
        _bankAccounts.map(function(b){return '<option value="bank:'+b.id+'"'+(selectedType==='bank'&&selectedId===b.id?' selected':'')+'>'+b.bankName+' — '+_fmt(b.balance)+'</option>';}).join('') +
      '</optgroup>' +
    '</select>';
  return html;
}

function _ensureCashBoxesLoaded(cb) {
  if (_cashBoxes.length || _bankAccounts.length) return cb();
  Promise.all([_cashAPI('GET','/cash-boxes'), _cashAPI('GET','/bank-accounts')]).then(function(res){
    _cashBoxes = res[0]||[]; _bankAccounts = res[1]||[]; cb();
  });
}

// ─────────────────────────────────────────────────────────────
// Receipts
// ─────────────────────────────────────────────────────────────
// V5.9.14 — receipts list now shows the draft/posted/cancelled status
// pill and exposes per-row Approve / Print / Cancel buttons.
function cashLoadReceipts() {
  var tb = document.getElementById('cashReceiptsBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  _cashAPI('GET', '/receipts').then(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد سندات قبض</td></tr>'; return; }
    var sMap = {customer:'عميل',employee:'موظف',rent:'إيجار',sales:'مبيعات',other:'أخرى'};
    var statusPill = function(s) {
      if (s === 'draft')     return '<span class="badge" style="background:#f1f5f9;color:#475569;">مسودة</span>';
      if (s === 'posted')    return '<span class="badge" style="background:#dcfce7;color:#166534;">مُرحَّل ✓</span>';
      if (s === 'cancelled') return '<span class="badge" style="background:#fee2e2;color:#991b1b;">ملغى</span>';
      return '<span class="badge">'+(s||'')+'</span>';
    };
    tb.innerHTML = list.map(function(r) {
      var dt = r.receiptDate ? new Date(r.receiptDate).toLocaleDateString('en-GB') : '';
      var actions = '<button class="btn btn-sm" style="background:#f0f9ff;color:#075985;border-radius:6px;font-size:11px;padding:3px 8px;" onclick="cashPrintVoucher(\''+r.id+'\',\'receipt\')" title="طباعة"><i class="fas fa-print"></i></button>';
      if (r.status === 'draft') {
        actions = '<button class="btn btn-sm" style="background:#dcfce7;color:#166534;border-radius:6px;font-size:11px;padding:3px 8px;font-weight:700;" onclick="cashApproveReceipt(\''+r.id+'\',\''+(r.receiptNumber||'')+'\')" title="اعتماد"><i class="fas fa-check"></i> اعتماد</button> ' + actions +
          ' <button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border-radius:6px;font-size:11px;padding:3px 8px;" onclick="cashCancelReceipt(\''+r.id+'\')" title="إلغاء"><i class="fas fa-times"></i></button>';
      }
      // V5.10.3 — surface creator name + manual-GL badge in the row
      var creator = r.createdByName || r.createdBy || '—';
      var manualBadge = r.hasManualGl ? ' <span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;margin-inline-start:4px;font-weight:700;" title="قيد محاسبي يدوي">قيد يدوي</span>' : '';
      return '<tr><td><code style="font-weight:700;color:#10b981;">'+r.receiptNumber+'</code>'+manualBadge+'</td>' +
        '<td>'+dt+'</td>' +
        '<td>'+(r.sourceName||'')+' <span style="font-size:10px;color:#94a3b8;">('+(sMap[r.sourceType]||r.sourceType)+')</span></td>' +
        '<td><span style="font-size:11px;color:#64748b;">'+(r.destinationType==='cash'?'صندوق':'بنك')+'</span></td>' +
        '<td style="text-align:start;font-weight:800;color:#10b981;">'+_fmt(r.amount)+'</td>' +
        '<td><span style="font-size:11px;color:#475569;"><i class="fas fa-user-circle" style="color:#94a3b8;margin-inline-end:3px;"></i>'+_cashEsc(creator)+'</span></td>' +
        '<td>'+statusPill(r.status)+'</td>' +
        '<td style="white-space:nowrap;">'+actions+'</td></tr>';
    }).join('');
  });
}

window.cashApproveReceipt = function(id, number) {
  if (!confirm('اعتماد سند القبض «' + (number||id) + '»؟ سيتم ترحيل القيد المحاسبي تلقائياً.')) return;
  loader(true);
  _cashAPI('POST', '/receipts/' + id + '/approve', { username: currentUser }).then(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الاعتماد + ترحيل القيد ' + (r.journalNumber||'')); cashLoadReceipts(); }
    else showToast((r && r.error) || 'فشل الاعتماد', true);
  });
};

window.cashCancelReceipt = function(id) {
  if (!confirm('إلغاء سند القبض؟')) return;
  loader(true);
  _cashAPI('POST', '/receipts/' + id + '/cancel', {}).then(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الإلغاء'); cashLoadReceipts(); }
    else showToast((r && r.error) || 'فشل الإلغاء', true);
  });
};

// V5.10.3 — Premium voucher creation modal — sectioned, searchable
// customer/supplier picker, manual GL toggle, COA tree picker for each
// manual journal line. Replaces the v5.9.14 flat form with a layout that
// mirrors the v5.9.4 branch editor + v5.9.7 stock-issue detail visual
// language (sid-* / brf-* tokens).
function cashOpenReceiptModal() { _cashOpenVoucherModal('receipt'); }
function cashOpenPaymentModal() { _cashOpenVoucherModal('payment'); }

function _cashOpenVoucherModal(kind) {
  _cashInjectVoucherStyles();
  var isReceipt = kind === 'receipt';
  var today = new Date().toISOString().slice(0,10);

  // Pull everything we need in parallel: cash-box list (already cached),
  // customers OR suppliers (depending on kind), full COA for the picker.
  var partyEndpoint = isReceipt ? 'getCustomers' : 'getSuppliers';
  Promise.all([
    new Promise(function(res){ _cashAPI('GET', '/cash-boxes').then(res); }),
    new Promise(function(res){ _cashAPI('GET', '/bank-accounts').then(res); }),
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res)[partyEndpoint](); }),
    new Promise(function(res){ _cashAPI('GET', '/gl-accounts-all').then(res); })
  ]).then(function(out) {
    _cashBoxes      = Array.isArray(out[0]) ? out[0] : [];
    _bankAccounts   = Array.isArray(out[1]) ? out[1] : [];
    var parties     = Array.isArray(out[2]) ? out[2] : [];
    var coa         = Array.isArray(out[3]) ? out[3] : [];
    window._cashCoa = coa;  // cached for the manual-GL line picker

    var partyTypeOptions = isReceipt
      ? '<option value="customer">من عميل</option>' +
        '<option value="employee">من موظف (سداد سلفة)</option>' +
        '<option value="rent">من إيجارات</option>' +
        '<option value="sales">من مبيعات</option>' +
        '<option value="other">أخرى</option>'
      : '<option value="supplier">لمورد</option>' +
        '<option value="employee">لموظف (سلفة)</option>' +
        '<option value="expense">مصروف تشغيلي</option>' +
        '<option value="other">أخرى</option>';

    document.getElementById('erpModalTitle').textContent = isReceipt ? 'سند قبض جديد' : 'سند صرف جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div class="cv">' +
        // ── Section 1: Identity ───────────────────────────
        '<section class="cv-section">' +
          '<header class="cv-head"><i class="fas fa-id-card"></i><span>بيانات السند</span></header>' +
          '<div class="cv-grid cv-grid-2">' +
            '<div class="cv-row"><label>تاريخ السند <span class="req">*</span></label><input type="date" class="cv-input" id="cvDate" value="'+today+'"></div>' +
            '<div class="cv-row"><label>المبلغ <span class="req">*</span></label><input type="number" step="0.01" class="cv-input" id="cvAmount" placeholder="0.00"></div>' +
          '</div>' +
          '<div class="cv-row" style="margin-top:10px;">' +
            '<label><i class="fas fa-user-circle" style="color:'+(isReceipt?'#16a34a':'#dc2626')+';margin-inline-end:4px;"></i> اسم المنشئ</label>' +
            '<div class="cv-input" style="background:#f8fafc;color:#475569;font-weight:700;">'+_cashEsc((window.currentUser && currentUser) || '—')+'</div>' +
          '</div>' +
        '</section>' +

        // ── Section 2: Source / Destination (linked to COA) ──
        '<section class="cv-section">' +
          '<header class="cv-head"><i class="fas fa-arrow-' + (isReceipt?'down':'up') + '" style="color:'+(isReceipt?'#16a34a':'#dc2626')+';"></i><span>'+(isReceipt?'الجهة المُودَع فيها':'الجهة المصروف منها')+' (الصندوق / البنك)</span></header>' +
          '<div class="cv-row">' +
            '<label>الصندوق أو البنك <span class="req">*</span></label>' +
            _cashBuildAccountPickerSelect('cvAcc') +
            '<small class="cv-hint"><i class="fas fa-link"></i> ' +
              'كل صندوق/بنك مرتبط بحساب في شجرة الحسابات (1101 للنقد، 1102 للبنوك). يمكن إدارة الربط من «إدارة النقد».' +
            '</small>' +
          '</div>' +
        '</section>' +

        // ── Section 3: Counter-party ─────────────────────────
        '<section class="cv-section">' +
          '<header class="cv-head"><i class="fas fa-handshake"></i><span>'+(isReceipt?'الطرف الآخر (المستلم منه)':'الطرف الآخر (المدفوع له)')+'</span></header>' +
          '<div class="cv-grid cv-grid-2">' +
            '<div class="cv-row"><label>النوع <span class="req">*</span></label>' +
              '<select class="cv-input" id="cvPartyType" onchange="_cvOnPartyTypeChange()">' + partyTypeOptions + '</select>' +
            '</div>' +
            '<div class="cv-row"><label>'+(isReceipt?'العميل':'المورد')+' (من القائمة)</label>' +
              '<select class="cv-input" id="cvPartyId" onchange="_cvOnPartyPick()">' +
                '<option value="">— اختر من القائمة، أو اكتب اسماً يدوياً تحت —</option>' +
                parties.map(function(p){ return '<option value="'+_cashEsc(p.id)+'" data-name="'+_cashEsc(p.name||'')+'">'+_cashEsc(p.name||'')+(p.phone?' · '+_cashEsc(p.phone):'')+'</option>'; }).join('') +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="cv-row" style="margin-top:10px;">' +
            '<label>اسم الطرف (سيظهر على السند والقيد)</label>' +
            '<input class="cv-input" id="cvPartyName" placeholder="يُملأ تلقائياً عند الاختيار من القائمة">' +
          '</div>' +
        '</section>' +

        // ── Section 4: Reference + description ────────────────
        '<section class="cv-section">' +
          '<header class="cv-head"><i class="fas fa-note-sticky"></i><span>المرجع والبيان</span></header>' +
          '<div class="cv-row"><label>المرجع (رقم فاتورة، عقد، إلخ)</label><input class="cv-input" id="cvRef" placeholder="مثال: INV-2026-0123"></div>' +
          '<div class="cv-row" style="margin-top:10px;"><label>البيان</label><textarea class="cv-input" id="cvDesc" rows="2" placeholder="وصف موجز يظهر على السند والقيد المحاسبي..."></textarea></div>' +
        '</section>' +

        // ── Section 5: Manual GL posting (collapsed by default) ──
        '<section class="cv-section">' +
          '<header class="cv-head" style="cursor:pointer;" onclick="_cvToggleManualGl()">' +
            '<i class="fas fa-book-tanakh" style="color:#7f1d1d;"></i>' +
            '<span>ترحيل محاسبي يدوي (اختياري)</span>' +
            '<i class="fas fa-chevron-down" id="cvManualChev" style="margin-inline-start:auto;transition:transform .2s;"></i>' +
          '</header>' +
          '<div id="cvManualBody" style="display:none;">' +
            '<div class="cv-warn">' +
              '<i class="fas fa-circle-info"></i>' +
              '<span>اتركه فارغاً ليُولِّد النظام القيد تلقائياً (Dr الصندوق/البنك → Cr الطرف الآخر). أو اختر يدوياً الحسابات المدينة والدائنة من شجرة الحسابات. الإجمالي يجب أن يساوي مبلغ السند والقيد متوازناً.</span>' +
            '</div>' +
            '<div class="cv-gl-table-wrap">' +
              '<table class="cv-gl-table">' +
                '<thead><tr><th>الحساب</th><th class="num">مدين</th><th class="num">دائن</th><th>وصف السطر</th><th></th></tr></thead>' +
                '<tbody id="cvGlBody"></tbody>' +
                '<tfoot><tr>' +
                  '<td><b>الإجمالي</b></td>' +
                  '<td class="num strong" id="cvGlTotalDr">0.00</td>' +
                  '<td class="num strong" id="cvGlTotalCr">0.00</td>' +
                  '<td colspan="2"><span id="cvGlBalance" class="cv-bal"></span></td>' +
                '</tr></tfoot>' +
              '</table>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px;">' +
              '<button type="button" class="cv-btn-ghost" onclick="_cvAddGlLine()"><i class="fas fa-plus"></i> إضافة سطر</button>' +
              '<button type="button" class="cv-btn-ghost" onclick="_cvAutoFill()" id="cvAutoFillBtn"><i class="fas fa-wand-magic-sparkles"></i> تعبئة تلقائية</button>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</div>';
    // Wire save handler + voucher kind onto the modal
    window._cvKind = kind;
    window._cvManualLines = []; // [{accountId, debit, credit, description}]
    document.getElementById('erpModalSaveBtn').onclick = _cashSaveVoucher;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

// ── Voucher modal helpers ──────────────────────────────────────────────

function _cashEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

function _cashBuildAccountPickerSelect(id) {
  // Cash boxes (linked to 1101) + bank accounts (linked to 1102) — grouped.
  var html = '<select class="cv-input" id="' + id + '">';
  html += '<option value="">— اختر صندوقاً أو حساب بنك —</option>';
  if (_cashBoxes.length) {
    html += '<optgroup label="الصناديق (1101 — النقدية)">';
    _cashBoxes.forEach(function(b) {
      html += '<option value="cash:' + _cashEsc(b.id) + '" data-gl="' + _cashEsc(b.glAccountCode||'') + '">' +
        _cashEsc(b.name) + (b.glAccountCode ? ' · ' + _cashEsc(b.glAccountCode) : '') + '</option>';
    });
    html += '</optgroup>';
  }
  if (_bankAccounts.length) {
    html += '<optgroup label="البنوك (1102 — البنوك)">';
    _bankAccounts.forEach(function(b) {
      html += '<option value="bank:' + _cashEsc(b.id) + '" data-gl="' + _cashEsc(b.glAccountCode||'') + '">' +
        _cashEsc(b.bankName) + (b.glAccountCode ? ' · ' + _cashEsc(b.glAccountCode) : '') + '</option>';
    });
    html += '</optgroup>';
  }
  html += '</select>';
  return html;
}

function _cashInjectVoucherStyles() {
  if (document.getElementById('cvVoucherStyles')) return;
  var st = document.createElement('style');
  st.id = 'cvVoucherStyles';
  st.textContent =
    '.cv{display:flex;flex-direction:column;gap:12px;}' +
    '.cv-section{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;}' +
    '.cv-head{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(135deg,#fafafa,#fff);border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:800;color:#0f172a;}' +
    '.cv-head i:first-child{font-size:14px;}' +
    '.cv-section > .cv-row, .cv-section > .cv-grid{padding:12px 14px;}' +
    '.cv-section > .cv-row + .cv-row, .cv-section > .cv-grid + .cv-row{padding-top:0;}' +
    '.cv-grid{display:grid;gap:10px;}' +
    '.cv-grid-2{grid-template-columns:1fr 1fr;}' +
    '@media(max-width:640px){.cv-grid-2{grid-template-columns:1fr;}}' +
    '.cv-row{display:flex;flex-direction:column;gap:5px;}' +
    '.cv-row label{font-size:12px;font-weight:700;color:#334155;display:flex;align-items:center;gap:4px;}' +
    '.cv-row label .req{color:#ef4444;}' +
    '.cv-input{height:38px;border-radius:10px;border:1.5px solid #e2e8f0;padding:0 10px;font-size:13px;background:#fff;font-family:inherit;transition:border-color .15s,box-shadow .15s;}' +
    'textarea.cv-input{height:auto;padding:8px 10px;}' +
    '.cv-input:focus{outline:none;border-color:#7f1d1d;box-shadow:0 0 0 3px rgba(127,29,29,.1);}' +
    '.cv-hint{font-size:11px;color:#94a3b8;margin-top:4px;display:flex;align-items:center;gap:5px;}' +
    '.cv-hint i{color:#7f1d1d;}' +
    '.cv-warn{margin:14px 14px 8px;padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:10px;font-size:11px;color:#92400e;display:flex;gap:8px;align-items:flex-start;line-height:1.6;}' +
    '.cv-warn i{flex-shrink:0;margin-top:2px;}' +
    '.cv-gl-table-wrap{padding:0 14px 8px;}' +
    '.cv-gl-table{width:100%;border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;}' +
    '.cv-gl-table th{background:#f8fafc;padding:7px 8px;text-align:start;font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #e2e8f0;}' +
    '.cv-gl-table .num{text-align:end;}' +
    '.cv-gl-table td{padding:6px 8px;border-bottom:1px solid #f1f5f9;}' +
    '.cv-gl-table tr:last-child td{border-bottom:none;}' +
    '.cv-gl-table tfoot td{background:#fafafa;font-weight:800;border-top:1.5px solid #e2e8f0;}' +
    '.cv-gl-table .cv-line-sel{width:100%;height:30px;padding:0 6px;border:1px solid #e2e8f0;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;background:#fff;}' +
    '.cv-gl-table .cv-line-amt{width:90px;height:28px;padding:0 6px;border:1px solid #e2e8f0;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;text-align:end;}' +
    '.cv-gl-table .cv-line-desc{width:100%;height:28px;padding:0 6px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;}' +
    '.cv-gl-table .cv-line-del{width:24px;height:24px;border-radius:6px;border:1px solid #fecaca;background:#fee2e2;color:#991b1b;cursor:pointer;}' +
    '.cv-bal{font-size:11px;font-weight:700;}' +
    '.cv-bal.ok{color:#16a34a;}.cv-bal.bad{color:#dc2626;}' +
    '.cv-btn-ghost{height:32px;padding:0 12px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;display:inline-flex;align-items:center;gap:5px;}' +
    '.cv-btn-ghost:hover{background:#fef2f2;border-color:#7f1d1d;color:#7f1d1d;}';
  document.head.appendChild(st);
}

window._cvOnPartyTypeChange = function() {
  // Reset the picker — different list types don't share IDs.
  var sel = document.getElementById('cvPartyId');
  if (sel) { sel.value = ''; }
  var nm = document.getElementById('cvPartyName');
  if (nm) { nm.value = ''; }
};

window._cvOnPartyPick = function() {
  var sel = document.getElementById('cvPartyId');
  var nm = document.getElementById('cvPartyName');
  if (!sel || !nm) return;
  var opt = sel.options[sel.selectedIndex];
  if (opt && opt.dataset && opt.dataset.name) nm.value = opt.dataset.name;
};

window._cvToggleManualGl = function() {
  var body = document.getElementById('cvManualBody');
  var chev = document.getElementById('cvManualChev');
  if (!body) return;
  var open = body.style.display === '';
  body.style.display = open ? 'none' : '';
  if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
  // Add 2 starter lines if empty
  if (!open && (!window._cvManualLines || !window._cvManualLines.length)) {
    window._cvManualLines = [
      { accountId: '', debit: 0, credit: 0, description: '' },
      { accountId: '', debit: 0, credit: 0, description: '' }
    ];
    _cvRenderGlLines();
  }
};

window._cvAddGlLine = function() {
  window._cvManualLines = window._cvManualLines || [];
  window._cvManualLines.push({ accountId: '', debit: 0, credit: 0, description: '' });
  _cvRenderGlLines();
};

window._cvDelGlLine = function(idx) {
  if (!window._cvManualLines) return;
  window._cvManualLines.splice(idx, 1);
  _cvRenderGlLines();
};

window._cvAutoFill = function() {
  // Auto-fill the 2 default lines based on the current voucher selection:
  // Receipt: Dr (cash/bank) Cr (1125/customers default) at the entered amount.
  // Payment: Dr (2101/suppliers default) Cr (cash/bank) at the entered amount.
  var amt = Number((document.getElementById('cvAmount')||{}).value||0);
  if (!amt) { showToast('أدخل المبلغ أولاً', true); return; }
  var dest = (document.getElementById('cvAcc')||{}).value || '';
  var coa = window._cashCoa || [];
  var glRow = function(code) { return coa.find(function(a){return a.code === code;}); };

  // Resolve the selected box/bank → its linked GL account
  var boxOrBank = null;
  if (dest.indexOf('cash:') === 0) boxOrBank = _cashBoxes.find(function(b){return b.id === dest.slice(5);});
  else if (dest.indexOf('bank:') === 0) boxOrBank = _bankAccounts.find(function(b){return b.id === dest.slice(5);});
  var boxAcc = boxOrBank && boxOrBank.glAccountId ? coa.find(function(a){return a.id === boxOrBank.glAccountId;}) : null;
  if (!boxAcc) { showToast('اختر صندوقاً أو بنكاً مرتبطاً بحساب في الشجرة أولاً', true); return; }

  var contraCode = window._cvKind === 'receipt' ? '1125' : '2101';
  var contra = glRow(contraCode) || coa.find(function(a){
    return a.code && a.code.startsWith(window._cvKind === 'receipt' ? '11' : '21');
  });
  if (!contra) { showToast('لم يُعثر على حساب مقابل في الشجرة', true); return; }

  if (window._cvKind === 'receipt') {
    window._cvManualLines = [
      { accountId: boxAcc.id,  debit: amt, credit: 0,   description: 'قبض' },
      { accountId: contra.id,  debit: 0,   credit: amt, description: 'الطرف الآخر' }
    ];
  } else {
    window._cvManualLines = [
      { accountId: contra.id,  debit: amt, credit: 0,   description: 'الطرف الآخر' },
      { accountId: boxAcc.id,  debit: 0,   credit: amt, description: 'صرف' }
    ];
  }
  _cvRenderGlLines();
};

function _cvRenderGlLines() {
  var body = document.getElementById('cvGlBody');
  if (!body) return;
  var lines = window._cvManualLines || [];
  var coa = window._cashCoa || [];
  var coaByType = {};
  coa.forEach(function(a) {
    if (!coaByType[a.type]) coaByType[a.type] = [];
    coaByType[a.type].push(a);
  });
  var typeLabels = { asset:'الأصول', liability:'الالتزامات', equity:'حقوق الملكية', revenue:'الإيرادات', expense:'المصروفات' };
  var optGroups = ['asset','liability','equity','revenue','expense'].map(function(t) {
    var arr = coaByType[t] || [];
    if (!arr.length) return '';
    return '<optgroup label="' + typeLabels[t] + '">' + arr.map(function(a) {
      var pad = a.level && a.level > 1 ? '— '.repeat(a.level - 1) : '';
      return '<option value="' + _cashEsc(a.id) + '">' + pad + _cashEsc(a.code||'') + ' — ' + _cashEsc(a.nameAr||'') + '</option>';
    }).join('') + '</optgroup>';
  }).join('');
  body.innerHTML = lines.map(function(l, i) {
    var sel = '<select class="cv-line-sel" onchange="_cvUpdateLine(' + i + ',\'accountId\',this.value)"><option value="">— اختر حساباً —</option>' + optGroups + '</select>';
    return '<tr>' +
      '<td>' + sel + '</td>' +
      '<td class="num"><input type="number" step="0.01" class="cv-line-amt" value="' + (l.debit||0) + '" oninput="_cvUpdateLine(' + i + ',\'debit\',this.value)"></td>' +
      '<td class="num"><input type="number" step="0.01" class="cv-line-amt" value="' + (l.credit||0) + '" oninput="_cvUpdateLine(' + i + ',\'credit\',this.value)"></td>' +
      '<td><input class="cv-line-desc" value="' + _cashEsc(l.description||'') + '" oninput="_cvUpdateLine(' + i + ',\'description\',this.value)" placeholder="(اختياري)"></td>' +
      '<td><button class="cv-line-del" onclick="_cvDelGlLine(' + i + ')" title="حذف"><i class="fas fa-times"></i></button></td>' +
    '</tr>';
  }).join('');
  // Re-select preserved values (the optGroups html is regenerated each call)
  Array.prototype.forEach.call(body.querySelectorAll('.cv-line-sel'), function(sel, i) {
    if (lines[i] && lines[i].accountId) sel.value = lines[i].accountId;
  });
  _cvRecalcTotals();
}

window._cvUpdateLine = function(idx, field, val) {
  var lines = window._cvManualLines || [];
  if (!lines[idx]) return;
  if (field === 'debit' || field === 'credit') {
    var v = Number(val) || 0;
    lines[idx][field] = v;
    // Mutual exclusion: setting one side to >0 zeros the other (accounting convention)
    if (v > 0) lines[idx][field === 'debit' ? 'credit' : 'debit'] = 0;
  } else {
    lines[idx][field] = val;
  }
  _cvRecalcTotals();
};

function _cvRecalcTotals() {
  var lines = window._cvManualLines || [];
  var dr = lines.reduce(function(s,l){return s + (Number(l.debit)||0);}, 0);
  var cr = lines.reduce(function(s,l){return s + (Number(l.credit)||0);}, 0);
  var fmt = function(v){return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
  var elD = document.getElementById('cvGlTotalDr');
  var elC = document.getElementById('cvGlTotalCr');
  var elB = document.getElementById('cvGlBalance');
  if (elD) elD.textContent = fmt(dr);
  if (elC) elC.textContent = fmt(cr);
  if (elB) {
    var diff = dr - cr;
    if (Math.abs(diff) < 0.01 && dr > 0) {
      elB.textContent = '✓ متوازن';
      elB.className = 'cv-bal ok';
    } else if (dr === 0 && cr === 0) {
      elB.textContent = '';
      elB.className = 'cv-bal';
    } else {
      elB.textContent = '⚠ غير متوازن (فرق ' + fmt(diff) + ')';
      elB.className = 'cv-bal bad';
    }
  }
  // Refresh select values that may have been blanked by re-render
  var body = document.getElementById('cvGlBody');
  if (body) {
    Array.prototype.forEach.call(body.querySelectorAll('.cv-line-sel'), function(sel, i) {
      if (lines[i] && lines[i].accountId && sel.value !== lines[i].accountId) sel.value = lines[i].accountId;
    });
  }
}

function _cashSaveVoucher() {
  var kind = window._cvKind || 'receipt';
  var isReceipt = kind === 'receipt';
  var dest = ((document.getElementById('cvAcc')||{}).value || '').split(':');
  if (!dest[0] || !dest[1]) return showToast('اختر صندوقاً أو حساب بنك', true);
  var amount = Number((document.getElementById('cvAmount')||{}).value || 0);
  if (!amount) return showToast('المبلغ مطلوب', true);
  var partyType = (document.getElementById('cvPartyType')||{}).value;
  var partyId   = (document.getElementById('cvPartyId')||{}).value || null;
  var partyName = (document.getElementById('cvPartyName')||{}).value || '';

  // Manual GL lines — only send if at least 2 lines have non-zero amounts AND the toggle was opened
  var manualBody = document.getElementById('cvManualBody');
  var manualOpen = manualBody && manualBody.style.display !== 'none';
  var manualLines = null;
  if (manualOpen && Array.isArray(window._cvManualLines)) {
    var nonZero = window._cvManualLines.filter(function(l){
      return l.accountId && ((Number(l.debit)||0) > 0 || (Number(l.credit)||0) > 0);
    });
    if (nonZero.length) {
      var dr = nonZero.reduce(function(s,l){return s + (Number(l.debit)||0);}, 0);
      var cr = nonZero.reduce(function(s,l){return s + (Number(l.credit)||0);}, 0);
      if (Math.abs(dr - cr) > 0.01)       return showToast('القيد غير متوازن — مدين ' + dr.toFixed(2) + ' ودائن ' + cr.toFixed(2), true);
      if (Math.abs(dr - amount) > 0.01)   return showToast('إجمالي القيد لا يطابق مبلغ السند', true);
      manualLines = nonZero;
    }
  }

  var payload = {
    receiptDate:  (document.getElementById('cvDate')||{}).value,
    paymentDate:  (document.getElementById('cvDate')||{}).value,
    amount: amount,
    reference: (document.getElementById('cvRef')||{}).value || '',
    description: (document.getElementById('cvDesc')||{}).value || '',
    username: currentUser,
    manualGlLines: manualLines
  };
  if (isReceipt) {
    payload.destinationType = dest[0];
    payload.destinationId   = dest[1];
    payload.sourceType      = partyType;
    payload.sourceId        = partyId;
    payload.sourceName      = partyName;
  } else {
    payload.sourceType    = dest[0];
    payload.sourceId      = dest[1];
    payload.recipientType = partyType;
    payload.recipientId   = partyId;
    payload.recipientName = partyName;
  }
  loader(true);
  _cashAPI('POST', isReceipt ? '/receipts' : '/payments', payload).then(function(r) {
    loader(false);
    if (r && r.success) {
      var msg = 'تم إنشاء سند مسودة: ' + (r.number || '') + (manualLines ? ' (قيد يدوي)' : '');
      showToast(msg + ' — اضغط «اعتماد» لترحيله محاسبياً.');
      erpCloseModal();
      if (isReceipt) cashLoadReceipts(); else cashLoadPayments();
    } else {
      showToast((r && r.error) || 'فشل الحفظ', true);
    }
  });
}

// Backward-compatible alias for the old voucher save handler
function cashSaveReceipt() { _cashSaveVoucher(); }
function cashSavePayment() { _cashSaveVoucher(); }

// ─────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────
function cashLoadPayments() {
  var tb = document.getElementById('cashPaymentsBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  _cashAPI('GET', '/payments').then(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد سندات صرف</td></tr>'; return; }
    var rMap = {supplier:'مورد',employee:'موظف',expense:'مصروف',other:'أخرى'};
    var statusPill = function(s) {
      if (s === 'draft')     return '<span class="badge" style="background:#f1f5f9;color:#475569;">مسودة</span>';
      if (s === 'posted')    return '<span class="badge" style="background:#dcfce7;color:#166534;">مُرحَّل ✓</span>';
      if (s === 'cancelled') return '<span class="badge" style="background:#fee2e2;color:#991b1b;">ملغى</span>';
      return '<span class="badge">'+(s||'')+'</span>';
    };
    tb.innerHTML = list.map(function(r) {
      var dt = r.paymentDate ? new Date(r.paymentDate).toLocaleDateString('en-GB') : '';
      var actions = '<button class="btn btn-sm" style="background:#f0f9ff;color:#075985;border-radius:6px;font-size:11px;padding:3px 8px;" onclick="cashPrintVoucher(\''+r.id+'\',\'payment\')" title="طباعة"><i class="fas fa-print"></i></button>';
      if (r.status === 'draft') {
        actions = '<button class="btn btn-sm" style="background:#dcfce7;color:#166534;border-radius:6px;font-size:11px;padding:3px 8px;font-weight:700;" onclick="cashApprovePayment(\''+r.id+'\',\''+(r.paymentNumber||'')+'\')" title="اعتماد"><i class="fas fa-check"></i> اعتماد</button> ' + actions +
          ' <button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border-radius:6px;font-size:11px;padding:3px 8px;" onclick="cashCancelPayment(\''+r.id+'\')" title="إلغاء"><i class="fas fa-times"></i></button>';
      }
      var creator = r.createdByName || r.createdBy || '—';
      var manualBadge = r.hasManualGl ? ' <span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;margin-inline-start:4px;font-weight:700;" title="قيد محاسبي يدوي">قيد يدوي</span>' : '';
      return '<tr><td><code style="font-weight:700;color:#ef4444;">'+r.paymentNumber+'</code>'+manualBadge+'</td>' +
        '<td>'+dt+'</td>' +
        '<td>'+(r.recipientName||'')+' <span style="font-size:10px;color:#94a3b8;">('+(rMap[r.recipientType]||r.recipientType)+')</span></td>' +
        '<td><span style="font-size:11px;color:#64748b;">'+(r.sourceType==='cash'?'صندوق':'بنك')+'</span></td>' +
        '<td style="text-align:start;font-weight:800;color:#ef4444;">-'+_fmt(r.amount)+'</td>' +
        '<td><span style="font-size:11px;color:#475569;"><i class="fas fa-user-circle" style="color:#94a3b8;margin-inline-end:3px;"></i>'+_cashEsc(creator)+'</span></td>' +
        '<td>'+statusPill(r.status)+'</td>' +
        '<td style="white-space:nowrap;">'+actions+'</td></tr>';
    }).join('');
  });
}

window.cashApprovePayment = function(id, number) {
  if (!confirm('اعتماد سند الصرف «' + (number||id) + '»؟ سيتم ترحيل القيد المحاسبي تلقائياً.')) return;
  loader(true);
  _cashAPI('POST', '/payments/' + id + '/approve', { username: currentUser }).then(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الاعتماد + ترحيل القيد ' + (r.journalNumber||'')); cashLoadPayments(); }
    else showToast((r && r.error) || 'فشل الاعتماد', true);
  });
};

window.cashCancelPayment = function(id) {
  if (!confirm('إلغاء سند الصرف؟')) return;
  loader(true);
  _cashAPI('POST', '/payments/' + id + '/cancel', {}).then(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الإلغاء'); cashLoadPayments(); }
    else showToast((r && r.error) || 'فشل الإلغاء', true);
  });
};

// V5.10.3 — old cashOpenPaymentModal / cashSavePayment removed. The unified
// _cashOpenVoucherModal('payment') and _cashSaveVoucher() handle both kinds.

// ─────────────────────────────────────────────────────────────
// Transfers
// ─────────────────────────────────────────────────────────────
function cashLoadTransfers() {
  var tb = document.getElementById('cashTransfersBody');
  tb.innerHTML = '<tr><td colspan="6" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  _cashAPI('GET', '/transfers').then(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-msg">لا توجد تحويلات</td></tr>'; return; }
    tb.innerHTML = list.map(function(t) {
      var dt = t.transfer_date ? new Date(t.transfer_date).toLocaleDateString('en-GB') : '';
      return '<tr><td><code style="font-weight:700;color:#8b5cf6;">'+t.transfer_number+'</code></td>' +
        '<td>'+dt+'</td>' +
        '<td>'+(t.from_type==='cash'?'صندوق':'بنك')+' <code>'+t.from_id+'</code></td>' +
        '<td>'+(t.to_type==='cash'?'صندوق':'بنك')+' <code>'+t.to_id+'</code></td>' +
        '<td style="text-align:start;font-weight:800;color:#8b5cf6;">'+_fmt(t.amount)+'</td>' +
        '<td style="font-size:12px;">'+(t.description||'')+'</td></tr>';
    }).join('');
  });
}

function cashOpenTransferModal() {
  _ensureCashBoxesLoaded(function() {
    var today = new Date().toISOString().slice(0,10);
    document.getElementById('erpModalTitle').textContent = 'تحويل نقدي جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>التاريخ *</label><input type="date" class="form-control" id="trfDate" value="'+today+'"></div>' +
        '<div class="form-row"><label>المبلغ *</label><input type="number" step="0.01" class="form-control" id="trfAmount"></div>' +
      '</div>' +
      '<div class="form-row">' + _cashDestinationSelect('trfFrom', 'من') + '</div>' +
      '<div class="form-row">' + _cashDestinationSelect('trfTo', 'إلى') + '</div>' +
      '<div class="form-row"><label>الوصف</label><textarea class="form-control" id="trfDesc" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSaveTransfer;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function cashSaveTransfer() {
  var f = document.getElementById('trfFrom').value.split(':');
  var t = document.getElementById('trfTo').value.split(':');
  var data = {
    transferDate: document.getElementById('trfDate').value,
    fromType: f[0], fromId: f[1], toType: t[0], toId: t[1],
    amount: Number(document.getElementById('trfAmount').value)||0,
    description: document.getElementById('trfDesc').value,
    username: currentUser
  };
  if (!data.amount) return showToast('المبلغ مطلوب', true);
  loader(true);
  _cashAPI('POST', '/transfers', data).then(function(r) {
    loader(false);
    if (r.success) { showToast('تم التحويل — قيد: '+r.journalNumber); erpCloseModal(); cashLoadTransfers(); }
    else showToast(r.error, true);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// V5.9.14 — Electronic voucher print (سند قبض / سند صرف).
//
// Same structural pattern as the v5.9.11 stock-issue print template:
// fetch entity + company settings in one server round-trip via the new
// /receipts/:id/print-data and /payments/:id/print-data endpoints, render
// an A5 sheet in a new window, auto-print on load.
//
// The voucher includes:
//   - Letterhead: company logo (if CompanyLogo setting is set), company
//     name (large), tax number, voucher type pill (قبض / صرف).
//   - Voucher number + date in a colored monospace badge.
//   - Status pill (مسودة / مُرحَّل ✓ / ملغى) so a printed cancelled
//     voucher can't be reused.
//   - Counter-party block (received from / paid to) + amount in numerals
//     and the Arabic "amount in words" rendition (handles SAR up to billions).
//   - Source / destination cash-box or bank account name + GL code.
//   - Description / reference / payment method.
//   - 3 signature blocks: المحاسب — المعتمد — المستلم/المُسلِّم.
//   - GL journal reference at the bottom (when posted).
//   - Footer: print timestamp + print user.
//
// The voucher prints on A5 portrait — vouchers in MENA traditionally fit
// on a half-A4 page, two per A4 sheet.
// ─────────────────────────────────────────────────────────────────────────

window.cashPrintVoucher = function(id, kind) {
  // kind: 'receipt' | 'payment'
  var path = (kind === 'payment') ? '/payments/' : '/receipts/';
  _cashAPI('GET', path + id + '/print-data').then(function(r) {
    if (!r || !r.success) return showToast((r && r.error) || 'تعذّر تحميل السند', true);
    _cashRenderVoucher(r.voucher, r.company || {}, kind);
  });
};

function _cashEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// Arabic amount-in-words helper. Covers SAR amounts up to billions with
// halalas. Used to print the voucher's "بالحرف" line.
function _cashAmountInWords(num) {
  num = Math.round(Number(num || 0) * 100) / 100;
  if (!isFinite(num) || num <= 0) return 'صفر ريال';
  var sign = num < 0 ? 'سالب ' : '';
  num = Math.abs(num);
  var halalas = Math.round((num - Math.floor(num)) * 100);
  var whole = Math.floor(num);
  var ones = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة','عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
  var tens = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];
  var hundreds = ['','مئة','مئتان','ثلاثمئة','أربعمئة','خمسمئة','ستمئة','سبعمئة','ثمانمئة','تسعمئة'];
  function under1000(n) {
    if (n < 20) return ones[n];
    if (n < 100) {
      var t = Math.floor(n/10), o = n%10;
      return o === 0 ? tens[t] : ones[o] + ' و' + tens[t];
    }
    var h = Math.floor(n/100), rem = n%100;
    return rem === 0 ? hundreds[h] : hundreds[h] + ' و' + under1000(rem);
  }
  function withScale(n, scaleNames) {
    if (n === 0) return '';
    if (n === 1) return scaleNames[0];
    if (n === 2) return scaleNames[1];
    if (n >= 3 && n <= 10) return ones[n] + ' ' + scaleNames[2];
    return under1000(n) + ' ' + scaleNames[3];
  }
  var parts = [];
  var billions = Math.floor(whole / 1000000000);
  var millions = Math.floor((whole % 1000000000) / 1000000);
  var thousands = Math.floor((whole % 1000000) / 1000);
  var rest = whole % 1000;
  if (billions)  parts.push(withScale(billions,  ['مليار','ملياران','مليارات','مليار']));
  if (millions)  parts.push(withScale(millions,  ['مليون','مليونان','ملايين','مليون']));
  if (thousands) parts.push(withScale(thousands, ['ألف','ألفان','آلاف','ألف']));
  if (rest)      parts.push(under1000(rest));
  var res = sign + parts.join(' و') + ' ريال';
  if (halalas > 0) res += ' و' + under1000(halalas) + ' هللة';
  return res + ' فقط لا غير';
}

function _cashRenderVoucher(v, cfg, kind) {
  var win = window.open('', '_blank', 'width=720,height=900');
  if (!win) return showToast('السماح بالنوافذ المنبثقة مطلوب للطباعة', true);

  var isReceipt = (kind === 'receipt');
  var docTitle = isReceipt ? 'سند قبض' : 'سند صرف';
  var docColor = isReceipt ? '#16a34a' : '#dc2626';
  var docColorBg = isReceipt ? '#dcfce7' : '#fee2e2';
  var num     = isReceipt ? v.receipt_number : v.payment_number;
  var dt      = isReceipt ? v.receipt_date    : v.payment_date;
  var amount  = Number(v.amount || 0);
  var status  = v.status || 'draft';
  var statusLabels = { draft:'مسودة', posted:'مُرحَّل ✓', cancelled:'ملغى' };
  var statusBgs    = { draft:'#f1f5f9', posted:'#dcfce7', cancelled:'#fee2e2' };
  var statusFgs    = { draft:'#475569', posted:'#166534', cancelled:'#991b1b' };

  // Parties
  var counterParty = isReceipt ? (v.source_name || '—') : (v.recipient_name || '—');
  var typeLabel    = isReceipt
    ? ({customer:'عميل', employee:'موظف', rent:'إيجار', sales:'مبيعات', other:'أخرى'}[v.source_type] || v.source_type)
    : ({supplier:'مورد', employee:'موظف', expense:'مصروف', other:'أخرى'}[v.recipient_type] || v.recipient_type);
  var srcDestLabel = isReceipt ? 'المُودَع في' : 'المصروف من';
  var srcDestName  = v.dest_name || v.src_name || '—';
  var srcDestGl    = (v.dest_gl_code || v.src_gl_code) ? ((v.dest_gl_code || v.src_gl_code) + ' — ' + (v.dest_gl_name || v.src_gl_name || '')) : '';

  var company = _cashEsc(cfg.CompanyName || 'Moroccan Taste');
  var taxNum  = _cashEsc(cfg.TaxNumber   || '');
  var logo    = cfg.CompanyLogo || '';

  var fmtDate = function(d) {
    if (!d) return '—';
    try {
      var dt = new Date(d);
      return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
    } catch(e) { return String(d); }
  };
  var fmtNum = function(n) {
    return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  };

  var html =
    '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<title>' + docTitle + ' ' + _cashEsc(num || '') + '</title>' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">' +
    '<style>' +
      '*{box-sizing:border-box;margin:0;padding:0;}' +
      'body{font-family:"Tajawal","Segoe UI",sans-serif;direction:rtl;color:#0f172a;background:#fff;font-size:13px;line-height:1.5;}' +
      '@page{size:A5 portrait;margin:8mm;}' +
      '.sheet{max-width:560px;margin:0 auto;padding:14px 18px;}' +
      '.lh{display:flex;align-items:center;gap:12px;border-bottom:3px solid '+docColor+';padding-bottom:12px;margin-bottom:14px;}' +
      '.lh-logo{width:54px;height:54px;border-radius:10px;background:'+docColorBg+';display:flex;align-items:center;justify-content:center;color:'+docColor+';font-size:24px;flex-shrink:0;overflow:hidden;}' +
      '.lh-logo img{max-width:100%;max-height:100%;object-fit:contain;}' +
      '.lh-text{flex:1;}' +
      '.lh-co{font-size:18px;font-weight:900;color:#0f172a;letter-spacing:-0.02em;}' +
      '.lh-tax{font-size:10px;color:#64748b;margin-top:2px;}' +
      '.lh-doc-pill{padding:5px 12px;border-radius:8px;background:'+docColorBg+';color:'+docColor+';font-weight:800;font-size:14px;}' +
      '.head-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;padding:10px 14px;background:linear-gradient(135deg,'+docColorBg+', #fff);border-radius:10px;}' +
      '.h-num{font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:900;color:'+docColor+';}' +
      '.h-num small{display:block;font-size:9px;color:#64748b;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;}' +
      '.h-date{text-align:start;}' +
      '.h-status{padding:4px 12px;border-radius:999px;font-size:11px;font-weight:800;}' +
      '.amount-block{padding:14px 16px;border:2px dashed '+docColor+';border-radius:12px;margin:14px 0;text-align:center;background:#fff;}' +
      '.amount-num{font-size:30px;font-weight:900;color:'+docColor+';font-family:ui-monospace,Menlo,monospace;letter-spacing:-0.5px;}' +
      '.amount-words{font-size:12px;color:#475569;margin-top:6px;font-weight:700;line-height:1.6;}' +
      '.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0;}' +
      '.field{padding:8px 10px;background:#f8fafc;border-radius:8px;font-size:12px;}' +
      '.field-l{font-size:9px;color:#94a3b8;font-weight:800;letter-spacing:0.4px;text-transform:uppercase;display:block;}' +
      '.field-v{color:#0f172a;font-weight:700;font-size:13px;margin-top:2px;}' +
      '.field-v code{font-family:ui-monospace,Menlo,monospace;background:#fff;padding:1px 6px;border-radius:4px;border:1px solid #e2e8f0;font-size:11px;color:'+docColor+';}' +
      '.field-full{grid-column:1 / -1;}' +
      '.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px;}' +
      '.sig{border-top:1.5px dashed #94a3b8;padding-top:6px;text-align:center;}' +
      '.sig-label{font-size:10px;color:#64748b;font-weight:800;}' +
      '.sig-name{font-size:11px;color:#0f172a;font-weight:700;margin-top:24px;min-height:14px;}' +
      '.foot{margin-top:18px;padding-top:10px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8;}' +
      '.foot code{font-family:ui-monospace,Menlo,monospace;}' +
      '.toolbar{position:fixed;top:10px;inset-inline-end:10px;display:flex;gap:6px;background:#fff;padding:6px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.1);z-index:1000;}' +
      '.toolbar button{height:32px;padding:0 14px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;}' +
      '.toolbar button.primary{background:'+docColor+';color:#fff;border-color:'+docColor+';}' +
      '@media print{.toolbar{display:none;}}' +
    '</style></head><body>' +
      '<div class="toolbar">' +
        '<button class="primary" onclick="window.print()"><i class="fas fa-print"></i> طباعة</button>' +
        '<button onclick="window.close()">إغلاق</button>' +
      '</div>' +
      '<div class="sheet">' +
        '<header class="lh">' +
          '<div class="lh-logo">' + (logo ? '<img src="'+_cashEsc(logo)+'" alt="logo">' : '<i class="fas fa-' + (isReceipt ? 'arrow-down' : 'arrow-up') + '"></i>') + '</div>' +
          '<div class="lh-text">' +
            '<div class="lh-co">' + company + '</div>' +
            (taxNum ? '<div class="lh-tax">الرقم الضريبي: ' + taxNum + '</div>' : '') +
          '</div>' +
          '<div class="lh-doc-pill">' + docTitle + '</div>' +
        '</header>' +

        '<div class="head-row">' +
          '<div class="h-num"><small>رقم السند</small>' + _cashEsc(num || '—') + '</div>' +
          '<div class="h-date"><small style="font-size:9px;color:#64748b;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">التاريخ</small><div style="font-size:14px;font-weight:800;">' + _cashEsc(fmtDate(dt)) + '</div></div>' +
          '<span class="h-status" style="background:' + (statusBgs[status]||'#f1f5f9') + ';color:' + (statusFgs[status]||'#475569') + ';">' + (statusLabels[status]||status) + '</span>' +
        '</div>' +

        '<div class="amount-block">' +
          '<div class="amount-num">' + fmtNum(amount) + ' ' + _cashEsc(cfg.Currency || 'ر.س') + '</div>' +
          '<div class="amount-words">' + _cashEsc(_cashAmountInWords(amount)) + '</div>' +
        '</div>' +

        '<div class="field-grid">' +
          '<div class="field"><span class="field-l">' + (isReceipt ? 'استلمنا من' : 'دفعنا إلى') + '</span><div class="field-v">' + _cashEsc(counterParty) + ' <small style="color:#94a3b8;font-weight:600;">(' + _cashEsc(typeLabel) + ')</small></div></div>' +
          '<div class="field"><span class="field-l">' + srcDestLabel + '</span><div class="field-v">' + _cashEsc(srcDestName) + (srcDestGl ? '<br><code>'+_cashEsc(srcDestGl)+'</code>' : '') + '</div></div>' +
          (v.reference ? '<div class="field field-full"><span class="field-l">المرجع</span><div class="field-v">' + _cashEsc(v.reference) + '</div></div>' : '') +
          (v.description ? '<div class="field field-full"><span class="field-l">البيان</span><div class="field-v" style="font-weight:500;line-height:1.7;">' + _cashEsc(v.description) + '</div></div>' : '') +
        '</div>' +

        '<div class="signatures">' +
          '<div class="sig"><span class="sig-label">المحاسب</span><div class="sig-name">' + _cashEsc(v.created_by_name || v.created_by || '') + '</div></div>' +
          '<div class="sig"><span class="sig-label">المعتمد</span><div class="sig-name">' + _cashEsc(v.approved_by_name || v.approved_by || (status==='posted' ? '' : '—')) + '</div></div>' +
          '<div class="sig"><span class="sig-label">' + (isReceipt ? 'المُسلِّم' : 'المستلم') + '</span><div class="sig-name">' + _cashEsc(counterParty) + '</div></div>' +
        '</div>' +

        (v.journal_id || v.journal_number
          ? '<div style="margin-top:18px;padding:8px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;font-size:11px;color:#92400e;display:flex;justify-content:space-between;align-items:center;"><span><i class="fas fa-book"></i> القيد المحاسبي: <code>' + _cashEsc(v.journal_number || v.journal_id) + '</code></span><span style="color:#16a34a;font-weight:700;">✓ مُرحَّل في الدفاتر</span></div>'
          : '') +

        // V5.10.3 — Manual GL lines table (when the bookkeeper hand-picked Dr/Cr)
        (v.manual_lines && v.manual_lines.length
          ? '<div style="margin-top:14px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;page-break-inside:avoid;">' +
              '<div style="font-size:11px;font-weight:800;color:#9a3412;margin-bottom:6px;display:flex;align-items:center;gap:5px;"><i class="fas fa-book-tanakh"></i> أسطر القيد المحاسبي اليدوي</div>' +
              '<table style="width:100%;border-collapse:collapse;font-size:10.5px;">' +
                '<thead><tr style="background:#9a3412;color:#fff;">' +
                  '<th style="padding:5px 7px;text-align:start;">الحساب</th>' +
                  '<th style="padding:5px 7px;text-align:end;">مدين</th>' +
                  '<th style="padding:5px 7px;text-align:end;">دائن</th>' +
                '</tr></thead>' +
                '<tbody>' + v.manual_lines.map(function(l) {
                  return '<tr style="border-bottom:1px solid #fed7aa;">' +
                    '<td style="padding:4px 7px;"><code style="color:#9a3412;font-family:ui-monospace,Menlo,monospace;">' + _cashEsc(l.accountCode||'') + '</code> ' + _cashEsc(l.accountName||'') +
                      (l.description ? '<div style="color:#94a3b8;font-size:9px;">' + _cashEsc(l.description) + '</div>' : '') +
                    '</td>' +
                    '<td style="padding:4px 7px;text-align:end;font-family:ui-monospace,Menlo,monospace;">' + (Number(l.debit)>0 ? fmtNum(l.debit) : '—') + '</td>' +
                    '<td style="padding:4px 7px;text-align:end;font-family:ui-monospace,Menlo,monospace;">' + (Number(l.credit)>0 ? fmtNum(l.credit) : '—') + '</td>' +
                  '</tr>';
                }).join('') + '</tbody>' +
              '</table>' +
            '</div>'
          : '') +

        '<footer class="foot">' +
          '<span>طُبع: ' + _cashEsc(new Date().toLocaleString('en-GB')) + '</span>' +
          '<span>المعرف: <code>' + _cashEsc(v.id || '') + '</code></span>' +
        '</footer>' +
      '</div>' +
      '<script>window.onload = function(){ setTimeout(function(){ window.focus(); window.print(); }, 250); };</' + 'script>' +
    '</body></html>';

  win.document.open();
  win.document.write(html);
  win.document.close();
}

