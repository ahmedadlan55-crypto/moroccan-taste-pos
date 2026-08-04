#!/usr/bin/env node
'use strict';
/**
 * tests/custodyNotInventory.test.js — «العهدة تحت بند المخزون».
 *
 * The owner reported that employee custody accounts appear under Inventory in
 * his chart of accounts. He was right, and the cause was unambiguous:
 *
 *   lib/glPosting.js:44-45 states the canonical family map —
 *     111 = Cash and Bank · 112 = AR · 113 = INVENTORY ·
 *     114 = Prepayments   · 115 = CUSTODY · 116 = Input VAT
 *   and CORE_ACCOUNTS parents 1200 المخزون الرئيسي, 1210 مخزون الفروع,
 *   1220 الإنتاج تحت التشغيل and 1230 المنتجات التامة under `113`.
 *
 *   But routes/custody.js created `1130 عهد الموظفين` under `113`, and
 *   routes/erp.js's journal-import path carried a hand-copy that did the same.
 *   So every عهدة account was a sibling of the warehouses. The chart tree
 *   showed it under المخزون, and the balance sheet agreed, because server.js's
 *   prefix table maps `113%` → inventory — while the name-rescue pass flipped
 *   report_section back to `receivables` on every boot. That contradiction is
 *   the recurring "re-derived … 1 mis-tagged account" log line.
 *
 * Custody is `115`. server.js already mapped `115` → receivables with the
 * comment «العهد والسلف»; the classification layer knew, the creator did not.
 *
 * This is a STATIC test on purpose: the defect is a hardcoded constant, and a
 * constant is exactly what a source scan pins. It runs in `npm test` with no DB.
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

// ── 1. `113` really is Inventory — the premise, stated by the code itself ──
{
  const gl = read('lib/glPosting.js');
  check('lib/glPosting.js documents 113 = Inventory', /113 = Inventory/.test(gl));
  check('lib/glPosting.js documents 115 = Custody', /115 = Custody/.test(gl));
  for (const [code, name] of [['1200', 'INVENTORY'], ['1210', 'BRANCH_INVENTORY'],
                              ['1220', 'WIP'], ['1230', 'FINISHED_GOODS']]) {
    const re = new RegExp(name + ":[^}]*code: '" + code + "'[^}]*parent: '113'");
    check(`${name} (${code}) is parented under 113 — so 113 is the warehouse group`,
      re.test(gl), code);
  }
}

// ── 2. The custody creator uses 115, and NEVER 113 ────────────────────────
{
  const custody = read('routes/custody.js');
  check("routes/custody.js declares CUSTODY_GROUP_CODE = '115'",
    /CUSTODY_GROUP_CODE\s*=\s*'115'/.test(custody));
  check('routes/custody.js no longer creates the group as 1130',
    !/const code = '1130'/.test(custody));
  // The whole point: no fallback may reach into the inventory subtree. A
  // "if 115 is missing, use 113" fallback would recreate the bug on a fresh
  // chart, which is precisely how it survived this long.
  const glHelpers = custody.slice(custody.indexOf('GL ACCOUNT HELPERS'),
                                  custody.indexOf('CUSTODY USERS'));
  check('the custody GL helpers reference no 113 parent at all',
    !/code = '113'|code LIKE '1130|'1130'/.test(glHelpers),
    (glHelpers.match(/113\d*/g) || []).slice(0, 5));
  check('custody child codes start in the 115 family',
    /CUSTODY_CHILD_PREFIX\s*=\s*'115'/.test(custody));
  // 1150 is AR (ذمم العملاء) — handing it out to a custody user would collide.
  check('the child-code generator skips 1150 (it is AR)',
    /code <> '1150'/.test(custody), '1150 must be excluded');
  check('the child-code scan orders by CHAR_LENGTH first (1159 must not beat 11510)',
    /ORDER BY CHAR_LENGTH\(code\) DESC/.test(custody));
}

// ── 3. There is ONE creator, not two ──────────────────────────────────────
{
  const erp = read('routes/erp.js');
  check('routes/erp.js no longer hand-copies the custody creator',
    !/'GL-1130', '1130', 'عهد الموظفين'/.test(erp));
  check('routes/erp.js delegates to the single implementation',
    /createCustodyUserGLAccount\(/.test(erp));
  const custody = read('routes/custody.js');
  check('routes/custody.js exports the creator so it CAN be shared',
    /module\.exports\.createCustodyUserGLAccount/.test(custody));
}

// ── 4. The one-shot relocation for charts that already have the defect ────
{
  const server = read('server.js');
  check('server.js carries the custody relocation repair',
    /CustodyOutOfInventory_v1/.test(server));
  check('the repair is gated on a settings key so it runs once',
    /SELECT setting_value FROM settings WHERE setting_key = 'CustodyOutOfInventory_v1'/.test(server));
  // It must move the PARENT only. Renumbering a code rewrites
  // gl_entries.account_code across posted history — that belongs to an
  // explicit, human-triggered /gl/accounts/:id/move, never to a boot step.
  // Anchored on the repair's own log tag so the slice cannot drift into
  // unrelated migration code above it and pass (or fail) for the wrong reason.
  const startAt = server.indexOf("SELECT setting_value FROM settings WHERE setting_key = 'CustodyOutOfInventory_v1'");
  const endAt = server.indexOf("catch (e) { console.error('[custody-fix]'", startAt);
  check('the repair block is locatable', startAt > 0 && endAt > startAt, { startAt, endAt });
  const block = server.slice(startAt, endAt);
  check('the repair updates parent_id, never code',
    /SET parent_id = \?, report_section = 'receivables'/.test(block));
  check('the repair does NOT touch gl_entries',
    !/gl_entries/.test(block));
  check('the repair re-derives levels after moving nodes',
    /recomputeLevels/.test(block));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ custody accounts live under 115 العهد والسلف — not under 113 المخزون');
