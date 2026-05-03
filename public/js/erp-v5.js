/**
 * ERP V5 — Frontend modules (Real-Estate / Contracts / Work-Orders / AP-AR / Matrix / Anomalies)
 * Loads on top of erp.js, depends on WoModal (wo-modal.js).
 *
 * Renders into target nodes by section name. Public entry points:
 *   ERPv5.render(section, container)
 *     section ∈ ['properties','contracts','work-orders','ap','ar','matrix','anomalies','budgets']
 */
(function(global){
  'use strict';
  const API = (path)=>fetch('/api'+path, {
    headers: {'X-User': (global.currentUser&&global.currentUser.username)||'admin'}
  }).then(r=>r.json());
  const POST = (path, body)=>fetch('/api'+path, {
    method:'POST',
    headers:{'Content-Type':'application/json','X-User':(global.currentUser&&global.currentUser.username)||'admin'},
    body: JSON.stringify(body||{})
  }).then(r=>r.json());
  const PUT = (path, body)=>fetch('/api'+path, {
    method:'PUT',
    headers:{'Content-Type':'application/json','X-User':(global.currentUser&&global.currentUser.username)||'admin'},
    body: JSON.stringify(body||{})
  }).then(r=>r.json());
  const DEL = (path)=>fetch('/api'+path, {
    method:'DELETE',
    headers:{'X-User':(global.currentUser&&global.currentUser.username)||'admin'}
  }).then(r=>r.json());

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function _money(n,c){ const v = parseFloat(n||0); return v.toLocaleString('ar-SA',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' ' + (c||'ر.س'); }
  function _date(d){ if(!d) return '—'; try { return new Date(d).toLocaleDateString('ar-SA'); } catch(e) { return d; } }
  function _statusBadge(s, map){
    const labels = map || {};
    const def = labels[s] || {label:s, kind:'neutral'};
    return `<span class="v5-badge v5-badge-${def.kind}">${_esc(def.label)}</span>`;
  }
  function _styles(){
    if (document.getElementById('erp-v5-styles')) return;
    const s = document.createElement('style');
    s.id = 'erp-v5-styles';
    s.textContent = `
      .v5-section{padding:20px;direction:rtl;font-family:'Tajawal',sans-serif;}
      .v5-toolbar{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
      .v5-toolbar .grow{flex:1;min-width:200px;}
      .v5-toolbar input,.v5-toolbar select{padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;font-family:inherit;}
      .v5-toolbar input:focus,.v5-toolbar select:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}
      .v5-btn{padding:8px 16px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit;color:#334155;transition:all .15s;}
      .v5-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08);}
      .v5-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}
      .v5-btn.primary:hover{background:#1d4ed8;}
      .v5-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626;}
      .v5-btn.success{background:#16a34a;color:#fff;border-color:#16a34a;}
      .v5-btn.ghost{background:transparent;border-color:transparent;}
      .v5-btn.ghost:hover{background:#f1f5f9;}
      .v5-btn.sm{padding:5px 10px;font-size:12px;}
      .v5-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px;}
      .v5-stat{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:all .2s;}
      .v5-stat:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.08);border-color:#cbd5e1;}
      .v5-stat-label{font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
      .v5-stat-value{font-size:24px;font-weight:800;color:#0f172a;line-height:1.1;}
      .v5-stat-value.success{color:#15803d;}
      .v5-stat-value.warning{color:#b45309;}
      .v5-stat-value.danger{color:#b91c1c;}
      .v5-stat-value.info{color:#1d4ed8;}
      .v5-stat-trend{font-size:12px;color:#64748b;margin-top:4px;}
      .v5-table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;font-size:13px;}
      .v5-table thead th{background:#f8fafc;padding:11px 12px;text-align:right;font-weight:700;color:#475569;font-size:12px;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #e2e8f0;}
      .v5-table tbody td{padding:11px 12px;border-bottom:1px solid #f1f5f9;color:#334155;}
      .v5-table tbody tr:hover{background:#f8fafc;}
      .v5-table tbody tr:last-child td{border-bottom:0;}
      .v5-table .actions{display:flex;gap:4px;justify-content:flex-end;}
      .v5-empty{text-align:center;padding:48px 24px;color:#64748b;}
      .v5-empty i{font-size:48px;color:#cbd5e1;margin-bottom:12px;display:block;}
      .v5-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;}
      .v5-badge-success{background:#d1fae5;color:#065f46;}
      .v5-badge-warning{background:#fef3c7;color:#92400e;}
      .v5-badge-danger {background:#fee2e2;color:#991b1b;}
      .v5-badge-info   {background:#dbeafe;color:#1e40af;}
      .v5-badge-purple {background:#ede9fe;color:#5b21b6;}
      .v5-badge-neutral{background:#f1f5f9;color:#475569;}
      .v5-form{display:grid;gap:14px;}
      .v5-form .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
      .v5-form .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
      .v5-form label{font-size:12px;font-weight:700;color:#334155;display:block;margin-bottom:5px;}
      .v5-form input,.v5-form select,.v5-form textarea{width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13px;font-family:inherit;direction:rtl;}
      .v5-form input:focus,.v5-form select:focus,.v5-form textarea:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}
      .v5-form textarea{min-height:80px;resize:vertical;}
      .v5-amount{font-variant-numeric:tabular-nums;font-weight:600;}
      .v5-aging-table th, .v5-aging-table td{text-align:center;}
      .v5-aging-pos{color:#b45309;font-weight:700;}
      .v5-skel{background:linear-gradient(90deg,#f1f5f9 0%,#e2e8f0 50%,#f1f5f9 100%);background-size:200% 100%;animation:v5-skel 1.5s infinite;border-radius:8px;height:14px;width:80%;}
      @keyframes v5-skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
      @media(max-width:768px){
        .v5-form .row,.v5-form .row3{grid-template-columns:1fr;}
        .v5-table{font-size:12px;}
        .v5-table thead th,.v5-table tbody td{padding:8px;}
      }`;
    document.head.appendChild(s);
  }

  // ───────── PROPERTIES ─────────────────────────────────────────────────
  async function renderProperties(container){
    _styles();
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;">العقارات والوحدات</h2>
      <div class="v5-stats" id="propStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <input type="text" placeholder="بحث..." id="propSearch" class="grow"/>
        <select id="propStatus"><option value="">كل الحالات</option><option value="active">نشط</option><option value="inactive">غير نشط</option></select>
        <button class="v5-btn primary" onclick="ERPv5.openPropertyForm()"><i class="fas fa-plus"></i> عقار جديد</button>
      </div>
      <div id="propList"><div class="v5-skel"></div></div>
    </div>`;
    try {
      const stats = await API('/properties/dashboard');
      document.getElementById('propStats').innerHTML = `
        <div class="v5-stat"><div class="v5-stat-label">عقارات</div><div class="v5-stat-value info">${stats.properties.total||0}</div><div class="v5-stat-trend">${stats.properties.active||0} نشط</div></div>
        <div class="v5-stat"><div class="v5-stat-label">وحدات</div><div class="v5-stat-value">${stats.units.total||0}</div><div class="v5-stat-trend">${stats.units.occupied||0} مؤجرة • ${stats.units.vacant||0} شاغرة</div></div>
        <div class="v5-stat"><div class="v5-stat-label">إيراد شهري</div><div class="v5-stat-value success">${_money(stats.units.monthly_revenue)}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">عقود نشطة</div><div class="v5-stat-value purple">${stats.contracts.active_count||0}</div></div>`;
    } catch(e){}
    await loadPropList();

    document.getElementById('propSearch').addEventListener('input', _debounce(loadPropList, 300));
    document.getElementById('propStatus').addEventListener('change', loadPropList);
  }
  async function loadPropList(){
    const q = (document.getElementById('propSearch')||{}).value || '';
    const status = (document.getElementById('propStatus')||{}).value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const rows = await API('/properties?'+params);
    const el = document.getElementById('propList');
    if (!rows.length) {
      el.innerHTML = `<div class="v5-empty"><i class="fas fa-building"></i><div>لا توجد عقارات. ابدأ بإضافة عقار جديد.</div></div>`;
      return;
    }
    el.innerHTML = `<table class="v5-table"><thead><tr>
      <th>الكود</th><th>اسم العقار</th><th>المدينة</th><th>وحدات</th><th>المؤجَّر</th><th>إيراد شهري</th><th>الحالة</th><th></th>
      </tr></thead><tbody>${rows.map(r=>`
        <tr>
          <td><strong>${_esc(r.code||'')}</strong></td>
          <td>${_esc(r.name)}</td>
          <td>${_esc(r.city||'—')}</td>
          <td>${r.units_total||0}</td>
          <td>${r.units_occupied||0}</td>
          <td class="v5-amount">${_money(r.monthly_revenue)}</td>
          <td>${_statusBadge(r.status, {active:{label:'نشط',kind:'success'}, inactive:{label:'غير نشط',kind:'neutral'}, sold:{label:'مباع',kind:'warning'}})}</td>
          <td class="actions">
            <button class="v5-btn sm ghost" onclick="ERPv5.openPropertyDetail('${r.id}')"><i class="fas fa-eye"></i></button>
            <button class="v5-btn sm ghost" onclick="ERPv5.openPropertyForm('${r.id}')"><i class="fas fa-pen"></i></button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }
  async function openPropertyForm(id){
    const data = id ? await API('/properties/'+id) : {};
    const m = WoModal.open({
      icon:'fa-building', iconKind:'info', size:'lg',
      title: id ? 'تعديل عقار' : 'عقار جديد',
      body: `<form class="v5-form" id="propForm">
        <div class="row">
          <div><label>الكود</label><input name="code" value="${_esc(data.code||'')}"/></div>
          <div><label>الاسم *</label><input name="name" value="${_esc(data.name||'')}" required/></div>
        </div>
        <div class="row3">
          <div><label>النوع</label><select name="type">
            <option value="commercial" ${data.type==='commercial'?'selected':''}>تجاري</option>
            <option value="residential" ${data.type==='residential'?'selected':''}>سكني</option>
            <option value="mixed" ${data.type==='mixed'?'selected':''}>مختلط</option>
            <option value="land" ${data.type==='land'?'selected':''}>أرض</option>
            <option value="office" ${data.type==='office'?'selected':''}>مكتبي</option>
            <option value="warehouse" ${data.type==='warehouse'?'selected':''}>مستودع</option>
          </select></div>
          <div><label>المدينة</label><input name="city" value="${_esc(data.city||'')}"/></div>
          <div><label>الحي</label><input name="district" value="${_esc(data.district||'')}"/></div>
        </div>
        <div><label>العنوان</label><input name="address" value="${_esc(data.address||'')}"/></div>
        <div class="row">
          <div><label>المساحة (م²)</label><input type="number" name="total_area" value="${_esc(data.total_area||'')}" step="0.01"/></div>
          <div><label>تكلفة الاقتناء</label><input type="number" name="acquisition_cost" value="${_esc(data.acquisition_cost||0)}" step="0.01"/></div>
        </div>
        <div><label>ملاحظات</label><textarea name="notes">${_esc(data.notes||'')}</textarea></div>
      </form>`,
      footer: `<button class="wom-btn" data-act="cancel">إلغاء</button>
               <button class="wom-btn primary" id="propSave"><i class="fas fa-save"></i> حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#propSave').addEventListener('click', async ()=>{
      const f = m.overlay.querySelector('#propForm');
      const body = {};
      [...f.elements].forEach(el=>{ if(el.name) body[el.name] = el.value; });
      if (!body.name) { WoModal.toast({message:'الاسم مطلوب', kind:'danger'}); return; }
      try {
        const r = id ? await PUT('/properties/'+id, body) : await POST('/properties', body);
        if (r.success) {
          WoModal.toast({message:'تم الحفظ', kind:'success'});
          m.close(); loadPropList();
        } else WoModal.toast({message: r.error||'فشل الحفظ', kind:'danger'});
      } catch(e) { WoModal.toast({message:e.message, kind:'danger'}); }
    });
  }
  async function openPropertyDetail(id){
    const d = await API('/properties/'+id);
    const unitsHtml = (d.units||[]).length
      ? `<table class="v5-table" style="margin-top:8px;"><thead><tr><th>الرقم</th><th>النوع</th><th>المساحة</th><th>الإيجار</th><th>الحالة</th><th>المستأجر</th><th></th></tr></thead><tbody>
          ${(d.units||[]).map(u=>`<tr>
            <td>${_esc(u.unit_number||'—')}</td>
            <td>${_esc(u.type)}</td>
            <td>${u.area||'—'}</td>
            <td class="v5-amount">${_money(u.monthly_rent)}</td>
            <td>${_statusBadge(u.status,{vacant:{label:'شاغر',kind:'neutral'},occupied:{label:'مؤجَّر',kind:'success'},reserved:{label:'محجوز',kind:'warning'},maintenance:{label:'صيانة',kind:'warning'}})}</td>
            <td>${_esc(u.tenant_name||'—')}</td>
            <td><button class="v5-btn sm ghost" onclick="ERPv5.openUnitForm('${id}','${u.id}')"><i class="fas fa-pen"></i></button></td>
          </tr>`).join('')}
        </tbody></table>`
      : `<div class="v5-empty"><i class="fas fa-door-open"></i><div>لا توجد وحدات. أضف وحدة جديدة.</div></div>`;
    WoModal.open({
      icon:'fa-building', iconKind:'info', size:'xl',
      title: d.name + (d.code?' ('+d.code+')':''),
      subtitle: (d.city||'') + ' • ' + (d.district||''),
      body: `<div>
        <div class="v5-stats">
          <div class="v5-stat"><div class="v5-stat-label">المساحة</div><div class="v5-stat-value">${d.total_area||'—'} م²</div></div>
          <div class="v5-stat"><div class="v5-stat-label">عدد الوحدات</div><div class="v5-stat-value">${(d.units||[]).length}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">تكلفة الاقتناء</div><div class="v5-stat-value">${_money(d.acquisition_cost)}</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px;">
          <h4 style="margin:0;font-size:16px;">الوحدات</h4>
          <button class="v5-btn primary sm" onclick="ERPv5.openUnitForm('${id}')"><i class="fas fa-plus"></i> وحدة جديدة</button>
        </div>
        ${unitsHtml}
      </div>`,
      footer:`<button class="wom-btn" data-act="close">إغلاق</button>`
    });
  }
  async function openUnitForm(propId, uid){
    const data = uid ? (await API('/properties/'+propId)).units.find(u=>u.id===uid) || {} : {};
    const m = WoModal.open({
      icon:'fa-door-open', iconKind:'info', size:'lg',
      title: uid ? 'تعديل وحدة' : 'وحدة جديدة',
      body: `<form class="v5-form" id="unitForm">
        <div class="row3">
          <div><label>رقم الوحدة *</label><input name="unit_number" value="${_esc(data.unit_number||'')}" required/></div>
          <div><label>الطابق</label><input type="number" name="floor" value="${_esc(data.floor||0)}"/></div>
          <div><label>النوع</label><select name="type">
            ${['apartment','shop','office','warehouse','parking','other'].map(t=>`<option value="${t}" ${data.type===t?'selected':''}>${({apartment:'شقة',shop:'محل',office:'مكتب',warehouse:'مستودع',parking:'موقف',other:'أخرى'})[t]}</option>`).join('')}
          </select></div>
        </div>
        <div class="row3">
          <div><label>المساحة (م²)</label><input type="number" step="0.01" name="area" value="${_esc(data.area||'')}"/></div>
          <div><label>غرف نوم</label><input type="number" name="bedrooms" value="${_esc(data.bedrooms||0)}"/></div>
          <div><label>دورات مياه</label><input type="number" name="bathrooms" value="${_esc(data.bathrooms||0)}"/></div>
        </div>
        <div class="row">
          <div><label>الإيجار الشهري</label><input type="number" step="0.01" name="monthly_rent" value="${_esc(data.monthly_rent||'')}"/></div>
          <div><label>الحالة</label><select name="status">
            ${['vacant','occupied','reserved','maintenance','unavailable'].map(s=>`<option value="${s}" ${data.status===s?'selected':''}>${({vacant:'شاغر',occupied:'مؤجَّر',reserved:'محجوز',maintenance:'صيانة',unavailable:'غير متاح'})[s]}</option>`).join('')}
          </select></div>
        </div>
      </form>`,
      footer:`<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="unitSave">حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#unitSave').addEventListener('click', async ()=>{
      const body = {};
      [...m.overlay.querySelector('#unitForm').elements].forEach(el=>{ if(el.name) body[el.name] = el.value; });
      try {
        const r = uid ? await PUT('/properties/units/'+uid, body) : await POST('/properties/'+propId+'/units', body);
        if (r.success) { WoModal.toast({message:'تم الحفظ',kind:'success'}); m.close(); openPropertyDetail(propId); }
        else WoModal.toast({message:r.error||'فشل',kind:'danger'});
      } catch(e) { WoModal.toast({message:e.message,kind:'danger'}); }
    });
  }

  // ───────── CONTRACTS ─────────────────────────────────────────────────
  async function renderContracts(container){
    _styles();
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 16px;font-size:22px;font-weight:800;">العقود</h2>
      <div class="v5-stats" id="conStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <input type="text" placeholder="بحث..." id="conSearch" class="grow"/>
        <select id="conStatus"><option value="">كل الحالات</option><option value="draft">مسودة</option><option value="active">نشط</option><option value="expired">منتهي</option><option value="terminated">ملغى</option></select>
        <select id="conType"><option value="">كل الأنواع</option><option value="lease">إيجار</option><option value="service">خدمة</option><option value="supply">توريد</option><option value="employment">عمل</option></select>
        <button class="v5-btn primary" onclick="ERPv5.openContractForm()"><i class="fas fa-plus"></i> عقد جديد</button>
      </div>
      <div id="conList"><div class="v5-skel"></div></div>
    </div>`;
    try {
      const s = await API('/contracts/dashboard');
      document.getElementById('conStats').innerHTML = `
        <div class="v5-stat"><div class="v5-stat-label">إجمالي</div><div class="v5-stat-value">${s.total||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">نشطة</div><div class="v5-stat-value success">${s.active||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">قيمة نشطة (قسط)</div><div class="v5-stat-value info">${_money(s.active_value)}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">تنتهي قريباً (60 يوم)</div><div class="v5-stat-value warning">${s.expiring_soon||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">دفعات متأخرة الإصدار</div><div class="v5-stat-value danger">${s.overdue_schedules||0}</div></div>`;
    } catch(e){}
    await loadContractList();
    document.getElementById('conSearch').addEventListener('input', _debounce(loadContractList, 300));
    document.getElementById('conStatus').addEventListener('change', loadContractList);
    document.getElementById('conType').addEventListener('change', loadContractList);
  }
  async function loadContractList(){
    const q = (document.getElementById('conSearch')||{}).value||'';
    const status = (document.getElementById('conStatus')||{}).value||'';
    const type = (document.getElementById('conType')||{}).value||'';
    const params = new URLSearchParams();
    if (q) params.set('q',q); if (status) params.set('status',status); if (type) params.set('type',type);
    const rows = await API('/contracts?'+params);
    const el = document.getElementById('conList');
    if (!rows.length) { el.innerHTML = `<div class="v5-empty"><i class="fas fa-file-contract"></i><div>لا توجد عقود.</div></div>`; return; }
    el.innerHTML = `<table class="v5-table"><thead><tr>
      <th>الكود</th><th>العنوان</th><th>الطرف</th><th>النوع</th><th>القسط</th><th>التواريخ</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><strong>${_esc(r.code)}</strong></td>
        <td>${_esc(r.title)}</td>
        <td>${_esc(r.party_name||'—')}</td>
        <td>${_esc({lease:'إيجار',service:'خدمة',supply:'توريد',employment:'عمل'}[r.type]||r.type)}</td>
        <td class="v5-amount">${_money(r.payment_amount)}<br><small style="color:#94a3b8;">${({monthly:'شهري',quarterly:'ربعي',semi_annual:'نصف سنوي',annual:'سنوي',one_time:'مرة واحدة'})[r.payment_frequency]||r.payment_frequency}</small></td>
        <td><small>${_date(r.start_date)}<br>↳ ${_date(r.end_date)}</small></td>
        <td>${_statusBadge(r.status, {draft:{label:'مسودة',kind:'neutral'},active:{label:'نشط',kind:'success'},pending_approval:{label:'معلق',kind:'warning'},expired:{label:'منتهي',kind:'danger'},terminated:{label:'ملغى',kind:'danger'},renewed:{label:'مجدد',kind:'info'}})}</td>
        <td class="actions">
          <button class="v5-btn sm ghost" onclick="ERPv5.openContractDetail('${r.id}')"><i class="fas fa-eye"></i></button>
          ${r.status==='draft'?`<button class="v5-btn sm success" onclick="ERPv5.activateContract('${r.id}')"><i class="fas fa-play"></i></button>`:''}
          ${r.status==='active'?`<button class="v5-btn sm danger" onclick="ERPv5.terminateContract('${r.id}')"><i class="fas fa-ban"></i></button>`:''}
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  async function openContractForm(id){
    const data = id ? await API('/contracts/'+id) : {};
    const props = await API('/properties').catch(()=>[]);
    let unitsHtml = '<option value="">— اختر عقاراً أولاً —</option>';
    if (data.property_id) {
      const pd = await API('/properties/'+data.property_id).catch(()=>({units:[]}));
      unitsHtml = '<option value="">—</option>' + (pd.units||[]).map(u=>`<option value="${u.id}" ${data.property_unit_id===u.id?'selected':''}>${_esc(u.unit_number)} (${_money(u.monthly_rent)})</option>`).join('');
    }
    const m = WoModal.open({
      icon:'fa-file-contract', iconKind:'purple', size:'xl',
      title: id?'تعديل عقد':'عقد جديد',
      body: `<form class="v5-form" id="conForm">
        <div class="row3">
          <div><label>عنوان العقد *</label><input name="title" value="${_esc(data.title||'')}" required/></div>
          <div><label>الكود</label><input name="code" value="${_esc(data.code||'')}"/></div>
          <div><label>النوع</label><select name="type">
            ${['lease','service','supply','employment','franchise','partnership'].map(t=>`<option value="${t}" ${data.type===t?'selected':''}>${({lease:'إيجار',service:'خدمة',supply:'توريد',employment:'عمل',franchise:'امتياز',partnership:'شراكة'})[t]}</option>`).join('')}
          </select></div>
        </div>
        <div class="row3">
          <div><label>الطرف الآخر *</label><input name="party_name" value="${_esc(data.party_name||'')}" required/></div>
          <div><label>الاتجاه</label><select name="direction">
            <option value="outgoing" ${data.direction==='outgoing'?'selected':''}>صادر منا</option>
            <option value="incoming" ${data.direction==='incoming'?'selected':''}>وارد إلينا</option>
          </select></div>
          <div><label>نوع الطرف</label><select name="party_type">
            <option value="customer" ${data.party_type==='customer'?'selected':''}>عميل</option>
            <option value="vendor" ${data.party_type==='vendor'?'selected':''}>مورد</option>
            <option value="employee" ${data.party_type==='employee'?'selected':''}>موظف</option>
            <option value="partner" ${data.party_type==='partner'?'selected':''}>شريك</option>
          </select></div>
        </div>
        <div class="row">
          <div><label>العقار (لعقود الإيجار)</label><select name="property_id" id="conProp"><option value="">—</option>${(props||[]).map(p=>`<option value="${p.id}" ${data.property_id===p.id?'selected':''}>${_esc(p.name)}</option>`).join('')}</select></div>
          <div><label>الوحدة</label><select name="property_unit_id" id="conUnit">${unitsHtml}</select></div>
        </div>
        <div class="row3">
          <div><label>تاريخ البداية *</label><input type="date" name="start_date" value="${_esc(data.start_date||'')}" required/></div>
          <div><label>تاريخ الانتهاء</label><input type="date" name="end_date" value="${_esc(data.end_date||'')}"/></div>
          <div><label>تجديد تلقائي</label><select name="auto_renew">
            <option value="0">لا</option>
            <option value="1" ${data.auto_renew?'selected':''}>نعم</option>
          </select></div>
        </div>
        <div class="row3">
          <div><label>الدورية</label><select name="payment_frequency">
            ${['monthly','quarterly','semi_annual','annual','one_time'].map(f=>`<option value="${f}" ${data.payment_frequency===f?'selected':''}>${({monthly:'شهري',quarterly:'ربعي',semi_annual:'نصف سنوي',annual:'سنوي',one_time:'مرة واحدة'})[f]}</option>`).join('')}
          </select></div>
          <div><label>قيمة القسط *</label><input type="number" step="0.01" name="payment_amount" value="${_esc(data.payment_amount||'')}" required/></div>
          <div><label>القيمة الإجمالية</label><input type="number" step="0.01" name="total_value" value="${_esc(data.total_value||0)}"/></div>
        </div>
        <div><label>الوصف</label><textarea name="description">${_esc(data.description||'')}</textarea></div>
        <div><label>الشروط</label><textarea name="terms">${_esc(data.terms||'')}</textarea></div>
      </form>`,
      footer: `<button class="wom-btn" data-act="cancel">إلغاء</button>
               <button class="wom-btn primary" id="conSave"><i class="fas fa-save"></i> حفظ مسودة</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#conProp').addEventListener('change', async (e)=>{
      const sel = m.overlay.querySelector('#conUnit');
      sel.innerHTML = '<option value="">—</option>';
      if (!e.target.value) return;
      const pd = await API('/properties/'+e.target.value);
      sel.innerHTML += (pd.units||[]).map(u=>`<option value="${u.id}">${_esc(u.unit_number)} (${_money(u.monthly_rent)})</option>`).join('');
    });
    m.overlay.querySelector('#conSave').addEventListener('click', async ()=>{
      const f = m.overlay.querySelector('#conForm');
      const body = {};
      [...f.elements].forEach(el=>{ if(el.name) body[el.name] = el.name==='auto_renew'?(el.value==='1'):el.value; });
      try {
        const r = id ? await PUT('/contracts/'+id, body) : await POST('/contracts', body);
        if (r.success) { WoModal.toast({message:id?'تم التحديث':'تم إنشاء العقد كمسودة',kind:'success'}); m.close(); loadContractList(); }
        else WoModal.toast({message:r.error||'فشل',kind:'danger'});
      } catch(e){ WoModal.toast({message:e.message,kind:'danger'}); }
    });
  }
  async function openContractDetail(id){
    const d = await API('/contracts/'+id);
    WoModal.open({
      icon:'fa-file-contract', iconKind:'purple', size:'xl',
      title: d.title, subtitle: d.code,
      body: `<div>
        <div class="v5-stats">
          <div class="v5-stat"><div class="v5-stat-label">القسط</div><div class="v5-stat-value">${_money(d.payment_amount)}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">الدورية</div><div class="v5-stat-value">${({monthly:'شهري',quarterly:'ربعي',annual:'سنوي'})[d.payment_frequency]||d.payment_frequency}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">من</div><div class="v5-stat-value" style="font-size:14px">${_date(d.start_date)}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">إلى</div><div class="v5-stat-value" style="font-size:14px">${_date(d.end_date)}</div></div>
        </div>
        <h4 style="margin:14px 0 8px;">جدولة الفواتير (${(d.schedule||[]).length})</h4>
        ${(d.schedule||[]).length?`<table class="v5-table"><thead><tr><th>تاريخ الاستحقاق</th><th>الفترة</th><th>المبلغ</th><th>الإجمالي مع الضريبة</th><th>الحالة</th><th></th></tr></thead><tbody>
          ${d.schedule.map(s=>`<tr>
            <td>${_date(s.due_date)}</td>
            <td><small>${_date(s.period_from)} → ${_date(s.period_to)}</small></td>
            <td class="v5-amount">${_money(s.amount)}</td>
            <td class="v5-amount">${_money(s.total_amount)}</td>
            <td>${_statusBadge(s.status,{scheduled:{label:'مجدول',kind:'neutral'},invoiced:{label:'مفوتر',kind:'info'},paid:{label:'مدفوع',kind:'success'},overdue:{label:'متأخر',kind:'danger'},cancelled:{label:'ملغى',kind:'neutral'}})}</td>
            <td>${s.status==='scheduled'?`<button class="v5-btn sm primary" onclick="ERPv5.spawnInv('${s.id}','${id}')">إنشاء فاتورة</button>`:''}</td>
          </tr>`).join('')}
        </tbody></table>`:`<div class="v5-empty"><i class="fas fa-calendar-xmark"></i><div>لا توجد جدولة. فعّل العقد لتوليد الجدولة تلقائياً.</div></div>`}
      </div>`,
      footer: `<button class="wom-btn" data-act="close">إغلاق</button>`
    });
  }
  async function activateContract(id){
    const ok = await WoModal.confirm({title:'تفعيل العقد',message:'سيتم توليد جدول الفواتير + ربط الوحدة. هل تريد المتابعة؟',confirmText:'تفعيل'});
    if (!ok) return;
    const r = await POST('/contracts/'+id+'/activate', {});
    if (r.success) { WoModal.toast({message:'تم التفعيل',kind:'success'}); loadContractList(); }
    else WoModal.alert({title:'فشل',message:r.error,kind:'danger'});
  }
  async function terminateContract(id){
    const reason = await WoModal.prompt({title:'إلغاء العقد',label:'سبب الإلغاء',placeholder:'مطلوب'});
    if (reason===null) return;
    const r = await POST('/contracts/'+id+'/terminate', {reason});
    if (r.success) { WoModal.toast({message:'تم إلغاء العقد',kind:'success'}); loadContractList(); }
    else WoModal.alert({title:'فشل',message:r.error,kind:'danger'});
  }
  async function spawnInv(sid, cid){
    const r = await POST('/contracts/schedules/'+sid+'/spawn-invoice', {});
    if (r.success) {
      WoModal.toast({message:'تم إصدار فاتورة '+r.code,kind:'success'});
      openContractDetail(cid);
    } else WoModal.alert({title:'فشل',message:r.error,kind:'danger'});
  }

  // ───────── WORK ORDERS ─────────────────────────────────────────────────
  async function renderWorkOrders(container){
    _styles();
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 16px;">أوامر العمل والصيانة</h2>
      <div class="v5-stats" id="woStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <input type="text" placeholder="بحث..." id="woSearch" class="grow"/>
        <select id="woStatus"><option value="">كل الحالات</option><option value="open">مفتوح</option><option value="assigned">مُعيَّن</option><option value="in_progress">قيد التنفيذ</option><option value="completed">مكتمل</option><option value="closed">مغلق</option></select>
        <select id="woPri"><option value="">كل الأولويات</option><option value="critical">حرج</option><option value="high">عالي</option><option value="normal">عادي</option><option value="low">منخفض</option></select>
        <button class="v5-btn primary" onclick="ERPv5.openWoForm()"><i class="fas fa-plus"></i> أمر جديد</button>
        <button class="v5-btn" onclick="ERPv5.openAssetsList()"><i class="fas fa-cube"></i> الأصول</button>
      </div>
      <div id="woList"><div class="v5-skel"></div></div>
    </div>`;
    try {
      const s = await API('/work-orders/dashboard');
      document.getElementById('woStats').innerHTML = `
        <div class="v5-stat"><div class="v5-stat-label">مفتوحة</div><div class="v5-stat-value warning">${s.open_count||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">قيد التنفيذ</div><div class="v5-stat-value info">${s.in_progress||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">حرجة</div><div class="v5-stat-value danger">${s.critical_open||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">متأخرة</div><div class="v5-stat-value danger">${s.overdue||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">إجمالي التكاليف</div><div class="v5-stat-value">${_money(s.total_cost)}</div></div>`;
    } catch(e){}
    await loadWoList();
    document.getElementById('woSearch').addEventListener('input', _debounce(loadWoList, 300));
    document.getElementById('woStatus').addEventListener('change', loadWoList);
    document.getElementById('woPri').addEventListener('change', loadWoList);
  }
  async function loadWoList(){
    const q = (document.getElementById('woSearch')||{}).value||'';
    const status = (document.getElementById('woStatus')||{}).value||'';
    const priority = (document.getElementById('woPri')||{}).value||'';
    const params = new URLSearchParams();
    if (q) params.set('q',q); if (status) params.set('status',status); if (priority) params.set('priority',priority);
    const rows = await API('/work-orders?'+params);
    const el = document.getElementById('woList');
    if (!rows.length) { el.innerHTML = `<div class="v5-empty"><i class="fas fa-screwdriver-wrench"></i><div>لا توجد أوامر عمل.</div></div>`; return; }
    const priMap = {critical:{label:'حرج',kind:'danger'},high:{label:'عالي',kind:'warning'},normal:{label:'عادي',kind:'info'},low:{label:'منخفض',kind:'neutral'}};
    const stMap = {open:{label:'مفتوح',kind:'neutral'},assigned:{label:'مُعيَّن',kind:'info'},in_progress:{label:'قيد التنفيذ',kind:'warning'},on_hold:{label:'موقوف',kind:'neutral'},completed:{label:'مكتمل',kind:'success'},closed:{label:'مغلق',kind:'success'},cancelled:{label:'ملغى',kind:'neutral'}};
    el.innerHTML = `<table class="v5-table"><thead><tr>
      <th>الكود</th><th>العنوان</th><th>الأولوية</th><th>المسؤول</th><th>الأصل</th><th>التكلفة</th><th>الاستحقاق</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><strong>${_esc(r.code||'')}</strong></td>
        <td>${_esc(r.title)}</td>
        <td>${_statusBadge(r.priority, priMap)}</td>
        <td>${_esc(r.assigned_to||'—')}</td>
        <td>${_esc(r.asset_name||'—')}</td>
        <td class="v5-amount">${_money(r.total_cost)}</td>
        <td>${_date(r.due_date)}</td>
        <td>${_statusBadge(r.status, stMap)}</td>
        <td class="actions"><button class="v5-btn sm ghost" onclick="ERPv5.openWoDetail('${r.id}')"><i class="fas fa-eye"></i></button></td>
      </tr>`).join('')}</tbody></table>`;
  }
  async function openWoForm(id){
    const data = id ? await API('/work-orders/'+id) : {};
    const assets = await API('/work-orders/assets').catch(()=>[]);
    const m = WoModal.open({
      icon:'fa-screwdriver-wrench', iconKind:'warning', size:'lg',
      title: id?'تعديل أمر عمل':'أمر عمل جديد',
      body: `<form class="v5-form" id="woForm">
        <div><label>العنوان *</label><input name="title" value="${_esc(data.title||'')}" required/></div>
        <div class="row3">
          <div><label>النوع</label><select name="type">
            ${['maintenance','operational','installation','inspection','repair','cleaning'].map(t=>`<option value="${t}" ${data.type===t?'selected':''}>${({maintenance:'صيانة',operational:'تشغيلي',installation:'تركيب',inspection:'فحص',repair:'إصلاح',cleaning:'تنظيف'})[t]}</option>`).join('')}
          </select></div>
          <div><label>الأولوية</label><select name="priority">
            ${['low','normal','high','critical'].map(p=>`<option value="${p}" ${data.priority===p?'selected':''}>${({low:'منخفض',normal:'عادي',high:'عالي',critical:'حرج'})[p]}</option>`).join('')}
          </select></div>
          <div><label>الاستحقاق</label><input type="date" name="due_date" value="${_esc(data.due_date||'')}"/></div>
        </div>
        <div class="row">
          <div><label>الأصل</label><select name="asset_id"><option value="">—</option>${assets.map(a=>`<option value="${a.id}" ${data.asset_id===a.id?'selected':''}>${_esc(a.name)}</option>`).join('')}</select></div>
          <div><label>الساعات المتوقعة</label><input type="number" step="0.5" name="estimated_hours" value="${_esc(data.estimated_hours||0)}"/></div>
        </div>
        <div><label>الوصف</label><textarea name="description">${_esc(data.description||'')}</textarea></div>
      </form>`,
      footer: `<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="woSave">حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#woSave').addEventListener('click', async ()=>{
      const body = {};
      [...m.overlay.querySelector('#woForm').elements].forEach(el=>{ if(el.name) body[el.name] = el.value; });
      try {
        const r = id ? await PUT('/work-orders/'+id, body) : await POST('/work-orders', body);
        if (r.success){ WoModal.toast({message:'تم الحفظ',kind:'success'}); m.close(); loadWoList(); }
        else WoModal.toast({message:r.error||'فشل',kind:'danger'});
      } catch(e){ WoModal.toast({message:e.message,kind:'danger'}); }
    });
  }
  async function openWoDetail(id){
    const d = await API('/work-orders/'+id);
    const linesHtml = (d.lines||[]).length
      ? `<table class="v5-table"><thead><tr><th>النوع</th><th>الوصف</th><th>كمية/ساعات</th><th>سعر</th><th>الإجمالي</th><th></th></tr></thead><tbody>
          ${d.lines.map(l=>`<tr>
            <td>${({labor:'عمالة',part:'قطعة',service:'خدمة',external:'خارجي'})[l.line_type]||l.line_type}</td>
            <td>${_esc(l.description||'—')}</td>
            <td>${l.line_type==='labor'?l.hours+' س':l.quantity+' '+(l.uom||'')}</td>
            <td class="v5-amount">${_money(l.line_type==='labor'?l.hourly_rate:l.unit_cost)}</td>
            <td class="v5-amount">${_money(l.total_cost)}</td>
            <td><button class="v5-btn sm ghost" onclick="ERPv5.delWoLine('${l.id}','${id}')"><i class="fas fa-trash"></i></button></td>
          </tr>`).join('')}
        </tbody></table>`
      : `<div class="v5-empty"><i class="fas fa-list"></i><div>لا توجد بنود.</div></div>`;
    const stMap = {open:{label:'مفتوح',kind:'neutral'},assigned:{label:'مُعيَّن',kind:'info'},in_progress:{label:'قيد التنفيذ',kind:'warning'},completed:{label:'مكتمل',kind:'success'},closed:{label:'مغلق',kind:'success'}};
    WoModal.open({
      icon:'fa-screwdriver-wrench', iconKind:'warning', size:'xl',
      title: d.title, subtitle: d.code,
      body: `<div>
        <div class="v5-stats">
          <div class="v5-stat"><div class="v5-stat-label">الحالة</div><div class="v5-stat-value">${_statusBadge(d.status, stMap)}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">المسؤول</div><div class="v5-stat-value" style="font-size:14px">${_esc(d.assigned_to||'لم يعيَّن')}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">الأصل</div><div class="v5-stat-value" style="font-size:14px">${_esc(d.asset_name||'—')}</div></div>
          <div class="v5-stat"><div class="v5-stat-label">إجمالي التكلفة</div><div class="v5-stat-value">${_money(d.total_cost)}</div></div>
        </div>
        <p style="color:#475569;line-height:1.7;margin:8px 0;">${_esc(d.description||'لا يوجد وصف')}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 8px;">
          <h4 style="margin:0;">البنود (مواد + ساعات)</h4>
          <div style="display:flex;gap:6px;">
            <button class="v5-btn sm primary" onclick="ERPv5.addWoLine('${id}','part')"><i class="fas fa-plus"></i> قطعة</button>
            <button class="v5-btn sm primary" onclick="ERPv5.addWoLine('${id}','labor')"><i class="fas fa-user-clock"></i> ساعات عمل</button>
          </div>
        </div>
        ${linesHtml}
      </div>`,
      footer: `<button class="wom-btn" data-act="close">إغلاق</button>
        ${d.status==='open'||d.status==='assigned'?`<button class="wom-btn primary" onclick="ERPv5.startWo('${id}')">▶ بدء التنفيذ</button>`:''}
        ${d.status==='in_progress'?`<button class="wom-btn success" onclick="ERPv5.completeWo('${id}')">✓ إكمال</button>`:''}
        ${d.status==='completed'?`<button class="wom-btn primary" onclick="ERPv5.closeWo('${id}')">إغلاق نهائي</button>`:''}`
    });
  }
  async function addWoLine(id, type){
    const m = WoModal.open({
      icon:type==='labor'?'fa-user-clock':'fa-cube', iconKind:'info', size:'md',
      title: type==='labor'?'إضافة ساعات عمل':'إضافة قطعة',
      body: `<form class="v5-form" id="lineForm">
        <div><label>الوصف</label><input name="description" required/></div>
        ${type==='labor'?`
          <div class="row">
            <div><label>الساعات</label><input type="number" step="0.25" name="hours" required/></div>
            <div><label>سعر الساعة</label><input type="number" step="0.01" name="hourly_rate" required/></div>
          </div>`:`
          <div class="row3">
            <div><label>الكمية</label><input type="number" step="0.01" name="quantity" value="1" required/></div>
            <div><label>الوحدة</label><input name="uom"/></div>
            <div><label>السعر</label><input type="number" step="0.01" name="unit_cost" required/></div>
          </div>`}
      </form>`,
      footer: `<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="lineSave">إضافة</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#lineSave').addEventListener('click', async ()=>{
      const body = {line_type: type};
      [...m.overlay.querySelector('#lineForm').elements].forEach(el=>{ if(el.name) body[el.name] = el.value; });
      const r = await POST('/work-orders/'+id+'/lines', body);
      if (r.success){ WoModal.toast({message:'تم الإضافة',kind:'success'}); m.close(); openWoDetail(id); }
      else WoModal.toast({message:r.error||'فشل',kind:'danger'});
    });
  }
  async function delWoLine(lid, woId){
    const ok = await WoModal.confirm({message:'حذف هذا البند؟', danger:true});
    if (!ok) return;
    await DEL('/work-orders/lines/'+lid);
    openWoDetail(woId);
  }
  async function startWo(id){
    await POST('/work-orders/'+id+'/start',{}); WoModal.toast({message:'بدأ التنفيذ',kind:'success'}); openWoDetail(id);
  }
  async function completeWo(id){
    const notes = await WoModal.prompt({title:'ملاحظات الإكمال',label:'وصف ما تم إنجازه'});
    if (notes===null) return;
    await POST('/work-orders/'+id+'/complete', {completion_notes: notes});
    WoModal.toast({message:'تم الإكمال + احتساب التكاليف',kind:'success'}); openWoDetail(id);
  }
  async function closeWo(id){
    await POST('/work-orders/'+id+'/close',{}); WoModal.toast({message:'تم الإغلاق النهائي',kind:'success'}); openWoDetail(id);
  }
  async function openAssetsList(){
    const assets = await API('/work-orders/assets');
    WoModal.open({
      icon:'fa-cube', iconKind:'info', size:'xl',
      title:'الأصول الثابتة',
      body: `<div>
        <div style="margin-bottom:10px"><button class="v5-btn primary sm" onclick="ERPv5.addAsset()"><i class="fas fa-plus"></i> أصل جديد</button></div>
        ${assets.length?`<table class="v5-table"><thead><tr><th>الكود</th><th>الاسم</th><th>الفئة</th><th>الرقم التسلسلي</th><th>الحالة</th><th>آخر صيانة</th></tr></thead><tbody>
          ${assets.map(a=>`<tr><td>${_esc(a.code||'')}</td><td>${_esc(a.name)}</td><td>${_esc(a.category)}</td><td>${_esc(a.serial_number||'—')}</td><td>${_statusBadge(a.status,{active:{label:'نشط',kind:'success'},retired:{label:'مستبعد',kind:'neutral'},disposed:{label:'مُتلَف',kind:'danger'}})}</td><td>${_date(a.last_maintenance_date)}</td></tr>`).join('')}
        </tbody></table>`:`<div class="v5-empty"><i class="fas fa-cube"></i><div>لا توجد أصول.</div></div>`}
      </div>`,
      footer:`<button class="wom-btn" data-act="close">إغلاق</button>`
    });
  }
  async function addAsset(){
    const m = WoModal.open({
      icon:'fa-cube',iconKind:'info',size:'lg',title:'أصل جديد',
      body:`<form class="v5-form" id="astForm">
        <div class="row">
          <div><label>الاسم *</label><input name="name" required/></div>
          <div><label>الفئة</label><select name="category">
            ${['equipment','vehicle','furniture','it','machinery','building','other'].map(c=>`<option value="${c}">${({equipment:'معدات',vehicle:'مركبات',furniture:'أثاث',it:'تقنية',machinery:'آلات',building:'مبنى',other:'أخرى'})[c]}</option>`).join('')}
          </select></div>
        </div>
        <div class="row3">
          <div><label>المصنع</label><input name="manufacturer"/></div>
          <div><label>الموديل</label><input name="model"/></div>
          <div><label>الرقم التسلسلي</label><input name="serial_number"/></div>
        </div>
        <div class="row">
          <div><label>تاريخ الشراء</label><input type="date" name="purchase_date"/></div>
          <div><label>تكلفة الشراء</label><input type="number" step="0.01" name="purchase_cost"/></div>
        </div>
      </form>`,
      footer:`<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="astSave">حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#astSave').addEventListener('click', async ()=>{
      const body={};[...m.overlay.querySelector('#astForm').elements].forEach(el=>{ if(el.name) body[el.name]=el.value; });
      const r = await POST('/work-orders/assets', body);
      if (r.success){ WoModal.toast({message:'تم الحفظ',kind:'success'}); m.close(); openAssetsList(); }
      else WoModal.toast({message:r.error||'فشل',kind:'danger'});
    });
  }

  // ───────── AP / AR INVOICES ─────────────────────────────────────────────
  async function renderInvoices(container, kind){
    _styles();
    const isAP = kind === 'ap';
    const ep = isAP ? '/ap-invoices' : '/ar-invoices';
    const title = isAP ? 'فواتير الموردين (AP)' : 'فواتير العملاء (AR)';
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 16px;">${title}</h2>
      <div class="v5-stats" id="invStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <input type="text" placeholder="بحث..." id="invSearch" class="grow"/>
        <select id="invStatus"><option value="">كل الحالات</option><option value="draft">مسودة</option><option value="${isAP?'approved':'issued'}">${isAP?'معتمد':'صادر'}</option><option value="partially_paid">دفع جزئي</option><option value="paid">مدفوع</option><option value="overdue">متأخر</option></select>
        <button class="v5-btn" onclick="ERPv5.openAging('${kind}')"><i class="fas fa-clock"></i> أعمار الديون</button>
        <button class="v5-btn primary" onclick="ERPv5.openInvoiceForm('${kind}')"><i class="fas fa-plus"></i> فاتورة جديدة</button>
      </div>
      <div id="invList"><div class="v5-skel"></div></div>
    </div>`;
    try {
      const s = await API(ep+'/dashboard');
      document.getElementById('invStats').innerHTML = `
        <div class="v5-stat"><div class="v5-stat-label">إجمالي الفواتير</div><div class="v5-stat-value">${s.total||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">${isAP?'مستحق علينا':'مستحق لنا'}</div><div class="v5-stat-value ${isAP?'danger':'success'}">${_money(isAP?s.total_payable:s.total_receivable)}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">المتأخر</div><div class="v5-stat-value danger">${_money(s.overdue_amount)}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">المدفوع</div><div class="v5-stat-value success">${s.paid_count||0}</div></div>
        <div class="v5-stat"><div class="v5-stat-label">المسودات</div><div class="v5-stat-value">${s.draft_count||0}</div></div>`;
    } catch(e){}
    await loadInvList(kind);
    document.getElementById('invSearch').addEventListener('input', _debounce(()=>loadInvList(kind), 300));
    document.getElementById('invStatus').addEventListener('change', ()=>loadInvList(kind));
  }
  async function loadInvList(kind){
    const isAP = kind === 'ap';
    const q = (document.getElementById('invSearch')||{}).value||'';
    const status = (document.getElementById('invStatus')||{}).value||'';
    const params = new URLSearchParams();
    if (q) params.set('q',q); if (status) params.set('status',status);
    const rows = await API((isAP?'/ap-invoices':'/ar-invoices')+'?'+params);
    const el = document.getElementById('invList');
    if (!rows.length) { el.innerHTML = `<div class="v5-empty"><i class="fas fa-file-invoice-dollar"></i><div>لا توجد فواتير.</div></div>`; return; }
    el.innerHTML = `<table class="v5-table"><thead><tr>
      <th>الكود</th><th>${isAP?'المورد':'العميل'}</th><th>التاريخ</th><th>الاستحقاق</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><strong>${_esc(r.code)}</strong></td>
        <td>${_esc(isAP?r.supplier_name:r.customer_name)}</td>
        <td>${_date(r.issue_date)}</td>
        <td>${_date(r.due_date)}</td>
        <td class="v5-amount">${_money(r.total_amount)}</td>
        <td class="v5-amount" style="color:#15803d;">${_money(r.paid_amount)}</td>
        <td class="v5-amount" style="color:#b91c1c;">${_money(r.balance_amount)}</td>
        <td>${_statusBadge(r.status, {draft:{label:'مسودة',kind:'neutral'},approved:{label:'معتمد',kind:'info'},issued:{label:'صادر',kind:'info'},partially_paid:{label:'جزئي',kind:'warning'},paid:{label:'مدفوع',kind:'success'},overdue:{label:'متأخر',kind:'danger'},cancelled:{label:'ملغى',kind:'neutral'}})}</td>
        <td class="actions">
          ${r.balance_amount>0?`<button class="v5-btn sm success" onclick="ERPv5.${isAP?'payInv':'recvInv'}('${r.id}', ${r.balance_amount})"><i class="fas fa-${isAP?'money-bill':'hand-holding-dollar'}"></i></button>`:''}
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  async function openInvoiceForm(kind){
    const isAP = kind === 'ap';
    const m = WoModal.open({
      icon:'fa-file-invoice-dollar', iconKind:isAP?'warning':'success', size:'lg',
      title:'فاتورة جديدة - '+(isAP?'مورد':'عميل'),
      body: `<form class="v5-form" id="invForm">
        <div class="row">
          <div><label>${isAP?'المورد':'العميل'} *</label><input name="${isAP?'supplier_name':'customer_name'}" required/></div>
          <div><label>الرقم الضريبي</label><input name="vat_number"/></div>
        </div>
        <div class="row3">
          <div><label>رقم الفاتورة الأصلي</label><input name="${isAP?'invoice_no':'code'}"/></div>
          <div><label>تاريخ الإصدار *</label><input type="date" name="issue_date" value="${new Date().toISOString().slice(0,10)}" required/></div>
          <div><label>تاريخ الاستحقاق</label><input type="date" name="due_date"/></div>
        </div>
        <div class="row3">
          <div><label>قبل الضريبة</label><input type="number" step="0.01" name="subtotal" value="0" id="invSub"/></div>
          <div><label>ضريبة القيمة المضافة (15%)</label><input type="number" step="0.01" name="vat_amount" value="0" id="invVat"/></div>
          <div><label>الإجمالي</label><input type="number" step="0.01" name="total_amount" value="0" id="invTot"/></div>
        </div>
        <div><label>ملاحظات</label><textarea name="notes"></textarea></div>
      </form>`,
      footer:`<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="invSave">حفظ</button>`
    });
    const sub = m.overlay.querySelector('#invSub'), vat = m.overlay.querySelector('#invVat'), tot = m.overlay.querySelector('#invTot');
    sub.addEventListener('input', ()=>{ const s = parseFloat(sub.value||0); vat.value = (s*0.15).toFixed(2); tot.value = (s*1.15).toFixed(2); });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#invSave').addEventListener('click', async ()=>{
      const body = {};
      [...m.overlay.querySelector('#invForm').elements].forEach(el=>{ if(el.name) body[el.name] = el.value; });
      const r = await POST(isAP?'/ap-invoices':'/ar-invoices', body);
      if (r.success){ WoModal.toast({message:'تم الحفظ - '+r.code,kind:'success'}); m.close(); loadInvList(kind); }
      else WoModal.toast({message:r.error||'فشل',kind:'danger'});
    });
  }
  async function payInv(id, balance){
    const amt = await WoModal.prompt({title:'تسجيل دفعة لمورد',label:'المبلغ',type:'number',defaultValue:balance});
    if (!amt) return;
    const r = await POST('/ap-invoices/'+id+'/pay', {amount: parseFloat(amt)});
    if (r.success){ WoModal.toast({message:'تم تسجيل الدفعة. المتبقي: '+_money(r.balance_amount),kind:'success'}); loadInvList('ap'); }
    else WoModal.alert({title:'فشل',message:r.error,kind:'danger'});
  }
  async function recvInv(id, balance){
    const amt = await WoModal.prompt({title:'تسجيل استلام دفعة',label:'المبلغ',type:'number',defaultValue:balance});
    if (!amt) return;
    const r = await POST('/ar-invoices/'+id+'/receive', {amount: parseFloat(amt)});
    if (r.success){ WoModal.toast({message:'تم تسجيل الاستلام. المتبقي: '+_money(r.balance_amount),kind:'success'}); loadInvList('ar'); }
    else WoModal.alert({title:'فشل',message:r.error,kind:'danger'});
  }
  async function openAging(kind){
    const isAP = kind==='ap';
    const rows = await API((isAP?'/ap-invoices':'/ar-invoices')+'/aging');
    WoModal.open({
      icon:'fa-clock', iconKind:'warning', size:'xl',
      title: 'أعمار الديون - '+(isAP?'موردون':'عملاء'),
      body: rows.length ? `<table class="v5-table v5-aging-table"><thead><tr>
        <th>${isAP?'المورد':'العميل'}</th><th>غير مستحق</th><th>1-30</th><th>31-60</th><th>61-90</th><th>+90</th><th>الإجمالي</th>
      </tr></thead><tbody>
        ${rows.map(r=>`<tr>
          <td style="text-align:right;"><strong>${_esc(isAP?r.supplier_name:r.customer_name)}</strong></td>
          <td class="v5-amount">${_money(r.not_due)}</td>
          <td class="v5-amount">${_money(r.d_0_30)}</td>
          <td class="v5-amount v5-aging-pos">${_money(r.d_31_60)}</td>
          <td class="v5-amount v5-aging-pos" style="color:#dc2626;">${_money(r.d_61_90)}</td>
          <td class="v5-amount" style="color:#7f1d1d;font-weight:800;">${_money(r.d_90_plus)}</td>
          <td class="v5-amount" style="font-weight:800;">${_money(r.total_balance)}</td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="v5-empty"><i class="fas fa-check-circle"></i><div>لا توجد ديون متأخرة. عمل ممتاز!</div></div>`,
      footer: `<button class="wom-btn" data-act="close">إغلاق</button>`
    });
  }

  // ───────── APPROVAL MATRIX ─────────────────────────────────────────────
  async function renderMatrix(container){
    _styles();
    // V5.9.16 — added KPI tiles + empty-state hero so the matrix page
    // doesn't open as a bare table. Stats are computed client-side from
    // the full list (the backend doesn't yet expose a dedicated /stats).
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 4px;">مصفوفة سياسات الموافقة</h2>
      <p style="color:#64748b;font-size:13px;margin-bottom:16px;">يحدد النظام تلقائياً مسار اعتماد كل معاملة بناء على نوعها ومبلغها — السياسات هنا تتحكم بالخطوات والمعتمدين والـ SLA.</p>
      <div class="v5-stats" id="mxStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <select id="mxType"><option value="">كل أنواع المعاملات</option></select>
        <button class="v5-btn primary" onclick="ERPv5.openMatrixForm()"><i class="fas fa-plus"></i> سياسة جديدة</button>
        <button class="v5-btn" onclick="ERPv5.testMatrix()"><i class="fas fa-flask"></i> اختبار المسار</button>
      </div>
      <div id="mxList"><div class="v5-skel"></div></div>
    </div>`;
    const types = await API('/approval-matrix/transaction-types');
    const sel = document.getElementById('mxType');
    sel.innerHTML += (types||[]).map(t=>`<option value="${t.code}">${_esc(t.name)} (${t.code})</option>`).join('');
    sel.addEventListener('change', loadMatrix);
    // V5.9.16 — load all rows once for the stats panel; loadMatrix() then
    // applies the filter on top.
    try {
      const all = await API('/approval-matrix?');
      const rows = Array.isArray(all) ? all : [];
      const active = rows.filter(r => r.is_active !== 0).length;
      const inactive = rows.length - active;
      const distinctTypes = new Set(rows.map(r => r.transaction_type_code)).size;
      const avgSla = rows.length ? Math.round(rows.reduce((s,r)=>s+(Number(r.sla_hours)||0),0) / rows.length) : 0;
      document.getElementById('mxStats').innerHTML =
        `<div class="v5-stat"><div class="v5-stat-label">سياسات نشطة</div><div class="v5-stat-value success">${active}</div><div class="v5-stat-trend">${rows.length} إجمالي</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">أنواع المعاملات المغطاة</div><div class="v5-stat-value info">${distinctTypes}</div><div class="v5-stat-trend">من أصل ${(types||[]).length} نوع</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">متوسط SLA</div><div class="v5-stat-value warning">${avgSla} س</div><div class="v5-stat-trend">للموافقة على كل خطوة</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">سياسات معطّلة</div><div class="v5-stat-value danger">${inactive}</div><div class="v5-stat-trend">${inactive ? 'تحتاج مراجعة' : 'لا توجد'}</div></div>`;
    } catch(e) { document.getElementById('mxStats').innerHTML = ''; }
    await loadMatrix();
  }
  async function loadMatrix(){
    const t = (document.getElementById('mxType')||{}).value||'';
    const params = new URLSearchParams();
    if (t) params.set('typeCode', t);
    const rows = await API('/approval-matrix?'+params);
    const el = document.getElementById('mxList');
    if (!rows.length) { el.innerHTML = `<div class="v5-empty"><i class="fas fa-sitemap"></i><div>لا توجد سياسات مسجلة.</div></div>`; return; }
    el.innerHTML = `<table class="v5-table"><thead><tr>
      <th>نوع المعاملة</th><th>المبلغ من</th><th>المبلغ إلى</th><th>الترتيب</th><th>المعتمد</th><th>SLA</th><th>صلاحيات</th><th>نشط</th><th></th>
    </tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><strong>${_esc(r.transaction_type_code)}</strong></td>
        <td class="v5-amount">${_money(r.amount_from)}</td>
        <td class="v5-amount">${r.amount_to ? _money(r.amount_to) : '∞'}</td>
        <td>${r.step_order}</td>
        <td>${_esc(r.approver_value)} <small style="color:#94a3b8;">(${r.approver_type})</small></td>
        <td>${r.sla_hours} س</td>
        <td>
          ${r.can_approve?'<span class="v5-badge v5-badge-success">اعتماد</span>':''}
          ${r.can_reject?'<span class="v5-badge v5-badge-danger">رفض</span>':''}
          ${r.can_return?'<span class="v5-badge v5-badge-warning">إعادة</span>':''}
        </td>
        <td>${r.is_active?'✓':'✗'}</td>
        <td class="actions">
          <button class="v5-btn sm ghost" onclick="ERPv5.openMatrixForm('${r.id}')"><i class="fas fa-pen"></i></button>
          <button class="v5-btn sm danger" onclick="ERPv5.delMatrix('${r.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  async function openMatrixForm(id){
    const types = await API('/approval-matrix/transaction-types');
    const data = id ? await API('/approval-matrix/'+id) : {};
    const m = WoModal.open({
      icon:'fa-sitemap', iconKind:'purple', size:'lg', title: id?'تعديل سياسة':'سياسة جديدة',
      body: `<form class="v5-form" id="mxForm">
        <div class="row">
          <div><label>نوع المعاملة *</label><select name="transaction_type_code" required>
            <option value="">—</option>${types.map(t=>`<option value="${t.code}" ${data.transaction_type_code===t.code?'selected':''}>${_esc(t.name)}</option>`).join('')}
          </select></div>
          <div><label>الترتيب *</label><input type="number" name="step_order" value="${data.step_order||1}" required/></div>
        </div>
        <div class="row">
          <div><label>المبلغ من</label><input type="number" step="0.01" name="amount_from" value="${data.amount_from||0}"/></div>
          <div><label>المبلغ إلى (فارغ = ∞)</label><input type="number" step="0.01" name="amount_to" value="${data.amount_to||''}"/></div>
        </div>
        <div class="row">
          <div><label>نوع المعتمد</label><select name="approver_type">
            ${['role','user','position','manager_of_creator','department_head'].map(t=>`<option value="${t}" ${data.approver_type===t?'selected':''}>${({role:'دور',user:'مستخدم محدد',position:'منصب',manager_of_creator:'مدير المنشئ',department_head:'رئيس القسم'})[t]}</option>`).join('')}
          </select></div>
          <div><label>القيمة (الدور/المستخدم) *</label><input name="approver_value" value="${_esc(data.approver_value||'')}" required placeholder="مثلاً: finance_manager أو ahmed.adlan"/></div>
        </div>
        <div class="row3">
          <div><label>SLA (ساعات)</label><input type="number" name="sla_hours" value="${data.sla_hours||24}"/></div>
          <div><label>تصعيد بعد (ساعات)</label><input type="number" name="escalate_after_hours" value="${data.escalate_after_hours||''}"/></div>
          <div><label>تصعيد إلى دور</label><input name="escalate_to_role" value="${_esc(data.escalate_to_role||'')}"/></div>
        </div>
        <div class="row3">
          <div><label><input type="checkbox" name="can_approve" ${data.can_approve!==0?'checked':''}/> يمكن الاعتماد</label></div>
          <div><label><input type="checkbox" name="can_reject" ${data.can_reject!==0?'checked':''}/> يمكن الرفض</label></div>
          <div><label><input type="checkbox" name="can_return" ${data.can_return!==0?'checked':''}/> يمكن الإعادة</label></div>
        </div>
        <div><label>ملاحظات</label><input name="notes" value="${_esc(data.notes||'')}"/></div>
      </form>`,
      footer: `<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="mxSave">حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#mxSave').addEventListener('click', async ()=>{
      const body={};
      [...m.overlay.querySelector('#mxForm').elements].forEach(el=>{
        if(!el.name) return;
        if (el.type==='checkbox') body[el.name] = el.checked;
        else body[el.name] = el.value || null;
      });
      try {
        const r = id ? await PUT('/approval-matrix/'+id, body) : await POST('/approval-matrix', body);
        if (r.success){ WoModal.toast({message:'تم الحفظ',kind:'success'}); m.close(); loadMatrix(); }
        else WoModal.toast({message:r.error||'فشل',kind:'danger'});
      } catch(e){ WoModal.toast({message:e.message,kind:'danger'}); }
    });
  }
  async function delMatrix(id){
    const ok = await WoModal.confirm({message:'تعطيل هذه السياسة؟',danger:true});
    if (!ok) return;
    await DEL('/approval-matrix/'+id); loadMatrix();
  }
  async function testMatrix(){
    const types = await API('/approval-matrix/transaction-types');
    const m = WoModal.open({
      icon:'fa-flask',iconKind:'info',size:'lg',title:'اختبار مصفوفة الموافقة',
      body:`<form class="v5-form" id="testForm">
        <div class="row">
          <div><label>نوع المعاملة</label><select name="typeCode">${types.map(t=>`<option value="${t.code}">${_esc(t.name)}</option>`).join('')}</select></div>
          <div><label>المبلغ</label><input type="number" step="0.01" name="amount" value="10000"/></div>
        </div>
      </form>
      <div id="testRes" style="margin-top:16px;"></div>`,
      footer:`<button class="wom-btn" data-act="cancel">إغلاق</button><button class="wom-btn primary" id="testRun">اختبار</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#testRun').addEventListener('click', async ()=>{
      const body={};[...m.overlay.querySelector('#testForm').elements].forEach(el=>{ if(el.name) body[el.name]=el.value; });
      const r = await POST('/approval-matrix/test', body);
      const res = m.overlay.querySelector('#testRes');
      if (!r.matched_count) {
        res.innerHTML = `<div class="v5-empty"><i class="fas fa-circle-question"></i><div>لا توجد سياسة مطابقة. ستستخدم الإعدادات الافتراضية.</div></div>`;
      } else {
        res.innerHTML = `<h4>المسار الناتج (${r.matched_count} خطوة):</h4>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px;background:#f8fafc;border-radius:12px;">
            <div class="v5-badge v5-badge-info">المُنشئ</div>
            ${r.path.map(p=>`<i class="fas fa-arrow-left" style="color:#94a3b8;"></i><div class="v5-badge v5-badge-purple">${p.step}: ${_esc(p.approver)} <small>(${p.sla_hours}س)</small></div>`).join('')}
            <i class="fas fa-arrow-left" style="color:#94a3b8;"></i><div class="v5-badge v5-badge-success">معتمد</div>
          </div>`;
      }
    });
  }

  // ───────── ANOMALIES ─────────────────────────────────────────────────
  async function renderAnomalies(container){
    _styles();
    // V5.9.16 — added a 4-tile KPI strip and a header subtitle so the page
    // tells the user what it's for and surfaces the most-actionable counts
    // (critical-open + total-open) before they scroll into the table.
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 4px;">تنبيهات الشذوذ — Anomaly Detection</h2>
      <p style="color:#64748b;font-size:13px;margin-bottom:16px;">يفحص النظام تلقائياً المعاملات والمصروفات والمخزون لرصد الأنماط غير الطبيعية. اضغط «تشغيل المسح» لإعادة الفحص الآن.</p>
      <div class="v5-stats" id="anStats"><div class="v5-skel"></div></div>
      <div class="v5-toolbar">
        <select id="anSev"><option value="">كل الدرجات</option><option value="critical">حرج</option><option value="high">عالي</option><option value="medium">متوسط</option><option value="low">منخفض</option></select>
        <select id="anSt"><option value="">كل الحالات</option><option value="open">مفتوح</option><option value="acknowledged">معترف به</option><option value="resolved">محلول</option></select>
        <button class="v5-btn primary" onclick="ERPv5.runScan()"><i class="fas fa-radar"></i> تشغيل المسح الذكي</button>
      </div>
      <div id="anList"><div class="v5-skel"></div></div>
    </div>`;
    document.getElementById('anSev').addEventListener('change', loadAnomalies);
    document.getElementById('anSt').addEventListener('change', loadAnomalies);
    // V5.9.16 — pull all rows once for the stats panel; loadAnomalies()
    // applies filters on the table below.
    try {
      const all = await API('/anomalies?');
      const rows = Array.isArray(all) ? all : [];
      const open       = rows.filter(r => r.status === 'open').length;
      const critical   = rows.filter(r => r.severity === 'critical' && r.status === 'open').length;
      const acknowledged = rows.filter(r => r.status === 'acknowledged').length;
      const resolved   = rows.filter(r => r.status === 'resolved').length;
      document.getElementById('anStats').innerHTML =
        `<div class="v5-stat" style="${critical>0?'border-color:#fecaca;background:linear-gradient(135deg,#fef2f2,#fff);':''}"><div class="v5-stat-label">حرجة مفتوحة</div><div class="v5-stat-value danger">${critical}</div><div class="v5-stat-trend">${critical>0?'تحتاج تدخل فوري':'لا توجد تنبيهات حرجة'}</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">مفتوحة (الكل)</div><div class="v5-stat-value warning">${open}</div><div class="v5-stat-trend">${open ? 'بانتظار المراجعة' : 'محدّث بالكامل'}</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">معترف بها</div><div class="v5-stat-value info">${acknowledged}</div><div class="v5-stat-trend">قيد المعالجة</div></div>` +
        `<div class="v5-stat"><div class="v5-stat-label">تمّ حلّها</div><div class="v5-stat-value success">${resolved}</div><div class="v5-stat-trend">من إجمالي ${rows.length} تنبيه</div></div>`;
    } catch(e) { document.getElementById('anStats').innerHTML = ''; }
    await loadAnomalies();
  }
  async function loadAnomalies(){
    const sev = (document.getElementById('anSev')||{}).value||'';
    const st = (document.getElementById('anSt')||{}).value||'';
    const params = new URLSearchParams();
    if (sev) params.set('severity', sev);
    if (st) params.set('status', st);
    const rows = await API('/anomalies?'+params);
    const el = document.getElementById('anList');
    if (!rows.length) { el.innerHTML = `<div class="v5-empty"><i class="fas fa-shield-check"></i><div style="color:#15803d;font-weight:600;">لا توجد تنبيهات. كل شيء طبيعي.</div></div>`; return; }
    const sevMap = {critical:{label:'حرج',kind:'danger'},high:{label:'عالي',kind:'danger'},medium:{label:'متوسط',kind:'warning'},low:{label:'منخفض',kind:'info'},info:{label:'معلومة',kind:'neutral'}};
    el.innerHTML = `<table class="v5-table"><thead><tr><th>التاريخ</th><th>الدرجة</th><th>الفئة</th><th>العنوان</th><th>الوصف</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><small>${_date(r.detected_at)}</small></td>
        <td>${_statusBadge(r.severity, sevMap)}</td>
        <td>${_esc({financial:'مالي',operational:'تشغيلي',compliance:'امتثال',duplicate:'تكرار',behavioral:'سلوكي'}[r.category]||r.category)}</td>
        <td><strong>${_esc(r.title)}</strong></td>
        <td>${_esc(r.description||'')}</td>
        <td>${_statusBadge(r.status, {open:{label:'مفتوح',kind:'warning'},acknowledged:{label:'معترف',kind:'info'},dismissed:{label:'متجاهل',kind:'neutral'},resolved:{label:'محلول',kind:'success'}})}</td>
        <td class="actions">
          ${r.status==='open'?`<button class="v5-btn sm" onclick="ERPv5.ackAnomaly('${r.id}')">إقرار</button>
          <button class="v5-btn sm danger" onclick="ERPv5.dismissAnomaly('${r.id}')">تجاهل</button>`:''}
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  async function ackAnomaly(id){ await POST('/anomalies/'+id+'/ack',{}); loadAnomalies(); }
  async function dismissAnomaly(id){ await POST('/anomalies/'+id+'/dismiss',{}); loadAnomalies(); }
  async function runScan(){
    const r = await POST('/anomalies/scan',{});
    WoModal.toast({message:'اكتمل المسح. اكتشف '+r.found_count+' تنبيه جديد',kind:r.found_count?'warning':'success'});
    loadAnomalies();
  }

  // ───────── BUDGETS ─────────────────────────────────────────────────────
  async function renderBudgets(container){
    _styles();
    _budgetsTreeStyles();
    const year = new Date().getFullYear();
    // V5.9.15 — completely rebuilt as a hierarchical COA tree (per the
    // user's "اريد ان نظهر لي الحسابات الصفرية وجميع الحسابات الخاصة بالشجرة"
    // request). The flat year-table is gone. Now every active account
    // appears as a tree node with budget/actual/variance, even if it has
    // never been budgeted or moved.
    container.innerHTML = `<div class="v5-section">
      <h2 style="margin:0 0 4px;">الميزانيات والتباين — شجرة الحسابات</h2>
      <p style="color:#64748b;font-size:13px;margin-bottom:16px;">جميع حسابات شجرة الحسابات حسب المعيار الدولي IFRS / IAS — اضبط الميزانية لكل حساب بشكل مستقل.</p>
      <div class="v5-toolbar">
        <label style="font-weight:700;font-size:13px;">السنة المالية:</label>
        <input type="number" id="budYear" value="${year}" style="width:110px;"/>
        <select id="budRootFilter" style="padding:8px 12px;">
          <option value="">جميع الجذور (1-5)</option>
          <option value="1">1 — الأصول</option>
          <option value="2">2 — الالتزامات</option>
          <option value="3">3 — حقوق الملكية</option>
          <option value="4">4 — الإيرادات</option>
          <option value="5" selected>5 — المصروفات</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;cursor:pointer;">
          <input type="checkbox" id="budShowZero" checked> إظهار الحسابات الصفرية
        </label>
        <span class="grow"></span>
        <button class="v5-btn primary" onclick="ERPv5.openBudgetForm()"><i class="fas fa-plus"></i> ميزانية جديدة</button>
        <button class="v5-btn" onclick="ERPv5.recomputeBudgets()"><i class="fas fa-rotate"></i> إعادة احتساب الفعلي</button>
      </div>
      <div id="budTreeWrap"><div class="v5-skel"></div></div>
    </div>`;
    document.getElementById('budYear').addEventListener('change', loadBudgets);
    document.getElementById('budRootFilter').addEventListener('change', loadBudgets);
    document.getElementById('budShowZero').addEventListener('change', loadBudgets);
    await loadBudgets();
  }

  function _budgetsTreeStyles(){
    if (document.getElementById('budgets-tree-styles')) return;
    const s = document.createElement('style');
    s.id = 'budgets-tree-styles';
    s.textContent = `
      .bud-tree{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;}
      .bud-th{display:grid;grid-template-columns:minmax(280px,2fr) 130px 130px 130px 100px 80px;background:#7f1d1d;color:#fff;padding:11px 14px;font-size:11px;font-weight:800;letter-spacing:0.4px;text-transform:uppercase;}
      .bud-th>div{text-align:end;}
      .bud-th>div:first-child{text-align:start;}
      .bud-row{display:grid;grid-template-columns:minmax(280px,2fr) 130px 130px 130px 100px 80px;align-items:center;padding:9px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;transition:background .15s;}
      .bud-row:hover{background:#fafafa;}
      .bud-row:last-child{border-bottom:none;}
      .bud-row.lvl-1{background:#fef2f2;font-weight:800;}
      .bud-row.lvl-1:hover{background:#fee2e2;}
      .bud-row.lvl-2{background:#fafafa;font-weight:700;}
      .bud-row.zero{opacity:0.55;}
      .bud-row.warn{background:#fffbeb;}
      .bud-row.over{background:#fef2f2;}
      .bud-row .name{display:flex;align-items:center;gap:8px;}
      .bud-row .name code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#7f1d1d;background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #fecaca;flex-shrink:0;}
      .bud-row .name .indent{display:inline-block;}
      .bud-row .num{text-align:end;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace;font-size:13px;}
      .bud-row .pos{color:#16a34a;}
      .bud-row .neg{color:#dc2626;}
      .bud-row .util-bar{height:14px;border-radius:7px;background:#e2e8f0;position:relative;overflow:hidden;}
      .bud-row .util-fill{height:100%;background:linear-gradient(90deg,#16a34a,#22c55e);}
      .bud-row .util-fill.warn{background:linear-gradient(90deg,#f59e0b,#fbbf24);}
      .bud-row .util-fill.over{background:linear-gradient(90deg,#dc2626,#ef4444);}
      .bud-row .util-pct{position:absolute;inset:0;display:grid;place-items:center;font-size:10px;font-weight:800;color:#0f172a;}
      .bud-row .actions{display:flex;gap:4px;justify-content:flex-end;}
      .bud-row .actions button{width:26px;height:26px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#475569;font-size:11px;}
      .bud-row .actions button:hover{background:#f8fafc;border-color:#7f1d1d;color:#7f1d1d;}
    `;
    document.head.appendChild(s);
  }

  async function loadBudgets(){
    const y = (document.getElementById('budYear')||{}).value || new Date().getFullYear();
    const root = (document.getElementById('budRootFilter')||{}).value || '';
    const showZero = (document.getElementById('budShowZero')||{}).checked !== false;
    const wrap = document.getElementById('budTreeWrap');
    wrap.innerHTML = `<div class="v5-skel"></div>`;
    let data;
    try { data = await API('/budgets/coa-tree?fiscalYear=' + encodeURIComponent(y)); }
    catch(e) { wrap.innerHTML = `<div class="v5-empty"><i class="fas fa-triangle-exclamation"></i><div>تعذّر تحميل شجرة الحسابات.</div></div>`; return; }
    let accounts = (data && data.accounts) || [];
    if (root)        accounts = accounts.filter(a => String(a.code).startsWith(root));
    if (!showZero)   accounts = accounts.filter(a => !a.isZeroBudget || !a.isZeroActual);
    if (!accounts.length) {
      wrap.innerHTML = `<div class="v5-empty"><i class="fas fa-chart-pie"></i><div>لا توجد حسابات تطابق الفلتر.</div></div>`;
      return;
    }
    let html = '<div class="bud-tree">' +
      '<div class="bud-th">' +
        '<div>الحساب</div>' +
        '<div>الميزانية</div>' +
        '<div>الفعلي</div>' +
        '<div>التباين</div>' +
        '<div>الاستخدام</div>' +
        '<div>إجراءات</div>' +
      '</div>';
    accounts.forEach(a => {
      const cls = ['bud-row', 'lvl-' + (a.level||1)];
      if (a.isZeroBudget && a.isZeroActual) cls.push('zero');
      else if (a.variancePct > a.blockPct) cls.push('over');
      else if (a.variancePct > a.warnPct)  cls.push('warn');
      const util = Math.min(100, Math.max(0, a.variancePct || 0));
      const utilCls = a.variancePct > a.blockPct ? 'over' : (a.variancePct > a.warnPct ? 'warn' : '');
      const indentPx = Math.max(0, (Number(a.level)||1) - 1) * 16;
      html += `<div class="${cls.join(' ')}">
        <div class="name"><span class="indent" style="width:${indentPx}px;"></span><code>${_esc(a.code||'')}</code><span>${_esc(a.nameAr||'')}</span></div>
        <div class="num">${_money(a.budgetAmount)}</div>
        <div class="num">${_money(a.actualAmount)}</div>
        <div class="num ${a.varianceAmount>=0?'pos':'neg'}">${_money(a.varianceAmount)}</div>
        <div>${a.budgetAmount>0?`<div class="util-bar"><div class="util-fill ${utilCls}" style="width:${util}%;"></div><span class="util-pct">${(a.variancePct||0).toFixed(1)}%</span></div>`:'<span style="color:#94a3b8;font-size:11px;">—</span>'}</div>
        <div class="actions"><button onclick="ERPv5.openBudgetForm('${_esc(a.id)}','${_esc(a.code||'')}','${_esc((a.nameAr||'').replace(/'/g, '&#39;'))}',${y})" title="ضبط الميزانية"><i class="fas fa-edit"></i></button></div>
      </div>`;
    });
    html += '</div>';
    wrap.innerHTML = html;
  }
  // V5.9.15 — open budget form. When called with accountId pre-fills the
  // form for that account (the row's edit button passes it). Otherwise the
  // user gets a free-form entry that lets them pick any cost-center OR account.
  async function openBudgetForm(accountId, accountCode, accountName, fiscalYear){
    accountId = accountId || '';
    accountCode = accountCode || '';
    accountName = accountName || '';
    fiscalYear = fiscalYear || new Date().getFullYear();
    const ccs = await fetch('/api/erp/cost-centers').then(r=>r.json()).catch(()=>[]);
    const accountFieldHtml = accountId
      ? `<div><label>الحساب</label><div style="padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fef2f2;font-family:ui-monospace,Menlo,monospace;"><b style="color:#7f1d1d;">${_esc(accountCode)}</b> — ${_esc(accountName)}</div></div>`
      : '';
    const ccFieldHtml = accountId
      ? '' // when targeting an account, cost-center is optional and hidden by default
      : `<div><label>مركز التكلفة</label><select name="cost_center_id"><option value="">— بدون —</option>${(ccs||[]).map(c=>`<option value="${c.id}">${_esc(c.name||c.id)}</option>`).join('')}</select></div>`;
    const m = WoModal.open({
      icon:'fa-chart-pie',iconKind:'info',size:'md',
      title: accountId ? `ضبط ميزانية الحساب ${accountCode}` : 'ميزانية شهرية',
      body:`<form class="v5-form" id="budForm">
        <input type="hidden" name="account_id" value="${_esc(accountId)}"/>
        ${accountFieldHtml}
        <div class="row">
          <div><label>السنة *</label><input type="number" name="fiscal_year" value="${fiscalYear}" required/></div>
          <div><label>الشهر</label><select name="period_month"><option value="">السنة كاملة</option>${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></div>
        </div>
        ${ccFieldHtml}
        <div><label>قيمة الميزانية *</label><input type="number" step="0.01" name="budget_amount" required placeholder="0.00"/></div>
        <div class="row">
          <div><label>تنبيه عند % (افتراضي 80)</label><input type="number" name="threshold_warn_pct" value="80"/></div>
          <div><label>إيقاف عند % (افتراضي 100)</label><input type="number" name="threshold_block_pct" value="100"/></div>
        </div>
      </form>`,
      footer:`<button class="wom-btn" data-act="cancel">إلغاء</button><button class="wom-btn primary" id="budSave">حفظ</button>`
    });
    m.overlay.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.overlay.querySelector('#budSave').addEventListener('click', async ()=>{
      const body={};[...m.overlay.querySelector('#budForm').elements].forEach(el=>{ if(el.name) body[el.name]=el.value; });
      // Either account_id OR cost_center_id is required by the backend.
      if (!body.account_id && !body.cost_center_id) {
        WoModal.toast({message:'اختر إما حساباً أو مركز تكلفة',kind:'danger'});
        return;
      }
      // V5.9.15 — backend now accepts either account_id OR cost_center_id;
      // no synthetic placeholder needed.
      const r = await POST('/budgets', body);
      if (r.success){ WoModal.toast({message:'تم الحفظ',kind:'success'}); m.close(); loadBudgets(); }
      else WoModal.toast({message:r.error||'فشل',kind:'danger'});
    });
  }
  async function recomputeBudgets(){
    const y = (document.getElementById('budYear')||{}).value||new Date().getFullYear();
    const r = await POST('/budgets/recompute', {year: parseInt(y)});
    WoModal.toast({message:'تم إعادة الاحتساب',kind:'success'}); loadBudgets();
  }

  // ───────── DISPATCHER ─────────────────────────────────────────────────
  function render(section, container){
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) { console.warn('[ERPv5] container missing for', section); return; }
    switch(section){
      case 'properties':  return renderProperties(container);
      case 'contracts':   return renderContracts(container);
      case 'work-orders': return renderWorkOrders(container);
      case 'ap':          return renderInvoices(container,'ap');
      case 'ar':          return renderInvoices(container,'ar');
      case 'matrix':      return renderMatrix(container);
      case 'anomalies':   return renderAnomalies(container);
      case 'budgets':     return renderBudgets(container);
      default: container.innerHTML = `<div class="v5-empty"><i class="fas fa-question"></i><div>قسم غير معروف: ${_esc(section)}</div></div>`;
    }
  }

  function _debounce(fn, ms){
    let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); };
  }

  global.ERPv5 = {
    render,
    openPropertyForm, openPropertyDetail, openUnitForm,
    openContractForm, openContractDetail, activateContract, terminateContract, spawnInv,
    openWoForm, openWoDetail, addWoLine, delWoLine, startWo, completeWo, closeWo,
    openAssetsList, addAsset,
    openInvoiceForm, payInv, recvInv, openAging,
    openMatrixForm, delMatrix, testMatrix,
    runScan, ackAnomaly, dismissAnomaly,
    openBudgetForm, recomputeBudgets
  };
})(window);
