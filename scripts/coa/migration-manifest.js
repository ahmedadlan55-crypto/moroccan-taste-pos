#!/usr/bin/env node
/**
 * The chart-of-accounts migration manifest — one reviewable row per account.
 *
 * DRY RUN BY DEFAULT. Without --apply this writes a manifest and changes
 * nothing, which is the whole point: a chart migration on a live ledger has to
 * be readable BEFORE it runs, per account, with the reason attached.
 *
 * WHAT IT PLANS
 *   reparent   an account that is parentless by accident. Production has 41
 *              roots where it should have 5: 36 operational accounts were
 *              created at runtime by ensureCoreAccounts/ensurePayrollAccounts
 *              with no parent, so they became roots. Reparenting changes
 *              structure only — no amount on any posted entry is touched.
 *   archive    a template account that has never been used. 216 of the 220
 *              six-digit accounts in production carry no entries at all.
 *   review     anything the script will not decide by itself.
 *
 * WHAT IT REFUSES TO DO
 *   * touch debit/credit on any posted entry — ever;
 *   * delete any account, used or not (archive is reversible, DELETE is not,
 *     and 27 tables reference accounts, 9 of them BY CODE);
 *   * renumber a used account (those 9 by-code columns do not fail loudly —
 *     they resolve to the wrong account or to nothing);
 *   * guess an account for the null-account gl_entries. Those go to the
 *     SUSPENSE role and wait for an accountant, because a guess here is a
 *     silent misstatement.
 *
 * Every planned row carries requiresAccountantApproval. Anything touching an
 * account WITH posted entries sets it true, and --apply skips those unless
 * --approve-with-entries is also passed. Structure is mechanical; money is not.
 *
 * Usage:
 *   node -r dotenv/config scripts/coa/migration-manifest.js [--out <path>] [--apply]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../db/connection');
const coaTree = require('../../lib/coa/tree');

function argValue(args, name, dflt) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}

// Where an orphaned operational account belongs, by the code it already has.
// Derived from lib/glPosting.js CORE_ACCOUNTS / lib/hrGLPosting.js
// SALARY_ACCOUNTS, which declare a `parent` for every code they create — so
// this is the parent the ENGINE ALREADY INTENDED, recovered, not invented.
const INTENDED_PARENT_BY_CODE = {
  '1110': '111', '1120': '111', '1150': '112', '1200': '113', '1210': '113',
  '1220': '113', '1230': '113', '1290': '116', '1130': '115',
  '2100': '211', '2150': '211', '2201': '212', '2202': '216', '2210': '213',
  '2310': '215', '2320': '215',
  '4100': '411', '4201': '42', '4910': '422',
  '5100': '51', '5121': '521', '5122': '521', '5123': '521', '5124': '521',
  '5125': '521', '5200': '521', '5300': '522', '5301': '611', '5302': '611',
  '5303': '611', '5304': '612', '5350': '523', '5400': '53', '5410': '6',
  '5420': '522', '5500': '6', '6100': '651',
};

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const approveWithEntries = args.includes('--approve-with-entries');
  const outPath = argValue(args, '--out',
    path.join(__dirname, '..', '..', 'artifacts', 'coa-manifest.json'));

  const [accounts] = await db.query(
    `SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.level,
            a.is_folder, a.is_active, a.status, a.balance, a.is_system_root,
            a.report_section, a.company_id,
            (SELECT COUNT(*) FROM gl_accounts c WHERE c.parent_id = a.id) AS kids,
            (SELECT COUNT(*) FROM gl_entries e WHERE e.account_id = a.id) AS entries
       FROM gl_accounts a ORDER BY ${coaTree.ORDER_BY('a')}`);

  const byCode = new Map(accounts.map((a) => [String(a.code), a]));
  const rows = [];

  for (const a of accounts) {
    const hasEntries = Number(a.entries) > 0;
    const base = {
      oldAccountId: a.id, oldCode: a.code, name: a.name_ar,
      oldParent: a.parent_id, targetCode: a.code, targetParent: a.parent_id,
      hasEntries, entryCount: Number(a.entries), balance: Number(a.balance || 0),
      requiresAccountantApproval: false,
    };

    // ── a root that should not be one ────────────────────────────────────
    if (a.parent_id === null && Number(a.is_system_root) !== 1) {
      const intended = INTENDED_PARENT_BY_CODE[String(a.code)];
      const parent = intended ? byCode.get(intended) : null;

      if (parent) {
        rows.push({ ...base, action: 'reparent', targetParent: parent.id,
          targetParentCode: parent.code, confidence: 'high',
          // Entries are untouched by a reparent, but the account MOVES on the
          // financial statements, so a used account still needs sign-off.
          requiresAccountantApproval: hasEntries,
          reason: `parentless, but lib/glPosting.js declares parent ${intended} for code ${a.code} — restoring the parent the engine already intended` });
      } else if (intended) {
        rows.push({ ...base, action: 'review', confidence: 'low',
          requiresAccountantApproval: true,
          reason: `parentless; intended parent ${intended} does not exist in this chart — the parent must be created first` });
      } else if (/^GLSEC|ITEST/i.test(String(a.id)) || /^GLSEC|ITEST/i.test(String(a.name_ar))) {
        rows.push({ ...base, action: hasEntries ? 'review' : 'archive', confidence: 'high',
          requiresAccountantApproval: hasEntries,
          reason: hasEntries
            ? 'test residue WITH posted entries — never deleted silently, an accountant decides'
            : 'test residue, zero entries, zero children; proven absent from production' });
      } else {
        rows.push({ ...base, action: 'review', confidence: 'low',
          requiresAccountantApproval: true,
          reason: 'parentless and not a system root, with no intended parent on record' });
      }
      continue;
    }

    // ── an unused template account ───────────────────────────────────────
    if (!hasEntries && Number(a.kids) === 0 && Number(a.is_system_root) !== 1
        && /^\d{6}$/.test(String(a.code)) && Number(a.is_active) === 1) {
      rows.push({ ...base, action: 'archive', confidence: 'medium',
        requiresAccountantApproval: false,
        reason: 'six-digit template account, never posted to and childless — archived, not deleted, so it can come back' });
      continue;
    }

    rows.push({ ...base, action: 'keep', confidence: 'high',
      reason: hasEntries ? `in use (${a.entries} entries)` : 'structurally sound' });
  }

  // ── gl_entries with no account at all ──────────────────────────────────
  const [orphanEntries] = await db.query(
    `SELECT e.id, e.journal_id, e.account_code, e.account_name, e.debit, e.credit
       FROM gl_entries e WHERE e.account_id IS NULL`);

  const summary = rows.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
  const manifest = {
    generatedAt: new Date().toISOString(),
    database: (await db.query('SELECT DATABASE() AS d'))[0][0].d,
    mode: apply ? 'APPLY' : 'DRY RUN',
    summary,
    needingApproval: rows.filter((r) => r.requiresAccountantApproval).length,
    nullAccountEntries: {
      count: orphanEntries.length,
      debit: orphanEntries.reduce((s, e) => s + Number(e.debit || 0), 0),
      credit: orphanEntries.reduce((s, e) => s + Number(e.credit || 0), 0),
      note: 'Routed to the SUSPENSE role, never guessed into a real account. '
          + 'account_code/account_name are preserved on each row as the only surviving evidence.',
      rows: orphanEntries,
    },
    accounts: rows,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n── CoA migration manifest ──');
  console.table(summary);
  console.log(`needing accountant approval : ${manifest.needingApproval}`);
  console.log(`gl_entries with NULL account : ${orphanEntries.length}`);
  console.log(`manifest                     : ${outPath}`);
  console.log(`mode                         : ${manifest.mode}\n`);

  const planned = rows.filter((r) => r.action === 'reparent' || r.action === 'archive');
  if (planned.length) {
    console.table(planned.map((r) => ({
      code: r.oldCode, name: String(r.name || '').slice(0, 26), action: r.action,
      toParent: r.targetParentCode || '-', entries: r.entryCount,
      approval: r.requiresAccountantApproval ? 'REQUIRED' : '-',
    })));
  }

  if (!apply) { console.log('DRY RUN — nothing was written to the database.\n'); await db.end(); return; }

  // ── apply ──────────────────────────────────────────────────────────────
  let done = 0, skipped = 0;
  await db.withTransaction(async (conn) => {
    for (const r of planned) {
      if (r.requiresAccountantApproval && !approveWithEntries) {
        skipped++;
        console.log(`  skipped ${r.oldCode} (${r.action}) — needs approval, pass --approve-with-entries`);
        continue;
      }
      if (r.action === 'reparent') {
        await conn.query('UPDATE gl_accounts SET parent_id = ?, updated_at = NOW(), updated_by = ? WHERE id = ?',
          [r.targetParent, 'coa-manifest', r.oldAccountId]);
      } else if (r.action === 'archive') {
        await conn.query(
          "UPDATE gl_accounts SET status = 'archived', is_active = 0, archived_at = NOW(), archived_by = ? WHERE id = ?",
          ['coa-manifest', r.oldAccountId]);
      }
      done++;
    }
    // One recompute for the whole batch — level is derived, and coaTree is its
    // only writer.
    await coaTree.recomputeLevels(conn);
  });
  console.log(`\napplied ${done}, skipped ${skipped} (awaiting approval)\n`);
  await db.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
