/**
 * V4.6 — Shared Transaction "Letter View" renderer
 * Pure function: takes a transaction object → returns HTML string
 * Used by both admin (erp.js) and employee (employee/app.js).
 *
 * Output format mirrors the formal Arabic government correspondence
 * style requested by the user (screenshots dated 2026-04-28).
 *
 * V5.9.5 — i18n: every hardcoded label now flows through `_L(key, fallback)`
 *   which prefers `window.t(key)` when available (employee portal i18n) and
 *   falls back to the embedded ar/en table when the host page doesn't
 *   register a translator. That makes the formal letter switch language
 *   alongside the rest of the UI without forcing the dynamic Google
 *   translator to guess at terms-of-art like "الموقر" or "تحية طيبة و بعد".
 */
(function(global) {
  'use strict';

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // Inline ar/en table — used when the host page hasn't registered window.t().
  // Keys mirror the ones we add to public/employee/app.js so a host that does
  // register window.t() wins; this is purely a fallback for the admin portal
  // (which doesn't ship the employee i18n table).
  var _LETTER_I18N = {
    ar: {
      'letter.recipientLabel': 'الموقر',
      'letter.recipientPrefix': 'سعادة',
      'letter.greeting': 'تحية طيبة و بعد',
      'letter.closing': 'ولكم الشكر و التقدير',
      'letter.attachMarker': '- المرفقات -',
      'letter.attachReplyBand': 'مرفقات الرد',
      'letter.attachMainBand': 'المرفقات',
      'letter.distributionBand': 'صور المعاملة',
      'letter.distHeadTo': 'الجهة المستقبلة',
      'letter.distHeadDate': 'تاريخ الارسال',
      'letter.distHeadFrom': 'المستخدم المرسل',
      'letter.distEmpty': '— لا يوجد توزيع إضافي —',
      'letter.attachEmpty': '- لا توجد مرفقات -',
      'letter.metaSerial': 'مسلسل المعاملة',
      'letter.metaDate': 'تاريخ المعاملة',
      'letter.metaImportance': 'درجة الأهمية',
      'letter.metaIssuer': 'جهة التحرير',
      'letter.metaStatus': 'حالة المعاملة',
      'letter.metaScope': 'نوع المعاملة',
      'letter.subject': 'الموضوع:',
      'letter.contentSection': 'محتوى المعاملة',
      'letter.scopeInternal': 'داخلية',
      'letter.scopeExternal': 'خارجية',
      'letter.replyDate': 'تاريخ الرد',
      'letter.replyFrom': 'من',
      'letter.replyTo': 'الى',
      'letter.replyAction': 'نوع الإجراء',
      'letter.attachReplyName': 'مرفق رد',
      'letter.attachMainName': 'مرفق المعاملة',
      'letter.fileFallback': 'ملف',
      'letter.notFound': 'المعاملة غير موجودة',
      'letter.statusDraft': 'مسودة', 'letter.statusCreated': 'جديدة',
      'letter.statusPending': 'معلق', 'letter.statusInProgress': 'قيد التشغيل',
      'letter.statusReplied': 'تم الرد', 'letter.statusReturned': 'مرجعة للتعديل',
      'letter.statusApproved': 'معتمدة', 'letter.statusRejected': 'مرفوضة',
      'letter.statusClosed': 'مغلقة',
      'letter.impCritical': 'عاجل', 'letter.impHigh': 'عالي',
      'letter.impMedium': 'عادي', 'letter.impLow': 'منخفض',
      'letter.actCreate': 'إنشاء', 'letter.actApprove': 'يعتمد حسب النظام',
      'letter.actReject': 'مرفوض', 'letter.actReturn': 'إرجاع للتعديل',
      'letter.actForward': 'تحويل', 'letter.actClose': 'إغلاق',
      'letter.actOpen': 'فتح',     'letter.actResubmit': 'إعادة إرسال'
    },
    en: {
      'letter.recipientLabel': 'To',
      'letter.recipientPrefix': 'Mr./Ms.',
      'letter.greeting': 'Dear Sir/Madam,',
      'letter.closing': 'With our thanks and appreciation',
      'letter.attachMarker': '- Attachments -',
      'letter.attachReplyBand': 'Reply attachments',
      'letter.attachMainBand': 'Attachments',
      'letter.distributionBand': 'Distribution copies',
      'letter.distHeadTo': 'Recipient',
      'letter.distHeadDate': 'Sent on',
      'letter.distHeadFrom': 'Sent by',
      'letter.distEmpty': '— No additional distribution —',
      'letter.attachEmpty': '- No attachments -',
      'letter.metaSerial': 'Transaction No.',
      'letter.metaDate': 'Date',
      'letter.metaImportance': 'Importance',
      'letter.metaIssuer': 'Issuing department',
      'letter.metaStatus': 'Status',
      'letter.metaScope': 'Scope',
      'letter.subject': 'Subject:',
      'letter.contentSection': 'Transaction content',
      'letter.scopeInternal': 'Internal',
      'letter.scopeExternal': 'External',
      'letter.replyDate': 'Reply date',
      'letter.replyFrom': 'From',
      'letter.replyTo': 'To',
      'letter.replyAction': 'Action',
      'letter.attachReplyName': 'Reply attachment',
      'letter.attachMainName': 'Transaction attachment',
      'letter.fileFallback': 'file',
      'letter.notFound': 'Transaction not found',
      'letter.statusDraft': 'Draft', 'letter.statusCreated': 'New',
      'letter.statusPending': 'Pending', 'letter.statusInProgress': 'In Progress',
      'letter.statusReplied': 'Replied', 'letter.statusReturned': 'Returned for Edit',
      'letter.statusApproved': 'Approved', 'letter.statusRejected': 'Rejected',
      'letter.statusClosed': 'Closed',
      'letter.impCritical': 'Critical', 'letter.impHigh': 'High',
      'letter.impMedium': 'Normal',     'letter.impLow': 'Low',
      'letter.actCreate': 'Created', 'letter.actApprove': 'Approved per policy',
      'letter.actReject': 'Rejected', 'letter.actReturn': 'Returned for edit',
      'letter.actForward': 'Forwarded', 'letter.actClose': 'Closed',
      'letter.actOpen': 'Opened',       'letter.actResubmit': 'Resubmitted'
    }
  };

  function _activeLang() {
    // Employee portal uses `currentLang` global; admin portal stores under
    // a different key. Falls back to <html lang> then to 'ar'.
    if (typeof global.currentLang === 'string') return global.currentLang;
    try {
      var v = (typeof localStorage !== 'undefined') &&
              (localStorage.getItem('emp_lang') || localStorage.getItem('pos_lang'));
      if (v) return v;
    } catch(e) {}
    var htmlLang = (global.document && global.document.documentElement && global.document.documentElement.getAttribute('lang')) || '';
    return htmlLang === 'en' ? 'en' : 'ar';
  }

  function _L(key) {
    // Prefer the host's translator (employee portal registers window.t).
    if (typeof global.t === 'function') {
      var v = global.t(key);
      if (v && v !== key) return v;
    }
    var lang = _activeLang();
    var dict = _LETTER_I18N[lang] || _LETTER_I18N.ar;
    return dict[key] !== undefined ? dict[key] : (_LETTER_I18N.ar[key] || key);
  }

  function _statusLabel(key) { return _L('letter.status' + _capKey(key)) || key; }
  function _impLabel(key)    { return _L('letter.imp'    + _capKey(key)) || key; }
  function _actionLabel(key) { return _L('letter.act'    + _capKey(key)) || key; }
  function _capKey(s) {
    if (!s) return '';
    // 'in_progress' → 'InProgress', 'approve' → 'Approve'
    return String(s).split('_').map(function(p){ return p.charAt(0).toUpperCase() + p.slice(1); }).join('');
  }

  function _detectFileIcon(name, mime) {
    var lower = (name || '').toLowerCase();
    if (mime && mime.indexOf('pdf') >= 0)        return { icon: 'fa-file-pdf', cls: 'pdf' };
    if (mime && mime.indexOf('image') >= 0)      return { icon: 'fa-file-image', cls: 'image' };
    if (mime && (mime.indexOf('excel') >= 0 || mime.indexOf('spreadsheet') >= 0)) return { icon: 'fa-file-excel', cls: 'excel' };
    if (mime && (mime.indexOf('word') >= 0 || mime.indexOf('document') >= 0))     return { icon: 'fa-file-word', cls: 'word' };
    if (lower.endsWith('.pdf'))                   return { icon: 'fa-file-pdf', cls: 'pdf' };
    if (/\.(jpe?g|png|gif|svg|webp|bmp)$/.test(lower)) return { icon: 'fa-file-image', cls: 'image' };
    if (/\.(xlsx?|csv|ods)$/.test(lower))         return { icon: 'fa-file-excel', cls: 'excel' };
    if (/\.(docx?|odt|rtf)$/.test(lower))         return { icon: 'fa-file-word', cls: 'word' };
    return { icon: 'fa-file', cls: 'generic' };
  }

  function _attachmentItem(att) {
    var name = att.fileName || att.name || att.attachmentName || _L('letter.fileFallback');
    var mime = att.mime || att.mimeType || att.attachmentMime || '';
    var url  = att.url || att.dataUrl || att.attachment || '';
    var ic   = _detectFileIcon(name, mime);
    var safeUrl = _esc(url);
    var clickHandler = url ? ('onclick="window.open(\'' + safeUrl + '\',\'_blank\')"') : '';
    return '<a class="txn-letter-attach-item" href="' + safeUrl + '" download="' + _esc(name) + '" target="_blank">' +
      '<i class="fas ' + ic.icon + ' txn-letter-attach-icon ' + ic.cls + '"></i>' +
      '<div class="txn-letter-attach-name">' + _esc(name) + '</div>' +
    '</a>';
  }

  function _renderAttachments(attachments) {
    if (!attachments || !attachments.length) {
      return '<div class="txn-letter-attach-empty">' + _esc(_L('letter.attachEmpty')) + '</div>';
    }
    return '<div class="txn-letter-attachments">' +
      attachments.map(_attachmentItem).join('') +
    '</div>';
  }

  function _formatDate(d) {
    if (!d) return '—';
    try {
      var dt = new Date(d);
      var y = dt.getFullYear();
      var m = String(dt.getMonth() + 1).padStart(2, '0');
      var day = String(dt.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    } catch (_) { return String(d).slice(0, 10); }
  }

  /**
   * Render a "letter body" — recipient + greeting + content + closing.
   * Used for both the main transaction content AND each reply log.
   */
  function _letterBody(opts) {
    var recipient = opts.recipient || '';
    var content   = opts.content   || '';
    var hasContent = (content && content.trim());

    var html = '<div class="txn-letter-body">';
    if (recipient) {
      html += '<div class="txn-letter-recipient-row">' +
        '<div class="txn-letter-signature-label">' + _esc(_L('letter.recipientLabel')) + '</div>' +
        '<div class="txn-letter-recipient">' + _esc(_L('letter.recipientPrefix')) + ' ' + _esc(recipient) + '</div>' +
        '<div></div>' +
      '</div>';
    }
    html += '<div class="txn-letter-greeting">' + _esc(_L('letter.greeting')) + '</div>';
    if (hasContent) {
      if (/<[a-z][\s\S]*>/i.test(content)) {
        html += '<div class="txn-letter-content">' + content + '</div>';
      } else {
        html += '<div class="txn-letter-content">' + _esc(content) + '</div>';
      }
    }
    html += '<div class="txn-letter-closing">' + _esc(_L('letter.closing')) + '</div>';
    html += '</div>';
    return html;
  }

  /**
   * Render a single reply (timeline log entry) as its own letter.
   */
  function _renderReplyLetter(log) {
    var date = _formatDate(log.createdAt);
    var fromUser = log.actionBy || log.action_by || '';
    var fromPos  = log.fromPositionName || log.position_name || log.positionName || '';
    var fromLabel = fromPos || fromUser;
    var toUser   = log.toUser || log.assignedTo || '';
    var toPos    = log.toPositionName || log.targetPositionName || '';
    var toLabel  = toPos || toUser || '—';
    var actionType = log.actionType || log.action_type || 'create';
    var actionLabel = _actionLabel(actionType);
    var note = log.note || log.action_note || '';
    var attachment = log.attachment;

    var replyAttachments = [];
    if (attachment && typeof attachment === 'string' && attachment.startsWith('data:')) {
      replyAttachments.push({
        fileName: log.attachmentName || (_L('letter.attachReplyName') + ' ' + date),
        mime: log.attachmentMime || '',
        dataUrl: attachment
      });
    } else if (attachment && typeof attachment === 'string' && attachment.startsWith('http')) {
      replyAttachments.push({
        fileName: log.attachmentName || (_L('letter.attachReplyName') + ' ' + date),
        mime: log.attachmentMime || '',
        url: attachment
      });
    }

    var html = '';
    html += '<div class="txn-letter-reply-meta">' +
      '<span class="txn-letter-reply-meta-label">' + _esc(_L('letter.replyDate')) + '</span>' +
      '<span class="txn-letter-reply-meta-value">' + date + '</span>' +
      '<span class="txn-letter-reply-meta-label">' + _esc(_L('letter.replyFrom')) + '</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(fromLabel) + '</span>' +
      '<span class="txn-letter-reply-meta-label">' + _esc(_L('letter.replyTo')) + '</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(toLabel) + '</span>' +
      '<span class="txn-letter-reply-meta-label">' + _esc(_L('letter.replyAction')) + '</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(actionLabel) + '</span>' +
    '</div>';

    html += _letterBody({ recipient: toLabel, content: note });

    html += '<div class="txn-letter-attach-marker">' + _esc(_L('letter.attachMarker')) + '</div>';
    html += '<div class="txn-letter-band">' + _esc(_L('letter.attachReplyBand')) + '</div>';
    if (replyAttachments.length) html += _renderAttachments(replyAttachments);

    return html;
  }

  /**
   * Render the distribution table (who else got copies of the txn).
   */
  function _renderDistribution(txn) {
    var recipients = txn.recipients || [];
    var html = '<div class="txn-letter-distribution">' +
      '<div class="txn-letter-distribution-head">' +
        '<span>' + _esc(_L('letter.distHeadTo')) + '</span>' +
        '<span>' + _esc(_L('letter.distHeadDate')) + '</span>' +
        '<span>' + _esc(_L('letter.distHeadFrom')) + '</span>' +
      '</div>';
    if (!recipients.length) {
      html += '<div class="txn-letter-distribution-empty">' + _esc(_L('letter.distEmpty')) + '</div>';
    } else {
      recipients.forEach(function(r) {
        html += '<div class="txn-letter-distribution-row">' +
          '<span>' + _esc(r.name || r.username || '') + '</span>' +
          '<span>' + _formatDate(r.sentAt || r.createdAt || txn.createdAt) + '</span>' +
          '<span>' + _esc(txn.createdBy || '') + '</span>' +
        '</div>';
      });
    }
    html += '</div>';
    return html;
  }

  /**
   * MAIN — render the entire transaction as a formal letter view.
   */
  function renderLetterView(txn) {
    if (!txn) return '<div style="padding:20px;color:#dc2626;">' + _esc(_L('letter.notFound')) + '</div>';

    var statusKey = txn.status || 'pending';
    var statusLabel = _statusLabel(statusKey);
    var importance = txn.importance ? _impLabel(txn.importance) : _L('letter.impMedium');
    var scope = txn.scope === 'external' ? _L('letter.scopeExternal') : _L('letter.scopeInternal');

    var meta = '<div class="txn-letter-meta">' +
      _metaCell(_L('letter.metaSerial'),     txn.txnNumber || txn.transactionNumber || '—') +
      _metaCell(_L('letter.metaDate'),       _formatDate(txn.createdAt)) +
      _metaCell(_L('letter.metaImportance'),
        _esc(importance) + '<span class="txn-letter-status-pill s-' + statusKey + '"><i class="fas fa-circle" style="font-size:6px;"></i>' + _esc(statusLabel) + '</span>') +
      _metaCell(_L('letter.metaIssuer'),     txn.deptName || txn.branchName || txn.brandName || '—') +
      _metaCell(_L('letter.metaStatus'),     statusLabel) +
      _metaCell(_L('letter.metaScope'),      scope) +
    '</div>';

    var subject = '<div class="txn-letter-subject">' +
      '<span class="txn-letter-subject-label">' + _esc(_L('letter.subject')) + '</span>' +
      '<span class="txn-letter-subject-value">' + _esc(txn.subject || txn.title || '—') + '</span>' +
    '</div>';

    var contentSection =
      '<div class="txn-letter-section">' + _esc(_L('letter.contentSection')) + '</div>' +
      _letterBody({
        recipient: txn.recipientName || txn.currentRoleName || (txn.currentAssignee || ''),
        content: txn.contentHtml || txn.description || ''
      });

    var attachments = txn.attachments ? txn.attachments.slice() : [];
    if (txn.attachmentDataUrl && (!attachments.length || !attachments.some(function(a){ return a.dataUrl === txn.attachmentDataUrl; }))) {
      attachments.push({
        fileName: _L('letter.attachMainName'),
        mime: '',
        dataUrl: txn.attachmentDataUrl
      });
    }
    var attachmentSection =
      '<div class="txn-letter-attach-marker">' + _esc(_L('letter.attachMarker')) + '</div>' +
      '<div class="txn-letter-band">' + _esc(_L('letter.attachMainBand')) + '</div>' +
      _renderAttachments(attachments);

    var logs = (txn.logs || []).filter(function(l) { return (l.actionType || l.action_type) !== 'create'; });
    var repliesSection = logs.map(_renderReplyLetter).join('');

    var distribution = _renderDistribution(txn);

    return '<div class="txn-letter">' +
      meta +
      subject +
      contentSection +
      attachmentSection +
      repliesSection +
      '<div class="txn-letter-band">' + _esc(_L('letter.distributionBand')) + '</div>' +
      distribution +
    '</div>';
  }

  function _metaCell(label, value) {
    return '<div class="txn-letter-meta-cell">' +
      '<span class="txn-letter-meta-label">' + _esc(label) + '</span>' +
      '<span class="txn-letter-meta-value">' + value + '</span>' +
    '</div>';
  }

  // Public API
  global.TxnLetterView = {
    render: renderLetterView,
    _esc: _esc,
    _formatDate: _formatDate
  };
})(typeof window !== 'undefined' ? window : this);
