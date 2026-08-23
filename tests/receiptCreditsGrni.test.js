#!/usr/bin/env node
'use strict';
/**
 * A goods receipt credits GR/IR, never accounts payable.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * The legacy purchase-receipt path (routes/erp-core.js) posted:
 *
 *     DR inventory
 *     DR input VAT
 *     CR ACCOUNTS PAYABLE          ← wrong
 *
 * A receipt creates a liability, but not a SUPPLIER-INVOICE liability — nothing
 * has been invoiced yet. Crediting the A/P control account puts money into it
 * that no supplier invoice backs, so the A/P ageing — which reads the
 * supplier-invoice subledger — can never tie to the ledger. Not by a rounding
 * difference: by construction, for as long as a receipt sits uninvoiced.
 *
 * ─── HOW IT WAS FOUND ───────────────────────────────────────────────────────
 * The A/P ageing gained a reconciliation against its control account. It
 * reported ageing 0 against a control balance of 400, and the 400 was eight
 * PurchaseReceipt journals at 50 each. The report found a defect in the posting
 * logic — which is what a reconciliation is for.
 *
 * The V2 procurement module had always done this correctly
 * (lib/procurement/accounts.js maps `grni` → role GRNI). Only the legacy path
 * was wrong, and both now resolve through the same registry so they cannot
 * drift apart again.
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

const ROOT = path.join(__dirname, '..');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// ── 1. The resolver exists, and refuses rather than guessing ───────────────
{
  const gl = require('../lib/glPosting');
  check('glPosting exposes getGrniAccountCode', typeof gl.getGrniAccountCode === 'function');

  const src = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'glPosting.js'), 'utf8'));
  const fn = (src.match(/async function getGrniAccountCode[\s\S]*?\n\}/) || [''])[0];

  check('it resolves through the shared role registry',
    /getAccountByRole/.test(fn) && /'GRNI'/.test(fn), fn.slice(0, 200));

  // The whole point: no silent fallback. Falling back to A/P would reinstate
  // the defect while looking like a safety net.
  check('it never falls back to the A/P account',
    !/CORE_ACCOUNTS\.AP/.test(fn), 'a fallback to A/P is the defect wearing a seatbelt');
  check('it throws when the role is unmapped', /throw/.test(fn), fn.slice(0, 200));
}

// ── 2. The legacy receipt path credits GR/IR ───────────────────────────────
{
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'routes', 'erp-core.js'), 'utf8'));

  // The receipt JOURNAL specifically. `referenceType: 'PurchaseReceipt'` also
  // appears on the lot-ledger inbound call a hundred lines earlier, and
  // anchoring on the bare string landed there — reading a block with no GL
  // entries in it at all. The journal is the one that passes `entries`.
  const idx = src.indexOf("referenceType: 'PurchaseReceipt', referenceId: id, entries");
  check('found the purchase-receipt JOURNAL', idx > -1);

  if (idx > -1) {
    // Look back over the entries assembled for this journal.
    const block = src.slice(Math.max(0, idx - 2200), idx);

    check('the receipt credits GR/IR', /getGrniAccountCode/.test(block), block.slice(-320));

    // The precise regression: `accountCode: gl.CORE_ACCOUNTS.AP.code` on a
    // CREDIT line inside the receipt journal.
    const creditsAp = /accountCode:\s*gl\.CORE_ACCOUNTS\.AP\.code,\s*debit:\s*0/.test(block);
    check('the receipt does NOT credit accounts payable', !creditsAp,
      'a receipt in A/P is money the ageing can never account for');

    // Inventory is still debited — the fix must not have moved the asset side.
    check('inventory is still debited', /CORE_ACCOUNTS\.INVENTORY\.code, debit:/.test(block));
  }
}

// ── 3. Both paths name the same role ───────────────────────────────────────
{
  const v2 = fs.readFileSync(path.join(ROOT, 'lib', 'procurement', 'accounts.js'), 'utf8');
  check('the V2 procurement module maps grni → GRNI', /grni:\s*'GRNI'/.test(v2));
  // If these two ever name different roles, the legacy and V2 receipt paths
  // credit different accounts and the ageing breaks again, silently.
  const glSrc = fs.readFileSync(path.join(ROOT, 'lib', 'glPosting.js'), 'utf8');
  check('the legacy path names the SAME role', /'GRNI'/.test(glSrc));
}

// ── 4. GR/IR is reported as GR/IR ──────────────────────────────────────────
{
  const p = path.join(ROOT, 'db', 'migrations', '0038_coa_report_section_corrections.sql');
  const sql = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^--.*$/gm, '') : '';
  check("migration 0038 files account 2150 under the `grni` section",
    /'2150'[\s\S]{0,120}grni/.test(sql) || /grni[\s\S]{0,120}'2150'/.test(sql),
    'the account every receipt credits should say what it is');
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ goods receipt credits GR/IR through the shared role — never A/P, never a guess');
console.log(pass + '/' + pass + ' passed');
