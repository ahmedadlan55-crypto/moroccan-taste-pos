/**
 * Custody User App — Lightweight standalone page for custody role users
 * Shows: balance cards + expenses list + add expense modal
 */

(function() {
  'use strict';

  // ─── State ───
  var state = {
    user: '',
    custodyId: '',
    custodyNumber: '',
    userName: '',
    balance: 0,
    totalTopups: 0,
    totalExpenses: 0,
    expenses: [],
    invoiceImageData: ''
  };

  // ─── Wait for API bridge to load ───
  function waitForApi(cb) {
    if (window._apiBridge) return cb();
    var tries = 0;
    var interval = setInterval(function() {
      tries++;
      if (window._apiBridge || tries > 50) {
        clearInterval(interval);
        if (window._apiBridge) cb();
        else { showToast('فشل تحميل النظام', true); }
      }
    }, 100);
  }

  // ─── Init ───
  document.addEventListener('DOMContentLoaded', function() {
    waitForApi(function() {
      // Parse session
      try {
        var session = JSON.parse(localStorage.getItem('pos_session') || '{}');
        state.user = session.username || session.user || '';
      } catch (e) {}

      if (!state.user) {
        showToast('يرجى تسجيل الدخول', true);
        setTimeout(function() { window.location.replace('/'); }, 1500);
        return;
      }

      loadMyCustody();
    });
  });

  // ─── Load Data ───
  function loadMyCustody() {
    var api = window._apiBridge;
    api.withSuccessHandler(function(data) {
      hideLoader();
      if (!data || data.error || data.noCustody) {
        document.getElementById('custodyApp').style.display = 'block';
        document.getElementById('custodyUserName').textContent = state.user;
        showToast(data && data.error || 'لا توجد عهدة مرتبطة بحسابك', true);
        return;
      }

      state.custodyId = data.custody.id;
      state.custodyNumber = data.custody.custodyNumber;
      state.userName = data.user.name || data.custody.userName || state.user;
      state.balance = data.custody.balance;
      state.totalTopups = data.custody.totalTopups;
      state.totalExpenses = data.custody.totalExpenses;
      state.expenses = data.expenses || [];

      renderUI();
    }).withFailureHandler(function(err) {
      hideLoader();
      showToast('خطأ في الاتصال', true);
    }).getMyCustody(state.user);
  }

  function hideLoader() {
    var loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
    document.getElementById('custodyApp').style.display = 'block';
  }

  // ─── Render UI ───
  function renderUI() {
    var fmt = function(v) {
      return Number(v || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    };

    document.getElementById('custodyUserName').textContent = state.userName;
    document.getElementById('balanceCurrent').textContent = fmt(state.balance) + ' SAR';
    document.getElementById('balanceCustodyNum').textContent = state.custodyNumber;
    document.getElementById('balanceTopups').textContent = fmt(state.totalTopups);
    document.getElementById('balanceExpenses').textContent = fmt(state.totalExpenses);

    // Balance color
    var balEl = document.getElementById('balanceCurrent');
    if (state.balance < 0) balEl.style.color = '#ef4444';
    else if (state.balance > 0) balEl.style.color = '#16a34a';
    else balEl.style.color = '#64748b';

    // Expense count
    document.getElementById('expCount').textContent = state.expenses.length;

    // Render expenses
    var listEl = document.getElementById('expensesList');
    if (!state.expenses.length) {
      listEl.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد مصروفات بعد</p></div>';
      return;
    }

    var html = '';
    state.expenses.forEach(function(e) {
      var statusClass = 'status-' + e.status;
      var statusLabels = {
        pending: 'بانتظار الموافقة',
        approved: 'تمت الموافقة',
        rejected: 'مرفوض',
        posted: 'تم الترحيل'
      };
      var statusIcons = {
        pending: 'fa-clock',
        approved: 'fa-check-circle',
        rejected: 'fa-times-circle',
        posted: 'fa-book'
      };

      var dateStr = '';
      if (e.expenseDate) {
        try { dateStr = new Date(e.expenseDate).toLocaleDateString('en-GB'); } catch(err) {}
      }

      var total = e.totalWithVat || e.amount || 0;

      html += '<div class="expense-card">';
      html += '<div class="exp-top">';
      html += '<div class="exp-desc">' + escHtml(e.description || '') + '</div>';
      html += '<span class="exp-status ' + statusClass + '"><i class="fas ' + (statusIcons[e.status] || 'fa-circle') + '"></i> ' + (statusLabels[e.status] || e.status) + '</span>';
      html += '</div>';

      html += '<div class="exp-amount">' + fmt(total) + ' <small>SAR</small></div>';

      html += '<div class="exp-details">';
      if (dateStr) html += '<div class="exp-detail-item"><i class="fas fa-calendar"></i> ' + dateStr + '</div>';
      if (e.vatAmount > 0) html += '<div class="exp-detail-item"><i class="fas fa-percentage"></i> ضريبة: ' + fmt(e.vatAmount) + '</div>';
      if (e.notes) html += '<div class="exp-detail-item"><i class="fas fa-sticky-note"></i> ' + escHtml(e.notes) + '</div>';
      html += '</div>';

      // Rejection reason
      if (e.status === 'rejected' && e.rejectionReason) {
        html += '<div class="exp-rejection"><i class="fas fa-exclamation-triangle"></i> سبب الرفض: ' + escHtml(e.rejectionReason) + '</div>';
      }

      // Invoice image button
      html += '<div class="exp-bottom">';
      if (e.invoiceImage) {
        html += '<button class="exp-invoice-btn" onclick="viewInvoiceImage(\'' + e.id + '\')"><i class="fas fa-image"></i> عرض الفاتورة</button>';
      } else {
        html += '<span></span>';
      }
      if (e.approvedBy) {
        html += '<div class="exp-detail-item"><i class="fas fa-user-check"></i> ' + escHtml(e.approvedBy) + '</div>';
      }
      html += '</div>';

      html += '</div>';
    });

    listEl.innerHTML = html;
  }

  // ─── Expense Modal ───
  window.openExpenseModal = function() {
    if (!state.custodyId) return showToast('لا توجد عهدة مرتبطة', true);
    // Reset form
    document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('expAmount').value = '';
    document.getElementById('expDesc').value = '';
    document.getElementById('expHasVat').value = '0';
    document.getElementById('expVatRate').value = '15';
    document.getElementById('vatGroup').style.display = 'none';
    document.getElementById('expNotes').value = '';
    document.getElementById('invoicePreview').innerHTML = '';
    state.invoiceImageData = '';
    document.getElementById('expenseModal').style.display = 'flex';
  };

  window.closeExpenseModal = function() {
    document.getElementById('expenseModal').style.display = 'none';
  };

  window.toggleVat = function() {
    document.getElementById('vatGroup').style.display =
      document.getElementById('expHasVat').value === '1' ? '' : 'none';
  };

  // ─── Image Upload ───
  window.handleInvoiceImage = function(input) {
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var max = 1200;
        var w = img.width, h = img.height;
        if (w > max || h > max) { var r = Math.min(max / w, max / h); w *= r; h *= r; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        state.invoiceImageData = canvas.toDataURL('image/jpeg', 0.85);
        document.getElementById('invoicePreview').innerHTML =
          '<img src="' + state.invoiceImageData + '">';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  // ─── Submit Expense ───
  window.submitExpense = function() {
    var desc = document.getElementById('expDesc').value.trim();
    var amount = Number(document.getElementById('expAmount').value) || 0;
    if (!desc || amount <= 0) return showToast('البيان والقيمة مطلوبة', true);

    var hasVat = document.getElementById('expHasVat').value === '1';
    var vatRate = hasVat ? (Number(document.getElementById('expVatRate').value) || 15) : 0;

    var payload = {
      expenseDate: document.getElementById('expDate').value,
      description: desc,
      amount: amount,
      hasVat: hasVat,
      vatRate: vatRate,
      invoiceImage: state.invoiceImageData || '',
      notes: document.getElementById('expNotes').value.trim(),
      username: state.user
    };

    // Show loading state
    var saveBtn = document.querySelector('.btn-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الحفظ...'; }

    var api = window._apiBridge;
    api.withSuccessHandler(function(r) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> حفظ المصروف'; }
      if (r && r.success) {
        closeExpenseModal();
        showToast('تم إضافة المصروف بنجاح');
        loadMyCustody(); // Refresh data
      } else {
        showToast((r && r.error) || 'فشل الحفظ', true);
      }
    }).withFailureHandler(function(err) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> حفظ المصروف'; }
      showToast('خطأ في الاتصال', true);
    }).addCustodyExpense(state.custodyId, payload);
  };

  // ─── View Invoice Image ───
  window.viewInvoiceImage = function(expId) {
    var exp = state.expenses.find(function(e) { return e.id === expId; });
    if (exp && exp.invoiceImage) {
      document.getElementById('imageViewerImg').src = exp.invoiceImage;
      document.getElementById('imageViewer').style.display = 'flex';
    } else {
      showToast('لا توجد صورة', true);
    }
  };

  window.closeImageViewer = function() {
    document.getElementById('imageViewer').style.display = 'none';
  };

  // ─── Logout ───
  window.custodyLogout = function() {
    localStorage.removeItem('pos_session');
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_last_view');
    window.location.replace('/');
  };

  // ─── Toast ───
  function showToast(msg, isError) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 3000);
  }
  window.showToast = showToast;

  // ─── Helpers ───
  function escHtml(s) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(s || ''));
    return div.innerHTML;
  }

})();
