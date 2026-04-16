/**
 * Employee Self-Service Portal — v3 (fixed)
 */
var empProfile = null;
var currentUser = '';
var BASE_API = '/api';

document.addEventListener('DOMContentLoaded', function() {
  document.body.style.visibility = 'visible';
  var token = localStorage.getItem('emp_token');
  var session = null;
  try { session = JSON.parse(localStorage.getItem('emp_session') || 'null'); } catch(e) {}
  if (token && session && session.username) {
    currentUser = session.username;
    document.getElementById('loginPage').style.display = 'none';
    startApp();
  }
  // else: login form is already visible in HTML
});

// ─── Direct API call (no dependency on api-bridge) ───
function callAPI(method, path, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, BASE_API + path, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  var token = localStorage.getItem('emp_token');
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    if (xhr.status === 401) { doLogout(); return; }
    try { cb(JSON.parse(xhr.responseText), null); }
    catch(e) { cb(null, 'HTTP ' + xhr.status); }
  };
  xhr.onerror = function() { cb(null, 'شبكة'); };
  xhr.send(body ? JSON.stringify(body) : null);
}

// ─── Start App ───
function startApp() {
  // Show app IMMEDIATELY — no loader, no waiting
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none';
  var app = document.getElementById('app');
  app.style.display = 'flex';

  // Show clock button IMMEDIATELY (before API responds)
  document.getElementById('clockSection').innerHTML =
    '<button class="clock-btn clock-in" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">تسجيل حضور</div><div class="clock-time" id="liveTime"></div></div></button>';
  startLiveClock();

  // Load profile in background
  callAPI('GET', '/hr/my-profile?username=' + currentUser, null, function(r) {
    if (r && r.success && r.employee) {
      empProfile = r.employee;
      document.getElementById('hdrName').textContent = r.employee.fullName || currentUser;
      document.getElementById('hdrSub').textContent = (r.employee.job_title||r.employee.jobTitle||'') + (r.employee.branchName ? ' — ' + r.employee.branchName : '');
    } else {
      document.getElementById('hdrName').textContent = currentUser;
      document.getElementById('hdrSub').textContent = '';
    }
  });

  // Load home data
  loadHomeData();
}

function hideLoader() { var l = document.getElementById('loader'); if (l) l.style.display = 'none'; }

function startLiveClock() {
  function tick() {
    var el = document.getElementById('liveTime');
    if (el) el.textContent = new Date().toLocaleTimeString('en', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  tick(); setInterval(tick, 1000);
}

function toast(msg, err) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + (err ? 'err' : 'ok');
  setTimeout(function() { t.className = 'toast'; }, 3500);
}

// ─── Login ───
document.addEventListener('keydown', function(e) { if (e.key==='Enter' && document.getElementById('loginPage') && document.getElementById('loginPage').style.display !== 'none') doLogin(); });

function doLogin() {
  var u = document.getElementById('lu').value, p = document.getElementById('lp').value;
  if (!u || !p) return toast('أدخل البيانات', true);
  var btn = document.getElementById('lbtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  callAPI('POST', '/auth/login', {username:u, password:p}, function(r, err) {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> دخول';
    if (err) return toast('خطأ في الاتصال: ' + err, true);
    if (r && r.success && r.token) {
      localStorage.setItem('emp_token', r.token);
      localStorage.setItem('emp_session', JSON.stringify({username:r.username,role:r.role,brandId:r.brandId||'',branchId:r.branchId||''}));
      currentUser = r.username;
      document.getElementById('loginPage').style.display = 'none';
      startApp();
    } else toast(r ? r.error : 'فشل الدخول', true);
  });
}

function doLogout() { localStorage.removeItem('emp_token'); localStorage.removeItem('emp_session'); location.reload(); }
function doRefresh() { loadHomeData(); toast('تم التحديث'); }

// ─── Navigation ───
function navTo(pg, el) {
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active');});
  document.getElementById('pg'+pg).classList.add('active');
  if (el) el.classList.add('active');
  if (pg==='att') loadAttPage();
  if (pg==='txn') loadMyTransactions();
  if (pg==='leave') loadLeavePage();
  if (pg==='me') loadProfilePage();
  if (pg==='home') loadHomeData();
}

// ═══════════════════════════════════════
// HOME
// ═══════════════════════════════════════
function loadHomeData() {
  callAPI('GET', '/hr/my-attendance?username=' + currentUser, null, function(rows) {
    var att = rows || [];
    if (!Array.isArray(att)) att = [];

    // Update clock button based on today's record
    var today = new Date().toISOString().split('T')[0];
    var rec = att.find(function(a) { return a.attendance_date && a.attendance_date.substring(0,10) === today; });
    var cs = document.getElementById('clockSection');
    if (!rec) {
      cs.innerHTML = '<button class="clock-btn ci" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">تسجيل حضور</div><div class="clock-time" id="liveTime"></div></div></button>';
      startLiveClock();
    } else if (!rec.clock_out) {
      var ci = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      cs.innerHTML = '<button class="clock-btn co" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">تسجيل انصراف</div><div class="clock-time">دخول: ' + ci + '</div></div></button>';
    } else {
      var ci2 = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      var co2 = rec.clock_out ? new Date(rec.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      var hrs = (Number(rec.total_hours)||0);
      var hrsStr = hrs >= 1 ? hrs.toFixed(1) + ' ساعة' : Math.round(hrs*60) + ' دقيقة';
      cs.innerHTML = '<div class="clock-btn cd"><i class="fas fa-check-circle" style="color:#059669;"></i><div><div class="clock-lbl" style="color:#059669;">تم التسجيل ✓</div><div class="clock-time" style="color:#374151;">' + ci2 + ' → ' + co2 + ' | ' + hrsStr + '</div></div></div>';
    }

    // Stats
    var present = att.filter(function(a){return a.status==='present';}).length;
    var hours = att.reduce(function(s,a){return s+(Number(a.total_hours)||0);},0);
    var late = att.filter(function(a){return (a.late_minutes||0)>0;}).length;
    var totalLateMin = att.reduce(function(s,a){return s+(Number(a.late_minutes)||0);},0);
    var lateHrs = (totalLateMin/60).toFixed(1);
    document.getElementById('homeStats').innerHTML =
      '<div class="st"><i class="fas fa-check" style="color:#10b981;background:#ecfdf5;"></i><b>' + present + '</b><span>حضور</span></div>' +
      '<div class="st"><i class="fas fa-clock" style="color:#0ea5e9;background:#e0f2fe;"></i><b>' + hours.toFixed(1) + '</b><span>ساعة</span></div>' +
      '<div class="st"><i class="fas fa-exclamation" style="color:#f59e0b;background:#fffbeb;"></i><b>' + lateHrs + '</b><span>ساعة تأخير</span></div>' +
      '<div class="st"><i class="fas fa-calendar" style="color:#8b5cf6;background:#f5f3ff;"></i><b>' + att.length + '</b><span>سجلات</span></div>';

    // Recent attendance
    var ra = document.getElementById('recentAtt');
    if (!att.length) { ra.innerHTML = '<p class="empty">لا توجد سجلات بعد</p>'; return; }
    ra.innerHTML = att.slice(0,7).map(function(a) {
      var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA',{weekday:'short',day:'numeric',month:'short'}) : '';
      var ci = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '—';
      var co = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '⏳';
      var h=Number(a.total_hours)||0; var hTxt=h>=1?h.toFixed(1)+'h':Math.round(h*60)+'m';
      return '<div class="ar"><span class="ad">' + d + '</span><span class="at">' + ci + ' → ' + co + '</span><span class="ah">' + hTxt + '</span></div>';
    }).join('');
  });
}

// ─── Clock In/Out ───
function doClock() {
  // Step 1: Try device biometrics (fingerprint/face)
  if (window.PublicKeyCredential && navigator.credentials) {
    // Try WebAuthn biometric
    toast('ضع بصمتك...');
    navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array(32),
        rp: { name: 'بوابة الموظف' },
        user: { id: new Uint8Array(16), name: currentUser, displayName: currentUser },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 30000
      }
    }).then(function() { doClockWithLocation(); })
      .catch(function() { doClockWithLocation(); }); // If biometrics unavailable, proceed anyway
  } else {
    doClockWithLocation();
  }
}

function doClockWithLocation() {
  toast('جاري تحديد الموقع...');
  var data = { username: currentUser };
  // Device name
  var ua = navigator.userAgent;
  if (/iPhone/.test(ua)) data.deviceName = 'iPhone';
  else if (/iPad/.test(ua)) data.deviceName = 'iPad';
  else if (/Android/.test(ua)) { var m = ua.match(/;\s*([^;)]+)\s*Build/); data.deviceName = m ? m[1].trim() : 'Android'; }
  else data.deviceName = 'متصفح';

  // REQUIRE location
  if (!navigator.geolocation) { toast('جهازك لا يدعم تحديد الموقع', true); return; }

  navigator.geolocation.getCurrentPosition(function(pos) {
    data.geoLat = pos.coords.latitude;
    data.geoLng = pos.coords.longitude;
    // Reverse geocode
    fetch('https://nominatim.openstreetmap.org/reverse?lat='+pos.coords.latitude+'&lon='+pos.coords.longitude+'&format=json&accept-language=ar')
      .then(function(r){return r.json();})
      .then(function(g){ data.geoAddress = g.display_name||''; sendClock(data); })
      .catch(function(){ sendClock(data); });
  }, function(err) {
    toast('يجب السماح بالموقع لتسجيل الحضور — افتح إعدادات المتصفح', true);
  }, {timeout:10000, enableHighAccuracy:true});
}

function sendClock(data) {
  callAPI('POST', '/hr/my-clock', data, function(r, err) {
    if (err) return toast('خطأ: ' + err, true);
    if (r && r.success) { toast(r.message); loadHomeData(); }
    else toast(r ? r.error : 'فشل التسجيل', true);
  });
}

// ═══════════════════════════════════════
// ATTENDANCE PAGE
// ═══════════════════════════════════════
function loadAttPage() {
  var c = document.getElementById('attList');
  c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  callAPI('GET', '/hr/my-attendance?username=' + currentUser, null, function(rows) {
    var att = rows||[];
    if (!Array.isArray(att)) att = [];
    if (!att.length) { c.innerHTML = '<p class="empty">لا توجد سجلات</p>'; return; }
    c.innerHTML = att.map(function(a) {
      var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA',{weekday:'long',day:'numeric',month:'long'}) : '';
      var ci = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '—';
      var co = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '⏳';
      var dev = a.device_name ? '<div class="meta"><i class="fas fa-mobile-alt"></i> ' + a.device_name + '</div>' : '';
      var loc = a.geo_address_in ? '<div class="meta"><i class="fas fa-map-marker-alt" style="color:#10b981;"></i> ' + a.geo_address_in.substring(0,50) + '</div>' : '';
      return '<div class="ar"><span class="ad">' + d + '</span><span class="at">' + ci + ' → ' + co + dev + loc + '</span><span class="ah">' + (Number(a.total_hours)||0).toFixed(1) + 'h</span></div>';
    }).join('');
  });
}

// ═══════════════════════════════════════
// LEAVE PAGE
// ═══════════════════════════════════════
function loadLeavePage() {
  callAPI('GET', '/hr/my-leave-balances?username=' + currentUser, null, function(rows) {
    var bals = rows||[]; if (!Array.isArray(bals)) bals = [];
    var c = document.getElementById('leaveBals');
    c.innerHTML = bals.length ? bals.map(function(b) {
      return '<div class="lc"><div class="ln">' + (b.leaveTypeName||b.leave_type_name||'—') + '</div><div class="lr">' + (b.remaining_days||0) + ' يوم</div></div>';
    }).join('') : '<p class="empty">لا توجد أرصدة</p>';
  });
  callAPI('GET', '/hr/my-leave-requests?username=' + currentUser, null, function(rows) {
    var reqs = rows||[]; if (!Array.isArray(reqs)) reqs = [];
    var sMap = {pending:'معلّق',branch_approved:'موافق',hr_approved:'معتمد',rejected:'مرفوض'};
    var c = document.getElementById('leaveReqs');
    c.innerHTML = reqs.length ? reqs.map(function(r) {
      var sd = r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : '';
      var ed = r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : '';
      return '<div class="lc"><div class="ln">' + (r.leaveTypeName||r.leave_type_name||'') + ' — ' + (r.days_count||0) + ' يوم<div class="meta">' + sd + ' → ' + ed + '</div></div><span class="badge">' + (sMap[r.status]||r.status) + '</span></div>';
    }).join('') : '<p class="empty">لا توجد طلبات</p>';
  });
}

function openLeaveForm() {
  callAPI('GET', '/hr/leave-types', null, function(types) {
    if (!types || !Array.isArray(types)) types = [];
    document.getElementById('lfType').innerHTML = types.map(function(t){return '<option value="'+t.id+'">'+t.name+'</option>';}).join('');
    document.getElementById('leaveModal').classList.add('show');
  });
}
function closeLeaveForm() { document.getElementById('leaveModal').classList.remove('show'); }

function submitLeave() {
  var d = {username:currentUser, leaveTypeId:document.getElementById('lfType').value, startDate:document.getElementById('lfStart').value, endDate:document.getElementById('lfEnd').value, reason:document.getElementById('lfReason').value};
  if (!d.leaveTypeId||!d.startDate||!d.endDate) return toast('اختر النوع والتواريخ',true);
  callAPI('POST', '/hr/my-leave-request', d, function(r) {
    if (r&&r.success) { toast(r.message||'تم'); closeLeaveForm(); loadLeavePage(); }
    else toast(r?r.error:'فشل',true);
  });
}

// ═══════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════
function loadProfilePage() {
  var c = document.getElementById('profileInfo');
  if (!empProfile) { c.innerHTML = '<p class="empty">لا يوجد ملف موظف مرتبط</p>'; return; }
  var e = empProfile;
  var ws = e.work_start || e.workStart || '08:00';
  var we = e.work_end || e.workEnd || '17:00';
  var salary = Number(e.basic_salary || e.basicSalary || 0);
  var fields = [['الرقم',e.employee_number],['الاسم',e.fullName],['الوظيفة',e.job_title||e.jobTitle],['الفرع',e.branchName],['الجوال',e.phone],['البريد',e.email],['ساعات الدوام',ws+' — '+we],['الراتب الأساسي',salary>0?salary.toLocaleString('en')+' SAR':'—']];
  c.innerHTML = fields.map(function(f){return '<div class="pf"><span>'+f[0]+'</span><b>'+(f[1]||'—')+'</b></div>';}).join('');
  callAPI('GET', '/hr/my-payslips?username=' + currentUser, null, function(rows) {
    var s = rows||[]; if (!Array.isArray(s)) s = [];
    var months = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    document.getElementById('payslips').innerHTML = s.length ? s.map(function(p){return '<div class="lc"><div class="ln">'+months[p.month||0]+' '+(p.year||'')+'</div><div class="lr" style="color:#10b981;">'+Number(p.net_salary||0).toFixed(0)+' SAR</div></div>';}).join('') : '<p class="empty">لا توجد رواتب</p>';
  });
}

// TRANSACTIONS
function loadMyTransactions() {
  var c = document.getElementById('myTxnList');
  c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  callAPI('GET', '/workflow/my-transactions?username=' + currentUser, null, function(rows) {
    var txns = rows || []; if (!Array.isArray(txns)) txns = [];
    var sMap = {pending:'معلّق',in_progress:'قيد التنفيذ',approved:'معتمدة',rejected:'مرفوضة',closed:'مغلقة'};
    var sClr = {pending:'#f59e0b',in_progress:'#0ea5e9',approved:'#10b981',rejected:'#ef4444',closed:'#6b7280'};
    if (!txns.length) { c.innerHTML = '<p class="empty">لا توجد معاملات</p>'; return; }
    c.innerHTML = txns.map(function(t) {
      var dt = t.createdAt ? new Date(t.createdAt).toLocaleDateString('ar-SA',{day:'numeric',month:'short'}) : '';
      return '<div class="ar" style="cursor:pointer;padding:12px 0;" onclick="viewMyTxn('"'"''+t.id+'"'"'")"><div style="flex:1;"><div style="font-weight:800;font-size:13px;">' + t.title + '</div><div class="meta">' + (t.typeName||'') + ' | ' + dt + '</div></div><span class="badge">' + (sMap[t.status]||t.status) + '</span></div>';
    }).join('');
  });
}
function openTxnModal() {
  callAPI('GET', '/workflow/transaction-types', null, function(types) {
    document.getElementById('txnType').innerHTML = (types||[]).map(function(t) { return '<option value="' + t.id + '">' + t.name + '</option>'; }).join('');
  });
  document.getElementById('txnJobTitle').value = empProfile ? (empProfile.job_title || '') : '';
  document.getElementById('txnTitle').value = ''; document.getElementById('txnDesc').value = '';
  document.getElementById('txnAmount').value = '0'; document.getElementById('txnFile').value = '';
  document.getElementById('txnModal').classList.add('show');
}
function closeTxnModal() { document.getElementById('txnModal').classList.remove('show'); }
function submitTxn() {
  var title = document.getElementById('txnTitle').value, typeId = document.getElementById('txnType').value;
  if (!title || !typeId) return toast('اختر النوع واكتب العنوان', true);
  var data = { transactionTypeId: typeId, title: title, description: document.getElementById('txnDesc').value, amount: Number(document.getElementById('txnAmount').value)||0, username: currentUser, branchId: empProfile ? empProfile.branch_id : '', brandId: empProfile ? empProfile.brand_id : '' };
  var f = document.getElementById('txnFile');
  if (f.files && f.files[0]) {
    if (f.files[0].size > 5242880) return toast('الحد 5MB', true);
    var r = new FileReader(); r.onload = function(e) { data.attachment = e.target.result; _doTxn(data); }; r.readAsDataURL(f.files[0]);
  } else _doTxn(data);
}
function _doTxn(data) {
  toast('جاري الإرسال...'); callAPI('POST', '/workflow/transactions', data, function(r, e) {
    if (e) return toast('خطأ: '+e, true);
    if (r && r.success) { toast('تم: '+(r.txnNumber||'')); closeTxnModal(); loadMyTransactions(); } else toast(r?r.error:'فشل', true);
  });
}
function viewMyTxn(id) {
  callAPI('GET', '/workflow/transactions/' + id, null, function(txn) {
    if (!txn || txn.error) return toast('خطأ', true);
    var sMap = {pending:'معلّق',in_progress:'قيد التنفيذ',approved:'معتمدة',rejected:'مرفوضة',closed:'مغلقة'};
    var aMap = {create:'إنشاء',approve:'موافقة',reject:'رفض',return:'إرجاع',close:'إغلاق'};
    var aClr = {create:'#0ea5e9',approve:'#10b981',reject:'#ef4444',return:'#f59e0b',close:'#6b7280'};
    var h = '<div class="pf"><span>الرقم</span><b>'+(txn.txnNumber||'')+'</b></div><div class="pf"><span>النوع</span><b>'+(txn.typeName||'')+'</b></div><div class="pf"><span>الحالة</span><b>'+(sMap[txn.status]||txn.status)+'</b></div><div class="pf"><span>المبلغ</span><b>'+Number(txn.amount||0).toFixed(2)+'</b></div>';
    if (txn.description) h += '<div class="card" style="margin:8px 0;"><p style="font-size:12px;">'+txn.description+'</p></div>';
    if (txn.attachment && txn.attachment.startsWith && txn.attachment.startsWith('data:')) h += '<a href="'+txn.attachment+'" download style="color:#0ea5e9;font-size:12px;"><i class="fas fa-download"></i> تحميل المرفق</a>';
    if (txn.logs && txn.logs.length) { h += '<div class="card" style="margin-top:8px;"><div class="card-t"><i class="fas fa-route"></i> المسار</div>';
      txn.logs.forEach(function(l) { var c=aClr[l.actionType]||'#6b7280'; h += '<div style="padding:6px 0;border-right:3px solid '+c+';padding-right:8px;margin-bottom:4px;font-size:11px;"><b style="color:'+c+';">'+(aMap[l.actionType]||l.actionType)+'</b> — '+(l.actionBy||'')+(l.note?' | '+l.note:'')+'</div>'; });
      h += '</div>'; }
    document.getElementById('txnDetailTitle').textContent = txn.txnNumber||'';
    document.getElementById('txnDetailBody').innerHTML = h;
    document.getElementById('txnDetailModal').classList.add('show');
  });
}
function closeTxnDetail() { document.getElementById('txnDetailModal').classList.remove('show'); }
