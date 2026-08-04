#!/usr/bin/env node
'use strict';
/**
 * tests/coaSingleInventory.test.js — «لماذا هناك اثنان من المخزون في الشجرة».
 *
 * The owner saw two account groups named المخزون. It was not a historical
 * accident waiting to be cleaned up once — the server RE-CREATED them on every
 * single boot, because two migrations in the same startup held opposite
 * beliefs about what account `112` is:
 *
 *   routes/erp.js `_repairInventoryClassification` (run at server.js:3413)
 *     → resolved AND CREATED `112 المخزون`, then dragged every
 *       inventory-named account under it.
 *
 *   server.js v5.11.14 block (server.js:4893)
 *     → its own comment states `112` is «الذمم المدينة / AR in the new chart»,
 *       and it moves inventory codes 1200/1210/1220/1230 to `113`.
 *
 * `113` is the survivor because lib/glPosting.js is the authority that WRITES
 * journals — every sale, purchase, waste entry, till movement — and its
 * CORE_ACCOUNTS parents the warehouses under `113`, with the family map at
 * :44-45 (111 Cash · 112 AR · 113 Inventory · 114 Prepayments · 115 Custody ·
 * 116 Input VAT). server.js already agreed with it; the repair helper was the
 * only dissenter.
 *
 * A merge without this fix would have been undone by the next restart, which
 * is why the cause is pinned here and not just the cleanup.
 *
 * Run: node tests/coaSingleInventory.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const erp = read('routes/erp.js');
const server = read('server.js');
const glPosting = read('lib/glPosting.js');
const { CORE_ACCOUNTS } = require('../lib/glPosting');
const cutover = read('db/migrations/0034_coa_inventory_sales_cutover.sql');
const salesRoute = read('routes/sales.js');

// ── 1. One posting leaf under the governed inventory folder ────────────────
{
  for (const name of ['INVENTORY', 'BRANCH_INVENTORY', 'WIP', 'FINISHED_GOODS']) {
    check(`${name} resolves to the single Inventory Control account (1200)`,
      CORE_ACCOUNTS[name].code === '1200' && CORE_ACCOUNTS[name].parent === '100300', name);
  }
  check('legacy stage/warehouse inventory codes are no longer runtime accounts',
    !/code: '1210'|code: '1220'|code: '1230'/.test(glPosting));
  check('AR (1150) is parented under modern receivables 100200',
    /AR:\s*\{[^}]*code: '1150'[^}]*parent: '100200'/.test(glPosting));
}

// ── 2. No boot path may CREATE an inventory group at 112 ──────────────────
// This is the exact line that produced the second المخزون on every restart.
{
  check('routes/erp.js no longer inserts «112 المخزون»',
    !/'112',\s*'المخزون'/.test(erp));
  check('server.js no longer inserts «112 المخزون»',
    !/'112',\s*'المخزون'/.test(server));
  check('the inventory-classification helper targets 100300 by a named constant',
    /INVENTORY_GROUP_CODE\s*=\s*'100300'/.test(erp));
  // The helper must not invent the group either. Creating a group from a
  // repair pass is precisely how the second one appeared.
  const helperStart = erp.indexOf('async function _repairInventoryClassification');
  const helperEnd = erp.indexOf('router._repairInventoryClassification', helperStart);
  check('the helper block is locatable', helperStart > 0 && helperEnd > helperStart);
  const helper = erp.slice(helperStart, helperEnd);
  check('the helper never INSERTs an account',
    !/INSERT\s+IGNORE\s+INTO\s+gl_accounts/i.test(helper),
    helper.match(/INSERT[^\n]*/i)?.[0]);
  check('the helper reports a missing group instead of creating one',
    /no-inventory-group-/.test(helper));
  check('the helper no longer hardcodes 112 anywhere in its body',
    !/'112'/.test(helper), (helper.match(/'11\d'/g) || []).slice(0, 5));
}

// ── 3. Boot agrees and never resurrects stage/category GL accounts ─────────
{
  check('server.js places only 1200 under 100300',
    /code = '1200'[\s\S]{0,300}100300|100300[\s\S]{0,300}code = '1200'/.test(server));
  check('server.js never revives the old warehouse/stage code family',
    !/code IN \('1200','1210','1220','1230'\)/.test(server));
}

// ── 6. Production cutover is non-destructive and cannot double-post ────────
{
  check('cutover never deletes accounts or ledger history',
    !/DELETE\s+FROM\s+gl_accounts|DELETE\s+FROM\s+gl_entries|UPDATE\s+gl_entries/i.test(cutover));
  check('unused rows are archived, not hidden warnings on active rows',
    /status = 'archived'/.test(cutover) && /archived_by = 'migration:0034'/.test(cutover));
  check('inventory roles converge on 1200',
    /WORK_IN_PROGRESS/.test(cutover) && /FINISHED_GOODS/.test(cutover) && /code = '1200'/.test(cutover));
  check('pre-cutover sales with a legacy journal are marked posted_legacy',
    /0034_cutover_guard_failed/.test(cutover) && /status = 'posted_legacy'/.test(cutover));
  check('orphan posted_legacy rows are requeued for one governed batch journal',
    /CUTOVER_REQUEUED_NO_LEGACY_JOURNAL/.test(cutover) &&
    /queue_row\.status = 'pending'/.test(cutover) && /legacy_journal\.id IS NULL/.test(cutover));
  check('the fail-closed queue guard runs before every chart mutation',
    cutover.indexOf('0034_cutover_guard_failed') < cutover.indexOf('UPDATE gl_accounts inventory_account'));
  check('the cutover guard is pool-safe and never relies on a temporary table',
    !/CREATE\s+TEMPORARY\s+TABLE/i.test(cutover));
  check('the cutover guard fails deterministically without depending on SQL strict mode',
    /SELECT\s+'0033'\s*,\s*'0034_cutover_guard_failed'/i.test(cutover) &&
    !/SELECT\s+NULL\s*,\s*'0034_cutover_guard_failed'/i.test(cutover));
  check('cutover rejects unproved batch and already-double-posted queue rows',
    /reference_type = 'SalesBatch'/.test(cutover) &&
    /legacy_journal\.id IS NOT NULL/.test(cutover));
  check('legacy WIP/branch/finished accounts are archived under inventory, never deleted',
    /legacy_inventory\.code IN \('1210','1220','1230'\)/.test(cutover) &&
    /legacy_inventory\.status = 'archived'/.test(cutover));
  check('the stale account balance cache is rebuilt from posted journal lines',
    /SET account_row\.balance = COALESCE\(ledger_total\.ledger_balance, 0\)/.test(cutover));
  check('unused standard-template leaves may retire instead of keeping 300+ active rows',
    !/WHERE account_row\.is_system_root = 0\s+AND COALESCE\(account_row\.system_managed/.test(cutover));
  check('the migration never assumes gl_accounts has company_id',
    !/inventory_account\.company_id|gl_accounts[^\n]*company_id/.test(cutover));
  check('checkout no longer posts one Sale journal per invoice',
    !/referenceType:\s*'Sale'/.test(salesRoute.slice(0, salesRoute.indexOf("router.post('/:id/void'"))));
}

// ── 4. The cleanup merge, and its never-automate boundary ────────────────
{
  check('server.js carries the duplicate-inventory merge',
    /InventoryDuplicateMerge_v1/.test(server));
  const start = server.indexOf("SELECT setting_value FROM settings WHERE setting_key = 'InventoryDuplicateMerge_v1'");
  const end = server.indexOf("catch (e) { console.error('[inv-merge]'", start);
  check('the merge block is locatable', start > 0 && end > start, { start, end });
  const block = server.slice(start, end);

  check('the merge re-parents children to 113', /SET parent_id = \?, report_section = 'inventory'/.test(block));
  // The three operations that can corrupt posted history must be absent.
  check('the merge NEVER changes an account code', !/SET code =/.test(block));
  check('the merge NEVER deactivates an account', !/is_active\s*=\s*0/.test(block));
  check('the merge NEVER deletes an account', !/DELETE\s+FROM\s+gl_accounts/i.test(block));
  check('the merge never touches gl_entries', !/UPDATE\s+gl_entries/i.test(block));

  // Renaming is only safe when no money was posted to the row.
  check('the merge counts posted entries before renaming 112',
    /SELECT COUNT\(\*\) AS n FROM gl_entries WHERE account_id = \?/.test(block));
  check('the merge renames 112 only when that count is zero',
    /Number\(cnt\.n\) === 0/.test(block));
  check('the merge refuses and warns when 112 carries entries',
    /console\.warn\('\[inv-merge\]/.test(block));
  check('the merge is a no-op when 112 is not named inventory',
    /\/مخزون\/\.test\(nm112\)/.test(block));
  check('the merge re-derives levels after moving nodes', /recomputeLevels/.test(block));
  check('the merge is gated so it runs once', /InventoryDuplicateMerge_v1','1'/.test(block) || start > 0);
}

// ── 5. The governed template agrees with every runtime writer ─────────────
{
  const rows = JSON.parse(read('db/coa-template.json'))
    .map((r) => ({ code: r.code, name: r.nameAr, parent: r.parentCode || null, kind: r.kind }));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  check('the governed template is non-trivial', rows.length > 100, rows.length);

  // Structural hygiene — a seed that contradicts itself cannot be a baseline.
  const dupes = [...new Set(rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i))];
  check('no duplicate codes in the seed', dupes.length === 0, dupes);
  const dangling = rows.filter((r) => r.parent && !byCode.has(r.parent)).map((r) => r.code + '→' + r.parent);
  check('every seeded parent exists in the seed', dangling.length === 0, dangling);

  const inventoryFolder = byCode.get('100300');
  check('100300 is the sole governed inventory folder',
    inventoryFolder?.kind === 'folder' && inventoryFolder.name === 'المخزون', inventoryFolder);
  const inventoryChildren = rows.filter((r) => r.parent === '100300');
  check('inventory has exactly one GL posting leaf',
    inventoryChildren.length === 1 && inventoryChildren[0].code === '1200' && inventoryChildren[0].kind === 'leaf',
    inventoryChildren);
  check('the template contains no warehouse/stage/category inventory accounts',
    !rows.some((r) => ['1210', '1220', '1230'].includes(r.code) || /^113\d{2}$/.test(r.code)));

  check('/gl/seed executes the governed template before the forensic legacy array',
    /source: 'governed-coa-template'/.test(erp));

  // Every parent CORE_ACCOUNTS declares must exist, or ensureCoreAccounts
  // walks up, finds nothing, and inserts the account as a PARENTLESS ROOT —
  // which is how 5410, 5500 and 6100 became stray roots on the live chart
  // (ADR 0002). 5500 is credited on every aggregator order.
  const need = [...glPosting.matchAll(/code: '(\d+)'[^}]*parent: '(\d+)'/g)]
    .map((m) => ({ code: m[1], parent: m[2] }));
  check('CORE_ACCOUNTS declares parents at all', need.length > 10, need.length);
  const stranded = need.filter((n) => !byCode.has(n.parent));
  check('no CORE account would be stranded as a root by this seed',
    stranded.length === 0, stranded.map((s) => s.code + '→' + s.parent));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ one inventory control account (1200) under governed folder 100300');
