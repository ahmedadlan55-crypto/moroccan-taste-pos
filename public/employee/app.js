/**
 * Employee Self-Service Portal — v3 (fixed)
 */
var empProfile = null;
var currentUser = '';
var BASE_API = '/api';

document.addEventListener('DOMContentLoaded', function() {
  try {
    var session = JSON.parse(localStorage.getItem('pos_session') || '{}');
    currentUser = session.username || '';
    if (!currentUser || document.body.classList.contains('needs-login')) { showEmpLogin(); return; }
    startApp();
  } catch(e) { showEmpLogin(); }
});

// ─── Direct API call (no dependency on api-bridge) ───
function callAPI(method, path, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, BASE_API + path, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  var token = localStorage.getItem('pos_token');
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
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
function showEmpLogin() {
  var ld = document.getElementById('loader'); if (ld) ld.style.display = 'none';
  document.getElementById('app').style.display = 'none';
  var d = document.createElement('div'); d.id = 'loginPage';
  d.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:16px;background:#f1f5f9;">' +
    '<div style="background:#fff;border-radius:20px;padding:32px 22px;width:100%;max-width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.06);">' +
      '<div style="width:56px;height:56px;border-radius:14px;background:#1e40af;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 14px;"><i class="fas fa-user-tie"></i></div>' +
      '<h1 style="font-size:20px;color:#0f172a;margin-bottom:4px;font-family:inherit;">بوابة الموظف</h1>' +
      '<p style="color:#64748b;font-size:12px;margin-bottom:20px;">سجّل دخولك لتسجيل الحضور</p>' +
      '<input type="text" id="lu" placeholder="اسم المستخدم" style="width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;margin-bottom:10px;text-align:right;font-family:inherit;">' +
      '<input type="password" id="lp" placeholder="كلمة المرور" style="width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;margin-bottom:14px;text-align:right;font-family:inherit;">' +
      '<button id="lbtn" onclick="doLogin()" style="width:100%;padding:13px;background:#1e40af;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;"><i class="fas fa-sign-in-alt"></i> دخول</button>' +
    '</div></div>';
  document.body.appendChild(d);
  document.addEventListener('keydown', function(e) { if (e.key==='Enter' && document.getElementById('loginPage')) doLogin(); });
}

function doLogin() {
  var u = document.getElementById('lu').value, p = document.getElementById('lp').value;
  if (!u || !p) return toast('أدخل البيانات', true);
  var btn = document.getElementById('lbtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  callAPI('POST', '/auth/login', {username:u, password:p}, function(r, err) {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> دخول';
    if (err) return toast('خطأ في الاتصال: ' + err, true);
    if (r && r.success && r.token) {
      localStorage.setItem('pos_token', r.token);
      localStorage.setItem('pos_session', JSON.stringify({username:r.username,role:r.role,brandId:r.brandId||'',branchId:r.branchId||''}));
      currentUser = r.username;
      var lp = document.getElementById('loginPage'); if (lp) lp.remove();
      document.body.classList.remove('needs-login');
      startApp();
    } else toast(r ? r.error : 'فشل الدخول', true);
  });
}

function doLogout() { localStorage.removeItem('pos_token'); localStorage.removeItem('pos_session'); location.reload(); }
function doRefresh() { loadHomeData(); toast('تم التحديث'); }

// ─── Navigation ───
function navTo(pg, el) {
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active');});
  document.getElementById('pg'+pg).classList.add('active');
  if (el) el.classList.add('active');
  if (pg==='att') loadAttPage();
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
      cs.innerHTML = '<button class="clock-btn clock-in" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">تسجيل حضور</div><div class="clock-time" id="liveTime"></div></div></button>';
      startLiveClock();
    } else if (!rec.clock_out) {
      var ci = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      cs.innerHTML = '<button class="clock-btn clock-out" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">تسجيل انصراف</div><div class="clock-time">حضرت ' + ci + '</div></div></button>';
    } else {
      var ci2 = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      var co2 = rec.clock_out ? new Date(rec.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      cs.innerHTML = '<div class="clock-btn clock-done"><i class="fas fa-check-circle"></i><div><div class="clock-lbl">تم التسجيل ✓</div><div class="clock-time">' + ci2 + ' → ' + co2 + '</div></div></div>';
    }

    // Stats
    var present = att.filter(function(a){return a.status==='present';}).length;
    var hours = att.reduce(function(s,a){return s+(Number(a.total_hours)||0);},0);
    var late = att.filter(function(a){return (a.late_minutes||0)>0;}).length;
    document.getElementById('homeStats').innerHTML =
      '<div class="sc"><i class="fas fa-check" style="color:#10b981;background:#ecfdf5;"></i><b>' + present + '</b><span>حضور</span></div>' +
      '<div class="sc"><i class="fas fa-clock" style="color:#3b82f6;background:#eff6ff;"></i><b>' + hours.toFixed(0) + '</b><span>ساعة</span></div>' +
      '<div class="sc"><i class="fas fa-exclamation" style="color:#f59e0b;background:#fffbeb;"></i><b>' + late + '</b><span>تأخير</span></div>' +
      '<div class="sc"><i class="fas fa-calendar" style="color:#8b5cf6;background:#f5f3ff;"></i><b>' + att.length + '</b><span>سجلات</span></div>';

    // Recent attendance
    var ra = document.getElementById('recentAtt');
    if (!att.length) { ra.innerHTML = '<p class="empty">لا توجد سجلات بعد</p>'; return; }
    ra.innerHTML = att.slice(0,7).map(function(a) {
      var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA',{weekday:'short',day:'numeric',month:'short'}) : '';
      var ci = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '—';
      var co = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '⏳';
      return '<div class="ar"><span class="ad">' + d + '</span><span class="at">' + ci + '→' + co + '</span><span class="ah">' + (Number(a.total_hours)||0).toFixed(1) + 'h</span></div>';
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
  var fields = [['الرقم',e.employee_number],['الاسم',e.fullName],['الوظيفة',e.job_title||e.jobTitle],['الفرع',e.branchName],['الجوال',e.phone],['البريد',e.email]];
  c.innerHTML = fields.map(function(f){return '<div class="pf"><span>'+f[0]+'</span><b>'+(f[1]||'—')+'</b></div>';}).join('');
  callAPI('GET', '/hr/my-payslips?username=' + currentUser, null, function(rows) {
    var s = rows||[]; if (!Array.isArray(s)) s = [];
    var months = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    document.getElementById('payslips').innerHTML = s.length ? s.map(function(p){return '<div class="lc"><div class="ln">'+months[p.month||0]+' '+(p.year||'')+'</div><div class="lr" style="color:#10b981;">'+Number(p.net_salary||0).toFixed(0)+' SAR</div></div>';}).join('') : '<p class="empty">لا توجد رواتب</p>';
  });
}
