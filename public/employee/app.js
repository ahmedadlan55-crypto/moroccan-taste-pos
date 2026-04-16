/**
 * Employee Self-Service Portal — app.js
 * Same architecture as POS + Custody apps
 * Uses /shared/api-bridge.js for API calls
 */

// ─── State ───
var empProfile = null;
var currentUser = '';

// ─── Init ───
document.addEventListener('DOMContentLoaded', function() {
  try {
    var session = JSON.parse(localStorage.getItem('pos_session') || '{}');
    currentUser = session.username || '';
    if (!currentUser) { window.location.replace('/'); return; }
    initApp();
  } catch(e) { window.location.replace('/'); }
});

function initApp() {
  // Use the shared api bridge
  var api = window._apiBridge;
  if (!api) { setTimeout(initApp, 100); return; }

  // Load employee profile
  api.withSuccessHandler(function(r) {
    hideLoader();
    if (r.success && r.employee) {
      empProfile = r.employee;
      document.getElementById('headerName').textContent = r.employee.fullName || currentUser;
      document.getElementById('headerSub').textContent = (r.employee.job_title || r.employee.jobTitle || '') + (r.employee.branchName ? ' — ' + r.employee.branchName : '');
      document.getElementById('app').style.display = 'flex';
      loadHome();
    } else {
      // No employee profile — show basic info
      document.getElementById('headerName').textContent = currentUser;
      document.getElementById('headerSub').textContent = 'لا يوجد ملف موظف مرتبط';
      document.getElementById('app').style.display = 'flex';
    }
  }).withFailureHandler(function() {
    hideLoader();
    document.getElementById('headerName').textContent = currentUser;
    document.getElementById('app').style.display = 'flex';
  }).getMyProfile(currentUser);
}

function hideLoader() { var l = document.getElementById('loader'); if (l) l.style.display = 'none'; }

// ─── Toast ───
function toast(msg, isErr) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast-bar show ' + (isErr ? 'err' : 'ok');
  setTimeout(function() { t.className = 'toast-bar'; }, 3000);
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
}

function refreshData() {
  var activeTab = document.querySelector('.nav-tab.active');
  var tabText = activeTab ? activeTab.querySelector('span').textContent : 'الرئيسية';
  if (tabText === 'الرئيسية') loadHome();
  else if (tabText === 'الحضور') loadAttendancePage();
  else if (tabText === 'الإجازات') loadLeavePage();
  else loadProfilePage();
  toast('تم التحديث');
}

function doLogout() {
  localStorage.removeItem('pos_token');
  localStorage.removeItem('pos_session');
  window.location.replace('/');
}

// ═══════════════════════════════════════
// HOME PAGE
// ═══════════════════════════════════════
function loadHome() {
  loadClockButton();
  window._apiBridge.withSuccessHandler(function(rows) {
    var att = rows || [];
    var present = att.filter(function(a) { return a.status === 'present'; }).length;
    var totalH = att.reduce(function(s, a) { return s + (Number(a.total_hours) || 0); }, 0);
    var lateDays = att.filter(function(a) { return (a.late_minutes||0) > 0; }).length;

    document.getElementById('homeStats').innerHTML =
      '<div class="stat-card st-present"><i class="fas fa-check-circle"></i><div><span class="stat-label">أيام الحضور</span><span class="stat-val">' + present + '</span></div></div>' +
      '<div class="stat-card st-hours"><i class="fas fa-clock"></i><div><span class="stat-label">ساعات العمل</span><span class="stat-val">' + totalH.toFixed(0) + '</span></div></div>' +
      '<div class="stat-card st-late"><i class="fas fa-exclamation-triangle"></i><div><span class="stat-label">أيام تأخير</span><span class="stat-val">' + lateDays + '</span></div></div>' +
      '<div class="stat-card st-leave"><i class="fas fa-calendar-minus"></i><div><span class="stat-label">إجمالي السجلات</span><span class="stat-val">' + att.length + '</span></div></div>';

    // Recent
    var recent = att.slice(0, 5);
    document.getElementById('recentAtt').innerHTML = recent.length ?
      recent.map(function(a) {
        var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA', {weekday:'short', day:'numeric', month:'short'}) : '';
        var cin = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '—';
        var cout = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '<span class="badge badge-yellow">لم ينصرف</span>';
        var dot = (a.late_minutes||0) > 0 ? 'late' : 'present';
        return '<div class="att-row"><div class="att-dot ' + dot + '"></div><div class="att-day">' + d + '</div><div class="att-times">' + cin + ' → ' + cout + '</div><div class="att-hrs">' + (Number(a.total_hours)||0).toFixed(1) + 'h</div></div>';
      }).join('') : '<p style="text-align:center;color:var(--slate);padding:20px;font-size:13px;">لا توجد سجلات هذا الشهر</p>';
  }).getMyAttendance(currentUser);
}

function loadClockButton() {
  window._apiBridge.withSuccessHandler(function(rows) {
    var today = new Date().toISOString().split('T')[0];
    var rec = (rows||[]).find(function(a) { return a.attendance_date && a.attendance_date.substring(0,10) === today; });
    var html = '';
    if (!rec) {
      html = '<button class="clock-btn clock-in" onclick="doClock()"><i class="fas fa-sign-in-alt" style="font-size:22px;"></i> تسجيل حضور</button>';
    } else if (!rec.clock_out) {
      html = '<button class="clock-btn clock-out" onclick="doClock()"><i class="fas fa-sign-out-alt" style="font-size:22px;"></i> تسجيل انصراف</button>';
    } else {
      html = '<button class="clock-btn clock-done"><i class="fas fa-check-circle" style="font-size:22px;"></i> تم التسجيل اليوم ✓</button>';
    }
    document.getElementById('clockSection').innerHTML = html;
  }).getMyAttendance(currentUser);
}

function doClock() {
  var data = { username: currentUser, deviceInfo: navigator.userAgent };
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      data.geoLat = pos.coords.latitude;
      data.geoLng = pos.coords.longitude;
      _sendClock(data);
    }, function() { _sendClock(data); }, { timeout: 5000 });
  } else _sendClock(data);
}

function _sendClock(data) {
  window._apiBridge.withSuccessHandler(function(r) {
    if (r.success) { toast(r.message); loadClockButton(); loadHome(); }
    else toast(r.error, true);
  }).myClock(data);
}

// ═══════════════════════════════════════
// ATTENDANCE PAGE
// ═══════════════════════════════════════
function loadAttendancePage() {
  window._apiBridge.withSuccessHandler(function(rows) {
    var att = rows || [];
    document.getElementById('fullAtt').innerHTML = att.length ?
      att.map(function(a) {
        var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString('ar-SA', {weekday:'long', day:'numeric', month:'long'}) : '';
        var cin = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '—';
        var cout = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'}) : '<span class="badge badge-yellow">لم ينصرف</span>';
        var late = (a.late_minutes||0) > 0 ? ' <span class="badge badge-red">تأخير ' + a.late_minutes + ' د</span>' : '';
        var dot = (a.late_minutes||0) > 0 ? 'late' : (a.status === 'absent' ? 'absent' : 'present');
        return '<div class="att-row"><div class="att-dot ' + dot + '"></div><div class="att-day">' + d + '</div><div class="att-times">' + cin + ' → ' + cout + late + '</div><div class="att-hrs">' + (Number(a.total_hours)||0).toFixed(1) + 'h</div></div>';
      }).join('') : '<p style="text-align:center;color:var(--slate);padding:20px;">لا توجد سجلات</p>';
  }).getMyAttendance(currentUser);
}

// ═══════════════════════════════════════
// LEAVE PAGE
// ═══════════════════════════════════════
function loadLeavePage() {
  // Balances
  window._apiBridge.withSuccessHandler(function(rows) {
    var bals = rows || [];
    var colors = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--red)', 'var(--purple)'];
    document.getElementById('leaveBalances').innerHTML = bals.length ?
      bals.map(function(b, i) {
        var c = colors[i % colors.length];
        return '<div class="lv-card"><div class="lv-icon" style="background:' + c + '12;color:' + c + ';"><i class="fas fa-calendar-day"></i></div>' +
          '<div class="lv-info"><div class="lv-name">' + (b.leaveTypeName || b.leave_type_name || '') + '</div>' +
          '<div class="lv-sub">إجمالي: ' + (b.total_days||0) + ' | مستخدم: ' + (b.used_days||0) + '</div></div>' +
          '<div class="lv-val">' + (b.remaining_days||0) + '</div></div>';
      }).join('') : '<p style="text-align:center;color:var(--slate);padding:20px;">لا توجد أرصدة — اطلب من HR تهيئة الأرصدة</p>';
  }).getMyLeaveBalances(currentUser);

  // My requests
  window._apiBridge.withSuccessHandler(function(rows) {
    var reqs = rows || [];
    var sMap = { pending: ['قيد الانتظار', 'badge-yellow'], branch_approved: ['موافق من المدير', 'badge-blue'], hr_approved: ['معتمدة', 'badge-green'], rejected: ['مرفوضة', 'badge-red'], cancelled: ['ملغاة', 'badge-red'] };
    document.getElementById('myLeaveReqs').innerHTML = reqs.length ?
      reqs.map(function(r) {
        var s = sMap[r.status] || [r.status, 'badge-blue'];
        var sd = r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : '';
        var ed = r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : '';
        return '<div class="lv-card"><div class="lv-info"><div class="lv-name">' + (r.leaveTypeName || r.leave_type_name || '') + ' — ' + (r.days_count||0) + ' يوم</div>' +
          '<div class="lv-sub">' + sd + ' إلى ' + ed + '</div></div><span class="badge ' + s[1] + '">' + s[0] + '</span></div>';
      }).join('') : '<p style="text-align:center;color:var(--slate);padding:12px;">لا توجد طلبات</p>';
  }).getMyLeaveRequests(currentUser);
}

function openLeaveModal() {
  window._apiBridge.withSuccessHandler(function(types) {
    document.getElementById('lfType').innerHTML = (types||[]).map(function(t) {
      return '<option value="' + t.id + '">' + t.name + '</option>';
    }).join('');
    document.getElementById('leaveModal').classList.add('show');
  }).getHrLeaveTypes();
}
function closeLeaveModal() { document.getElementById('leaveModal').classList.remove('show'); }

function submitLeave() {
  var type = document.getElementById('lfType').value;
  var start = document.getElementById('lfStart').value;
  var end = document.getElementById('lfEnd').value;
  var reason = document.getElementById('lfReason').value;
  if (!type || !start || !end) return toast('اختر النوع والتواريخ', true);

  window._apiBridge.withSuccessHandler(function(r) {
    if (r.success) {
      toast(r.message || 'تم تقديم الطلب');
      closeLeaveModal();
      loadLeavePage();
    } else toast(r.error, true);
  }).myLeaveRequest({ username: currentUser, leaveTypeId: type, startDate: start, endDate: end, reason: reason });
}

// ═══════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════
function loadProfilePage() {
  if (!empProfile) return;
  var e = empProfile;
  var empTypes = { full_time: 'دوام كامل', part_time: 'دوام جزئي', hourly: 'بالساعة', contract: 'عقد' };
  var fields = [
    ['الرقم الوظيفي', e.employee_number],
    ['الاسم الكامل', e.fullName],
    ['الوظيفة', e.job_title || e.jobTitle],
    ['القسم', e.departmentName],
    ['الفرع', e.branchName],
    ['الجوال', e.phone],
    ['البريد', e.email],
    ['تاريخ التعيين', e.hire_date ? new Date(e.hire_date).toLocaleDateString('en-GB') : '—'],
    ['نوع التوظيف', empTypes[e.employment_type] || e.employment_type],
    ['الحالة', e.status === 'active' ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">' + (e.status||'') + '</span>']
  ];
  document.getElementById('profileInfo').innerHTML = fields.map(function(f) {
    return '<div class="pf-row"><span class="pf-label">' + f[0] + '</span><span class="pf-value">' + (f[1]||'—') + '</span></div>';
  }).join('');

  // Payslips
  window._apiBridge.withSuccessHandler(function(rows) {
    var slips = rows || [];
    var months = ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    document.getElementById('payslips').innerHTML = slips.length ?
      slips.map(function(s) {
        return '<div class="ps-card"><div class="ps-icon"><i class="fas fa-file-invoice-dollar"></i></div>' +
          '<div class="ps-info"><div class="ps-month">' + months[s.month||0] + ' ' + (s.year||'') + '</div>' +
          '<div class="ps-detail">أساسي: ' + Number(s.basic_salary||0).toFixed(0) + ' | خصومات: ' + Number(s.total_deductions||0).toFixed(0) + '</div></div>' +
          '<div class="ps-amount">' + Number(s.net_salary||0).toFixed(0) + '</div></div>';
      }).join('') : '<p style="text-align:center;color:var(--slate);padding:16px;">لا توجد رواتب</p>';
  }).getMyPayslips(currentUser);
}
