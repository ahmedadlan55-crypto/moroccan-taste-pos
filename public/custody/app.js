/**
 * Custody User App — Standalone lightweight page
 * Only loads custody-specific code. No admin/POS overhead.
 */
(function() {
  'use strict';

  var S = {
    user: '', custodyId: '', custodyNumber: '', userName: '',
    balance: 0, topups: 0, expenses: 0, list: [], imgData: ''
  };

  var api;

  // ─── Boot ───
  document.addEventListener('DOMContentLoaded', function() {
    waitApi(function() {
      api = window._apiBridge;
      try {
        var s = JSON.parse(localStorage.getItem('pos_session') || '{}');
        S.user = s.username || s.user || '';
      } catch(e) {}
      if (!S.user) { toast('يرجى تسجيل الدخول', 'err'); setTimeout(function(){ location.replace('/'); }, 1200); return; }
      load();
    });
  });

  function waitApi(cb) {
    if (window._apiBridge) return cb();
    var n = 0, iv = setInterval(function() {
      n++;
      if (window._apiBridge || n > 40) { clearInterval(iv); if (window._apiBridge) cb(); else toast('فشل الاتصال', 'err'); }
    }, 80);
  }

  // ─── Load Data ───
  function load() {
    api.withSuccessHandler(function(d) {
      hideLoader();
      if (!d || d.error) {
        el('app').style.display = 'flex';
        el('headerName').textContent = S.user;
        toast(d && d.error || 'لا توجد عهدة', 'err');
        return;
      }
      S.custodyId = d.custody.id;
      S.custodyNumber = d.custody.custodyNumber;
      S.userName = (d.user && d.user.name) || d.custody.userName || S.user;
      S.balance = d.custody.balance;
      S.topups = d.custody.totalTopups;
      S.expenses = d.custody.totalExpenses;
      S.list = d.expenses || [];
      render();
    }).withFailureHandler(function() {
      hideLoader();
      toast('خطأ في الاتصال', 'err');
    }).getMyCustody(S.user);
  }
  window.refreshData = function() {
    el('topBar').classList.add('refreshing');
    api.withSuccessHandler(function(d) {
      el('topBar').classList.remove('refreshing');
      if (!d || d.error) return toast(d && d.error || 'خطأ', 'err');
      S.custodyId = d.custody.id;
      S.custodyNumber = d.custody.custodyNumber;
      S.userName = (d.user && d.user.name) || d.custody.userName || S.user;
      S.balance = d.custody.balance;
      S.topups = d.custody.totalTopups;
      S.expenses = d.custody.totalExpenses;
      S.list = d.expenses || [];
      render();
      toast('تم التحديث', 'ok');
    }).withFailureHandler(function() {
      el('topBar').classList.remove('refreshing');
      toast('فشل التحديث', 'err');
    }).getMyCustody(S.user);
  };

  function hideLoader() { el('loader').style.display = 'none'; el('app').style.display = 'flex'; el('app').style.flexDirection = 'column'; }

  // ─── Render ───
  function render() {
    el('headerName').textContent = S.userName;
    el('headerNum').textContent = S.custodyNumber;
    el('sBalance').textContent = fmt(S.balance);
    el('sTopups').textContent = fmt(S.topups);
    el('sExpenses').textContent = fmt(S.expenses);

    // Balance color
    var bc = el('sBalance');
    bc.style.color = S.balance > 0 ? 'var(--green)' : S.balance < 0 ? 'var(--red)' : 'var(--slate)';

    el('expBadge').textContent = S.list.length;

    var box = el('expList');
    if (!S.list.length) {
      box.innerHTML = '<div class="exp-empty"><i class="fas fa-inbox"></i><p>لا توجد مصروفات بعد</p><p style="font-size:12px;margin-top:6px;color:#b0b8c5;">اضغط الزر بالأسفل لإضافة مصروف</p></div>';
      return;
    }

    var h = '';
    S.list.forEach(function(e, i) {
      var bClass = 'b-' + e.status;
      var labels = { pending:'بانتظار الموافقة', approved:'تمت الموافقة', rejected:'مرفوض', posted:'تم الترحيل' };
      var icons = { pending:'fa-clock', approved:'fa-check-circle', rejected:'fa-times-circle', posted:'fa-book' };
      var total = e.totalWithVat || e.amount || 0;
      var dt = '';
      try { if (e.expenseDate) dt = new Date(e.expenseDate).toLocaleDateString('en-GB'); } catch(x){}

      h += '<div class="ecard" style="animation-delay:' + (i * 0.04) + 's;">';
      h += '<div class="ec-row1">';
      h += '<div class="ec-desc">' + esc(e.description || '') + '</div>';
      h += '<span class="ec-badge ' + bClass + '"><i class="fas ' + (icons[e.status]||'fa-circle') + '"></i> ' + (labels[e.status]||e.status) + '</span>';
      h += '</div>';
      h += '<div class="ec-amount">' + fmt(total) + ' <small>SAR</small></div>';
      h += '<div class="ec-meta">';
      if (dt) h += '<span><i class="fas fa-calendar-day"></i> ' + dt + '</span>';
      if (e.vatAmount > 0) h += '<span><i class="fas fa-percent"></i> ضريبة ' + fmt(e.vatAmount) + '</span>';
      if (e.notes) h += '<span><i class="fas fa-sticky-note"></i> ' + esc(e.notes) + '</span>';
      h += '</div>';
      if (e.status === 'rejected' && e.rejectionReason) {
        h += '<div class="ec-reject"><i class="fas fa-exclamation-triangle"></i> ' + esc(e.rejectionReason) + '</div>';
      }
      if (e.invoiceImage || e.approvedBy) {
        h += '<div class="ec-foot">';
        if (e.invoiceImage) h += '<button class="ec-img-btn" onclick="viewImg(\'' + e.id + '\')"><i class="fas fa-image"></i> الفاتورة</button>';
        else h += '<span></span>';
        if (e.approvedBy) h += '<span class="ec-meta"><i class="fas fa-user-check"></i> ' + esc(e.approvedBy) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    });
    box.innerHTML = h;
  }

  // ─── Modal ───
  window.openModal = function() {
    if (!S.custodyId) return toast('لا توجد عهدة', 'err');
    el('fDate').value = new Date().toISOString().split('T')[0];
    el('fAmt').value = '';
    el('fDesc').value = '';
    el('fVat').value = '0';
    el('fVatR').value = '15';
    el('vatBox').style.display = 'none';
    el('fNotes').value = '';
    el('imgPrev').innerHTML = '';
    el('uploadLabel').className = 'upload-area';
    el('uploadLabel').querySelector('span').textContent = 'اضغط لرفع صورة';
    S.imgData = '';
    el('sheet').style.display = 'flex';
  };
  window.closeModal = function() { el('sheet').style.display = 'none'; };
  window.togVat = function() { el('vatBox').style.display = el('fVat').value === '1' ? '' : 'none'; };

  // ─── Image ───
  window.pickImg = function(inp) {
    var f = inp.files[0]; if (!f) return;
    var isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    var r = new FileReader();
    r.onload = function(ev) {
      if (isPdf) {
        // Store PDF as data URL directly (no compression)
        S.imgData = ev.target.result;
        el('imgPrev').innerHTML = '<div style="padding:14px;background:#f1f5f9;border-radius:12px;text-align:center;"><i class="fas fa-file-pdf" style="font-size:32px;color:#ef4444;"></i><p style="margin-top:6px;font-size:13px;font-weight:700;">' + esc(f.name) + '</p></div>';
        el('uploadLabel').className = 'upload-area has-img';
        el('uploadLabel').querySelector('span').textContent = 'تم رفع الملف';
      } else {
        // Compress image
        var img = new Image();
        img.onload = function() {
          var c = document.createElement('canvas'), mx = 1200, w = img.width, h = img.height;
          if (w > mx || h > mx) { var sc = Math.min(mx/w, mx/h); w *= sc; h *= sc; }
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          S.imgData = c.toDataURL('image/jpeg', 0.82);
          el('imgPrev').innerHTML = '<img src="' + S.imgData + '">';
          el('uploadLabel').className = 'upload-area has-img';
          el('uploadLabel').querySelector('span').textContent = 'تم رفع الصورة';
        };
        img.src = ev.target.result;
      }
    };
    r.readAsDataURL(f);
  };

  // ─── Save ───
  window.doSave = function() {
    var desc = el('fDesc').value.trim();
    var amt = Number(el('fAmt').value) || 0;
    if (!desc || amt <= 0) return toast('البيان والقيمة مطلوبة', 'err');

    var hasVat = el('fVat').value === '1';
    var vatRate = hasVat ? (Number(el('fVatR').value) || 15) : 0;

    var btn = el('saveBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...';

    api.withSuccessHandler(function(r) {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
      if (r && r.success) {
        closeModal();
        toast('تم إرسال المصروف — بانتظار الموافقة', 'ok');
        load();
      } else toast((r && r.error) || 'فشل الحفظ', 'err');
    }).withFailureHandler(function() {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
      toast('خطأ في الاتصال', 'err');
    }).addCustodyExpense(S.custodyId, {
      expenseDate: el('fDate').value,
      description: desc, amount: amt,
      hasVat: hasVat, vatRate: vatRate,
      invoiceImage: S.imgData || '',
      notes: el('fNotes').value.trim(),
      username: S.user
    });
  };

  // ─── Image Viewer ───
  window.viewImg = function(id) {
    var e = S.list.find(function(x) { return x.id === id; });
    if (e && e.invoiceImage) {
      // Check if PDF
      if (e.invoiceImage.indexOf('application/pdf') !== -1) {
        // Open PDF in new tab
        var w = window.open('', '_blank');
        w.document.write('<html><body style="margin:0;"><iframe src="' + e.invoiceImage + '" style="width:100%;height:100vh;border:none;"></iframe></body></html>');
        w.document.close();
      } else {
        el('viewerImg').src = e.invoiceImage;
        el('viewer').style.display = 'flex';
      }
    } else toast('لا توجد صورة', 'err');
  };
  window.closeViewer = function() { el('viewer').style.display = 'none'; };

  // ─── Logout ───
  window.doLogout = function() {
    localStorage.removeItem('pos_session');
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_last_view');
    location.replace('/');
  };

  // ─── Utilities ───
  function el(id) { return document.getElementById(id); }
  function fmt(v) { return Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { var d = document.createElement('div'); d.appendChild(document.createTextNode(s || '')); return d.innerHTML; }
  function toast(msg, type) {
    var c = el('toasts'); if (!c) return;
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 2800);
  }
  window.toast = toast;

})();
