/**
 * Custody User App — Standalone lightweight page
 * Only loads custody-specific code. No admin/POS overhead.
 */
(function() {
  'use strict';

  var S = {
    user: '', custodyId: '', custodyNumber: '', userName: '',
    balance: 0, topups: 0, expenses: 0, list: [], imgData: '',
    custodyStatus: 'active',
    expenseAccounts: [], branchName: '', companyName: '',
    _pendingPayload: null
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
      S.custodyStatus = d.custody.status || 'active';
      S.list = d.expenses || [];
      S.expenseAccounts = d.expenseAccounts || [];
      S.branchName = d.branchName || '';
      S.companyName = d.companyName || '';
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
      S.custodyStatus = d.custody.status || 'active';
      S.list = d.expenses || [];
      S.expenseAccounts = d.expenseAccounts || [];
      S.branchName = d.branchName || '';
      S.companyName = d.companyName || '';
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

    // Branch name
    if (S.branchName) {
      el('branchBar').style.display = 'flex';
      el('branchName').textContent = S.branchName;
    }
    el('sBalance').textContent = fmt(S.balance);
    el('sTopups').textContent = fmt(S.topups);
    el('sExpenses').textContent = fmt(S.expenses);

    // Balance color
    var bc = el('sBalance');
    bc.style.color = S.balance > 0 ? 'var(--green)' : S.balance < 0 ? 'var(--red)' : 'var(--slate)';

    // Show/hide close button based on status
    var closeBtn = el('closeBtn');
    if (closeBtn) {
      if (S.custodyStatus === 'active') {
        closeBtn.style.display = 'inline-flex';
      } else if (S.custodyStatus === 'close_pending') {
        closeBtn.style.display = 'inline-flex';
        closeBtn.innerHTML = '<i class="fas fa-hourglass-half"></i><span>بانتظار الإقفال</span>';
        closeBtn.disabled = true;
        closeBtn.style.opacity = '0.6';
      } else {
        closeBtn.style.display = 'inline-flex';
        closeBtn.innerHTML = '<i class="fas fa-lock"></i><span>العهدة مغلقة</span>';
        closeBtn.disabled = true;
        closeBtn.style.opacity = '0.6';
      }
    }

    // Disable FAB if custody is closed or close_pending
    var fab = document.querySelector('.fab');
    if (fab) {
      if (S.custodyStatus !== 'active') {
        fab.style.opacity = '0.4';
        fab.style.pointerEvents = 'none';
      } else {
        fab.style.opacity = '1';
        fab.style.pointerEvents = 'auto';
      }
    }

    el('expBadge').textContent = S.list.length;

    var box = el('expList');
    if (!S.list.length) {
      box.innerHTML = '<div class="exp-empty"><i class="fas fa-inbox"></i><p>لا توجد مصروفات بعد</p><p style="font-size:12px;margin-top:6px;color:#b0b8c5;">اضغط الزر بالأسفل لإضافة مصروف</p></div>';
      return;
    }

    var h = '';
    S.list.forEach(function(e, i) {
      var statusKey = e.status;
      var bClass = 'b-' + statusKey;
      var labels = {
        pending: 'بانتظار الموافقة',
        approved: 'تمت الموافقة',
        rejected: 'مرفوض',
        posted: 'تم الترحيل',
        override_pending: 'طلب تجاوز رصيد',
        returned: 'مُرجع للتعديل'
      };
      var icons = {
        pending: 'fa-clock',
        approved: 'fa-check-circle',
        rejected: 'fa-times-circle',
        posted: 'fa-book',
        override_pending: 'fa-exclamation-triangle',
        returned: 'fa-edit'
      };
      var total = e.totalWithVat || e.amount || 0;
      var dt = '';
      try { if (e.expenseDate) dt = new Date(e.expenseDate).toLocaleDateString('en-GB'); } catch(x){}

      h += '<div class="ecard" style="animation-delay:' + (i * 0.04) + 's;">';
      h += '<div class="ec-row1">';
      h += '<div class="ec-desc">' + esc(e.description || '') + '</div>';
      h += '<span class="ec-badge ' + bClass + '"><i class="fas ' + (icons[statusKey]||'fa-circle') + '"></i> ' + (labels[statusKey]||statusKey) + '</span>';
      h += '</div>';
      // Show expense type (GL account) separately from description
      if (e.glAccountName) {
        h += '<div style="font-size:11px;color:#8b5cf6;font-weight:700;margin:2px 0;"><i class="fas fa-tag" style="margin-left:3px;"></i> ' + esc(e.glAccountName) + '</div>';
      }
      h += '<div class="ec-amount">' + fmt(total) + ' <small>SAR</small></div>';
      h += '<div class="ec-meta">';
      if (dt) h += '<span><i class="fas fa-calendar-day"></i> ' + dt + '</span>';
      if (e.vatAmount > 0) h += '<span><i class="fas fa-percent"></i> ضريبة ' + fmt(e.vatAmount) + '</span>';
      if (e.notes) h += '<span><i class="fas fa-sticky-note"></i> ' + esc(e.notes) + '</span>';
      if (e.costCenterName) h += '<span><i class="fas fa-bullseye"></i> ' + esc(e.costCenterName) + '</span>';
      h += '</div>';
      if (e.status === 'rejected' && e.rejectionReason) {
        h += '<div class="ec-reject"><i class="fas fa-exclamation-triangle"></i> ' + esc(e.rejectionReason) + '</div>';
      }
      // Edit button for returned expenses
      if (e.status === 'returned') {
        h += '<div class="ec-foot">';
        h += '<button class="ec-img-btn" style="background:rgba(67,56,202,0.1);color:#4338ca;" onclick="editExpense(\'' + e.id + '\')"><i class="fas fa-edit"></i> تعديل وإعادة إرسال</button>';
        if (e.invoiceImage) h += '<button class="ec-img-btn" onclick="viewImg(\'' + e.id + '\')"><i class="fas fa-image"></i> الفاتورة</button>';
        h += '</div>';
      } else if (e.invoiceImage || e.approvedBy) {
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

  // ─── Add Expense Modal ───
  window.openModal = function() {
    if (!S.custodyId) return toast('لا توجد عهدة', 'err');
    if (S.custodyStatus !== 'active') return toast('العهدة غير نشطة — لا يمكن إضافة مصروفات', 'err');
    _editingExpId = null;
    el('saveBtn').innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
    // Populate expense type dropdown
    var typeSelect = el('fExpType');
    if (typeSelect) {
      var opts = '<option value="">— اختر نوع المصروف —</option>';
      S.expenseAccounts.forEach(function(a) {
        opts += '<option value="' + a.id + '" data-name="' + esc(a.name) + '">' + a.code + ' — ' + esc(a.name) + '</option>';
      });
      typeSelect.innerHTML = opts;
    }
    // Populate cost centers
    var ccSelect = el('fCostCenter');
    if (ccSelect) {
      api.withSuccessHandler(function(ccs) {
        var ccOpts = '<option value="">— اختياري —</option>';
        (ccs||[]).forEach(function(c) { ccOpts += '<option value="' + c.id + '" data-name="' + esc(c.name) + '">' + c.code + ' — ' + esc(c.name) + '</option>'; });
        ccSelect.innerHTML = ccOpts;
      }).getCostCenters();
    }
    // Reset pre-approval checkbox
    var preApprovalEl = el('fPreApproval');
    if (preApprovalEl) preApprovalEl.checked = false;

    el('fDate').value = new Date().toISOString().split('T')[0];
    el('fAmt').value = '';
    el('fDesc').value = '';
    el('fVat').value = '0';
    el('fVatR').value = '15';
    el('vatBox').style.display = 'none';
    el('fNotes').value = '';
    el('imgPrev').innerHTML = '';
    el('uploadLabel').className = 'upload-area';
    el('uploadLabel').querySelector('span').textContent = 'اضغط لرفع صورة أو PDF';
    S.imgData = '';
    el('sheet').style.display = 'flex';
  };
  window.closeModal = function() { el('sheet').style.display = 'none'; };
  window.togVat = function() { el('vatBox').style.display = el('fVat').value === '1' ? '' : 'none'; };

  // Search/filter expense types
  window.filterExpTypes = function(query) {
    var sel = el('fExpType');
    if (!sel) return;
    var ql = (query||'').toLowerCase();
    var options = sel.querySelectorAll('option');
    var visibleCount = 0;
    options.forEach(function(opt) {
      if (!opt.value) { opt.style.display = ''; return; }
      var show = opt.textContent.toLowerCase().indexOf(ql) >= 0;
      opt.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });
    sel.size = ql && visibleCount > 0 ? Math.min(6, visibleCount + 1) : 1;
  };

  // Add new expense type (creates GL expense account)
  window.openAddExpenseType = function() {
    var name = prompt('اسم نوع المصروف الجديد:');
    if (!name) return;
    // Find next expense account code
    var maxCode = 0;
    S.expenseAccounts.forEach(function(a) {
      var num = parseInt(a.code) || 0;
      if (num > maxCode) maxCode = num;
    });
    var newCode = String(maxCode + 1);

    api.withSuccessHandler(function(r) {
      if (r && r.success) {
        toast('تم إضافة نوع المصروف: ' + name, 'ok');
        // Reload expense accounts
        api.withSuccessHandler(function(d) {
          if (d && d.expenseAccounts) S.expenseAccounts = d.expenseAccounts;
          // Rebuild dropdown
          var typeSelect = el('fExpType');
          if (typeSelect) {
            var opts = '<option value="">— اختر نوع المصروف —</option>';
            S.expenseAccounts.forEach(function(a) {
              opts += '<option value="' + a.id + '" data-name="' + esc(a.name) + '">' + a.code + ' — ' + esc(a.name) + '</option>';
            });
            typeSelect.innerHTML = opts;
          }
        }).getMyCustody(S.user);
      } else toast((r && r.error) || 'فشل', 'err');
    }).saveGLAccount({ code: newCode, nameAr: name, type: 'expense', level: 3 });
  };

  window.onExpTypeChange = function() {
    var sel = el('fExpType');
    if (sel && sel.value) {
      var opt = sel.options[sel.selectedIndex];
      var name = opt.getAttribute('data-name') || '';
      // Auto-fill description if empty
      var descEl = el('fDesc');
      if (descEl && !descEl.value) descEl.value = name;
    }
  };

  // ─── Image / PDF ───
  window.pickImg = function(inp) {
    var f = inp.files[0]; if (!f) return;
    var isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    var r = new FileReader();
    r.onload = function(ev) {
      if (isPdf) {
        S.imgData = ev.target.result;
        el('imgPrev').innerHTML = '<div style="padding:14px;background:#f1f5f9;border-radius:12px;text-align:center;"><i class="fas fa-file-pdf" style="font-size:32px;color:#ef4444;"></i><p style="margin-top:6px;font-size:13px;font-weight:700;">' + esc(f.name) + '</p></div>';
        el('uploadLabel').className = 'upload-area has-img';
        el('uploadLabel').querySelector('span').textContent = 'تم رفع الملف';
      } else {
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

  // ─── Build payload ───
  function buildPayload(override) {
    var desc = el('fDesc').value.trim();
    var amt = Number(el('fAmt').value) || 0;
    if (!desc || amt <= 0) { toast('البيان والقيمة مطلوبة', 'err'); return null; }
    var hasVat = el('fVat').value === '1';
    var vatRate = hasVat ? (Number(el('fVatR').value) || 15) : 0;
    // GL account
    var typeSel = el('fExpType');
    var glAccountId = typeSel ? typeSel.value : '';
    var glAccountName = '';
    if (typeSel && typeSel.value) {
      var opt = typeSel.options[typeSel.selectedIndex];
      glAccountName = opt ? (opt.getAttribute('data-name') || '') : '';
    }
    // Cost center
    var ccSel = el('fCostCenter');
    var costCenterId = ccSel ? ccSel.value : '';
    var costCenterName = '';
    if (ccSel && ccSel.value) { var ccOpt = ccSel.options[ccSel.selectedIndex]; costCenterName = ccOpt ? (ccOpt.getAttribute('data-name')||'') : ''; }
    // Pre-approval
    var preApproval = el('fPreApproval') && el('fPreApproval').checked;

    return {
      expenseDate: el('fDate').value,
      description: desc, amount: amt,
      hasVat: hasVat, vatRate: vatRate,
      invoiceImage: S.imgData || '',
      notes: el('fNotes').value.trim(),
      username: S.user,
      overrideBalance: !!override,
      glAccountId: glAccountId,
      glAccountName: glAccountName,
      costCenterId: costCenterId,
      costCenterName: costCenterName,
      preApproval: preApproval
    };
  }

  // ─── Save expense ───
  window.doSave = function() {
    var payload = buildPayload(false);
    if (!payload) return;

    // If editing a returned expense, use update endpoint
    if (_editingExpId) {
      var editId = _editingExpId;
      _editingExpId = null;
      var btn = el('saveBtn');
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري التعديل...';
      api.withSuccessHandler(function(r) {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
        if (r && r.success) {
          closeModal();
          toast('تم التعديل وإعادة الإرسال — بانتظار الموافقة', 'ok');
          load();
        } else toast((r && r.error) || 'فشل التعديل', 'err');
      }).withFailureHandler(function() {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
        toast('خطأ في الاتصال', 'err');
      }).updateCustodyExp(editId, payload);
      return;
    }

    submitExpense(payload);
  };

  function submitExpense(payload) {
    var btn = el('saveBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...';

    api.withSuccessHandler(function(r) {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
      if (r && r.success) {
        closeModal();
        if (r.status === 'override_pending') {
          toast('تم إرسال طلب تجاوز الرصيد — بانتظار موافقة المدير', 'ok');
        } else {
          toast('تم إرسال المصروف — بانتظار الموافقة', 'ok');
        }
        load();
      } else if (r && r.needsOverride) {
        // Balance exceeded — show override confirmation
        S._pendingPayload = payload;
        el('overrideMsg').innerHTML =
          '<div style="background:#fef3c7;padding:14px;border-radius:12px;margin-bottom:10px;">' +
          '<strong style="color:#92400e;"><i class="fas fa-exclamation-triangle"></i> تنبيه:</strong><br>' +
          esc(r.error) +
          '</div>' +
          '<p>هل تريد إرسال طلب تجاوز الرصيد للمدير للموافقة عليه؟</p>';
        el('overrideSheet').style.display = 'flex';
      } else {
        toast((r && r.error) || 'فشل الحفظ', 'err');
      }
    }).withFailureHandler(function() {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال المصروف';
      toast('خطأ في الاتصال', 'err');
    }).addCustodyExpense(S.custodyId, payload);
  }

  // ─── Override flow ───
  window.closeOverride = function() { el('overrideSheet').style.display = 'none'; };
  window.confirmOverride = function() {
    el('overrideSheet').style.display = 'none';
    if (!S._pendingPayload) return;
    S._pendingPayload.overrideBalance = true;
    submitExpense(S._pendingPayload);
    S._pendingPayload = null;
  };

  // ─── Close custody request ───
  window.requestClose = function() {
    if (S.custodyStatus !== 'active') return;
    var info = '<div style="background:#f1f5f9;padding:14px;border-radius:12px;margin-bottom:10px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>إجمالي التغذية:</span><strong style="color:var(--green);">' + fmt(S.topups) + ' SAR</strong></div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>إجمالي المصروفات:</span><strong style="color:var(--red);">' + fmt(S.expenses) + ' SAR</strong></div>' +
      '<div style="display:flex;justify-content:space-between;border-top:1px solid #e2e8f0;padding-top:6px;"><span>الرصيد المتبقي:</span><strong style="color:' + (S.balance >= 0 ? 'var(--green)' : 'var(--red)') + ';font-size:18px;">' + fmt(S.balance) + ' SAR</strong></div>' +
      '</div>';
    if (S.balance < 0) {
      info += '<p style="color:var(--red);font-weight:700;margin-bottom:8px;"><i class="fas fa-info-circle"></i> تم تجاوز الرصيد بمبلغ ' + fmt(Math.abs(S.balance)) + ' SAR — سيتم تسوية الفرق بعد الموافقة.</p>';
    } else if (S.balance > 0) {
      info += '<p style="color:var(--green);font-weight:700;margin-bottom:8px;"><i class="fas fa-info-circle"></i> سيتم استرجاع المبلغ المتبقي ' + fmt(S.balance) + ' SAR بعد الموافقة.</p>';
    }
    el('closeInfo').innerHTML = info;
    el('closeSheet').style.display = 'flex';
  };
  window.closeCloseSheet = function() { el('closeSheet').style.display = 'none'; };
  window.confirmClose = function() {
    var btn = el('closeSaveBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...';

    api.withSuccessHandler(function(r) {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-lock"></i> تأكيد طلب الإقفال';
      el('closeSheet').style.display = 'none';
      if (r && r.success) {
        toast('تم إرسال طلب الإقفال — بانتظار موافقة المدير', 'ok');
        load();
      } else toast((r && r.error) || 'فشل', 'err');
    }).withFailureHandler(function() {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-lock"></i> تأكيد طلب الإقفال';
      toast('خطأ في الاتصال', 'err');
    }).closeCustodyRequest(S.custodyId, { username: S.user, notes: el('closeNotes').value.trim() });
  };

  // ─── Edit returned expense ───
  var _editingExpId = null;

  window.editExpense = function(id) {
    var e = S.list.find(function(x) { return x.id === id; });
    if (!e) return;
    _editingExpId = id;
    // Fill form with existing data
    try { el('fDate').value = e.expenseDate ? new Date(e.expenseDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]; } catch(x) { el('fDate').value = new Date().toISOString().split('T')[0]; }
    el('fAmt').value = e.amount || '';
    el('fDesc').value = e.description || '';
    el('fVat').value = e.hasVat ? '1' : '0';
    el('fVatR').value = e.vatRate || 15;
    el('vatBox').style.display = e.hasVat ? '' : 'none';
    el('fNotes').value = e.notes || '';
    S.imgData = '';
    if (e.invoiceImage) {
      el('imgPrev').innerHTML = e.invoiceImage.indexOf('application/pdf') !== -1
        ? '<div style="padding:10px;background:#f1f5f9;border-radius:12px;text-align:center;"><i class="fas fa-file-pdf" style="font-size:28px;color:#ef4444;"></i><p style="font-size:12px;">الملف الحالي</p></div>'
        : '<img src="' + e.invoiceImage + '">';
      el('uploadLabel').className = 'upload-area has-img';
      el('uploadLabel').querySelector('span').textContent = 'تغيير الصورة';
    } else {
      el('imgPrev').innerHTML = '';
      el('uploadLabel').className = 'upload-area';
      el('uploadLabel').querySelector('span').textContent = 'اضغط لرفع صورة أو PDF';
    }
    // Change save button text
    el('saveBtn').innerHTML = '<i class="fas fa-paper-plane"></i> تعديل وإعادة الإرسال';
    el('sheet').style.display = 'flex';
  };

  // ─── Image Viewer ───
  window.viewImg = function(id) {
    var e = S.list.find(function(x) { return x.id === id; });
    if (e && e.invoiceImage) {
      if (e.invoiceImage.indexOf('application/pdf') !== -1) {
        // Show PDF in the same viewer modal using embed
        el('viewerImg').style.display = 'none';
        var pdfEmbed = document.getElementById('viewerPdf');
        if (!pdfEmbed) {
          pdfEmbed = document.createElement('embed');
          pdfEmbed.id = 'viewerPdf';
          pdfEmbed.style.cssText = 'width:95%;height:90vh;border-radius:12px;background:#fff;';
          el('viewer').querySelector('.img-viewer-content') ?
            el('viewer').querySelector('.img-viewer-content').appendChild(pdfEmbed) :
            el('viewer').insertBefore(pdfEmbed, el('viewer').firstChild);
        }
        pdfEmbed.src = e.invoiceImage;
        pdfEmbed.type = 'application/pdf';
        pdfEmbed.style.display = 'block';
        el('viewer').style.display = 'flex';
        el('viewer').onclick = null; // Don't close on PDF click
      } else {
        // Remove PDF embed if exists
        var pdfEl = document.getElementById('viewerPdf');
        if (pdfEl) pdfEl.style.display = 'none';
        el('viewerImg').style.display = 'block';
        el('viewerImg').src = e.invoiceImage;
        el('viewer').style.display = 'flex';
        el('viewer').onclick = closeViewer;
      }
    } else toast('لا توجد صورة', 'err');
  };
  window.closeViewer = function() {
    el('viewer').style.display = 'none';
    var pdfEl = document.getElementById('viewerPdf');
    if (pdfEl) { pdfEl.src = ''; pdfEl.style.display = 'none'; }
    el('viewerImg').style.display = 'block';
    el('viewer').onclick = closeViewer;
  };

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
