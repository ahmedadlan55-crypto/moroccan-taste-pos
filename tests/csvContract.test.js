#!/usr/bin/env node
'use strict';
/**
 * The one CSV contract: complete or refused, never quietly short.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * Two byte-identical copies of the CSV writer (`lib/procurement/http.js` and
 * `lib/order-to-cash/http.js`) did this:
 *
 *     const capped = rows.slice(0, CSV_ROW_CAP);            // row 50,001 gone
 *     return res.status(200).send(toCsv(rows, columns));    // 200. "Complete."
 *
 * A 60,000-row A/P ageing downloaded as a 50,000-row file with HTTP 200, no
 * header and no warning. The artifact looks finished, so nobody goes looking —
 * which is why this is worse than an error.
 *
 * ─── AND THE OTHER HALF ─────────────────────────────────────────────────────
 * Three CSV builders hand-rolled their own quoting with NO formula guard at
 * all (price-list template, payroll register, stocktake export), on fields a
 * user controls. Quoting alone is not a defence: Excel evaluates
 * `=cmd|'/C calc'!A0` inside a quoted cell too.
 *
 * The negative-number case is the one that needs care in the other direction:
 * the clones neutralized EVERY leading `-`, turning every credit balance and
 * variance in a financial export into the text `'-1500`, at which point Excel
 * will not sum the column and the totals of a financial report do not add up.
 */

const path = require('path');
const CSV = require('../lib/csvContract');
const fs = require('fs');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

const COLS = [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Amount' }];

// ── Complete or refused ────────────────────────────────────────────────────
{
  const rows = Array.from({ length: 10 }, (_, i) => ({ a: 'x' + i, b: i }));
  const text = CSV.toCsv(rows, COLS);
  eq('every row is written', text.trim().split('\r\n').length, 11); // header + 10
  check('carries the UTF-8 BOM so Excel reads Arabic', text.charCodeAt(0) === 0xfeff);
}

{
  // The exact regression: one row past the cap must NOT silently disappear.
  const rows = Array.from({ length: 6 }, (_, i) => ({ a: i, b: i }));
  let threw = null;
  try { CSV.toCsv(rows, COLS, { limit: 5 }); } catch (e) { threw = e; }
  check('over the limit it refuses instead of truncating', threw !== null);
  eq('refusal carries a machine code', threw && threw.code, 'REPORT_TOO_LARGE');
  eq('refusal states the real total', threw && threw.total, 6);
  eq('refusal states the limit', threw && threw.limit, 5);
  // Exactly at the limit is fine — the boundary is inclusive.
  check('exactly at the limit still writes', typeof CSV.toCsv(rows.slice(0, 5), COLS, { limit: 5 }) === 'string');
}

{
  // sendCsv must translate that into 413, not a 200 with a short body.
  const sent = {};
  const res = {
    status(c) { sent.status = c; return this; },
    json(b) { sent.json = b; return this; },
    send(b) { sent.body = b; return this; },
    setHeader(k, v) { (sent.headers ||= {})[k] = v; },
  };
  CSV.sendCsv(res, 'x.csv', Array.from({ length: 6 }, (_, i) => ({ a: i, b: i })), COLS, { limit: 5 });
  eq('overflow answers 413', sent.status, 413);
  eq('413 names the code', sent.json && sent.json.code, 'REPORT_TOO_LARGE');
  eq('413 reports the true row count', sent.json && sent.json.total, 6);
  check('413 sends no file body', sent.body === undefined, sent.body);
}

{
  const sent = {};
  const res = {
    status(c) { sent.status = c; return this; },
    json(b) { sent.json = b; return this; },
    send(b) { sent.body = b; return this; },
    setHeader(k, v) { (sent.headers ||= {})[k] = v; },
  };
  CSV.sendCsv(res, 'x.csv', [{ a: 'ok', b: 1 }], COLS);
  eq('a complete file is 200', sent.status, 200);
  check('a complete file has a body', typeof sent.body === 'string');
  // Completeness travels with the file, so a caller can prove it without
  // reopening the download.
  eq('row count is on the response', sent.headers['X-Report-Row-Count'], '1');
  eq('completeness is asserted', sent.headers['X-Report-Complete'], 'true');
}

// ── Formula injection ──────────────────────────────────────────────────────
{
  for (const attack of ['=1+1', '+1+1', '@SUM(A1)']) {
    const cell = CSV.csvCell(attack);
    check('neutralizes a leading ' + JSON.stringify(attack[0]), cell.startsWith("'"), cell);
  }
  // TAB and CR are neutralized too, but the cell is then QUOTED because it
  // contains a control character — so the apostrophe sits inside the quotes.
  // Asserting startsWith("'") here would fail on correct output.
  for (const attack of ['\tcmd', '\rcmd']) {
    const cell = CSV.csvCell(attack);
    check('neutralizes a leading control char ' + JSON.stringify(attack[0]),
      cell.indexOf("'") !== -1 && cell.indexOf("'") <= 1, cell);
  }
  // The classic payload, and the reason quoting alone is not a defence.
  const payload = "=cmd|'/C calc'!A0";
  const cell = CSV.csvCell(payload);
  check('neutralizes the command payload', cell.startsWith("'"), cell);
}

// ── Negatives stay numeric ─────────────────────────────────────────────────
{
  // A credit balance must remain a NUMBER. The clones quoted it, so Excel
  // treated the column as text and refused to sum a financial report.
  eq('a negative amount is not quoted', CSV.csvCell('-1500'), '-1500');
  eq('a negative decimal is not quoted', CSV.csvCell('-1500.75'), '-1500.75');
  eq('a positive number is untouched', CSV.csvCell('1500'), '1500');
  // But a leading `-` on non-numeric text is still an injection vector.
  check('a non-numeric leading dash IS neutralized', CSV.csvCell('-cmd|calc').startsWith("'"));
  eq('empty stays empty', CSV.csvCell(''), '');
  eq('null becomes empty', CSV.csvCell(null), '');
}

// ── Quoting still works ────────────────────────────────────────────────────
{
  eq('a comma forces quotes', CSV.csvCell('a,b'), '"a,b"');
  eq('a quote is doubled', CSV.csvCell('a"b'), '"a""b"');
  eq('a newline forces quotes', CSV.csvCell('a\nb'), '"a\nb"');
  eq('Arabic passes through unchanged', CSV.csvCell('شاي أخضر'), 'شاي أخضر');
}

// ── The clones are gone ────────────────────────────────────────────────────
{
  const ROOT = path.join(__dirname, '..');
  // Strip comments FIRST. The delegating files explain the defect they removed,
  // so a raw grep for `rows.slice(0, CSV_ROW_CAP)` matches the explanation and
  // reports the bug as still present. This project has been burned by grepping
  // a module path that its own comment also mentioned.
  const stripSrc = (s2) => s2.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const rel of ['lib/procurement/http.js', 'lib/order-to-cash/http.js']) {
    const src = stripSrc(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // The literal truncation that WAS the bug.
    check(rel + ': no longer slices rows for export',
      !/rows\.slice\(0,\s*CSV_ROW_CAP\)/.test(src), rel);
    check(rel + ': delegates to the one contract',
      /require\('\.\.\/csvContract'\)/.test(src), rel);
  }
  // Both must still export the names their callers import, or every export
  // route 500s on load.
  for (const rel of ['lib/procurement/http.js', 'lib/order-to-cash/http.js']) {
    const mod = require(path.join(ROOT, rel));
    eq(rel + ': still exports toCsv', typeof mod.toCsv, 'function');
    eq(rel + ': still exports sendCsv', typeof mod.sendCsv, 'function');
  }
}

// ── The three hand-rolled builders now use the guard ───────────────────────
{
  const ROOT = path.join(__dirname, '..');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const [rel, what] of [
    ['routes/erp-core.js', 'price-list template'],
    ['routes/hr.js', 'payroll register'],
    ['routes/stocktake-pro.js', 'stocktake export'],
  ]) {
    const src = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // Grep the require STATEMENT, not the module path — the path also appears
    // in the comments that explain why it is there.
    check(what + ': requires the CSV contract',
      /(?:^|\n)const CSVC = require\('\.\.\/lib\/csvContract'\);/.test(src), rel);
    check(what + ': routes cells through csvCell',
      /CSVC\.csvCell\(/.test(src), rel);
  }
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ CSV: complete or 413, formulas neutralized, negatives still numbers');
console.log(pass + '/' + pass + ' passed');
