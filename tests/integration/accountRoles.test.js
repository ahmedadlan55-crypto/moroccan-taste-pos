'use strict';
/* Integration — Account Role Registry writer + lookup (lib/accountRoles.js),
 * real DB, no HTTP server needed.
 *
 * Tier A.1 Corrective Gate, item 5. Covers success, failure, and concurrent-
 * modification paths for setAccountRole(), plus the company-scope fix from
 * migration 0015 (same role_key must be allowed across different
 * companies, blocked within the same one).
 *
 * Run: node tests/integration/accountRoles.test.js
 */
require('dotenv').config();
const db = require('../../db/connection');
const { getAccountByRole, setAccountRole, AccountRoleError } = require('../../lib/accountRoles');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function assertTestEnvironment() {
  const looksProd = !!(process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQLHOST);
  const dbName = process.env.DB_NAME || process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || '';
  if (looksProd || (dbName && dbName !== 'moroccan_taste_pos')) {
    console.error('REFUSING TO RUN: non-local database detected.');
    process.exit(2);
  }
}

const IDS = {
  companyB: 'ITEST-AR-COMPANY-B',
  leafAsset: 'ITEST-AR-LEAF-ASSET',
  leafLiability: 'ITEST-AR-LEAF-LIAB',
  folder: 'ITEST-AR-FOLDER',
};

// Catalog role keys are a small, curated whitelist (setAccountRole rejects
// anything not in lib/accountRoleCatalog.js), so the success-path tests
// below use REAL keys (CASH_ON_HAND, INVENTORY) rather than an ITEST_*
// fake one. Isolation instead comes from scoping every write to either the
// dedicated ITEST accounts/company created here, or to a role_key this
// suite always cleans up explicitly by name.
const TEST_ROLE_KEYS = ['CASH_ON_HAND', 'INVENTORY'];

async function cleanup() {
  try { await db.query('DELETE FROM account_role_history WHERE role_key IN (?, ?)', TEST_ROLE_KEYS); } catch (_) {}
  try { await db.query('DELETE FROM account_roles WHERE role_key IN (?, ?)', TEST_ROLE_KEYS); } catch (_) {}
  try { await db.query('DELETE FROM account_role_history WHERE role_key = ?', ['ITEST_NOT_IN_CATALOG_UNUSED']); } catch (_) {}
  for (const id of [IDS.leafAsset, IDS.leafLiability, IDS.folder]) {
    try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {}
  }
  try { await db.query('DELETE FROM companies WHERE id = ?', [IDS.companyB]); } catch (_) {}
}

async function tableCounts() {
  const out = {};
  for (const t of ['companies', 'gl_accounts', 'account_roles', 'account_role_history']) {
    const [[r]] = await db.query('SELECT COUNT(*) n FROM ' + t);
    out[t] = r.n;
  }
  return out;
}

async function setupFixtures() {
  const [[parentAcc]] = await db.query("SELECT id FROM gl_accounts WHERE code = '111' LIMIT 1");
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
    [IDS.leafAsset, 'ITEST900030', 'حساب أصل قابل للترحيل (ITEST)', 'asset', parentAcc.id, 4]
  );
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,0)',
    [IDS.leafLiability, 'ITEST900031', 'حساب التزام قابل للترحيل (ITEST)', 'liability', parentAcc.id, 4]
  );
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,?,1,1)',
    [IDS.folder, 'ITEST900032', 'Folder (ITEST)', 'asset', parentAcc.id, 4]
  );
  await db.query(
    "INSERT INTO companies (id, name, base_currency) VALUES (?, ?, 'SAR')",
    [IDS.companyB, 'شركة اختبار ثانية (ITEST)']
  );
}

(async () => {
  assertTestEnvironment();
  await cleanup();
  const before = await tableCounts();

  try {
    console.log('\n═══ Account Role Registry (writer + lookup) ═══');
    await setupFixtures();
    const [[mainCompany]] = await db.query('SELECT id FROM companies LIMIT 1');
    const companyId = mainCompany.id;

    // ── success: create a new mapping ──
    const created = await setAccountRole(db, {
      roleKey: 'CASH_ON_HAND', companyId, accountId: IDS.leafAsset,
      actor: 'itest-actor', reason: 'initial mapping for test',
    });
    check('setAccountRole creates a new mapping (version=1)', created.created === true && created.version === 1, created);

    const resolved = await getAccountByRole(db, 'CASH_ON_HAND', { companyId });
    check('getAccountByRole resolves the newly-created mapping', resolved.accountId === IDS.leafAsset, resolved);

    // ── reassign with correct expectedVersion -> success, version bumps, history written ──
    const [[otherAsset]] = await db.query("SELECT id FROM gl_accounts WHERE code = '1110' LIMIT 1");
    const reassigned = await setAccountRole(db, {
      roleKey: 'CASH_ON_HAND', companyId, accountId: otherAsset.id,
      actor: 'itest-actor-2', reason: 'reassigning to the real cash account', expectedVersion: 1,
    });
    check('reassigning with correct expectedVersion succeeds (version=2)', reassigned.created === false && reassigned.version === 2, reassigned);
    const [historyRows] = await db.query('SELECT old_account_id, new_account_id, reason, changed_by FROM account_role_history WHERE role_key = ? ORDER BY changed_at', ['CASH_ON_HAND']);
    check('account_role_history has 2 rows (create + reassign) with old/new account ids recorded', historyRows.length === 2 && historyRows[1].old_account_id === IDS.leafAsset && historyRows[1].new_account_id === otherAsset.id, historyRows);

    // ── stale expectedVersion -> ACCOUNT_ROLE_VERSION_CONFLICT (simulates a concurrent writer) ──
    let conflictCode = null, conflictDetails = null;
    try {
      await setAccountRole(db, {
        roleKey: 'CASH_ON_HAND', companyId, accountId: IDS.leafAsset,
        actor: 'itest-actor-3', reason: 'stale write attempt', expectedVersion: 1, // stale — real version is now 2
      });
    } catch (e) {
      conflictCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE';
      conflictDetails = e.details;
    }
    check('stale expectedVersion is rejected as ACCOUNT_ROLE_VERSION_CONFLICT (concurrent-modification guard)', conflictCode === 'ACCOUNT_ROLE_VERSION_CONFLICT', { conflictCode, conflictDetails });
    const [[stillV2]] = await db.query('SELECT version, account_id FROM account_roles WHERE role_key = ? AND company_id = ?', ['CASH_ON_HAND', companyId]);
    check('the rejected write did not change the mapping', stillV2.version === 2 && stillV2.account_id === otherAsset.id, stillV2);

    // ── reassign without expectedVersion at all -> ACCOUNT_ROLE_VERSION_REQUIRED ──
    let missingVersionCode = null;
    try {
      await setAccountRole(db, { roleKey: 'CASH_ON_HAND', companyId, accountId: IDS.leafAsset, actor: 'x', reason: 'no version given' });
    } catch (e) { missingVersionCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE'; }
    check('reassigning an EXISTING mapping without expectedVersion is rejected', missingVersionCode === 'ACCOUNT_ROLE_VERSION_REQUIRED', missingVersionCode);

    // ── type mismatch: CASH_ON_HAND (asset-only) pointed at a liability account ──
    let typeMismatchCode = null;
    try {
      await setAccountRole(db, { roleKey: 'CASH_ON_HAND', companyId, accountId: IDS.leafLiability, actor: 'x', reason: 'wrong type', expectedVersion: 2 });
    } catch (e) { typeMismatchCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE:' + e.message; }
    check('assigning a role to a wrong-typed account is rejected (catalog validation)', typeMismatchCode === 'ACCOUNT_ROLE_TYPE_MISMATCH', typeMismatchCode);

    // ── folder target rejected (structural, not just is_folder-flag based) ──
    let folderCode = null;
    try {
      await setAccountRole(db, { roleKey: 'INVENTORY', companyId, accountId: IDS.folder, actor: 'x', reason: 'folder target' });
    } catch (e) { folderCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE'; }
    check('assigning a role to a Folder account is rejected', folderCode === 'ACCOUNT_ROLE_TARGET_NOT_POSTABLE', folderCode);

    // ── unknown role key not in the catalog ──
    let unknownRoleCode = null;
    try {
      await setAccountRole(db, { roleKey: 'ITEST_NOT_IN_CATALOG', companyId, accountId: IDS.leafAsset, actor: 'x', reason: 'y' });
    } catch (e) { unknownRoleCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE'; }
    check('a role key absent from the catalog is rejected', unknownRoleCode === 'ACCOUNT_ROLE_UNKNOWN_ROLE', unknownRoleCode);

    // ── company-specific role collision: same role_key, DIFFERENT company -> allowed ──
    const secondCompanyMapping = await setAccountRole(db, {
      roleKey: 'CASH_ON_HAND', companyId: IDS.companyB, accountId: IDS.leafAsset,
      actor: 'itest-actor', reason: 'same role, different company — must not collide',
    });
    check(
      'the SAME role_key can be mapped independently in a DIFFERENT company (migration 0015 scope fix — would have collided under 0014\'s UNIQUE(role_key) alone)',
      secondCompanyMapping.created === true && secondCompanyMapping.version === 1,
      secondCompanyMapping
    );
    const [[companyAMapping]] = await db.query('SELECT account_id FROM account_roles WHERE role_key=? AND company_id=?', ['CASH_ON_HAND', companyId]);
    check('company A\'s mapping is untouched by company B\'s independent mapping', companyAMapping.account_id === otherAsset.id, companyAMapping);

    // ── getAccountByRole: missing companyId is a hard error, not a silent global fallback ──
    let missingCompanyCode = null;
    try { await getAccountByRole(db, 'CASH_ON_HAND', {}); } catch (e) { missingCompanyCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE'; }
    check('getAccountByRole without companyId is rejected (no silent global fallback)', missingCompanyCode === 'ACCOUNT_ROLE_MISSING_COMPANY', missingCompanyCode);

    // ── getAccountByRole: unmapped role in a company that never got one ──
    let unmappedCode = null;
    try { await getAccountByRole(db, 'ITEST_NEVER_MAPPED', { companyId }); } catch (e) { unmappedCode = e instanceof AccountRoleError ? e.code : 'WRONG_TYPE'; }
    check('getAccountByRole for a genuinely unmapped role throws ACCOUNT_ROLE_UNMAPPED', unmappedCode === 'ACCOUNT_ROLE_UNMAPPED', unmappedCode);
  } catch (e) {
    console.error('UNEXPECTED EXCEPTION during test run:', e);
    fail++; fails.push('unexpected exception: ' + e.message);
  } finally {
    await cleanup();
  }

  const after = await tableCounts();
  for (const t of Object.keys(before)) {
    check(`table "${t}" row count restored to baseline after cleanup`, before[t] === after[t], { before: before[t], after: after[t] });
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} accountRoles: ${pass} passed, ${fail} failed`);
  if (fail) console.log('   failed:', fails.join(' | '));
  try { await db.end(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
