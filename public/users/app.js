/**
 * Users page logic — list, add, edit, toggle, delete users
 * Standalone — uses /shared/common.js + /shared/auth.js + /shared/api-bridge.js
 */

var _cachedUsers = [];
var _editingUsername = '';

document.addEventListener('DOMContentLoaded', function() {
  if (!requireAuth()) return;
  document.body.classList.add('authenticated');
  restoreState();

  // Header + branding
  renderHeader('users');
  applyLang();
  translateUI();
  if (typeof refreshBrandingFromServer === 'function') {
    refreshBrandingFromServer(function() { renderHeader('users'); });
  }

  // Pull initial app data so state.currentUser/isDeveloper get populated,
  // then load the users table.
  api.withSuccessHandler(function(res) {
    if (res && !res.error) {
      state.settings = res.settings || state.settings;
      state.currentUser = res.currentUser || { username: state.user, role: state.role };
      state.isDeveloper = !!(res.currentUser && res.currentUser.isDeveloper);
      saveState();
      renderHeader('users');
    }
    loadUsers();
  }).withFailureHandler(function() { loadUsers(); }).getInitialAppData(state.user);
});

window.onLangChange = function() {
  renderHeader('users');
  loadUsers();
};

window.loadUsers = function() {
  loader(true);
  api.withFailureHandler(function(err) {
    loader(false);
    showToast(err.message || 'فشل تحميل المستخدمين', true);
  }).withSuccessHandler(function(arr) {
    loader(false);
    arr = Array.isArray(arr) ? arr : [];
    _cachedUsers = arr;

    var roleLabel = function(r) {
      if (r === 'admin')   return '<span class="badge blue">مدير مؤسسة</span>';
      if (r === 'manager') return '<span class="badge orange">مدير فرع</span>';
      return '<span class="badge green">كاشير</span>';
    };

    var tbody = q('#tbUsers');
    if (!arr.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:#94a3b8;">لا يوجد مستخدمين</td></tr>';
      return;
    }

    tbody.innerHTML = arr.map(function(u) {
      var devBadge = u.isDeveloper ? ' <span class="dev-badge"><i class="fas fa-code"></i> مطور</span>' : '';
      var displayName = u.displayName || '<span style="color:#94a3b8;">— لم يُحدد —</span>';
      return '<tr>' +
        '<td style="font-weight:800; font-size:14px;">' + displayName + '</td>' +
        '<td style="font-family:monospace; font-weight:700; color:var(--secondary);">' + (u.username || '') + '</td>' +
        '<td>' + roleLabel(u.role) + devBadge + '</td>' +
        '<td>' + (u.active
          ? '<span class="badge green">نشط</span>'
          : '<span class="badge red">موقوف</span>') + '</td>' +
        '<td style="color:#64748b;font-size:12px;">' +
          (u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '—') + '</td>' +
        '<td>' +
          '<div class="user-actions">' +
            '<button class="btn-edit"   onclick="editUser(\'' + u.username + '\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
            // v6.18.5 (Wave 6) — Permissions modal trigger
            '<button class="btn-edit"   onclick="openUserPermsModal(\'' + u.username + '\')" title="الصلاحيات" style="background:#0d9488;"><i class="fas fa-shield-halved"></i></button>' +
            '<button class="btn-toggle" onclick="toggleUser(\'' + u.username + '\')" title="تفعيل / إيقاف"><i class="fas fa-power-off"></i></button>' +
            '<button class="btn-del"    onclick="deleteUser(\'' + u.username + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }).getUsers();
};

// Load branches, brands, positions, and (v6.18.1) job-titles for the
// dropdowns.  Cached after first call.  All four fetches kick off in
// parallel; `done()` only proceeds once all four have populated.
var _muBranches = null, _muBrands = null, _muPositions = null, _muJobTitles = null;
function _muLoadDropdowns(cb) {
  function done() {
    if (_muBranches && _muBrands && _muPositions && _muJobTitles) {
      var brOpt = '<option value="">— بدون —</option>' + _muBranches.map(function(b){return '<option value="'+b.id+'">'+(b.name||'')+(b.code?' ['+b.code+']':'')+'</option>';}).join('');
      var bdOpt = '<option value="">— الكل —</option>' + _muBrands.map(function(b){return '<option value="'+b.id+'">'+(b.name||'')+'</option>';}).join('');
      var poOpt = '<option value="">— بدون —</option>' + _muPositions.map(function(p){return '<option value="'+p.id+'">'+(p.name||'')+'</option>';}).join('');
      // v6.18.1 — job titles dropdown grouped by rank for the SR.
      var jtOpt = '<option value="">— اختر —</option>' + _muJobTitles.map(function(j){
        return '<option value="'+j.code+'">'+(j.nameAr||j.nameEn||j.code)+' · '+(j.nameEn||'')+'</option>';
      }).join('');
      q('#muBranch').innerHTML = brOpt;
      q('#muBrand').innerHTML = bdOpt;
      q('#muPosition').innerHTML = poOpt;
      q('#muJobTitle').innerHTML = jtOpt;
      if (cb) cb();
    }
  }
  api.withSuccessHandler(function(list){ _muBranches = list || []; done(); }).getBranchesFull();
  api.withSuccessHandler(function(list){ _muBrands = list || []; done(); }).getBrands();
  api.withSuccessHandler(function(list){ _muPositions = list || []; done(); }).getWfPositions();
  // v6.18.1 — Fetch HR job titles directly (not yet in api-bridge).
  // Defensive: on any error (404, schema not migrated, network) fall
  // back to an empty list so the form still opens.
  fetch('/api/hr/job-titles', { credentials: 'include' })
    .then(function(r){ return r.json(); })
    .then(function(j){ _muJobTitles = (j && j.jobTitles) || []; done(); })
    .catch(function(){ _muJobTitles = []; done(); });
}

window.muTogglePass = function() {
  var el = q('#muPass'), eye = q('#muPassEye');
  if (el.type === 'password') { el.type = 'text'; eye.className = 'fas fa-eye-slash'; }
  else { el.type = 'password'; eye.className = 'fas fa-eye'; }
};

window.openUserForm = function() {
  _editingUsername = '';
  q('#userModalTitle').innerHTML = '<i class="fas fa-user-plus"></i> إضافة موظف جديد';
  q('#muDisplayName').value = '';
  q('#muName').value = '';
  q('#muName').disabled = false;
  q('#muNameHint').style.display = 'none';
  q('#muEmail').value = '';
  q('#muPhone').value = '';
  q('#muPass').value = '';
  q('#muPass').placeholder = '******';
  q('#muRole').value = 'cashier';
  q('#muIsDeveloper').checked = false;
  // v6.18.1 — reset the new HR people-record fields too
  if (q('#muIqama'))    q('#muIqama').value = '';
  if (q('#muIban'))     q('#muIban').value = '';
  _muLoadDropdowns(function() {
    q('#muBranch').value = ''; q('#muBrand').value = ''; q('#muPosition').value = '';
    if (q('#muJobTitle')) q('#muJobTitle').value = '';
  });
  openGlassModal('#modalUserForm');
};

window.editUser = function(username) {
  var u = _cachedUsers.find(function(x) { return x.username === username; });
  if (!u) return;
  _editingUsername = username;
  q('#userModalTitle').innerHTML = '<i class="fas fa-user-edit"></i> تعديل المستخدم — ' + (u.displayName || u.username);
  q('#muDisplayName').value = u.displayName || '';
  q('#muName').value = u.username;
  // Allow renaming for everyone except the sacred 'admin' user
  q('#muName').disabled = (username === 'admin');
  q('#muNameHint').style.display = (username === 'admin') ? 'none' : 'block';
  q('#muEmail').value = u.email || '';
  q('#muPhone').value = u.phone || '';
  q('#muPass').value = '';
  q('#muPass').placeholder = 'اتركها فارغة لعدم التغيير';
  q('#muRole').value = u.role || 'cashier';
  q('#muIsDeveloper').checked = !!u.isDeveloper;
  // v6.18.1 — pre-fill the new HR fields
  if (q('#muIqama')) q('#muIqama').value = u.iqamaNumber || '';
  if (q('#muIban'))  q('#muIban').value  = u.iban || '';
  _muLoadDropdowns(function() {
    q('#muBranch').value = u.branchId || '';
    q('#muBrand').value = u.brandId || '';
    q('#muPosition').value = u.positionId || '';
    if (q('#muJobTitle')) q('#muJobTitle').value = u.jobTitleCode || '';
  });
  openGlassModal('#modalUserForm');
};

window.saveUser = function() {
  var displayName = (q('#muDisplayName').value || '').trim();
  var username    = (q('#muName').value || '').trim();
  var password    = q('#muPass').value || '';
  var role        = q('#muRole').value || 'cashier';
  var isDeveloper = q('#muIsDeveloper').checked;
  var email       = (q('#muEmail').value || '').trim();
  var phone       = (q('#muPhone').value || '').trim();
  var brandId     = q('#muBrand').value || '';
  var branchId    = q('#muBranch').value || '';
  var positionId  = q('#muPosition').value || '';
  // v6.18.1 — read the new HR people-record fields
  var iqamaNumber  = (q('#muIqama')   ? q('#muIqama').value   : '').trim();
  var iban         = (q('#muIban')    ? q('#muIban').value    : '').trim().toUpperCase();
  var jobTitleCode = q('#muJobTitle') ? q('#muJobTitle').value : '';

  if (!username) return showToast('الرقم الوظيفي مطلوب', true);
  if (!_editingUsername && !password) return showToast('كلمة المرور مطلوبة عند إنشاء مستخدم', true);
  // v6.18.1 — Front-end mirror of the back-end format checks.  Wave 2
  // is "warning-only": empty values are accepted, only malformed ones
  // are rejected here so the user sees feedback before the round-trip.
  if (iqamaNumber && !/^\d{10}$/.test(iqamaNumber)) {
    return showToast('رقم الإقامة/الهوية يجب أن يكون 10 أرقام', true);
  }
  if (iban && !/^SA\d{22}$/.test(iban)) {
    return showToast('رقم الـIBAN يجب أن يبدأ بـSA و22 رقماً (إجمالي 24 خانة)', true);
  }

  loader(true);
  var done = function(r) {
    loader(false);
    if (r && r.success) {
      showToast(_editingUsername ? 'تم تحديث المستخدم' : 'تم إنشاء المستخدم بنجاح');
      closeGlassModal('#modalUserForm');
      loadUsers();
    } else {
      showToast((r && r.error) || 'فشل الحفظ', true);
    }
  };
  var fail = function(err) {
    loader(false);
    showToast(err.message || 'فشل الحفظ', true);
  };

  if (_editingUsername) {
    var payload = {
      displayName: displayName, role: role, isDeveloper: isDeveloper,
      email: email, phone: phone,
      brandId: brandId || null, branchId: branchId || null, positionId: positionId || null,
      // v6.18.1 — always send the new fields (empty string clears them server-side)
      iqamaNumber: iqamaNumber, iban: iban, jobTitleCode: jobTitleCode
    };
    if (password) payload.password = password;
    // Rename username if changed and allowed
    if (username && username !== _editingUsername && _editingUsername !== 'admin') {
      payload.newUsername = username;
    }
    api.withFailureHandler(fail).withSuccessHandler(done).updateUser(_editingUsername, payload);
  } else {
    var data = {
      username: username, password: password, role: role, displayName: displayName,
      isDeveloper: isDeveloper, email: email, phone: phone,
      brandId: brandId || null, branchId: branchId || null, positionId: positionId || null,
      // v6.18.1 — same four fields on create
      iqamaNumber: iqamaNumber, iban: iban, jobTitleCode: jobTitleCode
    };
    api.withFailureHandler(fail).withSuccessHandler(done).addUser(data);
  }
};

window.toggleUser = function(username) {
  loader(true);
  api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
     .withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) { showToast('تم التحديث'); loadUsers(); }
        else showToast((r && r.error) || 'فشل', true);
     }).toggleUserActive(username);
};

window.deleteUser = function(username) {
  glassConfirm('حذف المستخدم', 'تأكيد الحذف النهائي للمستخدم "' + username + '"؟', { danger: true, okText: 'حذف' }).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) { showToast('تم الحذف'); loadUsers(); }
          else showToast((r && r.error) || 'فشل الحذف', true);
       }).deleteUser(username);
  });
};

// ═══════════════════════════════════════════════════════════════
// v6.18.5 (Wave 6) — Per-user effective permissions modal
// ═══════════════════════════════════════════════════════════════
// Backend endpoints (GET / POST / DELETE /users/:username/permissions)
// expose role-default + per-user override semantics.  This modal
// renders the full permission catalog grouped by category, with a
// checkbox per row that the admin can toggle to override.  Sensitive
// permissions are highlighted; the row also shows whether each value
// comes from the user's role or from an explicit override.
var _permsModalUsername = '';
var _permsCategoryLabels = {
  pos: 'نقطة البيع', sales: 'المبيعات', inventory: 'المخزون',
  finance: 'المالية', hr: 'الموارد البشرية', workflow: 'سير العمل',
  admin: 'الإدارة', txn: 'المعاملات', purchases: 'المشتريات',
  warehouse: 'المستودع', reports: 'التقارير'
};

window.openUserPermsModal = function(username) {
  _permsModalUsername = username;
  // Build the modal lazily on first open so the markup doesn't bloat
  // the initial page weight.
  var modal = document.getElementById('modalUserPerms');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalUserPerms';
    modal.className = 'glass-modal hidden';
    modal.innerHTML =
      '<div class="glass-modal-content" style="max-width:780px;max-height:90dvh;display:flex;flex-direction:column;">' +
        '<div class="glass-modal-title">' +
          '<span><i class="fas fa-shield-halved"></i> صلاحيات المستخدم — <span id="permsUserLabel" style="color:#0d9488;"></span></span>' +
          '<button class="glass-modal-close" onclick="closeGlassModal(\'#modalUserPerms\')" aria-label="إغلاق">&times;</button>' +
        '</div>' +
        '<div class="glass-modal-body" id="permsModalBody" style="flex:1;overflow-y:auto;">' +
          '<div style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>' +
        '</div>' +
        '<div class="glass-modal-actions">' +
          '<button class="btn btn-light" onclick="closeGlassModal(\'#modalUserPerms\')">إغلاق</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
  }
  document.getElementById('permsUserLabel').textContent = username;
  openGlassModal('#modalUserPerms');
  _loadUserPerms(username);
};

function _loadUserPerms(username) {
  var body = document.getElementById('permsModalBody');
  body.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
  fetch('/api/auth/users/' + encodeURIComponent(username) + '/permissions', { credentials: 'include' })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j || !j.success) {
        body.innerHTML = '<div style="text-align:center;padding:30px;color:#dc2626;">' + ((j && j.error) || 'فشل التحميل') + '</div>';
        return;
      }
      _renderPermsList(j);
    })
    .catch(function(err){
      body.innerHTML = '<div style="text-align:center;padding:30px;color:#dc2626;">خطأ: ' + (err.message || err) + '</div>';
    });
}

function _renderPermsList(data) {
  var body = document.getElementById('permsModalBody');
  // Group by category preserving order.
  var groups = {};
  var order = [];
  (data.permissions || []).forEach(function(p) {
    if (!groups[p.category]) { groups[p.category] = []; order.push(p.category); }
    groups[p.category].push(p);
  });
  var html = '<div style="background:#f0f9ff;border:1px solid #bae6fd;padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:12px;color:#075985;line-height:1.7;">' +
    '<i class="fas fa-info-circle"></i> ' +
    'الدور الافتراضي: <b style="color:#0d9488;">' + (data.role||'—') + '</b>. ' +
    'الصلاحيات المُؤشَّرة فعّالة الآن. ' +
    'فك التأشير = منع (revoke override). تأشير صلاحية ليست من الدور = منح (grant override). ' +
    'الصلاحيات الحساسة <i class="fas fa-triangle-exclamation" style="color:#dc2626;"></i> تحتاج حذراً إضافياً.' +
  '</div>';
  html += order.map(function(cat) {
    var label = _permsCategoryLabels[cat] || cat;
    var perms = groups[cat];
    return '<details open style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px;">' +
      '<summary style="font-weight:800;color:#0f172a;cursor:pointer;padding:4px 0;">' +
        '<i class="fas fa-folder-open" style="color:#0d9488;"></i> ' + label +
        ' <span style="color:#94a3b8;font-weight:600;font-size:11px;">(' + perms.length + ')</span>' +
      '</summary>' +
      '<div style="margin-top:8px;">' +
        perms.map(function(p) {
          var checked = p.effective ? 'checked' : '';
          var sourceBadge = p.override === 'grant'
            ? ' <span style="background:#dcfce7;color:#166534;font-size:9px;padding:1px 6px;border-radius:6px;font-weight:700;">منح إضافي</span>'
            : p.override === 'revoke'
              ? ' <span style="background:#fee2e2;color:#991b1b;font-size:9px;padding:1px 6px;border-radius:6px;font-weight:700;">منع</span>'
              : (p.byRole
                  ? ' <span style="background:#dbeafe;color:#1e40af;font-size:9px;padding:1px 6px;border-radius:6px;font-weight:700;">من الدور</span>'
                  : '');
          var sensitiveIcon = p.isSensitive ? ' <i class="fas fa-triangle-exclamation" style="color:#dc2626;font-size:10px;" title="صلاحية حساسة"></i>' : '';
          return '<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #f1f5f9;cursor:pointer;">' +
            '<input type="checkbox" ' + checked + ' onchange="_togglePermOverride(\'' + p.id + '\', this.checked, ' + (p.byRole?1:0) + ')" data-perm-id="' + p.id + '">' +
            '<span style="flex:1;font-size:13px;color:#1e293b;">' + (p.labelAr||p.id) + sensitiveIcon + '</span>' +
            '<span><code style="font-size:10px;color:#64748b;">' + p.id + '</code>' + sourceBadge + '</span>' +
          '</label>';
        }).join('') +
      '</div>' +
    '</details>';
  }).join('');
  body.innerHTML = html;
}

window._togglePermOverride = function(permId, isChecked, byRole) {
  var username = _permsModalUsername;
  // Determine the action that maps user intent to a backend call:
  //   role=YES, now unchecked → POST revoke
  //   role=YES, now checked   → DELETE override (back to role default)
  //   role=NO,  now checked   → POST grant
  //   role=NO,  now unchecked → DELETE override (back to no-grant)
  var url = '/api/auth/users/' + encodeURIComponent(username) + '/permissions/' + encodeURIComponent(permId);
  var method, requestBody = null;
  var byRoleBool = !!byRole;
  if (isChecked && !byRoleBool) {
    method = 'POST'; requestBody = JSON.stringify({ grantType: 'grant' });
  } else if (!isChecked && byRoleBool) {
    method = 'POST'; requestBody = JSON.stringify({ grantType: 'revoke' });
  } else {
    // Either checked-and-was-role, or unchecked-and-not-role → no override needed.
    method = 'DELETE';
  }
  var opts = { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
  if (requestBody) opts.body = requestBody;
  fetch(url, opts)
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j || !j.success) {
        showToast((j && j.error) || 'فشل التحديث', true);
        // Reload to recover the true server state on failure
        _loadUserPerms(username);
        return;
      }
      // Re-render so the source badges update without the user
      // having to close/reopen the modal.
      _loadUserPerms(username);
    })
    .catch(function(err){
      showToast(err.message || 'خطأ', true);
      _loadUserPerms(username);
    });
};
