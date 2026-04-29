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

      /* Lightbox — V5.4.2 redesigned with consistent toolbar */
      .tv-lightbox{position:fixed;inset:0;background:rgba(15,23,42,.94);backdrop-filter:blur(8px);z-index:10000;display:flex;flex-direction:column;animation:tv-fade .18s ease-out;direction:rtl;}
      .tv-lb-toolbar{flex-shrink:0;background:#0f172a;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:14px;border-bottom:1px solid rgba(255,255,255,.08);box-shadow:0 4px 14px rgba(0,0,0,.4);}
      .tv-lb-info{flex:1;min-width:0;display:flex;align-items:center;gap:12px;}
      .tv-lb-info-icon{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;font-size:18px;flex-shrink:0;color:#fff;}
      .tv-lb-info-icon.image{background:#0ea5e9;}
      .tv-lb-info-icon.pdf{background:#dc2626;}
      .tv-lb-info-icon.doc{background:#1d4ed8;}
      .tv-lb-info-icon.xls{background:#15803d;}
      .tv-lb-info-icon.ppt{background:#ea580c;}
      .tv-lb-info-icon.other{background:#475569;}
      .tv-lb-info-text{flex:1;min-width:0;}
      .tv-lb-info-name{font-size:14px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tv-lb-info-meta{font-size:11px;color:rgba(255,255,255,.6);margin-top:2px;}
      .tv-lb-actions{display:flex;gap:8px;align-items:center;flex-shrink:0;}
      .tv-lb-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;min-height:38px;border-radius:10px;background:rgba(255,255,255,.10);color:#fff;border:1px solid rgba(255,255,255,.12);cursor:pointer;font-weight:700;font-size:13px;font-family:inherit;text-decoration:none;transition:all .15s;}
      .tv-lb-btn:hover{background:rgba(255,255,255,.20);transform:translateY(-1px);}
      .tv-lb-btn.primary{background:#2563eb;border-color:#2563eb;}
      .tv-lb-btn.primary:hover{background:#1d4ed8;}
      .tv-lb-btn.close{background:transparent;}
      .tv-lb-btn.close:hover{background:#dc2626;border-color:#dc2626;}
      .tv-lb-btn i{font-size:13px;}
      .tv-lb-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;}
      .tv-lb-stage img{max-width:96vw;max-height:80vh;object-fit:contain;border-radius:10px;box-shadow:0 14px 50px rgba(0,0,0,.55);}
      .tv-lb-stage iframe{width:96vw;height:82vh;max-width:1200px;background:#fff;border:0;border-radius:10px;box-shadow:0 14px 50px rgba(0,0,0,.55);}
      .tv-lb-card{background:#fff;border-radius:16px;padding:48px 56px;text-align:center;max-width:480px;box-shadow:0 14px 50px rgba(0,0,0,.55);}
      .tv-lb-card-icon{width:84px;height:84px;border-radius:20px;margin:0 auto 18px;display:grid;place-items:center;font-size:36px;color:#fff;}
      .tv-lb-card-icon.pdf{background:#dc2626;} .tv-lb-card-icon.doc{background:#1d4ed8;}
      .tv-lb-card-icon.xls{background:#15803d;} .tv-lb-card-icon.ppt{background:#ea580c;}
      .tv-lb-card-icon.other{background:#475569;} .tv-lb-card-icon.image{background:#0ea5e9;}
      .tv-lb-card-name{font-size:18px;font-weight:800;color:#0f172a;margin-bottom:6px;word-break:break-word;}
      .tv-lb-card-meta{font-size:12px;color:#64748b;font-weight:600;}
      @media (max-width:600px) {
        .tv-lb-toolbar{padding:8px 10px;gap:8px;}
        .tv-lb-info-icon{width:36px;height:36px;font-size:14px;}
        .tv-lb-info-name{font-size:12px;}
        .tv-lb-btn span{display:none;}
        .tv-lb-btn{padding:8px 10px;}
      }

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

      /* Replies — V5.4.2 formal Arabic correspondence layout */
      .tv-letter{background:#fff;border:1px solid #e2e8f0;border-radius:14px;margin-bottom:18px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.04);transition:all .15s;}
      .tv-letter:hover{box-shadow:0 6px 18px rgba(15,23,42,.08);}
      .tv-letter-head{background:linear-gradient(180deg,#f8fafc,#fff);padding:12px 16px;display:flex;gap:14px;align-items:center;border-bottom:2px solid #e2e8f0;flex-wrap:wrap;}
      .tv-letter-avatar{width:44px;height:44px;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:900;font-size:14px;flex-shrink:0;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.08);}
      .tv-letter-head-text{flex:1;min-width:160px;}
      .tv-letter-name{font-size:15px;font-weight:800;color:#0f172a;line-height:1.3;}
      .tv-letter-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;font-size:11px;}
      .tv-letter-pos{color:#7c3aed;font-weight:700;background:#ede9fe;padding:2px 8px;border-radius:6px;}
      .tv-letter-branch{color:#0369a1;font-weight:700;background:#e0f2fe;padding:2px 8px;border-radius:6px;}
      .tv-letter-dates{font-size:11px;color:#64748b;text-align:end;line-height:1.7;background:#fafbfc;border:1px dashed #e2e8f0;border-radius:10px;padding:8px 12px;min-width:200px;}
      .tv-letter-date-row{display:flex;align-items:center;gap:6px;justify-content:flex-end;}
      .tv-letter-date-row i{color:#94a3b8;width:14px;}
      .tv-letter-date-row strong{color:#0f172a;font-weight:700;}
      .tv-letter-ttr{color:#16a34a;font-weight:800;}
      .tv-letter-body{padding:18px 22px 14px;font-family:'Tajawal','Amiri',serif;color:#1e293b;line-height:1.85;font-size:14.5px;}
      .tv-letter-greet{font-weight:800;color:#0f172a;font-size:15.5px;}
      .tv-letter-prelude{margin-top:6px;color:#475569;font-weight:600;}
      .tv-letter-text{margin-top:14px;padding:14px 18px;background:#f8fafc;border-inline-start:3px solid #2563eb;border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.95;color:#0f172a;}
      .tv-letter-atts{margin-top:14px;padding:12px 16px;background:#fffbeb;border:1px dashed #fcd34d;border-radius:10px;}
      .tv-letter-atts-label{font-size:12px;font-weight:800;color:#92400e;margin-bottom:8px;display:flex;align-items:center;gap:6px;}
      .tv-letter-att-img{display:inline-block;cursor:zoom-in;border-radius:10px;overflow:hidden;border:1.5px solid #e2e8f0;max-width:280px;background:#fff;transition:all .15s;}
      .tv-letter-att-img:hover{border-color:#0ea5e9;box-shadow:0 6px 16px rgba(14,165,233,.18);transform:translateY(-2px);}
      .tv-letter-att-img img{display:block;width:100%;max-width:280px;max-height:200px;object-fit:cover;}
      .tv-letter-att-img-meta{padding:7px 11px;background:#f8fafc;font-size:11.5px;color:#475569;display:flex;align-items:center;gap:6px;font-weight:700;}
      .tv-letter-att-img-meta i:first-child{color:#0ea5e9;}
      .tv-letter-att-file{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;cursor:pointer;transition:all .15s;max-width:420px;margin-top:6px;}
      .tv-letter-att-file:hover{border-color:#0ea5e9;background:#f0f9ff;transform:translateY(-1px);}
      .tv-letter-att-icon{width:40px;height:40px;border-radius:10px;color:#fff;display:grid;place-items:center;font-size:16px;flex-shrink:0;}
      .tv-letter-att-file.pdf .tv-letter-att-icon{background:#dc2626;}
      .tv-letter-att-file.doc .tv-letter-att-icon{background:#1d4ed8;}
      .tv-letter-att-file.xls .tv-letter-att-icon{background:#15803d;}
      .tv-letter-att-file.ppt .tv-letter-att-icon{background:#ea580c;}
      .tv-letter-att-file.image .tv-letter-att-icon{background:#0ea5e9;}
      .tv-letter-att-file.other .tv-letter-att-icon{background:#475569;}
      .tv-letter-att-info{flex:1;min-width:0;}
      .tv-letter-att-name{font-weight:800;font-size:13px;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tv-letter-att-type{font-size:10.5px;color:#64748b;margin-top:2px;font-weight:600;}
      .tv-letter-att-arrow{color:#0ea5e9;font-size:13px;}
      .tv-letter-closing{margin-top:18px;color:#475569;font-weight:600;}
      .tv-letter-signature{margin-top:8px;text-align:end;padding-top:10px;border-top:1px dashed #e2e8f0;}
      .tv-letter-sig-name{font-weight:800;color:#0f172a;font-size:14.5px;}
      .tv-letter-sig-pos{font-size:12px;color:#7c3aed;font-weight:700;margin-top:2px;}
      @media (max-width:600px){
        .tv-letter-head{flex-direction:column;align-items:flex-start;}
        .tv-letter-dates{text-align:start;width:100%;}
        .tv-letter-date-row{justify-content:flex-start;}
        .tv-letter-body{padding:14px 16px 12px;font-size:13.5px;}
        .tv-letter-text{padding:11px 14px;font-size:13.5px;}
      }

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

  // V5.4.2: redesigned lightbox with proper toolbar — close + open-in-tab + download
  // arranged consistently in a top bar regardless of file type.
  function _openLightbox(att){
    _ensureStyles();
    var box = document.createElement('div');
    box.className = 'tv-lightbox';
    var info = _attIcon(att.mime);
    var fileLabel = att.fileName || 'مرفق';
    var ext = (fileLabel.split('.').pop() || '').toUpperCase();
    var hasUrl = !!att.dataUrl;
    // The toolbar — shown for ALL file types in a consistent position
    var toolbar =
      '<div class="tv-lb-toolbar" role="toolbar" aria-label="أدوات المرفق">' +
        '<div class="tv-lb-info">' +
          '<div class="tv-lb-info-icon ' + info.kind + '"><i class="fas ' + info.icon + '"></i></div>' +
          '<div class="tv-lb-info-text">' +
            '<div class="tv-lb-info-name" title="' + _esc(fileLabel) + '">' + _esc(fileLabel) + '</div>' +
            '<div class="tv-lb-info-meta">' + _esc(ext || (att.mime || '').split('/')[1] || 'ملف') + (att.uploadedBy ? ' • ' + _esc(att.uploadedBy) : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="tv-lb-actions">' +
          (hasUrl ? '<button class="tv-lb-btn" data-act="open" type="button"><i class="fas fa-external-link-alt"></i> <span>فتح في تبويب</span></button>' : '') +
          (hasUrl ? '<a class="tv-lb-btn primary" href="' + _esc(att.dataUrl) + '" download="' + _esc(fileLabel) + '"><i class="fas fa-download"></i> <span>تنزيل</span></a>' : '') +
          '<button class="tv-lb-btn close" data-act="close" type="button" aria-label="إغلاق"><i class="fas fa-times"></i></button>' +
        '</div>' +
      '</div>';

    var content = '';
    if (info.kind === 'image' && hasUrl) {
      content = '<div class="tv-lb-stage"><img src="' + _esc(att.dataUrl) + '" alt="' + _esc(fileLabel) + '"></div>';
    } else if (info.kind === 'pdf' && hasUrl) {
      content = '<div class="tv-lb-stage"><iframe src="' + _esc(att.dataUrl) + '#toolbar=1" title="' + _esc(fileLabel) + '"></iframe></div>';
    } else {
      // Generic preview card for office docs etc.
      content =
        '<div class="tv-lb-stage">' +
          '<div class="tv-lb-card">' +
            '<div class="tv-lb-card-icon ' + info.kind + '"><i class="fas ' + info.icon + '"></i></div>' +
            '<div class="tv-lb-card-name">' + _esc(fileLabel) + '</div>' +
            '<div class="tv-lb-card-meta">' + _esc(ext || 'ملف') + (att.mime ? ' • ' + _esc(att.mime) : '') + '</div>' +
            '<div style="font-size:13px;color:#94a3b8;margin-top:14px;">المعاينة المباشرة غير متاحة لهذا النوع. استخدم زر "فتح" أو "تنزيل" أعلاه.</div>' +
          '</div>' +
        '</div>';
    }
    box.innerHTML = toolbar + content;
    document.body.appendChild(box);
    function close(){ box.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    // Close on backdrop click (NOT on toolbar/stage clicks)
    box.addEventListener('click', function(e){
      if (e.target === box) close();
    });
    box.querySelectorAll('[data-act]').forEach(function(btn){
      btn.addEventListener('click', function(e){
        var a = btn.getAttribute('data-act');
        if (a === 'close') { close(); return; }
        if (a === 'open' && hasUrl) {
          // For data: URLs Chrome/Safari blocks navigation — convert to blob: first.
          try {
            if (att.dataUrl.startsWith('data:')) {
              fetch(att.dataUrl).then(function(r){ return r.blob(); }).then(function(b){
                var url = URL.createObjectURL(b);
                window.open(url, '_blank', 'noopener,noreferrer');
                setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
              });
            } else {
              window.open(att.dataUrl, '_blank', 'noopener,noreferrer');
            }
          } catch(_e) { window.open(att.dataUrl, '_blank'); }
        }
      });
    });
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

  // V5.4.2: Reply rendering as FORMAL ARABIC CORRESPONDENCE
  // Each reply is its own letter card:
  //   ┌─ HEADER STRIP ─────────────────────────────────┐
  //   │ [👤] الاسم الكامل • المنصب • الفرع              │
  //   │      وصلت المعاملة: {date}  •  الرد: {date}    │
  //   └────────────────────────────────────────────────┘
  //   سعادة {المنصب} الموقر،
  //   تحية طيبة وبعد،
  //
  //     {نص الرد}
  //
  //   ولكم خالص الشكر والتقدير،
  //                              [signature: name + position]
  //   [مرفقات → grid]
  function _renderReplies(replies){
    if (!replies || !replies.length) {
      return '<div class="tv-empty"><i class="fas fa-comments"></i>لا توجد ردود بعد.</div>';
    }
    return replies.map((r, idx) => {
      var color = _actorColor(r.authorUsername);
      var displayName = r.authorName || r.authorUsername || 'مستخدم';
      var pos = r.authorPosition || '';
      var branch = r.authorBranch || '';
      var receivedFmt = r.receivedAt ? _fmtDateTime(r.receivedAt) : '—';
      var repliedFmt = r.createdAt ? _fmtDateTime(r.createdAt) : '—';
      // Compute time-to-reply
      var ttr = '';
      try {
        if (r.receivedAt && r.createdAt) {
          var diff = (new Date(r.createdAt).getTime() - new Date(r.receivedAt).getTime()) / 60000;
          if (diff < 60) ttr = 'خلال ' + Math.max(1, Math.round(diff)) + ' دقيقة';
          else if (diff < 1440) ttr = 'خلال ' + Math.round(diff/60) + ' ساعة';
          else ttr = 'خلال ' + Math.round(diff/1440) + ' يوم';
        }
      } catch(_) {}

      // ── Attachment rendering (inline, click → lightbox) ────────────
      var attHtml = '';
      if (r.attachment && typeof r.attachment === 'string') {
        var mime = r.attachmentMime || '';
        if (!mime && r.attachment.startsWith('data:')) {
          var m = r.attachment.match(/^data:([^;,]+)/);
          mime = m ? m[1] : '';
        }
        var info = _attIcon(mime);
        if (info.kind === 'image' && r.attachment.startsWith('data:')) {
          attHtml =
            '<div class="tv-letter-att-img" data-reply-att-idx="'+idx+'">' +
              '<img src="'+_esc(r.attachment)+'" alt="'+_esc(r.attachmentName||'مرفق')+'">' +
              '<div class="tv-letter-att-img-meta">' +
                '<i class="fas fa-image"></i>' +
                '<span>'+_esc(r.attachmentName||'صورة')+'</span>' +
                '<i class="fas fa-search-plus" style="margin-inline-start:auto;opacity:.6;font-size:10px;"></i>' +
              '</div>' +
            '</div>';
        } else if (r.attachment.startsWith('data:') || r.attachment.startsWith('http')) {
          attHtml =
            '<div class="tv-letter-att-file ' + info.kind + '" data-reply-att-idx="'+idx+'">' +
              '<div class="tv-letter-att-icon"><i class="fas '+info.icon+'"></i></div>' +
              '<div class="tv-letter-att-info">' +
                '<div class="tv-letter-att-name">'+_esc(r.attachmentName||'مرفق')+'</div>' +
                '<div class="tv-letter-att-type">'+_esc((mime||'').toUpperCase()||'ملف')+' • انقر للفتح</div>' +
              '</div>' +
              '<i class="fas fa-external-link-alt tv-letter-att-arrow"></i>' +
            '</div>';
        }
      }

      // ── Greeting line: "سعادة {position} الموقر،" — adapt for unknown position
      var greeting = pos
        ? 'سعادة ' + _esc(pos) + ' الموقر،'
        : 'تحية طيبة،';

      // ── Build the formal letter card
      return '<article class="tv-letter">' +
        // Header strip (RTL)
        '<header class="tv-letter-head">' +
          '<div class="tv-letter-avatar" style="background:'+color+';">'+_esc(_initials(displayName))+'</div>' +
          '<div class="tv-letter-head-text">' +
            '<div class="tv-letter-name">'+_esc(displayName)+'</div>' +
            '<div class="tv-letter-meta">' +
              (pos ? '<span class="tv-letter-pos"><i class="fas fa-id-badge"></i> '+_esc(pos)+'</span>' : '') +
              (branch ? '<span class="tv-letter-branch"><i class="fas fa-location-dot"></i> '+_esc(branch)+'</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="tv-letter-dates">' +
            '<div class="tv-letter-date-row"><i class="fas fa-inbox"></i> <span>وصلت المعاملة:</span> <strong>'+_esc(receivedFmt)+'</strong></div>' +
            '<div class="tv-letter-date-row"><i class="fas fa-paper-plane"></i> <span>الرد:</span> <strong>'+_esc(repliedFmt)+'</strong>' +
              (ttr ? ' <span class="tv-letter-ttr">('+_esc(ttr)+')</span>' : '') +
            '</div>' +
          '</div>' +
        '</header>' +
        // Letter body — formal Arabic format
        '<div class="tv-letter-body">' +
          '<div class="tv-letter-greet">'+greeting+'</div>' +
          '<div class="tv-letter-prelude">تحية طيبة وبعد،</div>' +
          '<div class="tv-letter-text">'+_esc(r.replyText||'')+'</div>' +
          (attHtml ? '<div class="tv-letter-atts"><div class="tv-letter-atts-label"><i class="fas fa-paperclip"></i> المرفقات:</div>'+attHtml+'</div>' : '') +
          '<div class="tv-letter-closing">ولكم خالص الشكر والتقدير،</div>' +
          '<div class="tv-letter-signature">' +
            '<div class="tv-letter-sig-name">'+_esc(displayName)+'</div>' +
            (pos ? '<div class="tv-letter-sig-pos">'+_esc(pos)+'</div>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
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

  // V5.4.1: render action buttons with STRICT assignee-gating.
  //   - Reply: any viewer can reply (it's a comment)
  //   - approve/reject/return/forward: ONLY the current_assignee
  //   - When status is terminal (approved/rejected/closed/cancelled): NO actions
  //   - admin/developer always sees the buttons (override)
  function _renderActions(opts, txnPerms, t){
    if (!opts || !Array.isArray(opts.actions)) return '<button class="tv-btn" data-tv-act="close">إغلاق</button>';
    var perms = txnPerms || {};
    var btns = ['<button class="tv-btn ghost" data-tv-act="close">إغلاق</button>'];
    var meName = _currentUser();
    var meIsAdmin = !!(window.currentUser && (window.currentUserRole === 'admin' || window.currentRole === 'admin'));
    // Admin role from localStorage as a fallback
    if (!meIsAdmin) {
      try { meIsAdmin = (localStorage.getItem('pos_role') === 'admin' || localStorage.getItem('emp_role') === 'admin'); } catch(_){}
    }
    var assignee = (t && (t.currentAssignee || t.current_assignee)) || '';
    var status = (t && t.status) || '';
    var isTerminal = ['approved','rejected','closed','cancelled'].indexOf(status) >= 0;
    var isReturned = status === 'returned';
    var isAssignee = !!(meName && assignee && (assignee === meName));
    var canActWorkflow = !isTerminal && (isAssignee || meIsAdmin);

    // Reply — anyone who can view the modal can reply (server permission engine still gates)
    if (opts.actions.includes('reply') && perms.canReply !== false && !isReturned) {
      btns.push('<button class="tv-btn" data-tv-act="reply"><i class="fas fa-comment"></i> رد</button>');
    }
    // Workflow actions — ONLY assignee/admin
    if (canActWorkflow) {
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
    } else if (!isTerminal && assignee && assignee !== meName) {
      // Show explainer message: "the txn is at X — only X can act"
      // V5.4.2: prefer full name + position over username
      var lockName = (t && t.currentAssigneeName && t.currentAssigneeName !== assignee)
        ? t.currentAssigneeName : assignee;
      var lockPos = (t && t.currentAssigneePosition) || '';
      btns.push(
        '<div style="margin-inline-end:auto;display:flex;align-items:center;gap:8px;padding:8px 14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;color:#92400e;font-size:12.5px;font-weight:700;">' +
          '<i class="fas fa-lock"></i> ' +
          'المعاملة بانتظار <strong style="color:#7c2d12;">' + _esc(lockName) + '</strong>' +
          (lockPos ? ' <span style="color:#a16207;font-weight:600;">(' + _esc(lockPos) + ')</span>' : '') +
          ' — فقط هو يستطيع اتخاذ الإجراء' +
        '</div>'
      );
    } else if (isTerminal) {
      btns.push(
        '<div style="margin-inline-end:auto;display:flex;align-items:center;gap:8px;padding:8px 14px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;color:#475569;font-size:12.5px;font-weight:700;">' +
          '<i class="fas fa-check-double"></i> المعاملة مغلقة — لا توجد إجراءات متاحة' +
        '</div>'
      );
    }
    return btns.join('');
  }

  // V5.4.1: prominent banner showing where the transaction has stopped.
  // Shows the assignee + position + branch + how long it's been stuck there.
  function _renderStoppedAt(t){
    var status = (t && t.status) || '';
    var isTerminal = ['approved','rejected','closed','cancelled'].indexOf(status) >= 0;
    if (isTerminal) {
      var color = status==='approved' ? '#16a34a' : (status==='rejected' ? '#dc2626' : '#475569');
      var bg    = status==='approved' ? '#dcfce7' : (status==='rejected' ? '#fee2e2' : '#f1f5f9');
      var icon  = status==='approved' ? 'fa-check-circle' : (status==='rejected' ? 'fa-times-circle' : 'fa-flag-checkered');
      var label = _statusLabel(status);
      return '<div style="margin-bottom:14px;padding:14px 18px;background:'+bg+';border:2px solid '+color+';border-radius:14px;display:flex;align-items:center;gap:12px;">' +
        '<div style="width:44px;height:44px;border-radius:50%;background:'+color+';color:#fff;display:grid;place-items:center;font-size:18px;flex-shrink:0;"><i class="fas '+icon+'"></i></div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:11px;font-weight:800;color:'+color+';text-transform:uppercase;letter-spacing:.5px;">الحالة النهائية</div>' +
          '<div style="font-size:16px;font-weight:800;color:#0f172a;margin-top:2px;">المعاملة '+_esc(label)+'</div>' +
        '</div>' +
      '</div>';
    }
    var assignee = (t && (t.currentAssignee || t.current_assignee)) || '';
    if (!assignee) return '';
    // V5.4.2: prefer full name over username everywhere in the banner
    var displayName = (t && t.currentAssigneeName && t.currentAssigneeName !== assignee)
      ? t.currentAssigneeName : assignee;
    var displayPosition = (t && (t.currentAssigneePosition || t.currentRoleName || t.stepName)) || '';
    var displayBranch = (t && t.currentAssigneeBranch) || '';

    // Find the most recent log entry for this assignee to estimate "stopped since"
    var stoppedSince = null;
    var logs = (t && t.logs) || [];
    for (var i = logs.length - 1; i >= 0; i--) {
      if (logs[i].actionType !== 'reply') {
        stoppedSince = logs[i].createdAt;
        break;
      }
    }
    var hoursStuck = stoppedSince ? Math.round((Date.now() - new Date(stoppedSince).getTime()) / (3600*1000)) : null;
    var stuckText = '';
    if (hoursStuck !== null) {
      if (hoursStuck < 1)        stuckText = 'منذ أقل من ساعة';
      else if (hoursStuck < 24)  stuckText = 'منذ ' + hoursStuck + ' ساعة';
      else                       stuckText = 'منذ ' + Math.round(hoursStuck/24) + ' يوم';
    }
    var dueOverdue = false;
    if (t && t.dueDate) {
      var due = new Date(t.dueDate);
      if (!isNaN(due.getTime()) && due.getTime() < Date.now()) dueOverdue = true;
    }
    var initials = _initials(displayName);
    var color2 = _actorColor(assignee);
    return '<div style="margin-bottom:14px;padding:14px 18px;background:linear-gradient(180deg,#fffbeb,#fff);border:2px solid #f59e0b;border-radius:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">' +
      '<div style="width:54px;height:54px;border-radius:50%;background:'+color2+';color:#fff;display:grid;place-items:center;font-size:18px;font-weight:900;flex-shrink:0;border:3px solid #fff;box-shadow:0 4px 12px rgba(245,158,11,.30);">'+_esc(initials)+'</div>' +
      '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:11px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.5px;">' +
          '<i class="fas fa-pause-circle"></i> توقفت المعاملة عند' +
        '</div>' +
        '<div style="font-size:17px;font-weight:800;color:#0f172a;margin-top:4px;">'+_esc(displayName)+'</div>' +
        (displayPosition ? '<div style="font-size:12px;color:#7c3aed;font-weight:700;margin-top:2px;"><i class="fas fa-id-badge" style="font-size:10px;"></i> '+_esc(displayPosition)+'</div>' : '') +
        (displayBranch ? '<div style="font-size:11px;color:#0369a1;font-weight:700;margin-top:2px;"><i class="fas fa-location-dot" style="font-size:10px;"></i> '+_esc(displayBranch)+'</div>' : '') +
        (stuckText ? '<div style="font-size:11px;color:#64748b;margin-top:4px;"><i class="fas fa-clock"></i> '+stuckText+'</div>' : '') +
      '</div>' +
      (dueOverdue ?
        '<div style="background:#dc2626;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:800;"><i class="fas fa-triangle-exclamation"></i> متجاوزة الاستحقاق</div>'
        : '') +
      '<div style="background:#fef3c7;color:#92400e;padding:8px 14px;border-radius:10px;font-size:12px;font-weight:800;border:1px solid #fcd34d;">' +
        '<i class="fas fa-key"></i> الإجراء متاح فقط لـ <strong>'+_esc(displayName)+'</strong>' +
      '</div>' +
    '</div>';
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
      // V5.4.1: Stopped-At banner — shown FIRST so user immediately sees who can act
      html += _renderStoppedAt(t);
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

      // V5.4.1: Wire reply attachment cards → lightbox.
      // Each reply with an attachment becomes its own lightbox-able item.
      var replies = t.replies || [];
      ov.querySelectorAll('[data-reply-att-idx]').forEach(function(card){
        card.addEventListener('click', function(e){
          // Don't intercept if user clicked an external link inside
          if (e.target.tagName === 'A') return;
          var idx = parseInt(card.getAttribute('data-reply-att-idx')||'0', 10);
          var r = replies[idx];
          if (!r || !r.attachment) return;
          if (typeof r.attachment === 'string' && (r.attachment.startsWith('data:') || r.attachment.startsWith('http'))) {
            var mime = r.attachmentMime || '';
            if (!mime && r.attachment.startsWith('data:')) {
              var m = r.attachment.match(/^data:([^;,]+)/);
              mime = m ? m[1] : '';
            }
            _openLightbox({
              fileName: r.attachmentName || ('مرفق رد - ' + (r.authorName||r.authorUsername||'')),
              mime: mime,
              dataUrl: r.attachment
            });
          }
        });
      });

      // V5.4.1: Footer actions — pass txn so we can lock to assignee.
      document.getElementById('tvFoot').innerHTML = _renderActions(opts, t.permissions || {}, t);
    }).catch(function(e){
      document.getElementById('tvBody').innerHTML = _renderError(e && e.message || 'خطأ غير متوقع', txnId);
    });
  }

  global.TxnView = { open: open };
})(window);
