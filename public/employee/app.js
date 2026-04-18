/**
 * Employee Self-Service Portal — v4 (i18n ar/en)
 */
var empProfile = null;
var currentUser = '';
var BASE_API = '/api';

// ═══════════════════════════════════════
// i18n — LANGUAGE SUPPORT (Arabic / English)
// ═══════════════════════════════════════
var I18N = {
  ar: {
    // Login
    'login.title': 'بوابة الموظف',
    'login.sub': 'سجّل دخولك لتسجيل الحضور',
    'login.u': 'اسم المستخدم',
    'login.p': 'كلمة المرور',
    'login.btn': 'دخول',
    'login.fill': 'أدخل البيانات',
    'login.failed': 'فشل الدخول',
    'login.error': 'خطأ في الاتصال',
    // Header
    'header.employee': 'الموظف',
    'header.refresh': 'تحديث',
    'header.logout': 'خروج',
    'header.langToggle': 'English',
    // Bottom nav
    'nav.home': 'الرئيسية',
    'nav.att': 'البصمة',
    'nav.txn': 'معاملات',
    'nav.leave': 'إجازات',
    'nav.me': 'ملفي',
    // Home / Clock
    'home.recent': 'آخر الحضور',
    'clock.in': 'تسجيل حضور',
    'clock.out': 'تسجيل انصراف',
    'clock.recorded': 'تم التسجيل ✓',
    'clock.fingerprint': 'ضع بصمتك...',
    'clock.locating': 'جاري تحديد الموقع...',
    'clock.locationNeeded': 'يجب السماح بالموقع لتسجيل الحضور — افتح إعدادات المتصفح',
    'clock.deviceNoGeo': 'جهازك لا يدعم تحديد الموقع',
    'stats.hours': 'ساعات العمل',
    'stats.leave': 'رصيد إجازة',
    'stats.late': 'تأخير',
    'stats.present': 'حضور',
    'att.log': 'سجل الحضور',
    'att.workHours': 'ساعة عمل',
    'att.lateHours': 'ساعة تأخير',
    'att.lateCount': 'مرات تأخير',
    'att.lateMinutes': 'تأخير {n} د',
    'common.empty.home': 'لا توجد سجلات بعد',
    'common.empty.att': 'لا توجد سجلات',
    'common.empty.requests': 'لا توجد طلبات',
    'common.empty.balances': 'لا توجد أرصدة',
    'common.empty.txns': 'لا توجد معاملات',
    'common.empty.incoming': 'لا توجد معاملات بانتظارك',
    'common.done': 'تم',
    'common.refreshed': 'تم التحديث',
    // Leave
    'leave.balances': 'أرصدة الإجازات',
    'leave.days': 'يوم',
    'leave.yearsSvc': 'سنوات الخدمة',
    'leave.annualEntitlement': 'الاستحقاق السنوي',
    'leave.year': 'سنة',
    'leave.myRequests': 'طلباتي',
    'leave.newBtn': 'طلب إجازة',
    'leave.modalTitle': 'طلب إجازة',
    'leave.type': 'النوع',
    'leave.from': 'من',
    'leave.to': 'إلى',
    'leave.reason': 'السبب',
    'leave.submit': 'تقديم',
    'leave.selectTypeDates': 'اختر النوع والتواريخ',
    'leave.status.pending': 'معلّق',
    'leave.status.branch_approved': 'موافق',
    'leave.status.hr_approved': 'معتمد',
    'leave.status.rejected': 'مرفوض',
    // Transactions
    'txn.tab.inc': 'الوارد',
    'txn.tab.out': 'الصادر',
    'txn.awaitingMe': 'في انتظار إجرائي',
    'txn.mySent': 'معاملاتي المرسلة',
    'txn.newBtn': 'معاملة جديدة',
    'txn.accept': 'قبول',
    'txn.reject': 'رفض',
    'txn.return': 'إرجاع',
    'txn.forward': 'تحويل',
    'txn.edit': 'تعديل',
    'txn.cancel': 'إلغاء',
    'txn.responsible': 'مسؤول',
    'txn.rejectReason': 'سبب الرفض (مطلوب):',
    'txn.noteOptional': 'ملاحظة (اختياري):',
    'txn.reasonRequired': 'مطلوب ذكر السبب',
    'txn.forwardPrompt': 'تحويل إلى:\n{list}\n\nأدخل رقم الاختيار:',
    'txn.invalidChoice': 'اختيار غير صالح',
    'txn.noRecipient': 'لا يوجد مستلم محتمل',
    'txn.forwarded': 'تم التحويل',
    'txn.confirmCancel': 'إلغاء المعاملة نهائياً؟',
    'txn.cancelled': 'تم الإلغاء',
    'txn.titlePrompt': 'العنوان:',
    'txn.descPrompt': 'التفاصيل:',
    'txn.amountPrompt': 'المبلغ:',
    'txn.saved': 'تم الحفظ',
    'txn.failed': 'فشل',
    'txn.notFound': 'غير موجود',
    'txn.status.pending': 'معلّق',
    'txn.status.in_progress': 'قيد التنفيذ',
    'txn.status.approved': 'معتمدة',
    'txn.status.rejected': 'مرفوضة',
    'txn.status.closed': 'مغلقة',
    'txn.status.draft': 'مسودة',
    'txn.imp.critical': 'عاجل',
    'txn.imp.high': 'عالي',
    'txn.imp.medium': 'متوسط',
    'txn.imp.low': 'منخفض',
    'txn.act.create': 'إنشاء',
    'txn.act.approve': 'موافقة',
    'txn.act.reject': 'رفض',
    'txn.act.return': 'إرجاع',
    'txn.act.close': 'إغلاق',
    'txn.act.forward': 'تحويل',
    'txn.pathTitle': 'المسار الإداري',
    'txn.senderLabel': 'المرسل',
    'txn.branchLabel': 'الفرع',
    'txn.deptLabel': 'القسم',
    'txn.positionLabel': 'المنصب',
    'txn.accountLabel': 'الحساب',
    'txn.costCenterLabel': 'مركز التكلفة',
    'txn.numberLabel': 'الرقم',
    'txn.typeLabel': 'النوع',
    'txn.currentRoleLabel': 'الدور الحالي',
    'txn.downloadAttachment': 'تحميل المرفق',
    // New transaction modal
    'tm.title': 'معاملة جديدة',
    'tm.senderName': 'اسم المرسل',
    'tm.jobTitle': 'المسمى الوظيفي',
    'tm.type': 'نوع المعاملة *',
    'tm.importance': 'درجة الأهمية *',
    'tm.imp.low': 'منخفض (Low) — أخضر',
    'tm.imp.medium': 'متوسط (Medium) — أصفر',
    'tm.imp.high': 'عالي (High) — برتقالي',
    'tm.imp.critical': 'عاجل (Critical) — أحمر',
    'tm.titleLabel': 'العنوان *',
    'tm.titlePH': 'وصف مختصر للمعاملة',
    'tm.glAccount': 'الحساب المحاسبي',
    'tm.glSearch': 'ابحث برقم أو اسم الحساب...',
    'tm.costCenter': 'مركز التكلفة',
    'tm.noCC': '— بدون —',
    'tm.amount': 'المبلغ',
    'tm.recipient': 'إرسال إلى (المستلم) *',
    'tm.selectRecipient': '— اختر —',
    'tm.details': 'التفاصيل',
    'tm.detailsPH': 'تفاصيل إضافية',
    'tm.attachment': 'مرفق',
    'tm.send': 'إرسال المعاملة',
    'tm.titleRequired': 'اختر النوع واكتب العنوان',
    'tm.fileLimit': 'الحد 5MB',
    'tm.sending': 'جاري الإرسال...',
    'tm.newAccountPrompt': 'اسم الحساب الجديد (سيُضاف تحت المصروفات):',
    'tm.accountAdded': 'تم إضافة الحساب',
    'tm.txnNumberCreated': 'تم',
    'tm.noResults': 'لا توجد نتائج',
    'tm.addNewAccount': 'إضافة حساب جديد',
    // Detail modal
    'td.title': 'تفاصيل المعاملة',
    // Profile
    'profile.info': 'بياناتي',
    'profile.noRecord': 'لا يوجد ملف موظف مرتبط',
    'profile.number': 'الرقم',
    'profile.name': 'الاسم',
    'profile.position': 'الوظيفة',
    'profile.branch': 'الفرع',
    'profile.phone': 'الجوال',
    'profile.email': 'البريد',
    'profile.workHours': 'ساعات الدوام',
    'profile.salaries': 'الرواتب',
    'profile.salaryDetails': 'تفاصيل الراتب',
    'profile.basic': 'الراتب الأساسي',
    'profile.lateDed': 'خصم تأخير',
    'profile.netExpected': 'الصافي المتوقع',
    'profile.lateIgnored': 'تم تجاهل التأخير هذا الشهر — الراتب كامل',
    'profile.noSalaries': 'لا توجد رواتب',
    // Months
    'months.long': 'يناير فبراير مارس أبريل مايو يونيو يوليو أغسطس سبتمبر أكتوبر نوفمبر ديسمبر',
    'units.hour': 'ساعة',
    'units.minute': 'دقيقة',
    'units.minShort': 'د',
    'units.sarCurrency': 'ر.س'
  },
  en: {
    'login.title': 'Employee Portal',
    'login.sub': 'Sign in to record your attendance',
    'login.u': 'Username',
    'login.p': 'Password',
    'login.btn': 'Sign In',
    'login.fill': 'Enter credentials',
    'login.failed': 'Login failed',
    'login.error': 'Connection error',
    'header.employee': 'Employee',
    'header.refresh': 'Refresh',
    'header.logout': 'Logout',
    'header.langToggle': 'العربية',
    'nav.home': 'Home',
    'nav.att': 'Attendance',
    'nav.txn': 'Transactions',
    'nav.leave': 'Leaves',
    'nav.me': 'Profile',
    'home.recent': 'Recent Attendance',
    'clock.in': 'Clock In',
    'clock.out': 'Clock Out',
    'clock.recorded': 'Recorded ✓',
    'clock.fingerprint': 'Place your fingerprint...',
    'clock.locating': 'Locating...',
    'clock.locationNeeded': 'Please allow location to clock in — open browser settings',
    'clock.deviceNoGeo': 'Your device does not support location',
    'stats.hours': 'Work Hours',
    'stats.leave': 'Leave Balance',
    'stats.late': 'Late',
    'stats.present': 'Present',
    'att.log': 'Attendance Log',
    'att.workHours': 'Work hrs',
    'att.lateHours': 'Late hrs',
    'att.lateCount': 'Late count',
    'att.lateMinutes': 'Late {n} min',
    'common.empty.home': 'No records yet',
    'common.empty.att': 'No records',
    'common.empty.requests': 'No requests',
    'common.empty.balances': 'No balances',
    'common.empty.txns': 'No transactions',
    'common.empty.incoming': 'No transactions awaiting you',
    'common.done': 'Done',
    'common.refreshed': 'Refreshed',
    'leave.balances': 'Leave Balances',
    'leave.days': 'days',
    'leave.yearsSvc': 'Years of service',
    'leave.annualEntitlement': 'Annual entitlement',
    'leave.year': 'year',
    'leave.myRequests': 'My Requests',
    'leave.newBtn': 'Request Leave',
    'leave.modalTitle': 'Leave Request',
    'leave.type': 'Type',
    'leave.from': 'From',
    'leave.to': 'To',
    'leave.reason': 'Reason',
    'leave.submit': 'Submit',
    'leave.selectTypeDates': 'Select type and dates',
    'leave.status.pending': 'Pending',
    'leave.status.branch_approved': 'Branch Approved',
    'leave.status.hr_approved': 'HR Approved',
    'leave.status.rejected': 'Rejected',
    'txn.tab.inc': 'Incoming',
    'txn.tab.out': 'Outgoing',
    'txn.awaitingMe': 'Awaiting my action',
    'txn.mySent': 'My sent transactions',
    'txn.newBtn': 'New Transaction',
    'txn.accept': 'Accept',
    'txn.reject': 'Reject',
    'txn.return': 'Return',
    'txn.forward': 'Forward',
    'txn.edit': 'Edit',
    'txn.cancel': 'Cancel',
    'txn.responsible': 'Assigned',
    'txn.rejectReason': 'Rejection reason (required):',
    'txn.noteOptional': 'Note (optional):',
    'txn.reasonRequired': 'Reason required',
    'txn.forwardPrompt': 'Forward to:\n{list}\n\nEnter the number:',
    'txn.invalidChoice': 'Invalid choice',
    'txn.noRecipient': 'No eligible recipient',
    'txn.forwarded': 'Forwarded',
    'txn.confirmCancel': 'Cancel transaction permanently?',
    'txn.cancelled': 'Cancelled',
    'txn.titlePrompt': 'Title:',
    'txn.descPrompt': 'Details:',
    'txn.amountPrompt': 'Amount:',
    'txn.saved': 'Saved',
    'txn.failed': 'Failed',
    'txn.notFound': 'Not found',
    'txn.status.pending': 'Pending',
    'txn.status.in_progress': 'In Progress',
    'txn.status.approved': 'Approved',
    'txn.status.rejected': 'Rejected',
    'txn.status.closed': 'Closed',
    'txn.status.draft': 'Draft',
    'txn.imp.critical': 'Critical',
    'txn.imp.high': 'High',
    'txn.imp.medium': 'Medium',
    'txn.imp.low': 'Low',
    'txn.act.create': 'Created',
    'txn.act.approve': 'Approved',
    'txn.act.reject': 'Rejected',
    'txn.act.return': 'Returned',
    'txn.act.close': 'Closed',
    'txn.act.forward': 'Forwarded',
    'txn.pathTitle': 'Workflow Path',
    'txn.senderLabel': 'Sender',
    'txn.branchLabel': 'Branch',
    'txn.deptLabel': 'Department',
    'txn.positionLabel': 'Position',
    'txn.accountLabel': 'Account',
    'txn.costCenterLabel': 'Cost Center',
    'txn.numberLabel': 'No.',
    'txn.typeLabel': 'Type',
    'txn.currentRoleLabel': 'Current Role',
    'txn.downloadAttachment': 'Download attachment',
    'tm.title': 'New Transaction',
    'tm.senderName': 'Sender Name',
    'tm.jobTitle': 'Job Title',
    'tm.type': 'Type *',
    'tm.importance': 'Importance *',
    'tm.imp.low': 'Low — green',
    'tm.imp.medium': 'Medium — yellow',
    'tm.imp.high': 'High — orange',
    'tm.imp.critical': 'Critical — red',
    'tm.titleLabel': 'Title *',
    'tm.titlePH': 'Brief transaction description',
    'tm.glAccount': 'GL Account',
    'tm.glSearch': 'Search by code or name...',
    'tm.costCenter': 'Cost Center',
    'tm.noCC': '— None —',
    'tm.amount': 'Amount',
    'tm.recipient': 'Send to (recipient) *',
    'tm.selectRecipient': '— Select —',
    'tm.details': 'Details',
    'tm.detailsPH': 'Additional details',
    'tm.attachment': 'Attachment',
    'tm.send': 'Send',
    'tm.titleRequired': 'Select type and enter title',
    'tm.fileLimit': '5MB limit',
    'tm.sending': 'Sending...',
    'tm.newAccountPrompt': 'New account name (under Expenses):',
    'tm.accountAdded': 'Account added',
    'tm.txnNumberCreated': 'Done',
    'tm.noResults': 'No results',
    'tm.addNewAccount': 'Add new account',
    'td.title': 'Transaction Details',
    'profile.info': 'My Information',
    'profile.noRecord': 'No linked employee record',
    'profile.number': 'No.',
    'profile.name': 'Name',
    'profile.position': 'Position',
    'profile.branch': 'Branch',
    'profile.phone': 'Phone',
    'profile.email': 'Email',
    'profile.workHours': 'Work hours',
    'profile.salaries': 'Salaries',
    'profile.salaryDetails': 'Salary Details',
    'profile.basic': 'Basic Salary',
    'profile.lateDed': 'Late Deduction',
    'profile.netExpected': 'Expected Net',
    'profile.lateIgnored': 'Late ignored this month — full salary',
    'profile.noSalaries': 'No salaries',
    'months.long': 'January February March April May June July August September October November December',
    'units.hour': 'hr',
    'units.minute': 'min',
    'units.minShort': 'm',
    'units.sarCurrency': 'SAR'
  }
};

var currentLang = (function() {
  try { return localStorage.getItem('emp_lang') || 'ar'; } catch(e) { return 'ar'; }
})();

function t(key, vars) {
  var dict = I18N[currentLang] || I18N.ar;
  var out = (dict && dict[key] !== undefined) ? dict[key] : ((I18N.ar && I18N.ar[key] !== undefined) ? I18N.ar[key] : key);
  if (vars) {
    Object.keys(vars).forEach(function(k) { out = out.replace('{' + k + '}', vars[k]); });
  }
  return out;
}

function monthName(m) {
  var list = t('months.long').split(' ');
  return list[Math.max(0, Math.min(11, Number(m) - 1))];
}

function setLang(lang) {
  currentLang = (lang === 'en') ? 'en' : 'ar';
  try { localStorage.setItem('emp_lang', currentLang); } catch(e) {}
  applyLangToStaticDOM();
  // Re-render all dynamic content
  try { loadHomeData(); } catch(e) {}
  try { loadMyTransactions(); } catch(e) {}
  try { loadIncomingTxns(); } catch(e) {}
  try { loadLeavePage(); } catch(e) {}
  try { loadProfilePage(); } catch(e) {}
  try { loadAttPage(); } catch(e) {}
}

function applyLangToStaticDOM() {
  document.documentElement.setAttribute('lang', currentLang);
  document.documentElement.setAttribute('dir', currentLang === 'ar' ? 'rtl' : 'ltr');
  document.body.style.direction = currentLang === 'ar' ? 'rtl' : 'ltr';
  // Static text via data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-html');
    var icon = el.getAttribute('data-i18n-icon') || '';
    el.innerHTML = (icon ? '<i class="' + icon + '"></i> ' : '') + t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });
  // Toggle button label
  var btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = currentLang === 'ar' ? 'EN' : 'ع';
}

function toggleLang() { setLang(currentLang === 'ar' ? 'en' : 'ar'); }
window.toggleLang = toggleLang;
window.setLang = setLang;
window.t = t;


document.addEventListener('DOMContentLoaded', function() {
  document.body.style.visibility = 'visible';
  applyLangToStaticDOM();  // apply language once DOM is ready
  var token = localStorage.getItem('emp_token');
  var session = null;
  try { session = JSON.parse(localStorage.getItem('emp_session') || 'null'); } catch(e) {}
  if (token && session && session.username) {
    currentUser = session.username;
    var lp = document.getElementById('loginPage'); if (lp) lp.style.display = 'none';
    startApp();
  }
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
    '<button class="clock-btn clock-in" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">'+t('clock.in')+'</div><div class="clock-time" id="liveTime"></div></div></button>';
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
    } else toast(r ? r.error : t('login.failed'), true);
  });
}

function doLogout() { localStorage.removeItem('emp_token'); localStorage.removeItem('emp_session'); location.reload(); }
function doRefresh() { loadHomeData(); toast(t('common.refreshed')); }

// ─── Navigation ───
function navTo(pg, el) {
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active');});
  document.getElementById('pg'+pg).classList.add('active');
  if (el) el.classList.add('active');
  if (pg==='att') loadAttPage();
  if (pg==='txn') { txnSwitchTab('inc'); loadIncomingTxns(); loadMyTransactions(); }
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
      cs.innerHTML = '<button class="clock-btn ci" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">'+t('clock.in')+'</div><div class="clock-time" id="liveTime"></div></div></button>';
      startLiveClock();
    } else if (!rec.clock_out) {
      var ci = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      cs.innerHTML = '<button class="clock-btn co" onclick="doClock()"><i class="fas fa-fingerprint"></i><div><div class="clock-lbl">'+t('clock.out')+'</div><div class="clock-time">'+t('clock.in')+': ' + ci + '</div></div></button>';
    } else {
      var ci2 = rec.clock_in ? new Date(rec.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      var co2 = rec.clock_out ? new Date(rec.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '';
      var hrs = (Number(rec.total_hours)||0);
      var hrsStr = hrs >= 1 ? hrs.toFixed(1) + ' ' + t('units.hour') : Math.round(hrs*60) + ' ' + t('units.minute');
      cs.innerHTML = '<div class="clock-btn cd"><i class="fas fa-check-circle" style="color:#059669;"></i><div><div class="clock-lbl" style="color:#059669;">'+t('clock.recorded')+'</div><div class="clock-time" style="color:#374151;">' + ci2 + ' → ' + co2 + ' | ' + hrsStr + '</div></div></div>';
    }

    // Stats
    var present = att.filter(function(a){return a.status==='present';}).length;
    var hours = att.reduce(function(s,a){return s+(Number(a.total_hours)||0);},0);
    var totalLateMin = att.reduce(function(s,a){return s+(Number(a.late_minutes)||0);},0);

    // Format hours:minutes
    var hrsH = Math.floor(hours); var hrsM = Math.round((hours - hrsH) * 60);
    var hrsStr = hrsH + ':' + String(hrsM).padStart(2,'0');
    var lateH = Math.floor(totalLateMin/60); var lateM = Math.round(totalLateMin%60);
    var lateStr = lateH + ':' + String(lateM).padStart(2,'0');

    // Accrued leave balance (daily accumulation)
    var accrued = 0;
    if (empProfile && empProfile.hire_date) {
      var hd = new Date(empProfile.hire_date);
      var yrs = (new Date() - hd) / (365.25 * 24 * 60 * 60 * 1000);
      var annual = yrs >= 5 ? 30 : 21;
      // Days elapsed this year
      var jan1 = new Date(new Date().getFullYear(), 0, 1);
      var daysElapsed = Math.floor((new Date() - jan1) / (24*60*60*1000));
      accrued = Math.round((annual / 365) * daysElapsed * 100) / 100;
    }
    // Get used leave days
    var usedLeave = 0;
    callAPI('GET', '/hr/my-leave-balances?username=' + currentUser, null, function(bals) {
      if (bals && Array.isArray(bals)) {
        bals.forEach(function(b) { usedLeave += Number(b.used_days||0); });
      }
      var remainLeave = Math.max(0, accrued - usedLeave);
      var leaveWhole = Math.floor(remainLeave);
      var leaveHrs = Math.round((remainLeave - leaveWhole) * 9); // 9-hour day

      document.getElementById('homeStats').innerHTML =
        '<div class="st"><i class="fas fa-clock" style="color:#0ea5e9;background:#e0f2fe;"></i><b>' + hrsStr + '</b><span>'+t('stats.hours')+'</span></div>' +
        '<div class="st"><i class="fas fa-umbrella-beach" style="color:#10b981;background:#ecfdf5;"></i><b>' + leaveWhole + '<small style="font-size:11px;color:#64748b;">.' + leaveHrs + 'h</small></b><span>'+t('stats.leave')+'</span></div>' +
        '<div class="st"><i class="fas fa-exclamation" style="color:#f59e0b;background:#fffbeb;"></i><b>' + lateStr + '</b><span>'+t('stats.late')+'</span></div>' +
        '<div class="st"><i class="fas fa-calendar-check" style="color:#8b5cf6;background:#f5f3ff;"></i><b>' + present + '</b><span>'+t('stats.present')+'</span></div>';
    });

    // Recent attendance
    var ra = document.getElementById('recentAtt');
    if (!att.length) { ra.innerHTML = '<p class="empty">'+t('common.empty.home')+'</p>'; return; }
    var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA';
    ra.innerHTML = att.slice(0,7).map(function(a) {
      var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString(localeCode,{weekday:'short',day:'numeric',month:'short'}) : '';
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
    toast(t('clock.fingerprint'));
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
  toast(t('clock.locating'));
  var data = { username: currentUser };
  // Device name
  var ua = navigator.userAgent;
  if (/iPhone/.test(ua)) data.deviceName = 'iPhone';
  else if (/iPad/.test(ua)) data.deviceName = 'iPad';
  else if (/Android/.test(ua)) { var m = ua.match(/;\s*([^;)]+)\s*Build/); data.deviceName = m ? m[1].trim() : 'Android'; }
  else data.deviceName = currentLang === 'en' ? 'Browser' : 'متصفح';

  // REQUIRE location
  if (!navigator.geolocation) { toast(t('clock.deviceNoGeo'), true); return; }

  navigator.geolocation.getCurrentPosition(function(pos) {
    data.geoLat = pos.coords.latitude;
    data.geoLng = pos.coords.longitude;
    fetch('https://nominatim.openstreetmap.org/reverse?lat='+pos.coords.latitude+'&lon='+pos.coords.longitude+'&format=json&accept-language=' + (currentLang === 'en' ? 'en' : 'ar'))
      .then(function(r){return r.json();})
      .then(function(g){ data.geoAddress = g.display_name||''; sendClock(data); })
      .catch(function(){ sendClock(data); });
  }, function(err) {
    toast(t('clock.locationNeeded'), true);
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
    // Stats cards for attendance page
    var statsEl = document.getElementById('attStats');
    if (statsEl) {
      var present = att.filter(function(a){return a.status==='present';}).length;
      var hours = att.reduce(function(s,a){return s+(Number(a.total_hours)||0);},0);
      var totalLateMin = att.reduce(function(s,a){return s+(Number(a.late_minutes)||0);},0);
      var lateCount = att.filter(function(a){return (a.late_minutes||0)>0;}).length;
      statsEl.innerHTML =
        '<div class="st"><i class="fas fa-check" style="color:#10b981;background:#ecfdf5;"></i><b>' + present + '</b><span>'+t('stats.present')+'</span></div>' +
        '<div class="st"><i class="fas fa-clock" style="color:#0ea5e9;background:#e0f2fe;"></i><b>' + hours.toFixed(1) + '</b><span>'+t('att.workHours')+'</span></div>' +
        '<div class="st"><i class="fas fa-exclamation" style="color:#f59e0b;background:#fffbeb;"></i><b>' + (totalLateMin/60).toFixed(1) + '</b><span>'+t('att.lateHours')+'</span></div>' +
        '<div class="st"><i class="fas fa-user-clock" style="color:#ef4444;background:#fef2f2;"></i><b>' + lateCount + '</b><span>'+t('att.lateCount')+'</span></div>';
    }
    if (!att.length) { c.innerHTML = '<p class="empty">'+t('common.empty.att')+'</p>'; return; }
    var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA';
    c.innerHTML = att.map(function(a) {
      var d = a.attendance_date ? new Date(a.attendance_date).toLocaleDateString(localeCode,{weekday:'long',day:'numeric',month:'long'}) : '';
      var ci = a.clock_in ? new Date(a.clock_in).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '—';
      var co = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) : '⏳';
      var lateTxt = (a.late_minutes||0) > 0 ? '<div class="meta" style="color:#ef4444;"><i class="fas fa-exclamation-circle"></i> '+t('att.lateMinutes',{n:a.late_minutes})+'</div>' : '';
      var dev = a.device_name ? '<div class="meta"><i class="fas fa-mobile-alt"></i> ' + a.device_name + '</div>' : '';
      var loc = a.geo_address_in ? '<div class="meta"><i class="fas fa-map-marker-alt" style="color:#10b981;"></i> ' + a.geo_address_in.substring(0,50) + '</div>' : '';
      return '<div class="ar"><span class="ad">' + d + '</span><span class="at">' + ci + ' → ' + co + lateTxt + dev + loc + '</span><span class="ah">' + (Number(a.total_hours)||0).toFixed(1) + 'h</span></div>';
    }).join('');
  });
}

// ═══════════════════════════════════════
// LEAVE PAGE
// ═══════════════════════════════════════
function loadLeavePage() {
  // Show years of service + entitlement
  var yearsInfo = '';
  if (empProfile && empProfile.hire_date) {
    var hd = new Date(empProfile.hire_date);
    var yrs = new Date().getFullYear() - hd.getFullYear();
    var entitlement = yrs >= 5 ? 30 : 21;
    yearsInfo = '<div style="padding:8px 12px;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:12px;font-weight:700;margin-bottom:8px;"><i class="fas fa-briefcase" style="margin-left:4px;"></i> '+t('leave.yearsSvc')+': ' + yrs + ' '+t('leave.year')+' — '+t('leave.annualEntitlement')+': ' + entitlement + ' '+t('leave.days')+'</div>';
  }
  callAPI('GET', '/hr/my-leave-balances?username=' + currentUser, null, function(rows) {
    var bals = rows||[]; if (!Array.isArray(bals)) bals = [];
    var c = document.getElementById('leaveBals');
    var html = yearsInfo;
    html += bals.length ? bals.map(function(b) {
      var total = Number(b.total_days||0), used = Number(b.used_days||0), rem = Number(b.remaining_days||0);
      var pct = total > 0 ? Math.round((used/total)*100) : 0;
      var barClr = rem <= 3 ? '#ef4444' : rem <= 7 ? '#f59e0b' : '#10b981';
      return '<div class="lc" style="flex-direction:column;align-items:stretch;gap:4px;">' +
        '<div style="display:flex;justify-content:space-between;"><span style="font-weight:700;">' + (b.leaveTypeName||b.leave_type_name||'—') + '</span><span style="color:#0ea5e9;font-weight:800;">' + rem + ' / ' + total + ' ' + t('leave.days') + '</span></div>' +
        '<div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + barClr + ';border-radius:3px;"></div></div>' +
        '</div>';
    }).join('') : '<p class="empty">'+t('common.empty.balances')+'</p>';
    c.innerHTML = html;
  });
  callAPI('GET', '/hr/my-leave-requests?username=' + currentUser, null, function(rows) {
    var reqs = rows||[]; if (!Array.isArray(reqs)) reqs = [];
    var sMap = { pending:t('leave.status.pending'), branch_approved:t('leave.status.branch_approved'), hr_approved:t('leave.status.hr_approved'), rejected:t('leave.status.rejected') };
    var c = document.getElementById('leaveReqs');
    c.innerHTML = reqs.length ? reqs.map(function(r) {
      var sd = r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : '';
      var ed = r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : '';
      return '<div class="lc"><div class="ln">' + (r.leaveTypeName||r.leave_type_name||'') + ' — ' + (r.days_count||0) + ' ' + t('leave.days') + '<div class="meta">' + sd + ' → ' + ed + '</div></div><span class="badge">' + (sMap[r.status]||r.status) + '</span></div>';
    }).join('') : '<p class="empty">'+t('common.empty.requests')+'</p>';
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
  if (!d.leaveTypeId||!d.startDate||!d.endDate) return toast(t('leave.selectTypeDates'),true);
  callAPI('POST', '/hr/my-leave-request', d, function(r) {
    if (r&&r.success) { toast(r.message||t('common.done')); closeLeaveForm(); loadLeavePage(); }
    else toast(r?r.error:t('txn.failed'),true);
  });
}

// ═══════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════
function loadProfilePage() {
  var c = document.getElementById('profileInfo');
  if (!empProfile) { c.innerHTML = '<p class="empty">'+t('profile.noRecord')+'</p>'; return; }
  var e = empProfile;
  var ws = e.work_start || e.workStart || '08:00';
  var we = e.work_end || e.workEnd || '17:00';
  var salary = Number(e.basic_salary || e.basicSalary || 0);
  var fields = [
    [t('profile.number'), e.employee_number],
    [t('profile.name'), e.fullName],
    [t('profile.position'), e.job_title||e.jobTitle],
    [t('profile.branch'), e.branchName],
    [t('profile.phone'), e.phone],
    [t('profile.email'), e.email],
    [t('profile.workHours'), ws+' — '+we]
  ];
  c.innerHTML = fields.map(function(f){return '<div class="pf"><span>'+f[0]+'</span><b>'+(f[1]||'—')+'</b></div>';}).join('');

  // Calculate salary with late deductions for current month
  callAPI('GET', '/hr/my-attendance?username=' + currentUser, null, function(rows) {
    var att = rows || []; if (!Array.isArray(att)) att = [];
    var now = new Date();
    var thisMonth = att.filter(function(a) {
      if (!a.attendance_date) return false;
      var d = new Date(a.attendance_date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    var totalLateMin = thisMonth.reduce(function(s,a){return s+(Number(a.late_minutes)||0);},0);
    var dailyRate = salary / 30;
    var hourlyRate = dailyRate / 9; // 9-hour workday

    // Check if late is ignored this month
    var currentMonth = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    var ignoreMonth = empProfile ? (empProfile.ignore_late_month || '') : '';
    var ignoreLate = ignoreMonth === currentMonth;

    var lateDeduction = ignoreLate ? 0 : Math.round(hourlyRate * (totalLateMin / 60) * 100) / 100;
    var netSalary = Math.round((salary - lateDeduction) * 100) / 100;

    var currency = t('units.sarCurrency');
    var monthLocale = currentLang === 'en' ? 'en-US' : 'ar-SA';
    var salaryHtml = '<div style="background:#f8fafc;border-radius:12px;padding:14px;margin-top:10px;border:1px solid #e5e7eb;">';
    salaryHtml += '<div style="font-size:13px;font-weight:800;color:#1e293b;margin-bottom:10px;"><i class="fas fa-money-bill-wave" style="color:#10b981;margin-left:6px;"></i> '+t('profile.salaryDetails')+' — ' + (now.toLocaleDateString(monthLocale,{month:'long'})) + '</div>';
    salaryHtml += '<div class="pf"><span>'+t('profile.basic')+'</span><b style="color:#1e40af;">' + salary.toLocaleString('en') + ' ' + currency + '</b></div>';
    if (totalLateMin > 0 && !ignoreLate) {
      var lateH = Math.floor(totalLateMin/60); var lateM = totalLateMin%60;
      salaryHtml += '<div class="pf"><span>'+t('profile.lateDed')+' (' + lateH + ':' + String(lateM).padStart(2,'0') + ')</span><b style="color:#ef4444;">- ' + lateDeduction.toLocaleString('en') + ' ' + currency + '</b></div>';
    }
    if (ignoreLate && totalLateMin > 0) {
      salaryHtml += '<div style="padding:6px 10px;border-radius:8px;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;margin:4px 0;"><i class="fas fa-check-circle" style="margin-left:4px;"></i> '+t('profile.lateIgnored')+'</div>';
    }
    salaryHtml += '<div class="pf" style="border-top:2px solid #e5e7eb;padding-top:8px;margin-top:4px;"><span style="font-weight:800;">'+t('profile.netExpected')+'</span><b style="color:' + (lateDeduction > 0 ? '#f59e0b' : '#10b981') + ';font-size:18px;">' + netSalary.toLocaleString('en') + ' ' + currency + '</b></div>';
    salaryHtml += '</div>';
    c.innerHTML += salaryHtml;
  });

  callAPI('GET', '/hr/my-payslips?username=' + currentUser, null, function(rows) {
    var s = rows||[]; if (!Array.isArray(s)) s = [];
    var currency = t('units.sarCurrency');
    document.getElementById('payslips').innerHTML = s.length ? s.map(function(p){return '<div class="lc"><div class="ln">'+monthName(p.month||0)+' '+(p.year||'')+'</div><div class="lr" style="color:#10b981;">'+Number(p.net_salary||0).toFixed(0)+' '+currency+'</div></div>';}).join('') : '<p class="empty">'+t('profile.noSalaries')+'</p>';
  });
}

// TRANSACTIONS — Common helpers
var _impColors = { critical:'#dc2626', high:'#ea580c', medium:'#ca8a04', low:'#16a34a' };
var _impBgs    = { critical:'#fee2e2', high:'#ffedd5', medium:'#fef9c3', low:'#dcfce7' };
var _statClr   = { pending:'#f59e0b', in_progress:'#0ea5e9', approved:'#10b981', rejected:'#ef4444', closed:'#6b7280', draft:'#94a3b8' };
function _impLabel(i) { return t('txn.imp.' + i) || i; }
function _statLabel(s) { return t('txn.status.' + s) || s; }

function _impBadge(i) {
  var c = _impColors[i]||'#6b7280', bg = _impBgs[i]||'#f3f4f6';
  return '<span style="padding:2px 8px;border-radius:6px;background:'+bg+';color:'+c+';font-size:10px;font-weight:800;"><i class="fas fa-circle" style="font-size:6px;margin-left:3px;"></i>'+_impLabel(i)+'</span>';
}

function _statBadge(s) {
  var c = _statClr[s]||'#94a3b8';
  return '<span style="padding:2px 8px;border-radius:6px;background:'+c+'20;color:'+c+';font-size:10px;font-weight:800;">'+_statLabel(s)+'</span>';
}

function txnSwitchTab(which) {
  var inc = document.getElementById('txnSubInc'), out = document.getElementById('txnSubOut');
  var tInc = document.getElementById('txnTabInc'), tOut = document.getElementById('txnTabOut');
  // Re-apply labels in the current language (in case badge span was reset)
  var incLabel = tInc.querySelector('[data-i18n-label]');
  var outLabel = tOut.querySelector('[data-i18n-label]');
  if (incLabel) incLabel.textContent = t('txn.tab.inc');
  if (outLabel) outLabel.textContent = t('txn.tab.out');
  if (which === 'inc') {
    inc.style.display = ''; out.style.display = 'none';
    tInc.style.background='#fff'; tInc.style.color='#0ea5e9'; tInc.style.boxShadow='0 1px 3px rgba(0,0,0,.05)';
    tOut.style.background='transparent'; tOut.style.color='#64748b'; tOut.style.boxShadow='none';
    loadIncomingTxns();
  } else {
    inc.style.display = 'none'; out.style.display = '';
    tOut.style.background='#fff'; tOut.style.color='#0ea5e9'; tOut.style.boxShadow='0 1px 3px rgba(0,0,0,.05)';
    tInc.style.background='transparent'; tInc.style.color='#64748b'; tInc.style.boxShadow='none';
    loadMyTransactions();
  }
}

// Incoming — transactions awaiting my action
function loadIncomingTxns() {
  var c = document.getElementById('incomingTxnList');
  if (!c) return;
  c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  callAPI('GET', '/workflow/incoming?username=' + encodeURIComponent(currentUser), null, function(rows) {
    var list = rows || []; if (!Array.isArray(list)) list = [];
    var bd = document.getElementById('txnIncBadge');
    if (bd) { if (list.length) { bd.style.display = 'inline-block'; bd.textContent = list.length; } else { bd.style.display = 'none'; } }
    if (!list.length) { c.innerHTML = '<p class="empty">'+t('common.empty.incoming')+'</p>'; return; }
    var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA';
    c.innerHTML = list.map(function(tx) {
      var dt = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(localeCode,{day:'numeric',month:'short'}) : '';
      return '<div style="border-bottom:1px solid #f5f5f5;padding:10px 0;">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' + _impBadge(tx.importance||'medium') + _statBadge(tx.status) + '</div>' +
        '<div onclick="viewMyTxn(\''+tx.id+'\')" style="cursor:pointer;">' +
          '<div style="font-weight:800;font-size:13px;color:#0f172a;">' + (tx.title||'') + '</div>' +
          '<div style="font-size:10px;font-family:monospace;color:#64748b;margin-top:2px;">'+(tx.txnNumber||'')+'</div>' +
          '<div class="meta">' + (tx.typeName||'') + ' • ' + (tx.senderName||tx.createdBy||'') + ' • ' + dt + '</div>' +
          (Number(tx.amount) ? '<div style="margin-top:2px;color:#0ea5e9;font-weight:800;font-size:12px;">'+Number(tx.amount).toLocaleString('en',{minimumFractionDigits:2})+' '+t('units.sarCurrency')+'</div>' : '') +
        '</div>' +
        '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">' +
          '<button onclick="empAct(\''+tx.id+'\',\'approve\')" style="flex:1;padding:8px;border:none;background:#10b981;color:#fff;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-check"></i> '+t('txn.accept')+'</button>' +
          '<button onclick="empAct(\''+tx.id+'\',\'reject\')" style="flex:1;padding:8px;border:none;background:#ef4444;color:#fff;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-times"></i> '+t('txn.reject')+'</button>' +
          '<button onclick="empAct(\''+tx.id+'\',\'return\')" style="flex:1;padding:8px;border:none;background:#f59e0b;color:#fff;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-undo"></i> '+t('txn.return')+'</button>' +
          '<button onclick="empFwd(\''+tx.id+'\')" style="flex:1;padding:8px;border:none;background:#8b5cf6;color:#fff;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-share"></i> '+t('txn.forward')+'</button>' +
        '</div>' +
      '</div>';
    }).join('');
  });
}

function empAct(id, action) {
  var note = '';
  if (action === 'reject') {
    note = prompt(t('txn.rejectReason'));
    if (!note) return toast(t('txn.reasonRequired'), true);
  } else {
    note = prompt(t('txn.noteOptional')) || '';
  }
  var actionLabels = { approve: t('txn.act.approve'), reject: t('txn.act.reject'), return: t('txn.act.return') };
  toast(actionLabels[action] || action);
  callAPI('POST', '/workflow/transactions/' + id + '/action', {
    action: action, username: currentUser, note: note
  }, function(r) {
    if (r && r.success) { toast(t('common.done')); loadIncomingTxns(); loadMyTransactions(); }
    else toast(r ? r.error : t('txn.failed'), true);
  });
}

function empFwd(id) {
  callAPI('GET', '/workflow/eligible-users?sender=' + encodeURIComponent(currentUser), null, function(users) {
    if (!users || !users.length) return toast(t('txn.noRecipient'), true);
    var opts = users.map(function(u, i) { return (i+1)+') '+(u.fullName||u.username)+' — '+(u.positionName||''); }).join('\n');
    var pick = prompt(t('txn.forwardPrompt', { list: opts }));
    var idx = parseInt(pick) - 1;
    if (isNaN(idx) || idx < 0 || idx >= users.length) return toast(t('txn.invalidChoice'), true);
    var note = prompt(t('txn.noteOptional')) || '';
    callAPI('POST', '/workflow/transactions/' + id + '/action', {
      action: 'forward', username: currentUser, forwardTo: users[idx].username,
      note: t('txn.act.forward') + ': ' + users[idx].username + (note ? ' — ' + note : '')
    }, function(r) {
      if (r && r.success) { toast(t('txn.forwarded')); loadIncomingTxns(); }
      else toast(r ? r.error : t('txn.failed'), true);
    });
  });
}

function loadMyTransactions() {
  var c = document.getElementById('myTxnList');
  if (!c) return;
  c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  callAPI('GET', '/workflow/outbox?username=' + encodeURIComponent(currentUser), null, function(rows) {
    var txns = rows || []; if (!Array.isArray(txns)) txns = [];
    if (!txns.length) { c.innerHTML = '<p class="empty">'+t('common.empty.txns')+'</p>'; return; }
    var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA';
    c.innerHTML = txns.map(function(tx) {
      var dt = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(localeCode,{day:'numeric',month:'short'}) : '';
      var canEdit = (tx.status==='pending' || tx.status==='draft');
      var actBtns = '';
      if (canEdit) {
        actBtns = '<div style="display:flex;gap:4px;margin-top:6px;">' +
          '<button onclick="event.stopPropagation();empEditTxn(\''+tx.id+'\')" style="flex:1;padding:6px;border:none;background:#eff6ff;color:#1e40af;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-edit"></i> '+t('txn.edit')+'</button>' +
          '<button onclick="event.stopPropagation();empCancelTxn(\''+tx.id+'\')" style="flex:1;padding:6px;border:none;background:#fef2f2;color:#991b1b;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-trash"></i> '+t('txn.cancel')+'</button>' +
        '</div>';
      }
      return '<div style="border-bottom:1px solid #f5f5f5;padding:10px 0;">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' + _impBadge(tx.importance||'medium') + _statBadge(tx.status) + '</div>' +
        '<div onclick="viewMyTxn(\''+tx.id+'\')" style="cursor:pointer;">' +
          '<div style="font-weight:800;font-size:13px;color:#0f172a;">' + (tx.title||'') + '</div>' +
          '<div style="font-size:10px;font-family:monospace;color:#64748b;margin-top:2px;">'+(tx.txnNumber||'')+'</div>' +
          '<div class="meta">' + (tx.typeName||'') + ' • ' + dt + ' • '+t('txn.responsible')+': <b style="color:#1e40af;">' + (tx.currentAssignee||tx.currentPositionName||'—') + '</b></div>' +
        '</div>' +
        actBtns +
      '</div>';
    }).join('');
  });
}

function empEditTxn(id) {
  callAPI('GET', '/workflow/transactions/'+id, null, function(txn) {
    if (!txn || txn.error) return toast(t('txn.notFound'), true);
    var title = prompt(t('txn.titlePrompt'), txn.title || '');
    if (title === null) return;
    var desc = prompt(t('txn.descPrompt'), txn.description || '');
    if (desc === null) return;
    var amt = prompt(t('txn.amountPrompt'), Number(txn.amount||0));
    if (amt === null) return;
    callAPI('PUT', '/workflow/transactions/'+id, {
      username: currentUser, title: title, description: desc, amount: Number(amt)||0
    }, function(r) {
      if (r && r.success) { toast(t('txn.saved')); loadMyTransactions(); }
      else toast(r ? r.error : t('txn.failed'), true);
    });
  });
}

function empCancelTxn(id) {
  if (!confirm(t('txn.confirmCancel'))) return;
  callAPI('DELETE', '/workflow/transactions/'+id+'?username='+encodeURIComponent(currentUser), null, function(r) {
    if (r && r.success) { toast(t('txn.cancelled')); loadMyTransactions(); }
    else toast(r ? r.error : t('txn.failed'), true);
  });
}
var _txnAccounts = [];
var _txnCostCenters = [];
var _txnEligibleUsers = [];

function openTxnModal() {
  // Load all data in parallel
  callAPI('GET', '/workflow/transaction-types', null, function(types) {
    document.getElementById('txnType').innerHTML = (types||[]).map(function(tt) { return '<option value="' + tt.id + '">' + tt.name + '</option>'; }).join('');
  });
  callAPI('GET', '/erp/cost-centers', null, function(ccs) {
    _txnCostCenters = ccs || [];
    var sel = document.getElementById('txnCC');
    if (sel) sel.innerHTML = '<option value="">'+t('tm.noCC')+'</option>' + _txnCostCenters.map(function(c) { return '<option value="' + c.id + '" data-name="' + (c.name||'') + '">' + (c.code||'') + ' — ' + (c.name||'') + '</option>'; }).join('');
  });
  callAPI('GET', '/erp/gl/accounts', null, function(list) {
    _txnAccounts = (list || []).filter(function(a) {
      var ids = {}; (list||[]).forEach(function(x) { if (x.parentId) ids[x.parentId] = true; });
      return !ids[a.id];
    });
  });
  callAPI('GET', '/workflow/eligible-users?sender=' + currentUser, null, function(users) {
    _txnEligibleUsers = users || [];
    var sel = document.getElementById('txnRecipient');
    if (sel) sel.innerHTML = '<option value="">'+t('tm.selectRecipient')+'</option>' + _txnEligibleUsers.map(function(u) { return '<option value="' + u.username + '">' + (u.fullName||u.username) + ' — ' + (u.positionName||'') + (u.branchName?' | '+u.branchName:'') + '</option>'; }).join('');
  });
  // Fill employee info
  document.getElementById('txnSenderName').value = empProfile ? (empProfile.fullName || currentUser) : currentUser;
  document.getElementById('txnJobTitle').value = empProfile ? (empProfile.job_title || empProfile.jobTitle || '') : '';
  document.getElementById('txnTitle').value = ''; document.getElementById('txnDesc').value = '';
  document.getElementById('txnAmount').value = '0'; document.getElementById('txnFile').value = '';
  document.getElementById('txnAccSearch').value = ''; document.getElementById('txnAccId').value = '';
  document.getElementById('txnAccName').value = '';
  document.getElementById('txnModal').classList.add('show');
}
function closeTxnModal() { document.getElementById('txnModal').classList.remove('show'); }

// Account search for transaction
window.txnSearchAccount = function(input) {
  var val = input.value.toLowerCase().trim();
  var dd = document.getElementById('txnAccDropdown');
  if (!val) { dd.style.display = 'none'; return; }
  var matches = _txnAccounts.filter(function(a) {
    return (a.code||'').indexOf(val) !== -1 || (a.nameAr||'').toLowerCase().indexOf(val) !== -1;
  }).slice(0, 8);
  if (!matches.length) {
    dd.innerHTML = '<div style="padding:10px;font-size:12px;color:#64748b;text-align:center;">'+t('tm.noResults')+' — <a href="#" onclick="txnAddNewAccount();return false;" style="color:#0ea5e9;font-weight:700;">'+t('tm.addNewAccount')+'</a></div>';
    dd.style.display = 'block'; return;
  }
  dd.innerHTML = matches.map(function(a) {
    return '<div style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f1f5f9;" onmousedown="txnPickAccount(\'' + a.id + '\',\'' + a.code + '\',\'' + (a.nameAr||'').replace(/'/g,'') + '\')">' +
      '<span style="font-weight:700;">' + a.code + '</span> — ' + (a.nameAr||'') + '</div>';
  }).join('');
  dd.style.display = 'block';
};

window.txnPickAccount = function(id, code, name) {
  document.getElementById('txnAccId').value = id;
  document.getElementById('txnAccSearch').value = code + ' — ' + name;
  document.getElementById('txnAccName').value = name;
  document.getElementById('txnAccDropdown').style.display = 'none';
};

window.txnAddNewAccount = function() {
  var name = prompt(t('tm.newAccountPrompt'));
  if (!name) return;
  callAPI('POST', '/erp/gl/accounts', { nameAr: name, type: 'expense', parentId: '5' }, function(r) {
    if (r && r.success) {
      toast(t('tm.accountAdded') + ': ' + name);
      document.getElementById('txnAccId').value = r.id || '';
      document.getElementById('txnAccSearch').value = name;
      document.getElementById('txnAccName').value = name;
      document.getElementById('txnAccDropdown').style.display = 'none';
    } else toast(r ? r.error : t('txn.failed'), true);
  });
};

function submitTxn() {
  var title = document.getElementById('txnTitle').value, typeId = document.getElementById('txnType').value;
  if (!title || !typeId) return toast(t('tm.titleRequired'), true);
  var ccSel = document.getElementById('txnCC');
  var impEl = document.getElementById('txnImportance');
  var data = {
    transactionTypeId: typeId, title: title,
    description: document.getElementById('txnDesc').value,
    amount: Number(document.getElementById('txnAmount').value) || 0,
    importance: impEl ? impEl.value : 'medium',
    username: currentUser,
    branchId: empProfile ? empProfile.branch_id : '',
    brandId: empProfile ? empProfile.brand_id : '',
    deptId: empProfile ? empProfile.department_id : '',
    accountId: document.getElementById('txnAccId').value || '',
    accountCode: (document.getElementById('txnAccSearch').value || '').split(' — ')[0] || '',
    accountName: document.getElementById('txnAccName').value || '',
    costCenterId: ccSel ? ccSel.value : '',
    costCenterName: ccSel && ccSel.value ? (ccSel.options[ccSel.selectedIndex].getAttribute('data-name') || '') : '',
    recipientUsername: (document.getElementById('txnRecipient') || {}).value || '',
    senderName: empProfile ? (empProfile.fullName || currentUser) : currentUser,
    senderPosition: empProfile ? (empProfile.job_title || empProfile.jobTitle || '') : ''
  };
  var f = document.getElementById('txnFile');
  if (f.files && f.files[0]) {
    if (f.files[0].size > 5242880) return toast(t('tm.fileLimit'), true);
    var r = new FileReader(); r.onload = function(e) { data.attachment = e.target.result; _doTxn(data); }; r.readAsDataURL(f.files[0]);
  } else _doTxn(data);
}
function _doTxn(data) {
  toast(t('tm.sending'));
  callAPI('POST', '/workflow/transactions', data, function(r, e) {
    if (e) return toast(t('login.error') + ': ' + e, true);
    if (r && r.success) { toast(t('tm.txnNumberCreated') + ': ' + (r.txnNumber||'')); closeTxnModal(); txnSwitchTab('out'); loadMyTransactions(); } else toast(r?r.error:t('txn.failed'), true);
  });
}
function viewMyTxn(id) {
  callAPI('GET', '/workflow/transactions/' + id, null, function(txn) {
    if (!txn || txn.error) return toast(t('txn.failed'), true);
    var sMap = { pending:t('txn.status.pending'), in_progress:t('txn.status.in_progress'), approved:t('txn.status.approved'), rejected:t('txn.status.rejected'), closed:t('txn.status.closed') };
    var sClr = {pending:'#f59e0b',in_progress:'#0ea5e9',approved:'#10b981',rejected:'#ef4444',closed:'#6b7280'};
    var aMap = { create:t('txn.act.create'), approve:t('txn.act.approve'), reject:t('txn.act.reject'), return:t('txn.act.return'), close:t('txn.act.close'), forward:t('txn.act.forward') };
    var aClr = {create:'#0ea5e9',approve:'#10b981',reject:'#ef4444',return:'#f59e0b',close:'#6b7280',forward:'#8b5cf6'};
    var aIcon = {create:'fa-plus-circle',approve:'fa-check-circle',reject:'fa-times-circle',return:'fa-undo',close:'fa-lock',forward:'fa-share'};
    var sc = sClr[txn.status]||'#6b7280';

    var ic = _impColors[txn.importance]||'#6b7280';
    var il = _impLabels[txn.importance]||txn.importance;
    var h = '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
      '<div style="flex:1;padding:8px;border-radius:10px;background:'+sc+'15;border:1px solid '+sc+'30;text-align:center;"><span style="font-size:11px;font-weight:800;color:'+sc+';">'+(sMap[txn.status]||txn.status)+'</span></div>' +
      '<div style="flex:1;padding:8px;border-radius:10px;background:'+ic+'15;border:1px solid '+ic+'40;text-align:center;"><span style="font-size:11px;font-weight:800;color:'+ic+';"><i class="fas fa-circle" style="font-size:6px;margin-left:4px;"></i>'+il+'</span></div>' +
    '</div>';

    // Workflow path
    if (txn.workflowPath && txn.workflowPath.length) {
      h += '<div style="padding:8px;border-radius:10px;background:#f8fafc;border:1px solid #e5e7eb;margin-bottom:10px;">' +
        '<div style="font-size:10px;color:#64748b;font-weight:800;margin-bottom:6px;"><i class="fas fa-route" style="color:#8b5cf6;"></i> '+t('txn.pathTitle')+'</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center;">';
      txn.workflowPath.forEach(function(s, i) {
        var clr = s.isCurrent ? '#0ea5e9' : (s.isPast ? '#10b981' : '#94a3b8');
        var bg  = s.isCurrent ? '#e0f2fe' : (s.isPast ? '#dcfce7' : '#f1f5f9');
        h += '<div style="padding:4px 8px;border-radius:8px;background:'+bg+';border:1px solid '+clr+';font-size:9px;color:'+clr+';font-weight:800;"><i class="fas '+(s.isCurrent?'fa-arrow-right':s.isPast?'fa-check':'fa-circle')+'" style="font-size:7px;margin-left:3px;"></i>'+s.stepName+'</div>';
        if (i < txn.workflowPath.length - 1) h += '<i class="fas '+(currentLang==='en'?'fa-chevron-right':'fa-chevron-left')+'" style="color:#cbd5e1;font-size:8px;"></i>';
      });
      h += '</div></div>';
    }

    // Info grid
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">';
    h += '<div class="pf"><span>'+t('txn.numberLabel')+'</span><b style="font-family:monospace;font-size:10px;">'+(txn.txnNumber||'')+'</b></div>';
    h += '<div class="pf"><span>'+t('txn.typeLabel')+'</span><b>'+(txn.typeName||'')+'</b></div>';
    h += '<div class="pf"><span>'+t('tm.amount')+'</span><b style="color:#0ea5e9;">'+Number(txn.amount||0).toFixed(2)+'</b></div>';
    h += '<div class="pf"><span>'+t('txn.senderLabel')+'</span><b>'+(txn.senderName||txn.createdBy||'')+'</b></div>';
    if (txn.branchName) h += '<div class="pf"><span>'+t('txn.branchLabel')+'</span><b>'+txn.branchName+'</b></div>';
    if (txn.deptName) h += '<div class="pf"><span>'+t('txn.deptLabel')+'</span><b>'+txn.deptName+'</b></div>';
    if (txn.currentAssignee) h += '<div class="pf"><span>'+t('txn.responsible')+'</span><b style="color:#1e40af;">'+txn.currentAssignee+(txn.currentRoleName?' <small style="color:#8b5cf6;">('+txn.currentRoleName+')</small>':'')+'</b></div>';
    else if (txn.currentRoleName) h += '<div class="pf"><span>'+t('txn.currentRoleLabel')+'</span><b style="color:#8b5cf6;">'+txn.currentRoleName+'</b></div>';
    if (txn.senderPosition) h += '<div class="pf"><span>'+t('txn.positionLabel')+'</span><b>'+txn.senderPosition+'</b></div>';
    if (txn.accountName) h += '<div class="pf"><span>'+t('txn.accountLabel')+'</span><b>'+(txn.accountCode||'')+' — '+txn.accountName+'</b></div>';
    if (txn.costCenterName) h += '<div class="pf"><span>'+t('txn.costCenterLabel')+'</span><b>'+txn.costCenterName+'</b></div>';
    h += '</div>';

    if (txn.description) h += '<div style="padding:8px 10px;border-radius:8px;background:#f8fafc;font-size:12px;color:#475569;margin-bottom:10px;">'+txn.description+'</div>';
    if (txn.attachment && txn.attachment.startsWith && txn.attachment.startsWith('data:')) h += '<a href="'+txn.attachment+'" download style="display:inline-flex;align-items:center;gap:4px;color:#0ea5e9;font-size:12px;font-weight:700;margin-bottom:10px;"><i class="fas fa-download"></i> تحميل المرفق</a>';

    // Timeline
    if (txn.logs && txn.logs.length) {
      h += '<div style="margin-top:10px;"><div style="font-size:13px;font-weight:800;color:#1e293b;margin-bottom:8px;"><i class="fas fa-route" style="color:#0ea5e9;margin-left:4px;"></i> سير المعاملة</div>';
      txn.logs.forEach(function(l, i) {
        var c = aClr[l.actionType]||'#6b7280';
        var icon = aIcon[l.actionType]||'fa-circle';
        var dt = l.createdAt ? new Date(l.createdAt).toLocaleString('ar-SA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
        var isLast = i === txn.logs.length - 1;
        h += '<div style="display:flex;gap:10px;position:relative;">';
        // Timeline line + dot
        h += '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">';
        h += '<div style="width:28px;height:28px;border-radius:50%;background:'+c+'18;display:flex;align-items:center;justify-content:center;"><i class="fas '+icon+'" style="font-size:12px;color:'+c+';"></i></div>';
        if (!isLast) h += '<div style="width:2px;flex:1;background:'+c+'30;min-height:20px;"></div>';
        h += '</div>';
        // Content
        h += '<div style="flex:1;padding-bottom:'+(isLast?'0':'12')+'px;">';
        h += '<div style="font-size:12px;font-weight:800;color:'+c+';">'+(aMap[l.actionType]||l.actionType)+'</div>';
        h += '<div style="font-size:11px;color:#64748b;">'+(l.actionBy||'')+(l.positionName?' — <span style="color:#1e40af;font-weight:700;">'+l.positionName+'</span>':'')+'</div>';
        if (l.note) h += '<div style="font-size:11px;color:#334155;margin-top:2px;padding:4px 8px;border-radius:6px;background:#f1f5f9;">'+l.note+'</div>';
        if (l.attachment && l.attachment.startsWith && l.attachment.startsWith('data:')) h += '<a href="'+l.attachment+'" download style="font-size:10px;color:#0ea5e9;"><i class="fas fa-paperclip"></i> مرفق</a>';
        h += '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">'+dt+'</div>';
        h += '</div></div>';
      });
      h += '</div>';
    }

    document.getElementById('txnDetailTitle').textContent = txn.txnNumber||'';
    document.getElementById('txnDetailBody').innerHTML = h;
    document.getElementById('txnDetailModal').classList.add('show');
  });
}
function closeTxnDetail() { document.getElementById('txnDetailModal').classList.remove('show'); }
