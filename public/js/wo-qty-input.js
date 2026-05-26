/**
 * WoQtyInput — V5.7.26
 * ────────────────────────────────────────────────────────────────────
 * Reusable multi-unit quantity widget. Used everywhere the user enters
 * a stock quantity:
 *    • Recipe editor (BOM ingredient line)
 *    • Stocktake (physical count)
 *    • Stock transfer (issue qty)
 *    • Purchase order line
 *    • Inventory adjustment
 *
 * Why a shared widget:
 *    • Major + minor + auto-sync via convRate (e.g. 0.5 box ↔ 12 pieces)
 *    • Surgical updates (no full re-render on each keystroke; the input
 *      the user is typing in NEVER loses focus)
 *    • Stock display in BOTH units ("5.50 box / 132 pcs")
 *    • Color-coded vs requested qty (red if shortage)
 *    • Compact OR card mode
 *
 * USAGE:
 *    var ctrl = WoQtyInput.mount(host, {
 *      unit:        'GR',           // minor unit (string)
 *      bigUnit:     'KG',           // major unit (optional)
 *      convRate:    1000,           // minor units per major (default 1)
 *      stock:       1762,           // current stock in MINOR units (optional)
 *      cost:        0.06,           // per-minor-unit cost (optional)
 *      initialMinorQty: 12,         // starting value in MINOR units
 *      onChange:    fn(minorQty)    // called after every change (debounced 0)
 *      compact:     false           // true → small one-line layout
 *    });
 *
 *    ctrl.getMinorQty()             // → 12
 *    ctrl.setMinorQty(36)           // sets value, syncs both inputs, fires onChange
 *    ctrl.refreshStock(2000)        // updates the stock badge
 *    ctrl.destroy()                 // unmounts
 * ──────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _fmt(v, dp) {
    if (v == null || isNaN(v)) return '0';
    var n = Number(v);
    if (Math.abs(n) < 0.0001) return '0';
    return dp != null ? n.toFixed(dp) : (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));
  }
  function _trim(n) {
    if (n == null || isNaN(n)) return '';
    return Number.isInteger(n) ? String(n) : Number(n.toFixed(4));
  }

  var _instanceCounter = 0;

  function mount(host, opts) {
    if (!host) throw new Error('WoQtyInput.mount: host element required');
    opts = opts || {};
    var id           = ++_instanceCounter;
    var unit         = String(opts.unit     || 'PCS');
    var bigUnit      = String(opts.bigUnit  || '');
    var convRate     = Number(opts.convRate) || 1;
    var stock        = opts.stock != null ? Number(opts.stock) : null;
    var cost         = opts.cost != null  ? Number(opts.cost)  : null;
    var minorQty     = Number(opts.initialMinorQty) || 0;
    var onChange     = typeof opts.onChange === 'function' ? opts.onChange : function(){};
    var compact      = !!opts.compact;
    var hasMajor     = bigUnit && convRate > 1;

    // Render once
    var prefix = 'wqty-' + id;
    var stockHtml = stock == null ? '' : (function() {
      var stockMajor = (hasMajor && convRate > 0) ? (stock / convRate) : null;
      var stockColor = stock < minorQty ? '#dc2626' : (stock === 0 ? '#94a3b8' : '#16a34a');
      return '<div class="wqty-stock" id="' + prefix + '-stock" style="font-size:10.5px;color:' + stockColor + ';font-weight:600;margin-top:3px;">' +
               'المخزون: ' +
               (stockMajor != null
                 ? stockMajor.toFixed(2) + ' ' + _esc(bigUnit) + ' <span style="color:#94a3b8;">(' + stock + ' ' + _esc(unit) + ')</span>'
                 : stock + ' ' + _esc(unit)
               ) +
             '</div>';
    })();

    var majorVal = '';
    var minorVal = minorQty ? _trim(minorQty) : '';
    if (hasMajor && minorQty > 0) {
      var maj = Math.floor(minorQty / convRate);
      var min = minorQty - (maj * convRate);
      majorVal = maj ? _trim(maj) : '';
      minorVal = min ? _trim(min) : '';
    }

    // Layout: compact = single row of inputs; default = grid + labels below
    var inputStyle = 'width:' + (compact ? '90px' : '100px') +
                     ';padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;' +
                     'text-align:center;font-weight:700;font-family:monospace;font-size:14px;';
    var labelStyle = 'font-size:10.5px;color:#64748b;margin-top:3px;font-weight:600;text-align:center;';

    var inner = '<div class="wqty-root" id="' + prefix + '" style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">';
    if (hasMajor) {
      inner += '<div class="wqty-cell">' +
                 '<input type="number" step="any" min="0" class="wqty-major" id="' + prefix + '-major"' +
                   ' value="' + (majorVal === '' ? '' : majorVal) + '" placeholder="0" style="' + inputStyle + '">' +
                 '<div style="' + labelStyle + '">' + _esc(bigUnit) + '</div>' +
               '</div>';
      inner += '<div style="display:flex;align-items:center;padding-top:10px;color:#cbd5e1;font-weight:900;font-size:18px;">+</div>';
    }
    inner += '<div class="wqty-cell">' +
               '<input type="number" step="any" min="0" class="wqty-minor" id="' + prefix + '-minor"' +
                 ' value="' + (minorVal === '' ? '' : minorVal) + '" placeholder="0" style="' + inputStyle + '">' +
               '<div style="' + labelStyle + '">' + _esc(unit) + '</div>' +
             '</div>';
    inner += '</div>';
    if (stockHtml && !compact) inner += stockHtml;

    host.innerHTML = inner;

    var majorEl = host.querySelector('.wqty-major');
    var minorEl = host.querySelector('.wqty-minor');
    var stockEl = host.querySelector('.wqty-stock');

    function _refreshStockBadge() {
      if (!stockEl || stock == null) return;
      var stockMajor = (hasMajor && convRate > 0) ? (stock / convRate) : null;
      var stockColor = stock < minorQty ? '#dc2626' : (stock === 0 ? '#94a3b8' : '#16a34a');
      stockEl.style.color = stockColor;
      stockEl.innerHTML = 'المخزون: ' +
        (stockMajor != null
          ? stockMajor.toFixed(2) + ' ' + _esc(bigUnit) + ' <span style="color:#94a3b8;">(' + stock + ' ' + _esc(unit) + ')</span>'
          : stock + ' ' + _esc(unit)
        );
    }

    function _setMinor(v) {
      var n = Number(v);
      if (isNaN(n) || n < 0) n = 0;
      minorQty = n;

      if (hasMajor) {
        var maj = Math.floor(n / convRate);
        var min = n - (maj * convRate);
        if (majorEl && document.activeElement !== majorEl) majorEl.value = maj ? _trim(maj) : '';
        if (minorEl && document.activeElement !== minorEl) minorEl.value = min ? _trim(min) : '';
      } else {
        if (minorEl && document.activeElement !== minorEl) minorEl.value = n ? _trim(n) : '';
      }
      _refreshStockBadge();
    }

    function _calcAdditive() {
      var maj = majorEl ? Number(majorEl.value) || 0 : 0;
      var min = minorEl ? Number(minorEl.value) || 0 : 0;
      var total = (maj * convRate) + min;
      if (total < 0) total = 0;
      minorQty = total;
      _refreshStockBadge();
      try { onChange(minorQty); } catch (e) { console.warn('[WoQtyInput] onChange:', e); }
    }

    if (majorEl) {
      majorEl.addEventListener('input', _calcAdditive);
    }
    if (minorEl) {
      minorEl.addEventListener('input', _calcAdditive);
    }

    return {
      getMinorQty: function() { return minorQty; },
      setMinorQty: function(v) { _setMinor(v); try { onChange(minorQty); } catch (e) {} },
      refreshStock: function(newStock) {
        stock = Number(newStock) || 0;
        _refreshStockBadge();
      },
      destroy: function() {
        try { host.innerHTML = ''; } catch (e) {}
      }
    };
  }

  global.WoQtyInput = { mount: mount };
})(window);
