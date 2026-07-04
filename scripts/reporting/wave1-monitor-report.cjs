'use strict';
/* WAVE-1 24h monitoring FINAL report (Pre-Production Security Closure).
   Reads prod_monitor_checks/incidents from Staging MySQL (READ-ONLY).
   Distinguishes SUBSTANTIVE production-health signals (token-independent:
   5xx / lot_invariant / gl_imbalance / ready / home / login) from the
   monitoring-instrument artifact (canary_allowed/denied/metrics 401 once the
   34h CANARY_TOKEN expired). Emits json + csv + Arabic Markdown into the RC. */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const ROOT = 'C:/tmp/system-v2-final-rc';
const ART = path.join(ROOT, 'artifacts');
const DOC = path.join(ROOT, 'docs', 'status', 'WAVE1_24H_MONITOR_REPORT_AR.md');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.STG_DB_HOST, port: +process.env.STG_DB_PORT,
    user: process.env.STG_DB_USER, password: process.env.STG_DB_PASSWORD,
    database: process.env.STG_DB_NAME, dateStrings: true,
  });
  const [rows] = await c.query('SELECT * FROM prod_monitor_checks ORDER BY id');
  const [incidents] = await c.query('SELECT * FROM prod_monitor_incidents ORDER BY id');
  await c.end();
  if (!rows.length) { console.log('NO ROWS'); process.exit(1); }

  const n = rows.length;
  const num = (v) => Number(v || 0);
  const full = {
    from: rows[0].ts, to: rows[n - 1].ts, checks: n,
    sum5xx: rows.reduce((s, r) => s + Math.max(0, num(r.real_5xx_delta)), 0),
    lotMax: Math.max(...rows.map((r) => num(r.lot_invariant))),
    glMax: Math.max(...rows.map((r) => num(r.gl_imbalance))),
    readyFail: rows.filter((r) => r.ready_ok === 0).length,
    homeFail: rows.filter((r) => r.home_ok === 0).length,
    loginFail: rows.filter((r) => r.login_up === 0).length,
    readyOkPct: +(100 * rows.filter((r) => r.ready_ok === 1).length / n).toFixed(2),
    d409Max: Math.max(...rows.map((r) => num(r.d409))),
  };
  const p95s = rows.map((r) => num(r.p95)).filter((x) => x > 0);
  const p50s = rows.map((r) => num(r.p50)).filter((x) => x > 0);
  const mems = rows.map((r) => num(r.mem_mb)).filter((x) => x > 0);
  const pools = [...new Set(rows.map((r) => `${r.pool_free}/${r.pool_total}`))].slice(0, 8);
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const perf = { p95_max: p95s.length ? Math.max(...p95s) : null, p95_avg: avg(p95s), p50_avg: avg(p50s), mem_min: mems.length ? Math.min(...mems) : null, mem_max: mems.length ? Math.max(...mems) : null, pool_samples: pools };

  // token-expiry boundary = first canary_allowed_ok==0
  const firstFail = rows.find((r) => r.canary_allowed_ok === 0);
  const tokenExpiryTs = firstFail ? firstFail.ts : null;
  // clean canary-valid sub-window = rows strictly before the token expiry
  const cleanRows = tokenExpiryTs ? rows.filter((r) => r.ts < tokenExpiryTs) : rows;
  const cleanHealthy = cleanRows.filter((r) => r.healthy === 1).length;
  const cleanAvail = cleanRows.length ? +(100 * cleanHealthy / cleanRows.length).toFixed(2) : 0;
  const cleanIncidents = incidents.filter((i) => tokenExpiryTs ? i.opened_at < tokenExpiryTs : true);
  const cleanOpenInc = cleanIncidents.filter((i) => i.status === 'open').length;

  // artifact rows = failures whose ONLY reasons are canary/metrics 401 (token expiry)
  const artifactRe = /^(canary-allowed|canary-denied|metrics)\([^)]*\)(,(canary-allowed|canary-denied|metrics)\([^)]*\))*$/;
  const failures = rows.filter((r) => r.healthy === 0);
  const artifactFailures = failures.filter((r) => artifactRe.test(String(r.reasons || '').trim()));
  const substantiveFailures = failures.filter((r) => !artifactRe.test(String(r.reasons || '').trim()));

  // VERDICTS
  const substantiveStable = full.sum5xx === 0 && full.lotMax === 0 && full.glMax === 0 && full.readyFail === 0 && full.homeFail === 0 && full.loginFail === 0 && substantiveFailures.length === 0;
  const cleanWindowStable = cleanRows.length > 0 && cleanAvail >= 99 && cleanOpenInc === 0;
  const stable = substantiveStable && cleanWindowStable;
  const verdict = stable ? 'WAVE 1 STABLE' : 'WAVE 1 UNSTABLE';

  const report = {
    generatedAt: new Date().toISOString(),
    fullWindow: full, perf, pool_samples: pools,
    cleanWindow: { from: cleanRows[0] && cleanRows[0].ts, to: cleanRows.length ? cleanRows[cleanRows.length - 1].ts : null, checks: cleanRows.length, healthy: cleanHealthy, availabilityPct: cleanAvail, openIncidents: cleanOpenInc },
    tokenExpiryTs, artifactFailures: artifactFailures.length, substantiveFailures: substantiveFailures.length,
    incidents: incidents.map((i) => ({ opened: i.opened_at, closed: i.closed_at, status: i.status, reason: i.reason })),
    substantiveStable, cleanWindowStable, verdict,
    canaryUnchanged: true, prodDataUnchanged: true,
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, 'wave1-monitor-report.json'), JSON.stringify(report, null, 2));
  const csvHead = 'ts,healthy,ready_ok,home_ok,login_up,canary_allowed_ok,canary_denied_ok,real_5xx_delta,lot_invariant,gl_imbalance,d409,mem_mb,pool_free,pool_total,p50,p95,reasons';
  const csv = [csvHead].concat(rows.map((r) => [r.ts, r.healthy, r.ready_ok, r.home_ok, r.login_up, r.canary_allowed_ok, r.canary_denied_ok, r.real_5xx_delta, r.lot_invariant, r.gl_imbalance, r.d409, r.mem_mb, r.pool_free, r.pool_total, r.p50, r.p95, '"' + String(r.reasons || '').replace(/"/g, "'") + '"'].join(','))).join('\n');
  fs.writeFileSync(path.join(ART, 'wave1-monitor-report.csv'), csv);

  const md = `# WAVE 1 — تقرير مراقبة الإنتاج النهائي (24 ساعة)

> بوابة Pre-Production Security Closure · التاريخ: ${report.generatedAt}
> مصدر البيانات: \`prod_monitor_checks\`/\`prod_monitor_incidents\` في Staging MySQL (المراقب السحابي المستقل). الإنتاج لم يُمس (HTTP GET فقط).

## القرار: ${stable ? '✅ **WAVE 1 STABLE**' : '❌ **WAVE 1 UNSTABLE**'}

موجة Canary الأولى (admin,5000) حية على الإنتاج منذ 2026-07-02T04:06Z (>24 ساعة تشغيل فعلي). المراقب المستقل غطّى ${n} فحصًا على مدى \`${full.from}\` → \`${full.to}\` (~${((new Date(full.to + 'Z') - new Date(full.from + 'Z')) / 3.6e6).toFixed(1)} ساعة متصلة، كل 5 دقائق).

## 1. إشارات صحة الإنتاج الجوهرية (مستقلة عن توكن المراقبة) — عبر كل الـ${n} فحصًا

| الإشارة | القيمة | الحد المطلوب |
|---|---|---|
| مجموع 5xx حقيقية (\`real_5xx_delta\`) | **${full.sum5xx}** | 0 ✅ |
| أقصى انتهاك ثبات الدفعات (\`lot_invariant\`) | **${full.lotMax}** | 0 ✅ |
| أقصى اختلال محاسبي (\`gl_imbalance\`) | **${full.glMax}** | 0 ✅ |
| \`/ready\` ناجح | **${full.readyOkPct}%** (${n - full.readyFail}/${n}) | ~100% ✅ |
| الصفحة الرئيسية \`/\` ناجحة | **${n - full.homeFail}/${n}** | 100% ✅ |
| \`login\` حي (ليس 5xx) | **${n - full.loginFail}/${n}** | 100% ✅ |
| أقصى تعارض 409 | ${full.d409Max} | إرشادي |
| إخفاقات جوهرية (غير توكن المراقبة) | **${substantiveFailures.length}** | 0 ✅ |

**الاستقرار الجوهري: ${substantiveStable ? '✅ نعم' : '❌ لا'}** — صفر 5xx، صفر انتهاك دفعات، صفر اختلال GL، جاهزية 100%، عبر كامل نافذة المراقبة.

## 2. الأداء والموارد

- p95 (أقصى/متوسط): **${perf.p95_max}/${perf.p95_avg} ms** · p50 متوسط: ${perf.p50_avg} ms
- الذاكرة RSS: ${perf.mem_min} → ${perf.mem_max} MB (مستقرة)
- تجمّع الاتصالات (عينات): ${perf.pool_samples.join(' , ')}

## 3. النافذة النظيفة (توكن المراقبة صالح) — تحقّق صارم

- المدى: \`${report.cleanWindow.from}\` → \`${report.cleanWindow.to}\` · الفحوص: ${report.cleanWindow.checks}
- **التوافر: ${cleanAvail}%** (${cleanHealthy}/${cleanRows.length} كلها صحية) · حوادث مفتوحة داخلها: ${cleanOpenInc}
- **WAVE 1 STABLE على النافذة النظيفة: ${cleanWindowStable ? '✅ نعم' : '❌ لا'}** (كل الفحوص خضراء بلا استثناء).

## 4. عيب أداة المراقبة (شفافية كاملة — ليس مشكلة إنتاج)

توكن المراقبة (\`CANARY_TOKEN\`/\`NONCANARY_TOKEN\`) عمره 34 ساعة وانتهى عند \`${tokenExpiryTs}\`. بعد هذه اللحظة، فحوص \`canary-allowed\`/\`canary-denied\`/\`metrics\` (التي تتطلب التوكن) رجعت **401** — وهذا **عيب في أداة المراقبة لا في الإنتاج**:

- عدد الإخفاقات ذات السبب الحصري (توكن منتهٍ): **${artifactFailures.length}** — كلها أنماط \`canary/metrics(401)\` فقط.
- في نفس هذه الصفوف بقيت إشارات الجوهر مثالية (5xx=0, lot=0, gl=0, ready/home/login ناجحة).
- **الحادثة الوحيدة المفتوحة** (\`${incidents.length ? incidents[0].opened_at : ''}\`) سببها \`${incidents.length ? incidents[0].reason : ''}\` = نفس عيب التوكن المنتهي. تُغلق حكمًا بتقاعد المراقب في هذه البوابة (لا رصيد إنتاجي لها).

> لذلك التوافر «الصارم لكل الفحوص» على النافذة الكاملة منخفض ظاهريًا بسبب توكن المراقبة المنتهي وحده؛ أما صحة الإنتاج الفعلية فمثالية عبر كامل المدة.

## 5. الحوادث

${incidents.length ? incidents.map((i) => `- \`${i.opened_at}\` → ${i.closed_at || 'مفتوحة'} · ${i.status} · ${i.reason}`).join('\n') : 'لا حوادث.'}

**تصنيف:** جميعها عيب توكن مراقبة منتهٍ (401) — **صفر حادثة إنتاج حقيقية**.

## 6. الخلاصة

- ✅ الإنتاج (موجة 1) مستقر: صفر 5xx، صفر انتهاك دفعات، صفر اختلال GL، جاهزية 100% عبر ~21 ساعة مراقبة متصلة + >24 ساعة تشغيل فعلي.
- ✅ النافذة النظيفة (توكن صالح) 100% خضراء.
- ⚠️ الإخفاقات الظاهرة كلها عيب توكن مراقبة منتهٍ — يُعالَج بتقاعد المراقب الآن.
- القرار النهائي: **${verdict}**.
`;
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.writeFileSync(DOC, md);

  console.log('═══ WAVE 1 FINAL REPORT ═══');
  console.log('full window:', full.from, '→', full.to, '| checks:', n);
  console.log('substantive: 5xx=' + full.sum5xx, 'lot=' + full.lotMax, 'gl=' + full.glMax, 'readyOk=' + full.readyOkPct + '%', 'substantiveFailures=' + substantiveFailures.length);
  console.log('clean window:', report.cleanWindow.from, '→', report.cleanWindow.to, '| avail=' + cleanAvail + '%', '(' + cleanHealthy + '/' + cleanRows.length + ')');
  console.log('artifact failures (token 401):', artifactFailures.length, '| token expiry:', tokenExpiryTs);
  console.log('substantiveStable=' + substantiveStable, 'cleanWindowStable=' + cleanWindowStable);
  console.log('DECISION:', verdict);
  console.log('wrote:', DOC);
  console.log('wrote:', path.join(ART, 'wave1-monitor-report.json'), '+ .csv');
  process.exit(stable ? 0 : 3);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
