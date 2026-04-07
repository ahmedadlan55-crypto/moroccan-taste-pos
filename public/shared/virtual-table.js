/**
 * VirtualTable — minimal row-virtualisation helper for large tables.
 *
 * Keeps only ~30 rows in the DOM regardless of how many rows are in the
 * data array. Used by inventory/purchases/sales pages where thousands of
 * rows would otherwise freeze mobile devices.
 *
 * Usage:
 *   var vt = new VirtualTable(document.getElementById('tbBody'), {
 *     rowHeight: 56,                     // px — estimate
 *     overscan: 5,                       // extra rows to render above/below viewport
 *     renderRow: function(row, idx) { return '<tr>...</tr>'; },
 *     empty: '<tr><td colspan="8" class="empty-msg">لا توجد بيانات</td></tr>'
 *   });
 *   vt.setRows(dataArray);               // render initial data
 *   vt.setRows(dataArray.filter(fn));    // re-render after filter
 *   vt.destroy();                        // clean up
 *
 * Notes:
 * - The target element MUST be a <tbody> (the helper wraps it with spacer rows).
 * - rowHeight is an average/estimate; rows with different heights still work but
 *   scroll position accuracy depends on the estimate being close.
 * - The scrollable container is the closest ancestor with overflow-y:auto,
 *   falling back to the window if none is found.
 */
(function() {
  function VirtualTable(tbody, opts) {
    if (!tbody) throw new Error('VirtualTable: tbody element is required');
    opts = opts || {};
    this.tbody     = tbody;
    this.rowHeight = opts.rowHeight || 48;
    this.overscan  = opts.overscan || 5;
    this.renderRow = opts.renderRow;
    this.emptyHtml = opts.empty || '<tr><td colspan="20" style="text-align:center;padding:20px;color:#94a3b8;">لا توجد بيانات</td></tr>';
    this.rows      = [];
    this.startIdx  = 0;
    this.endIdx    = 0;
    this._rafId    = 0;
    this._scroller = this._findScroller(tbody);
    this._onScroll = this._onScrollRaw.bind(this);
    this._onResize = this._onScrollRaw.bind(this);
    this._scroller.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
  }

  VirtualTable.prototype._findScroller = function(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return node;
      node = node.parentElement;
    }
    return window;
  };

  VirtualTable.prototype._getScrollInfo = function() {
    if (this._scroller === window) {
      return {
        scrollTop: window.pageYOffset || document.documentElement.scrollTop,
        viewportH: window.innerHeight,
        top: this.tbody.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop)
      };
    }
    var rect = this.tbody.getBoundingClientRect();
    var scRect = this._scroller.getBoundingClientRect();
    return {
      scrollTop: this._scroller.scrollTop,
      viewportH: this._scroller.clientHeight,
      // offset of tbody inside the scroller's scrollable content
      top: rect.top - scRect.top + this._scroller.scrollTop
    };
  };

  VirtualTable.prototype._onScrollRaw = function() {
    if (this._rafId) return;
    var self = this;
    this._rafId = requestAnimationFrame(function() {
      self._rafId = 0;
      self._renderWindow();
    });
  };

  VirtualTable.prototype.setRows = function(rows) {
    this.rows = Array.isArray(rows) ? rows : [];
    this._renderWindow(true);
  };

  VirtualTable.prototype._renderWindow = function(force) {
    var tbody = this.tbody;
    var total = this.rows.length;

    if (total === 0) {
      tbody.innerHTML = this.emptyHtml;
      return;
    }

    var info = this._getScrollInfo();
    // Local scroll position inside the tbody (0 when tbody top is in view)
    var localTop = Math.max(0, info.scrollTop - info.top);
    var viewportH = info.viewportH;

    var visibleCount = Math.ceil(viewportH / this.rowHeight) + this.overscan * 2;
    var startIdx = Math.max(0, Math.floor(localTop / this.rowHeight) - this.overscan);
    var endIdx = Math.min(total, startIdx + visibleCount);

    if (!force && startIdx === this.startIdx && endIdx === this.endIdx) return;
    this.startIdx = startIdx;
    this.endIdx = endIdx;

    var topPad    = startIdx * this.rowHeight;
    var bottomPad = (total - endIdx) * this.rowHeight;

    var html = '';
    if (topPad > 0) {
      html += '<tr class="vt-spacer" aria-hidden="true" style="height:' + topPad + 'px;"><td colspan="100"></td></tr>';
    }
    for (var i = startIdx; i < endIdx; i++) {
      html += this.renderRow(this.rows[i], i);
    }
    if (bottomPad > 0) {
      html += '<tr class="vt-spacer" aria-hidden="true" style="height:' + bottomPad + 'px;"><td colspan="100"></td></tr>';
    }
    tbody.innerHTML = html;
  };

  VirtualTable.prototype.refresh = function() { this._renderWindow(true); };

  VirtualTable.prototype.destroy = function() {
    this._scroller.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.tbody.innerHTML = '';
  };

  window.VirtualTable = VirtualTable;
})();
