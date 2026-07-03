#!/usr/bin/env node
/**
 * rotate-admin-password.js — أداة تدوير كلمة مرور مستخدم (افتراضيًا admin) بأمان.
 *
 * الاستخدام:
 *   node scripts/rotate-admin-password.js [--user <username>]
 *
 * تتصل بقاعدة البيانات عبر نفس إعدادات التطبيق (DATABASE_URL أو DB_* في .env).
 * لتشغيلها على Production: صدّر DATABASE_URL الخاص بالإنتاج في جلسة طرفية آمنة
 * ثم شغّل الأداة — المالك يكتب كلمة المرور بنفسه بإدخال مخفي.
 *
 * الضمانات:
 *   - الإدخال مخفي تمامًا (لا يظهر على الشاشة ولا في history).
 *   - لا تُطبع كلمة المرور ولا تُحفظ نصيًا في أي مكان (ملف/سجل/DB).
 *   - يُخزَّن bcrypt hash فقط (cost 12).
 *   - تحقق ذاتي بعد التحديث: الهاش الجديد يطابق الكلمة الجديدة،
 *     والهاش القديم لا يطابقها (إثبات أن الكلمة تغيّرت فعلًا).
 *   - يصفّر failed_attempts/locked_until ويسجل حدث audit_log بدون أي سر.
 */
'use strict';

const readline = require('readline');
const bcrypt = require('bcryptjs');

const MIN_LENGTH = 12;

function parseArgs(argv) {
  const out = { user: 'admin' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--user' && argv[i + 1]) { out.user = argv[++i]; }
    else if (argv[i] === '--help' || argv[i] === '-h') { out.help = true; }
  }
  return out;
}

/** يقرأ سطرًا من stdin مع إخفاء كامل للأحرف المُدخلة. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    let muted = false;
    process.stdout.write = function (chunk, ...rest) {
      if (muted) {
        // نسمح فقط بسطر جديد عند الإنهاء حتى لا يلتصق الإخراج
        if (typeof chunk === 'string' && chunk.includes('\n')) return stdoutWrite('\n');
        return true;
      }
      return stdoutWrite(chunk, ...rest);
    };
    rl.question(question, (answer) => {
      muted = false;
      process.stdout.write = stdoutWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
    rl.on('SIGINT', () => {
      muted = false;
      process.stdout.write = stdoutWrite;
      rl.close();
      reject(new Error('cancelled'));
    });
  });
}

function validateStrength(pw) {
  const problems = [];
  if (!pw || pw.length < MIN_LENGTH) problems.push(`الطول ${MIN_LENGTH} حرفًا على الأقل`);
  if (!/[A-Za-z]/.test(pw)) problems.push('حرف لاتيني واحد على الأقل');
  if (!/[0-9]/.test(pw)) problems.push('رقم واحد على الأقل');
  if (/^(admin|password|123456|admin123)/i.test(pw)) problems.push('لا تبدأ بكلمة شائعة (admin/password/123456)');
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('node scripts/rotate-admin-password.js [--user <username>]');
    process.exit(0);
  }
  if (!process.stdin.isTTY) {
    console.error('✗ هذه أداة تفاعلية — شغّلها من طرفية حقيقية (TTY) حتى يبقى الإدخال مخفيًا.');
    process.exit(1);
  }

  const db = require('../db/connection');
  try {
    const [rows] = await db.query(
      'SELECT id, username, password FROM users WHERE username = ? LIMIT 1', [args.user]
    );
    if (!rows.length) {
      console.error(`✗ المستخدم "${args.user}" غير موجود.`);
      process.exit(1);
    }
    const user = rows[0];
    const oldHash = user.password || '';

    console.log(`تدوير كلمة مرور المستخدم: ${user.username} (id=${user.id})`);
    console.log('اكتب كلمة المرور الجديدة (لن تظهر على الشاشة):');

    const pw1 = await promptHidden('كلمة المرور الجديدة: ');
    const problems = validateStrength(pw1);
    if (problems.length) {
      console.error('✗ كلمة المرور ضعيفة — المطلوب: ' + problems.join('، '));
      process.exit(1);
    }
    const pw2 = await promptHidden('أعد كتابتها للتأكيد: ');
    if (pw1 !== pw2) {
      console.error('✗ الإدخالان غير متطابقين. لم يتغير شيء.');
      process.exit(1);
    }
    if (oldHash && await bcrypt.compare(pw1, oldHash)) {
      console.error('✗ الكلمة الجديدة مطابقة للقديمة. اختر كلمة مختلفة. لم يتغير شيء.');
      process.exit(1);
    }

    const newHash = await bcrypt.hash(pw1, 12);

    await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        `UPDATE users SET password = ?, failed_attempts = 0, locked_until = NULL WHERE id = ? AND username = ?`,
        [newHash, user.id, user.username]
      );
      if (!r.affectedRows) throw new Error('UPDATE لم يطابق أي صف — أُلغيت العملية.');
      // حدث تدقيق بدون أي سر
      try {
        await conn.query(
          `INSERT INTO audit_log (id, user_id, username, action, table_name, record_id, new_value, created_at)
           VALUES (?, ?, ?, 'password_rotated', 'users', ?, ?, NOW())`,
          ['AUD-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
           String(user.id), user.username, String(user.id),
           JSON.stringify({ rotatedBy: 'rotate-admin-password.js', hashAlgo: 'bcrypt', cost: 12 })]
        );
      } catch (e) { /* audit best-effort — لا يكسر التدوير */ }
    });

    // تحقق ذاتي من قاعدة البيانات مباشرة
    const [after] = await db.query('SELECT password FROM users WHERE id = ?', [user.id]);
    const storedHash = after[0] && after[0].password;
    const newWorks = storedHash ? await bcrypt.compare(pw1, storedHash) : false;
    const oldStillMatches = oldHash ? await bcrypt.compare(pw1, oldHash) : false;

    if (!newWorks) {
      console.error('✗ فشل التحقق: الهاش المخزن لا يطابق الكلمة الجديدة! افحص قاعدة البيانات فورًا.');
      process.exit(2);
    }
    console.log('✓ الكلمة الجديدة تعمل (bcrypt.compare ضد الهاش المخزن نجح).');
    console.log(oldStillMatches
      ? '⚠ تحذير غير متوقع: الكلمة الجديدة تطابق الهاش القديم.'
      : '✓ الكلمة القديمة لم تعد صالحة (الهاش تغيّر والكلمة الجديدة مختلفة عنه).');
    console.log('✓ اكتمل التدوير. لم يُحفظ أي نص صريح في أي مكان.');
    process.exit(0);
  } finally {
    try { await db.end(); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => {
  if (e && e.message === 'cancelled') {
    console.error('\n✗ أُلغيت العملية. لم يتغير شيء.');
  } else {
    console.error('✗ خطأ:', e.message);
  }
  process.exit(1);
});
