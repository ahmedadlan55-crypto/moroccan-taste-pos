/**
 * Employee Self-Service Portal — app.js
 * Mobile-first design, same architecture as POS + Custody
 */
var empProfile = null;
var currentUser = '';

// ─── Init ───
document.addEventListener('DOMContentLoaded', function() {
  try {
    var session = JSON.parse(localStorage.getItem('pos_session') || '{}');
    currentUser = session.username || '';
    if (!currentUser || document.body.classList.contains('needs-login')) { showEmpLogin(); return; }
    initApp();
  } catch(e) { showEmpLogin(); }
});

function initApp() {
  var api = window._apiBridge;
  if (!api) {
    if ((initApp._r = (initApp._r||0) + 1) > 30) { toast('فشل تحميل النظام', true); hideLoader(); return; }
    setTimeout(initApp, 200); return;
  }
  api.withSuccessHandler(function(r) {
    hideLoader();
    document.getElementById('app').style.display = 'flex';
    if (r && r.success && r.employee) {
      empProfile = r.employee;
      document.getElementById('headerName').textContent = r.employee.fullName || currentUser;
      document.getElementById('headerSub').textContent = (r.employee.job_title || r.employee.jobTitle || '') + (r.employee.branchName ? ' — ' + r.employee.branchName : '');
    } else {
      document.getElementById('headerName').textContent = currentUser;
      document.getElementById('headerSub').textContent = 'لا يوجد ملف موظف مرتبط';
    }
    loadHome();
  }).withFailureHandler(function() {
    hideLoader();
    document.getElementById('app').style.display = 'flex';
    document.getElementById('headerName').textContent = currentUser;
    loadHome();
  }).getMyProfile(currentUser);
}

function hideLoader() { var l = document.getElementById('loader'); if (l) l.style.display = 'none'; }

function toast(msg, isErr) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast-bar show ' + (isErr ? 'err' : 'ok');
  setTimeout(function() { t.className = 'toast-bar'; }, 3500);
}

// ─── Navigation ───
function navTo(page, el) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('page' + page).classList.add('active');
  if (el) el.classList.add('active');
  if (page === 'Attendance') loadAttendancePage();
  if (page === 'Leave') loadLeavePage();
  if (page === 'Profile') loadProfilePage();
  if (page === 'Home') loadHome();
}

function refreshData() { loadHome(); toast('تم التحديث'); }
function doLogout() { localStorage.removeItem('pos_token'); localStorage.removeItem('pos_session'); window.location.reload(); }

// ─── Login ───
function showEmpLogin() {
  hideLoader();
  document.getElementById('app').style.display = 'none';
  var d = document.createElement('div'); d.id = 'empLoginPage';
  d.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:20px;">' +
    '<div style="background:rgba(255,255,255,0.9);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.5);border-radius:24px;padding:36px 24px;width:100%;max-width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.08);">' +
      '<div style="width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#3b82f6,#1e40af);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 14px;"><i class="fas fa-user-tie"></i></div>' +
      '<h1 style="font-size:20px;color:#0f172a;margin-bottom:4px;">بوابة الموظف</h1>' +
      '<p style="color:#64748b;font-size:12px;margin-bottom:20px;">سجّل دخولك لتسجيل الحضور وعرض بياناتك</p>' +
      '<input type="text" id="empLoginUser" placeholder="اسم المستخدم" style="width:100%;padding:13px 14px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:15px;margin-bottom:10px;text-align:right;background:rgba(255,255,255,0.8);">' +
      '<input type="password" id="empLoginPass" placeholder="كلمة المرور" style="width:100%;padding:13px 14px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:15px;margin-bottom:14px;text-align:right;background:rgba(255,255,255,0.8);">' +
      '<button id="empLoginBtn" onclick="empDoLogin()" style="width:100%;padding:14px;background:linear-gradient(135deg,#3b82f6,#1e40af);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;"><i class="fas fa-sign-in-alt"></i> دخول</button>' +
    '</div></div>';
  document.body.appendChild(d);
  document.addEventListener('keydown', function(e) { if (e.key==='Enter' && document.getElementById('empLoginPage')) empDoLogin(); });
}

function empDoLogin() {
  var u = document.getElementById('empLoginUser').value;
  var p = document.getElementById('empLoginPass').value;
  if (!u || !p) return toast('أدخل اسم المستخدم وكلمة المرور', true);
  var btn = document.getElementById('empLoginBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/auth/login', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> دخول'; }
    try {
      var r = JSON.parse(xhr.responseText);
      if (r.success && r.token) {
        localStorage.setItem('pos_token', r.token);
        localStorage.setItem('pos_session', JSON.stringify({ username: r.username, role: r.role, brandId: r.brandId||'', branchId: r.branchId||'' }));
        currentUser = r.username;
        var lp = document.getElementById('empLoginPage'); if (lp) lp.remove();
        document.body.classList.remove('needs-login');
        initApp();
      } else toast(r.error || 'فشل تسجيل الدخول', true);
    } catch(e) { toast('خطأ — HTTP ' + xhr.status, true); }
  };
  xhr.onerror = function() { if (btn) { btn.disabled=false; btn.innerHTML='<i class="fas fa-sign-in-alt"></i> دخول'; } toast('لا يمكن الاتصال بالخادم', true); };
  xhr.send(JSON.stringify({ username: u, password: p }));
}

// ═══════════════════════════════════════
// HOME
// ═══════════════════════════════════════
function loadHome() {
  loadClockButton();
  window._apiBridge.withSuccessHandler(function(rows) {
    var att = rows || [];
    var present = att.filter(function(a) { return a.status === 'present'; }).length;
    var totalH = att.reduce(function(s, a) { return s + (Number(a.total_hours) || 0); }, 0);
    var lateDays = att.filter(function(a) { return (a.late_minutes||0) > 0; }).length;
    document.getElementById('homeStats').innerHTML =
      _statCard('fa-check-circle', '#10b981', present, 'أيام حضور') +
      _statCard('fa-clock', '#3b82f6', totalH.toFixed(0), 'ساعة عمل') +
      _statCard('fa-exclamation-triangle', '#f59e0b', lateDays, 'تأخير') +
      _statCard('fa-calendar-day', '#8b5cf6', att.length, 'سجلات');
    // Recent
    document.getElementById('recentAtt').innerHTML = att.slice(0, 7).length ?
      att.slice(0, 7).map(_renderAttRow).join('') :
      '<p style="text-align:center;color:#94a3b8;padding:24px;font-size:13px;">لا توجد سجلات</p>';
  }).getMyAttendance(currentUser);
}

function _statCard(icon, color, val, label) {
  return '<div class="stat-card"><i class="fas ' + icon + '" style="color:' + color + ';background:' + color + '15;"></i><div><span class="stat-val">' + val + '</span><span class="stat-label">' + label + '</span></div></div>';
}

function _renderAttRow(a) {
  var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA', {weekday:'short', day:'numeric', month:'short'}) : '';
  var cin = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '—';
  var cout = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '<span style="color:#f59e0b;font-size:10px;">لم ينصرف</span>';
  var hrs = (Number(a.total_hours)||0).toFixed(1);
  var late = (a.late_minutes||0) > 0 ? ' <span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:8px;font-size:9px;">متأخر ' + a.late_minutes + 'د</span>' : '';
  return '<div class="att-row"><div class="att-day">' + d + '</div><div class="att-times">' + cin + ' → ' + cout + late + '</div><div class="att-hrs">' + hrs + 'h</div></div>';
}

function loadClockButton() {
  window._apiBridge.withSuccessHandler(function(rows) {
    var today = new Date().toISOString().split('T')[0];
    var rec = (rows||[]).find(function(a) { return a.attendance_date && a.attendance_date.substring(0,10) === today; });
    var sec = document.getElementById('clockSection');
    if (!rec) {
      sec.innerHTML = '<button class="clock-btn clock-in" onclick="doClock()"><i class="fas fa-fingerprint" style="font-size:28px;"></i><div><div class="clock-label">تسجيل حضور</div><div class="clock-time" id="clockTime"></div></div></button>';
    } else if (!rec.clock_out) {
      var cin = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '';
      sec.innerHTML = '<button class="clock-btn clock-out" onclick="doClock()"><i class="fas fa-fingerprint" style="font-size:28px;"></i><div><div class="clock-label">تسجيل انصراف</div><div class="clock-time">حضرت: ' + cin + '</div></div></button>';
    } else {
      var cin2 = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '';
      var cout2 = rec.clock_out ? new Date(rec.clock_out).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '';
      sec.innerHTML = '<div class="clock-btn clock-done"><i class="fas fa-check-circle" style="font-size:28px;"></i><div><div class="clock-label">تم التسجيل ✓</div><div class="clock-time">' + cin2 + ' → ' + cout2 + ' (' + (Number(rec.total_hours)||0).toFixed(1) + 'h)</div></div></div>';
    }
    // Update live time
    _updateClockTime();
  }).getMyAttendance(currentUser);
}

function _updateClockTime() {
  var el = document.getElementById('clockTime');
  if (el && !el.textContent) {
    el.textContent = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    setInterval(function() { var e = document.getElementById('clockTime'); if (e && !e.dataset.set) e.textContent = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit', second:'2-digit'}); }, 1000);
  }
}

function doClock() {
  var data = { username: currentUser, deviceInfo: navigator.userAgent };
  // Parse device name
  var ua = navigator.userAgent;
  if (/iPhone/.test(ua)) data.deviceName = 'iPhone';
  else if (/iPad/.test(ua)) data.deviceName = 'iPad';
  else if (/Android/.test(ua)) { var m = ua.match(/;\s*([^;)]+)\s*Build/); data.deviceName = m ? m[1].trim() : 'Android'; }
  else if (/Windows/.test(ua)) data.deviceName = 'Windows';
  else data.deviceName = 'متصفح';

  toast('جاري تحديد الموقع...');
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      data.geoLat = pos.coords.latitude;
      data.geoLng = pos.coords.longitude;
      // Reverse geocode
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&format=json&accept-language=ar')
        .then(function(r) { return r.json(); })
        .then(function(g) { data.geoAddress = g.display_name || ''; _sendClock(data); })
        .catch(function() { _sendClock(data); });
    }, function() { _sendClock(data); }, { timeout: 8000, enableHighAccuracy: true });
  } else _sendClock(data);
}

function _sendClock(data) {
  window._apiBridge.withSuccessHandler(function(r) {
    if (r.success) { toast(r.message); loadClockButton(); loadHome(); }
    else toast(r.error, true);
  }).myClock(data);
}

// ═══════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════
function loadAttendancePage() {
  window._apiBridge.withSuccessHandler(function(rows) {
    document.getElementById('fullAtt').innerHTML = (rows||[]).length ?
      (rows||[]).map(function(a) {
        var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA', {weekday:'long', day:'numeric', month:'long'}) : '';
        var cin = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '—';
        var cout = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '<span style="color:#f59e0b;font-size:10px;">لم ينصرف</span>';
        var late = (a.late_minutes||0) > 0 ? '<span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:8px;font-size:9px;">تأخير ' + a.late_minutes + 'د</span>' : '';
        var device = a.device_name ? '<div style="font-size:10px;color:#94a3b8;margin-top:2px;"><i class="fas fa-mobile-alt"></i> ' + a.device_name + '</div>' : '';
        var locIn = a.geo_address_in ? '<div style="font-size:10px;color:#94a3b8;margin-top:1px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="fas fa-map-marker-alt" style="color:#ef4444;"></i> ' + a.geo_address_in + '</div>' : '';
        return '<div class="att-row" style="flex-wrap:wrap;"><div class="att-day">' + d + '</div><div class="att-times">' + cin + ' → ' + cout + ' ' + late + device + locIn + '</div><div class="att-hrs">' + (Number(a.total_hours)||0).toFixed(1) + 'h</div></div>';
      }).join('') : '<p style="text-align:center;color:#94a3b8;padding:24px;">لا توجد سجلات</p>';
  }).getMyAttendance(currentUser);
}

// ═══════════════════════════════════════
// LEAVE
// ═══════════════════════════════════════
function loadLeavePage() {
  window._apiBridge.withSuccessHandler(function(rows) {
    var bals = rows || [];
    var colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    document.getElementById('leaveBalances').innerHTML = bals.length ?
      bals.map(function(b, i) {
        var c = colors[i % colors.length];
        return '<div class="lv-card"><div class="lv-icon" style="background:' + c + '15;color:' + c + ';"><i class="fas fa-calendar-day"></i></div>' +
          '<div class="lv-info"><div class="lv-name">' + (b.leaveTypeName || b.leave_type_name || '') + '</div>' +
          '<div class="lv-sub">إجمالي: ' + (b.total_days||0) + ' | مستخدم: ' + (b.used_days||0) + '</div></div>' +
          '<div class="lv-val">' + (b.remaining_days||0) + '</div></div>';
      }).join('') : '<p style="text-align:center;color:#94a3b8;padding:16px;">لا توجد أرصدة</p>';
  }).getMyLeaveBalances(currentUser);

  window._apiBridge.withSuccessHandler(function(rows) {
    var reqs = rows || [];
    var sMap = { pending: ['معلّق', 'badge-yellow'], branch_approved: ['موافق', 'badge-blue'], hr_approved: ['معتمد', 'badge-green'], rejected: ['مرفوض', 'badge-red'] };
    document.getElementById('myLeaveReqs').innerHTML = reqs.length ?
      reqs.map(function(r) {
        var s = sMap[r.status] || [r.status, 'badge-blue'];
        var sd = r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : '';
        var ed = r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : '';
        return '<div class="lv-card"><div class="lv-info"><div class="lv-name">' + (r.leaveTypeName||r.leave_type_name||'') + ' — ' + (r.days_count||0) + ' يوم</div>' +
          '<div class="lv-sub">' + sd + ' → ' + ed + '</div></div><span class="badge ' + s[1] + '">' + s[0] + '</span></div>';
      }).join('') : '<p style="text-align:center;color:#94a3b8;padding:12px;">لا توجد طلبات</p>';
  }).getMyLeaveRequests(currentUser);
}

function openLeaveModal() {
  window._apiBridge.withSuccessHandler(function(types) {
    document.getElementById('lfType').innerHTML = (types||[]).map(function(t) { return '<option value="' + t.id + '">' + t.name + '</option>'; }).join('');
    document.getElementById('leaveModal').classList.add('show');
  }).getHrLeaveTypes();
}
function closeLeaveModal() { document.getElementById('leaveModal').classList.remove('show'); }

function submitLeave() {
  var type = document.getElementById('lfType').value;
  var start = document.getElementById('lfStart').value;
  var end = document.getElementById('lfEnd').value;
  if (!type || !start || !end) return toast('اختر النوع والتواريخ', true);
  window._apiBridge.withSuccessHandler(function(r) {
    if (r.success) { toast(r.message || 'تم تقديم الطلب'); closeLeaveModal(); loadLeavePage(); }
    else toast(r.error, true);
  }).myLeaveRequest({ username: currentUser, leaveTypeId: type, startDate: start, endDate: end, reason: document.getElementById('lfReason').value });
}

// ═══════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════
function loadProfilePage() {
  if (!empProfile) { document.getElementById('profileInfo').innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px;">لا يوجد ملف موظف مرتبط بحسابك</p>'; return; }
  var e = empProfile;
  var types = { full_time: 'دوام كامل', part_time: 'جزئي', hourly: 'بالساعة', contract: 'عقد' };
  var fields = [
    ['الرقم الوظيفي', e.employee_number], ['الاسم', e.fullName], ['الوظيفة', e.job_title || e.jobTitle],
    ['القسم', e.departmentName], ['الفرع', e.branchName], ['الجوال', e.phone], ['البريد', e.email],
    ['تاريخ التعيين', e.hire_date ? new Date(e.hire_date).toLocaleDateString('en-GB') : '—'],
    ['نوع التوظيف', types[e.employment_type] || '—'],
    ['الحالة', e.status === 'active' ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">' + (e.status||'') + '</span>']
  ];
  document.getElementById('profileInfo').innerHTML = fields.map(function(f) {
    return '<div class="pf-row"><span class="pf-label">' + f[0] + '</span><span class="pf-value">' + (f[1]||'—') + '</span></div>';
  }).join('');

  window._apiBridge.withSuccessHandler(function(rows) {
    var slips = rows || [];
    var months = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    document.getElementById('payslips').innerHTML = slips.length ?
      slips.map(function(s) {
        return '<div class="ps-card"><div class="ps-icon"><i class="fas fa-file-invoice-dollar"></i></div>' +
          '<div class="ps-info"><div class="ps-month">' + months[s.month||0] + ' ' + (s.year||'') + '</div>' +
          '<div class="ps-detail">أساسي: ' + Number(s.basic_salary||0).toFixed(0) + ' | خصومات: ' + Number(s.total_deductions||0).toFixed(0) + '</div></div>' +
          '<div class="ps-amount">' + Number(s.net_salary||0).toFixed(0) + '</div></div>';
      }).join('') : '<p style="text-align:center;color:#94a3b8;padding:16px;">لا توجد رواتب</p>';
  }).getMyPayslips(currentUser);
}
