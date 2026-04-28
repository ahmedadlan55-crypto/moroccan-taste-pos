/**
 * WoModal — Unified modal system (replaces 5 fragmented modal patterns).
 * Public API:
 *   WoModal.open({ icon, title, subtitle, body, footer, size, onClose })
 *   WoModal.confirm({ title, message, confirmText, cancelText, danger? })   → Promise<bool>
 *   WoModal.prompt({ title, label, placeholder, validate?, defaultValue })  → Promise<string|null>
 *   WoModal.alert({ icon, title, message, kind })                          → Promise<void>
 *   WoModal.toast({ message, kind })                                       → auto-dismiss
 *   WoModal.close(id?)                                                     → close (top or by id)
 *   WoModal.closeAll()
 */
(function(global){
  'use strict';
  if (global.WoModal) return;  // already loaded

  let _seq = 0;
  const _stack = [];

  function _ensureStyles(){
    if (document.getElementById('wo-modal-styles')) return;
    const s = document.createElement('style');
    s.id = 'wo-modal-styles';
    s.textContent = `
      .wom-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);
        backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;
        opacity:0;animation:wom-fade .18s ease-out forwards;padding:16px;}
      @keyframes wom-fade{to{opacity:1}}
      .wom-card{background:#fff;border-radius:16px;width:100%;max-width:560px;max-height:90vh;
        display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.25);
        transform:translateY(8px) scale(.98);animation:wom-pop .18s cubic-bezier(.4,0,.2,1) forwards;
        overflow:hidden;direction:rtl;}
      @keyframes wom-pop{to{transform:translateY(0) scale(1)}}
      .wom-card.size-sm{max-width:400px}
      .wom-card.size-lg{max-width:780px}
      .wom-card.size-xl{max-width:1100px}
      .wom-card.size-full{max-width:96vw;height:90vh}
      .wom-head{padding:18px 20px;display:flex;gap:14px;align-items:center;border-bottom:1px solid #f1f5f9;flex-shrink:0;}
      .wom-icon{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;font-size:20px;}
      .wom-icon.success{background:#d1fae5;color:#065f46}
      .wom-icon.warning{background:#fef3c7;color:#92400e}
      .wom-icon.danger {background:#fee2e2;color:#991b1b}
      .wom-icon.info   {background:#dbeafe;color:#1e40af}
      .wom-icon.purple {background:#ede9fe;color:#5b21b6}
      .wom-icon.neutral{background:#f1f5f9;color:#475569}
      .wom-titles{flex:1;min-width:0}
      .wom-title{font-size:17px;font-weight:700;color:#0f172a;margin:0;line-height:1.3}
      .wom-subtitle{font-size:13px;color:#64748b;margin-top:2px}
      .wom-x{background:transparent;border:0;font-size:22px;cursor:pointer;color:#64748b;width:36px;height:36px;border-radius:8px;display:grid;place-items:center;}
      .wom-x:hover{background:#f1f5f9;color:#0f172a}
      .wom-body{padding:20px;overflow-y:auto;flex:1;color:#334155;font-size:14px;line-height:1.6}
      .wom-foot{padding:14px 20px;border-top:1px solid #f1f5f9;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;background:#fafbfc;}
      .wom-btn{padding:9px 18px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;color:#334155;
        font-weight:600;cursor:pointer;font-size:14px;transition:all .15s;font-family:inherit;}
      .wom-btn:hover{background:#f8fafc;transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.06)}
      .wom-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
      .wom-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8}
      .wom-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626}
      .wom-btn.danger:hover{background:#b91c1c;border-color:#b91c1c}
      .wom-btn.success{background:#16a34a;color:#fff;border-color:#16a34a}
      .wom-btn.success:hover{background:#15803d;border-color:#15803d}
      .wom-input{width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;
        font-family:inherit;direction:rtl;transition:border-color .15s;}
      .wom-input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
      .wom-input.err{border-color:#dc2626}
      .wom-label{display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:6px}
      .wom-err{color:#dc2626;font-size:12px;margin-top:4px;display:none}
      .wom-err.show{display:block}
      .wom-toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;
        padding:12px 20px;border-radius:12px;z-index:10000;font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,.3);
        animation:wom-toast-in .25s ease-out, wom-toast-out .25s ease-in 3.5s forwards;direction:rtl;}
      .wom-toast.success{background:#15803d}
      .wom-toast.danger {background:#b91c1c}
      .wom-toast.warning{background:#b45309}
      @keyframes wom-toast-in {from{opacity:0;transform:translate(-50%,-12px)}to{opacity:1;transform:translate(-50%,0)}}
      @keyframes wom-toast-out{to{opacity:0;transform:translate(-50%,-12px)}}
      @media (max-width:600px){
        .wom-card{max-width:100%;max-height:100vh;border-radius:16px 16px 0 0;align-self:flex-end;}
        .wom-overlay{align-items:flex-end;padding:0;}
      }`;
    document.head.appendChild(s);
  }

  function _esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function open(opts){
    _ensureStyles();
    opts = opts || {};
    const id = 'wom-' + (++_seq);
    const overlay = document.createElement('div');
    overlay.className = 'wom-overlay';
    overlay.id = id;
    const size = opts.size || 'md';
    const iconHtml = opts.icon
      ? `<div class="wom-icon ${_esc(opts.iconKind||'info')}"><i class="fas ${_esc(opts.icon)}"></i></div>`
      : '';
    const subHtml = opts.subtitle ? `<div class="wom-subtitle">${_esc(opts.subtitle)}</div>` : '';
    const titleHtml = opts.title ? `<h3 class="wom-title">${_esc(opts.title)}</h3>` : '';
    const headHtml = (opts.title || opts.icon) ? `
      <div class="wom-head">
        ${iconHtml}
        <div class="wom-titles">${titleHtml}${subHtml}</div>
        ${opts.dismissible !== false ? `<button class="wom-x" data-act="close">&times;</button>` : ''}
      </div>` : '';
    const bodyHtml = opts.body ? `<div class="wom-body">${typeof opts.body === 'string' ? opts.body : ''}</div>` : '';
    const footHtml = opts.footer ? `<div class="wom-foot">${typeof opts.footer === 'string' ? opts.footer : ''}</div>` : '';
    overlay.innerHTML = `<div class="wom-card size-${_esc(size)}" data-id="${id}">${headHtml}${bodyHtml}${footHtml}</div>`;
    document.body.appendChild(overlay);
    if (opts.body && typeof opts.body !== 'string') {
      overlay.querySelector('.wom-body').appendChild(opts.body);
    }
    if (opts.footer && typeof opts.footer !== 'string') {
      overlay.querySelector('.wom-foot').appendChild(opts.footer);
    }
    overlay.addEventListener('click', (e)=>{
      if (e.target === overlay && opts.dismissibleOverlay !== false) close(id);
      if (e.target.matches('[data-act="close"]')) close(id);
    });
    const escHandler = (e)=>{ if (e.key==='Escape' && opts.dismissible !== false) close(id); };
    document.addEventListener('keydown', escHandler);
    _stack.push({ id, overlay, escHandler, onClose: opts.onClose });
    return { id, overlay, close: ()=>close(id) };
  }

  function close(id){
    const idx = id ? _stack.findIndex(x=>x.id===id) : _stack.length-1;
    if (idx < 0) return;
    const m = _stack[idx];
    m.overlay.style.animation = 'wom-fade .15s ease-in reverse forwards';
    document.removeEventListener('keydown', m.escHandler);
    setTimeout(()=>{
      m.overlay.remove();
      if (typeof m.onClose === 'function') m.onClose();
    }, 150);
    _stack.splice(idx,1);
  }

  function closeAll(){ while (_stack.length) close(); }

  function confirm(opts){
    opts = opts || {};
    return new Promise(resolve => {
      const m = open({
        icon: opts.danger ? 'fa-triangle-exclamation' : 'fa-circle-question',
        iconKind: opts.danger ? 'danger' : 'warning',
        title: opts.title || 'تأكيد العملية',
        body: `<div>${_esc(opts.message || 'هل أنت متأكد؟')}</div>`,
        footer: `
          <button class="wom-btn" data-act="cancel">${_esc(opts.cancelText || 'إلغاء')}</button>
          <button class="wom-btn ${opts.danger ? 'danger' : 'primary'}" data-act="ok">${_esc(opts.confirmText || 'تأكيد')}</button>
        `,
        size: 'sm',
        onClose: () => resolve(false)
      });
      m.overlay.querySelector('[data-act="ok"]').addEventListener('click', ()=>{
        const handler = _stack.find(x=>x.id===m.id);
        if (handler) handler.onClose = null;
        close(m.id); resolve(true);
      });
      m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
        close(m.id); resolve(false);
      });
    });
  }

  function prompt(opts){
    opts = opts || {};
    return new Promise(resolve => {
      const m = open({
        icon: 'fa-pen-to-square',
        iconKind: 'info',
        title: opts.title || 'أدخل القيمة',
        body: `
          ${opts.label ? `<label class="wom-label">${_esc(opts.label)}</label>` : ''}
          <input type="${opts.type || 'text'}" class="wom-input" data-fld="v"
            placeholder="${_esc(opts.placeholder||'')}" value="${_esc(opts.defaultValue||'')}"/>
          <div class="wom-err" data-fld="err"></div>
        `,
        footer: `
          <button class="wom-btn" data-act="cancel">إلغاء</button>
          <button class="wom-btn primary" data-act="ok">${_esc(opts.confirmText || 'موافق')}</button>
        `,
        size: 'sm',
        onClose: () => resolve(null)
      });
      const inp = m.overlay.querySelector('[data-fld="v"]');
      const err = m.overlay.querySelector('[data-fld="err"]');
      setTimeout(()=>inp.focus(), 50);
      const submit = ()=>{
        const v = inp.value;
        if (typeof opts.validate === 'function') {
          const e = opts.validate(v);
          if (e) {
            err.textContent = e; err.classList.add('show');
            inp.classList.add('err'); return;
          }
        }
        const handler = _stack.find(x=>x.id===m.id);
        if (handler) handler.onClose = null;
        close(m.id); resolve(v);
      };
      m.overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
      m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{ close(m.id); resolve(null); });
      inp.addEventListener('keydown', e => { if (e.key==='Enter') submit(); });
    });
  }

  function alert(opts){
    opts = opts || {};
    return new Promise(resolve => {
      const m = open({
        icon: opts.icon || (opts.kind==='success' ? 'fa-circle-check'
                          : opts.kind==='danger'  ? 'fa-circle-xmark'
                          : opts.kind==='warning' ? 'fa-triangle-exclamation' : 'fa-circle-info'),
        iconKind: opts.kind || 'info',
        title: opts.title || 'تنبيه',
        body: `<div>${_esc(opts.message || '')}</div>`,
        footer: `<button class="wom-btn primary" data-act="ok">حسناً</button>`,
        size: 'sm',
        onClose: () => resolve()
      });
      m.overlay.querySelector('[data-act="ok"]').addEventListener('click', ()=>{
        const handler = _stack.find(x=>x.id===m.id);
        if (handler) handler.onClose = null;
        close(m.id); resolve();
      });
    });
  }

  function toast(opts){
    _ensureStyles();
    opts = opts || {};
    const div = document.createElement('div');
    div.className = 'wom-toast ' + (opts.kind || '');
    div.textContent = opts.message || '';
    document.body.appendChild(div);
    setTimeout(()=>div.remove(), 4000);
  }

  global.WoModal = { open, close, closeAll, confirm, prompt, alert, toast };

  // Backward-compat shims for legacy calls
  if (!global.erpConfirm) {
    global.erpConfirm = (msg, ok)=>{ confirm({message:msg}).then(r=>{ if(r && typeof ok==='function') ok(); }); };
  }
  if (!global.erpToast) {
    global.erpToast = (msg, kind)=>toast({message:msg, kind:kind});
  }
})(window);
