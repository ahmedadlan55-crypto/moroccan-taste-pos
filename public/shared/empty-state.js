/**
 * Empty State Component — v6.4
 * ─────────────────────────────────────────────────────────────
 * Premium empty-state pattern with inline SVG illustrations, title,
 * description, and optional CTA. Replaces "لا توجد بيانات" anti-pattern.
 *
 * Usage:
 *   EmptyState.render({
 *     icon: 'inbox' | 'paper-plane' | 'search' | 'shield' | 'celebrate' | 'database',
 *     title: 'لا توجد معاملات بانتظارك',
 *     description: 'عندما يرسل لك أحد معاملة للمراجعة ستظهر هنا.',
 *     ctaLabel: 'إنشاء معاملة جديدة',
 *     ctaOnClick: 'wfOpenNewTxnModal()',   // string or function ref
 *     ctaSecondaryLabel: 'استكشف القوالب',  // optional
 *   })
 *
 * Returns: HTML string ready to inject into a container or <td>.
 *
 * Inline SVG illustrations sized 96×96, soft gradients matching design tokens.
 */
(function(global){
  'use strict';
  if (global.EmptyState) return;

  var _cssInjected = false;
  function _injectCss(){
    if (_cssInjected) return;
    _cssInjected = true;
    var s = document.createElement('style');
    s.id = 'empty-state-css';
    s.textContent = [
      '.es-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;}',
      '.es-illustration{width:96px;height:96px;margin-bottom:18px;}',
      '.es-title{font-size:17px;font-weight:800;color:#0f172a;margin:0 0 8px;letter-spacing:-0.01em;}',
      '.es-desc{font-size:13.5px;line-height:1.65;color:#64748b;max-width:380px;margin:0 0 22px;}',
      '.es-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.es-cta{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:10px;border:none;background:#2563eb;color:#fff;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;transition:transform .15s,box-shadow .15s;}',
      '.es-cta:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(37,99,235,.25);}',
      '.es-cta.secondary{background:transparent;color:#475569;border:1.5px solid #cbd5e1;}',
      '.es-cta.secondary:hover{background:#f8fafc;}',
      // When dropped inside a <td colspan> in a table
      'td > .es-wrap{padding:36px 16px;}',
      // Compact variant for sidebars / small cards
      '.es-wrap.compact{padding:24px 16px;}',
      '.es-wrap.compact .es-illustration{width:64px;height:64px;margin-bottom:12px;}',
      '.es-wrap.compact .es-title{font-size:14px;}',
      '.es-wrap.compact .es-desc{font-size:12px;margin-bottom:14px;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── SVG illustration library ──────────────────────────────────────────────
  var ILLUSTRATIONS = {
    inbox: '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset="1" stop-color="#bfdbfe"/></linearGradient></defs>' +
      '<rect x="14" y="38" width="68" height="42" rx="6" fill="url(#es-g1)" stroke="#3b82f6" stroke-width="2"/>' +
      '<path d="M14 56 L34 56 L40 64 L56 64 L62 56 L82 56" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<rect x="28" y="18" width="40" height="24" rx="3" fill="#fff" stroke="#94a3b8" stroke-width="1.5"/>' +
      '<line x1="34" y1="26" x2="62" y2="26" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>' +
      '<line x1="34" y1="32" x2="54" y2="32" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>',

    'paper-plane': '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs>' +
      '<path d="M14 50 L82 18 L70 78 L46 56 L32 70 L46 56 L14 50Z" fill="url(#es-g2)" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M46 56 L82 18" stroke="#b45309" stroke-width="1.5" stroke-dasharray="2 3"/>' +
      '</svg>',

    search: '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0e7ff"/><stop offset="1" stop-color="#c7d2fe"/></linearGradient></defs>' +
      '<circle cx="40" cy="40" r="24" fill="url(#es-g3)" stroke="#0e7490" stroke-width="2.5"/>' +
      '<line x1="58" y1="58" x2="78" y2="78" stroke="#0e7490" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="40" cy="40" r="14" fill="none" stroke="#a5b4fc" stroke-width="1.5"/>' +
      '</svg>',

    shield: '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dcfce7"/><stop offset="1" stop-color="#bbf7d0"/></linearGradient></defs>' +
      '<path d="M48 12 L78 24 L78 50 Q78 70 48 84 Q18 70 18 50 L18 24 Z" fill="url(#es-g4)" stroke="#16a34a" stroke-width="2.5"/>' +
      '<path d="M34 48 L44 58 L62 38" fill="none" stroke="#15803d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',

    celebrate: '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fce7f3"/><stop offset="1" stop-color="#fbcfe8"/></linearGradient></defs>' +
      '<circle cx="48" cy="50" r="28" fill="url(#es-g5)"/>' +
      '<path d="M36 46 Q40 40 44 46" fill="none" stroke="#be185d" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M52 46 Q56 40 60 46" fill="none" stroke="#be185d" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M36 58 Q48 70 60 58" fill="none" stroke="#be185d" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="22" cy="22" r="3" fill="#f59e0b"/>' +
      '<circle cx="76" cy="20" r="2.5" fill="#3b82f6"/>' +
      '<circle cx="80" cy="60" r="2" fill="#16a34a"/>' +
      '<circle cx="14" cy="64" r="2.5" fill="#dc2626"/>' +
      '</svg>',

    database: '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="es-g6" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient></defs>' +
      '<ellipse cx="48" cy="22" rx="28" ry="8" fill="url(#es-g6)" stroke="#94a3b8" stroke-width="2"/>' +
      '<path d="M20 22 L20 50 Q20 58 48 58 Q76 58 76 50 L76 22" fill="url(#es-g6)" stroke="#94a3b8" stroke-width="2"/>' +
      '<path d="M20 50 L20 74 Q20 82 48 82 Q76 82 76 74 L76 50" fill="url(#es-g6)" stroke="#94a3b8" stroke-width="2"/>' +
      '<ellipse cx="48" cy="50" rx="28" ry="8" fill="none" stroke="#94a3b8" stroke-width="1.5"/>' +
      '</svg>',
  };

  function _esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  /**
   * Render an empty-state element.
   * @param {object} opts
   * @param {string} opts.icon - 'inbox'|'paper-plane'|'search'|'shield'|'celebrate'|'database'
   * @param {string} opts.title - main heading (Arabic)
   * @param {string} [opts.description] - explainer line
   * @param {string} [opts.ctaLabel] - primary action label
   * @param {string} [opts.ctaOnClick] - inline onclick (string)
   * @param {string} [opts.ctaSecondaryLabel] - secondary action label
   * @param {string} [opts.ctaSecondaryOnClick] - inline onclick (string)
   * @param {boolean} [opts.compact] - smaller variant
   */
  function render(opts){
    _injectCss();
    opts = opts || {};
    var svg = ILLUSTRATIONS[opts.icon] || ILLUSTRATIONS.inbox;
    var compactCls = opts.compact ? ' compact' : '';
    var html = '<div class="es-wrap'+compactCls+'" role="status">';
    html += '<div class="es-illustration">'+svg+'</div>';
    html += '<h3 class="es-title">'+_esc(opts.title || 'لا توجد بيانات')+'</h3>';
    if (opts.description) {
      html += '<p class="es-desc">'+_esc(opts.description)+'</p>';
    }
    if (opts.ctaLabel || opts.ctaSecondaryLabel) {
      html += '<div class="es-actions">';
      if (opts.ctaLabel) {
        html += '<button class="es-cta"'+(opts.ctaOnClick?' onclick="'+_esc(opts.ctaOnClick)+'"':'')+'>'+
                '<i class="fas fa-plus"></i>'+_esc(opts.ctaLabel)+'</button>';
      }
      if (opts.ctaSecondaryLabel) {
        html += '<button class="es-cta secondary"'+(opts.ctaSecondaryOnClick?' onclick="'+_esc(opts.ctaSecondaryOnClick)+'"':'')+'>'+
                _esc(opts.ctaSecondaryLabel)+'</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  global.EmptyState = { render: render, ILLUSTRATIONS: ILLUSTRATIONS };
})(typeof window !== 'undefined' ? window : this);
