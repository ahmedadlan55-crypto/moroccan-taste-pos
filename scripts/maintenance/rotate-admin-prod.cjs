#!/usr/bin/env node
'use strict';
/*
 * تدوير كلمة مرور admin على Production — غلاف آمن حول scripts/rotate-admin-password.js
 *
 * ماذا يفعل:
 *   1. يقرأ متغيرات خدمة MySQL في مشروع Railway المرتبط بهذا المجلد (عبر railway CLI).
 *   2. يعرض هوية البيئة فقط (اسم المشروع/البيئة/الخدمة) — لا يطبع DATABASE_URL أو أي سر.
 *   3. ينتظر تأكيدك الصريح بكتابة PRODUCTION.
 *   4. يشغّل أداة التدوير التفاعلية (إدخال مخفي، bcrypt فقط، تحقق ذاتي، سجل تدقيق بلا سر).
 *
 * الاستخدام (من طرفية تفاعلية، داخل مجلد مستودع مرتبط بمشروع الإنتاج عبر railway link):
 *   node scripts/maintenance/rotate-admin-prod.cjs
 *
 * المتطلبات: railway CLI مسجّل الدخول + المجلد مرتبط بمشروع الإنتاج (kind-quietude).
 * لا يغيّر هذا السكربت JWT_SECRET ولا أي Feature Flag.
 */
const { execFileSync, spawnSync } = require('child_process');
const readline = require('readline');
const path = require('path');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('هذه الأداة تفاعلية ويجب تشغيلها من طرفية حقيقية (TTY).');
  process.exit(2);
}

const repoRoot = path.join(__dirname, '..', '..');

let vars;
try {
  const out = execFileSync('railway', ['variables', '-s', 'MySQL', '--json'], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: true,
  });
  vars = JSON.parse(out);
} catch (e) {
  console.error('تعذّر قراءة متغيرات خدمة MySQL من Railway. تأكد من railway login وrailway link لمشروع الإنتاج.');
  process.exit(2);
}

const pub = vars.MYSQL_PUBLIC_URL;
if (!pub) { console.error('MYSQL_PUBLIC_URL غير موجود على خدمة MySQL.'); process.exit(2); }

console.log('');
console.log('════════ تدوير كلمة مرور admin ════════');
console.log('  Railway project : ' + (vars.RAILWAY_PROJECT_NAME || 'غير معروف'));
console.log('  Environment     : ' + (vars.RAILWAY_ENVIRONMENT_NAME || 'غير معروف'));
console.log('  DB service      : ' + (vars.RAILWAY_SERVICE_NAME || 'MySQL'));
console.log('  (لن يُعرض أي Secret أو DATABASE_URL)');
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('إذا كانت هذه هي بيئة Production المقصودة اكتب PRODUCTION ثم Enter: ', (ans) => {
  rl.close();
  if (String(ans).trim() !== 'PRODUCTION') {
    console.log('أُلغي — لم يتم أي تغيير.');
    process.exit(1);
  }
  const env = Object.assign({}, process.env, {
    DATABASE_URL: pub,
    // حيادية كاملة: لا تسمح لملف .env المحلي أو متغيرات أخرى بتوجيه الاتصال
    MYSQL_URL: '', DB_HOST: '', DB_PORT: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '',
  });
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'rotate-admin-password.js')], {
    cwd: repoRoot, env, stdio: 'inherit', windowsHide: true,
  });
  process.exit(r.status == null ? 1 : r.status);
});
