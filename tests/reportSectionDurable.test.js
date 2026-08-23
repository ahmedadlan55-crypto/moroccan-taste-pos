#!/usr/bin/env node
'use strict';
/**
 * A stored `report_section` survives a restart.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * server.js re-derives `report_section` from CODE PREFIXES on every boot. Its
 * WHERE clause used to be:
 *
 *     WHERE code LIKE ? AND (report_section IS NULL OR report_section <> ?)
 *
 * — it overwrote any stored value that differed from the prefix guess. Every
 * boot. Which meant:
 *
 *   1. A CLASSIFICATION COULD NOT BE CORRECTED. Migration 0038 fixed nineteen
 *      accounts, the server restarted, and every one was back. Not a race, not
 *      a partial write — the correction was simply undone, silently, by design.
 *
 *   2. THE GUESS WAS ITSELF WRONG. `112%` maps to `receivables`, and account
 *      1120 is «البنوك» — the BANK. The A/R ageing's reconciliation reported a
 *      2,360 break whose entire balance was that one account, sitting in the
 *      customer control account because of a prefix.
 *
 *   3. IT OUTRANKED THE STORED METADATA. Migration 0028 made `report_section`
 *      explicit account metadata; 0036 rebuilt the chart canonically. A legacy
 *      code-prefix guess re-asserting itself over both is exactly what
 *      lib/coa/classify.js quarantines its `legacy*` functions to prevent.
 *
 * Filling a NULL is still right — a fresh install needs a starting value.
 * Overwriting a stored one is what made every correction temporary.
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
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/** server.js with comments removed — a rule must not be "kept" by prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const code = stripComments(server);

// ── 1. No boot statement overwrites a stored section ───────────────────────
{
  // Every UPDATE that writes report_section, with the clause it writes under.
  const updates = [];
  const re = /UPDATE gl_accounts SET report_section[\s\S]{0,400}?(?:;|\n\s*\n)/g;
  let m;
  while ((m = re.exec(code)) !== null) updates.push(m[0].replace(/\s+/g, ' '));

  check('found the report_section writers in server.js', updates.length > 0, updates.length);

  // The exact shape of the defect: a WHERE that accepts a non-NULL value.
  const clobbering = updates.filter((u) =>
    /report_section\s*<>\s*\?/.test(u) || /report_section\s*!=\s*\?/.test(u),
  );
  check('no boot UPDATE overwrites a section that differs from the guess',
    clobbering.length === 0, clobbering.map((u) => u.slice(0, 140)));
}

// ── 2. The prefix pass fills NULLs only ────────────────────────────────────
{
  const idx = code.indexOf('const corrections = [');
  check('the prefix re-derive pass is still present', idx > -1);
  if (idx > -1) {
    // The UPDATE built inside that block.
    const block = code.slice(idx, idx + 3000);
    const stmt = (block.match(/let sql = "UPDATE gl_accounts SET report_section[^"]*"/) || [])[0] || '';
    check('the prefix pass writes only where the section IS NULL',
      /report_section IS NULL/.test(stmt) && !/<>/.test(stmt), stmt);
  }
}

// ── 3. The correction migration exists and is code-addressed ───────────────
{
  const p = path.join(ROOT, 'db', 'migrations', '0038_coa_report_section_corrections.sql');
  check('migration 0038 exists', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const sql = fs.readFileSync(p, 'utf8');
    const body = sql.replace(/^--.*$/gm, '');

    // Addressed by exact code, never by a name pattern — a name match would
    // sweep accounts nobody reviewed.
    check('0038 never matches on an account NAME',
      !/name_ar\s+LIKE/i.test(body), 'found a name_ar LIKE — that is guessing');

    // It must not touch balances, codes, or the chart's shape.
    check('0038 changes presentation only — no balance, code or parent is written',
      !/SET\s+balance/i.test(body) && !/SET\s+code/i.test(body) && !/parent_id\s*=/i.test(body),
      'a classification migration must not move money or reshape the chart');

    check('0038 corrects the bank account off the receivables line',
      /code = '1120'[\s\S]{0,80}receivables/.test(body) || /'1120'[\s\S]{0,120}cash/.test(body));

    // `acc_dep` is CONTRA — an asset carrying it is SUBTRACTED from total
    // assets, so the balance sheet understated them by twice their value.
    check('0038 moves the two real assets off the contra-depreciation section',
      /'122'/.test(body) && /'1220'/.test(body) && /acc_dep/.test(body));
  }
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ report_section: a stored classification survives boot; the prefix guesser fills NULLs only');
console.log(pass + '/' + pass + ' passed');
