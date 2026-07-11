// ═══════════════════════════════════════════════════════════════════
// stage-c-demo-seed.mjs — Stage C baseline-screenshot demo data (LOCAL ONLY)
//
// Seeds the LOCAL dev DB (via the running HTTP API on :3000) with:
//   • 6 cost centers (codes STC-01..STC-06, ids CC-STAGEC-01..06)
//   • 8 balanced GL journals tagged reference_type='STAGECDEMO'
//     → 3 left draft, 2 approved, 3 posted, 1 of the posted reversed
//       (the reversal itself is a 9th journal, reference_type='reversal',
//        reference_id=<original STAGECDEMO journal id>)
//
// EVERYTHING is tagged for cleanup — run scripts/stage-c-demo-clean.mjs
// to remove all of it (do NOT run the clean script until the "after"
// screenshots are captured).
//
// Usage:  node scripts/stage-c-demo-seed.mjs   (server must be running on :3000)
// ═══════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const BASE = process.env.SEED_BASE_URL || 'http://localhost:3000';

// ─── read .env (dotenv-style, no override of process env) ───
function readEnv() {
  const e = {};
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
}
const ENV = readEnv();

const token = jwt.sign(
  { id: 1, username: 'admin', role: 'admin', tokenVersion: 1 },
  ENV.JWT_SECRET,
  { expiresIn: '3h' }
);
const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await r.text();
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: r.status, data };
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── main ───
const summary = { costCenters: [], journals: [], reversal: null, notes: [] };

const db = await mysql.createConnection({
  host: ENV.DB_HOST, port: Number(ENV.DB_PORT) || 3306,
  user: ENV.DB_USER, password: ENV.DB_PASSWORD || '', database: ENV.DB_NAME,
});

// ── 0. Local-schema repair (required for POST /gl/journals/:id/post) ──
// routes/erp.js _checkPeriodOpen() selects accounting_periods.period_name,
// but this local DB's accounting_periods was created by an older migration
// WITHOUT that column (it only has period_label). The table is EMPTY, so
// adding the nullable column is a zero-data-impact repair that matches the
// canonical schema in server.js (~line 3539). Without it every journal
// "post" call 500s with "Unknown column 'period_name'".
const [apCols] = await db.query('SHOW COLUMNS FROM accounting_periods');
if (!apCols.some((c) => c.Field === 'period_name')) {
  await db.query('ALTER TABLE accounting_periods ADD COLUMN period_name VARCHAR(20) NULL');
  summary.notes.push('added missing accounting_periods.period_name column (empty table, matches server.js schema)');
}

// ── 1. Cost centers ──
// Try the API first (canonical shape: nameAr/nameEn). The LOCAL cost_centers
// table has the OLD schema (name/type — no name_ar), which makes the current
// endpoint 500 — in that case fall back to a direct INSERT matching the
// actual local columns. Tagged for cleanup: ids CC-STAGEC-*, codes STC-*.
const CC_SEED = [
  { id: 'CC-STAGEC-01', code: 'STC-01', name: 'الإدارة العامة',        type: 'department' },
  { id: 'CC-STAGEC-02', code: 'STC-02', name: 'المطبخ المركزي',        type: 'department' },
  { id: 'CC-STAGEC-03', code: 'STC-03', name: 'فرع العليا',            type: 'branch' },
  { id: 'CC-STAGEC-04', code: 'STC-04', name: 'فرع النخيل',            type: 'branch' },
  { id: 'CC-STAGEC-05', code: 'STC-05', name: 'التسويق والتوصيل',      type: 'department' },
  { id: 'CC-STAGEC-06', code: 'STC-06', name: 'مشروع التوسعة 2026',    type: 'project' },
];

const [ccCols] = await db.query('SHOW COLUMNS FROM cost_centers');
const ccHasNameAr = ccCols.some((c) => c.Field === 'name_ar');

for (const cc of CC_SEED) {
  const [exists] = await db.query('SELECT id FROM cost_centers WHERE id = ?', [cc.id]);
  if (exists.length) { summary.costCenters.push({ ...cc, via: 'already-present' }); continue; }
  let via = 'api';
  if (ccHasNameAr) {
    const r = await api('POST', '/api/erp/cost-centers', {
      code: cc.code, nameAr: cc.name, notes: 'STAGECDEMO', username: 'admin',
    });
    if (!(r.status === 200 || r.status === 201) || !r.data.success) via = 'api-failed:' + JSON.stringify(r.data).slice(0, 120);
  } else {
    via = 'direct-sql (local table has old name/type schema — API endpoint writes name_ar and 500s)';
  }
  if (via !== 'api') {
    await db.query(
      'INSERT INTO cost_centers (id, code, name, type, is_active) VALUES (?,?,?,?,1)',
      [cc.id, cc.code, cc.name, cc.type]
    );
  }
  summary.costCenters.push({ ...cc, via });
}

// ── 2. GL journals (all reference_type = STAGECDEMO) ──
// Entry shape mirrors public/js/erp.js erpSaveJournal() / routes/erp.js
// POST /gl/journals: { accountId, accountCode, accountName, debit, credit, description }.
const accRes = await api('GET', '/api/erp/gl/accounts');
if (accRes.status !== 200 || !Array.isArray(accRes.data)) {
  console.error('FATAL: could not list gl accounts', accRes.status, accRes.data);
  process.exit(1);
}
const byCode = {};
for (const a of accRes.data) byCode[String(a.code)] = a;
const E = (code, debit, credit, description) => {
  const a = byCode[code];
  if (!a) throw new Error('account code not found: ' + code);
  return { accountId: a.id, accountCode: String(a.code), accountName: a.nameAr || a.nameEn || '', debit, credit, description: description || '' };
};
const CC = (i) => ({ costCenterId: CC_SEED[i].id, costCenterName: CC_SEED[i].name });

const JOURNALS = [
  { // → posted
    finalStatus: 'posted', journalDate: dateNDaysAgo(56), ...CC(2),
    description: 'مبيعات نقدية — فرع العليا (بيانات عرض Stage C)',
    entries: [E('11101', 5750, 0, 'نقدية المبيعات'), E('41101', 0, 5000, 'مبيعات مشروبات'), E('21301', 0, 750, 'ضريبة القيمة المضافة 15%')],
  },
  { // → posted
    finalStatus: 'posted', journalDate: dateNDaysAgo(49), ...CC(0),
    description: 'إيجار شهري — المقر الرئيسي (بيانات عرض Stage C)',
    entries: [E('5221', 12000, 0, 'إيجار الفرع'), E('11102', 0, 12000, 'سداد من البنك')],
  },
  { // → posted THEN reversed (reversal journal auto-created)
    finalStatus: 'posted+reversed', journalDate: dateNDaysAgo(42), ...CC(1),
    description: 'مشتريات بن ومواد خام — آجل (بيانات عرض Stage C)',
    entries: [E('5111', 3450, 0, 'بن كولومبي'), E('21101', 0, 3450, 'مورد المواد الغذائية')],
  },
  { // → approved
    finalStatus: 'approved', journalDate: dateNDaysAgo(35), ...CC(0),
    description: 'استحقاق رواتب الشهر (بيانات عرض Stage C)',
    entries: [E('5211', 8500, 0, 'رواتب إدارة'), E('5212', 6200, 0, 'رواتب كاشير وباريستا'), E('21201', 0, 14700, 'رواتب مستحقة')],
  },
  { // → approved
    finalStatus: 'approved', journalDate: dateNDaysAgo(28), ...CC(4),
    description: 'حملة إعلانية — سوشيال ميديا (بيانات عرض Stage C)',
    entries: [E('5242', 2400, 0, 'إعلانات ممولة'), E('11102', 0, 2400, 'سداد بنكي')],
  },
  { // stays draft
    finalStatus: 'draft', journalDate: dateNDaysAgo(21), ...CC(3),
    description: 'فاتورة كهرباء وماء — فرع النخيل (بيانات عرض Stage C)',
    entries: [E('5222', 1850, 0, 'كهرباء وماء'), E('21203', 0, 1850, 'فواتير منافع مستحقة')],
  },
  { // stays draft
    finalStatus: 'draft', journalDate: dateNDaysAgo(14), ...CC(4),
    description: 'مبيعات تطبيقات التوصيل — الأسبوع الجاري (بيانات عرض Stage C)',
    entries: [E('11301', 4025, 0, 'ذمم تطبيقات التوصيل'), E('41201', 0, 3500, 'مبيعات تطبيقات'), E('21301', 0, 525, 'ضريبة القيمة المضافة 15%')],
  },
  { // stays draft
    finalStatus: 'draft', journalDate: dateNDaysAgo(7), ...CC(5),
    description: 'شراء معدات — مشروع التوسعة (بيانات عرض Stage C)',
    entries: [E('121', 15000, 0, 'ماكينة إسبريسو جديدة'), E('11102', 0, 15000, 'سداد بنكي')],
  },
];

for (const j of JOURNALS) {
  const create = await api('POST', '/api/erp/gl/journals', {
    journalDate: j.journalDate,
    referenceType: 'STAGECDEMO',            // ← cleanup tag
    referenceId: '',
    description: j.description,
    notes: 'STAGECDEMO seed — تُحذف عبر stage-c-demo-clean.mjs',
    username: 'admin',
    costCenterId: j.costCenterId, costCenterName: j.costCenterName,
    entries: j.entries,
  });
  if (create.status !== 200 || !create.data.success) {
    console.error('journal create FAILED', j.description, create.status, create.data);
    summary.journals.push({ description: j.description, error: create.data });
    continue;
  }
  const id = create.data.id, journalNumber = create.data.journalNumber;
  const rec = { id, journalNumber, journalDate: j.journalDate, target: j.finalStatus, description: j.description };

  if (j.finalStatus === 'approved' || j.finalStatus.startsWith('posted')) {
    const ap = await api('POST', `/api/erp/gl/journals/${id}/approve`, { username: 'admin' });
    if (!ap.data.success) rec.approveError = ap.data;
  }
  if (j.finalStatus.startsWith('posted')) {
    const po = await api('POST', `/api/erp/gl/journals/${id}/post`, { username: 'admin' });
    if (!po.data.success) rec.postError = po.data;
  }
  if (j.finalStatus === 'posted+reversed') {
    const rv = await api('POST', `/api/erp/gl/journals/${id}/reverse`, { username: 'admin', reason: 'تصحيح — عرض Stage C' });
    if (rv.data.success) {
      summary.reversal = {
        originalId: rv.data.originalJournalId, originalNumber: rv.data.originalJournalNumber,
        reversalId: rv.data.newJournalId, reversalNumber: rv.data.newJournalNumber,
      };
    } else rec.reverseError = rv.data;
  }
  summary.journals.push(rec);
  await sleep(40); // journal id is 'JRN-' + Date.now() — avoid same-ms collisions
}

// ── 3. Verify via the same API the UI uses ──
const list = await api('GET', '/api/erp/gl/journals');
const rows = Array.isArray(list.data) ? list.data : [];
console.log('\n═══ SEED RESULT ═══');
console.log('cost centers:');
for (const c of summary.costCenters) console.log(`  ${c.id}  ${c.code}  ${c.name}  [${c.via}]`);
console.log('journals now in DB (' + rows.length + '):');
for (const r of rows) {
  console.log(`  ${r.journalNumber}  ${String(r.journalDate).slice(0, 10)}  status=${r.status}  ref=${r.referenceType}  D=${r.totalDebit}  «${(r.description || '').slice(0, 45)}»`);
}
if (summary.reversal) console.log('reversal:', JSON.stringify(summary.reversal));
if (summary.notes.length) console.log('notes:', summary.notes.join(' | '));
const errs = summary.journals.filter((x) => x.error || x.approveError || x.postError || x.reverseError);
if (errs.length) { console.log('ERRORS:'); for (const e of errs) console.log(' ', JSON.stringify(e)); }

await db.end();
console.log('\nDone. Cleanup later with: node scripts/stage-c-demo-clean.mjs');
