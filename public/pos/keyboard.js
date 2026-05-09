/* ─────────────────────────────────────────────────────────────────
 * v5.12.3 — iPad-style virtual keyboard
 *
 *   • Standard QWERTY (English) and AR-101 (Arabic) layouts
 *   • Numbers + symbols panel, Shift toggle, Lang toggle, Return
 *   • touchstart drives keypress (no 300 ms tap delay)
 *   • Long-press Backspace (350 ms hold → 60 ms repeat)
 *   • White surface, iPad-style press highlights
 *   • Hides on outside touch, persists on key tap (preventDefault)
 *
 * Auto-attaches to any [data-vk="1"] input or textarea, immediately
 * for elements present at load time and via MutationObserver for
 * elements added later (modals etc.).
 * ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ─── Layouts ───────────────────────────────────────────────────────
  // Last entry of each row is the action key marker; alphabetic keys
  // are plain strings.
  var LAYOUT_EN = [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['SHIFT','z','x','c','v','b','n','m','BACK'],
    ['MODE','LANG','SPACE','RETURN']
  ];

  // Standard Arabic (Mac/iOS) layout
  var LAYOUT_AR = [
    ['ض','ص','ث','ق','ف','غ','ع','ه','خ','ح','ج'],
    ['ش','س','ي','ب','ل','ا','ت','ن','م','ك','ط'],
    ['ذ','ء','ؤ','ر','لا','ى','ة','و','ز','ظ','BACK'],
    ['MODE','LANG','SPACE','RETURN']
  ];

  // Numbers / symbols (single panel — toggled by 123 / ABC)
  var LAYOUT_NUM = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['-','/',':',';','(',')','$','&','@','"'],
    ['SYM','.',',','?','!',"'",'BACK'],
    ['MODE','LANG','SPACE','RETURN']
  ];

  // v5.12.8 — Phone layouts. Compact rows with the numbers row always
  // on top (mobile-style). Used when the user picks the 📱 style. Same
  // action keys (SHIFT/BACK/MODE/LANG/SPACE/RETURN) so the dispatcher
  // is unchanged.
  var LAYOUT_EN_PHONE = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['SHIFT','z','x','c','v','b','n','m','BACK'],
    ['MODE','LANG','SPACE','RETURN']
  ];
  var LAYOUT_AR_PHONE = [
    ['١','٢','٣','٤','٥','٦','٧','٨','٩','٠'],
    ['ض','ص','ث','ق','ف','غ','ع','ه','خ','ح','ج'],
    ['ش','س','ي','ب','ل','ا','ت','ن','م','ك','ط'],
    ['ذ','ء','ؤ','ر','لا','ى','ة','و','ز','ظ','BACK'],
    ['MODE','LANG','SPACE','RETURN']
  ];

  // ─── State ─────────────────────────────────────────────────────────
  var state = {
    el:        null,
    target:    null,
    lang:      'en',     // 'en' | 'ar'
    mode:      'letters',// 'letters' | 'numbers'
    style:     'tablet', // 'tablet' (iPad) | 'phone' (compact)
    shift:     false,
    capsLock:  false,
    backHold:  null      // long-press timer
  };

  // ─── Persistence ───────────────────────────────────────────────────
  function loadLang() {
    try {
      var s = localStorage.getItem('vk_lang');
      if (s === 'ar' || s === 'en') return s;
    } catch (e) {}
    return (document.documentElement.lang || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  }
  function saveLang(v) { try { localStorage.setItem('vk_lang', v); } catch (e) {} }
  function loadStyle() {
    try {
      var s = localStorage.getItem('vk_style');
      if (s === 'phone' || s === 'tablet') return s;
    } catch (e) {}
    // Default by viewport: phone if narrow
    return (window.innerWidth && window.innerWidth < 600) ? 'phone' : 'tablet';
  }
  function saveStyle(v) { try { localStorage.setItem('vk_style', v); } catch (e) {} }

  // ─── Build keys ────────────────────────────────────────────────────
  function makeKey(label, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vk-key' + (opts.cls ? ' ' + opts.cls : '');
    b.textContent = label;
    b.tabIndex = -1;

    // v5.12.6 — "touch wins" dedup. Browsers fire BOTH touchstart and a
    // synthetic mousedown for the same finger gesture; the previous
    // handled-flag trick blocked legit fast taps. Now: every touchstart
    // stamps a timestamp on the element; a mousedown that lands within
    // 600 ms is treated as a ghost and skipped. Real mouse clicks (no
    // prior touchstart) still fire. Result: unlimited-rate fast typing.
    var TOUCH_LOCK_MS = 600;
    var fire = function () {
      b.classList.add('vk-pressed');
      if (opts.onPress) opts.onPress(b);
    };
    var release = function () {
      requestAnimationFrame(function () { b.classList.remove('vk-pressed'); });
      if (opts.onRelease) opts.onRelease(b);
    };
    b.addEventListener('touchstart', function (e) {
      e.preventDefault();
      b.dataset.vkTouch = String(Date.now());
      fire();
    }, { passive: false });
    b.addEventListener('touchend',    release);
    b.addEventListener('touchcancel', release);
    b.addEventListener('mousedown', function (e) {
      e.preventDefault(); // keep the input focused
      var t = Number(b.dataset.vkTouch || 0);
      if (t && (Date.now() - t) < TOUCH_LOCK_MS) return; // ghost click — skip
      fire();
    });
    b.addEventListener('mouseup',    release);
    b.addEventListener('mouseleave', release);

    return b;
  }

  // ─── Layout rendering ──────────────────────────────────────────────
  function ensureRoot() {
    if (state.el) return state.el;

    var root = document.createElement('div');
    root.id = 'vkKeyboard';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Virtual keyboard');

    var bar = document.createElement('div');
    bar.className = 'vk-bar';
    bar.innerHTML =
      '<div class="vk-bar-title"><i class="fas fa-keyboard"></i> <span class="vk-bar-text">لوحة المفاتيح</span></div>' +
      '<div style="display:flex;gap:6px;">' +
        '<button type="button" class="vk-bar-btn" data-vk-act="style" title="تَبديل الطراز">📱</button>' +
        '<button type="button" class="vk-bar-btn" data-vk-act="hide" title="إخفاء"><i class="fas fa-chevron-down"></i></button>' +
      '</div>';
    var hideBtn = bar.querySelector('[data-vk-act="hide"]');
    hideBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    hideBtn.addEventListener('click', hide);
    var styleBtn = bar.querySelector('[data-vk-act="style"]');
    styleBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    styleBtn.addEventListener('click', toggleStyle);
    root.appendChild(bar);

    document.body.appendChild(root);
    state.el = root;
    state.lang = loadLang();
    state.style = loadStyle();
    redraw();
    return root;
  }

  function redraw() {
    var root = state.el;
    if (!root) return;
    // Remove all rows except the bar
    Array.prototype.slice.call(root.querySelectorAll('.vk-row')).forEach(function (n) { n.remove(); });
    root.classList.toggle('vk-lang-ar', state.lang === 'ar');
    root.classList.toggle('vk-lang-en', state.lang === 'en');
    root.classList.toggle('vk-mode-num', state.mode === 'numbers');
    root.classList.toggle('vk-style-phone',  state.style === 'phone');
    root.classList.toggle('vk-style-tablet', state.style === 'tablet');

    // Update the style toggle icon to indicate the OPPOSITE style (what
    // the user will switch to on next click)
    var styleBtn = root.querySelector('[data-vk-act="style"]');
    if (styleBtn) styleBtn.textContent = state.style === 'phone' ? '🖥' : '📱';

    var isPhone = state.style === 'phone';
    var layout =
      state.mode === 'numbers' ? LAYOUT_NUM :
      state.lang === 'ar'      ? (isPhone ? LAYOUT_AR_PHONE : LAYOUT_AR) :
                                 (isPhone ? LAYOUT_EN_PHONE : LAYOUT_EN);

    layout.forEach(function (rowDef) {
      var row = document.createElement('div');
      row.className = 'vk-row';
      rowDef.forEach(function (entry) {
        row.appendChild(buildKey(entry));
      });
      root.appendChild(row);
    });
  }

  function buildKey(entry) {
    if (entry === 'SHIFT') {
      var shiftKey = makeKey('⇧', {
        cls: 'vk-shift' + (state.shift || state.capsLock ? ' vk-on' : ''),
        onPress: toggleShift
      });
      return shiftKey;
    }
    if (entry === 'BACK') {
      var backKey = makeKey('⌫', {
        cls: 'vk-back',
        onPress: function (btn) {
          backspaceOnce();
          // Long-press repeat — 350 ms hold then 60 ms interval
          state.backHold = setTimeout(function () {
            state.backHold = setInterval(backspaceOnce, 60);
          }, 350);
        },
        onRelease: function () {
          if (state.backHold) {
            clearTimeout(state.backHold);
            clearInterval(state.backHold);
            state.backHold = null;
          }
        }
      });
      return backKey;
    }
    if (entry === 'MODE') {
      var label = state.mode === 'numbers'
        ? (state.lang === 'ar' ? 'حروف' : 'ABC')
        : '123';
      return makeKey(label, { cls: 'vk-mode', onPress: toggleMode });
    }
    if (entry === 'LANG') {
      // Show the OPPOSITE language so the user knows what they'll switch to
      var langLabel = state.lang === 'ar' ? 'EN' : 'ع';
      return makeKey(langLabel, { cls: 'vk-lang', onPress: toggleLang });
    }
    if (entry === 'SPACE') {
      return makeKey(state.lang === 'ar' ? 'مسافة' : 'space', {
        cls: 'vk-space',
        onPress: function () { typeChar(' '); }
      });
    }
    if (entry === 'RETURN') {
      return makeKey(state.lang === 'ar' ? 'إدخال' : 'return', {
        cls: 'vk-return',
        onPress: function () { sendReturn(); }
      });
    }
    if (entry === 'SYM') {
      return makeKey('#+=', { cls: 'vk-mode', onPress: function () { /* future second symbols panel */ } });
    }
    // Plain character key
    var ch = entry;
    var displayed = (state.shift || state.capsLock) && state.lang === 'en'
      ? ch.toUpperCase()
      : ch;
    return makeKey(displayed, {
      onPress: function () {
        var out = (state.shift || state.capsLock) && state.lang === 'en'
          ? ch.toUpperCase()
          : ch;
        typeChar(out);
        if (state.shift && !state.capsLock) {
          state.shift = false;
          redraw();
        }
      }
    });
  }

  // ─── Input helpers ─────────────────────────────────────────────────
  function getInput() { return state.target; }

  function typeChar(ch) {
    var inp = getInput();
    if (!inp) return;
    var s = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    var e = inp.selectionEnd   != null ? inp.selectionEnd   : inp.value.length;
    inp.value = inp.value.slice(0, s) + ch + inp.value.slice(e);
    var caret = s + ch.length;
    try { inp.setSelectionRange(caret, caret); } catch (err) {}
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function backspaceOnce() {
    var inp = getInput();
    if (!inp) return;
    var s = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    var e = inp.selectionEnd   != null ? inp.selectionEnd   : inp.value.length;
    if (s === e) {
      if (s === 0) return;
      inp.value = inp.value.slice(0, s - 1) + inp.value.slice(e);
      try { inp.setSelectionRange(s - 1, s - 1); } catch (err) {}
    } else {
      inp.value = inp.value.slice(0, s) + inp.value.slice(e);
      try { inp.setSelectionRange(s, s); } catch (err) {}
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function sendReturn() {
    var inp = getInput();
    if (!inp) return;
    // Fire a synthetic Enter keydown so existing handlers (e.g. form submit, search) run
    try {
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (e) {}
    // Hide after Return on single-line inputs
    if (inp.tagName === 'INPUT') hide();
  }

  // ─── Toggles ───────────────────────────────────────────────────────
  function toggleShift() {
    // Quick double-tap → caps lock
    var now = Date.now();
    if (state._lastShift && (now - state._lastShift) < 350) {
      state.capsLock = !state.capsLock;
      state.shift = state.capsLock;
    } else {
      state.shift = !state.shift;
      state.capsLock = false;
    }
    state._lastShift = now;
    redraw();
  }

  function toggleLang() {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    state.mode = 'letters';
    state.shift = false;
    state.capsLock = false;
    saveLang(state.lang);
    redraw();
  }

  function toggleMode() {
    state.mode = state.mode === 'numbers' ? 'letters' : 'numbers';
    state.shift = false;
    redraw();
  }

  function toggleStyle() {
    state.style = state.style === 'phone' ? 'tablet' : 'phone';
    saveStyle(state.style);
    redraw();
  }

  // ─── Show / hide ───────────────────────────────────────────────────
  function show(input) {
    ensureRoot();
    state.target = input;
    state.el.classList.add('vk-open');
    document.body.classList.add('vk-active');
    setTimeout(function () {
      try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    }, 200);
  }

  function hide() {
    if (!state.el) return;
    state.el.classList.remove('vk-open');
    document.body.classList.remove('vk-active');
    // v5.12.8 — blur the bound input so a subsequent tap on the SAME
    // input fires a fresh focus event. Without this, the next click
    // hits an already-focused input and `focus` never re-fires, so the
    // keyboard never reopens.
    if (state.target) { try { state.target.blur(); } catch (e) {} }
    state.target = null;
    if (state.backHold) {
      clearTimeout(state.backHold);
      clearInterval(state.backHold);
      state.backHold = null;
    }
  }

  // ─── Input binding ────────────────────────────────────────────────
  function bindInput(el) {
    if (!el || el._vkBound) return;
    el._vkBound = true;
    // v5.12.8 — open on BOTH focus AND click. Click captures the case
    // where the input still has focus from a prior session (after the
    // user dismissed the keyboard with ✕): focus event won't refire,
    // but click always does. pointerdown covers stylus/pen input.
    var open = function () { show(el); };
    el.addEventListener('focus', open);
    el.addEventListener('click', open);
    el.addEventListener('pointerdown', open);
  }

  function scanAndBind(root) {
    (root || document).querySelectorAll('input[data-vk="1"], textarea[data-vk="1"]').forEach(bindInput);
  }

  // Hide when clicking / tapping outside both the keyboard and the
  // currently bound input. Captured early so blur-via-keypress doesn't
  // race the close.
  document.addEventListener('mousedown', function (e) {
    if (!state.el || !state.el.classList.contains('vk-open')) return;
    if (state.el.contains(e.target)) return;
    if (state.target && state.target.contains(e.target)) return;
    if (e.target === state.target) return;
    if (e.target.matches && e.target.matches('input[data-vk="1"], textarea[data-vk="1"]')) return;
    hide();
  }, true);
  document.addEventListener('touchstart', function (e) {
    if (!state.el || !state.el.classList.contains('vk-open')) return;
    if (state.el.contains(e.target)) return;
    if (state.target && state.target.contains(e.target)) return;
    if (e.target === state.target) return;
    if (e.target.matches && e.target.matches('input[data-vk="1"], textarea[data-vk="1"]')) return;
    hide();
  }, { capture: true, passive: true });

  // ─── Public debug API ─────────────────────────────────────────────
  window.vkShow   = function (sel) { var el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (el) { bindInput(el); show(el); } };
  window.vkHide   = hide;
  window.vkLang   = function (lang) { if (lang === 'ar' || lang === 'en') { state.lang = lang; saveLang(lang); redraw(); } };
  window.vkRescan = scanAndBind;

  // ─── Init ─────────────────────────────────────────────────────────
  function init() {
    scanAndBind(document);
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              if (n.matches && n.matches('input[data-vk="1"], textarea[data-vk="1"]')) bindInput(n);
              scanAndBind(n);
            }
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
