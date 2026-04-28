/**
 * V4.6 — Shared Transaction "Letter View" renderer
 * Pure function: takes a transaction object → returns HTML string
 * Used by both admin (erp.js) and employee (employee/app.js).
 *
 * Output format mirrors the formal Arabic government correspondence
 * style requested by the user (screenshots dated 2026-04-28).
 */
(function(global) {
  'use strict';

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  var STATUS_LABELS = {
    draft:'مسودة', created:'جديدة', pending:'معلق', in_progress:'قيد التشغيل',
    replied:'تم الرد', returned:'مرجعة للتعديل', approved:'معتمدة',
    rejected:'مرفوضة', closed:'مغلقة'
  };
  var IMPORTANCE_LABELS = {
    critical:'عاجل', high:'عالي', medium:'عادي', low:'منخفض'
  };
  var ACTION_LABELS = {
    create:'إنشاء',
    approve:'يعتمد حسب النظام',
    reject:'مرفوض',
    return:'إرجاع للتعديل',
    forward:'تحويل',
    close:'إغلاق',
    open:'فتح',
    resubmit:'إعادة إرسال'
  };

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
    var name = att.fileName || att.name || att.attachmentName || 'ملف';
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
      return '<div class="txn-letter-attach-empty">- لا توجد مرفقات -</div>';
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
    // Recipient header row
    if (recipient) {
      html += '<div class="txn-letter-recipient-row">' +
        '<div class="txn-letter-signature-label">الموقر</div>' +
        '<div class="txn-letter-recipient">سعادة ' + _esc(recipient) + '</div>' +
        '<div></div>' +
      '</div>';
    }
    // Greeting
    html += '<div class="txn-letter-greeting">تحية طيبة و بعد</div>';
    // Body
    if (hasContent) {
      // If contentHtml looks like HTML, trust it; else escape and pre-wrap
      if (/<[a-z][\s\S]*>/i.test(content)) {
        html += '<div class="txn-letter-content">' + content + '</div>';
      } else {
        html += '<div class="txn-letter-content">' + _esc(content) + '</div>';
      }
    }
    // Closing
    html += '<div class="txn-letter-closing">ولكم الشكر و التقدير</div>';
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
    var actionLabel = ACTION_LABELS[actionType] || actionType;
    var note = log.note || log.action_note || '';
    var attachment = log.attachment;

    // Attachments for this reply
    var replyAttachments = [];
    if (attachment && typeof attachment === 'string' && attachment.startsWith('data:')) {
      replyAttachments.push({
        fileName: log.attachmentName || ('مرفق رد ' + date),
        mime: log.attachmentMime || '',
        dataUrl: attachment
      });
    } else if (attachment && typeof attachment === 'string' && attachment.startsWith('http')) {
      replyAttachments.push({
        fileName: log.attachmentName || ('مرفق رد ' + date),
        mime: log.attachmentMime || '',
        url: attachment
      });
    }

    var html = '';
    // Header row: تاريخ الرد | من | الى | نوع الإجراء
    html += '<div class="txn-letter-reply-meta">' +
      '<span class="txn-letter-reply-meta-label">تاريخ الرد</span>' +
      '<span class="txn-letter-reply-meta-value">' + date + '</span>' +
      '<span class="txn-letter-reply-meta-label">من</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(fromLabel) + '</span>' +
      '<span class="txn-letter-reply-meta-label">الى</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(toLabel) + '</span>' +
      '<span class="txn-letter-reply-meta-label">نوع الإجراء</span>' +
      '<span class="txn-letter-reply-meta-value">' + _esc(actionLabel) + '</span>' +
    '</div>';

    // Letter body (recipient + greeting + note + closing)
    html += _letterBody({ recipient: toLabel, content: note });

    // Attachments line + section
    html += '<div class="txn-letter-attach-marker">- المرفقات -</div>';
    html += '<div class="txn-letter-band">مرفقات الرد</div>';
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
        '<span>الجهة المستقبلة</span>' +
        '<span>تاريخ الارسال</span>' +
        '<span>المستخدم المرسل</span>' +
      '</div>';
    if (!recipients.length) {
      html += '<div class="txn-letter-distribution-empty">— لا يوجد توزيع إضافي —</div>';
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
   * Returns HTML string (no event handlers — pure markup).
   */
  function renderLetterView(txn) {
    if (!txn) return '<div style="padding:20px;color:#dc2626;">المعاملة غير موجودة</div>';

    var statusKey = txn.status || 'pending';
    var statusLabel = STATUS_LABELS[statusKey] || statusKey;
    var importance = IMPORTANCE_LABELS[txn.importance] || (txn.importance || 'عادي');
    var scope = txn.scope === 'external' ? 'خارجية' : 'داخلية';

    // Top metadata grid
    var meta = '<div class="txn-letter-meta">' +
      _metaCell('مسلسل المعاملة', txn.txnNumber || txn.transactionNumber || '—') +
      _metaCell('تاريخ المعاملة', _formatDate(txn.createdAt)) +
      _metaCell('درجة الأهمية',
        importance + '<span class="txn-letter-status-pill s-' + statusKey + '"><i class="fas fa-circle" style="font-size:6px;"></i>' + statusLabel + '</span>') +
      _metaCell('جهة التحرير', txn.deptName || txn.branchName || txn.brandName || '—') +
      _metaCell('حالة المعاملة', statusLabel) +
      _metaCell('نوع المعاملة', scope) +
    '</div>';

    // Subject row
    var subject = '<div class="txn-letter-subject">' +
      '<span class="txn-letter-subject-label">الموضوع:</span>' +
      '<span class="txn-letter-subject-value">' + _esc(txn.subject || txn.title || '—') + '</span>' +
    '</div>';

    // Main content as letter
    var contentSection =
      '<div class="txn-letter-section">محتوى المعاملة</div>' +
      _letterBody({
        recipient: txn.recipientName || txn.currentRoleName || (txn.currentAssignee || ''),
        content: txn.contentHtml || txn.description || ''
      });

    // Original attachments
    var attachments = txn.attachments ? txn.attachments.slice() : [];
    if (txn.attachmentDataUrl && (!attachments.length || !attachments.some(function(a){ return a.dataUrl === txn.attachmentDataUrl; }))) {
      attachments.push({
        fileName: 'مرفق المعاملة',
        mime: '',
        dataUrl: txn.attachmentDataUrl
      });
    }
    var attachmentSection =
      '<div class="txn-letter-attach-marker">- المرفقات -</div>' +
      '<div class="txn-letter-band">المرفقات</div>' +
      _renderAttachments(attachments);

    // All replies (logs except 'create')
    var logs = (txn.logs || []).filter(function(l) { return (l.actionType || l.action_type) !== 'create'; });
    var repliesSection = logs.map(_renderReplyLetter).join('');

    // Final distribution table
    var distribution = _renderDistribution(txn);

    return '<div class="txn-letter">' +
      meta +
      subject +
      contentSection +
      attachmentSection +
      repliesSection +
      '<div class="txn-letter-band">صور المعاملة</div>' +
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
