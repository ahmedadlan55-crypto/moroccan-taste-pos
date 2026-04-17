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
  Promise.all([
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res).getBranchesFull(); }),
    new Promise(function(res){ window._apiBridge.withSuccessHandler(res).getBrands(); })
  ]).then(function(r) {
    var brs = r[0]||[], brands = r[1]||[];
    var brOpts = brs.map(function(x){return '<option value="'+x.id+'"'+(d.branchId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
    var brandOpts = brands.map(function(x){return '<option value="'+x.id+'"'+(d.brandId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
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
  window._apiBridge.withSuccessHandler(function(brands) {
    var brandOpts = (brands||[]).map(function(x){return '<option value="'+x.id+'"'+(d.brandId===x.id?' selected':'')+'>'+x.name+'</option>';}).join('');
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
      '</div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSaveBank;
    document.getElementById('erpModal').classList.remove('hidden');
  }).getBrands();
}
function cashSaveBank() {
  var data = {
    id: document.getElementById('baId').value || undefined,
    bankName: document.getElementById('baBankName').value,
    accountName: document.getElementById('baAccName').value,
    accountNumber: document.getElementById('baAccNum').value,
    iban: document.getElementById('baIban').value,
    brandId: document.getElementById('baBrand').value,
    currency: document.getElementById('baCurrency').value || 'SAR'
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
function cashLoadReceipts() {
  var tb = document.getElementById('cashReceiptsBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  _cashAPI('GET', '/receipts').then(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد سندات قبض</td></tr>'; return; }
    var sMap = {customer:'عميل',employee:'موظف',rent:'إيجار',sales:'مبيعات',other:'أخرى'};
    tb.innerHTML = list.map(function(r) {
      var dt = r.receiptDate ? new Date(r.receiptDate).toLocaleDateString('en-GB') : '';
      return '<tr><td><code style="font-weight:700;color:#10b981;">'+r.receiptNumber+'</code></td>' +
        '<td>'+dt+'</td>' +
        '<td>'+(r.sourceName||'')+' <span style="font-size:10px;color:#94a3b8;">('+(sMap[r.sourceType]||r.sourceType)+')</span></td>' +
        '<td><span style="font-size:11px;color:#64748b;">'+(r.destinationType==='cash'?'صندوق':'بنك')+'</span></td>' +
        '<td style="text-align:start;font-weight:800;color:#10b981;">'+_fmt(r.amount)+'</td>' +
        '<td style="font-size:12px;">'+(r.description||'')+'</td>' +
        '<td><span class="badge" style="background:#dcfce7;color:#166534;">مرحّل</span></td></tr>';
    }).join('');
  });
}

function cashOpenReceiptModal() {
  _ensureCashBoxesLoaded(function() {
    var today = new Date().toISOString().slice(0,10);
    document.getElementById('erpModalTitle').textContent = 'سند قبض جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>تاريخ السند *</label><input type="date" class="form-control" id="rcptDate" value="'+today+'"></div>' +
        '<div class="form-row"><label>المبلغ *</label><input type="number" step="0.01" class="form-control" id="rcptAmount"></div>' +
      '</div>' +
      '<div class="form-row">' + _cashDestinationSelect('rcptDest', 'يُودَع في') + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>نوع القبض *</label><select class="form-control" id="rcptSrcType">' +
          '<option value="customer">من عميل</option>' +
          '<option value="employee">من موظف (سداد سلفة)</option>' +
          '<option value="rent">من إيجارات</option>' +
          '<option value="sales">من مبيعات</option>' +
          '<option value="other">أخرى</option>' +
        '</select></div>' +
        '<div class="form-row"><label>اسم المصدر (عميل/موظف)</label><input class="form-control" id="rcptSrcName"></div>' +
      '</div>' +
      '<div class="form-row"><label>المرجع (رقم فاتورة، إلخ)</label><input class="form-control" id="rcptRef"></div>' +
      '<div class="form-row"><label>الوصف</label><textarea class="form-control" id="rcptDesc" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSaveReceipt;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function cashSaveReceipt() {
  var dest = document.getElementById('rcptDest').value.split(':');
  var data = {
    receiptDate: document.getElementById('rcptDate').value,
    destinationType: dest[0], destinationId: dest[1],
    sourceType: document.getElementById('rcptSrcType').value,
    sourceName: document.getElementById('rcptSrcName').value,
    amount: Number(document.getElementById('rcptAmount').value)||0,
    reference: document.getElementById('rcptRef').value,
    description: document.getElementById('rcptDesc').value,
    username: currentUser
  };
  if (!data.amount || !data.destinationId) return showToast('المبلغ والوجهة مطلوبان', true);
  loader(true);
  _cashAPI('POST', '/receipts', data).then(function(r) {
    loader(false);
    if (r.success) { showToast('تم القبض — سند: '+r.number+' | قيد: '+r.journalNumber); erpCloseModal(); cashLoadReceipts(); }
    else showToast(r.error, true);
  });
}

// ─────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────
function cashLoadPayments() {
  var tb = document.getElementById('cashPaymentsBody');
  tb.innerHTML = '<tr><td colspan="7" class="empty-msg"><i class="fas fa-spinner fa-spin"></i></td></tr>';
  _cashAPI('GET', '/payments').then(function(list) {
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-msg">لا توجد سندات صرف</td></tr>'; return; }
    var rMap = {supplier:'مورد',employee:'موظف',expense:'مصروف',other:'أخرى'};
    tb.innerHTML = list.map(function(r) {
      var dt = r.paymentDate ? new Date(r.paymentDate).toLocaleDateString('en-GB') : '';
      return '<tr><td><code style="font-weight:700;color:#ef4444;">'+r.paymentNumber+'</code></td>' +
        '<td>'+dt+'</td>' +
        '<td>'+(r.recipientName||'')+' <span style="font-size:10px;color:#94a3b8;">('+(rMap[r.recipientType]||r.recipientType)+')</span></td>' +
        '<td><span style="font-size:11px;color:#64748b;">'+(r.sourceType==='cash'?'صندوق':'بنك')+'</span></td>' +
        '<td style="text-align:start;font-weight:800;color:#ef4444;">-'+_fmt(r.amount)+'</td>' +
        '<td style="font-size:12px;">'+(r.description||'')+'</td>' +
        '<td><span class="badge" style="background:#dcfce7;color:#166534;">مرحّل</span></td></tr>';
    }).join('');
  });
}

function cashOpenPaymentModal() {
  _ensureCashBoxesLoaded(function() {
    var today = new Date().toISOString().slice(0,10);
    document.getElementById('erpModalTitle').textContent = 'سند صرف جديد';
    document.getElementById('erpModalBody').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>تاريخ السند *</label><input type="date" class="form-control" id="payDate" value="'+today+'"></div>' +
        '<div class="form-row"><label>المبلغ *</label><input type="number" step="0.01" class="form-control" id="payAmount"></div>' +
      '</div>' +
      '<div class="form-row">' + _cashDestinationSelect('paySrc', 'يُصرف من') + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-row"><label>نوع الصرف *</label><select class="form-control" id="payRecipType">' +
          '<option value="supplier">لمورد</option>' +
          '<option value="employee">لموظف (سلفة)</option>' +
          '<option value="expense">مصروف تشغيلي</option>' +
          '<option value="other">أخرى</option>' +
        '</select></div>' +
        '<div class="form-row"><label>اسم المستفيد</label><input class="form-control" id="payRecipName"></div>' +
      '</div>' +
      '<div class="form-row"><label>المرجع</label><input class="form-control" id="payRef"></div>' +
      '<div class="form-row"><label>الوصف</label><textarea class="form-control" id="payDesc" rows="2"></textarea></div>';
    document.getElementById('erpModalSaveBtn').onclick = cashSavePayment;
    document.getElementById('erpModal').classList.remove('hidden');
  });
}

function cashSavePayment() {
  var src = document.getElementById('paySrc').value.split(':');
  var data = {
    paymentDate: document.getElementById('payDate').value,
    sourceType: src[0], sourceId: src[1],
    recipientType: document.getElementById('payRecipType').value,
    recipientName: document.getElementById('payRecipName').value,
    amount: Number(document.getElementById('payAmount').value)||0,
    reference: document.getElementById('payRef').value,
    description: document.getElementById('payDesc').value,
    username: currentUser
  };
  if (!data.amount || !data.sourceId) return showToast('المبلغ والمصدر مطلوبان', true);
  loader(true);
  _cashAPI('POST', '/payments', data).then(function(r) {
    loader(false);
    if (r.success) { showToast('تم الصرف — سند: '+r.number+' | قيد: '+r.journalNumber); erpCloseModal(); cashLoadPayments(); }
    else showToast(r.error, true);
  });
}

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
