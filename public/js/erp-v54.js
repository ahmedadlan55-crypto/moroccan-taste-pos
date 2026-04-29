/**
 * ERP V5.4 — Channel Menus + Professional Stocktake (UI)
 * Loaded after erp-v5.js. Public:
 *   ERPv54.renderChannelMenus(container)
 *   ERPv54.renderStocktakePro(container)
 */
(function(global){
  'use strict';

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function _money(n){ return (parseFloat(n||0)).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function _date(d){ return d ? new Date(d).toLocaleDateString('ar-SA') : '—'; }

  function _api(p){
    var token = localStorage.getItem('pos_token') || '';
    return fetch('/api'+p, { headers: { 'Authorization': 'Bearer '+token } }).then(r=>r.json());
  }
  function _post(p,b){
    var token = localStorage.getItem('pos_token') || '';
    return fetch('/api'+p, { method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: JSON.stringify(b||{})}).then(r=>r.json());
  }
  function _put(p,b){
    var token = localStorage.getItem('pos_token') || '';
    return fetch('/api'+p, { method:'PUT', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: JSON.stringify(b||{})}).then(r=>r.json());
  }
  function _del(p){
    var token = localStorage.getItem('pos_token') || '';
    return fetch('/api'+p, { method:'DELETE', headers:{'Authorization':'Bearer '+token}}).then(r=>r.json());
  }

  function _ensureStyles(){
    if (document.getElementById('v54-styles')) return;
    var s = document.createElement('style'); s.id = 'v54-styles';
    s.textContent = `
      .v54-section{padding:18px;direction:rtl;font-family:'Tajawal',sans-serif;}
      .v54-h1{margin:0 0 16px;font-size:22px;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:10px;}
      .v54-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px 14px;}
      .v54-toolbar select,.v54-toolbar input{padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13px;font-family:inherit;}
      .v54-btn{padding:9px 16px;border-radius:10px;border:1.5px solid #e2e8f0;background:#fff;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;color:#334155;display:inline-flex;align-items:center;gap:6px;}
      .v54-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}
      .v54-btn.success{background:#16a34a;color:#fff;border-color:#16a34a;}
      .v54-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626;}
      .v54-btn.warning{background:#f59e0b;color:#fff;border-color:#f59e0b;}
      .v54-btn.sm{padding:5px 10px;font-size:11px;}
      .v54-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08);}
      .v54-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px;}
      .v54-stat{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px 14px;}
      .v54-stat-l{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px;}
      .v54-stat-v{font-size:22px;font-weight:800;color:#0f172a;line-height:1.1;margin-top:4px;}
      .v54-stat-v.success{color:#16a34a;} .v54-stat-v.danger{color:#dc2626;} .v54-stat-v.warning{color:#f59e0b;}

      .v54-table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;font-size:12.5px;}
      .v54-table thead th{background:#f8fafc;padding:10px;text-align:right;font-weight:700;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #e2e8f0;}
      .v54-table tbody td{padding:10px;border-bottom:1px solid #f1f5f9;}
      .v54-table tbody tr:hover{background:#f8fafc;}
      .v54-table tbody tr:last-child td{border-bottom:0;}
      .v54-flagged{background:#fef2f2 !important;}
      .v54-empty{text-align:center;padding:40px;color:#64748b;font-size:13px;}
      .v54-empty i{font-size:42px;color:#cbd5e1;display:block;margin-bottom:10px;}

      /* Two-pane channel menu picker */
      .v54-cm-shell{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      .v54-cm-pane{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;max-height:60vh;}
      .v54-cm-pane-head{padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-weight:800;display:flex;align-items:center;gap:8px;font-size:13px;}
      .v54-cm-pane-list{flex:1;overflow-y:auto;padding:8px;}
      .v54-cm-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:4px;border:1px solid #e2e8f0;cursor:pointer;transition:all .15s;}
      .v54-cm-item:hover{background:#f0f9ff;border-color:#0ea5e9;}
      .v54-cm-item input[type=checkbox]{margin:0;}
      .v54-cm-item-name{flex:1;font-weight:700;color:#0f172a;font-size:12px;}
      .v54-cm-item-cat{font-size:10px;color:#94a3b8;}
      .v54-cm-item-price{font-weight:800;color:#16a34a;font-size:12px;}

      .v54-badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800;}
      .v54-badge-green{background:#dcfce7;color:#15803d;}
      .v54-badge-red{background:#fee2e2;color:#991b1b;}
      .v54-badge-yellow{background:#fef3c7;color:#92400e;}
      .v54-badge-blue{background:#dbeafe;color:#1e40af;}
      .v54-badge-gray{background:#f1f5f9;color:#475569;}

      @media(max-width:768px){
        .v54-cm-shell{grid-template-columns:1fr;}
      }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHANNEL MENUS
  // ═══════════════════════════════════════════════════════════════════
  async function renderChannelMenus(container){
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    _ensureStyles();
    container.innerHTML = '<div class="v54-section">' +
      '<h2 class="v54-h1"><i class="fas fa-store" style="color:#0ea5e9"></i> منيو القنوات</h2>' +
      '<div class="v54-toolbar">' +
        '<label>القناة:</label>' +
        '<select id="v54CmChannel"><option value="">— اختر قناة —</option></select>' +
        '<label>الفرع:</label>' +
        '<select id="v54CmBranch"><option value="">كل الفروع</option></select>' +
        '<button class="v54-btn" id="v54CmCopyBtn"><i class="fas fa-copy"></i> نسخ من قناة أخرى</button>' +
      '</div>' +
      '<div id="v54CmContent"><div class="v54-empty"><i class="fas fa-arrow-up"></i>اختر قناة من الأعلى للبدء</div></div>' +
    '</div>';
    // Load channels + branches
    const [channels, branches] = await Promise.all([
      _api('/channel-menus/channels'),
      _api('/erp/branches').catch(()=>[])
    ]);
    var chSel = document.getElementById('v54CmChannel');
    chSel.innerHTML = '<option value="">— اختر قناة —</option>' +
      channels.map(c => '<option value="'+_esc(c.id)+'">'+_esc(c.name)+' ('+(c.item_count||0)+' صنف)</option>').join('');
    var brSel = document.getElementById('v54CmBranch');
    brSel.innerHTML = '<option value="">كل الفروع</option>' +
      (branches||[]).map(b => '<option value="'+_esc(b.id)+'">'+_esc(b.name||b.id)+'</option>').join('');

    chSel.addEventListener('change', () => _v54CmLoadContent(chSel.value, brSel.value));
    brSel.addEventListener('change', () => _v54CmLoadContent(chSel.value, brSel.value));
    document.getElementById('v54CmCopyBtn').addEventListener('click', () => _v54CmCopyDialog(chSel.value, channels));
  }

  async function _v54CmLoadContent(channelId, branchId){
    var content = document.getElementById('v54CmContent');
    if (!channelId) {
      content.innerHTML = '<div class="v54-empty"><i class="fas fa-arrow-up"></i>اختر قناة من الأعلى للبدء</div>';
      return;
    }
    content.innerHTML = '<div class="v54-empty"><i class="fas fa-spinner fa-spin"></i>جاري التحميل...</div>';
    var qs = branchId ? '?branchId='+encodeURIComponent(branchId) : '';
    const [items, available] = await Promise.all([
      _api('/channel-menus/'+encodeURIComponent(channelId)+qs),
      _api('/channel-menus/'+encodeURIComponent(channelId)+'/available-items'+qs)
    ]);

    content.innerHTML =
      '<div class="v54-stats">' +
        '<div class="v54-stat"><div class="v54-stat-l">إجمالي الأصناف في القناة</div><div class="v54-stat-v">'+items.length+'</div></div>' +
        '<div class="v54-stat"><div class="v54-stat-l">المتوفر للبيع</div><div class="v54-stat-v success">'+items.filter(i=>i.isAvailable).length+'</div></div>' +
        '<div class="v54-stat"><div class="v54-stat-l">المعطّل</div><div class="v54-stat-v warning">'+items.filter(i=>!i.isAvailable).length+'</div></div>' +
        '<div class="v54-stat"><div class="v54-stat-l">أصناف غير مضافة</div><div class="v54-stat-v">'+available.length+'</div></div>' +
      '</div>' +
      '<div class="v54-cm-shell">' +
        '<div class="v54-cm-pane">' +
          '<div class="v54-cm-pane-head">' +
            '<i class="fas fa-list"></i> أصناف القناة الحالية ('+items.length+')' +
            '<button class="v54-btn sm" style="margin-inline-start:auto;" onclick="ERPv54.cmExportCsv()"><i class="fas fa-file-csv"></i> CSV</button>' +
          '</div>' +
          '<div class="v54-cm-pane-list">' +
            (items.length ? items.map(_v54CmItemRow).join('') : '<div class="v54-empty"><i class="fas fa-utensils"></i>لا توجد أصناف بعد</div>') +
          '</div>' +
        '</div>' +
        '<div class="v54-cm-pane">' +
          '<div class="v54-cm-pane-head">' +
            '<i class="fas fa-plus-circle"></i> إضافة من المنيو الرئيسي ('+available.length+')' +
            '<button class="v54-btn sm primary" id="v54CmAddSelected" style="margin-inline-start:auto;"><i class="fas fa-arrow-left"></i> إضافة المحدد</button>' +
          '</div>' +
          '<input type="text" id="v54CmAvailFilter" placeholder="بحث..." style="margin:8px;padding:8px;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:12px;">' +
          '<div class="v54-cm-pane-list" id="v54CmAvailList">' +
            (available.length ? available.map(_v54CmAvailRow).join('') : '<div class="v54-empty"><i class="fas fa-check-circle"></i>كل الأصناف مضافة</div>') +
          '</div>' +
        '</div>' +
      '</div>';
    // Wire add-selected
    document.getElementById('v54CmAddSelected').onclick = async () => {
      const checks = content.querySelectorAll('#v54CmAvailList input[type=checkbox]:checked');
      const ids = [...checks].map(c => c.value);
      if (!ids.length) { alert('حدد أصنافاً أولاً'); return; }
      const r = await _post('/channel-menus/'+encodeURIComponent(channelId)+'/items', {
        itemIds: ids, branchId: branchId || null
      });
      if (r.success) _v54CmLoadContent(channelId, branchId);
      else alert(r.error || 'فشل');
    };
    // Search filter on available items
    document.getElementById('v54CmAvailFilter').addEventListener('input', e => {
      const q = (e.target.value || '').toLowerCase();
      content.querySelectorAll('#v54CmAvailList .v54-cm-item').forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });
    // Cache items for CSV export
    window._v54CmCache = items;
    window._v54CmChannelId = channelId;
    window._v54CmBranchId = branchId;
  }

  function _v54CmItemRow(it){
    return '<div class="v54-cm-item" data-item-id="'+_esc(it.menuItemId)+'" style="border-inline-start:3px solid '+(it.isAvailable?'#16a34a':'#94a3b8')+';">' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="v54-cm-item-name">'+_esc(it.itemName||it.menuItemId)+
          (it.isSemiFinished ? ' <span class="v54-badge v54-badge-yellow">نصف مصنع</span>':'') +
        '</div>' +
        '<div class="v54-cm-item-cat">'+_esc(it.category||'')+
          (it.dailyLimit ? ' • حد يومي: '+it.dailyLimit+(it.soldToday?' (بِيع: '+it.soldToday+')':''):'') +
        '</div>' +
      '</div>' +
      '<div style="text-align:left;">' +
        '<div class="v54-cm-item-price">'+_money(it.effectivePrice)+'</div>' +
        (it.overridePrice != null ? '<div style="font-size:9px;color:#94a3b8;text-decoration:line-through;">'+_money(it.basePrice)+'</div>':'') +
      '</div>' +
      '<button class="v54-btn sm" onclick="ERPv54.cmEditItem(\''+_esc(it.menuItemId)+'\')" aria-label="تعديل"><i class="fas fa-pen"></i></button>' +
      '<button class="v54-btn sm" onclick="ERPv54.cmToggleAvail(\''+_esc(it.menuItemId)+'\','+(it.isAvailable?'false':'true')+')" aria-label="تبديل" title="'+(it.isAvailable?'تعطيل':'تفعيل')+'"><i class="fas '+(it.isAvailable?'fa-eye-slash':'fa-eye')+'"></i></button>' +
      '<button class="v54-btn sm danger" onclick="ERPv54.cmRemove(\''+_esc(it.menuItemId)+'\')" aria-label="حذف"><i class="fas fa-trash"></i></button>' +
    '</div>';
  }
  function _v54CmAvailRow(m){
    return '<div class="v54-cm-item">' +
      '<input type="checkbox" value="'+_esc(m.id)+'">' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="v54-cm-item-name">'+_esc(m.name||m.id)+'</div>' +
        '<div class="v54-cm-item-cat">'+_esc(m.category||'')+(m.brand_name?' • '+_esc(m.brand_name):'')+'</div>' +
      '</div>' +
      '<div class="v54-cm-item-price">'+_money(m.price)+'</div>' +
    '</div>';
  }

  async function cmEditItem(itemId){
    const it = (window._v54CmCache || []).find(x => x.menuItemId === itemId);
    if (!it) return;
    const newPrice = prompt('سعر مخصص (اتركه فارغاً للعودة للسعر الأساسي '+_money(it.basePrice)+'):',
      it.overridePrice != null ? it.overridePrice : '');
    if (newPrice === null) return;
    const dailyLimit = prompt('حد يومي (اتركه فارغاً = بدون حد):', it.dailyLimit || '');
    if (dailyLimit === null) return;
    const body = {
      override_price: newPrice ? Number(newPrice) : null,
      daily_limit: dailyLimit ? Number(dailyLimit) : null,
      branchId: window._v54CmBranchId || null
    };
    const r = await _put('/channel-menus/'+encodeURIComponent(window._v54CmChannelId)+'/items/'+encodeURIComponent(itemId), body);
    if (r.success) _v54CmLoadContent(window._v54CmChannelId, window._v54CmBranchId);
  }
  async function cmToggleAvail(itemId, makeAvailable){
    const r = await _put('/channel-menus/'+encodeURIComponent(window._v54CmChannelId)+'/items/'+encodeURIComponent(itemId),
      { is_available: !!makeAvailable, branchId: window._v54CmBranchId || null });
    if (r.success) _v54CmLoadContent(window._v54CmChannelId, window._v54CmBranchId);
  }
  async function cmRemove(itemId){
    if (!confirm('حذف هذا الصنف من القناة؟')) return;
    const qs = window._v54CmBranchId ? '?branchId='+encodeURIComponent(window._v54CmBranchId) : '';
    const r = await _del('/channel-menus/'+encodeURIComponent(window._v54CmChannelId)+'/items/'+encodeURIComponent(itemId)+qs);
    if (r.success) _v54CmLoadContent(window._v54CmChannelId, window._v54CmBranchId);
  }
  async function _v54CmCopyDialog(channelId, channels){
    if (!channelId) { alert('اختر القناة الهدف أولاً'); return; }
    const others = channels.filter(c => c.id !== channelId);
    if (!others.length) { alert('لا توجد قنوات أخرى للنسخ منها'); return; }
    const list = others.map((c,i) => (i+1)+'. '+c.name+(c.item_count?' ('+c.item_count+' صنف)':'')).join('\n');
    const choice = prompt('اختر رقم القناة المصدر:\n\n'+list);
    if (!choice) return;
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= others.length) return;
    const r = await _post('/channel-menus/'+encodeURIComponent(channelId)+'/copy-from/'+encodeURIComponent(others[idx].id),
      { branchId: window._v54CmBranchId || null });
    if (r.success) {
      alert('تم نسخ '+r.copied+' صنف من '+others[idx].name);
      _v54CmLoadContent(channelId, window._v54CmBranchId);
    }
  }
  function cmExportCsv(){
    const items = window._v54CmCache || [];
    if (!items.length) return;
    let csv = '﻿الصنف,الفئة,السعر الأساسي,السعر المخصص,السعر الفعلي,متاح,حد يومي\n';
    items.forEach(i => {
      csv += [i.itemName||'', i.category||'', i.basePrice||0, i.overridePrice||'',
              i.effectivePrice||0, i.isAvailable?'نعم':'لا', i.dailyLimit||''].join(',') + '\n';
    });
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'channel-menu-'+window._v54CmChannelId+'.csv';
    a.click();
  }

  // ═══════════════════════════════════════════════════════════════════
  // STOCKTAKE PRO
  // ═══════════════════════════════════════════════════════════════════
  async function renderStocktakePro(container){
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    _ensureStyles();
    container.innerHTML =
      '<div class="v54-section">' +
        '<h2 class="v54-h1"><i class="fas fa-clipboard-check" style="color:#16a34a;"></i> الجرد الاحترافي</h2>' +
        '<div class="v54-toolbar">' +
          '<select id="v54StStatus"><option value="">كل الحالات</option>' +
            '<option value="draft">مسودة</option>' +
            '<option value="in_progress">قيد التنفيذ</option>' +
            '<option value="pending_approval">بانتظار الاعتماد</option>' +
            '<option value="approved">معتمد</option>' +
            '<option value="rejected">مرفوض</option>' +
          '</select>' +
          '<button class="v54-btn primary" onclick="ERPv54.stkNew()"><i class="fas fa-plus"></i> جرد جديد</button>' +
        '</div>' +
        '<div id="v54StList"><div class="v54-empty"><i class="fas fa-spinner fa-spin"></i>جاري التحميل...</div></div>' +
      '</div>';
    document.getElementById('v54StStatus').addEventListener('change', _v54StLoadList);
    _v54StLoadList();
  }
  async function _v54StLoadList(){
    var status = (document.getElementById('v54StStatus')||{}).value || '';
    var qs = status ? '?status='+encodeURIComponent(status) : '';
    const rows = await _api('/stocktake-pro'+qs);
    var el = document.getElementById('v54StList');
    if (!rows.length) { el.innerHTML = '<div class="v54-empty"><i class="fas fa-clipboard"></i>لا توجد عمليات جرد. ابدأ بإنشاء جرد جديد.</div>'; return; }
    var statusBadge = function(s){
      var map = {
        draft:        ['مسودة','gray'],
        in_progress:  ['قيد التنفيذ','blue'],
        pending_approval: ['بانتظار الاعتماد','yellow'],
        approved:     ['معتمد','green'],
        rejected:     ['مرفوض','red'],
        cancelled:    ['ملغى','gray']
      };
      var v = map[s] || [s, 'gray'];
      return '<span class="v54-badge v54-badge-'+v[1]+'">'+v[0]+'</span>';
    };
    el.innerHTML = '<table class="v54-table"><thead><tr>' +
      '<th>التاريخ</th><th>المستودع</th><th>الفرع</th><th>طريقة الجرد</th><th>الحالة</th>' +
      '<th>أصناف</th><th>مُعلَّمة</th><th>إجمالي الفرق</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(r => '<tr>' +
        '<td>'+_date(r.stocktake_date)+'</td>' +
        '<td><strong>'+_esc(r.warehouse_name||r.warehouse_id)+'</strong></td>' +
        '<td>'+_esc(r.branch_name||'—')+'</td>' +
        '<td>'+({full:'كامل',cycle:'دوري',spot:'عشوائي',blind:'أعمى'}[r.count_method]||r.count_method||'كامل')+'</td>' +
        '<td>'+statusBadge(r.effective_status)+'</td>' +
        '<td>'+(r.line_count||0)+'</td>' +
        '<td>'+(r.flagged_count>0 ? '<span class="v54-badge v54-badge-red">'+r.flagged_count+'</span>' : 0)+'</td>' +
        '<td style="font-weight:800;color:'+(Number(r.total_variance)<0?'#dc2626':(Number(r.total_variance)>0?'#16a34a':'#64748b'))+';">'+_money(r.total_variance)+'</td>' +
        '<td><button class="v54-btn sm" onclick="ERPv54.stkOpen(\''+_esc(r.id)+'\')"><i class="fas fa-folder-open"></i> فتح</button></td>' +
      '</tr>').join('') + '</tbody></table>';
  }

  async function stkNew(){
    const warehouses = await _api('/erp/warehouses').catch(()=>[]);
    if (!warehouses.length) { alert('لا توجد مستودعات معرّفة'); return; }
    const lines = warehouses.map((w,i) => (i+1)+'. '+(w.name||w.id)).join('\n');
    const choice = prompt('اختر رقم المستودع:\n\n'+lines);
    if (!choice) return;
    const idx = parseInt(choice,10) - 1;
    if (idx < 0 || idx >= warehouses.length) return;
    const wh = warehouses[idx];
    const method = prompt('طريقة الجرد:\n1. full = كامل (كل الأصناف)\n2. cycle = دوري (مجموعة)\n3. spot = عشوائي\n4. blind = أعمى (بدون عرض النظامي)','full') || 'full';
    const threshold = prompt('نسبة الفرق التي تُعتبر مشبوهة (افتراضي 10%):','10') || '10';
    const r = await _post('/stocktake-pro', {
      warehouseId: wh.id, branchId: wh.branch_id || null,
      countMethod: method, varianceThresholdPct: Number(threshold)
    });
    if (r.success) {
      // Auto-load snapshot
      await _post('/stocktake-pro/'+r.id+'/load-snapshot', {});
      stkOpen(r.id);
    } else alert(r.error || 'فشل');
  }

  async function stkOpen(id){
    const data = await _api('/stocktake-pro/'+encodeURIComponent(id));
    if (data.error) { alert(data.error); return; }
    const can = ['draft','in_progress'].includes(data.effective_status);
    const canApprove = data.effective_status === 'pending_approval';
    var html =
      '<div class="v54-section">' +
        '<button class="v54-btn" onclick="ERPv54.renderStocktakePro(document.getElementById(\'erpV5Host\'))"><i class="fas fa-arrow-right"></i> رجوع للقائمة</button>' +
        '<h2 class="v54-h1" style="margin-top:14px;"><i class="fas fa-clipboard-check"></i> جرد '+_esc(data.warehouse_name||data.warehouse_id)+'</h2>' +
        '<div class="v54-stats">' +
          '<div class="v54-stat"><div class="v54-stat-l">إجمالي الأصناف</div><div class="v54-stat-v">'+(data.summary.total_lines||0)+'</div></div>' +
          '<div class="v54-stat"><div class="v54-stat-l">المُعلَّمة (فروقات حادة)</div><div class="v54-stat-v danger">'+(data.summary.flagged_lines||0)+'</div></div>' +
          '<div class="v54-stat"><div class="v54-stat-l">المتحقَّق منها</div><div class="v54-stat-v success">'+(data.summary.verified_lines||0)+'</div></div>' +
          '<div class="v54-stat"><div class="v54-stat-l">إجمالي الفرق (كمية)</div><div class="v54-stat-v">'+_money(data.summary.total_variance_qty)+'</div></div>' +
          '<div class="v54-stat"><div class="v54-stat-l">قيمة الفرق</div><div class="v54-stat-v '+(Number(data.summary.total_variance_value)<0?'danger':'success')+'">'+_money(data.summary.total_variance_value)+'</div></div>' +
        '</div>' +
        '<div class="v54-toolbar">' +
          '<input type="text" id="v54StScan" placeholder="🔍 امسح/أدخل كود الصنف للبحث السريع..." style="flex:1;" '+(can?'':'disabled')+'>' +
          '<input type="number" id="v54StScanQty" placeholder="الكمية الفعلية" style="width:160px;" '+(can?'':'disabled')+'>' +
          '<button class="v54-btn primary" onclick="ERPv54.stkScan(\''+_esc(id)+'\')" '+(can?'':'disabled')+'><i class="fas fa-barcode"></i> تسجيل</button>' +
          '<select id="v54StFilter">' +
            '<option value="all">عرض الكل</option>' +
            '<option value="variance">فروقات فقط</option>' +
            '<option value="flagged">مُعلَّمة فقط</option>' +
            '<option value="verified">متحقَّق منها</option>' +
            '<option value="unverified">غير متحقَّق منها</option>' +
          '</select>' +
          '<a class="v54-btn" href="/api/stocktake-pro/'+encodeURIComponent(id)+'/export" target="_blank"><i class="fas fa-file-csv"></i> تصدير CSV</a>' +
        '</div>' +
        '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">' +
          '<table class="v54-table" id="v54StTable"><thead><tr>' +
            '<th></th><th>الكود</th><th>الصنف</th><th>النظامي</th><th>الفعلي</th><th>الفرق</th><th>%</th><th>قيمة الفرق</th><th>السبب</th><th>متحقَّق</th>' +
          '</tr></thead><tbody id="v54StBody">' +
            data.items.map(it => _v54StRow(it, id, can)).join('') +
          '</tbody></table>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">' +
          (can ? '<button class="v54-btn danger" onclick="ERPv54.stkCancel(\''+_esc(id)+'\')">إلغاء الجرد</button>' : '') +
          (can ? '<button class="v54-btn warning" onclick="ERPv54.stkSubmit(\''+_esc(id)+'\')"><i class="fas fa-paper-plane"></i> تقديم للاعتماد</button>' : '') +
          (canApprove ? '<button class="v54-btn danger" onclick="ERPv54.stkReject(\''+_esc(id)+'\')"><i class="fas fa-times"></i> رفض</button>' : '') +
          (canApprove ? '<button class="v54-btn success" onclick="ERPv54.stkApprove(\''+_esc(id)+'\')"><i class="fas fa-check"></i> اعتماد + ترحيل</button>' : '') +
        '</div>' +
        (data.rejection_reason ? '<div style="margin-top:14px;padding:14px;background:#fee2e2;border:1px solid #fca5a5;border-radius:12px;color:#991b1b;"><strong>سبب الرفض:</strong> '+_esc(data.rejection_reason)+'</div>' : '') +
      '</div>';
    document.getElementById('erpV5Host').innerHTML = html;
    document.getElementById('v54StFilter').addEventListener('change', e => {
      const f = e.target.value;
      document.querySelectorAll('#v54StBody tr').forEach(tr => {
        const isVar = parseFloat(tr.getAttribute('data-variance')||'0') !== 0;
        const isFlag = tr.classList.contains('v54-flagged');
        const isVer = tr.getAttribute('data-verified') === '1';
        let show = true;
        if (f === 'variance') show = isVar;
        else if (f === 'flagged') show = isFlag;
        else if (f === 'verified') show = isVer;
        else if (f === 'unverified') show = !isVer;
        tr.style.display = show ? '' : 'none';
      });
    });
  }

  function _v54StRow(it, stkId, canEdit){
    var flagClass = it.is_flagged ? 'v54-flagged' : '';
    var varColor = Number(it.variance) < 0 ? '#dc2626' : (Number(it.variance) > 0 ? '#16a34a' : '#64748b');
    return '<tr class="'+flagClass+'" data-line-id="'+_esc(it.id)+'" data-variance="'+it.variance+'" data-verified="'+(it.verified_at?'1':'0')+'">' +
      '<td>'+(it.is_flagged?'<i class="fas fa-flag" style="color:#dc2626;" title="فرق مشبوه"></i>':'')+'</td>' +
      '<td style="font-family:monospace;font-size:11px;">'+_esc(it.item_code||'')+'</td>' +
      '<td><strong>'+_esc(it.item_name||it.item_id)+'</strong></td>' +
      '<td>'+_money(it.system_qty)+'</td>' +
      '<td><input type="number" step="0.001" value="'+it.actual_qty+'" '+(canEdit?'':'disabled')+
        ' onchange="ERPv54.stkUpdateLine(\''+_esc(stkId)+'\',\''+_esc(it.id)+'\',this.value)" style="width:100px;padding:6px 8px;border:1.5px solid #e2e8f0;border-radius:8px;"></td>' +
      '<td style="color:'+varColor+';font-weight:800;">'+_money(it.variance)+'</td>' +
      '<td style="font-weight:700;">'+(it.variance_pct||0)+'%</td>' +
      '<td>'+_money(it.variance_value)+' ر.س</td>' +
      '<td>'+
        '<select '+(canEdit?'':'disabled')+' onchange="ERPv54.stkSetReason(\''+_esc(stkId)+'\',\''+_esc(it.id)+'\',this.value)" style="padding:5px 8px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:11px;">' +
          '<option value="">—</option>' +
          ['damage','expiry','theft','count_error','received','transferred','sold','production','other']
            .map(c => '<option value="'+c+'" '+(it.reason_code===c?'selected':'')+'>'+
              ({damage:'تلف',expiry:'انتهاء',theft:'فقد',count_error:'خطأ',received:'استلام',transferred:'تحويل',sold:'بيع',production:'إنتاج',other:'أخرى'}[c])+'</option>').join('') +
        '</select>' +
      '</td>' +
      '<td>'+(it.verified_at ? '<span class="v54-badge v54-badge-green">✓</span>' :
        (canEdit?'<button class="v54-btn sm success" onclick="ERPv54.stkVerifyLine(\''+_esc(stkId)+'\',\''+_esc(it.id)+'\')"><i class="fas fa-check"></i></button>':''))+'</td>' +
    '</tr>';
  }

  async function stkUpdateLine(stkId, lineId, actualQty){
    const r = await _put('/stocktake-pro/'+encodeURIComponent(stkId)+'/items/'+encodeURIComponent(lineId), { actualQty: Number(actualQty) });
    if (r.success) stkOpen(stkId);
  }
  async function stkSetReason(stkId, lineId, reason){
    await _put('/stocktake-pro/'+encodeURIComponent(stkId)+'/items/'+encodeURIComponent(lineId), { reasonCode: reason || null });
  }
  async function stkVerifyLine(stkId, lineId){
    const r = await _put('/stocktake-pro/'+encodeURIComponent(stkId)+'/items/'+encodeURIComponent(lineId), { verified: true });
    if (r.success) stkOpen(stkId);
  }
  async function stkScan(stkId){
    const code = (document.getElementById('v54StScan')||{}).value;
    const qty = (document.getElementById('v54StScanQty')||{}).value;
    if (!code) return;
    const r = await _post('/stocktake-pro/'+encodeURIComponent(stkId)+'/items/scan', { itemCode: code, actualQty: qty?Number(qty):null });
    if (r.error) alert(r.error);
    else {
      document.getElementById('v54StScan').value = '';
      document.getElementById('v54StScanQty').value = '';
      stkOpen(stkId);
    }
  }
  async function stkSubmit(stkId){
    if (!confirm('تقديم الجرد للاعتماد؟ لن تتمكن من التعديل بعدها.')) return;
    const r = await _post('/stocktake-pro/'+encodeURIComponent(stkId)+'/submit', {});
    if (r.success) stkOpen(stkId); else alert(r.error||'فشل');
  }
  async function stkApprove(stkId){
    if (!confirm('اعتماد الجرد + ترحيل التسويات للمخزون؟ هذا الإجراء نهائي.')) return;
    const r = await _post('/stocktake-pro/'+encodeURIComponent(stkId)+'/approve', {});
    if (r.success) { alert('تم الاعتماد. تم ترحيل '+r.movements+' حركة.'); stkOpen(stkId); }
    else alert(r.error||'فشل');
  }
  async function stkReject(stkId){
    const reason = prompt('سبب الرفض (10 أحرف على الأقل):');
    if (!reason || reason.length < 10) return;
    const r = await _post('/stocktake-pro/'+encodeURIComponent(stkId)+'/reject', { reason });
    if (r.success) stkOpen(stkId); else alert(r.error||'فشل');
  }
  async function stkCancel(stkId){
    if (!confirm('إلغاء هذا الجرد نهائياً؟')) return;
    const r = await _post('/stocktake-pro/'+encodeURIComponent(stkId)+'/cancel', {});
    if (r.success) ERPv54.renderStocktakePro(document.getElementById('erpV5Host'));
    else alert(r.error||'فشل');
  }

  global.ERPv54 = {
    renderChannelMenus, renderStocktakePro,
    cmEditItem, cmToggleAvail, cmRemove, cmExportCsv,
    stkNew, stkOpen, stkUpdateLine, stkSetReason, stkVerifyLine, stkScan,
    stkSubmit, stkApprove, stkReject, stkCancel
  };
})(window);
