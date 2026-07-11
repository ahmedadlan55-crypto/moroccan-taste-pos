/**
 * Shared transaction constants & i18n labels — V5
 * Single source of truth for status/action/importance labels in BOTH languages.
 * Loaded by: admin (erp.js) + employee (app.js) + txn-letter.js
 *
 * Usage:
 *   TxnConst.statusLabel('pending')                    → 'قيد الانتظار'
 *   TxnConst.statusLabel('pending', 'en')              → 'Pending'
 *   TxnConst.statusBadge('approved')                   → '<span class="...">معتمدة</span>'
 *   TxnConst.actionLabel('return')                     → 'إعادة'
 *   TxnConst.MAX_REPLY_FILE_MB                         → 5
 */
(function(global){
  'use strict';
  if (global.TxnConst) return;

  // ─── File size limits (single source of truth) ───────────────────
  var MAX_TXN_FILE_MB    = 10;
  var MAX_REPLY_FILE_MB  = 5;
  var MAX_TXN_FILE_BYTES   = MAX_TXN_FILE_MB * 1024 * 1024;
  var MAX_REPLY_FILE_BYTES = MAX_REPLY_FILE_MB * 1024 * 1024;
  var REJECT_REASON_MIN_LEN = 10;
  var TXN_FETCH_TIMEOUT_MS  = 12000;
  var REPLY_FETCH_TIMEOUT_MS = 10000;
  var ACTION_TIMEOUT_MS = 90000;
  var INBOX_PAGE_SIZE = 100;

  // ─── Status (8 lifecycle states) ───────────────────────────────────
  var STATUS = {
    draft:       { ar: 'مسودة',       en: 'Draft',       kind: 'neutral', color: '#475569', bg: '#f1f5f9' },
    created:     { ar: 'مرسلة',        en: 'Created',     kind: 'info',    color: '#0369a1', bg: '#e0f2fe' },
    pending:     { ar: 'قيد الانتظار', en: 'Pending',     kind: 'warning', color: '#92400e', bg: '#fef3c7' },
    in_progress: { ar: 'قيد المعالجة', en: 'In Progress', kind: 'info',    color: '#1d4ed8', bg: '#dbeafe' },
    replied:     { ar: 'تمّ الرد',     en: 'Replied',     kind: 'purple',  color: '#155e75', bg: '#e6f3f7' },
    returned:    { ar: 'مرجعة',        en: 'Returned',    kind: 'warning', color: '#9a3412', bg: '#ffedd5' },
    approved:    { ar: 'معتمدة',       en: 'Approved',    kind: 'success', color: '#15803d', bg: '#dcfce7' },
    rejected:    { ar: 'مرفوضة',       en: 'Rejected',    kind: 'danger',  color: '#991b1b', bg: '#fee2e2' },
    closed:      { ar: 'مغلقة',        en: 'Closed',      kind: 'neutral', color: '#1e293b', bg: '#cbd5e1' },
    cancelled:   { ar: 'ملغية',        en: 'Cancelled',   kind: 'neutral', color: '#64748b', bg: '#f1f5f9' }
  };

  // ─── Actions (workflow-advancing) ──────────────────────────────────
  var ACTION = {
    create:   { ar: 'إنشاء',     en: 'Create',   icon: 'fa-plus',         color: '#0ea5e9' },
    open:     { ar: 'فتح',       en: 'Open',     icon: 'fa-folder-open',  color: '#0ea5e9' },
    approve:  { ar: 'اعتماد',    en: 'Approve',  icon: 'fa-check',        color: '#16a34a' },
    reject:   { ar: 'رفض',       en: 'Reject',   icon: 'fa-times',        color: '#dc2626' },
    return:   { ar: 'إعادة',     en: 'Return',   icon: 'fa-undo',         color: '#f59e0b' },
    forward:  { ar: 'تحويل',     en: 'Forward',  icon: 'fa-share',        color: '#0e7490' },
    reply:    { ar: 'رد',        en: 'Reply',    icon: 'fa-comment',      color: '#0ea5e9' },
    resubmit: { ar: 'إعادة الإرسال', en: 'Resubmit', icon: 'fa-paper-plane', color: '#0ea5e9' },
    close:    { ar: 'إغلاق',     en: 'Close',    icon: 'fa-lock',         color: '#475569' },
    cancel:   { ar: 'إلغاء',     en: 'Cancel',   icon: 'fa-ban',          color: '#64748b' }
  };

  // ─── Importance ────────────────────────────────────────────────────
  var IMPORTANCE = {
    critical: { ar: 'حرجة', en: 'Critical', color: '#dc2626', bg: '#fee2e2' },
    high:     { ar: 'عالية', en: 'High',    color: '#ea580c', bg: '#ffedd5' },
    medium:   { ar: 'عادية', en: 'Medium',  color: '#0369a1', bg: '#e0f2fe' },
    low:      { ar: 'منخفضة', en: 'Low',    color: '#475569', bg: '#f1f5f9' }
  };

  // Detect the current language preference (admin sets `pos_lang`, employee `emp_lang`)
  function _lang(forceLang){
    if (forceLang) return forceLang;
    try {
      var l = localStorage.getItem('pos_lang') || localStorage.getItem('emp_lang') || 'ar';
      return (l === 'en' ? 'en' : 'ar');
    } catch(_) { return 'ar'; }
  }

  // v6.4 — normalize key: server sometimes returns 'Pending' / 'In Progress'
  // (PascalCase or with spaces) while the STATUS map uses snake_case lower.
  // Normalize before lookup so badges always render the Arabic label.
  function _normStatus(k){
    if (k == null) return '';
    return String(k).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
  }

  function statusLabel(key, lang){
    var s = STATUS[_normStatus(key)];
    if (!s) return String(key||'');
    return s[_lang(lang)] || s.ar;
  }
  function actionLabel(key, lang){
    var a = ACTION[_normStatus(key)];
    if (!a) return String(key||'');
    return a[_lang(lang)] || a.ar;
  }
  function importanceLabel(key, lang){
    var i = IMPORTANCE[_normStatus(key)];
    if (!i) return String(key||'');
    return i[_lang(lang)] || i.ar;
  }

  function statusBadge(key, lang){
    var s = STATUS[_normStatus(key)];
    if (!s) return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#f1f5f9;color:#475569;">'+_esc(key)+'</span>';
    return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:'+s.bg+';color:'+s.color+';" aria-label="'+_esc(statusLabel(key,lang))+'">'+_esc(statusLabel(key,lang))+'</span>';
  }

  function importanceBadge(key, lang){
    var i = IMPORTANCE[_normStatus(key)];
    if (!i) return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800;background:#f1f5f9;color:#475569;">'+_esc(key)+'</span>';
    return '<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800;background:'+i.bg+';color:'+i.color+';" aria-label="'+_esc(importanceLabel(key,lang))+'">'+_esc(importanceLabel(key,lang))+'</span>';
  }

  function _esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  // V5-DATE: unified Hijri/Gregorian formatter — both portals were using different formats.
  function fmtDate(d, lang, opts){
    if (!d) return '—';
    try {
      var dt = (d instanceof Date) ? d : new Date(d);
      if (isNaN(dt.getTime())) return '—';
      var l = _lang(lang);
      var locale = (l === 'en') ? 'en-GB' : 'ar-SA-u-nu-latn';
      return dt.toLocaleDateString(locale, opts || {year:'numeric', month:'short', day:'2-digit'});
    } catch(_) { return String(d); }
  }
  function fmtDateTime(d, lang){
    if (!d) return '—';
    try {
      var dt = (d instanceof Date) ? d : new Date(d);
      if (isNaN(dt.getTime())) return '—';
      var l = _lang(lang);
      var locale = (l === 'en') ? 'en-GB' : 'ar-SA-u-nu-latn';
      return dt.toLocaleString(locale, {day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'});
    } catch(_) { return String(d); }
  }

  global.TxnConst = {
    STATUS: STATUS, ACTION: ACTION, IMPORTANCE: IMPORTANCE,
    statusLabel: statusLabel, actionLabel: actionLabel, importanceLabel: importanceLabel,
    statusBadge: statusBadge, importanceBadge: importanceBadge,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime,
    MAX_TXN_FILE_MB: MAX_TXN_FILE_MB,
    MAX_REPLY_FILE_MB: MAX_REPLY_FILE_MB,
    MAX_TXN_FILE_BYTES: MAX_TXN_FILE_BYTES,
    MAX_REPLY_FILE_BYTES: MAX_REPLY_FILE_BYTES,
    REJECT_REASON_MIN_LEN: REJECT_REASON_MIN_LEN,
    TXN_FETCH_TIMEOUT_MS: TXN_FETCH_TIMEOUT_MS,
    REPLY_FETCH_TIMEOUT_MS: REPLY_FETCH_TIMEOUT_MS,
    ACTION_TIMEOUT_MS: ACTION_TIMEOUT_MS,
    INBOX_PAGE_SIZE: INBOX_PAGE_SIZE
  };
})(typeof window !== 'undefined' ? window : this);
