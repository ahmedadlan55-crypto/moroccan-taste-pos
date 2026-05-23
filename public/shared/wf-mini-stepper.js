/**
 * Workflow Mini-Stepper — v6.4
 * ─────────────────────────────────────────────────────────────
 * Inline visual progress component for transaction list rows.
 * Renders 3–7 colored dots showing the workflow state at a glance.
 *
 *   ●●○○○○○   "2 من 7 خطوات"
 *   ✓✓◉○○○○   (done, done, current pulse, pending...)
 *
 * Used in: admin outbox / inbox / dashboard tables + employee outbox.
 *
 * Usage:
 *   const html = WfMiniStepper.render({
 *     steps: 7,                 // total step count
 *     current: 3,               // current step (1-indexed)
 *     status: 'in_progress',    // optional — colors the current dot
 *   });
 *   tdEl.innerHTML = html;
 *
 * Or from a transaction object (auto-extracts step counts):
 *   WfMiniStepper.fromTxn(txn)
 */
(function(global){
  'use strict';
  if (global.WfMiniStepper) return;

  // Inject CSS once on first use.
  var _cssInjected = false;
  function _injectCss(){
    if (_cssInjected) return;
    _cssInjected = true;
    var s = document.createElement('style');
    s.id = 'wf-mini-stepper-css';
    s.textContent = [
      '.wfms{display:inline-flex;align-items:center;gap:3px;direction:ltr;vertical-align:middle;}',
      '.wfms-dot{width:8px;height:8px;border-radius:50%;background:#e2e8f0;border:1px solid #cbd5e1;flex-shrink:0;transition:transform .15s;}',
      '.wfms-dot.done{background:#16a34a;border-color:#15803d;}',
      '.wfms-dot.current{background:#3b82f6;border-color:#1d4ed8;width:10px;height:10px;box-shadow:0 0 0 3px rgba(59,130,246,.18);animation:wfms-pulse 2s infinite;}',
      '.wfms-dot.rejected{background:#dc2626;border-color:#991b1b;}',
      '.wfms-dot.returned{background:#f59e0b;border-color:#b45309;}',
      '.wfms-dot.approved{background:#16a34a;border-color:#15803d;}',
      '.wfms-line{width:6px;height:2px;background:#e2e8f0;flex-shrink:0;}',
      '.wfms-line.done{background:#16a34a;}',
      '.wfms-label{font-size:10px;font-weight:700;color:#64748b;margin-inline-start:8px;font-variant-numeric:tabular-nums;}',
      '.wfms-label .num{color:#0f172a;font-weight:800;}',
      '@keyframes wfms-pulse{50%{box-shadow:0 0 0 6px rgba(59,130,246,.08);}}',
      // Compact variant for dense tables
      '.wfms.compact .wfms-dot{width:6px;height:6px;}',
      '.wfms.compact .wfms-dot.current{width:8px;height:8px;}',
      '.wfms.compact .wfms-line{width:4px;}',
      '.wfms.compact .wfms-label{font-size:9px;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /**
   * Render the stepper.
   * @param {object} opts
   * @param {number} opts.steps - total step count (1-20)
   * @param {number} opts.current - current step index, 1-based (0 = none yet)
   * @param {string} [opts.status] - 'in_progress'|'approved'|'rejected'|'returned'|'closed'|'draft'
   * @param {boolean} [opts.compact] - smaller dots
   * @param {boolean} [opts.showLabel] - append "X من Y" label (default true)
   */
  function render(opts){
    _injectCss();
    opts = opts || {};
    var steps = Math.max(1, Math.min(20, Number(opts.steps) || 1));
    var current = Math.max(0, Math.min(steps, Number(opts.current) || 0));
    var status = String(opts.status || '').toLowerCase();
    var showLabel = opts.showLabel !== false;
    var compactCls = opts.compact ? ' compact' : '';

    // Treat terminal states uniformly
    var isApproved = status === 'approved' || status === 'closed';
    var isRejected = status === 'rejected';
    var isReturned = status === 'returned';

    var html = '<span class="wfms'+compactCls+'" role="img" aria-label="خطوة '+current+' من '+steps+'">';
    for (var i = 1; i <= steps; i++) {
      var dotCls = '';
      if (isApproved) {
        // All done if approved/closed
        dotCls = 'done';
      } else if (isRejected && i === current) {
        dotCls = 'rejected';
      } else if (isReturned && i === current) {
        dotCls = 'returned';
      } else if (i < current) {
        dotCls = 'done';
      } else if (i === current) {
        dotCls = 'current';
      }
      html += '<span class="wfms-dot'+(dotCls?' '+dotCls:'')+'"></span>';
      if (i < steps) {
        var lineCls = (isApproved || i < current) ? ' done' : '';
        html += '<span class="wfms-line'+lineCls+'"></span>';
      }
    }
    if (showLabel) {
      html += '<span class="wfms-label"><span class="num">'+current+'</span> من <span class="num">'+steps+'</span></span>';
    }
    html += '</span>';
    return html;
  }

  /**
   * Build a stepper from a transaction object. Handles all shape variants
   * the API returns (workflowPath array, currentStepIndex, totalSteps...).
   */
  function fromTxn(txn, opts){
    if (!txn) return render({steps: 1, current: 0});
    var steps = 1, current = 0;
    if (Array.isArray(txn.workflowPath) && txn.workflowPath.length) {
      steps = txn.workflowPath.length;
      // Find the step matching txn.currentStepId or fall back to count of "done"
      var idx = -1;
      if (txn.currentStepId) {
        for (var i = 0; i < txn.workflowPath.length; i++) {
          if (String(txn.workflowPath[i].id) === String(txn.currentStepId)) { idx = i; break; }
        }
      }
      current = idx >= 0 ? (idx + 1) : (txn.currentStepIndex || 1);
    } else if (txn.totalSteps) {
      steps = Number(txn.totalSteps) || 1;
      current = Number(txn.currentStepIndex) || 0;
    } else if (txn.stepIndex && txn.stepsTotal) {
      steps = Number(txn.stepsTotal) || 1;
      current = Number(txn.stepIndex) || 0;
    }
    return render(Object.assign({}, opts, {
      steps: steps,
      current: current,
      status: txn.status || ''
    }));
  }

  global.WfMiniStepper = { render: render, fromTxn: fromTxn };
})(typeof window !== 'undefined' ? window : this);
