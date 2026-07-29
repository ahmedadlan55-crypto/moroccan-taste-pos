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

// ── 1. The premise: the posting authority says 113 = Inventory ────────────
{
  check('glPosting documents 112 = AR', /112 = AR/.test(glPosting));
  check('glPosting documents 113 = Inventory', /113 = Inventory/.test(glPosting));
  for (const [name, code] of [['INVENTORY', '1200'], ['BRANCH_INVENTORY', '1210'],
                              ['WIP', '1220'], ['FINISHED_GOODS', '1230']]) {
    check(`${name} (${code}) is parented under 113`,
      new RegExp(name + ":[^}]*code: '" + code + "'[^}]*parent: '113'").test(glPosting), code);
  }
  check('AR (1150) is parented under 112, not 113',
    /AR:\s*\{[^}]*code: '1150'[^}]*parent: '112'/.test(glPosting));
}

// ── 2. No boot path may CREATE an inventory group at 112 ──────────────────
// This is the exact line that produced the second المخزون on every restart.
{
  check('routes/erp.js no longer inserts «112 المخزون»',
    !/'112',\s*'المخزون'/.test(erp));
  check('server.js no longer inserts «112 المخزون»',
    !/'112',\s*'المخزون'/.test(server));
  check('the inventory-classification helper targets 113 by a named constant',
    /INVENTORY_GROUP_CODE\s*=\s*'113'/.test(erp));
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

// ── 3. The two boot migrations now agree ──────────────────────────────────
{
  // server.js's v5.11.14 block treats 112 as AR (it moves 1150 there).
  check('server.js still moves AR 1150 to 112',
    /WHERE code = '1150'[\s\S]{0,80}\[id112/.test(server) || /code = '1150'/.test(server));
  check('server.js still moves the warehouse codes to 113',
    /code IN \('1200','1210','1220','1230'\)/.test(server));
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

// ── 5. The /gl/seed template agrees with the posting authority ───────────
//
// The seed is the LAST source that could recreate the conflict. It only runs
// on a chart with zero accounts (the COUNT guard at the top of the route), so
// it can never rewrite a live chart — but a fresh install seeded the old way
// was born with Inventory at 112 and Receivables at 113, i.e. the mirror image
// of what every journal writer assumes, and grew a second inventory group the
// first time the boot migrations ran.
{
  const start = erp.indexOf('const accounts = [');
  const end = erp.indexOf('];', start);
  check('the seed array is locatable', start > 0 && end > start);
  const rows = [...erp.slice(start, end)
    .matchAll(/\{code:'([^']+)',name:'([^']+)'[^}]*parent:(?:'([^']*)'|null)/g)]
    .map((m) => ({ code: m[1], name: m[2], parent: m[3] ?? null }));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  check('the seed parses to a non-trivial chart', rows.length > 50, rows.length);

  // Structural hygiene — a seed that contradicts itself cannot be a baseline.
  const dupes = [...new Set(rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i))];
  check('no duplicate codes in the seed', dupes.length === 0, dupes);
  const dangling = rows.filter((r) => r.parent && !byCode.has(r.parent)).map((r) => r.code + '→' + r.parent);
  check('every seeded parent exists in the seed', dangling.length === 0, dangling);

  // The families the owner sees, in the order the posting engine assumes.
  for (const [code, must] of [['112', 'ذمم'], ['113', 'المخزون'], ['114', 'مقدم'],
                              ['115', 'العهد'], ['116', 'المدخلات']]) {
    const a = byCode.get(code);
    check(`seed ${code} is ${must}`, !!a && a.name.includes(must), a ? a.name : '(absent)');
  }
  check('the seed does NOT name 112 as inventory',
    !(byCode.get('112') || {}).name?.includes('مخزون'), (byCode.get('112') || {}).name);

  // 521/522/523 are owned by CORE_ACCOUNTS (waste, variance, PPV). Seeding
  // them as payroll/rent/maintenance filed every waste posting in the business
  // under «الرواتب والأجور».
  check('seed 521 is the waste family, not payroll',
    /هدر|توالف/.test((byCode.get('521') || {}).name || ''), (byCode.get('521') || {}).name);
  check('payroll moved off 521 to its own family',
    /الرواتب/.test((byCode.get('526') || {}).name || ''), (byCode.get('526') || {}).name);

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
console.log('✅ one inventory group (113); no boot path re-creates a second one at 112');
