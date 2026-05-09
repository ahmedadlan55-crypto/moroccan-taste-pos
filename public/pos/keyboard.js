/* ─────────────────────────────────────────────────────────────────
 * v5.12.0 — Virtual Keyboard for kiosk cashier
 * Auto-attaches to any input/textarea with [data-vk="1"]. Pops up
 * on focus, slides down on blur or click outside. Writes back to the
 * input via dispatched 'input' events so existing handlers
 * (e.g. renderMenuGrid) fire as if a hardware key were pressed.
 *
 * Layouts: AR (QWERTY-Arabic) + EN (QWERTY) + always-visible
 * numbers row. Initial language follows document.lang; subsequent
 * 🌐 toggles persist in localStorage('vk_lang').
 * ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var LAYOUTS = {
    en: [
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l'],
      ['z','x','c','v','b','n','m']
    ],
    ar: [
      ['ض','ص','ث','ق','ف','غ','ع','ه','خ','ح'],
      ['ش','س','ي','ب','ل','ا','ت','ن','م'],
      ['ئ','ء','ؤ','ر','لا','ى','ة','و','ز']
    ]
  };

  var NUMBERS = ['1','2','3','4','5','6','7','8','9','0'];

  var state = {
    el:        null,   // root <div id="vkKeyboard">
    target:    null,   // currently focused input
    lang:      'en',
    isShift:   false   // reserved for future capitalization
  };

  function chooseInitialLang() {
    try {
      var saved = localStorage.getItem('vk_lang');
      if (saved === 'ar' || saved === 'en') return saved;
    } catch (e) {}
    var docLang = (document.documentElement.lang || '').toLowerCase();
    return docLang.startsWith('ar') ? 'ar' : 'en';
  }

  function makeKey(label, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vk-key' + (opts.cls ? ' ' + opts.cls : '');
    b.textContent = label;
    if (opts.data) {
      Object.keys(opts.data).forEach(function (k) {
        b.setAttribute('data-' + k, opts.data[k]);
      });
    }
    if (opts.aria) b.setAttribute('aria-label', opts.aria);
    // Block focus stealing — keep the input focused so the caret stays put.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    b.addEventListener('click', opts.onClick || function () {});
    return b;
  }

  function buildLayout() {
    var root = state.el;
    // Wipe everything except the bar
    var bar = root.querySelector('.vk-bar');
    root.innerHTML = '';
    root.appendChild(bar);
    root.classList.toggle('vk-lang-ar', state.lang === 'ar');
    root.classList.toggle('vk-lang-en', state.lang === 'en');

    // Numbers row (always)
    var rowNums = document.createElement('div');
    rowNums.className = 'vk-row';
    NUMBERS.forEach(function (n) {
      rowNums.appendChild(makeKey(n, {
        cls: 'vk-num',
        onClick: function () { typeChar(n); }
      }));
    });
    root.appendChild(rowNums);

    // Letter rows
    var letters = LAYOUTS[state.lang];
    letters.forEach(function (rowChars, idx) {
      var row = document.createElement('div');
      row.className = 'vk-row';
      // Last letter row gets backspace appended on the right
      rowChars.forEach(function (ch) {
        row.appendChild(makeKey(ch, {
          onClick: function () { typeChar(ch); }
        }));
      });
      if (idx === letters.length - 1) {
        row.appendChild(makeKey('⌫', {
          cls: 'vk-danger vk-wide',
          aria: 'Backspace',
          onClick: backspace
        }));
      }
      root.appendChild(row);
    });

    // Bottom row — language toggle + space + clear + close
    var bottom = document.createElement('div');
    bottom.className = 'vk-row';
    bottom.appendChild(makeKey(state.lang === 'ar' ? 'EN' : 'ع',
      { cls: 'vk-lang', aria: 'Toggle language', onClick: toggleLang }));
    bottom.appendChild(makeKey(state.lang === 'ar' ? 'مسافة' : 'space',
      { cls: 'vk-space', onClick: function () { typeChar(' '); } }));
    bottom.appendChild(makeKey(state.lang === 'ar' ? 'مسح' : 'clear',
      { cls: 'vk-wide', onClick: clearAll }));
    bottom.appendChild(makeKey('✕',
      { cls: 'vk-action vk-wide', aria: 'Close keyboard', onClick: hide }));
    root.appendChild(bottom);
  }

  function ensureRoot() {
    if (state.el) return state.el;
    var root = document.createElement('div');
    root.id = 'vkKeyboard';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Virtual keyboard');
    var bar = document.createElement('div');
    bar.className = 'vk-bar';
    bar.innerHTML =
      '<div class="vk-bar-title"><i class="fas fa-keyboard"></i><span>لوحة المفاتيح</span></div>' +
      '<div class="vk-bar-actions">' +
        '<button type="button" class="vk-bar-btn" data-vk-act="hide" title="إخفاء">✕</button>' +
      '</div>';
    bar.querySelector('[data-vk-act="hide"]').addEventListener('mousedown', function (e) { e.preventDefault(); });
    bar.querySelector('[data-vk-act="hide"]').addEventListener('click', hide);
    root.appendChild(bar);
    document.body.appendChild(root);
    state.el = root;
    state.lang = chooseInitialLang();
    buildLayout();
    return root;
  }

  function typeChar(ch) {
    var inp = state.target;
    if (!inp) return;
    var start = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    var end   = inp.selectionEnd   != null ? inp.selectionEnd   : inp.value.length;
    var v = inp.value;
    inp.value = v.slice(0, start) + ch + v.slice(end);
    var caret = start + ch.length;
    try { inp.setSelectionRange(caret, caret); } catch (e) {}
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function backspace() {
    var inp = state.target;
    if (!inp) return;
    var start = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    var end   = inp.selectionEnd   != null ? inp.selectionEnd   : inp.value.length;
    var v = inp.value;
    if (start === end && start > 0) {
      inp.value = v.slice(0, start - 1) + v.slice(end);
      try { inp.setSelectionRange(start - 1, start - 1); } catch (e) {}
    } else if (start !== end) {
      inp.value = v.slice(0, start) + v.slice(end);
      try { inp.setSelectionRange(start, start); } catch (e) {}
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clearAll() {
    var inp = state.target;
    if (!inp) return;
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function toggleLang() {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('vk_lang', state.lang); } catch (e) {}
    buildLayout();
  }

  function show(input) {
    ensureRoot();
    state.target = input;
    state.el.classList.add('vk-open');
    document.body.classList.add('vk-active');
    // Make sure the input stays visible above the keyboard
    setTimeout(function () {
      try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    }, 280);
  }

  function hide() {
    if (!state.el) return;
    state.el.classList.remove('vk-open');
    document.body.classList.remove('vk-active');
    state.target = null;
  }

  // Bind to all inputs/textarea marked with data-vk="1". MutationObserver
  // catches any added later (modals, etc.).
  function bindInput(el) {
    if (!el || el._vkBound) return;
    el._vkBound = true;
    el.addEventListener('focus', function () { show(el); });
    // Don't hide on blur — that fires when the user taps a key (focus moves
    // to the button briefly). Use document mousedown instead.
  }

  function scanAndBind(root) {
    (root || document).querySelectorAll('input[data-vk="1"], textarea[data-vk="1"]').forEach(bindInput);
  }

  // Hide when user clicks anywhere outside the keyboard AND outside the
  // currently bound input.
  document.addEventListener('mousedown', function (e) {
    if (!state.el || !state.el.classList.contains('vk-open')) return;
    if (state.el.contains(e.target)) return;
    if (state.target && state.target.contains(e.target)) return;
    if (e.target === state.target) return;
    // If the click landed on another VK-bound input, show that one instead.
    if (e.target.matches && e.target.matches('input[data-vk="1"], textarea[data-vk="1"]')) {
      // The focus event will handle it.
      return;
    }
    hide();
  }, true);

  // Public API for power users / debug
  window.vkShow   = function (sel) { var el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (el) { bindInput(el); show(el); } };
  window.vkHide   = hide;
  window.vkLang   = function (lang) { if (lang === 'ar' || lang === 'en') { state.lang = lang; try { localStorage.setItem('vk_lang', lang); } catch (e) {} buildLayout(); } };
  window.vkRescan = scanAndBind;

  // Initial scan once DOM is ready (script is loaded with defer, so
  // DOMContentLoaded may have already fired).
  function init() {
    scanAndBind(document);
    // Watch for inputs added later (modals open after page load)
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              if (n.matches && n.matches('input[data-vk="1"], textarea[data-vk="1"]')) bindInput(n);
              scanAndBind(n);
            }
          });
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
