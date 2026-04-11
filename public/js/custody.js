/**
 * Custody Management (العهد) — frontend logic
 * Lazy-loaded from app.js when user navigates to any custody section.
 */

var _custodyUsersCache = [];
var _custodiesCache = [];

// ═══════════════════════════════════════
// CUSTODY USERS (مسؤولو العهدة)
// ═══════════════════════════════════════

window.loadCustodyUsers = function() {
  loader();
  api.withSuccessHandler(function(list) {
    loader(false);
    _custodyUsersCache = list || [];
    var h = '';
    if (!list.length) { h = '<tr><td colspan="7" style="text-align:center;padding:30px;">لا يوجد مسؤولو عهدة</td></tr>'; }
    else {
      list.forEach(function(u) {
        h += '<tr>' +
          '<td style="font-weight:700;">' + u.name + '</td>' +
          '<td>' + (u.idNumber || '—') + '</td>' +
          '<td>' + (u.phone || '—') + '</td>' +
          '<td>' + (u.jobTitle || '—') + '</td>' +
          '<td><code style="font-size:11px;">' + (u.linkedUsername || '—') + '</code></td>' +
          '<td>' + (u.isActive ? '<span class="badge green">نشط</span>' : '<span class="badge red">معطّل</span>') + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-light btn-sm" onclick="editCustodyUser(\'' + u.id + '\')" title="تعديل"><i class="fas fa-edit"></i></button> ' +
            '<button class="btn btn-' + (u.isActive ? 'danger' : 'success') + ' btn-sm" onclick="toggleCustodyUserFn(\'' + u.id + '\')" title="' + (u.isActive ? 'تعطيل' : 'تفعيل') + '"><i class="fas fa-' + (u.isActive ? 'ban' : 'check') + '"></i></button> ' +
            '<button class="btn btn-danger btn-sm" onclick="deleteCustodyUserFn(\'' + u.id + '\',\'' + (u.name||'').replace(/'/g,'') + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</td></tr>';
      });
    }
    if (document.getElementById('tbCustodyUsers')) document.getElementById('tbCustodyUsers').innerHTML = h;
  }).getCustodyUsers();
};

window.openCustodyUserModal = function(data) {
  var d = data || {};
  // Load system users to populate the dropdown
  api.withSuccessHandler(function(users) {
    var usersList = users || [];
    var opts = '<option value="">— بدون ربط —</option>' + usersList.map(function(u) {
      var uname = u.username || u;
      var selected = (d.linkedUsername && d.linkedUsername === uname) ? ' selected' : '';
      return '<option value="' + uname + '"' + selected + '>' + uname + '</option>';
    }).join('');

    var h = '<div class="modal-content"><div class="modal-title">' + (d.id ? 'تعديل' : 'إضافة') + ' مسؤول عهدة<button class="modal-close" onclick="closeModal(\'#modalCustodyUser\')">&times;</button></div>' +
      '<input type="hidden" id="cuUserId" value="' + (d.id||'') + '">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-group"><label class="form-label">الاسم *</label><input type="text" id="cuName" class="form-control" value="' + (d.name||'') + '"></div>' +
        '<div class="form-group"><label class="form-label">رقم الهوية</label><input type="text" id="cuIdNum" class="form-control" value="' + (d.idNumber||'') + '"></div>' +
        '<div class="form-group"><label class="form-label">الجوال</label><input type="text" id="cuPhone" class="form-control" value="' + (d.phone||'') + '"></div>' +
        '<div class="form-group"><label class="form-label">الوظيفة</label><input type="text" id="cuJob" class="form-control" value="' + (d.jobTitle||'') + '"></div>' +
        '<div class="form-group"><label class="form-label">ربط بحساب مستخدم</label><select id="cuLinked" class="form-control">' + opts + '</select></div>' +
        '<div class="form-group"><label class="form-label">ملاحظات</label><input type="text" id="cuNotes" class="form-control" value="' + (d.notes||'') + '"></div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" style="flex:1;" onclick="saveCustodyUserFn()"><i class="fas fa-save"></i> حفظ</button><button class="btn btn-light" onclick="closeModal(\'#modalCustodyUser\')">إلغاء</button></div></div>';
    if (!document.getElementById('modalCustodyUser')) {
      var m = document.createElement('div'); m.id = 'modalCustodyUser'; m.className = 'modal'; document.body.appendChild(m);
    }
    document.getElementById('modalCustodyUser').innerHTML = h;
    openModal('#modalCustodyUser');
  }).getUsers();
};

window.editCustodyUser = function(id) {
  var u = _custodyUsersCache.find(function(x) { return x.id === id; });
  if (u) openCustodyUserModal(u);
};

window.saveCustodyUserFn = function() {
  var d = {
    id: document.getElementById('cuUserId').value,
    name: document.getElementById('cuName').value,
    idNumber: document.getElementById('cuIdNum').value,
    phone: document.getElementById('cuPhone').value,
    jobTitle: document.getElementById('cuJob').value,
    linkedUsername: document.getElementById('cuLinked').value,
    notes: document.getElementById('cuNotes').value
  };
  if (!d.name) return showToast('الاسم مطلوب', true);
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { closeModal('#modalCustodyUser'); showToast('تم الحفظ'); loadCustodyUsers(); } else showToast(r.error, true); }).saveCustodyUser(d);
};

window.toggleCustodyUserFn = function(id) {
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم التحديث'); loadCustodyUsers(); } }).toggleCustodyUser(id);
};

window.deleteCustodyUserFn = function(id, name) {
  if (!confirm('حذف مسؤول العهدة "' + name + '"؟\nسيتم حذفه نهائياً.')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحذف'); loadCustodyUsers(); } else showToast(r.error, true); }).deleteCustodyUser(id);
};

// ═══════════════════════════════════════
// CUSTODIES (إدارة العهد)
// ═══════════════════════════════════════

window.loadCustodies = function() {
  loader();
  api.withSuccessHandler(function(list) {
    loader(false);
    _custodiesCache = list || [];
    var h = '';
    if (!list.length) { h = '<tr><td colspan="8" style="text-align:center;padding:30px;">لا توجد عهد</td></tr>'; }
    else {
      list.forEach(function(c) {
        var balColor = c.balance > 0 ? '#16a34a' : (c.balance < 0 ? '#ef4444' : '#64748b');
        h += '<tr>' +
          '<td><code>' + c.custodyNumber + '</code></td>' +
          '<td style="font-weight:700;">' + c.userName + '</td>' +
          '<td style="font-size:12px;">' + (c.createdDate ? new Date(c.createdDate).toLocaleDateString('en-GB') : '') + '</td>' +
          '<td style="color:#16a34a;font-weight:700;">' + formatVal(c.totalTopups) + '</td>' +
          '<td style="color:#ef4444;font-weight:700;">' + formatVal(c.totalExpenses) + '</td>' +
          '<td style="font-weight:900;color:' + balColor + ';">' + formatVal(c.balance) + '</td>' +
          '<td>' + (c.status === 'active' ? '<span class="badge green">نشط</span>' : '<span class="badge red">مغلق</span>') + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-primary btn-sm" onclick="openCustodyDetail(\'' + c.id + '\')" title="تفاصيل"><i class="fas fa-eye"></i></button> ' +
            '<button class="btn btn-success btn-sm" onclick="openTopupModal(\'' + c.id + '\')" title="تغذية رصيد"><i class="fas fa-plus-circle"></i></button> ' +
            '<button class="btn btn-light btn-sm" onclick="openAddExpenseModal(\'' + c.id + '\')" title="إضافة مصروف"><i class="fas fa-receipt"></i></button> ' +
            '<button class="btn btn-danger btn-sm" onclick="deleteCustodyFn(\'' + c.id + '\',\'' + (c.custodyNumber||'').replace(/'/g,'') + '\')" title="حذف العهدة"><i class="fas fa-trash"></i></button>' +
          '</td></tr>';
      });
    }
    if (document.getElementById('tbCustodies')) document.getElementById('tbCustodies').innerHTML = h;
    // Populate report selector
    var sel = document.getElementById('custodyReportSelect');
    if (sel) {
      sel.innerHTML = '<option value="">اختر عهدة...</option>' + (list || []).map(function(c) {
        return '<option value="' + c.id + '">' + c.custodyNumber + ' — ' + c.userName + '</option>';
      }).join('');
    }
  }).getCustodies();
};

window.openCreateCustodyModal = function() {
  // Load custody users for picker
  api.withSuccessHandler(function(users) {
    var active = (users || []).filter(function(u) { return u.isActive; });
    var opts = active.map(function(u) { return '<option value="' + u.id + '" data-name="' + u.name + '">' + u.name + ' (' + (u.jobTitle || '') + ')</option>'; }).join('');
    var h = '<div class="modal-content"><div class="modal-title"><i class="fas fa-wallet"></i> إنشاء عهدة جديدة<button class="modal-close" onclick="closeModal(\'#modalCreateCustody\')">&times;</button></div>' +
      '<div class="form-group"><label class="form-label">مسؤول العهدة *</label><select id="newCusUser" class="form-control">' + opts + '</select></div>' +
      '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" style="flex:1;" onclick="createCustodyFn()"><i class="fas fa-save"></i> إنشاء</button><button class="btn btn-light" onclick="closeModal(\'#modalCreateCustody\')">إلغاء</button></div></div>';
    if (!document.getElementById('modalCreateCustody')) {
      var m = document.createElement('div'); m.id = 'modalCreateCustody'; m.className = 'modal'; document.body.appendChild(m);
    }
    document.getElementById('modalCreateCustody').innerHTML = h;
    openModal('#modalCreateCustody');
  }).getCustodyUsers();
};

window.deleteCustodyFn = function(id, num) {
  if (!confirm('حذف العهدة "' + num + '" وجميع مصروفاتها وتغذياتها؟\nلا يمكن التراجع!')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم حذف العهدة'); loadCustodies(); } else showToast(r.error, true); }).deleteCustody(id);
};

window.createCustodyFn = function() {
  var sel = document.getElementById('newCusUser');
  var userId = sel ? sel.value : '';
  var userName = sel ? sel.options[sel.selectedIndex].getAttribute('data-name') : '';
  if (!userId) return showToast('اختر مسؤول العهدة', true);
  loader(); api.withSuccessHandler(function(r) {
    loader(false); if (r.success) { closeModal('#modalCreateCustody'); showToast('تم إنشاء العهدة: ' + r.custodyNumber); loadCustodies(); } else showToast(r.error, true);
  }).createCustody({ userId: userId, userName: userName, username: state.user });
};

// ═══════════════════════════════════════
// TOPUP (تغذية الرصيد)
// ═══════════════════════════════════════

window.openTopupModal = function(custodyId) {
  var h = '<div class="modal-content"><div class="modal-title"><i class="fas fa-plus-circle" style="color:var(--success);"></i> تغذية رصيد العهدة<button class="modal-close" onclick="closeModal(\'#modalTopup\')">&times;</button></div>' +
    '<input type="hidden" id="topCusId" value="' + custodyId + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">المبلغ *</label><input type="number" id="topAmount" class="form-control" step="0.01" min="0.01"></div>' +
      '<div class="form-group"><label class="form-label">طريقة الدفع</label><select id="topMethod" class="form-control"><option value="cash">كاش</option><option value="transfer">تحويل</option><option value="other">أخرى</option></select></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">ملاحظات</label><input type="text" id="topNotes" class="form-control"></div>' +
    '<div class="form-group"><label class="form-label">صورة الإيصال</label><input type="file" id="topReceipt" accept="image/*" onchange="handleCustodyImage(this,\'topReceiptPreview\')"><div id="topReceiptPreview" style="margin-top:8px;"></div></div>' +
    '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-success" style="flex:1;" onclick="submitTopup()"><i class="fas fa-check"></i> تغذية</button><button class="btn btn-light" onclick="closeModal(\'#modalTopup\')">إلغاء</button></div></div>';
  if (!document.getElementById('modalTopup')) {
    var m = document.createElement('div'); m.id = 'modalTopup'; m.className = 'modal'; document.body.appendChild(m);
  }
  document.getElementById('modalTopup').innerHTML = h;
  openModal('#modalTopup');
};

window.submitTopup = function() {
  var cusId = document.getElementById('topCusId').value;
  var amt = Number(document.getElementById('topAmount').value) || 0;
  if (amt <= 0) return showToast('أدخل المبلغ', true);
  var preview = document.getElementById('topReceiptPreview');
  var img = preview && preview.querySelector('img') ? preview.querySelector('img').src : '';
  loader(); api.withSuccessHandler(function(r) {
    loader(false); if (r.success) { closeModal('#modalTopup'); showToast('تم تغذية الرصيد'); loadCustodies(); } else showToast(r.error, true);
  }).topupCustody(cusId, { amount: amt, paymentMethod: document.getElementById('topMethod').value, receiptImage: img, notes: document.getElementById('topNotes').value, username: state.user });
};

// ═══════════════════════════════════════
// ADD EXPENSE (إضافة مصروف)
// ═══════════════════════════════════════

window.openAddExpenseModal = function(custodyId) {
  var h = '<div class="modal-content modal-large"><div class="modal-title"><i class="fas fa-receipt" style="color:var(--danger);"></i> إضافة مصروف عهدة<button class="modal-close" onclick="closeModal(\'#modalCusExp\')">&times;</button></div>' +
    '<input type="hidden" id="cesCusId" value="' + custodyId + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">التاريخ *</label><input type="date" id="cesDate" class="form-control" value="' + new Date().toISOString().split('T')[0] + '"></div>' +
      '<div class="form-group"><label class="form-label">القيمة *</label><input type="number" id="cesAmount" class="form-control" step="0.01" min="0.01"></div>' +
      '<div class="form-group" style="grid-column:1/-1;"><label class="form-label">البيان *</label><input type="text" id="cesDesc" class="form-control" placeholder="وصف المصروف..."></div>' +
      '<div class="form-group"><label class="form-label">هل يوجد ضريبة؟</label><select id="cesHasVat" class="form-control" onchange="toggleCesVat()"><option value="0">لا</option><option value="1">نعم</option></select></div>' +
      '<div class="form-group" id="cesVatGroup" style="display:none;"><label class="form-label">نسبة الضريبة (%)</label><input type="number" id="cesVatRate" class="form-control" value="15" step="0.1"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">ملاحظات</label><input type="text" id="cesNotes" class="form-control"></div>' +
    '<div class="form-group"><label class="form-label">صورة الفاتورة أو PDF</label><input type="file" id="cesInvoice" accept="image/*,application/pdf" onchange="handleCustodyImage(this,\'cesInvoicePreview\')"><div id="cesInvoicePreview" style="margin-top:8px;"></div></div>' +
    '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-danger" style="flex:1;" onclick="submitCustodyExpense()"><i class="fas fa-save"></i> حفظ المصروف</button><button class="btn btn-light" onclick="closeModal(\'#modalCusExp\')">إلغاء</button></div></div>';
  if (!document.getElementById('modalCusExp')) {
    var m = document.createElement('div'); m.id = 'modalCusExp'; m.className = 'modal'; document.body.appendChild(m);
  }
  document.getElementById('modalCusExp').innerHTML = h;
  openModal('#modalCusExp');
};

window.toggleCesVat = function() {
  var show = document.getElementById('cesHasVat').value === '1';
  document.getElementById('cesVatGroup').style.display = show ? '' : 'none';
};

window.submitCustodyExpense = function() {
  var cusId = document.getElementById('cesCusId').value;
  var desc = document.getElementById('cesDesc').value;
  var amt = Number(document.getElementById('cesAmount').value) || 0;
  if (!desc || amt <= 0) return showToast('البيان والقيمة مطلوبة', true);
  var hasVat = document.getElementById('cesHasVat').value === '1';
  var vatRate = hasVat ? Number(document.getElementById('cesVatRate').value) || 15 : 0;
  var preview = document.getElementById('cesInvoicePreview');
  var img = preview && preview.querySelector('img') ? preview.querySelector('img').src : '';
  loader(); api.withSuccessHandler(function(r) {
    loader(false); if (r.success) { closeModal('#modalCusExp'); showToast('تم إضافة المصروف — بانتظار الموافقة'); loadCustodies(); } else showToast(r.error, true);
  }).addCustodyExpense(cusId, { expenseDate: document.getElementById('cesDate').value, description: desc, amount: amt, hasVat: hasVat, vatRate: vatRate, invoiceImage: img, notes: document.getElementById('cesNotes').value, username: state.user });
};

// ═══════════════════════════════════════
// IMAGE HANDLER (رفع صور)
// ═══════════════════════════════════════

window.handleCustodyImage = function(input, previewId) {
  var file = input.files[0];
  if (!file) return;
  var isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById(previewId);
    if (isPdf) {
      // Store PDF as-is
      if (prev) prev.innerHTML = '<div style="padding:10px;background:#f1f5f9;border-radius:8px;text-align:center;"><i class="fas fa-file-pdf" style="font-size:28px;color:#ef4444;"></i><div style="font-size:12px;margin-top:4px;">' + (file.name || 'PDF') + '</div></div>';
      // Store in a hidden img tag for retrieval
      var hidden = document.createElement('img');
      hidden.src = e.target.result; hidden.style.display = 'none';
      if (prev) prev.appendChild(hidden);
    } else {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var max = 1200;
        var w = img.width, h = img.height;
        if (w > max || h > max) { var r = Math.min(max/w, max/h); w *= r; h *= r; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        if (prev) prev.innerHTML = '<img src="' + dataUrl + '" style="max-width:200px;max-height:150px;border-radius:8px;border:1px solid #e2e8f0;">';
      };
      img.src = e.target.result;
    }
  };
  reader.readAsDataURL(file);
};

// ═══════════════════════════════════════
// APPROVAL (تأكيد المصروفات)
// ═══════════════════════════════════════

window.loadCustodyApprovals = function() {
  loader();

  // Load expenses + close requests in parallel
  var expDone = false, closeDone = false, expList = [], closeList = [];
  function tryRender() {
    if (!expDone || !closeDone) return;
    loader(false);
    var h = '';

    // Close requests section
    if (closeList.length) {
      closeList.forEach(function(c) {
        if (c.status !== 'close_pending') return;
        var balColor = c.balance >= 0 ? '#16a34a' : '#ef4444';
        h += '<tr style="background:rgba(239,68,68,0.04);">' +
          '<td><code style="font-size:11px;">' + (c.custodyNumber || '') + '</code></td>' +
          '<td style="font-weight:700;">' + (c.userName || '') + '</td>' +
          '<td colspan="4" style="font-weight:700;color:#ef4444;"><i class="fas fa-lock"></i> طلب إقفال العهدة — الرصيد: <span style="color:' + balColor + ';">' + formatVal(c.balance) + '</span></td>' +
          '<td style="font-weight:900;color:' + balColor + ';">' + formatVal(c.balance) + '</td>' +
          '<td></td>' +
          '<td><span class="badge red">طلب إقفال</span></td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-success btn-sm" onclick="approveCloseCustodyFn(\'' + c.id + '\')" title="موافقة"><i class="fas fa-check"></i></button> ' +
            '<button class="btn btn-danger btn-sm" onclick="rejectCloseCustodyFn(\'' + c.id + '\')" title="رفض"><i class="fas fa-times"></i></button>' +
          '</td></tr>';
      });
    }

    // Expenses
    if (!expList.length && !h) { h = '<tr><td colspan="10" style="text-align:center;padding:30px;">لا توجد مصروفات معلقة</td></tr>'; }
    else {
      expList.forEach(function(e) {
        var sBadge = e.status === 'pending' ? '<span class="badge yellow">بانتظار</span>'
          : e.status === 'approved' ? '<span class="badge blue">معتمد</span>'
          : e.status === 'override_pending' ? '<span class="badge" style="background:#fef3c7;color:#92400e;">تجاوز رصيد</span>'
          : e.status === 'returned' ? '<span class="badge" style="background:#e0e7ff;color:#4338ca;">مُرجع للتعديل</span>'
          : '<span class="badge green">مرحّل</span>';
        var imgBtn = e.invoiceImage ? '<button class="btn btn-light btn-sm" onclick="viewCustodyImage(\'' + e.id + '\')" title="عرض الفاتورة"><i class="fas fa-image"></i></button>' : '—';
        var actions = '';
        // Delete + Return available on non-posted/approved expenses
        var canManage = (e.status === 'pending' || e.status === 'override_pending' || e.status === 'rejected' || e.status === 'returned');
        var manageActions = canManage ? '<button class="btn btn-light btn-sm" onclick="returnCustodyExpFn(\'' + e.id + '\')" title="إرجاع للتعديل"><i class="fas fa-undo"></i></button> ' +
          '<button class="btn btn-danger btn-sm" onclick="deleteCustodyExpFn(\'' + e.id + '\')" title="حذف"><i class="fas fa-trash"></i></button>' : '';
        if (e.status === 'override_pending') {
          actions = '<button class="btn btn-warning btn-sm" onclick="approveOverrideFn(\'' + e.id + '\')" title="موافقة تجاوز"><i class="fas fa-check-double"></i></button> ' +
            '<button class="btn btn-danger btn-sm" onclick="rejectCustodyExpFn(\'' + e.id + '\')" title="رفض"><i class="fas fa-times"></i></button> ' + manageActions;
        } else if (e.status === 'pending') {
          actions = '<button class="btn btn-success btn-sm" onclick="approveCustodyExpFn(\'' + e.id + '\')" title="موافقة"><i class="fas fa-check"></i></button> ' +
            '<button class="btn btn-danger btn-sm" onclick="rejectCustodyExpFn(\'' + e.id + '\')" title="رفض"><i class="fas fa-times"></i></button> ' + manageActions;
        } else if (e.status === 'approved') {
          actions = '<button class="btn btn-primary btn-sm" onclick="postCustodyExpFn(\'' + e.id + '\')" title="ترحيل محاسبي"><i class="fas fa-book"></i></button>';
        } else if (e.status === 'returned' || e.status === 'rejected') {
          actions = manageActions;
        }
        h += '<tr>' +
          '<td><code style="font-size:11px;">' + (e.custodyNumber || '') + '</code></td>' +
          '<td style="font-weight:700;">' + (e.userName || '') + '</td>' +
          '<td style="font-size:12px;">' + (e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-GB') : '') + '</td>' +
          '<td>' + (e.description || '') + '</td>' +
          '<td style="font-weight:700;">' + formatVal(e.amount) + '</td>' +
          '<td>' + formatVal(e.vatAmount || 0) + '</td>' +
          '<td style="font-weight:900;color:var(--secondary);">' + formatVal(e.totalWithVat || e.amount) + '</td>' +
          '<td>' + imgBtn + '</td>' +
          '<td>' + sBadge + '</td>' +
          '<td style="white-space:nowrap;">' + actions + '</td>' +
        '</tr>';
      });
    }
    if (document.getElementById('tbCustodyApproval')) document.getElementById('tbCustodyApproval').innerHTML = h;
  }

  api.withSuccessHandler(function(list) { expList = list || []; expDone = true; tryRender(); }).getCustodyPending();
  api.withSuccessHandler(function(list) { closeList = (list || []).filter(function(c) { return c.status === 'close_pending'; }); closeDone = true; tryRender(); }).getCustodies();
};

window._pendingExpImages = {};
window.viewCustodyImage = function(expId) {
  api.withSuccessHandler(function(list) {
    var exp = (list || []).find(function(e) { return e.id === expId; });
    if (exp && exp.invoiceImage) {
      var isPdf = exp.invoiceImage.indexOf('application/pdf') !== -1;
      var w = window.open('', '_blank');
      if (isPdf) {
        w.document.write('<html><body style="margin:0;"><embed src="' + exp.invoiceImage + '" type="application/pdf" style="width:100%;height:100vh;"></body></html>');
      } else {
        w.document.write('<html><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#000;"><img src="' + exp.invoiceImage + '" style="max-width:100%;max-height:100vh;object-fit:contain;"></body></html>');
      }
      w.document.close();
    } else showToast('لا توجد صورة', true);
  }).getCustodyPending();
};

window.approveCustodyExpFn = function(expId) {
  if (!confirm('موافقة على المصروف وخصمه من رصيد العهدة؟')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الاعتماد ✓'); loadCustodyApprovals(); } else showToast(r.error, true); }).approveCustodyExp(expId, state.user);
};

window.rejectCustodyExpFn = function(expId) {
  var reason = prompt('سبب الرفض:');
  if (reason === null) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الرفض'); loadCustodyApprovals(); } else showToast(r.error, true); }).rejectCustodyExp(expId, state.user, reason);
};

window.deleteCustodyExpFn = function(expId) {
  if (!confirm('حذف هذا المصروف نهائياً؟')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم حذف المصروف'); loadCustodyApprovals(); } else showToast(r.error, true); }).deleteCustodyExp(expId);
};

window.returnCustodyExpFn = function(expId) {
  var reason = prompt('سبب الإرجاع / التعليمات للمسؤول:');
  if (reason === null) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم إرجاع المصروف للتعديل'); loadCustodyApprovals(); } else showToast(r.error, true); }).returnCustodyExp(expId, state.user, reason);
};

window.approveOverrideFn = function(expId) {
  if (!confirm('الموافقة على تجاوز الرصيد لهذا المصروف؟\nسيتم نقله لقائمة الانتظار العادية.')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الموافقة على التجاوز — المصروف بانتظار الاعتماد'); loadCustodyApprovals(); } else showToast(r.error, true); }).approveOverrideExp(expId, state.user);
};

window.approveCloseCustodyFn = function(cusId) {
  if (!confirm('الموافقة على إقفال العهدة؟')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم إقفال العهدة'); loadCustodyApprovals(); loadCustodies(); } else showToast(r.error, true); }).closeCustodyApprove(cusId, state.user);
};

window.rejectCloseCustodyFn = function(cusId) {
  var reason = prompt('سبب رفض الإقفال:');
  if (reason === null) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم رفض طلب الإقفال'); loadCustodyApprovals(); loadCustodies(); } else showToast(r.error, true); }).closeCustodyReject(cusId, state.user, reason);
};

window.postCustodyExpFn = function(expId) {
  if (!confirm('ترحيل المصروف للقيود المحاسبية؟ لن يمكن التراجع.')) return;
  loader(); api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الترحيل — قيد: ' + (r.journalNumber || '')); loadCustodyApprovals(); } else showToast(r.error, true); }).postCustodyExp(expId, state.user);
};

// ═══════════════════════════════════════
// DETAIL + REPORTS
// ═══════════════════════════════════════

window.openCustodyDetail = function(cusId) {
  loader();
  api.withSuccessHandler(function(c) {
    loader(false);
    if (!c || c.error) return showToast(c && c.error || 'خطأ', true);
    var h = '<div style="margin-bottom:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">' +
      '<div style="background:#f0fdf4;padding:14px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">رقم العهدة</div><div style="font-size:18px;font-weight:900;">' + c.custodyNumber + '</div></div>' +
      '<div style="background:#eff6ff;padding:14px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">المسؤول</div><div style="font-size:16px;font-weight:800;">' + c.userName + '</div></div>' +
      '<div style="background:#fef3c7;padding:14px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">الرصيد</div><div style="font-size:20px;font-weight:900;color:' + (c.balance >= 0 ? '#16a34a' : '#ef4444') + ';">' + formatVal(c.balance) + '</div></div>' +
    '</div>';
    // Topups
    h += '<h4 style="margin:14px 0 8px;color:var(--primary);"><i class="fas fa-plus-circle"></i> سجل التغذية</h4>';
    if (c.topups && c.topups.length) {
      h += '<table class="table" style="font-size:12px;margin-bottom:14px;"><thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>بواسطة</th></tr></thead><tbody>';
      c.topups.forEach(function(t) { h += '<tr><td>' + (t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : '') + '</td><td style="color:#16a34a;font-weight:800;">+' + formatVal(t.amount) + '</td><td>' + (t.paymentMethod||'') + '</td><td>' + (t.createdBy||'') + '</td></tr>'; });
      h += '</tbody></table>';
    } else h += '<p style="color:#94a3b8;font-size:13px;">لا توجد عمليات تغذية</p>';
    // Expenses
    h += '<h4 style="margin:14px 0 8px;color:var(--danger);"><i class="fas fa-receipt"></i> المصروفات</h4>';
    if (c.expenses && c.expenses.length) {
      h += '<table class="table" style="font-size:12px;"><thead><tr><th>التاريخ</th><th>البيان</th><th>القيمة</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>';
      c.expenses.forEach(function(e) {
        var sb = { pending: '<span class="badge yellow">بانتظار</span>', approved: '<span class="badge blue">معتمد</span>', rejected: '<span class="badge red">مرفوض</span>', posted: '<span class="badge green">مرحّل</span>' };
        h += '<tr><td>' + (e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-GB') : '') + '</td><td>' + (e.description||'') + '</td><td>' + formatVal(e.amount) + '</td><td>' + formatVal(e.vatAmount) + '</td><td style="font-weight:800;">' + formatVal(e.totalWithVat) + '</td><td>' + (sb[e.status]||e.status) + '</td></tr>';
      });
      h += '</tbody></table>';
    } else h += '<p style="color:#94a3b8;font-size:13px;">لا توجد مصروفات</p>';
    if (!document.getElementById('modalCustodyDetail')) {
      var m = document.createElement('div'); m.id = 'modalCustodyDetail'; m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">تفاصيل العهدة<button class="modal-close" onclick="closeModal(\'#modalCustodyDetail\')">&times;</button></div><div id="cusDetailBody"></div></div>';
      document.body.appendChild(m);
    }
    document.getElementById('cusDetailBody').innerHTML = h;
    openModal('#modalCustodyDetail');
  }).getCustodyDetail(cusId);
};

window.loadCustodyReport = function() {
  var sel = document.getElementById('custodyReportSelect');
  var cusId = sel ? sel.value : '';
  if (!cusId) { document.getElementById('custodyReportBody').innerHTML = '<p style="text-align:center;color:#94a3b8;padding:40px;">اختر عهدة لعرض التقرير</p>'; return; }
  loader();
  api.withSuccessHandler(function(data) {
    loader(false);
    if (!data || data.error) return showToast(data && data.error || 'خطأ', true);
    state._lastCustodyReport = data;
    var c = data.custody, u = data.user;
    var h = '<div style="border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin-bottom:14px;">' +
      '<h3 style="text-align:center;margin-bottom:14px;">تقرير عهدة — ' + c.custodyNumber + '</h3>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">' +
        '<div><strong>المسؤول:</strong> ' + (u ? u.name : c.userName) + '</div>' +
        '<div><strong>الوظيفة:</strong> ' + (u ? u.jobTitle || '—' : '—') + '</div>' +
        '<div><strong>تاريخ الإنشاء:</strong> ' + (c.createdDate ? new Date(c.createdDate).toLocaleDateString('en-GB') : '') + '</div>' +
        '<div><strong>إجمالي التغذية:</strong> <span style="color:#16a34a;font-weight:800;">' + formatVal(c.totalTopups) + '</span></div>' +
        '<div><strong>إجمالي المصروفات:</strong> <span style="color:#ef4444;font-weight:800;">' + formatVal(c.totalExpenses) + '</span></div>' +
        '<div><strong>الرصيد:</strong> <span style="font-weight:900;font-size:18px;color:' + (c.balance >= 0 ? '#16a34a' : '#ef4444') + ';">' + formatVal(c.balance) + '</span></div>' +
      '</div></div>';
    // Expenses table
    h += '<table class="table" style="font-size:13px;"><thead><tr><th>#</th><th>التاريخ</th><th>البيان</th><th>القيمة</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>';
    (data.expenses || []).forEach(function(e, i) {
      var sb = { pending: 'بانتظار', approved: 'معتمد', rejected: 'مرفوض', posted: 'مرحّل' };
      h += '<tr><td>' + (i+1) + '</td><td>' + (e.date ? new Date(e.date).toLocaleDateString('en-GB') : '') + '</td><td>' + (e.description||'') + '</td><td>' + formatVal(e.amount) + '</td><td>' + formatVal(e.vatAmount) + '</td><td style="font-weight:800;">' + formatVal(e.totalWithVat) + '</td><td>' + (sb[e.status]||e.status) + '</td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('custodyReportBody').innerHTML = h;
  }).getCustodyReport(cusId);
};

window.printCustodyPDF = function() {
  var data = state._lastCustodyReport;
  if (!data) return showToast('اختر عهدة أولاً', true);
  var c = data.custody, u = data.user;
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var rows = (data.expenses || []).map(function(e, i) {
    return '<tr><td>' + (i+1) + '</td><td>' + (e.date ? new Date(e.date).toLocaleDateString('en-GB') : '') + '</td><td style="font-weight:700;">' + (e.description||'') + '</td><td>' + formatVal(e.amount) + '</td><td>' + formatVal(e.vatAmount) + '</td><td style="font-weight:800;">' + formatVal(e.totalWithVat) + '</td><td>' + (e.status||'') + '</td></tr>';
  }).join('');
  // Invoice images / PDFs
  var imgs = '';
  (data.expenses || []).forEach(function(e, i) {
    if (e.invoiceImage) {
      var isPdf = e.invoiceImage.indexOf('application/pdf') !== -1;
      if (isPdf) {
        imgs += '<div style="page-break-before:always;text-align:center;padding:20px;">' +
          '<h4>فاتورة #' + (i+1) + ' — ' + (e.description||'') + '</h4>' +
          '<div style="margin:20px auto;padding:30px;background:#f8fafc;border:2px dashed #cbd5e1;border-radius:12px;max-width:400px;">' +
          '<div style="font-size:48px;color:#ef4444;margin-bottom:10px;">&#128196;</div>' +
          '<div style="font-size:16px;font-weight:700;color:#334155;">مرفق PDF</div>' +
          '<div style="font-size:13px;color:#64748b;margin-top:6px;">' + (e.description||'فاتورة') + '</div>' +
          '</div></div>';
      } else {
        imgs += '<div style="page-break-before:always;text-align:center;padding:20px;"><h4>فاتورة #' + (i+1) + ' — ' + (e.description||'') + '</h4><img src="' + e.invoiceImage + '" style="max-width:90%;max-height:80vh;margin-top:10px;border:1px solid #ddd;border-radius:8px;"></div>';
      }
    }
  });
  var w = window.open('', '_blank');
  w.document.write(
    '<html dir="rtl"><head><meta charset="UTF-8"><title>تقرير عهدة ' + c.custodyNumber + '</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:30px;color:#1e293b;font-size:13px;}' +
    'h2{text-align:center;margin-bottom:4px;}h3{text-align:center;color:#64748b;margin-bottom:14px;}' +
    '.meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:14px 0;}.meta div{background:#f8fafc;padding:10px;border-radius:10px;border:1px solid #e2e8f0;}.meta .lbl{font-size:10px;color:#64748b;}.meta .val{font-weight:700;}' +
    'table{width:100%;border-collapse:collapse;margin:12px 0;}th,td{border:1px solid #ddd;padding:8px;text-align:right;}th{background:#f1f5f9;font-weight:700;}' +
    '.sig{display:flex;justify-content:space-around;margin-top:40px;}.sig div{text-align:center;}.sig .line{width:140px;border-bottom:1px solid #94a3b8;padding-top:40px;margin:0 auto;}.sig .cap{font-size:11px;color:#64748b;margin-top:4px;}' +
    '@media print{body{padding:10px;}}</style></head><body>' +
    '<h2>' + company + '</h2><h3>تقرير عهدة — ' + c.custodyNumber + '</h3>' +
    '<div class="meta">' +
      '<div><div class="lbl">المسؤول</div><div class="val">' + (u ? u.name : c.userName) + '</div></div>' +
      '<div><div class="lbl">الوظيفة</div><div class="val">' + (u ? u.jobTitle || '—' : '—') + '</div></div>' +
      '<div><div class="lbl">تاريخ الإنشاء</div><div class="val">' + (c.createdDate ? new Date(c.createdDate).toLocaleDateString('en-GB') : '') + '</div></div>' +
      '<div><div class="lbl">إجمالي التغذية</div><div class="val" style="color:#16a34a;">' + formatVal(c.totalTopups) + '</div></div>' +
      '<div><div class="lbl">إجمالي المصروفات</div><div class="val" style="color:#ef4444;">' + formatVal(c.totalExpenses) + '</div></div>' +
      '<div><div class="lbl">الرصيد</div><div class="val" style="font-size:16px;color:' + (c.balance >= 0 ? '#16a34a' : '#ef4444') + ';">' + formatVal(c.balance) + '</div></div>' +
    '</div>' +
    '<table><thead><tr><th>#</th><th>التاريخ</th><th>البيان</th><th>القيمة</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    imgs +
    '<div class="sig"><div><div class="line"></div><div class="cap">مسؤول العهدة</div></div><div><div class="line"></div><div class="cap">المدير المباشر</div></div><div><div class="line"></div><div class="cap">المحاسب</div></div><div><div class="line"></div><div class="cap">ختم الشركة</div></div></div>' +
    '</body></html>'
  );
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
};
