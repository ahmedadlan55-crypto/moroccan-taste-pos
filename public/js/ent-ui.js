/* ═══════════════════════════════════════════════════════════════════════
 * ENT-UI · Enterprise UI Kit JS  v1.0  (v5.10.41)
 *
 * Render helpers + behavior primitives that pair with /css/ent-ui.css.
 * Exposed on `window.EntUI`. All functions return HTML strings (plain
 * concatenation) — the calling code is responsible for setting innerHTML
 * and binding event listeners. This keeps the kit framework-free and
 * compatible with the existing vanilla-JS codebase.
 *
 * Public surface:
 *   EntUI.overlay({ id, contentHtml, onClose })           -> mounts an overlay shell
 *   EntUI.header({ icon, eyebrow, title, code, status, statusType, sub, stats, theme, readonly, onClose })
 *   EntUI.summaryCard({ label, value, unit, icon, intent, footer })
 *   EntUI.summary(cards)                                   -> .ent-summary grid
 *   EntUI.tag(text, type)                                  -> .ent-tag pill
 *   EntUI.banner({ icon, title, text, meta, intent })
 *   EntUI.section({ icon, title, action, body })
 *   EntUI.table({ columns, rows, footer, state, emptyAction, colCount })
 *   EntUI.timeline(steps)                                  -> WorkflowTimeline
 *   EntUI.actionBar({ leftBtns, rightBtns, readonly, permissions })
 *   EntUI.button({ label, intent, icon, onClick, disabled, hidden, permission })
 *   EntUI.field({ type, id, label, value, required, placeholder, options, hint, error, readonly, attrs })
 *   EntUI.formGrid(fieldsHtml)
 *   EntUI.kv(rows)                                         -> key/value definition grid
 *   EntUI.infoCard({ icon, label, value, intent })
 *   EntUI.pager({ page, totalPages, totalItems, pageSize, onPage })
 *   EntUI.attachments({ files, readonly, onRemove, onUpload })
 *
 * Behavior primitives:
 *   EntUI.Validation                  — rule library + run(values, rules)
 *   EntUI.State.create(initial)       — tiny pub/sub state container
 *   EntUI.Error.show(host, msg)       — inline error renderer
 *   EntUI.Permission.can(action)      — role check (reads window.state.user)
 *   EntUI.fmt.qty / fmt.money / fmt.date  — shared formatters
 *   EntUI.esc(s)                      — HTML-escape helper
 * ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // ───────────────────────── Utilities ─────────────────────────
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function attr(s) { return esc(s); }

  // Format helpers
  function fmtQty(n) {
    n = Number(n || 0);
    return n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  function fmtMoney(n) {
    n = Number(n || 0);
    return n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      return dt.toLocaleString('ar-SA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return String(d); }
  }
  function fmtDateShort(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      return dt.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: '2-digit' });
    } catch (e) { return String(d); }
  }
  function bytesFmt(n) {
    n = Number(n || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ───────────────────────── Overlay shell ─────────────────────────
  // Mounts a singleton overlay div for a given id. Handles ESC close +
  // backdrop click. Returns a handle with open()/close()/setContent().
  var _overlays = {};
  function overlay(opts) {
    opts = opts || {};
    var id = opts.id || 'entOverlay';
    var ov = document.getElementById(id);
    if (!ov) {
      ov = document.createElement('div');
      ov.id = id;
      ov.className = 'ent-overlay';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (ev) {
        if (ev.target === ov) handle.close();
      });
    }
    var handle = _overlays[id] || (_overlays[id] = {});
    handle.el = ov;
    handle.open = function (contentHtml) {
      if (contentHtml !== undefined) ov.innerHTML = '<div class="ent-shell">' + contentHtml + '</div>';
      ov.classList.add('open');
      document.body.style.overflow = 'hidden';
      handle._escHandler = function (ev) {
        if (ev.key === 'Escape' && ov.classList.contains('open')) handle.close();
      };
      document.addEventListener('keydown', handle._escHandler);
    };
    handle.close = function () {
      ov.classList.remove('open');
      document.body.style.overflow = '';
      if (handle._escHandler) document.removeEventListener('keydown', handle._escHandler);
      if (typeof opts.onClose === 'function') { try { opts.onClose(); } catch (e) {} }
    };
    handle.setContent = function (html) { ov.innerHTML = '<div class="ent-shell">' + html + '</div>'; };
    return handle;
  }

  // ───────────────────────── 1. HeaderSection ─────────────────────────
  function header(o) {
    o = o || {};
    var theme = o.theme || ''; // success / warning / danger / info
    var readonly = o.readonly ? ' readonly' : '';
    var closeBtn = o.onClose === false
      ? ''
      : '<button class="ent-header-close" type="button" data-ent-close aria-label="إغلاق">&times;</button>';
    var eyebrow = o.eyebrow
      ? '<div class="ent-header-eyebrow">' + (o.icon ? '<i class="fas ' + esc(o.icon) + '"></i> ' : '') + esc(o.eyebrow) + '</div>'
      : '';
    var statusPill = '';
    if (o.status) {
      statusPill = ' <span class="ent-tag ' + esc(o.statusType || 'neutral') + '">' + esc(o.status) + '</span>';
    }
    var titleHtml = '';
    if (o.title || o.code) {
      titleHtml = '<div class="ent-header-title">' +
        (o.code ? '<code>' + esc(o.code) + '</code>' : '') +
        (o.title ? '<span>' + esc(o.title) + '</span>' : '') +
        statusPill +
        '</div>';
    }
    var subHtml = '';
    if (Array.isArray(o.sub) && o.sub.length) {
      subHtml = '<div class="ent-header-sub">' +
        o.sub.map(function (s) {
          if (typeof s === 'string') return '<span>' + esc(s) + '</span>';
          var ic = s.icon ? '<i class="fas ' + esc(s.icon) + '"></i>' : '';
          return '<span>' + ic + ' ' + esc(s.text || '') + '</span>';
        }).join('') +
      '</div>';
    }
    var statsHtml = '';
    if (Array.isArray(o.stats) && o.stats.length) {
      statsHtml = '<div class="ent-header-stats">' +
        o.stats.map(function (st) {
          var cls = st.accent ? ' accent' : '';
          var unit = st.unit ? ' <small>' + esc(st.unit) + '</small>' : '';
          return '<div class="ent-header-stat' + cls + '">' +
            '<div class="ent-header-stat-lbl">' + esc(st.label || '') + '</div>' +
            '<div class="ent-header-stat-val">' + esc(st.value || '') + unit + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }
    return '<header class="ent-header' + (theme ? ' ' + theme : '') + readonly + '">' +
      closeBtn + eyebrow + titleHtml + subHtml + statsHtml +
    '</header>';
  }

  // ───────────────────────── 2. SummaryCard / Summary grid ─────────────────────────
  function summaryCard(o) {
    o = o || {};
    var intent = o.intent || 'info';
    var icon = o.icon ? '<div class="ent-summary-card-icon"><i class="fas ' + esc(o.icon) + '"></i></div>' : '';
    var unit = o.unit ? ' <small>' + esc(o.unit) + '</small>' : '';
    var footer = o.footer ? '<div class="ent-summary-card-foot">' + o.footer + '</div>' : '';
    return '<div class="ent-summary-card ' + esc(intent) + '">' +
      icon +
      '<div class="ent-summary-card-body">' +
        '<div class="ent-summary-card-lbl">' + esc(o.label || '') + '</div>' +
        '<div class="ent-summary-card-val">' + esc(String(o.value == null ? '—' : o.value)) + unit + '</div>' +
        footer +
      '</div>' +
    '</div>';
  }
  function summary(cards) {
    if (!Array.isArray(cards) || !cards.length) return '';
    return '<div class="ent-summary">' + cards.map(summaryCard).join('') + '</div>';
  }

  // ───────────────────────── 3. TagStatus ─────────────────────────
  function tag(text, type, opts) {
    opts = opts || {};
    var cls = 'ent-tag ' + (type || 'neutral') + (opts.solid ? ' solid' : '');
    var ic = opts.icon ? '<i class="fas ' + esc(opts.icon) + '"></i> ' : '';
    return '<span class="' + cls + '">' + ic + esc(text || '') + '</span>';
  }

  // ───────────────────────── 4. Banner ─────────────────────────
  function banner(o) {
    o = o || {};
    var intent = o.intent || 'warning';
    var icon = o.icon || (intent === 'danger' ? 'fa-circle-xmark'
                       : intent === 'success' ? 'fa-circle-check'
                       : intent === 'info' ? 'fa-circle-info'
                       : intent === 'pink' ? 'fa-rotate-left'
                       : 'fa-triangle-exclamation');
    return '<div class="ent-banner ' + esc(intent) + '">' +
      '<div class="ent-banner-icon"><i class="fas ' + esc(icon) + '"></i></div>' +
      '<div style="flex:1;">' +
        (o.title ? '<div class="ent-banner-title">' + esc(o.title) + '</div>' : '') +
        (o.text ? '<div class="ent-banner-text">' + o.text + '</div>' : '') +
        (o.meta ? '<div class="ent-banner-meta">' + esc(o.meta) + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  // ───────────────────────── 5. Section wrapper ─────────────────────────
  function section(o) {
    o = o || {};
    var head = '';
    if (o.title) {
      head = '<div class="ent-section-head">' +
        '<div class="ent-section-title">' +
          (o.icon ? '<i class="fas ' + esc(o.icon) + '"></i>' : '') +
          ' ' + esc(o.title) +
        '</div>' +
        (o.action ? '<div class="ent-section-action">' + o.action + '</div>' : '') +
      '</div>';
    }
    return '<section class="ent-section">' + head + (o.body || '') + '</section>';
  }

  // ───────────────────────── 6. DetailsTable ─────────────────────────
  // columns: [{ key, label, num?, render?(row, idx) -> html }]
  // rows: array of row objects (also supports row._state: partial|pending|over|positive|negative)
  // state: 'loading' | 'empty' | 'error' | undefined
  function table(o) {
    o = o || {};
    var cols = o.columns || [];
    var colCount = cols.length || o.colCount || 1;
    var head = '<thead><tr>' + cols.map(function (c) {
      return '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.label || '') + '</th>';
    }).join('') + '</tr></thead>';

    var body;
    if (o.state === 'loading') {
      var skelRows = '';
      for (var i = 0; i < 4; i++) {
        skelRows += '<tr>';
        for (var k = 0; k < colCount; k++) skelRows += '<td><span class="ent-skel" style="width:' + (50 + (k % 3) * 20) + '%;"></span></td>';
        skelRows += '</tr>';
      }
      body = '<tbody class="is-loading">' + skelRows + '</tbody>';
    } else if (o.state === 'error') {
      body = '<tbody><tr><td colspan="' + colCount + '">' +
        '<div class="ent-error-state">' +
          '<i class="fas fa-circle-xmark"></i>' +
          '<div class="ent-error-state-title">' + esc(o.errorTitle || 'تعذّر تحميل البيانات') + '</div>' +
          '<div class="ent-error-state-text">' + esc(o.errorText || 'حدث خطأ أثناء الاتصال بالخادم. حاول مرة أخرى.') + '</div>' +
        '</div>' +
      '</td></tr></tbody>';
    } else if (!Array.isArray(o.rows) || !o.rows.length) {
      body = '<tbody><tr><td colspan="' + colCount + '">' +
        '<div class="ent-empty">' +
          '<div class="ent-empty-icon"><i class="fas ' + esc(o.emptyIcon || 'fa-inbox') + '"></i></div>' +
          '<div class="ent-empty-title">' + esc(o.emptyTitle || 'لا توجد بيانات') + '</div>' +
          '<div class="ent-empty-text">' + esc(o.emptyText || 'لم يتم العثور على أي عناصر مطابقة.') + '</div>' +
          (o.emptyAction ? '<div class="ent-empty-action">' + o.emptyAction + '</div>' : '') +
        '</div>' +
      '</td></tr></tbody>';
    } else {
      var rowsHtml = o.rows.map(function (row, idx) {
        var rowCls = row._state ? ' class="ent-row-' + esc(row._state) + '"' : '';
        var cells = cols.map(function (c) {
          var val;
          if (typeof c.render === 'function') {
            val = c.render(row, idx);
          } else {
            val = row[c.key];
            if (val === null || val === undefined) val = '';
            val = esc(String(val));
          }
          return '<td' + (c.num ? ' class="num"' : '') + '>' + val + '</td>';
        }).join('');
        return '<tr' + rowCls + '>' + cells + '</tr>';
      }).join('');
      body = '<tbody>' + rowsHtml + '</tbody>';
    }

    var foot = '';
    if (o.footer) {
      foot = '<tfoot><tr>' +
        (Array.isArray(o.footer)
          ? o.footer.map(function (f) {
              return '<td' + (f.colspan ? ' colspan="' + f.colspan + '"' : '') + (f.num ? ' class="num"' : '') + '>' + (f.html || esc(f.text || '')) + '</td>';
            }).join('')
          : '<td colspan="' + colCount + '">' + o.footer + '</td>') +
      '</tr></tfoot>';
    }
    return '<div class="ent-table-wrap"><table class="ent-table">' + head + body + foot + '</table></div>';
  }

  // ───────────────────────── 7. WorkflowTimeline ─────────────────────────
  // steps: [{ key, label, icon, status: 'done'|'current'|''|'reversed'|'cancelled', when, who, note }]
  function timeline(steps) {
    if (!Array.isArray(steps) || !steps.length) return '';
    var html = steps.map(function (s) {
      var meta = '';
      if (s.when) meta += '<div class="ent-step-meta">' + esc(fmtDate(s.when)) + '</div>';
      if (s.who)  meta += '<div class="ent-step-meta user"><i class="fas fa-user-circle"></i> ' + esc(s.who) + '</div>';
      if (s.note) meta += '<div class="ent-step-meta">' + esc(s.note) + '</div>';
      return '<div class="ent-step ' + esc(s.status || '') + '">' +
        '<div class="ent-step-dot"><i class="fas ' + esc(s.icon || 'fa-circle') + '"></i></div>' +
        '<div class="ent-step-lbl">' + esc(s.label || '') + '</div>' +
        meta +
      '</div>';
    }).join('');
    return '<div class="ent-timeline">' + html + '</div>';
  }

  // ───────────────────────── 8. BottomActionBar + Button ─────────────────────────
  // buttons: [{ id, label, intent, icon, onClick, disabled, hidden, permission, attrs }]
  function button(b) {
    if (!b) return '';
    if (b.hidden) return '';
    if (b.permission && !Permission.can(b.permission)) return '';
    var cls = 'ent-btn ' + (b.intent || 'ghost');
    if (b.size === 'sm') cls += ' sm';
    if (b.size === 'lg') cls += ' lg';
    if (b.iconOnly) cls += ' icon-only';
    var disabled = b.disabled ? ' disabled aria-disabled="true"' : '';
    var attrs = '';
    if (b.id) attrs += ' id="' + attr(b.id) + '"';
    if (b.onClick) attrs += ' onclick="' + attr(b.onClick) + '"';
    if (b.attrs) attrs += ' ' + b.attrs;
    var icon = b.icon ? '<i class="fas ' + esc(b.icon) + '"></i>' : '';
    var label = b.iconOnly ? '' : '<span>' + esc(b.label || '') + '</span>';
    return '<button type="button" class="' + cls + '"' + attrs + disabled + '>' + icon + label + '</button>';
  }
  function actionBar(o) {
    o = o || {};
    var leftHtml  = (o.leftBtns  || []).map(button).join('');
    var rightHtml = (o.rightBtns || []).map(button).join('');
    if (!leftHtml && !rightHtml) return '';
    return '<footer class="ent-actionbar">' +
      '<div class="ent-actionbar-left">' + leftHtml + '</div>' +
      '<div class="ent-actionbar-right">' + rightHtml + '</div>' +
    '</footer>';
  }

  // ───────────────────────── 9. FormField (text/number/select/date/textarea) ─────────────────────────
  function field(o) {
    o = o || {};
    var type = o.type || 'text';
    var id = o.id || ('entF' + Math.random().toString(36).slice(2, 8));
    var req = o.required ? ' <span class="req">*</span>' : '';
    var labelHtml = o.label
      ? '<label class="ent-field-label" for="' + attr(id) + '">' +
          (o.icon ? '<i class="fas ' + esc(o.icon) + '"></i> ' : '') +
          esc(o.label) + req +
        '</label>'
      : '';
    var attrs = '';
    if (o.placeholder) attrs += ' placeholder="' + attr(o.placeholder) + '"';
    if (o.required)    attrs += ' required';
    if (o.readonly)    attrs += ' readonly';
    if (o.disabled)    attrs += ' disabled';
    if (o.min != null) attrs += ' min="' + attr(o.min) + '"';
    if (o.max != null) attrs += ' max="' + attr(o.max) + '"';
    if (o.step != null)attrs += ' step="' + attr(o.step) + '"';
    if (o.onChange)    attrs += ' onchange="' + attr(o.onChange) + '"';
    if (o.onInput)     attrs += ' oninput="' + attr(o.onInput) + '"';
    if (o.attrs)       attrs += ' ' + o.attrs;
    var inputHtml;
    if (type === 'select') {
      var opts = (o.options || []).map(function (op) {
        var val = (op.value !== undefined) ? op.value : op;
        var lbl = (op.label !== undefined) ? op.label : val;
        var sel = (String(val) === String(o.value || '')) ? ' selected' : '';
        return '<option value="' + attr(val) + '"' + sel + '>' + esc(lbl) + '</option>';
      }).join('');
      inputHtml = '<select id="' + attr(id) + '" class="ent-field-select"' + attrs + '>' + opts + '</select>';
    } else if (type === 'textarea') {
      inputHtml = '<textarea id="' + attr(id) + '" class="ent-field-textarea"' + attrs + '>' + esc(o.value || '') + '</textarea>';
    } else {
      var value = (o.value !== undefined && o.value !== null) ? ' value="' + attr(o.value) + '"' : '';
      inputHtml = '<input type="' + attr(type) + '" id="' + attr(id) + '" class="ent-field-input"' + attrs + value + '>';
    }
    var hint = o.hint  ? '<div class="ent-field-hint">'  + o.hint  + '</div>' : '';
    var err  = '<div class="ent-field-error"><i class="fas fa-circle-exclamation"></i> <span data-ent-err-msg>' + esc(o.error || '') + '</span></div>';
    var wrapCls = 'ent-field' + (o.error ? ' is-invalid' : '');
    return '<div class="' + wrapCls + '" data-ent-field="' + attr(id) + '">' +
      labelHtml + inputHtml + hint + err +
    '</div>';
  }
  function formGrid(html) { return '<div class="ent-form-grid">' + (html || '') + '</div>'; }

  // ───────────────────────── 10. Key/Value definition list ─────────────────────────
  function kv(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    return '<div class="ent-kv">' +
      rows.map(function (r) {
        return '<div class="ent-kv-row">' +
          '<div class="ent-kv-lbl">' + esc(r.label || '') + '</div>' +
          '<div class="ent-kv-val">' + (r.html || esc(String(r.value == null ? '—' : r.value))) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }
  function infoCard(o) {
    o = o || {};
    return '<div class="ent-info-card">' +
      '<div class="ent-info-card-icon"><i class="fas ' + esc(o.icon || 'fa-circle-info') + '"></i></div>' +
      '<div class="ent-info-card-body">' +
        '<div class="ent-info-card-lbl">' + esc(o.label || '') + '</div>' +
        '<div class="ent-info-card-val">' + (o.html || esc(o.value || '')) + '</div>' +
      '</div>' +
    '</div>';
  }

  // ───────────────────────── 11. AttachmentManager ─────────────────────────
  // Visual only — actual upload integration lives in the caller.
  function attachments(o) {
    o = o || {};
    var files = o.files || [];
    var readonly = !!o.readonly;
    var list;
    if (!files.length) {
      list = '<div class="ent-attach-empty">لا توجد مرفقات</div>';
    } else {
      list = '<div class="ent-attach-list">' +
        files.map(function (f, idx) {
          var ext = (f.name || '').split('.').pop().toLowerCase();
          var icon = (['jpg','jpeg','png','gif','webp'].indexOf(ext) >= 0) ? 'fa-image'
                   : (ext === 'pdf') ? 'fa-file-pdf'
                   : (['xls','xlsx','csv'].indexOf(ext) >= 0) ? 'fa-file-excel'
                   : (['doc','docx'].indexOf(ext) >= 0) ? 'fa-file-word'
                   : 'fa-file';
          var meta = bytesFmt(f.size) + (f.uploadedAt ? ' · ' + fmtDateShort(f.uploadedAt) : '');
          var rm = readonly
            ? ''
            : '<button class="ent-attach-rm" type="button" data-ent-attach-rm="' + idx + '" aria-label="حذف"><i class="fas fa-trash"></i></button>';
          var dl = f.url
            ? '<a class="ent-btn ghost sm" href="' + attr(f.url) + '" target="_blank" rel="noopener" title="تنزيل"><i class="fas fa-download"></i></a>'
            : '';
          return '<div class="ent-attach-item">' +
            '<div class="ent-attach-icon"><i class="fas ' + icon + '"></i></div>' +
            '<div class="ent-attach-body">' +
              '<div class="ent-attach-name" title="' + attr(f.name || '') + '">' + esc(f.name || '—') + '</div>' +
              '<div class="ent-attach-meta">' + esc(meta) + '</div>' +
            '</div>' +
            dl + rm +
          '</div>';
        }).join('') +
      '</div>';
    }
    var drop = readonly ? '' :
      '<div class="ent-attach-drop" data-ent-attach-drop>' +
        '<i class="fas fa-cloud-arrow-up"></i>' +
        '<div>اسحب الملفات هنا أو اضغط للاختيار</div>' +
        '<div style="font-size:11px;margin-top:4px;">PDF · صور · Excel · Word — حتى 10 ميغابايت</div>' +
      '</div>';
    return '<div class="ent-attach">' + list + drop + '</div>';
  }

  // ───────────────────────── 12. Pagination ─────────────────────────
  function pager(o) {
    o = o || {};
    var page = Math.max(1, Number(o.page || 1));
    var pageSize = Math.max(1, Number(o.pageSize || 25));
    var total = Math.max(0, Number(o.totalItems || 0));
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    var from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    var to   = Math.min(total, page * pageSize);
    var callee = o.onPage || ''; // function-name string, called as callee(pageNum)
    function btn(p, label, disabled, active) {
      var cls = 'ent-pager-btn' + (active ? ' active' : '');
      var dis = disabled ? ' disabled' : '';
      var onclick = (!disabled && callee) ? ' onclick="' + attr(callee) + '(' + p + ')"' : '';
      return '<button type="button" class="' + cls + '"' + onclick + dis + '>' + esc(label) + '</button>';
    }
    // Build a windowed page list: 1 … (p-1) p (p+1) … last
    var pages = [];
    function pushNum(n) { if (pages.indexOf(n) < 0 && n >= 1 && n <= totalPages) pages.push(n); }
    pushNum(1);
    pushNum(page - 1); pushNum(page); pushNum(page + 1);
    pushNum(totalPages);
    pages.sort(function (a, b) { return a - b; });
    var pageBtns = '';
    var prevP = 0;
    pages.forEach(function (p) {
      if (prevP && p > prevP + 1) pageBtns += '<span style="padding:0 4px;color:#94a3b8;">…</span>';
      pageBtns += btn(p, String(p), false, p === page);
      prevP = p;
    });
    return '<div class="ent-pager">' +
      '<div class="ent-pager-info">' + from + '–' + to + ' من ' + total + '</div>' +
      btn(page - 1, '‹', page <= 1) +
      pageBtns +
      btn(page + 1, '›', page >= totalPages) +
    '</div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // Behavior primitives
  // ═══════════════════════════════════════════════════════════════

  // ───────────────────────── ValidationEngine ─────────────────────────
  // Rules registry. Each rule is fn(value, allValues, params) -> true | errMsg
  var rules = {
    required: function (v) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return 'هذا الحقل مطلوب';
      return true;
    },
    minLength: function (v, _, n) {
      if (!v) return true;
      return String(v).trim().length >= n ? true : 'الحد الأدنى ' + n + ' حرفاً';
    },
    maxLength: function (v, _, n) {
      if (!v) return true;
      return String(v).trim().length <= n ? true : 'الحد الأقصى ' + n + ' حرفاً';
    },
    min: function (v, _, n) {
      if (v === '' || v === null || v === undefined) return true;
      return Number(v) >= n ? true : 'لا يقل عن ' + n;
    },
    max: function (v, _, n) {
      if (v === '' || v === null || v === undefined) return true;
      return Number(v) <= n ? true : 'لا يزيد عن ' + n;
    },
    nonNegative: function (v) {
      if (v === '' || v === null || v === undefined) return true;
      return Number(v) >= 0 ? true : 'لا يمكن أن تكون سالبة';
    },
    positive: function (v) {
      if (v === '' || v === null || v === undefined) return true;
      return Number(v) > 0 ? true : 'يجب أن تكون أكبر من صفر';
    },
    notEqual: function (v, all, other) {
      if (v === '' || v === null || v === undefined) return true;
      return String(v) !== String(all[other]) ? true : 'يجب أن يختلف عن ' + other;
    },
    lte: function (v, all, other) {
      if (v === '' || v === null) return true;
      return Number(v) <= Number(all[other] || 0) ? true : 'لا يزيد عن ' + other;
    },
    gte: function (v, all, other) {
      if (v === '' || v === null) return true;
      return Number(v) >= Number(all[other] || 0) ? true : 'لا يقل عن ' + other;
    }
  };
  // schema: { fieldName: [{ rule: 'required' } | { rule: 'minLength', param: 4 } | fn] }
  // returns { ok: bool, errors: { fieldName: msg } }
  function validate(values, schema) {
    var errors = {};
    Object.keys(schema || {}).forEach(function (k) {
      var checks = schema[k];
      if (!Array.isArray(checks)) checks = [checks];
      for (var i = 0; i < checks.length; i++) {
        var c = checks[i];
        var fn, param;
        if (typeof c === 'function') { fn = c; param = undefined; }
        else if (typeof c === 'string') { fn = rules[c]; param = undefined; }
        else { fn = rules[c.rule]; param = c.param; }
        if (!fn) continue;
        var result = fn(values[k], values, param);
        if (result !== true) { errors[k] = result; break; }
      }
    });
    return { ok: Object.keys(errors).length === 0, errors: errors };
  }
  // Decorates the rendered .ent-field wrappers with .is-invalid + sets error msg
  function applyErrors(host, errors) {
    if (!host || !errors) return;
    Array.prototype.forEach.call(host.querySelectorAll('[data-ent-field]'), function (el) {
      el.classList.remove('is-invalid');
      var msgEl = el.querySelector('[data-ent-err-msg]');
      if (msgEl) msgEl.textContent = '';
    });
    Object.keys(errors).forEach(function (k) {
      var el = host.querySelector('[data-ent-field="' + k + '"]');
      if (!el) return;
      el.classList.add('is-invalid');
      var msgEl = el.querySelector('[data-ent-err-msg]');
      if (msgEl) msgEl.textContent = errors[k];
    });
  }

  // ───────────────────────── StateManager (tiny pub/sub) ─────────────────────────
  function createState(initial) {
    var state = Object.assign({}, initial || {});
    var listeners = [];
    return {
      get: function (k) { return k ? state[k] : state; },
      set: function (patch) {
        Object.assign(state, patch || {});
        listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
      },
      reset: function (next) {
        state = Object.assign({}, next || {});
        listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
      },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
      }
    };
  }

  // ───────────────────────── ErrorHandler ─────────────────────────
  var ErrorHandler = {
    show: function (host, msg, opts) {
      opts = opts || {};
      if (typeof host === 'string') host = document.querySelector(host);
      if (!host) return;
      host.innerHTML = '<div class="ent-error-state">' +
        '<i class="fas fa-circle-xmark"></i>' +
        '<div class="ent-error-state-title">' + esc(opts.title || 'حدث خطأ') + '</div>' +
        '<div class="ent-error-state-text">' + esc(msg || '') + '</div>' +
      '</div>';
    },
    toast: function (msg, isError) {
      // Defer to the host app's showToast if present.
      if (typeof window.showToast === 'function') return window.showToast(msg, !!isError);
      console.error('[EntUI]', msg);
    }
  };

  // ───────────────────────── PermissionGuard ─────────────────────────
  // Map of action → roles allowed. Override by setting EntUI.Permission.actions.
  var Permission = {
    actions: {
      'transfers.approve': ['admin','manager'],
      'transfers.issue':   ['admin','manager','warehouse'],
      'transfers.receive': ['admin','manager','warehouse','custody'],
      'transfers.reverse': ['admin','manager'],
      'transfers.delete':  ['admin'],
      'stocktake.approve': ['admin','manager'],
      'stocktake.delete':  ['admin'],
      'adjustments.approve':['admin','manager'],
      'adjustments.create': ['admin','manager','warehouse'],
      'adjustments.delete': ['admin']
    },
    role: function () {
      try {
        var s = window.state && window.state.user;
        if (s && s.role) return String(s.role).toLowerCase();
      } catch (e) {}
      try {
        var raw = localStorage.getItem('pos_session');
        if (raw) return String(JSON.parse(raw).role || '').toLowerCase();
      } catch (e) {}
      return '';
    },
    can: function (action) {
      if (!action) return true;
      var role = Permission.role();
      if (!role) return false;
      // Admin can do anything.
      if (role === 'admin') return true;
      var allow = Permission.actions[action];
      if (!allow) return true; // Unknown actions default to allowed.
      return allow.indexOf(role) >= 0;
    }
  };

  // ───────────────────────── Wire global delegation for overlay close + attach ─────────────────────────
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    // Close buttons inside ent-header
    if (t && t.closest && t.closest('[data-ent-close]')) {
      var ov = t.closest('.ent-overlay');
      if (ov && ov.id && _overlays[ov.id]) _overlays[ov.id].close();
    }
  }, true);

  // ───────────────────────── Public surface ─────────────────────────
  var EntUI = {
    // Renderers
    overlay: overlay,
    header: header,
    summaryCard: summaryCard,
    summary: summary,
    tag: tag,
    banner: banner,
    section: section,
    table: table,
    timeline: timeline,
    actionBar: actionBar,
    button: button,
    field: field,
    formGrid: formGrid,
    kv: kv,
    infoCard: infoCard,
    attachments: attachments,
    pager: pager,
    // Behavior
    Validation: { rules: rules, run: validate, applyErrors: applyErrors },
    State: { create: createState },
    Error: ErrorHandler,
    Permission: Permission,
    // Utilities
    esc: esc, attr: attr,
    fmt: { qty: fmtQty, money: fmtMoney, date: fmtDate, dateShort: fmtDateShort, bytes: bytesFmt }
  };

  global.EntUI = EntUI;
})(typeof window !== 'undefined' ? window : this);
