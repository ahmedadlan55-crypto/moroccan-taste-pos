/**
 * Dynamic on-the-fly translation engine — Moroccan Taste POS
 * ────────────────────────────────────────────────────────────
 * Auto-translates ALL visible page content (including DB-sourced text like
 * product names, customer names, transaction subjects, descriptions…) when
 * the user switches language to English. No need to maintain a manual
 * Arabic↔English dictionary for content that comes from the database.
 *
 *  HOW IT WORKS
 *    1. Walk the visible DOM and collect every text node + translatable
 *       attribute (placeholder/title/aria-label) that contains Arabic chars.
 *    2. Snapshot the originals onto the node itself (._origText) so we can
 *       restore on switch back to Arabic without re-fetching.
 *    3. Batch the unique source strings (deduplicated) into 1–2 calls to
 *       Google Translate's free public endpoint (no API key, generous quota).
 *    4. Apply translations back into the DOM in-place.
 *    5. Cache every translation in localStorage so the second visit is
 *       INSTANT and works offline once primed.
 *    6. MutationObserver auto-translates new DOM nodes added later (cart
 *       lines, modal popups, freshly loaded lists, …).
 *
 *  PUBLIC API
 *    DynamicI18N.translatePage(targetLang, opts?)   — Promise<void>
 *    DynamicI18N.translate(text, targetLang)        — Promise<string>
 *    DynamicI18N.restoreOriginal(root?)             — sync, restores Arabic
 *    DynamicI18N.startObserver(targetLang)          — auto-translate new DOM
 *    DynamicI18N.stopObserver()
 *    DynamicI18N.clearCache()                       — wipe all cached entries
 *
 *  OPT-OUT
 *    Add  data-no-translate  attribute or  .no-translate  class to any
 *    element to skip its subtree (codes, IDs, raw monospace data, etc.).
 * ──────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  // Has at least one Arabic character (covers Arabic + extended ranges)
  var ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  var CACHE_PREFIX = 'mt_dyn_i18n_v1:';
  var GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
  // Sentinel for batched requests — a sequence Google's translator preserves
  // verbatim across translation. Two pilcrows on their own line.
  var SENTINEL = '\n¶¶\n';
  var MAX_BATCH_CHARS = 4500;     // Google ~5K limit; leave headroom for URL encoding
  var TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, TEXTAREA: 1 };

  // Mutation observer state
  var _observer = null;
  var _queue = new Set();
  var _queueTimer = null;
  var _lastTargetLang = null;
  // Concurrency token — when user toggles language rapidly, only the LATEST
  // call's results get applied. Older ones short-circuit.
  var _runToken = 0;

  // ────────────────────────────────────────────────────────────
  // Cache (localStorage)
  // ────────────────────────────────────────────────────────────
  function _hash(s) {
    // djb2 — small, fast, collision-acceptable for our key space
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  }
  function _key(lang, src) { return CACHE_PREFIX + lang + ':' + _hash(src) + ':' + src.length; }
  function _getCached(lang, src) {
    try { return localStorage.getItem(_key(lang, src)); } catch (e) { return null; }
  }
  function _setCached(lang, src, dst) {
    try {
      localStorage.setItem(_key(lang, src), dst);
    } catch (e) {
      // localStorage full — evict oldest 200 cache entries and retry once
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
        }
        keys.slice(0, 200).forEach(function (k) { localStorage.removeItem(k); });
        localStorage.setItem(_key(lang, src), dst);
      } catch (e2) { /* give up — translation works without cache */ }
    }
  }

  // ────────────────────────────────────────────────────────────
  // DOM walking
  // ────────────────────────────────────────────────────────────
  function _shouldSkipElement(el) {
    if (!el) return true;
    if (SKIP_TAGS[el.tagName]) return true;
    // contentEditable=true → user input area, never touch
    if (el.isContentEditable) return true;
    // Walk up: any ancestor opted out?
    var p = el;
    while (p) {
      if (p.nodeType === 1 && (p.hasAttribute && p.hasAttribute('data-no-translate'))) return true;
      if (p.classList && p.classList.contains('no-translate')) return true;
      p = p.parentElement;
    }
    return false;
  }
  function _shouldTranslateText(textNode) {
    var v = textNode.nodeValue;
    if (!v) return false;
    var trimmed = v.trim();
    if (!trimmed) return false;
    // Has at least one Arabic char (otherwise — already non-Arabic, leave alone)
    if (!ARABIC_RE.test(trimmed)) return false;
    return !_shouldSkipElement(textNode.parentElement);
  }

  function _collectTextNodes(root) {
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return _shouldTranslateText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function _collectAttrItems(root) {
    var items = [];
    // Include the root itself if it's an Element
    var all = root.nodeType === 1
      ? [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')))
      : Array.prototype.slice.call(root.querySelectorAll('*'));
    all.forEach(function (el) {
      if (_shouldSkipElement(el)) return;
      TRANSLATABLE_ATTRS.forEach(function (attr) {
        var val = el.getAttribute && el.getAttribute(attr);
        if (val && ARABIC_RE.test(val)) items.push({ el: el, attr: attr, value: val });
      });
    });
    return items;
  }

  // ────────────────────────────────────────────────────────────
  // Translation API
  // ────────────────────────────────────────────────────────────
  // V5.7.13 — primary path is our own backend proxy at /api/i18n/translate.
  //   Direct browser → Google fails for many users (CORS, region blocks,
  //   carrier proxies). Server-to-server bypasses all of that.
  //   We fall back to direct Google in case the backend is down.
  function _backendTranslate(texts, sourceLang, targetLang) {
    var token = '';
    try {
      token = localStorage.getItem('pos_token') ||
              localStorage.getItem('emp_token') || '';
    } catch (e) {}
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('/api/i18n/translate', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ q: texts, source: sourceLang, target: targetLang })
    }).then(function (r) {
      if (!r.ok) throw new Error('proxy ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.translations)) throw new Error('bad shape');
      // Ensure length matches; pad with originals if not
      var out = data.translations.slice();
      while (out.length < texts.length) out.push(texts[out.length]);
      return out;
    });
  }

  function _googleTranslateDirect(texts, sourceLang, targetLang) {
    // Last-resort fallback: direct browser fetch to Google.
    var joined = texts.join(SENTINEL);
    var url = GOOGLE_URL +
      '?client=gtx' +
      '&sl=' + encodeURIComponent(sourceLang) +
      '&tl=' + encodeURIComponent(targetLang) +
      '&dt=t&q=' + encodeURIComponent(joined);
    return fetch(url, { method: 'GET', mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var out = '';
        if (Array.isArray(data) && Array.isArray(data[0])) {
          for (var i = 0; i < data[0].length; i++) {
            if (data[0][i] && data[0][i][0]) out += data[0][i][0];
          }
        }
        var parts = out.split(SENTINEL);
        // Pad/truncate so caller always gets array of correct length
        while (parts.length < texts.length) parts.push(texts[parts.length]);
        if (parts.length > texts.length) parts.length = texts.length;
        return parts;
      });
  }

  function _googleTranslate(texts, sourceLang, targetLang) {
    // Primary: backend proxy. Fallback: direct Google.
    return _backendTranslate(texts, sourceLang, targetLang).catch(function (e) {
      try { console.warn('[i18n] backend proxy failed, trying direct Google:', e.message); } catch (_) {}
      return _googleTranslateDirect(texts, sourceLang, targetLang).catch(function (e2) {
        try { console.warn('[i18n] direct Google also failed:', e2.message); } catch (_) {}
        // Both failed — return originals so the page doesn't break
        return texts.slice();
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────
  var DynamicI18N = {

    // Translate a single string (used internally + exposed for callers)
    translate: function (text, targetLang, sourceLang) {
      sourceLang = sourceLang || 'ar';
      if (!text || !ARABIC_RE.test(text)) return Promise.resolve(text);
      var cached = _getCached(targetLang, text);
      if (cached != null) return Promise.resolve(cached);
      return _googleTranslate([text], sourceLang, targetLang).then(function (arr) {
        var t = arr[0] || text;
        _setCached(targetLang, text, t);
        return t;
      }).catch(function () { return text; });
    },

    // Translate the entire visible page (or a subtree if root is given)
    translatePage: function (targetLang, opts) {
      opts = opts || {};
      var root = opts.root || document.body;
      var sourceLang = opts.sourceLang || 'ar';
      _lastTargetLang = targetLang;
      var token = ++_runToken;

      // 1. Collect everything translatable, snapshotting originals
      var textNodes = _collectTextNodes(root);
      var attrItems = _collectAttrItems(root);

      // 2. Build dedupe map: source text → list of {type, target}
      var sourceMap = Object.create(null);
      var sourceOrder = [];
      function _addSrc(src, item) {
        if (!sourceMap[src]) { sourceMap[src] = []; sourceOrder.push(src); }
        sourceMap[src].push(item);
      }
      textNodes.forEach(function (n) {
        if (n._origText == null) n._origText = n.nodeValue;
        _addSrc(n._origText, { type: 'text', node: n });
      });
      attrItems.forEach(function (it) {
        var bucket = '_origAttr_' + it.attr;
        if (it.el.dataset[bucket] == null) it.el.dataset[bucket] = it.value;
        _addSrc(it.el.dataset[bucket], { type: 'attr', el: it.el, attr: it.attr });
      });

      if (!sourceOrder.length) return Promise.resolve();

      // 3. Resolve from cache; collect uncached
      var resolved = Object.create(null);
      var uncached = [];
      sourceOrder.forEach(function (src) {
        var c = _getCached(targetLang, src);
        if (c != null) resolved[src] = c;
        else uncached.push(src);
      });

      // 4. Apply cached translations IMMEDIATELY (before API calls land)
      function _apply(srcArr) {
        if (token !== _runToken) return;  // user switched away — abort
        srcArr.forEach(function (src) {
          var dst = resolved[src];
          if (dst == null) return;
          var bucket = sourceMap[src] || [];
          bucket.forEach(function (item) {
            try {
              if (item.type === 'text') {
                if (item.node.parentElement) item.node.nodeValue = dst;
              } else if (item.type === 'attr') {
                item.el.setAttribute(item.attr, dst);
              }
            } catch (e) { /* node may have been removed; ignore */ }
          });
        });
      }
      _apply(sourceOrder.filter(function (s) { return resolved[s] != null; }));

      // 5. Batch the uncached strings and send to Google
      function _runBatches(remaining) {
        if (!remaining.length) return Promise.resolve();
        if (token !== _runToken) return Promise.resolve();
        var batch = [];
        var len = 0;
        while (remaining.length && (len + remaining[0].length + SENTINEL.length) < MAX_BATCH_CHARS) {
          var s = remaining.shift();
          batch.push(s);
          len += s.length + SENTINEL.length;
        }
        // If a single string is bigger than the budget, send it alone
        if (!batch.length && remaining.length) batch.push(remaining.shift());

        return _googleTranslate(batch, sourceLang, targetLang).then(function (results) {
          batch.forEach(function (src, i) {
            var t = (results[i] != null && results[i] !== '') ? results[i] : src;
            resolved[src] = t;
            _setCached(targetLang, src, t);
          });
          _apply(batch);
          return _runBatches(remaining);
        }).catch(function () {
          // On API failure, leave originals; continue with rest
          return _runBatches(remaining);
        });
      }

      return _runBatches(uncached.slice());
    },

    restoreOriginal: function (root) {
      root = root || document.body;
      _runToken++;  // cancel any in-flight translatePage
      // 1. Restore text nodes
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        if (n._origText != null) {
          try { n.nodeValue = n._origText; } catch (e) {}
        }
      }
      // 2. Restore attributes
      var elements = root.nodeType === 1
        ? [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')))
        : Array.prototype.slice.call(root.querySelectorAll('*'));
      elements.forEach(function (el) {
        if (!el.dataset) return;
        TRANSLATABLE_ATTRS.forEach(function (attr) {
          var orig = el.dataset['_origAttr_' + attr];
          if (orig != null) el.setAttribute(attr, orig);
        });
      });
      _lastTargetLang = null;
    },

    // Watch for new DOM nodes and translate them (debounced ~250ms)
    startObserver: function (targetLang) {
      this.stopObserver();
      _lastTargetLang = targetLang;
      var self = this;
      _observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) _queue.add(node);
            else if (node.nodeType === 3 && _shouldTranslateText(node)) {
              if (node.parentElement) _queue.add(node.parentElement);
            }
          });
          // Also re-translate when textContent changes inside an existing element
          // (e.g. innerHTML rewrite, common with cart/menu rerenders).
          if (m.type === 'characterData' && m.target && _shouldTranslateText(m.target)) {
            if (m.target.parentElement) _queue.add(m.target.parentElement);
          }
        });
        if (_queueTimer) clearTimeout(_queueTimer);
        _queueTimer = setTimeout(function () {
          if (!_lastTargetLang) return;
          var roots = Array.from(_queue);
          _queue.clear();
          // Translate each new root in parallel — translatePage handles its own batching
          roots.forEach(function (r) {
            // Still attached to the document?
            if (r && r.isConnected !== false && document.body.contains(r)) {
              self.translatePage(_lastTargetLang, { root: r });
            }
          });
        }, 250);
      });
      _observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    },

    stopObserver: function () {
      if (_observer) { _observer.disconnect(); _observer = null; }
      if (_queueTimer) { clearTimeout(_queueTimer); _queueTimer = null; }
      _queue.clear();
    },

    clearCache: function () {
      try {
        var rm = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) rm.push(k);
        }
        rm.forEach(function (k) { localStorage.removeItem(k); });
        return rm.length;
      } catch (e) { return 0; }
    }
  };

  global.DynamicI18N = DynamicI18N;

})(window);
