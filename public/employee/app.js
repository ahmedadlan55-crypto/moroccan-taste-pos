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
    // V3.1 — attendance section i18n
    'att.history': 'سجل الحضور',
    'att.month': 'الشهر',
    'att.dailyDetails': 'التفاصيل اليومية',
    'att.present': 'حاضر',
    'att.late': 'متأخر',
    'att.absent': 'غياب',
    'att.leave': 'إجازة',
    'att.weekend': 'عطلة',
    'att.partial': 'دخول بدون انصراف',
    'att.holiday': 'عطلة رسمية',
    'att.future': 'لم يأت بعد',
    'att.daysCount': '{n} يوم',
    'att.noRecords': 'لا توجد سجلات',
    'att.noData': 'لا توجد بيانات',
    'period.thisWeek': 'هذا الأسبوع',
    'period.thisMonth': 'هذا الشهر',
    'period.lastMonth': 'الشهر الماضي',
    'period.last30': 'آخر 30 يوم',
    'period.last90': 'آخر 90 يوم',
    'period.custom': 'فترة مخصصة',
    // Day-of-week short labels (Sat=س, Sun=ح, Mon=ن, Tue=ث, Wed=ر, Thu=خ, Fri=ج)
    'dow.sat': 'س', 'dow.sun': 'ح', 'dow.mon': 'ن', 'dow.tue': 'ث',
    'dow.wed': 'ر', 'dow.thu': 'خ', 'dow.fri': 'ج',
    // Transaction view dynamic labels
    'txn.action.create': 'إنشاء',
    'txn.action.approve': 'موافقة',
    'txn.action.reject': 'رفض',
    'txn.action.return': 'إرجاع',
    'txn.action.close': 'إقفال',
    'txn.action.forward': 'تحويل',
    'txn.attached': 'مرفق',
    'txn.viewAttach': 'عرض',
    'txn.downloadAttach': 'تنزيل',
    'txn.repliesTitle': 'الردود والمناقشة',
    'txn.replyPlaceholder': 'اكتب رداً أو ملاحظة...',
    'txn.attachFile': 'إرفاق ملف',
    'txn.sendReply': 'إرسال الرد',
    'txn.replyCount': '{n} رد',
    'txn.noReplies': 'لا توجد ردود بعد — كن أول من يضيف رداً.',
    'txn.replyDeptHeader': 'رد القسم',
    'txn.fromDept': 'مرفق من',
    'txn.workflowLog': 'سجل الإجراءات (ماذا قال كل قسم)',
    'txn.recipients': 'المستلمون',
    'txn.timeline': 'سير المعاملة',
    'txn.showWorkflow': 'عرض سير المعاملة',
    'txn.hideWorkflow': 'إخفاء سير المعاملة',
    'txn.contentLabel': 'محتوى المعاملة',
    'txn.noContent': 'لا يوجد محتوى',
    'txn.downloadAttachOriginal': 'تحميل المرفق الأصلي',
    'txn.viewAttachOriginal': 'عرض المرفق',
    'txn.sender': 'المُرسِل',
    'txn.status_label': 'الحالة',
    'txn.importance_label': 'الأهمية',
    'txn.stoppedAt': 'المعاملة متوقفة الآن عند',
    'txn.stoppedStep': 'الخطوة:',
    'txn.returnedToSender': 'تم إرجاع المعاملة للمرسل',
    'txn.returnedNeedsFix': 'يحتاج المرسل لتصحيح وإعادة الإرسال',
    'txn.returnedToYou': 'تم إرجاع معاملتك للتعديل',
    'txn.returnedHeader': 'سبب الإرجاع — يرجى التعديل ثم إعادة الإرسال',
    'txn.returnedBy': 'المُرجِع:',
    'txn.returnedHint': 'اضغط زر "تعديل وإعادة الإرسال" أدناه لتصحيح المعاملة وإرسالها مرة أخرى.',
    'txn.editAndResubmit': 'تعديل وإعادة الإرسال',
    'txn.approvedTransaction': 'تمت الموافقة على المعاملة',
    'txn.closedTransaction': 'تم إقفال المعاملة',
    'txn.rejectedTransaction': 'تم رفض المعاملة',
    'txn.amount': 'المبلغ',
    'txn.failed': 'فشلت العملية',
    'txn.notFound': 'المعاملة غير موجودة',
    'txn.passedCEO': 'مرّت على الرئيس التنفيذي',
    'txn.passedCEOLabel': 'معتمدة من الإدارة العليا',
    'txn.me': 'أنا',
    'role.admin': 'أدمن',
    'role.manager': 'مدير',
    'role.cashier': 'كاشير',
    'role.custody': 'عهدة',
    'role.finance': 'مالية',
    'role.hr': 'موارد بشرية',
    'role.inventory': 'مخزون',
    'role.purchasing': 'مشتريات',
    'role.employee': 'موظف',
    'role.user': 'مستخدم',
    'common.empty.home': 'لا توجد سجلات بعد',
    'common.empty.att': 'لا توجد سجلات',
    'common.empty.requests': 'لا توجد طلبات',
    'common.empty.balances': 'لا توجد أرصدة',
    'common.empty.txns': 'لا توجد معاملات',
    'common.empty.incoming': 'لا توجد معاملات بانتظارك',
    'common.done': 'تم',
    'common.refreshed': 'تم التحديث',
    'common.cancelBtn': 'إلغاء',
    'common.closeBtn': 'إغلاق',
    'common.network': 'شبكة',
    'common.browser': 'متصفح',
    'common.errorPrefix': 'خطأ: ',
    'common.connError': 'خطأ في الاتصال: ',
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
    'txn.rejectReason': 'سبب الرفض',
    'txn.returnReason': 'سبب الإرجاع',
    'txn.noteOptional': 'ملاحظة (اختياري)',
    'txn.notePlaceholder': 'اكتب تعليقك هنا...',
    'txn.notePlaceholderRequired': 'اكتب سبب القرار والملاحظات التي تريد إبلاغ المرسل بها...',
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
    'txn.status.created': 'جديدة',
    'txn.status.in_progress': 'قيد الإجراء',
    'txn.status.replied': 'تم الرد',
    'txn.status.approved': 'معتمدة',
    'txn.status.rejected': 'مرفوضة',
    'txn.status.returned': 'مرجعة للتعديل',
    'txn.status.closed': 'مغلقة',
    'txn.status.draft': 'مسودة',
    // V4 — counter + nav badges
    'counter.pending': 'بانتظار ردّك',
    'counter.returned': 'مرجعة لك',
    'counter.overdue': 'متأخرة',
    'counter.unread': 'إشعارات',
    'counter.total': 'الإجمالي',
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
    'txn.content': 'محتوى المعاملة',
    'txn.recipientsTitle': 'الجهات الصادر إليها',
    'txn.needsResponse': 'يحتاج رد',
    'txn.workflowPath': 'سير المعاملة',
    'txn.attachmentLbl': 'مرفق',
    'txn.secrecyContent': 'سرية المحتوى',
    'txn.secrecyAttachments': 'سرية المرفقات',
    'txn.sec.normal': 'عادي',
    'txn.sec.confidential': 'سري',
    'txn.sec.secret': 'سري للغاية',
    'txn.sec.top_secret': 'سري جداً للغاية',
    'txn.clock.locationFail': 'يجب السماح بالموقع',
    'txn.clock.regFail': 'فشل التسجيل',
    'rpName': 'بوابة الموظف',
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
    // V3.1 — attendance section i18n
    'att.history': 'Attendance History',
    'att.month': 'Month',
    'att.dailyDetails': 'Daily Details',
    'att.present': 'Present',
    'att.late': 'Late',
    'att.absent': 'Absent',
    'att.leave': 'On Leave',
    'att.weekend': 'Weekend',
    'att.partial': 'Clock-in only (no clock-out)',
    'att.holiday': 'Public Holiday',
    'att.future': 'Upcoming',
    'att.daysCount': '{n} days',
    'att.noRecords': 'No records',
    'att.noData': 'No data',
    'period.thisWeek': 'This Week',
    'period.thisMonth': 'This Month',
    'period.lastMonth': 'Last Month',
    'period.last30': 'Last 30 days',
    'period.last90': 'Last 90 days',
    'period.custom': 'Custom range',
    'dow.sat': 'Sa', 'dow.sun': 'Su', 'dow.mon': 'Mo', 'dow.tue': 'Tu',
    'dow.wed': 'We', 'dow.thu': 'Th', 'dow.fri': 'Fr',
    'txn.action.create': 'Created',
    'txn.action.approve': 'Approved',
    'txn.action.reject': 'Rejected',
    'txn.action.return': 'Returned',
    'txn.action.close': 'Closed',
    'txn.action.forward': 'Forwarded',
    'txn.attached': 'Attachment',
    'txn.viewAttach': 'View',
    'txn.downloadAttach': 'Download',
    'txn.repliesTitle': 'Replies & Discussion',
    'txn.replyPlaceholder': 'Write a reply or note...',
    'txn.attachFile': 'Attach file',
    'txn.sendReply': 'Send Reply',
    'txn.replyCount': '{n} replies',
    'txn.noReplies': 'No replies yet — be the first to add one.',
    'txn.replyDeptHeader': 'Department reply',
    'txn.fromDept': 'Attached by',
    'txn.workflowLog': 'Action log (what each department said)',
    'txn.recipients': 'Recipients',
    'txn.timeline': 'Workflow timeline',
    'txn.showWorkflow': 'Show workflow',
    'txn.hideWorkflow': 'Hide workflow',
    'txn.contentLabel': 'Transaction content',
    'txn.noContent': 'No content',
    'txn.downloadAttachOriginal': 'Download original attachment',
    'txn.viewAttachOriginal': 'View attachment',
    'txn.sender': 'Sender',
    'txn.status_label': 'Status',
    'txn.importance_label': 'Importance',
    'txn.stoppedAt': 'Currently waiting at',
    'txn.stoppedStep': 'Step:',
    'txn.returnedToSender': 'Transaction returned to sender',
    'txn.returnedNeedsFix': 'Sender needs to fix and resubmit',
    'txn.returnedToYou': 'Your transaction was returned for editing',
    'txn.returnedHeader': 'Return reason — please edit then resubmit',
    'txn.returnedBy': 'Returned by:',
    'txn.returnedHint': 'Tap "Edit and Resubmit" below to fix and send again.',
    'txn.editAndResubmit': 'Edit and Resubmit',
    'txn.approvedTransaction': 'Transaction approved',
    'txn.closedTransaction': 'Transaction closed',
    'txn.rejectedTransaction': 'Transaction rejected',
    'txn.amount': 'Amount',
    'txn.failed': 'Operation failed',
    'txn.notFound': 'Transaction not found',
    'txn.passedCEO': 'Passed through the CEO',
    'txn.passedCEOLabel': 'Approved by Top Management',
    'txn.me': 'Me',
    'role.admin': 'Admin',
    'role.manager': 'Manager',
    'role.cashier': 'Cashier',
    'role.custody': 'Custody',
    'role.finance': 'Finance',
    'role.hr': 'HR',
    'role.inventory': 'Inventory',
    'role.purchasing': 'Purchasing',
    'role.employee': 'Employee',
    'role.user': 'User',
    'common.empty.home': 'No records yet',
    'common.empty.att': 'No records',
    'common.empty.requests': 'No requests',
    'common.empty.balances': 'No balances',
    'common.empty.txns': 'No transactions',
    'common.empty.incoming': 'No transactions awaiting you',
    'common.done': 'Done',
    'common.refreshed': 'Refreshed',
    'common.cancelBtn': 'Cancel',
    'common.closeBtn': 'Close',
    'common.network': 'network',
    'common.browser': 'Browser',
    'common.errorPrefix': 'Error: ',
    'common.connError': 'Connection error: ',
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
    'txn.rejectReason': 'Rejection reason',
    'txn.returnReason': 'Return reason',
    'txn.noteOptional': 'Note (optional)',
    'txn.notePlaceholder': 'Write your comment here...',
    'txn.notePlaceholderRequired': 'Write the reason and notes you want to share with the sender...',
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
    'txn.status.created': 'New',
    'txn.status.in_progress': 'In Progress',
    'txn.status.replied': 'Replied',
    'txn.status.approved': 'Approved',
    'txn.status.rejected': 'Rejected',
    'txn.status.returned': 'Returned for Edit',
    'txn.status.closed': 'Closed',
    'txn.status.draft': 'Draft',
    // V4 — counter + nav badges
    'counter.pending': 'Awaiting Reply',
    'counter.returned': 'Returned to You',
    'counter.overdue': 'Overdue',
    'counter.unread': 'Notifications',
    'counter.total': 'Total',
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
    'txn.content': 'Transaction content',
    'txn.recipientsTitle': 'Recipients',
    'txn.needsResponse': 'needs response',
    'txn.workflowPath': 'Workflow progress',
    'txn.attachmentLbl': 'attachment',
    'txn.secrecyContent': 'Content secrecy',
    'txn.secrecyAttachments': 'Attachments secrecy',
    'txn.sec.normal': 'Normal',
    'txn.sec.confidential': 'Confidential',
    'txn.sec.secret': 'Secret',
    'txn.sec.top_secret': 'Top Secret',
    'txn.clock.locationFail': 'Location permission required',
    'txn.clock.regFail': 'Registration failed',
    'rpName': 'Employee Portal',
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
  // Browser tab title
  try { document.title = t('login.title'); } catch(e) {}
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

// ═══════════════════════════════════════════════════════════════════
// V4 — Counters refresh + SSE live notifications
// ═══════════════════════════════════════════════════════════════════
window._empCounters = {};
window.empRefreshCounters = function() {
  if (!currentUser) return;
  callAPI('GET', '/counters/me?username=' + encodeURIComponent(currentUser), null, function(c) {
    if (!c || c.error) return;
    window._empCounters = c;
    var pending = (c.inbox && c.inbox.pendingAction) || 0;
    var returned = (c.inbox && c.inbox.returnedToMe) || 0;
    var total = pending + returned;
    var badge = document.getElementById('navTxnBadge');
    if (badge) {
      if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  });
};

// Auto-refresh every 30s + immediately after login
setInterval(function() { try { empRefreshCounters(); } catch(_) {} }, 30000);

// SSE live inbox
window._empSSE = null;
window.empStartLiveInbox = function() {
  if (window._empSSE || !currentUser) return;
  if (typeof EventSource === 'undefined') return;
  try {
    var token = localStorage.getItem('emp_token') || localStorage.getItem('pos_token') || '';
    var sse = new EventSource('/api/sse/inbox?username=' + encodeURIComponent(currentUser));
    sse.addEventListener('notification', function(ev) {
      try {
        var data = JSON.parse(ev.data);
        var sevColor = { info:'#0ea5e9', success:'#16a34a', warning:'#f59e0b', danger:'#dc2626' };
        var color = sevColor[data.severity] || '#0ea5e9';
        var t = document.createElement('div');
        t.style.cssText = 'position:fixed;top:70px;inset-inline-end:14px;z-index:99999;background:#fff;border-inline-start:4px solid '+color+';box-shadow:0 8px 24px rgba(0,0,0,.15);border-radius:12px;padding:12px 14px;max-width:300px;font-family:inherit;cursor:pointer;animation:slideInRight 0.3s ease;';
        t.innerHTML = '<div style="font-weight:900;font-size:13px;color:#0f172a;margin-bottom:3px;">' + (data.title || '') + '</div>' +
                      '<div style="font-size:11px;color:#64748b;line-height:1.5;">' + (data.body || '') + '</div>';
        if (data.linkType === 'transaction' && data.linkId) {
          t.onclick = function() { t.remove(); navTo('txn', null); setTimeout(function(){ if (typeof viewMyTxn === 'function') viewMyTxn(data.linkId); }, 300); };
        }
        document.body.appendChild(t);
        setTimeout(function(){ t.style.transition = 'opacity 0.4s'; t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 400); }, 6000);
        empRefreshCounters();
      } catch(e) {}
    });
    sse.onerror = function() {
      sse.close();
      window._empSSE = null;
      setTimeout(function(){ empStartLiveInbox(); }, 10000);
    };
    window._empSSE = sse;
  } catch(e) { console.warn('SSE init:', e); }
};


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
    // V5-UX: graceful token-expiry — show banner + delay reload by 1.5s
    if (xhr.status === 401) {
      try {
        if (!window._sessionExpiredHandled) {
          window._sessionExpiredHandled = true;
          var banner = document.createElement('div');
          banner.setAttribute('role', 'alert');
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;padding:14px 16px;text-align:center;font-weight:800;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
          banner.innerHTML = '⚠ انتهت الجلسة — جاري إعادة التوجيه لتسجيل الدخول...';
          document.body.appendChild(banner);
          try { sessionStorage.setItem('emp_relogin_required', '1'); } catch(_){}
          setTimeout(function(){ doLogout(); }, 1500);
        }
      } catch(_e) { doLogout(); }
      return;
    }
    // Step 1: parse the response (may throw on invalid JSON)
    var parsed = null, parseErr = null;
    try { parsed = JSON.parse(xhr.responseText); }
    catch(e) { parseErr = 'HTTP ' + xhr.status; }
    // Step 2: invoke the callback OUTSIDE the parse try/catch so that
    // bugs inside the caller's code don't masquerade as network errors.
    // Any crash inside cb is logged but swallowed (user sees no spurious toast).
    try { cb(parseErr ? null : parsed, parseErr); }
    catch(cbErr) {
      try { console.error('callAPI callback crashed for', method, path, cbErr); } catch(_) {}
    }
  };
  xhr.onerror = function() { try { cb(null, t('common.network')); } catch(_) {} };
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
  var tEl = document.getElementById('toast');
  if (!tEl) return;
  tEl.textContent = msg;
  tEl.className = 'toast show ' + (err ? 'err' : 'ok');
  // V5-A11y: announce errors loudly to screen readers (assertive),
  // success messages politely (polite). role=status established in HTML.
  tEl.setAttribute('role', err ? 'alert' : 'status');
  tEl.setAttribute('aria-live', err ? 'assertive' : 'polite');
  tEl.setAttribute('aria-atomic', 'true');
  setTimeout(function() { tEl.className = 'toast'; }, 3500);
}
// V5-FIX: glassToast was referenced ~20 places but never defined → silent UI failure.
// Alias to toast() so all error/success messages actually appear.
window.glassToast = function(msg, err){ return toast(msg, err); };

// V5-OFFLINE: lightweight outbound queue for replies/actions when network drops.
// On 'online' event, drains queued items and POSTs them with the original idempotency key.
// Server's idempotency table dedupes if the original already landed.
window._empOutboxKey = 'emp_outbox_v1';
function _empOutboxRead(){
  try { return JSON.parse(localStorage.getItem(window._empOutboxKey) || '[]'); }
  catch(_) { return []; }
}
function _empOutboxWrite(arr){
  try { localStorage.setItem(window._empOutboxKey, JSON.stringify(arr.slice(-50))); } catch(_) {}
}
window._empOutboxQueue = function(item){
  // item: { url, body, headers, savedAt, label }
  var arr = _empOutboxRead();
  arr.push(Object.assign({ savedAt: Date.now() }, item));
  _empOutboxWrite(arr);
  toast('💾 محفوظ — سيُرسل تلقائياً عند رجوع الإنترنت', false);
};
window._empOutboxDrain = function(){
  var arr = _empOutboxRead();
  if (!arr.length) return;
  var token = localStorage.getItem('pos_token') || localStorage.getItem('emp_token');
  if (!token) return;
  var remaining = [];
  var doneCount = 0;
  var pending = arr.length;
  arr.forEach(function(it){
    var headers = Object.assign({
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }, it.headers || {});
    fetch(it.url, { method: 'POST', headers: headers, body: it.body })
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(r){ if (r && r.success) doneCount++; else remaining.push(it); })
      .catch(function(){ remaining.push(it); })
      .finally(function(){
        pending--;
        if (pending === 0) {
          _empOutboxWrite(remaining);
          if (doneCount > 0) toast('✓ أُرسلت ' + doneCount + ' عملية مؤجلة', false);
          if (remaining.length > 0) toast('⚠ تبقّى ' + remaining.length + ' عملية بحاجة لإعادة', true);
        }
      });
  });
};
window.addEventListener('online', function(){
  setTimeout(function(){ try { window._empOutboxDrain(); } catch(_) {} }, 1500);
});
// Drain on app start in case there's pending from a previous session
setTimeout(function(){ if (navigator.onLine) try { window._empOutboxDrain(); } catch(_) {} }, 4000);

// ─── Login ───
document.addEventListener('keydown', function(e) { if (e.key==='Enter' && document.getElementById('loginPage') && document.getElementById('loginPage').style.display !== 'none') doLogin(); });

function doLogin() {
  var u = document.getElementById('lu').value, p = document.getElementById('lp').value;
  if (!u || !p) return toast(t('login.fill'), true);
  var btn = document.getElementById('lbtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  callAPI('POST', '/auth/login', {username:u, password:p}, function(r, err) {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> ' + t('login.btn');
    if (err) return toast(t('common.connError') + err, true);
    if (r && r.success && r.token) {
      localStorage.setItem('emp_token', r.token);
      localStorage.setItem('emp_session', JSON.stringify({username:r.username,role:r.role,brandId:r.brandId||'',branchId:r.branchId||''}));
      // V5.4.1: persist for TxnView assignee-lock logic
      try {
        localStorage.setItem('emp_role', r.role || '');
        localStorage.setItem('emp_username', r.username || '');
      } catch(_){}
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
  document.querySelectorAll('.nt').forEach(function(t){t.classList.remove('active');});
  var pageEl = document.getElementById('pg'+pg);
  if (pageEl) pageEl.classList.add('active');
  if (el) el.classList.add('active');
  if (pg==='att') loadAttPage();
  if (pg==='txn') { txnSwitchTab('inc'); loadIncomingTxns(); loadMyTransactions(); }
  if (pg==='leave') loadLeavePage();
  if (pg==='me') loadProfilePage();
  if (pg==='home') loadHomeData();
  if (pg==='hours') loadHoursPage();
}

// ═══════════════════════════════════════
// HOME
// ═══════════════════════════════════════
function loadHomeData() {
  // V4: refresh counters + start SSE on home load (idempotent)
  try { empRefreshCounters(); } catch(_) {}
  try { empStartLiveInbox(); } catch(_) {}
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
        rp: { name: t('rpName') },
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
  else data.deviceName = t('common.browser');

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
    if (err) return toast(t('common.errorPrefix') + err, true);
    if (r && r.success) { toast(r.message); loadHomeData(); }
    else toast(r ? r.error : t('txn.clock.regFail'), true);
  });
}

// ═══════════════════════════════════════
// ATTENDANCE PAGE
// ═══════════════════════════════════════
// Attendance state + presets
window._attState = { preset: 'thismonth', from: '', to: '' };
function _attResolveRange(preset) {
  var now = new Date();
  var ymd = function(d){ return d.toISOString().slice(0,10); };
  if (preset === 'thisweek') { var d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); return { from: ymd(d), to: ymd(now) }; }
  if (preset === 'thismonth') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (preset === 'lastmonth') { var s = new Date(now.getFullYear(), now.getMonth() - 1, 1); var e = new Date(now.getFullYear(), now.getMonth(), 0); return { from: ymd(s), to: ymd(e) }; }
  if (preset === 'last30') { var d = new Date(now); d.setDate(d.getDate() - 29); return { from: ymd(d), to: ymd(now) }; }
  return { from: ymd(now), to: ymd(now) };
}
window.attSetPreset = function(p) {
  window._attState.preset = p;
  document.querySelectorAll('[data-attp]').forEach(function(el){ el.classList.toggle('active', el.getAttribute('data-attp') === p); });
  loadAttPage();
};

function loadAttPage() {
  var c = document.getElementById('attList');
  if (c) c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  // V3.1: render day-of-week headers in current language so EN switch works
  var dowEl = document.getElementById('attCalDow');
  if (dowEl) {
    dowEl.innerHTML = ['dow.sat','dow.sun','dow.mon','dow.tue','dow.wed','dow.thu','dow.fri']
      .map(function(k){ return '<span>' + t(k) + '</span>'; }).join('');
  }
  var range = _attResolveRange(window._attState.preset || 'thismonth');
  window._attState.from = range.from;
  window._attState.to = range.to;
  var lbl = document.getElementById('attRangeLabel');
  if (lbl) lbl.textContent = range.from + ' → ' + range.to;

  callAPI('GET', '/hr/my-attendance-full?username=' + encodeURIComponent(currentUser) + '&from=' + range.from + '&to=' + range.to, null, function(d) {
    if (!d || d.success === false) {
      var msg = (d && d.error) || t('att.noData') || 'فشل تحميل البيانات';
      if (c) c.innerHTML = '<p class="empty" style="color:#ef4444;"><i class="fas fa-triangle-exclamation"></i> ' + msg + '</p>';
      // Clear stats
      var statsEl = document.getElementById('attStats');
      if (statsEl) statsEl.innerHTML = '';
      return;
    }
    _attRender(d);
  });
}

function _attFmt(v, dig) { return Number(v||0).toLocaleString('en', { minimumFractionDigits: dig!=null?dig:1, maximumFractionDigits: dig!=null?dig:1 }); }

function _attRender(d) {
  var tot = d.totals || {};
  // KPI strip — 4 tiles, fully translated
  var statsEl = document.getElementById('attStats');
  if (statsEl) {
    statsEl.innerHTML =
      '<div class="st"><i class="fas fa-check" style="color:#10b981;background:#ecfdf5;"></i><b>' + (tot.present||0) + '</b><span>' + t('att.present') + '</span></div>' +
      '<div class="st"><i class="fas fa-times" style="color:#ef4444;background:#fef2f2;"></i><b>' + (tot.absent||0) + '</b><span>' + t('att.absent') + '</span></div>' +
      '<div class="st"><i class="fas fa-clock" style="color:#0ea5e9;background:#e0f2fe;"></i><b>' + _attFmt(tot.workingHours||0) + '</b><span>' + t('att.workHours') + '</span></div>' +
      '<div class="st"><i class="fas fa-exclamation" style="color:#f59e0b;background:#fffbeb;"></i><b>' + _attFmt(tot.lateHours||0) + '</b><span>' + t('att.lateHours') + '</span></div>';
  }

  // Days count — translated
  var dc = document.getElementById('attDaysCount');
  if (dc) dc.textContent = t('att.daysCount').replace('{n}', (d.days||[]).length);

  // Calendar grid (only the FIRST month in the range to keep it readable)
  _attRenderCalendar(d);

  // Daily list
  var c = document.getElementById('attList');
  if (!c) return;
  if (!d.days || !d.days.length) { c.innerHTML = '<p class="empty">' + t('att.noRecords') + '</p>'; return; }
  // Render newest first
  var rows = d.days.slice().reverse().filter(function(r){ return r.status !== 'future'; });
  c.innerHTML = rows.map(_attRowHtml).join('');
}

function _attRowHtml(r) {
  // V3.1: status labels are now i18n keys so they switch with language
  var statusInfo = {
    present: { icon:'fa-check', label: t('att.present') },
    late:    { icon:'fa-exclamation', label: t('att.late') },
    absent:  { icon:'fa-user-xmark', label: t('att.absent') },
    leave:   { icon:'fa-umbrella-beach', label: t('att.leave') },
    weekend: { icon:'fa-mug-hot', label: t('att.weekend') },
    holiday: { icon:'fa-gift', label: t('att.holiday') },
    partial: { icon:'fa-hourglass-half', label: t('att.partial') }
  };
  var stKey = r.status === 'present' && r.lateMinutes > 0 ? 'late' : r.status;
  var info = statusInfo[stKey] || statusInfo.present;
  // Date locale follows current language
  var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA-u-nu-latn';
  var dateLbl = r.date ? new Date(r.date).toLocaleDateString(localeCode, { weekday:'short', day:'2-digit', month:'2-digit' }) : '—';
  var hrShort = currentLang === 'en' ? 'h' : 'س';
  var minShort = currentLang === 'en' ? 'min' : 'د';
  var timesHtml = '';
  if (r.clockIn) {
    var ci = new Date(r.clockIn).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    var co = r.clockOut ? new Date(r.clockOut).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}) : '—';
    timesHtml = '<i class="fas fa-clock" style="color:#94a3b8;font-size:9px;margin-inline-end:3px;"></i>' + ci + ' ← ' + co + ' · ' + _attFmt(r.totalHours) + ' ' + hrShort;
  } else if (r.status === 'absent') {
    timesHtml = '<i class="fas fa-user-xmark" style="color:#ef4444;font-size:9px;margin-inline-end:3px;"></i>' + t('att.absent');
  } else if (r.status === 'weekend') {
    timesHtml = '<i class="fas fa-bed" style="color:#94a3b8;font-size:9px;margin-inline-end:3px;"></i>' + t('att.weekend');
  } else if (r.status === 'leave') {
    timesHtml = '<i class="fas fa-umbrella-beach" style="color:#1e40af;font-size:9px;margin-inline-end:3px;"></i>' + (r.notes || t('att.leave'));
  }
  var pillsHtml = '';
  if (r.lateMinutes > 0)     pillsHtml += '<span class="att-status-pill late"><i class="fas fa-arrow-down"></i> -' + r.lateMinutes + ' ' + minShort + '</span>';
  if (r.overtimeMinutes > 0) pillsHtml += '<span class="att-status-pill present"><i class="fas fa-arrow-up"></i> +' + r.overtimeMinutes + ' ' + minShort + '</span>';
  if (!pillsHtml) pillsHtml = '<span class="att-status-pill ' + stKey + '">' + info.label + '</span>';
  return '<div class="att-row">' +
    '<div class="att-row-icon ' + stKey + '"><i class="fas ' + info.icon + '"></i></div>' +
    '<div class="att-row-main"><div class="att-row-date">' + dateLbl + '</div><div class="att-row-meta">' + timesHtml + '</div></div>' +
    '<div class="att-row-vals">' + pillsHtml + '</div>' +
  '</div>';
}

function _attRenderCalendar(d) {
  var grid = document.getElementById('attCalendarGrid');
  var monthLbl = document.getElementById('attCalendarMonth');
  if (!grid) return;
  if (!d.days || !d.days.length) { grid.innerHTML = '<div class="empty">' + t('att.noData') + '</div>'; return; }
  // Pick the month containing the LAST day of the range
  var anchor = new Date(d.days[d.days.length - 1].date);
  var year = anchor.getFullYear();
  var month = anchor.getMonth(); // 0-indexed
  // V3.1: month label locale follows current language
  var calLocale = currentLang === 'en' ? 'en-US' : 'ar-SA-u-nu-latn';
  if (monthLbl) monthLbl.textContent = anchor.toLocaleDateString(calLocale, { month:'long', year:'numeric' });
  // Build day-of-month → day data lookup for days in the active month within the range
  var dayMap = {};
  d.days.forEach(function(r) {
    var dt = new Date(r.date);
    if (dt.getFullYear() === year && dt.getMonth() === month) dayMap[dt.getDate()] = r;
  });
  // First-day-of-month + count
  var firstDow = new Date(year, month, 1).getDay();         // 0=Sun..6=Sat
  // We render Sat-first (Saudi week). Convert: Sat=0 col, Sun=1 col, ..., Fri=6 col
  var startCol = (firstDow + 1) % 7;                        // Sat→0, Sun→1, ..., Fri→6
  var lastDate = new Date(year, month + 1, 0).getDate();
  var todayYmd = new Date().toISOString().slice(0,10);
  var html = '';
  // Empty cells before day 1
  for (var i = 0; i < startCol; i++) html += '<div class="att-cal-cell empty"></div>';
  for (var day = 1; day <= lastDate; day++) {
    var r = dayMap[day];
    var status = r ? r.status : 'future';
    if (r && r.status === 'present' && r.lateMinutes > 0) status = 'late';
    var isToday = r ? (r.date === todayYmd) : (new Date(year, month, day).toISOString().slice(0,10) === todayYmd);
    var marks = '';
    if (r) {
      if (r.lateMinutes > 0)     marks += '<span class="att-cal-mark" style="left:3px;color:#dc2626;">L</span>';
      if (r.overtimeMinutes > 0) marks += '<span class="att-cal-mark" style="right:3px;color:#16a34a;">+</span>';
    }
    var title = '';
    if (r) {
      title = r.date + ' — ' + status;
      if (r.totalHours) title += ' (' + r.totalHours + 'h)';
      if (r.lateMinutes) title += ' متأخر ' + r.lateMinutes + 'د';
    }
    html += '<div class="att-cal-cell ' + status + (isToday?' today':'') + '" title="' + title + '"><span class="att-cal-day">' + day + '</span>' + marks + '</div>';
  }
  grid.innerHTML = html;
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
// V4: 8-state palette unified with admin
var _statClr = {
  draft:'#94a3b8', created:'#0ea5e9', pending:'#f59e0b',
  in_progress:'#f59e0b', replied:'#8b5cf6', returned:'#dc2626',
  approved:'#16a34a', rejected:'#991b1b', closed:'#6b7280'
};
var _statBg  = {
  draft:'#f1f5f9', created:'#e0f2fe', pending:'#fef3c7',
  in_progress:'#fef3c7', replied:'#ede9fe', returned:'#fef2f2',
  approved:'#dcfce7', rejected:'#fee2e2', closed:'#f3f4f6'
};
var _statIcon = {
  draft:'fa-file-pen', created:'fa-paper-plane', pending:'fa-clock',
  in_progress:'fa-spinner', replied:'fa-comment-dots', returned:'fa-rotate-left',
  approved:'fa-circle-check', rejected:'fa-circle-xmark', closed:'fa-lock'
};
function _impLabel(i) { return t('txn.imp.' + i) || i; }
function _statLabel(s) { return t('txn.status.' + s) || s; }

function _impBadge(i) {
  var c = _impColors[i]||'#6b7280', bg = _impBgs[i]||'#f3f4f6';
  return '<span style="padding:2px 8px;border-radius:6px;background:'+bg+';color:'+c+';font-size:10px;font-weight:800;"><i class="fas fa-circle" style="font-size:6px;margin-left:3px;"></i>'+_impLabel(i)+'</span>';
}

function _statBadge(s) {
  var c = _statClr[s]||'#94a3b8', bg = _statBg[s]||'#f3f4f6', icon = _statIcon[s]||'fa-circle';
  return '<span style="padding:3px 10px;border-radius:999px;background:'+bg+';color:'+c+';font-size:10.5px;font-weight:800;border:1.5px solid '+c+';display:inline-flex;align-items:center;gap:4px;"><i class="fas '+icon+'" style="font-size:9px;"></i>'+_statLabel(s)+'</span>';
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
// V5-UX: preserves scroll position on refresh; escapes IDs in inline onclick
//        (XSS-hardened); 44px touch targets on mobile.
function loadIncomingTxns() {
  var c = document.getElementById('incomingTxnList');
  if (!c) return;
  // V5-UX: remember scroll position so re-render doesn't jump to top
  var prevScroll = c.scrollTop;
  c.innerHTML = '<p class="empty"><i class="fas fa-spinner fa-spin"></i></p>';
  callAPI('GET', '/workflow/incoming?username=' + encodeURIComponent(currentUser), null, function(rows) {
    var list = rows || []; if (!Array.isArray(list)) list = [];
    var bd = document.getElementById('txnIncBadge');
    if (bd) { if (list.length) { bd.style.display = 'inline-block'; bd.textContent = list.length; } else { bd.style.display = 'none'; } }
    if (!list.length) { c.innerHTML = '<p class="empty">'+t('common.empty.incoming')+'</p>'; return; }
    var localeCode = currentLang === 'en' ? 'en-US' : 'ar-SA';
    var isNarrow = window.innerWidth < 500;
    c.innerHTML = list.map(function(tx) {
      var dt = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(localeCode,{day:'numeric',month:'short'}) : '';
      // V5-SEC: escape IDs in inline onclick to prevent XSS via malicious id strings
      var idEsc = String(tx.id || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
      // V5-UX: on narrow phones (<500px) show only Approve/Reject in row 1, Return/Forward in row 2.
      // 44px min-height per Apple HIG; 12px font instead of 11px for legibility.
      var primaryRow =
        '<button aria-label="'+t('txn.accept')+'" onclick="empAct(\''+idEsc+'\',\'approve\')" style="flex:1;min-height:44px;padding:10px 8px;border:none;background:#10b981;color:#fff;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;"><i class="fas fa-check"></i> '+t('txn.accept')+'</button>' +
        '<button aria-label="'+t('txn.reject')+'" onclick="empAct(\''+idEsc+'\',\'reject\')" style="flex:1;min-height:44px;padding:10px 8px;border:none;background:#ef4444;color:#fff;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;"><i class="fas fa-times"></i> '+t('txn.reject')+'</button>';
      var secondaryRow =
        '<button aria-label="'+t('txn.return')+'" onclick="empAct(\''+idEsc+'\',\'return\')" style="flex:1;min-height:44px;padding:10px 8px;border:none;background:#f59e0b;color:#fff;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;"><i class="fas fa-undo"></i> '+t('txn.return')+'</button>' +
        '<button aria-label="'+t('txn.forward')+'" onclick="empFwd(\''+idEsc+'\')" style="flex:1;min-height:44px;padding:10px 8px;border:none;background:#8b5cf6;color:#fff;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;"><i class="fas fa-share"></i> '+t('txn.forward')+'</button>';
      var actionsHtml = isNarrow
        ? '<div style="display:flex;gap:6px;margin-top:8px;">'+primaryRow+'</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px;">'+secondaryRow+'</div>'
        : '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">'+primaryRow+secondaryRow+'</div>';
      return '<div class="emp-incoming-row" data-txn-id="'+idEsc+'" style="border-bottom:1px solid #f5f5f5;padding:10px 0;">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' + _impBadge(tx.importance||'medium') + _statBadge(tx.status) + '</div>' +
        '<div onclick="viewMyTxn(\''+idEsc+'\')" style="cursor:pointer;">' +
          '<div style="font-weight:800;font-size:13px;color:#0f172a;">' + (tx.title||'') + '</div>' +
          '<div style="font-size:10px;font-family:monospace;color:#64748b;margin-top:2px;">'+(tx.txnNumber||'')+'</div>' +
          '<div class="meta">' + (tx.typeName||'') + ' • ' + (tx.senderName||tx.createdBy||'') + ' • ' + dt + '</div>' +
          (Number(tx.amount) ? '<div style="margin-top:2px;color:#0ea5e9;font-weight:800;font-size:12px;">'+Number(tx.amount).toLocaleString('en',{minimumFractionDigits:2})+' '+t('units.sarCurrency')+'</div>' : '') +
        '</div>' +
        actionsHtml +
      '</div>';
    }).join('');
    // V5-UX: restore scroll position after render
    if (prevScroll > 0) { try { c.scrollTop = prevScroll; } catch(_){} }
  });
}

function empAct(id, action) {
  // V5-UX: rewritten for mobile-first — uses WoModal if available; falls back to inline.
  var required = (action === 'reject' || action === 'return');
  var minLen = required ? 10 : 0;   // V5-UX: min length on rejection/return reasons
  var maxLen = 1000;                 // V5-UX: cap to prevent runaway textareas
  var aClrs = { approve: '#10b981', reject: '#ef4444', return: '#f59e0b', close: '#6b7280' };
  var aIconKind = { approve: 'success', reject: 'danger', return: 'warning', close: 'neutral' };
  var aIcons = { approve: 'fa-check-circle', reject: 'fa-times-circle', return: 'fa-undo', close: 'fa-lock' };
  var aTitles = { approve: t('txn.act.approve'), reject: t('txn.act.reject'), return: t('txn.act.return'), close: t('txn.act.close') };
  var labelKey = action === 'return' ? 'txn.returnReason' : (action === 'reject' ? 'txn.rejectReason' : 'txn.noteOptional');

  // Build the textarea + counter HTML
  var bodyHTML =
    '<div style="margin-bottom:8px;">' +
      '<label for="empActNote" style="font-size:13px;font-weight:700;color:#334155;display:block;margin-bottom:6px;">' +
        t(labelKey) + (required?' <span style="color:#ef4444;" aria-hidden="true">*</span>':'') +
      '</label>' +
      '<textarea id="empActNote" rows="4" maxlength="'+maxLen+'" ' +
        'aria-required="'+(required?'true':'false')+'" ' +
        'style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:12px;font-size:15px;font-family:inherit;direction:rtl;min-height:96px;max-height:30vh;resize:none;box-sizing:border-box;" ' +
        'placeholder="'+t(required?'txn.notePlaceholderRequired':'txn.notePlaceholder')+'"></textarea>' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-top:4px;">' +
        '<span id="empActErr" style="color:#ef4444;font-weight:700;display:none;"></span>' +
        '<span id="empActCount">0 / '+maxLen+'</span>' +
      '</div>' +
    '</div>';

  // Use WoModal if loaded (newer pattern)
  if (typeof WoModal !== 'undefined' && WoModal.open) {
    var m = WoModal.open({
      icon: aIcons[action], iconKind: aIconKind[action],
      title: aTitles[action], size: 'sm',
      body: bodyHTML,
      footer: '<button class="wom-btn" data-act="cancel">'+t('common.cancelBtn')+'</button>' +
              '<button class="wom-btn" id="empActOkBtn" style="background:'+aClrs[action]+';color:#fff;border-color:'+aClrs[action]+';min-height:44px;min-width:100px;">'+aTitles[action]+'</button>'
    });
    _wireEmpAct(m.overlay, m.close, id, action, required, minLen, maxLen);
    return;
  }

  // Fallback inline modal — still mobile-friendly
  var old = document.getElementById('empActionDlg'); if (old) old.remove();
  var div = document.createElement('div');
  div.id = 'empActionDlg';
  div.setAttribute('role','dialog');
  div.setAttribute('aria-modal','true');
  div.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;padding:0;backdrop-filter:blur(4px);';
  div.innerHTML =
    '<div role="document" style="background:#fff;border-radius:18px 18px 0 0;padding:20px;width:100%;max-width:520px;max-height:85dvh;overflow-y:auto;box-shadow:0 -8px 32px rgba(0,0,0,.25);direction:rtl;">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
        '<div style="width:44px;height:44px;border-radius:12px;background:'+aClrs[action]+'15;display:grid;place-items:center;flex-shrink:0;"><i class="fas '+aIcons[action]+'" style="color:'+aClrs[action]+';font-size:18px;"></i></div>' +
        '<h3 style="margin:0;font-size:17px;font-weight:800;color:#0f172a;">'+aTitles[action]+'</h3>' +
        '<button aria-label="'+t('common.cancelBtn')+'" id="empActCloseX" style="margin-inline-start:auto;width:36px;height:36px;border:0;background:transparent;font-size:22px;color:#64748b;cursor:pointer;border-radius:8px;">&times;</button>' +
      '</div>' +
      bodyHTML +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">' +
        '<button id="empActCancelBtn" style="padding:12px 22px;min-height:44px;min-width:88px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;">'+t('common.cancelBtn')+'</button>' +
        '<button id="empActOkBtn" style="padding:12px 26px;min-height:44px;min-width:120px;border:none;background:'+aClrs[action]+';color:#fff;border-radius:12px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px '+aClrs[action]+'40;">'+aTitles[action]+'</button>' +
      '</div>' +
    '</div>';
  // V5-UX: align-items:flex-end on mobile = bottom sheet; switch to center on >=600px
  if (window.matchMedia && window.matchMedia('(min-width:600px)').matches) {
    div.style.alignItems = 'center';
    div.querySelector('div[role="document"]').style.borderRadius = '18px';
    div.querySelector('div[role="document"]').style.maxWidth = '480px';
  }
  document.body.appendChild(div);
  _wireEmpAct(div, function(){ div.remove(); }, id, action, required, minLen, maxLen);
}

// Shared wiring used by both the WoModal path and the inline fallback
function _wireEmpAct(host, closeFn, id, action, required, minLen, maxLen){
  // Backdrop / X / Cancel
  if (host.id === 'empActionDlg') {
    host.addEventListener('click', function(e) { if (e.target === host) closeFn(); });
    var x = host.querySelector('#empActCloseX'); if (x) x.onclick = closeFn;
  }
  // V5-A11y: focus trap — Tab/Shift+Tab cycle within modal; Esc closes
  var focusables = host.querySelectorAll('textarea,button,input,select');
  host.addEventListener('keydown', function(e){
    if (e.key === 'Escape') { closeFn(); return; }
    if (e.key !== 'Tab' || !focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
  var cancel = host.querySelector('#empActCancelBtn') || host.querySelector('[data-act="cancel"]');
  if (cancel) cancel.onclick = closeFn;
  var ta = host.querySelector('#empActNote');
  var counter = host.querySelector('#empActCount');
  var err = host.querySelector('#empActErr');
  var ok = host.querySelector('#empActOkBtn');
  if (ta && counter) {
    ta.addEventListener('input', function(){
      counter.textContent = ta.value.length + ' / ' + maxLen;
      if (err && err.style.display === 'block') {
        // clear error as user types
        err.style.display = 'none';
        ta.style.borderColor = '#e5e7eb';
      }
    });
  }
  setTimeout(function(){ if (ta) ta.focus(); }, 80);
  if (!ok) return;
  ok.addEventListener('click', function(){
    if (ok.disabled) return;
    var note = ((ta && ta.value) || '').trim();
    if (required && note.length < minLen) {
      if (err) {
        err.style.display = 'block';
        err.textContent = (minLen > 0)
          ? 'يجب أن يكون السبب على الأقل ' + minLen + ' أحرف'
          : (typeof t === 'function' ? t('txn.reasonRequired') : 'السبب مطلوب');
      }
      if (ta) { ta.style.borderColor = '#ef4444'; ta.focus(); }
      return;
    }
    // V5-UX: lock to prevent double-submit
    ok.disabled = true;
    if (ta) ta.disabled = true;
    var original = ok.textContent;
    ok.textContent = '... ' + original;
    var idemKey = 'act-' + id + '-' + action + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    callAPI('POST', '/workflow/transactions/' + id + '/action', {
      action: action, username: currentUser, note: note, idempotencyKey: idemKey
    }, function(r) {
      ok.disabled = false;
      if (ta) ta.disabled = false;
      ok.textContent = original;
      if (r && r.success) {
        closeFn();
        toast((typeof t==='function'?t('common.done'):'تم'));
        if (typeof loadIncomingTxns === 'function') loadIncomingTxns();
        if (typeof loadMyTransactions === 'function') loadMyTransactions();
      } else {
        if (err) { err.style.display = 'block'; err.textContent = (r && r.error) || (typeof t==='function'?t('txn.failed'):'فشل'); }
        else toast((r && r.error) || (typeof t==='function'?t('txn.failed'):'فشل'), true);
      }
    });
  });
}

function empFwd(id) {
  callAPI('GET', '/workflow/eligible-users?sender=' + encodeURIComponent(currentUser), null, function(users) {
    if (!users || !users.length) return toast(t('txn.noRecipient'), true);
    // V5-UX: group users by department/role for clearer hierarchy
    var groups = { manager: [], peer: [], subordinate: [], other: [] };
    users.forEach(function(u){
      var k = u.relation || (u.role === 'admin' ? 'manager' : 'other');
      if (groups[k]) groups[k].push(u); else groups.other.push(u);
    });
    var groupLabels = {
      manager: '👔 المديرون والإدارة العليا',
      peer: '👥 الزملاء (نفس المستوى)',
      subordinate: '👤 المرؤوسون',
      other: '🌐 مستخدمون آخرون'
    };
    var optsHtml = '';
    Object.keys(groups).forEach(function(k){
      if (!groups[k].length) return;
      optsHtml += '<optgroup label="' + groupLabels[k] + ' (' + groups[k].length + ')">';
      groups[k].forEach(function(u){
        optsHtml += '<option value="'+_esc(u.username)+'">'+_esc(u.fullName||u.username)+(u.positionName?' — '+_esc(u.positionName):'')+(u.branchName?' · '+_esc(u.branchName):'')+'</option>';
      });
      optsHtml += '</optgroup>';
    });

    var old = document.getElementById('empFwdDlg'); if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'empFwdDlg';
    div.setAttribute('role','dialog');
    div.setAttribute('aria-modal','true');
    div.setAttribute('aria-labelledby','empFwdTitle');
    // V5-UX: bottom-sheet on mobile, centered on tablet+
    var isMobile = !(window.matchMedia && window.matchMedia('(min-width:600px)').matches);
    div.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);display:flex;align-items:'+(isMobile?'flex-end':'center')+';justify-content:center;padding:'+(isMobile?'0':'14px')+';backdrop-filter:blur(4px);';
    div.innerHTML =
      '<div role="document" style="background:#fff;border-radius:'+(isMobile?'18px 18px 0 0':'18px')+';padding:20px;width:100%;max-width:'+(isMobile?'100%':'480px')+';max-height:'+(isMobile?'85dvh':'90vh')+';overflow-y:auto;box-shadow:0 -8px 32px rgba(0,0,0,.25);direction:rtl;">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
          '<div style="width:44px;height:44px;border-radius:12px;background:#ede9fe;display:grid;place-items:center;flex-shrink:0;"><i class="fas fa-share" style="color:#7c3aed;font-size:18px;"></i></div>' +
          '<h3 id="empFwdTitle" style="margin:0;font-size:17px;font-weight:800;color:#0f172a;">'+t('txn.forward')+'</h3>' +
          '<button aria-label="إغلاق" id="empFwdCloseX" style="margin-inline-start:auto;width:36px;height:36px;border:0;background:transparent;font-size:22px;color:#64748b;cursor:pointer;border-radius:8px;">&times;</button>' +
        '</div>' +
        '<div style="margin-bottom:10px;">' +
          '<label for="empFwdTo" style="font-size:13px;font-weight:700;color:#334155;display:block;margin-bottom:6px;">'+t('tm.recipient')+' <span style="color:#ef4444;" aria-hidden="true">*</span></label>' +
          '<select id="empFwdTo" aria-required="true" style="width:100%;min-height:44px;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;font-family:inherit;background:#fff;">'+optsHtml+'</select>' +
        '</div>' +
        '<div style="margin-bottom:10px;">' +
          '<label for="empFwdNote" style="font-size:13px;font-weight:700;color:#334155;display:block;margin-bottom:6px;">'+t('txn.noteOptional')+'</label>' +
          '<textarea id="empFwdNote" rows="3" maxlength="1000" style="width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;resize:none;font-family:inherit;min-height:80px;max-height:30vh;" placeholder="'+t('txn.notePlaceholder')+'"></textarea>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button id="empFwdCancelBtn" style="padding:12px 22px;min-height:44px;min-width:88px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;">'+t('common.cancelBtn')+'</button>' +
          '<button id="empFwdOkBtn" style="padding:12px 26px;min-height:44px;min-width:120px;border:none;background:#8b5cf6;color:#fff;border-radius:12px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px rgba(139,92,246,.4);">'+t('txn.forward')+'</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div);
    div.addEventListener('click', function(e) { if (e.target === div) div.remove(); });
    div.querySelector('#empFwdCancelBtn').onclick = function() { div.remove(); };
    div.querySelector('#empFwdCloseX').onclick = function(){ div.remove(); };
    // V5-A11y: auto-focus the recipient picker so keyboard users don't have to tab
    setTimeout(function(){ var f = document.getElementById('empFwdTo'); if (f) f.focus(); }, 60);
    // V5-A11y: focus trap within modal — Tab/Shift+Tab cycles within
    var focusables = div.querySelectorAll('select,textarea,button,input');
    div.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { div.remove(); return; }
      if (e.key !== 'Tab' || !focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });
    var okBtn = div.querySelector('#empFwdOkBtn');
    okBtn.onclick = function() {
      if (okBtn.disabled) return;
      var toUser = document.getElementById('empFwdTo').value;
      var note = (document.getElementById('empFwdNote').value||'').trim();
      if (!toUser) return toast(t('txn.invalidChoice'), true);
      // V5-UX: lock to prevent double-submit + idempotency
      okBtn.disabled = true;
      var originalText = okBtn.textContent;
      okBtn.textContent = '... ' + originalText;
      var idemKey = 'fwd-' + id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
      callAPI('POST', '/workflow/transactions/' + id + '/action', {
        action: 'forward', username: currentUser, forwardTo: toUser,
        note: t('txn.act.forward') + ': ' + toUser + (note ? ' — ' + note : ''),
        idempotencyKey: idemKey
      }, function(r) {
        okBtn.disabled = false;
        okBtn.textContent = originalText;
        if (r && r.success) {
          div.remove();
          toast(t('txn.forwarded'));
          if (typeof loadIncomingTxns === 'function') loadIncomingTxns();
        } else toast(r ? r.error : t('txn.failed'), true);
      });
    };
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
      var isReturned = tx.status === 'returned';
      // V3.1: editable while pending/draft (workflow not started) OR while returned (creator must fix and resubmit)
      var canEdit = (tx.status==='pending' || tx.status==='draft' || isReturned);
      var actBtns = '';
      if (isReturned) {
        // Prominent Resubmit button — the obvious next step for a returned txn
        actBtns = '<div style="display:flex;gap:4px;margin-top:8px;">' +
          '<button onclick="event.stopPropagation();empEditTxn(\''+tx.id+'\')" style="flex:2;padding:9px;border:none;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;border-radius:8px;font-size:12px;font-weight:900;cursor:pointer;box-shadow:0 2px 4px rgba(220,38,38,.3);"><i class="fas fa-pen-to-square"></i> تعديل وإعادة الإرسال</button>' +
          '<button onclick="event.stopPropagation();empCancelTxn(\''+tx.id+'\')" style="flex:1;padding:9px;border:none;background:#fef2f2;color:#991b1b;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-trash"></i></button>' +
        '</div>';
      } else if (canEdit) {
        actBtns = '<div style="display:flex;gap:4px;margin-top:6px;">' +
          '<button onclick="event.stopPropagation();empEditTxn(\''+tx.id+'\')" style="flex:1;padding:6px;border:none;background:#eff6ff;color:#1e40af;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-edit"></i> '+t('txn.edit')+'</button>' +
          '<button onclick="event.stopPropagation();empCancelTxn(\''+tx.id+'\')" style="flex:1;padding:6px;border:none;background:#fef2f2;color:#991b1b;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer;"><i class="fas fa-trash"></i> '+t('txn.cancel')+'</button>' +
        '</div>';
      }
      // Returned-state row treatment: red left border + soft tint
      var rowStyle = isReturned
        ? 'border-bottom:1px solid #f5f5f5;padding:10px 12px 10px 14px;background:linear-gradient(90deg,#fef2f2,#fff 30%);border-right:4px solid #dc2626;border-radius:8px;margin-bottom:4px;'
        : 'border-bottom:1px solid #f5f5f5;padding:10px 0;';
      // Status badge — for returned, use a distinctive red pill
      var statusPill = isReturned
        ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:#fef2f2;color:#dc2626;border:1px solid #dc2626;font-size:10px;font-weight:900;"><i class="fas fa-rotate-left" style="font-size:9px;"></i> مرجعة للتعديل' + (tx.returnCount > 1 ? ' ×' + tx.returnCount : '') + '</span>'
        : _statBadge(tx.status);
      return '<div style="' + rowStyle + '">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' + _impBadge(tx.importance||'medium') + statusPill + '</div>' +
        '<div onclick="viewMyTxn(\''+tx.id+'\')" style="cursor:pointer;">' +
          '<div style="font-weight:800;font-size:13px;color:#0f172a;">' + (tx.title||'') + '</div>' +
          '<div style="font-size:10px;font-family:monospace;color:#64748b;margin-top:2px;">'+(tx.txnNumber||'')+'</div>' +
          '<div class="meta">' + (tx.typeName||'') + ' • ' + dt + ' • '+t('txn.responsible')+': <b style="color:#1e40af;">' + (tx.currentAssignee||tx.currentPositionName||'—') + '</b></div>' +
          (isReturned && tx.returnReason ? '<div style="margin-top:6px;padding:6px 10px;background:#fff;border:1px solid #fecaca;border-radius:6px;font-size:11px;color:#991b1b;line-height:1.5;"><i class="fas fa-quote-right" style="font-size:9px;margin-inline-end:4px;"></i>' + (tx.returnReason.length > 100 ? tx.returnReason.substring(0,100) + '…' : tx.returnReason) + '</div>' : '') +
        '</div>' +
        actBtns +
      '</div>';
    }).join('');
  });
}

// ─── Edit a sent transaction using the redesigned modal in edit mode ───
window._editingTxnId = null;
function empEditTxn(id) {
  callAPI('GET', '/workflow/transactions/'+id, null, function(txn) {
    if (!txn || txn.error) return toast(t('txn.notFound') || 'المعاملة غير موجودة', true);
    openTxnModal();
    window._editingTxnId = id;
    // V4.4: full-edit mode for returned transactions — unlock type + recipient + all fields
    var isReturned = (txn.status === 'returned');
    window._editingFullMode = isReturned;
    setTimeout(function(){
      var titleSpan = document.querySelector('#txnModal .modal-h span');
      if (titleSpan) {
        titleSpan.innerHTML = isReturned
          ? '<i class="fas fa-rotate-left" style="color:#dc2626;"></i> تعديل المعاملة المرجعة (تعديل كامل)'
          : '<i class="fas fa-edit" style="color:#1e40af;"></i> تعديل المعاملة';
      }
      var sendBtn = document.querySelector('#txnModal button.btn-m[onclick="submitTxn()"]');
      if (sendBtn) {
        sendBtn.innerHTML = isReturned
          ? '<i class="fas fa-paper-plane"></i> حفظ وإعادة الإرسال'
          : '<i class="fas fa-save"></i> حفظ التعديلات';
        sendBtn.setAttribute('onclick', 'submitTxnEdit()');
        sendBtn.style.background = isReturned
          ? 'linear-gradient(135deg,#dc2626,#b91c1c)'
          : '#1e40af';
      }
      var banner = document.getElementById('txnDraftBanner');
      if (banner) banner.style.display = 'none';

      // V4.4: prepend a banner explaining FULL EDIT mode + the return reason
      if (isReturned) {
        var modalC = document.querySelector('#txnModal .modal-c');
        var existingNotice = document.getElementById('returnedFullEditNotice');
        if (existingNotice) existingNotice.remove();
        if (modalC) {
          var notice = document.createElement('div');
          notice.id = 'returnedFullEditNotice';
          notice.style.cssText = 'background:linear-gradient(135deg,#fef2f2,#fff);border:2px solid #dc2626;border-radius:10px;padding:12px;margin:0 0 14px;';
          var retDt = '';
          try { if (txn.returnedAt) retDt = new Date(txn.returnedAt).toLocaleString('ar-SA-u-nu-latn',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(_){}
          notice.innerHTML =
            '<div style="display:flex;gap:10px;align-items:flex-start;">' +
              '<i class="fas fa-rotate-left" style="color:#dc2626;font-size:18px;margin-top:2px;"></i>' +
              '<div style="flex:1;">' +
                '<div style="font-weight:900;font-size:13px;color:#991b1b;margin-bottom:4px;">معاملة مرجعة للتعديل — يمكنك تعديل كل الحقول</div>' +
                (txn.returnedBy ? '<div style="font-size:11px;color:#7f1d1d;"><b>المُرجِع:</b> '+_esc(txn.returnedBy)+(retDt?' · '+retDt:'')+'</div>' : '') +
                (txn.returnReason ? '<div style="margin-top:6px;padding:8px 10px;background:#fff;border:1px solid #fecaca;border-radius:8px;font-size:12px;color:#991b1b;line-height:1.6;"><i class="fas fa-quote-right" style="font-size:10px;"></i> '+_esc(txn.returnReason)+'</div>' : '') +
              '</div>' +
            '</div>';
          var firstChild = modalC.querySelector('.fg, .form-row, input, textarea, select');
          if (firstChild) modalC.insertBefore(notice, firstChild);
          else modalC.insertBefore(notice, modalC.firstChild);
        }
      }

      var setVal = function(id,v){ var e=document.getElementById(id); if (e) e.value = (v==null?'':v); };
      setVal('txnTitle', txn.subject || txn.title || '');
      setVal('txnDesc',  txn.contentHtml || txn.description || '');
      setVal('txnAmount', Number(txn.amount||0));
      txnSetImportance(txn.importance || 'medium');

      // V4.4: type select — UNLOCKED for returned, locked for pending
      var typeSel = document.getElementById('txnType');
      var tid = txn.typeId || txn.transactionTypeId;
      if (typeSel && tid) {
        typeSel.value = tid;
        if (isReturned) {
          typeSel.disabled = false;
          typeSel.style.background = '#fff';
          typeSel.style.borderColor = '#dc2626';
        } else {
          typeSel.disabled = true;
          typeSel.style.background = '#f3f4f6';
        }
      }

      // V4.4: recipient — UNLOCKED for returned
      var recSel = document.getElementById('txnRecipient');
      if (recSel) {
        if (txn.currentAssignee) {
          var alreadyOpt = Array.from(recSel.options).find(function(o){ return o.value === txn.currentAssignee; });
          if (alreadyOpt) recSel.value = txn.currentAssignee;
        }
        if (isReturned) {
          recSel.disabled = false;
          recSel.style.background = '#fff';
          recSel.style.borderColor = '#dc2626';
        } else {
          recSel.disabled = true;
          recSel.style.background = '#f3f4f6';
        }
      }

      if (txn.accountCode || txn.accountName) {
        setVal('txnAccSearch', (txn.accountCode||'') + ' — ' + (txn.accountName||''));
        setVal('txnAccId', txn.accountId || '');
        setVal('txnAccName', txn.accountName || '');
      }
      var ccSel = document.getElementById('txnCC');
      if (ccSel && txn.costCenterId) ccSel.value = txn.costCenterId;
      txnValidateTitle();
    }, 350);
  });
}

window.submitTxnEdit = function() {
  if (!window._editingTxnId) return;
  var id = window._editingTxnId;
  var title = document.getElementById('txnTitle').value;
  var desc = document.getElementById('txnDesc').value;
  var amount = Number(document.getElementById('txnAmount').value) || 0;
  var importance = (document.getElementById('txnImportance')||{}).value || 'medium';
  if (!title || title.trim().length < 5) return toast('العنوان قصير جداً (5 أحرف على الأقل)', true);

  var payload = {
    username: currentUser, title: title, description: desc, contentHtml: desc,
    amount: amount, importance: importance
  };

  // V4.4: full-edit mode (returned) — also send type, recipient, account, cost center
  if (window._editingFullMode) {
    var typeSel = document.getElementById('txnType');
    var recSel = document.getElementById('txnRecipient');
    var ccSel = document.getElementById('txnCC');
    if (typeSel && typeSel.value) payload.transactionTypeId = typeSel.value;
    if (recSel && recSel.value) payload.recipientUsername = recSel.value;
    var accId = (document.getElementById('txnAccId') || {}).value;
    var accName = (document.getElementById('txnAccName') || {}).value;
    if (accId) payload.accountId = accId;
    if (accName) payload.accountName = accName;
    if (ccSel && ccSel.value) payload.costCenterId = ccSel.value;
  }

  toast('جاري الحفظ...');
  callAPI('PUT', '/workflow/transactions/'+id, payload, function(r) {
    if (!(r && r.success)) {
      return toast(r ? r.error : 'فشل الحفظ', true);
    }
    toast('✓ تم حفظ التعديلات');
    var wasReturned = (r.status === 'returned');
    var doFinish = function() {
      window._editingTxnId = null;
      window._editingFullMode = false;
      // Restore modal back to create mode
      var titleSpan = document.querySelector('#txnModal .modal-h span');
      if (titleSpan) titleSpan.innerHTML = '<i class="fas fa-file-alt" style="color:#0ea5e9;"></i> معاملة جديدة';
      var sendBtn = document.querySelector('#txnModal button.btn-m[onclick="submitTxnEdit()"]');
      if (sendBtn) {
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المعاملة';
        sendBtn.setAttribute('onclick', 'submitTxn()');
        sendBtn.style.background = '#0ea5e9';
      }
      var typeSel = document.getElementById('txnType'); if (typeSel) { typeSel.disabled = false; typeSel.style.background = ''; typeSel.style.borderColor = ''; }
      var recSel  = document.getElementById('txnRecipient'); if (recSel) { recSel.disabled = false; recSel.style.background = ''; recSel.style.borderColor = ''; }
      // V4.4: remove the returned-edit notice banner
      var notice = document.getElementById('returnedFullEditNotice');
      if (notice) notice.remove();
      closeTxnModal();
      loadMyTransactions();
    };
    // V3.1: If this was a returned transaction, ask if they want to resubmit it now
    if (wasReturned) {
      // Use a simple confirm dialog (consistent with employee app's existing patterns)
      if (window.confirm('تم الحفظ بنجاح.\n\nهل ترغب في إعادة إرسال المعاملة الآن إلى الجهة التي أرجعتها؟\n\n• اضغط "موافق" → لإعادة الإرسال\n• اضغط "إلغاء" → لإبقائها مرجعة كمسودة معدّلة')) {
        callAPI('POST', '/workflow/transactions/' + id + '/resubmit', { username: currentUser, note: 'تم التعديل بناءً على ملاحظات الإرجاع' }, function(rr) {
          if (rr && rr.success) toast('✓ تم إعادة الإرسال');
          else toast(rr ? rr.error : 'فشل إعادة الإرسال', true);
          doFinish();
        });
      } else {
        doFinish();
      }
    } else {
      doFinish();
    }
  });
};

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
function _esc(s){ if (s==null) return ''; return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
// V5-SEC: minimal HTML sanitizer for contentHtml. Strips <script>, event handlers,
// javascript: URLs, and any tag not in a safe whitelist. Use BEFORE injecting via innerHTML.
function _sanitizeHtml(html){
  if (!html) return '';
  var d = document.createElement('div');
  d.innerHTML = String(html);
  var SAFE_TAGS = ['B','I','U','EM','STRONG','BR','P','DIV','SPAN','UL','OL','LI','A','H1','H2','H3','H4','H5','H6','TABLE','THEAD','TBODY','TR','TD','TH','BLOCKQUOTE','CODE','PRE','HR','SMALL','SUB','SUP'];
  var walk = function(node){
    var children = Array.prototype.slice.call(node.childNodes);
    children.forEach(function(child){
      if (child.nodeType === 1) {
        if (SAFE_TAGS.indexOf(child.tagName) === -1) {
          // Replace bad tag with its text content
          var txt = document.createTextNode(child.textContent || '');
          child.parentNode.replaceChild(txt, child);
        } else {
          // Strip ALL attributes except href on <a>
          for (var i = child.attributes.length - 1; i >= 0; i--) {
            var attr = child.attributes[i];
            var keep = false;
            if (child.tagName === 'A' && attr.name === 'href') {
              var val = (attr.value || '').trim().toLowerCase();
              if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('mailto:') || val.startsWith('/')) {
                keep = true;
              }
            }
            if (!keep) child.removeAttribute(attr.name);
          }
          if (child.tagName === 'A') {
            child.setAttribute('rel', 'noopener noreferrer');
            child.setAttribute('target', '_blank');
          }
          walk(child);
        }
      }
    });
  };
  walk(d);
  return d.innerHTML;
}

function viewMyTxn(id) {
  callAPI('GET', '/workflow/transactions/' + id, null, function(txn) {
    if (!txn || txn.error) {
      toast(t('txn.failed') || 'فشل تحميل المعاملة', true);
      console.error('viewMyTxn — empty/error response:', txn);
      return;
    }
    // Cache for the toggle button
    window._currentViewedTxn = txn;

    var sMap = { pending: t('txn.status.pending'), in_progress: t('txn.status.in_progress'), approved: t('txn.status.approved'), rejected: t('txn.status.rejected'), returned: t('txn.status.returned'), closed: t('txn.status.closed'), draft: t('txn.status.draft') };
    var sClr = { pending:'#f59e0b', in_progress:'#0ea5e9', approved:'#10b981', rejected:'#ef4444', returned:'#f97316', closed:'#6b7280' };
    var sBg  = { pending:'#fef3c7', in_progress:'#e0f2fe', approved:'#dcfce7', rejected:'#fee2e2', returned:'#ffedd5', closed:'#f1f5f9' };
    var ic = _impColors[txn.importance]||'#6b7280';
    var il = _impLabel(txn.importance) || txn.importance;
    var sc = sClr[txn.status]||'#6b7280';
    var sbg = sBg[txn.status]||'#f1f5f9';
    var statusLabel = sMap[txn.status]||txn.status;

    // ═══ HEADER — Title + Sender card (very prominent) ═══
    var titleText = txn.subject || txn.title || '';
    var senderName = txn.senderName || txn.createdBy || '';
    var senderPos  = txn.senderPosition || '';
    var senderInitial = senderName ? senderName.charAt(0).toUpperCase() : '?';
    var h = '';

    // PROMINENT TITLE BANNER — gradient + large title + sender avatar
    h += '<div style="border-radius:14px;padding:16px 18px;margin-bottom:12px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#fff;box-shadow:0 4px 12px rgba(15,23,42,.15);">';
    // Title row
    if (titleText) {
      h += '<h3 style="margin:0 0 10px;color:#fff;font-size:22px;font-weight:900;line-height:1.35;letter-spacing:-0.01em;">'+_esc(titleText)+'</h3>';
    }
    // Sender card
    h += '<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:rgba(255,255,255,.08);border-radius:10px;border:1px solid rgba(255,255,255,.12);">' +
      '<div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;flex-shrink:0;">'+_esc(senderInitial)+'</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:9.5px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;">المُرسِل</div>' +
        '<div style="font-size:14.5px;font-weight:900;color:#fff;margin-top:1px;">'+_esc(senderName||'—')+'</div>' +
        (senderPos ? '<div style="font-size:11px;color:#cbd5e1;font-weight:600;margin-top:1px;"><i class="fas fa-id-badge" style="color:#fbbf24;font-size:10px;margin-inline-end:3px;"></i>'+_esc(senderPos)+'</div>' : '') +
      '</div>' +
    '</div>';
    h += '</div>';

    // Compact meta row: number · type · amount · date
    var metaParts = [];
    if (txn.txnNumber) metaParts.push('<code style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:5px;font-weight:700;">'+_esc(txn.txnNumber)+'</code>');
    if (txn.typeName) metaParts.push('<span style="color:#475569;font-weight:700;"><i class="fas fa-tag" style="color:#94a3b8;font-size:9px;margin-inline-end:3px;"></i>'+_esc(txn.typeName)+'</span>');
    if (Number(txn.amount||0) > 0) metaParts.push('<span style="color:#0ea5e9;font-weight:900;font-size:13px;"><i class="fas fa-coins" style="font-size:10px;margin-inline-end:3px;"></i>'+Number(txn.amount).toLocaleString('en',{minimumFractionDigits:2})+' ر.س</span>');
    if (txn.createdAt) {
      try { metaParts.push('<span style="color:#94a3b8;"><i class="far fa-clock" style="font-size:10px;margin-inline-end:3px;"></i>'+new Date(txn.createdAt).toLocaleDateString('ar-SA-u-nu-latn',{day:'2-digit',month:'short',year:'numeric'})+'</span>'); } catch(_){}
    }
    if (metaParts.length) {
      h += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11.5px;margin-bottom:12px;padding:8px 10px;background:#fafbfc;border-radius:9px;border:1px solid #f1f5f9;">' + metaParts.join('<span style="color:#cbd5e1;">·</span>') + '</div>';
    }

    // 3. STATUS + STOPPED-AT — the most important info anyone needs at a glance
    h += '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">';
    // Status pill
    h += '<div style="flex:1;min-width:130px;padding:10px 12px;border-radius:12px;background:'+sbg+';border:1.5px solid '+sc+';">' +
      '<div style="font-size:9px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">الحالة</div>' +
      '<div style="font-size:14px;font-weight:900;color:'+sc+';margin-top:2px;"><i class="fas fa-circle" style="font-size:7px;margin-left:4px;"></i>'+_esc(statusLabel)+'</div>' +
    '</div>';
    // Importance pill
    h += '<div style="flex:1;min-width:130px;padding:10px 12px;border-radius:12px;background:'+ic+'15;border:1.5px solid '+ic+'40;">' +
      '<div style="font-size:9px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">الأهمية</div>' +
      '<div style="font-size:14px;font-weight:900;color:'+ic+';margin-top:2px;"><i class="fas fa-bolt" style="font-size:10px;margin-left:4px;"></i>'+_esc(il)+'</div>' +
    '</div>';
    h += '</div>';

    // V3: CEO approval badge — shows when transaction has passed through CEO/admin
    if (txn.passedCeoAt) {
      var ceoDt = '';
      try { ceoDt = new Date(txn.passedCeoAt).toLocaleString('ar-SA-u-nu-latn',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(_){}
      h += '<div style="padding:10px 14px;border-radius:12px;background:linear-gradient(135deg,#ecfccb,#f0fdf4);border:1.5px solid #16a34a;margin-bottom:10px;display:flex;align-items:center;gap:10px;">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;"><i class="fas fa-crown"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:10px;font-weight:800;color:#15803d;text-transform:uppercase;letter-spacing:.04em;">معتمدة من الإدارة العليا</div>' +
          '<div style="font-size:13px;font-weight:900;color:#14532d;margin-top:2px;">مرّت على الرئيس التنفيذي' + (txn.passedCeoBy ? ' — ' + _esc(txn.passedCeoBy) : '') + (ceoDt ? ' • ' + ceoDt : '') + '</div>' +
        '</div>' +
      '</div>';
    }

    // 4. STOPPED-AT — visible to EVERYONE (the user's specific request)
    if (txn.status === 'pending' || txn.status === 'in_progress') {
      var stoppedName = txn.currentAssignee || txn.currentPositionName || txn.currentRoleName || '—';
      var stoppedRole = (txn.currentAssignee && txn.currentRoleName) ? txn.currentRoleName : '';
      h += '<div style="padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,#fef3c7,#fff);border:1.5px solid #f59e0b;margin-bottom:10px;display:flex;align-items:center;gap:10px;">' +
        '<div style="width:40px;height:40px;border-radius:50%;background:#f59e0b;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;"><i class="fas fa-pause"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:10px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.04em;">المعاملة متوقفة الآن عند</div>' +
          '<div style="font-size:14px;font-weight:900;color:#78350f;margin-top:2px;">' + _esc(stoppedName) +
            (stoppedRole ? ' <small style="color:#a16207;font-weight:700;">— '+_esc(stoppedRole)+'</small>' : '') +
          '</div>' +
          (txn.currentStepName ? '<div style="font-size:11px;color:#a16207;margin-top:2px;">' + t('txn.stoppedStep') + ' ' + _esc(txn.currentStepName) + '</div>' : '') +
        '</div>' +
      '</div>';
    } else if (txn.status === 'returned') {
      // V3.1: Show full return context — who returned, when, and the reason text — fully translated
      var retDt = '';
      var dtLocale = currentLang === 'en' ? 'en-US' : 'ar-SA-u-nu-latn';
      try { if (txn.returnedAt) retDt = new Date(txn.returnedAt).toLocaleString(dtLocale,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(_){}
      var isMyOwn = (txn.createdBy === currentUser);
      var headLbl = isMyOwn ? ('⚠️ ' + t('txn.returnedToYou')) : t('txn.returnedToSender');
      var timesLbl = currentLang === 'en' ? (' (×' + txn.returnCount + ')') : (' (المرة ' + txn.returnCount + ')');
      h += '<div style="padding:14px;border-radius:14px;background:linear-gradient(135deg,#fef2f2,#fff);border:2px solid #dc2626;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;box-shadow:0 4px 12px rgba(220,38,38,.15);">' +
        '<div style="width:46px;height:46px;border-radius:50%;background:#dc2626;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;"><i class="fas fa-rotate-left"></i></div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:14px;font-weight:900;color:#991b1b;">' + headLbl + (txn.returnCount > 1 ? timesLbl : '') + '</div>' +
          '<div style="font-size:11.5px;color:#7f1d1d;margin-top:3px;font-weight:700;">' +
            '<b>' + t('txn.returnedBy') + '</b> ' + _esc(txn.returnedBy || '—') + (retDt ? ' · ' + retDt : '') +
          '</div>' +
          (txn.returnReason ? '<div style="margin-top:8px;padding:10px 12px;background:#fff;border:1px solid #fecaca;border-radius:10px;font-size:13px;color:#991b1b;line-height:1.7;font-weight:600;"><i class="fas fa-quote-right" style="font-size:11px;color:#dc2626;margin-inline-end:6px;"></i>' + _esc(txn.returnReason) + '</div>' : '') +
          (isMyOwn ? '<div style="margin-top:8px;font-size:11px;color:#991b1b;"><i class="fas fa-info-circle"></i> ' + t('txn.returnedHint') + '</div>' : '') +
        '</div>' +
      '</div>';
    } else if (txn.status === 'approved' || txn.status === 'closed') {
      var apprLbl = txn.status === 'closed' ? t('txn.closedTransaction') : t('txn.approvedTransaction');
      h += '<div style="padding:10px 14px;border-radius:10px;background:#dcfce7;border:1px solid #86efac;margin-bottom:10px;display:flex;align-items:center;gap:10px;">' +
        '<i class="fas fa-check-circle" style="color:#16a34a;font-size:20px;"></i>' +
        '<div style="font-size:13px;font-weight:800;color:#15803d;">' + apprLbl + '</div>' +
      '</div>';
    } else if (txn.status === 'rejected') {
      h += '<div style="padding:10px 14px;border-radius:10px;background:#fee2e2;border:1px solid #fca5a5;margin-bottom:10px;display:flex;align-items:center;gap:10px;">' +
        '<i class="fas fa-times-circle" style="color:#dc2626;font-size:20px;"></i>' +
        '<div style="font-size:13px;font-weight:800;color:#991b1b;">' + t('txn.rejectedTransaction') + '</div>' +
      '</div>';
    }

    // 5. CONTENT — translated header + empty state
    h += '<div style="position:relative;border:2px solid #0ea5e9;border-radius:16px;background:linear-gradient(180deg,#f0f9ff 0%,#fff 60%);padding:18px 18px 16px;margin-bottom:12px;box-shadow:0 6px 16px rgba(14,165,233,.10);">';
    h += '<div style="position:absolute;top:-10px;inset-inline-start:14px;background:#0ea5e9;color:#fff;padding:3px 12px;border-radius:7px;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;box-shadow:0 2px 4px rgba(14,165,233,.3);">' +
      '<i class="fas fa-file-lines" style="font-size:10px;margin-inline-end:4px;"></i>' + t('txn.contentLabel') +
    '</div>';
    if (txn.contentHtml && txn.contentHtml.trim()) {
      // V5-SEC: sanitize contentHtml — only allow safe tags. Previously raw HTML
      // from server was injected, opening XSS via SVG/script in user-submitted content.
      var safeContent = _sanitizeHtml(txn.contentHtml);
      h += '<div style="font-size:15px;color:#0f172a;line-height:1.95;font-weight:500;margin-top:6px;word-break:break-word;overflow-wrap:anywhere;">' + safeContent + '</div>';
    } else if (txn.description) {
      h += '<div style="font-size:15px;color:#0f172a;line-height:1.95;font-weight:500;white-space:pre-wrap;margin-top:6px;word-break:break-word;overflow-wrap:anywhere;">' + _esc(txn.description) + '</div>';
    } else {
      h += '<div style="font-size:13px;color:#94a3b8;font-style:italic;text-align:center;padding:14px;margin-top:6px;"><i class="fas fa-file-circle-question" style="font-size:24px;display:block;margin-bottom:8px;"></i>' + t('txn.noContent') + '</div>';
    }
    if (txn.attachment && txn.attachment.startsWith && txn.attachment.startsWith('data:')) {
      var isImg = txn.attachment.startsWith('data:image/');
      h += '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">';
      if (isImg) {
        h += '<img src="'+txn.attachment+'" style="max-width:280px;max-height:180px;border-radius:8px;border:1px solid #bae6fd;display:block;cursor:zoom-in;" onclick="window.open(this.src,\'_blank\')">';
      }
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button onclick="window.open(\''+txn.attachment+'\',\'_blank\')" style="display:inline-flex;align-items:center;gap:6px;color:#0ea5e9;font-size:12px;font-weight:800;padding:7px 14px;background:#fff;border:1.5px solid #0ea5e9;border-radius:10px;cursor:pointer;font-family:inherit;"><i class="fas fa-eye"></i> ' + t('txn.viewAttachOriginal') + '</button>' +
        '<a href="'+txn.attachment+'" download style="display:inline-flex;align-items:center;gap:6px;color:#fff;font-size:12px;font-weight:800;padding:7px 14px;background:#0ea5e9;border:1.5px solid #0ea5e9;border-radius:10px;text-decoration:none;"><i class="fas fa-download"></i> ' + t('txn.downloadAttach') + '</a>' +
      '</div></div>';
    }
    h += '</div>';

    // V4.2: REPLIES THREAD — when user IS current assignee, reply ADVANCES workflow
    // (user spec: "بعد الرد يجب انتقال المعاملة للجهة التالية")
    var fileLabelDefault = t('txn.attachFile');
    var isMyTurn = (txn.currentAssignee === currentUser || txn.current_assignee === currentUser);
    var canStillReply = !isMyTurn || !((txn.logs || []).some(function(l) {
      return l.actionBy === currentUser && l.workflowDefinitionId === txn.currentStepId
             && ['approve','reject','return','forward'].indexOf(l.actionType) >= 0;
    }));
    var btnLabel = isMyTurn ? '<i class="fas fa-paper-plane"></i> رد + موافقة وتحويل للتالي'
                            : '<i class="fas fa-comment"></i> ' + t('txn.sendReply');
    var btnBg = isMyTurn ? 'background:linear-gradient(135deg,#16a34a,#15803d);'
                          : 'background:linear-gradient(135deg,#8b5cf6,#6d28d9);';
    h += '<div style="border:2px solid ' + (isMyTurn ? '#16a34a' : '#c4b5fd') + ';border-radius:14px;background:linear-gradient(180deg,' + (isMyTurn ? '#f0fdf4' : '#faf5ff') + ' 0%,#fff 60%);padding:14px;margin-bottom:12px;" id="emp_replyBox">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
        '<div style="width:30px;height:30px;border-radius:50%;background:' + (isMyTurn ? '#16a34a' : '#8b5cf6') + ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;"><i class="fas fa-comments"></i></div>' +
        '<span style="font-size:14px;font-weight:900;color:' + (isMyTurn ? '#15803d' : '#5b21b6') + ';">' + (isMyTurn ? '⚠️ معاملة بانتظار ردّك' : t('txn.repliesTitle')) + '</span>' +
        '<span id="emp_repliesCount" style="margin-inline-start:auto;font-size:11px;color:#7c3aed;font-weight:800;background:#ede9fe;padding:4px 10px;border-radius:999px;">…</span>' +
      '</div>' +
      '<div id="emp_repliesList"><div style="text-align:center;color:#94a3b8;padding:20px;font-size:12px;"><i class="fas fa-spinner fa-spin"></i></div></div>';
    if (canStillReply) {
      h += '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed ' + (isMyTurn ? '#86efac' : '#c4b5fd') + ';" id="emp_replyForm">' +
        (isMyTurn ? '<div style="font-size:11.5px;color:#15803d;font-weight:700;margin-bottom:8px;background:#dcfce7;padding:8px 12px;border-radius:8px;border:1px solid #86efac;"><i class="fas fa-info-circle"></i> اكتب ردك واختر المستلم (افتراضياً: الشخص التالي في السلسلة).</div>' : '') +
        '<textarea id="emp_replyText" placeholder="' + (isMyTurn ? 'اكتب ردك على المعاملة...' : t('txn.replyPlaceholder')).replace(/'/g,"\\'") + '" style="width:100%;min-height:80px;padding:12px;border:1.5px solid ' + (isMyTurn ? '#86efac' : '#c4b5fd') + ';border-radius:10px;font-family:inherit;font-size:13px;resize:vertical;outline:none;background:#fff;line-height:1.7;"></textarea>' +
        // V4.5/V5-UX: recipient picker (only when user is current assignee — otherwise reply is just a comment)
        // V5-UX: shows clear loading state, then populates with grouped optgroups.
        (isMyTurn ?
          '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#f0fdf4;padding:10px 12px;border-radius:10px;border:1px solid #86efac;">' +
            '<i class="fas fa-paper-plane" style="color:#15803d;font-size:13px;"></i>' +
            '<label for="emp_replyForwardTo" style="font-size:11.5px;font-weight:800;color:#15803d;">إرسال إلى:</label>' +
            '<select id="emp_replyForwardTo" aria-label="اختر المستلم" style="flex:1;min-width:180px;min-height:40px;padding:8px 10px;border:1.5px solid #86efac;border-radius:8px;font-family:inherit;font-size:13px;background:#fff;color:#0f172a;font-weight:600;">' +
              '<option value="" data-loading="1">⏳ جاري تحميل المستلمين...</option>' +
            '</select>' +
            '<span id="emp_replyRecipHint" style="width:100%;font-size:10.5px;color:#15803d;display:none;"><i class="fas fa-info-circle"></i> اتركه فارغاً ليُرسل تلقائياً للشخص التالي حسب سياسة الموافقة.</span>' +
          '</div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;">' +
          '<input type="file" id="emp_replyFile" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" style="display:none;" onchange="(function(i){var l=document.getElementById(\'emp_replyFileLabel\');if(l)l.textContent=i.files[0]?(i.files[0].name.length>20?i.files[0].name.substring(0,20)+\'...\':i.files[0].name):(window.t?t(\'txn.attachFile\'):\'إرفاق ملف\');})(this)">' +
          '<button type="button" onclick="document.getElementById(\'emp_replyFile\').click()" style="padding:9px 14px;border-radius:10px;background:#fff;color:' + (isMyTurn ? '#15803d' : '#8b5cf6') + ';border:1.5px solid ' + (isMyTurn ? '#86efac' : '#c4b5fd') + ';font-weight:800;font-size:12px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-paperclip"></i><span id="emp_replyFileLabel">' + fileLabelDefault + '</span></button>' +
          '<button onclick="empPostReply(\''+id+'\',' + (isMyTurn?'true':'false') + ')" id="emp_replySendBtn" style="flex:1;padding:11px 16px;border-radius:10px;' + btnBg + 'color:#fff;border:none;font-weight:900;font-size:13px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 2px 6px rgba(0,0,0,.12);">' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
      // V4.5/V5-UX: populate recipient picker with GROUPED relevant users.
      // Loaded via callAPI immediately (no setTimeout race), with retry on failure
      // and a valid set of usernames cached on the element for client-side validation.
      if (isMyTurn) {
        var _doFetchRecipients = function(retry){
          callAPI('GET', '/workflow/routable-users?username=' + encodeURIComponent(currentUser), null, function(resp) {
            var sel = document.getElementById('emp_replyForwardTo');
            var hint = document.getElementById('emp_replyRecipHint');
            if (!sel) return;
            if (!resp || !Array.isArray(resp.groups)) {
              if (!retry) { setTimeout(function(){ _doFetchRecipients(true); }, 1500); return; }
              sel.innerHTML = '<option value="">▶ التالي في السلسلة (افتراضي)</option>' +
                '<option value="" disabled>⚠ تعذّر تحميل قائمة المستلمين</option>';
              return;
            }
            var validUsernames = {};
            var html = '<option value="">▶ التالي في السلسلة (افتراضي)</option>';
            var totalUsers = 0;
            resp.groups.forEach(function(g) {
              if (!g.users || !g.users.length) return;
              html += '<optgroup label="' + _esc(g.label) + ' (' + g.users.length + ')">';
              g.users.forEach(function(u) {
                validUsernames[u.username] = true; totalUsers++;
                var label = u.fullName + (u.position ? ' — ' + u.position : '') + (u.branch ? ' · ' + u.branch : '');
                html += '<option value="' + _esc(u.username) + '">' + _esc(label) + '</option>';
              });
              html += '</optgroup>';
            });
            sel.innerHTML = html;
            // Cache valid set for empPostReply validation
            sel._validUsernames = validUsernames;
            if (hint) hint.style.display = totalUsers > 0 ? 'block' : 'none';
            if (totalUsers === 0) {
              sel.innerHTML += '<option value="" disabled>لا يوجد مستلمون مؤهلون — سيُرسل للتالي افتراضياً</option>';
            }
          });
        };
        _doFetchRecipients(false);
      }
    } else {
      h += '<div style="margin-top:12px;padding:12px;background:#f0f9ff;border:1.5px dashed #bae6fd;border-radius:10px;color:#0369a1;font-size:12px;font-weight:700;text-align:center;"><i class="fas fa-circle-check"></i> لقد رددت على هذه المرحلة من قبل — رد واحد لكل مرحلة</div>';
    }
    h += '</div>';

    setTimeout(function(){ var ta = document.getElementById('emp_replyText'); if (ta) ta.placeholder = isMyTurn ? 'اكتب ردك على المعاملة...' : t('txn.replyPlaceholder'); }, 0);

    // 6. TOGGLE BUTTON — translated label
    var hasWorkflow = (txn.workflowPath && txn.workflowPath.length) || (txn.logs && txn.logs.length) || (txn.recipients && txn.recipients.length);
    if (hasWorkflow) {
      h += '<button onclick="toggleWorkflowView()" id="wfToggleBtn" style="width:100%;padding:13px;border-radius:12px;border:1.5px dashed #8b5cf6;background:#faf5ff;color:#6d28d9;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px;">' +
        '<i class="fas fa-route"></i><span id="wfToggleLabel">' + t('txn.showWorkflow') + '</span><i class="fas fa-chevron-down" id="wfToggleChevron" style="font-size:11px;transition:transform .2s;"></i>' +
      '</button>';
    }

    // 7. WORKFLOW SECTION — hidden by default
    h += '<div id="wfDetailWrap" style="display:none;">';
    // (Workflow path stepper intentionally hidden — per user request, not
    // shown to anyone. Only the action log + recipients + 'stopped at'
    // banner above are surfaced.)

    // 7b. Recipients — translated header
    if (Array.isArray(txn.recipients) && txn.recipients.length) {
      h += '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:10px;background:#fff;">' +
        '<div style="font-size:10px;color:#64748b;font-weight:800;margin-bottom:6px;"><i class="fas fa-paper-plane"></i> ' + t('txn.recipients') + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
      txn.recipients.forEach(function(r) {
        h += '<span style="padding:4px 10px;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:11px;">' +
          (r.code?'<code style="font-size:9px;color:#64748b;">'+_esc(r.code)+'</code> ':'') +
          '<b>'+_esc(r.name||r.username||'')+'</b>' +
          (r.responseReceived?' <i class="fas fa-check" style="color:#16a34a;"></i>':'') +
        '</span>';
      });
      h += '</div></div>';
    }

    // 7c. Detailed timeline — who replied with what + attachments
    if (txn.logs && txn.logs.length) {
      var aMap = { create: t('txn.action.create'), approve: t('txn.action.approve'), reject: t('txn.action.reject'), return: t('txn.action.return'), close: t('txn.action.close'), forward: t('txn.action.forward') };
      var aClr = { create:'#0ea5e9', approve:'#10b981', reject:'#ef4444', return:'#f97316', close:'#6b7280', forward:'#8b5cf6' };
      var aIcon = { create:'fa-plus-circle', approve:'fa-check-circle', reject:'fa-times-circle', return:'fa-undo', close:'fa-lock', forward:'fa-share' };
      var dtLocale = currentLang === 'en' ? 'en-US' : 'ar-SA-u-nu-latn';
      h += '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px;background:#fff;">';
      h += '<div style="font-size:11px;font-weight:900;color:#0f172a;margin-bottom:10px;"><i class="fas fa-clock-rotate-left" style="color:#8b5cf6;margin-left:4px;"></i> ' + t('txn.workflowLog') + '</div>';
      txn.logs.forEach(function(l, i) {
        var c = aClr[l.actionType]||'#6b7280';
        var icon = aIcon[l.actionType]||'fa-circle';
        var label = aMap[l.actionType]||l.actionType;
        var dt = '';
        if (l.createdAt) { try { dt = new Date(l.createdAt).toLocaleString(dtLocale,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(_){} }
        var isLast = i === txn.logs.length - 1;
        // V4.2: paperclip badge on timeline circle if step has attachment
        var hasAttach = l.attachment && l.attachment.startsWith && l.attachment.startsWith('data:');
        h += '<div style="display:flex;gap:10px;position:relative;">';
        h += '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;position:relative;">' +
          '<div style="width:36px;height:36px;border-radius:50%;background:'+c+'18;display:flex;align-items:center;justify-content:center;border:2px solid '+c+';position:relative;"><i class="fas '+icon+'" style="font-size:14px;color:'+c+';"></i>' +
          (hasAttach ? '<span style="position:absolute;top:-4px;inset-inline-end:-6px;width:18px;height:18px;border-radius:50%;background:#0ea5e9;color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.2);" title="يحتوي على مرفق"><i class="fas fa-paperclip"></i></span>' : '') +
          '</div>';
        if (!isLast) h += '<div style="width:2px;flex:1;background:'+c+'30;min-height:24px;"></div>';
        h += '</div>';
        h += '<div style="flex:1;padding-bottom:'+(isLast?'0':'14')+'px;min-width:0;">';
        h += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span style="font-size:13px;font-weight:900;color:'+c+';">'+_esc(label)+'</span>' +
             (hasAttach ? '<span style="font-size:9.5px;color:#0369a1;background:#e0f2fe;padding:2px 7px;border-radius:999px;font-weight:800;border:1px solid #bae6fd;"><i class="fas fa-paperclip" style="font-size:8px;"></i> مرفق</span>' : '<span style="font-size:9.5px;color:#94a3b8;background:#f1f5f9;padding:2px 7px;border-radius:999px;font-weight:700;"><i class="fas fa-paperclip-vertical" style="font-size:8px;"></i> بدون مرفق</span>') +
             '</div>';
        h += '<div style="font-size:11.5px;color:#1e293b;font-weight:700;margin-top:2px;">'+_esc(l.actionBy||'—')+(l.positionName?' <span style="color:#8b5cf6;font-weight:700;">— '+_esc(l.positionName)+'</span>':'')+'</div>';
        if (l.note) {
          h += '<div style="font-size:12px;color:#334155;margin-top:6px;padding:8px 10px;border-radius:8px;background:#f8fafc;border:1px solid #f1f5f9;line-height:1.6;word-break:break-word;overflow-wrap:anywhere;">' +
            '<div style="font-size:9px;font-weight:800;color:#64748b;text-transform:uppercase;margin-bottom:3px;letter-spacing:.04em;"><i class="fas fa-quote-right"></i> ' + t('txn.replyDeptHeader') + '</div>' +
            _esc(l.note) +
          '</div>';
        }
        if (l.attachment && l.attachment.startsWith && l.attachment.startsWith('data:')) {
          var attIsImg = l.attachment.startsWith('data:image/');
          h += '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;">';
          if (attIsImg) {
            h += '<img src="'+l.attachment+'" style="max-width:200px;max-height:140px;border-radius:6px;border:1px solid #cbd5e1;cursor:zoom-in;" onclick="window.open(this.src,\'_blank\')">';
          }
          h += '<div style="display:flex;gap:6px;align-items:center;font-size:10.5px;flex-wrap:wrap;">' +
            '<span style="color:#64748b;font-weight:700;"><i class="fas fa-paperclip"></i> ' + t('txn.fromDept') + ' ' + _esc(l.actionBy || t('role.user')) + ':</span>' +
            '<button onclick="window.open(\''+l.attachment+'\',\'_blank\')" style="background:#1e40af;color:#fff;border:none;padding:3px 9px;border-radius:5px;cursor:pointer;font-weight:700;font-size:10px;display:inline-flex;align-items:center;gap:3px;font-family:inherit;"><i class="fas fa-eye"></i> ' + t('txn.viewAttach') + '</button>' +
            '<a href="'+l.attachment+'" download style="background:#16a34a;color:#fff;text-decoration:none;padding:3px 9px;border-radius:5px;font-weight:700;font-size:10px;display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-download"></i> ' + t('txn.downloadAttach') + '</a>' +
          '</div></div>';
        }
        if (dt) h += '<div style="font-size:10px;color:#94a3b8;margin-top:4px;"><i class="far fa-clock"></i> '+dt+'</div>';
        h += '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>'; // end #wfDetailWrap

    // ─── Action buttons (visible only to the creator + when editable) ───
    // V3.1: Returned-for-edit gets a prominent Resubmit treatment.
    // Edit/Cancel disappear once others have acted (workflow has moved past creator).
    var isCreator = (txn.createdBy === currentUser);
    var canEditFresh = isCreator && (txn.status === 'pending' || txn.status === 'draft');
    var canEditReturned = isCreator && txn.status === 'returned';
    var hasOthersActed = (txn.logs || []).some(function(l){ return l.actionType && l.actionType !== 'create' && l.actionBy !== currentUser; });
    if (hasOthersActed && canEditFresh) canEditFresh = false;
    if (canEditReturned) {
      // Highlight the Resubmit button — translated
      h += '<div class="td-action-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">' +
        '<button class="td-edit-btn" style="flex:2;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;border:none;font-weight:900;padding:14px;font-size:14px;border-radius:12px;box-shadow:0 4px 12px rgba(220,38,38,.3);cursor:pointer;font-family:inherit;" onclick="closeTxnDetail();empEditTxn(\''+_esc(txn.id)+'\')"><i class="fas fa-pen-to-square"></i> ' + t('txn.editAndResubmit') + '</button>' +
        '<button class="td-cancel-btn" style="flex:1;" onclick="empCancelTxn(\''+_esc(txn.id)+'\')"><i class="fas fa-trash"></i> ' + t('txn.cancel') + '</button>' +
        '<button class="td-close-btn" onclick="closeTxnDetail()">' + t('common.cancelBtn') + '</button>' +
      '</div>';
    } else if (canEditFresh) {
      h += '<div class="td-action-btns">' +
        '<button class="td-edit-btn" onclick="closeTxnDetail();empEditTxn(\''+_esc(txn.id)+'\')"><i class="fas fa-edit"></i> تعديل المعاملة</button>' +
        '<button class="td-cancel-btn" onclick="empCancelTxn(\''+_esc(txn.id)+'\')"><i class="fas fa-trash"></i> إلغاء</button>' +
        '<button class="td-close-btn" onclick="closeTxnDetail()">إغلاق</button>' +
      '</div>';
    } else {
      h += '<div class="td-action-btns"><button class="td-close-btn" style="flex:1;" onclick="closeTxnDetail()">إغلاق</button></div>';
    }

    // V4.6 — Replace the body with the new formal letter-style view
    // The 'h' variable above contains buttons + replies form which we keep,
    // but the main content rendering switches to TxnLetterView.
    var letterHtml = (window.TxnLetterView && typeof window.TxnLetterView.render === 'function')
      ? window.TxnLetterView.render(txn)
      : h;   // fallback to old design if shared script not loaded

    // Extract just the action buttons + reply form from old `h` (everything after marker)
    // Strategy: render letter view on top, then keep the original action buttons block at the bottom
    var actionButtonsHtml = '';
    var actionMatch = h.match(/<div class="td-action-btns"[\s\S]*$/);
    if (actionMatch) actionButtonsHtml = actionMatch[0];

    // Reply form must also be preserved (it has interactive elements + IDs)
    var replyFormHtml = '';
    var replyMatch = h.match(/<div[^>]*id="emp_replyBox"[\s\S]*?(?=<div class="td-action-btns"|$)/);
    if (replyMatch) replyFormHtml = replyMatch[0];

    document.getElementById('txnDetailTitle').textContent = (txn.subject || txn.title || txn.txnNumber || '');
    document.getElementById('txnDetailBody').innerHTML =
      letterHtml +
      replyFormHtml +
      actionButtonsHtml;
    document.getElementById('txnDetailModal').classList.add('show');
    setTimeout(function(){ try { empLoadReplies(id); } catch(e){ console.warn('replies load err:', e); } }, 50);
  });
}

window.toggleWorkflowView = function() {
  var wrap = document.getElementById('wfDetailWrap');
  var lbl  = document.getElementById('wfToggleLabel');
  var chev = document.getElementById('wfToggleChevron');
  var btn  = document.getElementById('wfToggleBtn');
  if (!wrap) return;
  var isHidden = wrap.style.display === 'none';
  wrap.style.display = isHidden ? '' : 'none';
  if (lbl) lbl.textContent = isHidden ? t('txn.hideWorkflow') : t('txn.showWorkflow');
  if (chev) chev.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
  if (btn) btn.style.background = isHidden ? '#ede9fe' : '#faf5ff';
};
function closeTxnDetail() { document.getElementById('txnDetailModal').classList.remove('show'); }

// ═══════════════════════════════════════════════════════════════════
// V3: Replies Thread (employee + admin shared logic)
// ═══════════════════════════════════════════════════════════════════
// V3.1: Professional reply card — gradient avatar, role badge, action color,
// timestamp, content bubble, image preview + view/download for attachments.
window.empLoadReplies = function(txnId, listElId, countElId) {
  listElId  = listElId  || 'emp_repliesList';
  countElId = countElId || 'emp_repliesCount';
  var url = '/api/workflow/transactions/' + txnId + '/replies';
  var token = localStorage.getItem('pos_token');
  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){return r.json();})
    .then(function(rows) {
      if (!Array.isArray(rows)) rows = [];
      var listEl = document.getElementById(listElId);
      var cntEl  = document.getElementById(countElId);
      if (cntEl) cntEl.textContent = t('txn.replyCount').replace('{n}', rows.length);
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px;font-size:12px;background:#fff;border:1px dashed #c4b5fd;border-radius:10px;"><i class="fas fa-comment-dots" style="font-size:28px;display:block;margin-bottom:8px;color:#c4b5fd;"></i>' + t('txn.noReplies') + '</div>';
        return;
      }
      // Role-aware avatar gradient + label + side-color — labels via i18n
      var roleStyles = {
        admin:    { grad: 'linear-gradient(135deg,#dc2626,#991b1b)', label: t('role.admin'), side: '#dc2626' },
        manager:  { grad: 'linear-gradient(135deg,#1e40af,#1e3a8a)', label: t('role.manager'), side: '#1e40af' },
        cashier:  { grad: 'linear-gradient(135deg,#16a34a,#15803d)', label: t('role.cashier'), side: '#16a34a' },
        custody:  { grad: 'linear-gradient(135deg,#d97706,#b45309)', label: t('role.custody'), side: '#d97706' },
        finance:  { grad: 'linear-gradient(135deg,#0369a1,#075985)', label: t('role.finance'), side: '#0369a1' },
        hr:       { grad: 'linear-gradient(135deg,#a855f7,#7e22ce)', label: t('role.hr'), side: '#a855f7' },
        inventory:{ grad: 'linear-gradient(135deg,#0d9488,#0f766e)', label: t('role.inventory'), side: '#0d9488' },
        purchasing:{ grad: 'linear-gradient(135deg,#ea580c,#c2410c)', label: t('role.purchasing'), side: '#ea580c' },
        employee: { grad: 'linear-gradient(135deg,#475569,#334155)', label: t('role.employee'), side: '#475569' }
      };
      var initials = function(s){ s = String(s||'').trim(); if (!s) return '؟'; var p = s.split(/\s+/); return ((p[0][0]||'') + (p[1]?p[1][0]:'')).toUpperCase(); };
      var dtLocale = currentLang === 'en' ? 'en-US' : 'ar-SA-u-nu-latn';
      listEl.innerHTML = rows.map(function(r, idx) {
        var dt = '';
        try { dt = new Date(r.createdAt).toLocaleString(dtLocale,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(e){}
        var rs = roleStyles[r.authorRole] || roleStyles.employee;
        var posLbl = r.authorPosition ? _esc(r.authorPosition) : (rs.label || t('role.user'));
        var isMine = (r.authorUsername === currentUser);
        // Attachment block — image preview + view/download with i18n
        var att = '';
        if (r.attachment && String(r.attachment).indexOf('data:') === 0) {
          var isImg = String(r.attachment).indexOf('data:image/') === 0;
          var fname = r.attachmentName ? _esc(r.attachmentName) : t('txn.attached');
          att = '<div style="margin-top:10px;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">';
          if (isImg) {
            att += '<img src="'+r.attachment+'" style="max-width:100%;max-height:240px;border-radius:8px;border:1px solid #cbd5e1;display:block;margin-bottom:8px;cursor:zoom-in;" onclick="window.open(this.src,\'_blank\')" alt="'+fname+'">';
          }
          att += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<i class="fas fa-paperclip" style="color:#64748b;font-size:11px;"></i>' +
            '<span style="font-size:11px;color:#475569;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + fname + '</span>' +
            '<button onclick="window.open(\''+r.attachment+'\',\'_blank\')" style="background:#1e40af;color:#fff;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:11px;display:inline-flex;align-items:center;gap:4px;font-family:inherit;"><i class="fas fa-eye"></i> ' + t('txn.viewAttach') + '</button>' +
            '<a href="'+r.attachment+'" download="'+fname+'" style="background:#16a34a;color:#fff;text-decoration:none;padding:5px 10px;border-radius:6px;font-weight:700;font-size:11px;display:inline-flex;align-items:center;gap:4px;"><i class="fas fa-download"></i> ' + t('txn.downloadAttach') + '</a>' +
          '</div></div>';
        }
        return '<div style="display:flex;gap:10px;padding:12px;background:#fff;border:1px solid #e5e7eb;border-right:3px solid '+rs.side+';border-radius:12px;margin-bottom:10px;'+(isMine ? 'background:linear-gradient(180deg,#fafbff 0%,#fff 100%);' : '')+'box-shadow:0 1px 3px rgba(15,23,42,.04);">' +
          '<div style="width:40px;height:40px;border-radius:50%;background:'+rs.grad+';color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:900;font-size:13px;letter-spacing:-0.5px;box-shadow:0 2px 6px rgba(0,0,0,.1);">' + _esc(initials(r.authorName||r.authorUsername)) + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
              '<span style="font-weight:900;font-size:13px;color:#0f172a;">' + _esc(r.authorName||r.authorUsername||'') + '</span>' +
              (isMine ? '<span style="font-size:9px;color:#0ea5e9;background:#e0f2fe;padding:1px 6px;border-radius:6px;font-weight:800;">' + t('txn.me') + '</span>' : '') +
              '<span style="font-size:10px;font-weight:800;color:#fff;background:'+rs.side+';padding:2px 8px;border-radius:6px;"><i class="fas fa-user-tag" style="font-size:8px;margin-inline-end:3px;"></i>' + _esc(posLbl) + '</span>' +
              '<span style="margin-inline-start:auto;font-size:10px;color:#94a3b8;font-weight:600;"><i class="far fa-clock" style="margin-inline-end:3px;"></i>' + dt + '</span>' +
            '</div>' +
            '<div style="font-size:13.5px;color:#334155;line-height:1.75;margin-top:6px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;background:#f8fafc;padding:10px 12px;border-radius:8px;border:1px solid #f1f5f9;">' + _esc(r.replyText||'') + '</div>' +
            att +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function(err) {
      console.error('[empLoadReplies] err:', err);
      var listEl = document.getElementById(listElId);
      if (listEl) listEl.innerHTML = '<div style="text-align:center;color:#dc2626;padding:14px;font-size:12px;">فشل تحميل الردود</div>';
    });
};

// V4.3: empPostReply — Optimistic UI (reply appears IMMEDIATELY) + auto-advance
// 1. Renders user's reply in the list FIRST (with "sending..." indicator)
// 2. Sends to server in background
// 3. On success: confirms the reply (removes pending state)
// 4. On failure: removes optimistic reply + shows error + re-enables form
window.empPostReply = function(txnId, andAdvance) {
  var ta = document.getElementById('emp_replyText');
  var btn = document.getElementById('emp_replySendBtn');
  if (!ta) return;
  var text = (ta.value || '').trim();
  if (!text) { glassToast('اكتب نص الرد', true); return; }
  var fileInput = document.getElementById('emp_replyFile');
  var hasFile = fileInput && fileInput.files && fileInput.files[0];
  var fileName = hasFile ? fileInput.files[0].name : null;

  // ─── OPTIMISTIC UI: render user's reply IMMEDIATELY ───
  var optimisticId = 'optimistic-' + Date.now();
  var listEl = document.getElementById('emp_repliesList');
  if (listEl) {
    // Remove "no replies yet" empty state if present
    if (listEl.innerHTML.indexOf('comment-dots') >= 0 || listEl.innerHTML.indexOf('comment-slash') >= 0) {
      listEl.innerHTML = '';
    }
    var initials = (currentUser || '?').substring(0,2).toUpperCase();
    var nowDt = new Date().toLocaleString('ar-SA-u-nu-latn',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    var optimisticHtml =
      '<div id="' + optimisticId + '" style="display:flex;gap:10px;padding:12px;background:#fff;border:1px solid #e5e7eb;border-right:3px solid #16a34a;border-radius:12px;margin-bottom:10px;background:linear-gradient(180deg,#f0fdf4 0%,#fff 100%);box-shadow:0 1px 3px rgba(15,23,42,.04);opacity:0.85;position:relative;">' +
        '<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:900;font-size:13px;letter-spacing:-0.5px;">' + _esc(initials) + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-weight:900;font-size:13px;color:#0f172a;">' + _esc(currentUser) + '</span>' +
            '<span style="font-size:9px;color:#0ea5e9;background:#e0f2fe;padding:1px 6px;border-radius:6px;font-weight:800;">أنا</span>' +
            '<span style="font-size:10px;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:6px;"><i class="fas fa-spinner fa-spin"></i> جاري الإرسال...</span>' +
            '<span style="margin-inline-start:auto;font-size:10px;color:#94a3b8;">' + nowDt + '</span>' +
          '</div>' +
          '<div style="font-size:13.5px;color:#334155;line-height:1.75;margin-top:6px;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:10px 12px;border-radius:8px;border:1px solid #f1f5f9;">' + _esc(text) + '</div>' +
          (hasFile ? '<div style="margin-top:6px;font-size:11px;color:#64748b;"><i class="fas fa-paperclip"></i> ' + _esc(fileName) + ' (' + Math.round(fileInput.files[0].size/1024) + ' KB)</div>' : '') +
        '</div>' +
      '</div>';
    listEl.insertAdjacentHTML('beforeend', optimisticHtml);
    // Auto-scroll to the new reply
    var newEl = document.getElementById(optimisticId);
    if (newEl && newEl.scrollIntoView) newEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Disable form immediately
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.style.cursor = 'not-allowed'; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  if (ta) { ta.disabled = true; ta.value = ''; }

  var token = localStorage.getItem('pos_token') || localStorage.getItem('emp_token');
  var reEnable = function() {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = 'pointer'; btn.innerHTML = (andAdvance ? '<i class="fas fa-paper-plane"></i> رد + موافقة وتحويل للتالي' : '<i class="fas fa-comment"></i> إرسال الرد'); }
    if (ta) { ta.disabled = false; ta.value = text; }
    var optEl = document.getElementById(optimisticId);
    if (optEl) optEl.remove();
  };

  // V4.5/V5-UX: read explicit recipient (only present when user is current assignee)
  // V5-UX: validate against the cached valid usernames set populated when the picker loaded.
  var fwdSel = document.getElementById('emp_replyForwardTo');
  var explicitForwardTo = (fwdSel && fwdSel.value) ? fwdSel.value : null;
  if (explicitForwardTo && fwdSel && fwdSel._validUsernames && !fwdSel._validUsernames[explicitForwardTo]) {
    var optEl4 = document.getElementById(optimisticId);
    if (optEl4) optEl4.remove();
    reEnable();
    glassToast('المستلم المحدد غير صالح — حدّد الصفحة وأعد المحاولة', true);
    return;
  }
  var doSend = function(attachment, attachmentName, attachmentMime) {
    // V4.5.2: AbortController with 90s timeout — never hang forever
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutHandle = controller ? setTimeout(function(){
      controller.abort();
      console.warn('[reply] timed out after 90s');
    }, 90000) : null;

    // Update spinner text periodically so user knows it's still working
    // V5-UX: include file-size hint when uploading large attachments
    var spinnerStart = Date.now();
    var fileSizeHint = (hasFile && fileInput.files[0])
      ? ' (' + Math.round(fileInput.files[0].size / 1024) + ' KB)' : '';
    var spinnerInterval = setInterval(function() {
      if (!btn) return;
      var secs = Math.floor((Date.now() - spinnerStart) / 1000);
      var hint = secs > 30 ? ' — قد يستغرق وقتاً بسبب المرفق' + fileSizeHint : '';
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإرسال... ' + secs + 'ث' + hint;
    }, 1000);
    var clearSpinner = function() { clearInterval(spinnerInterval); if (timeoutHandle) clearTimeout(timeoutHandle); };

    // V5-UX: idempotency key — guards against double-send on flaky networks.
    // Server can dedupe by this key; even if not, the optimistic UI prevents UI dup.
    var idemKey = 'reply-' + txnId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    fetch('/api/workflow/transactions/' + txnId + '/replies', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idemKey
      },
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        replyText: text, username: currentUser,
        attachment: attachment || null,
        attachmentName: attachmentName || null,
        attachmentMime: attachmentMime || null,
        andAdvance: !!andAdvance,
        forwardTo: explicitForwardTo,
        idempotencyKey: idemKey
      })
    })
      .then(function(r){return r.json();})
      .then(function(r) {
        clearSpinner();
        if (r && r.success) {
          var optEl = document.getElementById(optimisticId);
          if (optEl) {
            optEl.style.opacity = '1';
            var sendingBadge = optEl.querySelector('span[style*="جاري الإرسال"]');
            if (sendingBadge) {
              sendingBadge.outerHTML = '<span style="font-size:10px;color:#16a34a;background:#dcfce7;padding:2px 8px;border-radius:6px;font-weight:800;"><i class="fas fa-check-circle"></i> تم الإرسال</span>';
            }
          }
          if (fileInput) fileInput.value = '';
          var fileLabel = document.getElementById('emp_replyFileLabel');
          if (fileLabel) fileLabel.textContent = 'إرفاق ملف';
          var form = document.getElementById('emp_replyForm');
          if (form) form.style.display = 'none';
          // V4.5.2: warn user if S3 had an issue (not blocking, but informative)
          if (r.s3Warning) {
            console.warn('[reply s3 warning]', r.s3Warning);
            // Don't toast — the attachment is still saved inline, no impact on user
          }
          if (r.advanceResult && r.advanceResult.newStatus) {
            glassToast('✓ تم الرد + انتقلت المعاملة لـ ' + (r.advanceResult.newAssignee || r.advanceResult.newStatus));
            setTimeout(function(){
              if (typeof loadIncomingTxns === 'function') loadIncomingTxns();
              if (typeof empRefreshCounters === 'function') empRefreshCounters();
            }, 200);
          } else if (r.advanceError) {
            glassToast('⚠️ الرد أُرسل لكن فشل التحريك: ' + r.advanceError, true);
            console.warn('[reply advance error]', r.advanceError);
          } else {
            glassToast('✓ تم إرسال الرد');
          }
        } else {
          var optEl2 = document.getElementById(optimisticId);
          if (optEl2) optEl2.remove();
          reEnable();
          glassToast((r && r.error) || 'فشل الإرسال', true);
        }
      })
      .catch(function(err) {
        clearSpinner();
        var optEl3 = document.getElementById(optimisticId);
        if (optEl3) optEl3.remove();
        reEnable();
        console.error('[empPostReply] err:', err);
        // V5-OFFLINE: if the device is offline, queue the reply for auto-retry.
        // If online but server fails, surface the error normally.
        var isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        if (isOffline || (err && err.name !== 'AbortError' && (!err.message || err.message.includes('NetworkError') || err.message.includes('Failed to fetch')))) {
          try {
            window._empOutboxQueue({
              url: '/api/workflow/transactions/' + txnId + '/replies',
              headers: { 'X-Idempotency-Key': idemKey },
              body: JSON.stringify({
                replyText: text, username: currentUser,
                attachment: attachment || null,
                attachmentName: attachmentName || null,
                attachmentMime: attachmentMime || null,
                andAdvance: !!andAdvance,
                forwardTo: explicitForwardTo,
                idempotencyKey: idemKey
              }),
              label: 'reply'
            });
            return;
          } catch(_qe) { /* fall through to normal error */ }
        }
        // V4.5.2: distinguish between abort (timeout) and other errors
        if (err && err.name === 'AbortError') {
          glassToast('⏱️ انتهت المهلة (90 ثانية) — جرب مرة أخرى أو قلل حجم المرفق', true);
        } else {
          glassToast('فشل الاتصال: ' + (err && err.message || 'unknown'), true);
        }
      });
  };
  if (hasFile) {
    var f = fileInput.files[0];
    if (f.size > 5 * 1024 * 1024) { var oe = document.getElementById(optimisticId); if (oe) oe.remove(); reEnable(); glassToast('حجم الملف يجب أن يكون أقل من 5MB', true); return; }
    var reader = new FileReader();
    reader.onload = function() { doSend(reader.result, f.name, f.type); };
    reader.onerror = function() { var oe2 = document.getElementById(optimisticId); if (oe2) oe2.remove(); reEnable(); glassToast('تعذّر قراءة الملف', true); };
    reader.readAsDataURL(f);
  } else {
    doSend(null, null, null);
  }
};

// ═══════════════════════════════════════════════════════════════════
// MY HOURS & PAY — overtime + late tracking page
// ═══════════════════════════════════════════════════════════════════
window._hoursState = { preset: 'thismonth', from: '', to: '' };
var _hoursPresetLabels = {
  thisweek:'هذا الأسبوع', thismonth:'هذا الشهر', lastmonth:'الشهر الماضي',
  last30:'آخر 30 يوم', last90:'آخر 90 يوم'
};

function _hoursResolveRange(preset) {
  var now = new Date();
  var ymd = function(d){ return d.toISOString().slice(0,10); };
  if (preset === 'thisweek') {
    var d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return { from: ymd(d), to: ymd(now) };
  }
  if (preset === 'thismonth') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (preset === 'lastmonth') {
    var s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var e = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: ymd(s), to: ymd(e) };
  }
  if (preset === 'last30') { var d = new Date(now); d.setDate(d.getDate() - 29); return { from: ymd(d), to: ymd(now) }; }
  if (preset === 'last90') { var d = new Date(now); d.setDate(d.getDate() - 89); return { from: ymd(d), to: ymd(now) }; }
  return { from: ymd(now), to: ymd(now) };
}

window.hoursSetPreset = function(p) {
  window._hoursState.preset = p;
  document.querySelectorAll('[data-hp]').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-hp') === p);
  });
  loadHoursPage();
};

function loadHoursPage() {
  var range = _hoursResolveRange(window._hoursState.preset);
  window._hoursState.from = range.from;
  window._hoursState.to   = range.to;
  var lbl = document.getElementById('hoursRangeLabel');
  if (lbl) lbl.textContent = range.from + ' → ' + range.to;
  // Show loading state
  var tbl = document.getElementById('hoursTable');
  if (tbl) tbl.innerHTML = '<div class="empty"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';

  callAPI('GET', '/hr/my-hours-summary?username=' + encodeURIComponent(currentUser) + '&from=' + range.from + '&to=' + range.to, null, function(d) {
    if (!d || d.success === false) {
      var msg = (d && d.error) || 'فشل تحميل البيانات';
      if (tbl) tbl.innerHTML = '<div class="empty" style="color:#ef4444;"><i class="fas fa-triangle-exclamation"></i> ' + msg + '</div>';
      // Clear KPIs
      ['hkpiOTHours','hkpiOTValue','hkpiLateHours','hkpiLateValue'].forEach(function(id){ var e=document.getElementById(id); if (e) e.textContent='—'; });
      return;
    }
    _hoursRender(d);
  });
}

function _hoursFmt(v, d) { return Number(v||0).toLocaleString('en', { minimumFractionDigits: d!=null?d:2, maximumFractionDigits: d!=null?d:2 }); }
function _hoursDeltaHtml(delta, invertColor) {
  var n = Number(delta || 0);
  if (Math.abs(n) < 0.5) return '<span style="color:#94a3b8;">— بدون تغيير</span>';
  var goingUp = n > 0;
  // For "late hours" / "late deduction", going UP is BAD; for "overtime", UP is GOOD
  var good = invertColor ? !goingUp : goingUp;
  var cls = good ? 'up' : 'down';
  var arrow = goingUp ? '<i class="fas fa-arrow-up"></i>' : '<i class="fas fa-arrow-down"></i>';
  return '<span class="'+cls+'">' + arrow + ' ' + (n>0?'+':'') + n.toFixed(1) + '%</span>';
}

function _hoursRender(d) {
  var tot = d.totals, prev = d.previousTotals, delt = d.deltas;
  // KPI values
  var setT = function(id, txt){ var e=document.getElementById(id); if (e) e.innerHTML = txt; };
  setT('hkpiOTHours',   _hoursFmt(tot.overtimeHours, 1) + '<small style="font-size:11px;color:#94a3b8;font-weight:600;margin-inline-start:4px;">س</small>');
  setT('hkpiOTValue',   _hoursFmt(tot.overtimeValue) + '<small style="font-size:11px;color:#94a3b8;font-weight:600;margin-inline-start:4px;">ر.س</small>');
  setT('hkpiLateHours', _hoursFmt(tot.lateHours, 1) + '<small style="font-size:11px;color:#94a3b8;font-weight:600;margin-inline-start:4px;">س</small>');
  setT('hkpiLateValue', _hoursFmt(tot.lateValue) + '<small style="font-size:11px;color:#94a3b8;font-weight:600;margin-inline-start:4px;">ر.س</small>');

  // Delta sub-labels (relative to previous identical-length window)
  var sub = function(id, html, cls){
    var e = document.getElementById(id);
    if (e) { e.className = 'hours-kpi-sub ' + (cls||''); e.innerHTML = html; }
  };
  // Compute per-tile direction class for the parent .hours-kpi-sub
  function dCls(n, invertColor){
    if (Math.abs(n) < 0.5) return '';
    var good = invertColor ? n < 0 : n > 0;
    return good ? 'up' : 'down';
  }
  sub('hkpiOTHoursDelta', _hoursDeltaHtml(delt.overtimeHours, false) + ' <span style="color:#94a3b8;">vs الفترة السابقة</span>', dCls(delt.overtimeHours, false));
  sub('hkpiOTValueDelta', _hoursDeltaHtml(delt.overtimeValue, false) + ' <span style="color:#94a3b8;">vs الفترة السابقة</span>', dCls(delt.overtimeValue, false));
  sub('hkpiLateHoursDelta', _hoursDeltaHtml(delt.lateHours, true) + ' <span style="color:#94a3b8;">vs الفترة السابقة</span>', dCls(delt.lateHours, true));
  sub('hkpiLateValueDelta', _hoursDeltaHtml(delt.lateValue, true) + ' <span style="color:#94a3b8;">vs الفترة السابقة</span>', dCls(delt.lateValue, true));

  // Net impact card
  var netVal = document.getElementById('hoursNetVal');
  var netSub = document.getElementById('hoursNetSub');
  var netCard = document.getElementById('hoursNetCard');
  var net = Number(tot.netImpact || 0);
  if (netVal) {
    netVal.textContent = (net >= 0 ? '+' : '') + _hoursFmt(net) + ' ر.س';
    netVal.style.color = net > 0 ? '#16a34a' : (net < 0 ? '#ef4444' : '#475569');
  }
  if (netSub) netSub.textContent = (net > 0 ? 'مكاسب صافية من الإضافي بعد خصم التأخير' : (net < 0 ? 'خصم صافي من الراتب' : 'متعادل — لا تأثير على الراتب'));
  if (netCard) {
    netCard.style.background = net > 0 ? 'linear-gradient(135deg,#dcfce7,#fff)' :
                              (net < 0 ? 'linear-gradient(135deg,#fee2e2,#fff)' :
                                         '#fff');
  }
  var rateVal = document.getElementById('hoursRateVal');
  if (rateVal) rateVal.textContent = _hoursFmt(d.employee.hourlyRate) + ' ر.س';

  // Days count
  var dc = document.getElementById('hoursDaysCount');
  if (dc) dc.textContent = (d.rows||[]).length + ' يوم';

  // Per-day table
  var tbl = document.getElementById('hoursTable');
  if (!tbl) return;
  if (!d.rows || !d.rows.length) {
    tbl.innerHTML = '<div class="empty"><i class="fas fa-inbox"></i> لا توجد سجلات حضور في هذه الفترة</div>';
    return;
  }
  tbl.innerHTML = d.rows.map(function(r){
    var dateLbl = r.date ? new Date(r.date).toLocaleDateString('en-GB', { weekday:'short', day:'2-digit', month:'2-digit' }) : '—';
    var times = '';
    if (r.clockIn) {
      var ci = new Date(r.clockIn).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      var co = r.clockOut ? new Date(r.clockOut).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}) : '—';
      times = ci + ' ← ' + co + ' (' + _hoursFmt(r.totalHours, 1) + ' س)';
    }
    var otPill = r.overtimeMinutes > 0 ?
      '<span class="hours-pill ot"><i class="fas fa-arrow-up"></i> +' + _hoursFmt(r.overtimeHours, 1) + ' س = ' + _hoursFmt(r.overtimeValue) + ' ر.س</span>' :
      '<span class="hours-pill zero">—</span>';
    var latePill = r.lateMinutes > 0 ?
      '<span class="hours-pill late"><i class="fas fa-arrow-down"></i> -' + _hoursFmt(r.lateHours, 1) + ' س = -' + _hoursFmt(r.lateValue) + ' ر.س</span>' :
      '<span class="hours-pill zero">—</span>';
    return '<div class="hours-row">' +
      '<div><div class="hours-row-date">'+dateLbl+'</div><div class="hours-row-meta">'+times+'</div></div>' +
      '<div class="hours-row-vals">' + otPill + latePill + '</div>' +
    '</div>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// TRANSACTION MODAL — draft persistence + importance card UI
// ═══════════════════════════════════════════════════════════════════
var _txnDraftKey = function() { return 'emp_txn_draft_' + (currentUser || 'anon'); };

window.txnSetImportance = function(level) {
  var hidden = document.getElementById('txnImportance');
  if (hidden) hidden.value = level;
  document.querySelectorAll('.tm-imp-card').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-imp') === level);
  });
  txnSaveDraft();
};

window.txnValidateTitle = function() {
  var v = document.getElementById('txnTitle').value.trim();
  var el = document.getElementById('txnTitleVal');
  if (!el) return;
  if (!v) { el.className = 'tm-validation'; el.textContent = ''; return; }
  if (v.length < 5) { el.className = 'tm-validation err'; el.textContent = '✗ العنوان قصير جداً (5 أحرف على الأقل)'; return; }
  el.className = 'tm-validation ok';
  el.textContent = '✓ عنوان صالح';
  // Update char counter on description as well
  var dEl = document.getElementById('txnDesc');
  var cEl = document.getElementById('txnDescCount');
  if (dEl && cEl) cEl.textContent = (dEl.value || '').length + ' / 2000';
};

window.txnSaveDraft = function() {
  try {
    var d = {
      type:       (document.getElementById('txnType')||{}).value || '',
      importance: (document.getElementById('txnImportance')||{}).value || 'medium',
      title:      (document.getElementById('txnTitle')||{}).value || '',
      desc:       (document.getElementById('txnDesc')||{}).value || '',
      accId:      (document.getElementById('txnAccId')||{}).value || '',
      accSearch:  (document.getElementById('txnAccSearch')||{}).value || '',
      cc:         (document.getElementById('txnCC')||{}).value || '',
      amount:     (document.getElementById('txnAmount')||{}).value || '',
      recipient:  (document.getElementById('txnRecipient')||{}).value || ''
    };
    localStorage.setItem(_txnDraftKey(), JSON.stringify(d));
  } catch(e) {}
  // Update char counter on each save
  var dEl = document.getElementById('txnDesc');
  var cEl = document.getElementById('txnDescCount');
  if (dEl && cEl) cEl.textContent = (dEl.value || '').length + ' / 2000';
};

window.txnLoadDraft = function() {
  try {
    var raw = localStorage.getItem(_txnDraftKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) { return null; }
};

window.txnDiscardDraft = function() {
  try { localStorage.removeItem(_txnDraftKey()); } catch(e) {}
  // Clear all fields
  ['txnTitle','txnDesc','txnAccSearch','txnAccId','txnAccName','txnAmount','txnFile'].forEach(function(id){
    var e = document.getElementById(id); if (e) { if (e.tagName === 'SELECT') e.value=''; else e.value=''; }
  });
  if (document.getElementById('txnImportance')) document.getElementById('txnImportance').value = 'medium';
  txnSetImportance('medium');
  if (document.getElementById('txnAmount')) document.getElementById('txnAmount').value = '0';
  var b = document.getElementById('txnDraftBanner'); if (b) b.style.display = 'none';
  toast('تم تفريغ المسودة');
};

// Wrap the original openTxnModal to also restore draft + show context badges
var _origOpenTxnModal = window.openTxnModal;
window.openTxnModal = function() {
  if (_origOpenTxnModal) _origOpenTxnModal();
  // Show brand + branch context badges
  var badges = document.getElementById('txnContextBadges');
  if (badges && empProfile) {
    var html = '';
    if (empProfile.branchName || empProfile.branch_name) {
      html += '<span class="tm-ctx-badge"><i class="fas fa-map-marker-alt"></i> ' + (empProfile.branchName || empProfile.branch_name || '') + '</span>';
    }
    if (empProfile.departmentName || empProfile.department_name) {
      html += '<span class="tm-ctx-badge" style="background:#fef3c7;color:#92400e;border-color:#fde68a;"><i class="fas fa-building"></i> ' + (empProfile.departmentName || empProfile.department_name || '') + '</span>';
    }
    badges.innerHTML = html;
  }
  // Restore draft
  setTimeout(function(){
    var d = txnLoadDraft();
    if (!d) return;
    var hasContent = d.title || d.desc || (d.amount && d.amount !== '0');
    if (!hasContent) return;
    var setVal = function(id, v){ var e=document.getElementById(id); if (e && v != null) e.value = v; };
    setVal('txnTitle', d.title);
    setVal('txnDesc', d.desc);
    setVal('txnAmount', d.amount);
    if (d.importance) txnSetImportance(d.importance);
    if (d.accSearch) setVal('txnAccSearch', d.accSearch);
    if (d.accId)     setVal('txnAccId', d.accId);
    var banner = document.getElementById('txnDraftBanner');
    if (banner) banner.style.display = 'flex';
    txnValidateTitle();
  }, 250);
};

// Auto-clear draft on successful submit (wraps _doTxn)
var _origDoTxn = window._doTxn;
window._doTxn = function(data) {
  toast(t('tm.sending'));
  callAPI('POST', '/workflow/transactions', data, function(r, e) {
    if (e) return toast(t('login.error') + ': ' + e, true);
    if (r && r.success) {
      // Clear draft on success
      try { localStorage.removeItem(_txnDraftKey()); } catch(_) {}
      var banner = document.getElementById('txnDraftBanner'); if (banner) banner.style.display = 'none';
      toast(t('tm.txnNumberCreated') + ': ' + (r.txnNumber||''));
      closeTxnModal();
      txnSwitchTab('out');
      loadMyTransactions();
    } else toast(r ? r.error : t('txn.failed'), true);
  });
};

// V5.4 — OVERRIDE viewMyTxn to use the unified TxnView modal.
// Employee gets fewer action buttons than admin (only reply/approve/reject/return for now).
(function(){
  var _legacy = window.viewMyTxn;
  window.viewMyTxn = function(id) {
    if (window.TxnView && typeof window.TxnView.open === 'function') {
      return window.TxnView.open(id, {
        actions: ['reply','return','reject','approve','forward'],
        onAction: function(act, ctx) {
          if (act === 'approve' || act === 'reject' || act === 'return') {
            ctx.close();
            setTimeout(function(){ if (typeof window.empAct === 'function') window.empAct(id, act); }, 80);
          } else if (act === 'forward') {
            ctx.close();
            setTimeout(function(){ if (typeof window.empFwd === 'function') window.empFwd(id); }, 80);
          } else if (act === 'reply') {
            ctx.close();
            // Open the legacy view which has the inline reply form
            setTimeout(function(){ if (typeof _legacy === 'function') _legacy(id); }, 80);
          }
        }
      });
    }
    return _legacy && _legacy(id);
  };
})();

