'use strict';
/* Unit — printHtml() can print into a window the CALLER already opened.
 *
 * THE DEFECT (W0-A #4): frontend/shared/invoiceTemplate.ts `printHtml(html)`
 * called `window.open` itself. A browser only honors window.open inside the
 * user gesture that triggered it, and AUTO-PRINT fires AFTER an `await` (the
 * checkout round-trip) — the gesture is spent by then, so the popup is blocked
 * and auto-print could never work at all. The signature is now
 * `printHtml(html, win?)`: the caller opens the window synchronously on the
 * click, awaits its data, then hands the live window here.
 *
 * This test executes the REAL function out of the shipped .ts file (extracted
 * and type-stripped — there is no TypeScript runner on the backend chain), so
 * it fails if the parameter is ever removed, if the fallback window.open path
 * regresses, or if a supplied window stops being used.
 *
 * Run: node tests/printHtmlWindowTarget.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'frontend', 'shared', 'invoiceTemplate.ts');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

// ── extract printHtml from the real source and strip the TS annotations ──────
const source = fs.readFileSync(SRC, 'utf8');
const m = source.match(/export function printHtml\([\s\S]*?\n\}/);
if (!m) {
  console.error('❌ printHtmlWindowTarget: could not find `export function printHtml(` in ' + SRC);
  process.exit(1);
}
const declaration = m[0].split('\n')[0];
const js = m[0]
  .replace(/^export\s+/, '')
  .replace(/(\w+)\??\s*:\s*[A-Za-z<>|[\]\s.]+?(?=[,)])/g, '$1')  // parameter types
  .replace(/\)\s*:\s*[A-Za-z<>|[\]\s.]+\{/, ') {');              // return type

function makeWindow(opened) {
  const w = {
    opened: false, printed: false, focused: false, closedDoc: false, written: '',
    document: {
      open() { w.opened = true; },
      write(html) { w.written += html; },
      close() { w.closedDoc = true; },
    },
    focus() { w.focused = true; },
    print() { w.printed = true; },
    // printHtml defers the print by a beat; run it immediately here.
    setTimeout(fn) { fn(); return 0; },
  };
  if (opened) opened.push(w);
  return w;
}
function load(openResult, openLog) {
  const globalWindow = { open: (...args) => { openLog.push(args); return openResult; } };
  // eslint-disable-next-line no-new-func
  return new Function('window', js + '\nreturn printHtml;')(globalWindow);
}

console.log('\n▶ signature');
check('printHtml declares an optional `win?: Window | null` second parameter',
  /printHtml\(\s*html\s*:\s*string\s*,\s*win\?\s*:\s*Window\s*\|\s*null\s*\)\s*:\s*boolean/.test(declaration), declaration);
check('the stripped function takes 2 parameters', load(null, []).length === 2, load(null, []).length);

console.log('\n▶ no window supplied — today\'s behavior, unchanged');
{
  const log = []; const popup = makeWindow();
  const printHtml = load(popup, log);
  const ok = printHtml('<html>RECEIPT-A</html>');
  check('returns true', ok === true, ok);
  check('opened its own popup via window.open', log.length === 1, log);
  check('window.open kept the historical target/features', log[0] && log[0][0] === '' && log[0][1] === '_blank' && /width=420/.test(String(log[0][2])), log[0]);
  check('wrote the html into that popup and closed the document',
    popup.opened === true && popup.written === '<html>RECEIPT-A</html>' && popup.closedDoc === true, { written: popup.written });
  check('focused + printed it', popup.focused === true && popup.printed === true, { focused: popup.focused, printed: popup.printed });
}

console.log('\n▶ no window supplied and the popup is BLOCKED');
{
  const log = [];
  const printHtml = load(null, log);
  let threw = null; let ok;
  try { ok = printHtml('<html>RECEIPT-B</html>'); } catch (e) { threw = e; }
  check('returns false instead of throwing', threw === null && ok === false, { threw: threw && threw.message, ok });
}

console.log('\n▶ a window IS supplied — the auto-print path');
{
  const log = []; const fallback = makeWindow(); const caller = makeWindow();
  const printHtml = load(fallback, log);
  const ok = printHtml('<html>RECEIPT-C</html>', caller);
  check('returns true', ok === true, ok);
  check('window.open was NOT called (the spent user gesture is never re-used)', log.length === 0, log);
  check('the CALLER\'s window received the document', caller.written === '<html>RECEIPT-C</html>' && caller.opened === true && caller.closedDoc === true, { written: caller.written });
  check('the caller\'s window was focused + printed', caller.focused === true && caller.printed === true, { focused: caller.focused, printed: caller.printed });
  check('the fallback window was left completely untouched',
    fallback.written === '' && fallback.printed === false && fallback.opened === false, fallback.written);
}

console.log('\n▶ an explicitly null window falls back (never a silent no-op)');
{
  const log = []; const popup = makeWindow();
  const printHtml = load(popup, log);
  const ok = printHtml('<html>RECEIPT-D</html>', null);
  check('null win → falls back to window.open and returns true', ok === true && log.length === 1 && popup.printed === true, { ok, log: log.length });

  const log2 = [];
  const blocked = load(null, log2);
  check('null win + blocked fallback → false', blocked('<html>x</html>', null) === false, log2.length);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} printHtmlWindowTarget: ${pass} passed, ${fail} failed`);
if (fail) console.log('   failed:', fails.join(' | '));
process.exit(fail === 0 ? 0 : 1);
