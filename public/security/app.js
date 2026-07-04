'use strict';
/* Security → Change Password page logic. Uses the shared pos_token; never stores
   any password in browser storage; enforces the same policy the server enforces
   so the user gets instant feedback. English digits only. */
(function () {
  var token = localStorage.getItem('pos_token');
  var params = new URLSearchParams(location.search);
  var redirect = params.get('redirect') || '/';
  if (params.get('must') === '1') document.getElementById('mustBanner').style.display = 'block';
  document.getElementById('backLink').setAttribute('href', redirect);
  if (!token) { location.href = '/?next=' + encodeURIComponent('/security/'); return; }

  var SPECIAL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/;
  var COMMON = ['admin123', 'admin', 'password', '123456', 'changeme', 'qwerty', 'welcome', 'p@ssw0rd', 'admin@123'];
  var cur = document.getElementById('cur'), nw = document.getElementById('nw'), cf = document.getElementById('cf');
  var btn = document.getElementById('submitBtn'), msg = document.getElementById('msg'), bar = document.getElementById('meterBar');

  function checks(pw) {
    return {
      len: pw.length >= 12,
      letter: /[a-zA-Z؀-ۿ]/.test(pw),
      digit: /[0-9]/.test(pw),
      special: SPECIAL.test(pw),
      notcommon: pw.length > 0 && COMMON.indexOf(pw.toLowerCase().trim()) === -1,
    };
  }
  function strength(pw) {
    var s = 0;
    if (pw.length >= 12) s++;
    if (pw.length >= 16) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/[0-9]/.test(pw) && SPECIAL.test(pw)) s++;
    if (COMMON.indexOf(pw.toLowerCase().trim()) !== -1) s = 0;
    return Math.min(4, s);
  }
  function render() {
    var pw = nw.value, c = checks(pw), allReq = Object.keys(c).every(function (k) { return c[k]; });
    Object.keys(c).forEach(function (k) {
      var li = document.querySelector('.reqs li[data-k="' + k + '"]');
      if (!li) return;
      li.classList.toggle('ok', c[k]);
      li.querySelector('i').className = c[k] ? 'fas fa-circle-check' : 'fas fa-circle';
    });
    var st = strength(pw), colors = ['#e11d48', '#f59e0b', '#f59e0b', '#10b981', '#10b981'];
    bar.style.width = (pw ? (st + 1) * 20 : 0) + '%';
    bar.style.background = colors[st];
    var match = cf.value.length > 0 && cf.value === nw.value;
    btn.disabled = !(cur.value.length > 0 && allReq && match);
  }
  [cur, nw, cf].forEach(function (el) { el.addEventListener('input', render); });

  Array.prototype.forEach.call(document.querySelectorAll('.toggle'), function (t) {
    t.addEventListener('click', function () {
      var f = document.getElementById(t.getAttribute('data-for'));
      f.type = f.type === 'password' ? 'text' : 'password';
      t.querySelector('i').className = f.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
    });
  });

  function show(kind, text) { msg.className = 'msg ' + kind; msg.textContent = text; }

  document.getElementById('pwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (cf.value !== nw.value) { show('err', 'التأكيد لا يطابق كلمة المرور الجديدة'); return; }
    btn.disabled = true;
    fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ currentPassword: cur.value, newPassword: nw.value }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.j && res.j.success) {
          if (res.j.token) localStorage.setItem('pos_token', res.j.token); // keep THIS session signed in
          show('ok', 'تم تغيير كلمة المرور بنجاح. سيتم تحويلك…');
          cur.value = nw.value = cf.value = '';
          setTimeout(function () { location.href = redirect; }, 1400);
        } else {
          show('err', (res.j && res.j.error) || 'تعذّر تغيير كلمة المرور');
          btn.disabled = false;
        }
      }).catch(function () { show('err', 'خطأ في الاتصال'); btn.disabled = false; });
  });
})();
