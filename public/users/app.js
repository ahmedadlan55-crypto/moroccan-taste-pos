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
            '<button class="btn-toggle" onclick="toggleUser(\'' + u.username + '\')" title="تفعيل / إيقاف"><i class="fas fa-power-off"></i></button>' +
            '<button class="btn-del"    onclick="deleteUser(\'' + u.username + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }).getUsers();
};

// Load branches, brands, positions for the dropdowns (cached after first call)
var _muBranches = null, _muBrands = null, _muPositions = null;
function _muLoadDropdowns(cb) {
  function done() {
    if (_muBranches && _muBrands && _muPositions) {
      var brOpt = '<option value="">— بدون —</option>' + _muBranches.map(function(b){return '<option value="'+b.id+'">'+(b.name||'')+(b.code?' ['+b.code+']':'')+'</option>';}).join('');
      var bdOpt = '<option value="">— الكل —</option>' + _muBrands.map(function(b){return '<option value="'+b.id+'">'+(b.name||'')+'</option>';}).join('');
      var poOpt = '<option value="">— بدون —</option>' + _muPositions.map(function(p){return '<option value="'+p.id+'">'+(p.name||'')+'</option>';}).join('');
      q('#muBranch').innerHTML = brOpt;
      q('#muBrand').innerHTML = bdOpt;
      q('#muPosition').innerHTML = poOpt;
      if (cb) cb();
    }
  }
  api.withSuccessHandler(function(list){ _muBranches = list || []; done(); }).getBranchesFull();
  api.withSuccessHandler(function(list){ _muBrands = list || []; done(); }).getBrands();
  api.withSuccessHandler(function(list){ _muPositions = list || []; done(); }).getWfPositions();
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
  _muLoadDropdowns(function() {
    q('#muBranch').value = ''; q('#muBrand').value = ''; q('#muPosition').value = '';
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
  _muLoadDropdowns(function() {
    q('#muBranch').value = u.branchId || '';
    q('#muBrand').value = u.brandId || '';
    q('#muPosition').value = u.positionId || '';
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

  if (!username) return showToast('الرقم الوظيفي مطلوب', true);
  if (!_editingUsername && !password) return showToast('كلمة المرور مطلوبة عند إنشاء مستخدم', true);

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
      brandId: brandId || null, branchId: branchId || null, positionId: positionId || null
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
      brandId: brandId || null, branchId: branchId || null, positionId: positionId || null
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
