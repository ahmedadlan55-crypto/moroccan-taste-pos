/**
 * TxnView — Unified Professional Transaction Detail Modal (V5.4)
 * ───────────────────────────────────────────────────────────────────
 * One world-class component used by BOTH admin (erp.js) AND employee (app.js).
 * Replaces the divergent wfViewTxn / viewMyTxn implementations.
 *
 * Public API:
 *   TxnView.open(txnId, options)
 *     options.onAction(actionType)  — called when user takes an action button
 *     options.actions = ['approve','reject','return','forward','reply','close']
 *
 * Sections rendered (top→bottom):
 *   1. Header strip          — # / title / status badge / importance
 *   2. Workflow timeline      — Ant-Design-style horizontal stepper
 *   3. Meta grid              — From / To / Dates (created/due/Hijri) / Branch / Dept / Amount
 *   4. Subject + Content      — sanitized HTML
 *   5. Attachments grid       — images preview + PDFs embedded + others as cards
 *   6. Action log timeline    — every step with actor + position + branch + note + attachments
 *   7. Replies thread         — chronological with attachments
 *   8. Action buttons         — approve / reject / return / forward / reply / close
 */
(function(global){
  'use strict';
  if (global.TxnView) return;

  const ARROW = (typeof document !== 'undefined' && getComputedStyle(document.documentElement).direction === 'rtl') ? '←' : '→';

  function _esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Lightweight HTML sanitizer (whitelist) — same approach as employee app.
  function _sanitize(html){
    if (!html) return '';
    const SAFE = ['B','I','U','EM','STRONG','BR','P','DIV','SPAN','UL','OL','LI','A','H1','H2','H3','H4','H5','H6','TABLE','THEAD','TBODY','TR','TD','TH','BLOCKQUOTE','CODE','PRE','HR','SMALL','SUB','SUP'];
    const d = document.createElement('div'); d.innerHTML = String(html);
    function walk(n){
      [...n.childNodes].forEach(c=>{
        if (c.nodeType !== 1) return;
        if (SAFE.indexOf(c.tagName) === -1) {
          const t = document.createTextNode(c.textContent || '');
          c.parentNode.replaceChild(t, c); return;
        }
        for (let i = c.attributes.length-1; i >= 0; i--){
          const a = c.attributes[i];
          let keep = false;
          if (c.tagName === 'A' && a.name === 'href') {
            const v = (a.value||'').trim().toLowerCase();
            if (v.startsWith('http://')||v.startsWith('https://')||v.startsWith('mailto:')||v.startsWith('/')) keep = true;
          }
          if (!keep) c.removeAttribute(a.name);
        }
        if (c.tagName === 'A') { c.setAttribute('rel','noopener noreferrer'); c.setAttribute('target','_blank'); }
        walk(c);
      });
    }
    walk(d);
    return d.innerHTML;
  }

  function _statusBadge(status){
    if (global.TxnConst && global.TxnConst.statusBadge) return global.TxnConst.statusBadge(status);
    return '<span class="tv-badge tv-badge-neutral">'+_esc(status)+'</span>';
  }
  function _statusLabel(status){
    return (global.TxnConst && global.TxnConst.statusLabel) ? global.TxnConst.statusLabel(status) : status;
  }
  function _importanceBadge(imp){
    if (global.TxnConst && global.TxnConst.importanceBadge) return global.TxnConst.importanceBadge(imp);
    return '<span class="tv-badge">'+_esc(imp)+'</span>';
  }
  function _actionLabel(a){
    return (global.TxnConst && global.TxnConst.actionLabel) ? global.TxnConst.actionLabel(a) : a;
  }
  function _fmtDate(d){
    return (global.TxnConst && global.TxnConst.fmtDate) ? global.TxnConst.fmtDate(d) : (d ? new Date(d).toLocaleDateString('ar-SA-u-nu-latn') : '—');
  }
  function _fmtDateTime(d){
    return (global.TxnConst && global.TxnConst.fmtDateTime) ? global.TxnConst.fmtDateTime(d) : (d ? new Date(d).toLocaleString('ar-SA-u-nu-latn') : '—');
  }
  function _money(n){
    var v = parseFloat(n||0);
    return v.toLocaleString('en',{minimumFractionDigits: 2, maximumFractionDigits: 2});
  }

  function _initials(name){
    name = String(name||'?').trim();
    if (!name) return '؟';
    var p = name.split(/\s+/);
    return ((p[0][0]||'') + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  // Color hash for actor avatars (deterministic)
  function _actorColor(name){
    var palette = ['#0ea5e9','#22c55e','#f59e0b','#a855f7','#ef4444','#06b6d4','#10b981','#6366f1','#ec4899','#f97316'];
    var s = String(name||'').toLowerCase();
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  function _ensureStyles(){
    if (document.getElementById('txnview-styles')) return;
    const s = document.createElement('style'); s.id = 'txnview-styles';
    s.textContent = `
      .tv-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);z-index:9990;display:flex;align-items:center;justify-content:center;padding:14px;animation:tv-fade .18s ease-out;}
      @keyframes tv-fade{from{opacity:0}to{opacity:1}}
      .tv-shell{background:#fff;border-radius:18px;width:100%;max-width:1100px;max-height:92vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.30);direction:rtl;font-family:'Tajawal',sans-serif;}
      .tv-head{padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:14px;background:linear-gradient(180deg,#f8fafc,#fff);flex-shrink:0;}
      .tv-head-icon{width:46px;height:46px;border-radius:14px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-size:20px;flex-shrink:0;}
      .tv-head-titles{flex:1;min-width:0;}
      .tv-num{font-family:'JetBrains Mono','Courier New',monospace;font-size:11px;color:#64748b;font-weight:700;letter-spacing:.5px;}
      .tv-title{font-size:17px;font-weight:800;color:#0f172a;margin:2px 0 0;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tv-head-meta{display:flex;gap:8px;align-items:center;flex-shrink:0;}
      .tv-x{width:36px;height:36px;border:0;background:#f1f5f9;border-radius:10px;font-size:22px;cursor:pointer;color:#64748b;display:grid;place-items:center;}
      .tv-x:hover{background:#fee2e2;color:#991b1b;}
      .tv-body{flex:1;overflow-y:auto;padding:18px 22px;background:#fafbfc;}
      .tv-foot{padding:14px 22px;border-top:1px solid #e2e8f0;background:#fff;display:flex;gap:10px;justify-content:flex-end;flex-shrink:0;flex-wrap:wrap;}
      .tv-section{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px;margin-bottom:14px;}
      .tv-section-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px dashed #e2e8f0;}
      .tv-section-head .ic{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-size:14px;flex-shrink:0;}
      .tv-section-head h4{margin:0;font-size:14px;font-weight:800;color:#0f172a;}
      .tv-section-head .count{margin-inline-start:auto;font-size:11px;font-weight:700;color:#64748b;background:#f1f5f9;padding:3px 10px;border-radius:999px;}

      /* Meta grid */
      .tv-meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;}
      .tv-meta-cell{padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;}
      .tv-meta-label{font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;}
      .tv-meta-value{font-size:13px;color:#0f172a;font-weight:700;}

      /* Status / importance badges (fallback styling) */
      .tv-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#f1f5f9;color:#475569;}

      /* Workflow timeline (Ant Design Steps style) */
      .tv-steps{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:6px 0;}
      .tv-step{display:flex;flex-direction:column;align-items:center;flex:1;min-width:120px;position:relative;}
      .tv-step-circle{width:36px;height:36px;border-radius:50%;border:2px solid #cbd5e1;background:#fff;color:#94a3b8;display:grid;place-items:center;font-weight:800;font-size:14px;z-index:2;}
      .tv-step.done .tv-step-circle{background:#16a34a;border-color:#16a34a;color:#fff;}
      .tv-step.current .tv-step-circle{background:#2563eb;border-color:#2563eb;color:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.18);}
      .tv-step.rejected .tv-step-circle{background:#dc2626;border-color:#dc2626;color:#fff;}
      .tv-step-line{position:absolute;top:18px;height:2px;background:#cbd5e1;z-index:1;}
      .tv-step-line.left{left:0;right:50%;}
      .tv-step-line.right{right:0;left:50%;}
      .tv-step.done .tv-step-line,
      .tv-step.current .tv-step-line.left{background:#16a34a;}
      .tv-step-info{margin-top:8px;text-align:center;max-width:130px;}
      .tv-step-name{font-size:12px;font-weight:700;color:#0f172a;line-height:1.3;}
      .tv-step-pos{font-size:10px;color:#64748b;margin-top:2px;}
      .tv-step.current .tv-step-name{color:#1d4ed8;}
      .tv-step.done .tv-step-name{color:#15803d;}

      /* Attachments grid */
      .tv-att-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;}
      .tv-att-card{position:relative;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;}
      .tv-att-card:hover{border-color:#2563eb;transform:translateY(-2px);box-shadow:0 6px 16px rgba(37,99,235,.15);}
      .tv-att-thumb{width:100%;height:120px;background:#0f172a;display:grid;place-items:center;color:#fff;font-size:36px;}
      .tv-att-thumb.image{background-size:cover;background-position:center;background-repeat:no-repeat;}
      .tv-att-thumb.pdf{background:#dc2626;}
      .tv-att-thumb.doc{background:#1d4ed8;}
      .tv-att-thumb.xls{background:#15803d;}
      .tv-att-thumb.ppt{background:#ea580c;}
      .tv-att-meta{padding:8px 10px;background:#fff;}
      .tv-att-name{font-size:11px;font-weight:700;color:#0f172a;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
      .tv-att-info{font-size:10px;color:#94a3b8;margin-top:3px;}

      /* Lightbox */
      .tv-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;animation:tv-fade .15s;}
      .tv-lightbox img{max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;}
      .tv-lightbox iframe{width:96vw;height:92vh;background:#fff;border:0;border-radius:8px;}
      .tv-lightbox-close{position:absolute;top:14px;inset-inline-end:14px;background:rgba(255,255,255,.18);border:0;color:#fff;width:42px;height:42px;border-radius:50%;cursor:pointer;font-size:22px;}
      .tv-lightbox-close:hover{background:#dc2626;}
      .tv-lightbox-dl{position:absolute;top:14px;inset-inline-start:14px;background:rgba(255,255,255,.18);color:#fff;border:0;padding:8px 16px;border-radius:10px;cursor:pointer;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:6px;}

      /* Action log timeline */
      .tv-log{position:relative;padding-inline-start:30px;}
      .tv-log::before{content:'';position:absolute;inset-inline-start:14px;top:8px;bottom:8px;width:2px;background:#e2e8f0;}
      .tv-log-item{position:relative;margin-bottom:14px;display:flex;gap:12px;align-items:flex-start;}
      .tv-log-dot{position:absolute;inset-inline-start:-30px;top:6px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;border:3px solid #fff;z-index:2;flex-shrink:0;}
      .tv-log-card{flex:1;background:#fff;border:1px solid #e2e8f0;border-inline-start:3px solid #94a3b8;border-radius:12px;padding:10px 14px;}
      .tv-log-actor{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;}
      .tv-log-avatar{width:28px;height:28px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:10px;font-weight:800;flex-shrink:0;}
      .tv-log-name{font-weight:800;color:#0f172a;}
      .tv-log-pos{color:#7c3aed;font-size:11px;font-weight:700;}
      .tv-log-branch{color:#64748b;font-size:11px;}
      .tv-log-time{margin-inline-start:auto;color:#94a3b8;font-size:10px;}
      .tv-log-action{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:800;}
      .tv-log-note{margin-top:8px;font-size:13px;color:#334155;line-height:1.7;background:#f8fafc;padding:8px 12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;}
      /* Action color mapping */
      .tv-log-card.create{border-inline-start-color:#0ea5e9;}
      .tv-log-card.approve{border-inline-start-color:#16a34a;}
      .tv-log-card.reject{border-inline-start-color:#dc2626;}
      .tv-log-card.return{border-inline-start-color:#f59e0b;}
      .tv-log-card.forward{border-inline-start-color:#8b5cf6;}
      .tv-log-card.reply{border-inline-start-color:#06b6d4;}
      .tv-log-card.close{border-inline-start-color:#475569;}
      .tv-log-dot.create{background:#0ea5e9;} .tv-log-dot.approve{background:#16a34a;}
      .tv-log-dot.reject{background:#dc2626;} .tv-log-dot.return{background:#f59e0b;}
      .tv-log-dot.forward{background:#8b5cf6;} .tv-log-dot.reply{background:#06b6d4;}
      .tv-log-dot.close{background:#475569;}
      .tv-log-action.create{background:#dbeafe;color:#1e40af;}
      .tv-log-action.approve{background:#dcfce7;color:#15803d;}
      .tv-log-action.reject{background:#fee2e2;color:#991b1b;}
      .tv-log-action.return{background:#fef3c7;color:#92400e;}
      .tv-log-action.forward{background:#ede9fe;color:#6d28d9;}
      .tv-log-action.reply{background:#cffafe;color:#155e75;}
      .tv-log-action.close{background:#f1f5f9;color:#1e293b;}

      /* Replies */
      .tv-reply{display:flex;gap:10px;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:10px;}
      .tv-reply-body{flex:1;min-width:0;}
      .tv-reply-actor{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;}
      .tv-reply-text{margin-top:6px;font-size:13px;color:#334155;line-height:1.7;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px 12px;border-radius:8px;}

      /* Action buttons */
      .tv-btn{padding:10px 18px;min-height:42px;border-radius:10px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;display:inline-flex;align-items:center;gap:6px;transition:all .15s;}
      .tv-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08);}
      .tv-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}
      .tv-btn.success{background:#16a34a;color:#fff;border-color:#16a34a;}
      .tv-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626;}
      .tv-btn.warning{background:#f59e0b;color:#fff;border-color:#f59e0b;}
      .tv-btn.purple{background:#8b5cf6;color:#fff;border-color:#8b5cf6;}
      .tv-btn.ghost{background:transparent;border:0;color:#64748b;}

      /* Empty state */
      .tv-empty{text-align:center;color:#94a3b8;padding:24px;font-size:13px;}
      .tv-empty i{font-size:36px;display:block;margin-bottom:8px;color:#cbd5e1;}

      /* Mobile: full-screen sheet */
      @media (max-width: 700px) {
        .tv-overlay{padding:0;align-items:flex-end;}
        .tv-shell{max-width:100%;max-height:100vh;border-radius:14px 14px 0 0;}
        .tv-meta-grid{grid-template-columns:1fr 1fr;}
        .tv-att-grid{grid-template-columns:repeat(2,1fr);}
        .tv-steps{justify-content:flex-start;}
        .tv-step{min-width:90px;}
      }
    `;
    document.head.appendChild(s);
  }

  function _attIcon(mime){
    mime = String(mime||'').toLowerCase();
    if (mime.startsWith('image/')) return { kind: 'image', icon: 'fa-image' };
    if (mime === 'application/pdf') return { kind: 'pdf', icon: 'fa-file-pdf' };
    if (mime.includes('word') || mime.endsWith('.doc') || mime.endsWith('.docx')) return { kind: 'doc', icon: 'fa-file-word' };
    if (mime.includes('excel') || mime.includes('spreadsheet')) return { kind: 'xls', icon: 'fa-file-excel' };
    if (mime.includes('powerpoint') || mime.includes('presentation')) return { kind: 'ppt', icon: 'fa-file-powerpoint' };
    return { kind: 'other', icon: 'fa-file' };
  }

  function _renderAttGrid(attachments, lightboxFn){
    if (!attachments || !attachments.length) return '<div class="tv-empty"><i class="fas fa-paperclip"></i>لا توجد مرفقات.</div>';
    return '<div class="tv-att-grid">' + attachments.map((a, idx) => {
      var info = _attIcon(a.mime);
      var thumbStyle = '';
      var thumbInner = '<i class="fas '+info.icon+'"></i>';
      if (info.kind === 'image' && a.dataUrl) {
        thumbStyle = ' style="background-image:url(\''+a.dataUrl.replace(/'/g,'%27')+'\')"';
        thumbInner = '';
      }
      var ext = (a.fileName||'').split('.').pop();
      return '<div class="tv-att-card" data-att-idx="'+idx+'" title="'+_esc(a.fileName||'')+'">' +
               '<div class="tv-att-thumb '+info.kind+'"'+thumbStyle+'>'+thumbInner+'</div>' +
               '<div class="tv-att-meta">' +
                 '<div class="tv-att-name">'+_esc(a.fileName||a.id)+'</div>' +
                 '<div class="tv-att-info">'+_esc(ext.toUpperCase())+' • '+(a.uploadedBy?_esc(a.uploadedBy):'')+'</div>' +
               '</div>' +
             '</div>';
    }).join('') + '</div>';
  }

  function _openLightbox(att){
    _ensureStyles();
    var box = document.createElement('div');
    box.className = 'tv-lightbox';
    var info = _attIcon(att.mime);
    var content = '';
    if (info.kind === 'image') {
      content = '<img src="'+_esc(att.dataUrl||'')+'" alt="'+_esc(att.fileName||'')+'">';
    } else if (info.kind === 'pdf') {
      content = '<iframe src="'+_esc(att.dataUrl||'')+'#toolbar=1" title="'+_esc(att.fileName||'')+'"></iframe>';
    } else {
      content = '<div style="background:#fff;padding:40px 60px;border-radius:12px;text-align:center;"><i class="fas '+info.icon+'" style="font-size:64px;color:#475569;"></i><div style="margin-top:16px;font-weight:800;color:#0f172a;">'+_esc(att.fileName||'')+'</div><a class="tv-btn primary" style="margin-top:20px;display:inline-flex;text-decoration:none;" href="'+_esc(att.dataUrl||'')+'" download="'+_esc(att.fileName||'')+'"><i class="fas fa-download"></i> تنزيل</a></div>';
    }
    box.innerHTML = content +
      '<button class="tv-lightbox-close" aria-label="إغلاق">&times;</button>' +
      (att.dataUrl ? '<a class="tv-lightbox-dl" href="'+_esc(att.dataUrl)+'" download="'+_esc(att.fileName||'')+'"><i class="fas fa-download"></i> تنزيل</a>' : '');
    document.body.appendChild(box);
    function close(){ box.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    box.addEventListener('click', function(e){ if (e.target === box) close(); });
    box.querySelector('.tv-lightbox-close').onclick = close;
  }

  function _renderSteps(workflowPath){
    if (!workflowPath || !workflowPath.length) return '<div class="tv-empty"><i class="fas fa-route"></i>لا يوجد مسار سير محدد.</div>';
    return '<div class="tv-steps">' + workflowPath.map((s, i) => {
      var n = workflowPath.length;
      var leftLine = i > 0 ? '<div class="tv-step-line left"></div>' : '';
      var rightLine = i < n-1 ? '<div class="tv-step-line right"></div>' : '';
      var iconChar = s.state === 'done' ? '✓' : (s.state === 'rejected' ? '✗' : (i+1));
      return '<div class="tv-step '+s.state+'">' +
               leftLine + rightLine +
               '<div class="tv-step-circle">'+iconChar+'</div>' +
               '<div class="tv-step-info"><div class="tv-step-name">'+_esc(s.stepName||'خطوة '+(i+1))+'</div>' +
                 (s.positionName ? '<div class="tv-step-pos">'+_esc(s.positionName)+'</div>' : '') +
               '</div>' +
             '</div>';
    }).join('') + '</div>';
  }

  function _renderLog(logs){
    if (!logs || !logs.length) return '<div class="tv-empty"><i class="fas fa-history"></i>لا توجد إجراءات بعد.</div>';
    return '<div class="tv-log">' + logs.map(l => {
      var act = l.actionType || 'create';
      var actLabel = _actionLabel(act);
      var color = _actorColor(l.actionBy);
      var posIcon = act === 'create' ? 'fa-plus' :
                    act === 'approve' ? 'fa-check' :
                    act === 'reject'  ? 'fa-times' :
                    act === 'return'  ? 'fa-undo' :
                    act === 'forward' ? 'fa-share' :
                    act === 'reply'   ? 'fa-comment' :
                    act === 'close'   ? 'fa-lock' : 'fa-circle';
      return '<div class="tv-log-item">' +
               '<div class="tv-log-dot '+act+'"><i class="fas '+posIcon+'"></i></div>' +
               '<div class="tv-log-card '+act+'">' +
                 '<div class="tv-log-actor">' +
                   '<div class="tv-log-avatar" style="background:'+color+';">'+_esc(_initials(l.actorFullName||l.actionBy))+'</div>' +
                   '<span class="tv-log-name">'+_esc(l.actorFullName||l.actionBy||'مستخدم')+'</span>' +
                   (l.positionName ? '<span class="tv-log-pos"><i class="fas fa-id-badge" style="font-size:9px;"></i> '+_esc(l.positionName)+'</span>' : '') +
                   (l.actorBranchName ? '<span class="tv-log-branch">📍 '+_esc(l.actorBranchName)+'</span>' : '') +
                   '<span class="tv-log-time">'+_esc(_fmtDateTime(l.createdAt))+'</span>' +
                 '</div>' +
                 '<span class="tv-log-action '+act+'"><i class="fas '+posIcon+'" style="font-size:10px;"></i> '+_esc(actLabel)+'</span>' +
                 (l.note ? '<div class="tv-log-note">'+_esc(l.note)+'</div>' : '') +
               '</div>' +
             '</div>';
    }).join('') + '</div>';
  }

  function _renderReplies(replies){
    if (!replies || !replies.length) return '<div class="tv-empty"><i class="fas fa-comments"></i>لا توجد ردود.</div>';
    return replies.map(r => {
      var color = _actorColor(r.authorUsername);
      return '<div class="tv-reply">' +
               '<div class="tv-log-avatar" style="background:'+color+';width:36px;height:36px;font-size:12px;flex-shrink:0;">'+_esc(_initials(r.authorName||r.authorUsername))+'</div>' +
               '<div class="tv-reply-body">' +
                 '<div class="tv-reply-actor">' +
                   '<span class="tv-log-name">'+_esc(r.authorName||r.authorUsername)+'</span>' +
                   (r.authorPosition ? '<span class="tv-log-pos">'+_esc(r.authorPosition)+'</span>' : '') +
                   '<span class="tv-log-time" style="margin-inline-start:auto;">'+_esc(_fmtDateTime(r.createdAt))+'</span>' +
                 '</div>' +
                 '<div class="tv-reply-text">'+_esc(r.replyText||'')+'</div>' +
                 (r.attachment ? '<div style="margin-top:6px;font-size:11px;color:#0ea5e9;font-weight:700;"><i class="fas fa-paperclip"></i> '+_esc(r.attachmentName||'مرفق')+'</div>' : '') +
               '</div>' +
             '</div>';
    }).join('');
  }

  function _renderMeta(t){
    var dueColor = t.dueDate && new Date(t.dueDate) < new Date() ? '#dc2626' : '#0f172a';
    var rows = [
      ['# المعاملة', _esc(t.txnNumber || t.id)],
      ['الموضوع', _esc(t.subject || t.title || '')],
      ['من (المُنشئ)', _esc(t.senderName || t.createdBy || '—')],
      ['المنصب', _esc(t.senderPosition || '')],
      ['إلى (المسؤول الحالي)', _esc(t.currentAssignee || '—')],
      ['المنصب الحالي', _esc(t.currentRoleName || t.stepName || '')],
      ['الفرع', _esc(t.branchName || t.branchCode || '—')],
      ['القسم', _esc(t.deptName || t.deptCode || '—')],
      ['التاريخ', _esc(_fmtDateTime(t.createdAt))],
      ['تاريخ الاستحقاق', '<span style="color:'+dueColor+';">'+_esc(_fmtDate(t.dueDate))+'</span>'],
      ['التاريخ الهجري', _esc(t.hijriDate || '—')],
      ['المبلغ', _esc(_money(t.amount)) + ' ر.س'],
      ['نوع المعاملة', _esc(t.typeName || '')],
      ['مركز التكلفة', _esc(t.costCenterName || '—')],
      ['الحساب', _esc((t.accountCode||'') + ' ' + (t.accountName||'') || '—')],
      ['سرية المحتوى', _esc(t.contentSecrecy || 'normal')]
    ];
    return '<div class="tv-meta-grid">' + rows.map(r =>
      '<div class="tv-meta-cell"><div class="tv-meta-label">'+r[0]+'</div><div class="tv-meta-value">'+r[1]+'</div></div>'
    ).join('') + '</div>';
  }

  function _renderActions(opts, txnPerms){
    if (!opts || !Array.isArray(opts.actions)) return '<button class="tv-btn" data-tv-act="close">إغلاق</button>';
    var perms = txnPerms || {};
    var btns = ['<button class="tv-btn ghost" data-tv-act="close">إغلاق</button>'];
    if (opts.actions.includes('reply') && perms.canReply !== false)
      btns.push('<button class="tv-btn" data-tv-act="reply"><i class="fas fa-comment"></i> رد</button>');
    if (opts.actions.includes('return') && (perms.canReturn !== false))
      btns.push('<button class="tv-btn warning" data-tv-act="return"><i class="fas fa-undo"></i> إعادة للتعديل</button>');
    if (opts.actions.includes('forward') && (perms.canForward !== false))
      btns.push('<button class="tv-btn purple" data-tv-act="forward"><i class="fas fa-share"></i> تحويل</button>');
    if (opts.actions.includes('reject') && (perms.canReject !== false))
      btns.push('<button class="tv-btn danger" data-tv-act="reject"><i class="fas fa-times"></i> رفض</button>');
    if (opts.actions.includes('approve') && (perms.canApprove !== false))
      btns.push('<button class="tv-btn success" data-tv-act="approve"><i class="fas fa-check"></i> اعتماد</button>');
    if (opts.actions.includes('close') && perms.canClose)
      btns.push('<button class="tv-btn primary" data-tv-act="close-txn"><i class="fas fa-lock"></i> إغلاق نهائي</button>');
    return btns.join('');
  }

  function _getToken(){
    return localStorage.getItem('pos_token') || localStorage.getItem('emp_token') || '';
  }
  function _currentUser(){
    return (window.currentUser) || localStorage.getItem('pos_username') || localStorage.getItem('emp_username') || '';
  }

  function _fetchBundle(id){
    var token = _getToken();
    var u = _currentUser();
    return fetch('/api/workflow/transactions/'+encodeURIComponent(id)+'/full-bundle?username='+encodeURIComponent(u),
      { headers: { 'Authorization': 'Bearer '+token, 'X-User': u } }
    ).then(r => r.json());
  }

  function _renderError(msg, txnId){
    return '<div class="tv-empty" style="padding:60px 20px;color:#dc2626;">' +
             '<i class="fas fa-triangle-exclamation"></i>' +
             '<div style="font-weight:800;margin-bottom:8px;">'+_esc(msg)+'</div>' +
             '<button class="tv-btn primary" onclick="TxnView.open(\''+_esc(txnId)+'\')"><i class="fas fa-rotate"></i> إعادة المحاولة</button>' +
           '</div>';
  }

  function open(txnId, opts){
    if (!txnId) return;
    opts = opts || {};
    _ensureStyles();
    var existing = document.getElementById('tv-overlay'); if (existing) existing.remove();
    var ov = document.createElement('div');
    ov.className = 'tv-overlay';
    ov.id = 'tv-overlay';
    ov.setAttribute('role','dialog');
    ov.setAttribute('aria-modal','true');
    ov.setAttribute('aria-labelledby','tvTitle');
    ov.innerHTML =
      '<div class="tv-shell">' +
        '<div class="tv-head">' +
          '<div class="tv-head-icon"><i class="fas fa-file-alt"></i></div>' +
          '<div class="tv-head-titles">' +
            '<div class="tv-num" id="tvNum">جاري التحميل...</div>' +
            '<h3 class="tv-title" id="tvTitle">جاري تحميل المعاملة</h3>' +
          '</div>' +
          '<div class="tv-head-meta" id="tvHeadMeta"></div>' +
          '<button class="tv-x" data-tv-act="close" aria-label="إغلاق">&times;</button>' +
        '</div>' +
        '<div class="tv-body" id="tvBody">' +
          '<div class="tv-empty" style="padding:80px 20px;"><i class="fas fa-spinner fa-spin" style="color:#2563eb;"></i><div>جاري تحميل البيانات...</div></div>' +
        '</div>' +
        '<div class="tv-foot" id="tvFoot">' +
          '<button class="tv-btn ghost" data-tv-act="close">إغلاق</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    function close(){
      ov.remove();
      document.removeEventListener('keydown', onKey);
      if (typeof opts.onClose === 'function') opts.onClose();
    }
    function onKey(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function(e){
      if (e.target === ov) close();
      var btn = e.target.closest('[data-tv-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-tv-act');
      if (act === 'close') return close();
      if (typeof opts.onAction === 'function') {
        var r = opts.onAction(act, { txnId: txnId, close: close });
        if (r === true) close();
      }
    });

    // Fetch the bundle
    _fetchBundle(txnId).then(function(t){
      if (!t || t.error) {
        document.getElementById('tvBody').innerHTML = _renderError(t && t.error || 'فشل تحميل المعاملة', txnId);
        return;
      }
      // Header
      document.getElementById('tvNum').textContent = (t.txnNumber || t.id) + (t.typeName ? ' • ' + t.typeName : '');
      document.getElementById('tvTitle').textContent = t.subject || t.title || '(بدون عنوان)';
      document.getElementById('tvHeadMeta').innerHTML = _statusBadge(t.status) + ' ' + _importanceBadge(t.importance||'medium');

      // Body
      var html = '';
      // Workflow timeline
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#dbeafe;color:#1d4ed8;"><i class="fas fa-route"></i></div>' +
                '<h4>مسار سير العمل</h4>' +
                (t.workflowPath ? '<span class="count">'+t.workflowPath.length+' خطوة</span>' : '') +
                '</div>' +
                _renderSteps(t.workflowPath || []) +
              '</div>';
      // Meta
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#fef3c7;color:#92400e;"><i class="fas fa-info-circle"></i></div>' +
                '<h4>التفاصيل الكاملة</h4></div>' +
                _renderMeta(t) +
              '</div>';
      // Content
      var content = t.contentHtml ? _sanitize(t.contentHtml) : (t.description ? _esc(t.description).replace(/\n/g,'<br>') : '');
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#dcfce7;color:#15803d;"><i class="fas fa-file-lines"></i></div>' +
                '<h4>محتوى المعاملة</h4></div>' +
                (content ? '<div style="font-size:14px;line-height:1.95;color:#0f172a;">'+content+'</div>'
                         : '<div class="tv-empty"><i class="fas fa-file-circle-question"></i>لا يوجد محتوى نصي.</div>') +
              '</div>';
      // Attachments — combine the legacy single + the multi-attachments table
      var allAtts = (t.attachments || []).slice();
      if (t.attachmentDataUrl && typeof t.attachmentDataUrl === 'string' && t.attachmentDataUrl.startsWith('data:')) {
        // Front-load the original creation attachment
        var mime = t.attachmentDataUrl.match(/^data:([^;,]+)/);
        allAtts.unshift({
          id: '__creation__',
          fileName: 'مرفق إنشاء المعاملة',
          mime: mime ? mime[1] : '',
          dataUrl: t.attachmentDataUrl,
          uploadedBy: t.createdBy,
          uploadedAt: t.createdAt
        });
      }
      // Pull replies attachments (each reply's attachment) into the grid too
      (t.replies || []).forEach(function(r){
        if (r.attachment && r.attachment.startsWith && r.attachment.startsWith('data:')) {
          var m = r.attachment.match(/^data:([^;,]+)/);
          allAtts.push({
            id: 'reply-'+r.id,
            fileName: r.attachmentName || ('مرفق رد - ' + (r.authorName||r.authorUsername)),
            mime: m ? m[1] : (r.attachmentMime||''),
            dataUrl: r.attachment,
            uploadedBy: r.authorUsername,
            uploadedAt: r.createdAt
          });
        }
      });
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#ede9fe;color:#6d28d9;"><i class="fas fa-paperclip"></i></div>' +
                '<h4>المرفقات</h4>' +
                '<span class="count">' + allAtts.length + ' ملف</span></div>' +
                _renderAttGrid(allAtts) +
              '</div>';
      // Action log
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#fef3c7;color:#b45309;"><i class="fas fa-history"></i></div>' +
                '<h4>سجل الإجراءات</h4>' +
                '<span class="count">' + ((t.logs||[]).length) + ' حدث</span></div>' +
                _renderLog(t.logs || []) +
              '</div>';
      // Replies thread
      html += '<div class="tv-section">' +
                '<div class="tv-section-head"><div class="ic" style="background:#cffafe;color:#155e75;"><i class="fas fa-comments"></i></div>' +
                '<h4>الردود والتعليقات</h4>' +
                '<span class="count">' + ((t.replies||[]).length) + ' رد</span></div>' +
                _renderReplies(t.replies || []) +
              '</div>';

      document.getElementById('tvBody').innerHTML = html;

      // Wire attachment cards → lightbox
      ov.querySelectorAll('[data-att-idx]').forEach(function(card){
        card.addEventListener('click', function(){
          var idx = parseInt(card.getAttribute('data-att-idx')||'0', 10);
          if (allAtts[idx]) _openLightbox(allAtts[idx]);
        });
      });

      // Footer actions
      document.getElementById('tvFoot').innerHTML = _renderActions(opts, t.permissions || {});
    }).catch(function(e){
      document.getElementById('tvBody').innerHTML = _renderError(e && e.message || 'خطأ غير متوقع', txnId);
    });
  }

  global.TxnView = { open: open };
})(window);
