#!/usr/bin/env node
'use strict';
/**
 * tests/coaBootDrift.test.js — «شجرة الحسابات تتغيّر لوحدها».
 *
 * THE DEFECT
 * ──────────
 * The chart of accounts drifted because the server REWROTE it on every start.
 * Seven separate boot blocks re-parented accounts, renumbered codes, renamed
 * the payables control account, created ~25 accounts and POSTED A REAL
 * JOURNAL — unconditionally, before anyone had looked at the chart. Two of
 * them are "gated on a settings key", which makes them one-shot, not
 * consented-to: the first boot after a deploy spends the shot.
 *
 * The consequence is not a cosmetic one. An accountant who corrected a parent
 * by hand watched the next restart put it back, so the chart could never
 * converge; and the party-dimension bootstrap chose the posting date of a
 * live accounting document by the accident of when a process happened to
 * restart.
 *
 * THE FIX BEING PINNED
 * ────────────────────
 * One flag, `COA_BOOT_REPAIR`, default OFF. Nothing is deleted — the blocks
 * encode real knowledge about how this chart broke and how to unbreak it.
 * They are GATED: with the flag off each block still runs its DETECTION
 * queries and prints what it WOULD have changed (`[coa-drift]`, count plus a
 * short sample); with the flag set to exactly '1' behaviour is unchanged, so
 * an operator can still run the repair deliberately.
 *
 * WHY THIS IS A STATIC SOURCE TEST
 * ────────────────────────────────
 * Same reasoning as tests/coaSingleInventory.test.js:26 — the defect IS the
 * source. It is a hardcoded, always-on mutation sitting in a 8,000-line boot
 * path that only executes against a live MySQL instance after a full server
 * start. A behavioural test would need a database, a seeded chart, and a
 * restart to observe the very thing the source states outright. What has to
 * stay true is a property of the text: no write to gl_accounts or gl_entries
 * in these blocks may sit outside a `COA_BOOT_REPAIR` guard, and the branch
 * that runs when the flag is OFF may not write at all. A source scan pins
 * that exactly, on every run, with no DB.
 *
 * It is not ONLY static. `lib/partyDimension/bootstrap.js` exports its three
 * steps as plain functions of `db`, so section 6 actually RUNS them against a
 * stub connection and asserts that with the flag off no write statement is
 * issued and `postJournal` is never called — and that with the flag on it IS.
 * A guard that is always off is not a fix, it is a deletion with extra steps.
 *
 * Run: node tests/coaBootDrift.test.js   (pure, no DB)
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
const server = read('server.js');
const boot = read('lib/partyDimension/bootstrap.js');

// Section 6 runs the bootstrap steps for real against a stub connection; it is
// assigned there and awaited at the very bottom, so the summary is printed
// after every check — static and behavioural alike — has been counted.
let probe = async () => {};

// ═══════════════════════════════════════════════════════════════════════════
// A tiny brace scanner, so "is this mutation inside the guard" is a STRUCTURAL
// question rather than a "does the word appear somewhere above it" one.
//
// It skips strings, template literals and comments, because the blocks under
// test contain SQL like `REGEXP '^113[0-9]{2}$'` — a brace inside a string
// would otherwise throw the depth count off and the whole analysis with it.
// ═══════════════════════════════════════════════════════════════════════════
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length;
}

/** Index of the `}` matching the `{` at openIdx, or -1. */
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const cl = src.indexOf('*/', i); if (cl < 0) return -1; i = cl + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Every `if (coaBootRepairEnabled())` / `if (!coaBootRepairEnabled())` in a
 * file, with its two branches resolved. `offBranch` is the code that runs when
 * the flag is NOT '1' — the branch that must never write.
 */
function guardSites(src) {
  const out = [];
  const re = /if\s*\(\s*(!?)\s*coaBootRepairEnabled\(\)/g;
  let m;
  while ((m = re.exec(src))) {
    const negated = m[1] === '!';
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const consequent = { start: open, end: close };
    let alternate = null;
    const tail = src.slice(close + 1, close + 40).match(/^\s*else\s*\{/);
    if (tail) {
      const aOpen = close + tail[0].length;         // index of the else-branch '{'
      const aClose = matchBrace(src, aOpen);
      if (aClose > 0) alternate = { start: aOpen, end: aClose };
    }
    out.push({
      at: m.index, negated, consequent, alternate,
      offBranch: negated ? consequent : alternate,
      onBranch: negated ? alternate : consequent,
    });
  }
  return out;
}

const serverGuards = guardSites(server);
const bootGuards = guardSites(boot);

/** Is character index `i` inside either branch of some COA_BOOT_REPAIR guard? */
function guardedAt(guards, i) {
  return guards.some((g) =>
    (i > g.consequent.start && i < g.consequent.end) ||
    (g.alternate && i > g.alternate.start && i < g.alternate.end));
}

/** Assert every listed mutating statement in a named block sits inside a guard. */
function assertBlockGuarded(label, src, guards, startMark, endMark, mutations) {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start);
  check(`[${label}] the block is locatable`, start > 0 && end > start, { start, end });
  if (!(start > 0 && end > start)) return;
  const block = src.slice(start, end);
  check(`[${label}] the block consults COA_BOOT_REPAIR`,
    /coaBootRepairEnabled\(\)/.test(block));
  for (const needle of mutations) {
    const at = src.indexOf(needle, start);
    const found = at > 0 && at < end;
    check(`[${label}] mutation is present: ${needle.slice(0, 52).replace(/\s+/g, ' ')}…`, found);
    if (found) {
      check(`[${label}] …and it is INSIDE a COA_BOOT_REPAIR guard`, guardedAt(guards, at));
    }
  }
}

// ── 1. The flag: one switch, off by default, strict ───────────────────────
// A repair that rewrites the structure of posted history must require someone
// to type the documented value, not to satisfy a truthiness convention. And
// it must be read PER CALL: a module-level constant captured at require()
// time is invisible to anything that sets the variable afterwards.
{
  for (const [where, src] of [['server.js', server], ['bootstrap.js', boot]]) {
    check(`${where} defines coaBootRepairEnabled()`,
      /function coaBootRepairEnabled\s*\(\s*\)\s*\{/.test(src));
    check(`${where} reads process.env.COA_BOOT_REPAIR`,
      /process\.env\.COA_BOOT_REPAIR/.test(src));
    check(`${where} compares strictly against '1' — nothing else turns it on`,
      /return\s+process\.env\.COA_BOOT_REPAIR === '1';/.test(src));
    // The three ways a "default off" flag accidentally defaults ON.
    check(`${where} has no default value that would enable it`,
      !/process\.env\.COA_BOOT_REPAIR\s*\|\|\s*'1'/.test(src));
    check(`${where} does not accept 'true'/'on'/'yes' as ON`,
      !/COA_BOOT_REPAIR[^\n]*\b(true|on|yes)\b/i.test(src.replace(/^\s*[/*].*$/gm, '')));
    check(`${where} does not capture the flag in a module-level constant`,
      !/^const COA_BOOT_REPAIR\s*=/m.test(src));
  }
  check('server.js has a single diagnostic voice for the skipped repairs',
    /function coaDrift\(/.test(server) && /\[coa-drift\]/.test(server));
  check('…which names the flag in every skip message, so the log is actionable',
    /set COA_BOOT_REPAIR=1 to apply/.test(server));
}

// ── 2. The branch that runs with the flag OFF may not write ───────────────
// This is where the teeth are. Guarding a mutation is worthless if the
// diagnostic branch quietly writes too, and "log what it would do" is very
// easy to implement with an UPDATE still in it.
{
  check('server.js has COA_BOOT_REPAIR guard sites at all', serverGuards.length >= 7, serverGuards.length);
  check('bootstrap.js has COA_BOOT_REPAIR guard sites at all', bootGuards.length >= 4, bootGuards.length);

  // `gl_\b` would NEVER match `gl_accounts` — `_` and `a` are both word
  // characters, so there is no boundary between them. Match the table name.
  const writeSql = /(INSERT\s+(IGNORE\s+)?INTO|UPDATE\s+gl_\w+|DELETE\s+FROM)/i;
  for (const [where, src, guards] of [['server.js', server, serverGuards],
                                      ['bootstrap.js', boot, bootGuards]]) {
    let checked = 0;
    for (const g of guards) {
      if (!g.offBranch) continue;   // ON-only guard (`if (enabled) { … }`) — nothing runs when off
      const off = src.slice(g.offBranch.start, g.offBranch.end);
      const hit = off.match(writeSql);
      check(`${where} @${src.slice(0, g.at).split('\n').length}: the flag-OFF branch writes nothing`,
        !hit, hit ? hit[0] : undefined);
      checked++;
    }
    check(`${where} actually has flag-OFF branches to inspect`, checked >= 4, checked);
  }
}

// ── 3. Block by block: every boot-time chart mutation is behind the flag ──
//
// Located by content, not by line number — these blocks have moved several
// times and will move again. Each entry names the exact statements that used
// to run on every start.
{
  // (1) The only current inventory boot repair keeps the single 1200 control
  //     account under governed folder 100300. Numbered migration 0034 owns
  //     retirement of legacy stage/category accounts; boot never renumbers.
  assertBlockGuarded('inventory-control', server, serverGuards,
    '// Keep the single operational Inventory Control account',
    "[inventory-control] placement check skipped", [
      '"UPDATE gl_accounts SET parent_id = ?, level = ? WHERE code = \'1200\'"',
    ]);
  const inventoryControlStart = server.indexOf('// Keep the single operational Inventory Control account');
  const inventoryControlEnd = server.indexOf("[inventory-control] placement check skipped", inventoryControlStart);
  const inventoryControlBlock = server.slice(inventoryControlStart, inventoryControlEnd);
  const inventoryControlCode = inventoryControlBlock.replace(/^\s*\/\/.*$/gm, '');
  check('[inventory-control] boot never renumbers any account',
    !/SET code\s*=/.test(inventoryControlCode));
  check('[inventory-control] boot does not revive stage/category accounts',
    !/1210|1220|1230/.test(inventoryControlCode));

  // (2) V5.7.18 — writes account_name onto POSTED journal lines.
  assertBlockGuarded('V5.7.18', server, serverGuards,
    '// V5.7.18 — One-time backfill: gl_entries.account_name',
    'table may not exist yet on fresh installs', [
      'SET e.account_name = COALESCE(',
    ]);

  // (3) _repairInventoryClassification — UPDATEs parent_id on a NAME match.
  assertBlockGuarded('inventory-classification', server, serverGuards,
    '// v5.10.5 — Self-heal inventory misclassification once at boot',
    "'[migrate] inventory-classification: error'", [
      'erpRouter._repairInventoryClassification(db)',
    ]);
  check('[inventory-classification] the flag-off path still counts the drift',
    /would re-parent[^\n]*inventory-named account/.test(server));

  // (4) custody-fix — CREATES account 115 and re-parents custody accounts.
  assertBlockGuarded('custody-fix', server, serverGuards,
    "SELECT setting_value FROM settings WHERE setting_key = 'CustodyOutOfInventory_v1'",
    "catch (e) { console.error('[custody-fix]'", [
      'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_folder, report_section)',
      '"UPDATE gl_accounts SET parent_id = ?, report_section = \'receivables\' WHERE id = ?"',
      "VALUES ('CustodyOutOfInventory_v1','1')",
    ]);

  // (5) inv-merge — moves children of 112 to 113 and RENAMES 112.
  assertBlockGuarded('inv-merge', server, serverGuards,
    "SELECT setting_value FROM settings WHERE setting_key = 'InventoryDuplicateMerge_v1'",
    "catch (e) { console.error('[inv-merge]'", [
      '"UPDATE gl_accounts SET parent_id = ?, report_section = \'inventory\' WHERE id = ?"',
      "\"UPDATE gl_accounts SET name_ar = 'ذمم العملاء', report_section = 'receivables' WHERE id = ?\"",
      "VALUES ('InventoryDuplicateMerge_v1','1')",
    ]);

  // (7a) The party-dimension one-shot key, written from server.js.
  assertBlockGuarded('party-bootstrap', server, serverGuards,
    "const PARTY_KEY = 'PartyDimensionBootstrap_v1';",
    "catch (e) { console.error('[party] bootstrap skipped:'", [
      '"INSERT INTO settings (setting_key, setting_value) VALUES (?, \'1\') "',
    ]);
}

// ── 4. A diagnostic run must not spend the one-shot ───────────────────────
//
// The subtlest way to get this wrong: keep the settings-key write outside the
// guard. The repair would then be marked "done" by the first flag-off boot and
// could never run again — the block would be permanently retired without ever
// having executed. All three one-shot keys must be written only on the branch
// that actually did the work.
{
  for (const key of ["'CustodyOutOfInventory_v1','1'", "'InventoryDuplicateMerge_v1','1'", 'PARTY_KEY']) {
    const at = key === 'PARTY_KEY'
      ? server.indexOf('"INSERT INTO settings (setting_key, setting_value) VALUES (?, \'1\') "')
      : server.indexOf('VALUES (' + key + ')');
    check(`the one-shot write for ${key} is locatable`, at > 0, at);
    if (at > 0) check(`…and it only happens under COA_BOOT_REPAIR`, guardedAt(serverGuards, at));
  }
}

// ── 5. is_folder: the exception, and the bug inside it ────────────────────
//
// This block is deliberately NOT behind the flag, and the reason is what it
// writes: `display_order` is filled only where NULL, and `is_folder = 1 where
// the row has children` restates a fact the data already asserts. Neither can
// move an account, rename it, or relabel posted money — gating them would
// leave a fresh install with an unordered chart and rootless-looking roots.
//
// What WAS wrong is the root force-set. `code IN ('1','2','3','4','5')` is
// true in dev and FALSE IN PRODUCTION, where the roots are 100000..500000 —
// so in prod it has always matched zero rows while the log cheerfully claimed
// success, and on a chart that grew a real posting account numbered '5' it
// would silently promote it to a folder. Migration 0028 added `is_system_root`
// (parentless AND canonical for its type), which travels with the row instead
// of with a numbering scheme that differs per environment.
{
  const start = server.indexOf('// v5.10.43 — bulletproof migration');
  const end = server.indexOf("console.error('[v5.10.43] is_folder migration FAILED:'", start);
  check('[is_folder] the block is locatable', start > 0 && end > start, { start, end });
  const block = server.slice(start, end);

  check('[is_folder] it probes for gl_accounts.is_system_root',
    /coaHasColumn\('gl_accounts', 'is_system_root'\)/.test(block));
  check('[is_folder] the probe uses the file\'s INFORMATION_SCHEMA idiom',
    /INFORMATION_SCHEMA\.COLUMNS[\s\S]{0,200}TABLE_SCHEMA = DATABASE\(\)/.test(server));
  check('[is_folder] the roots are keyed off is_system_root, not off a code list',
    /UPDATE gl_accounts SET is_folder = 1 WHERE is_system_root = 1/.test(block));

  const legacyAt = block.indexOf("UPDATE gl_accounts SET is_folder = 1 WHERE code IN ('1','2','3','4','5')");
  const probeAt = block.indexOf('coaHasColumn');
  check('[is_folder] the hardcoded 1..5 list survives ONLY as a fallback',
    legacyAt > 0 && probeAt > 0 && probeAt < legacyAt, { probeAt, legacyAt });
  check('[is_folder] …reached only when the column is absent',
    /if \(hasSystemRoot\) \{[\s\S]{0,400}\} else \{[\s\S]{0,200}code IN \('1','2','3','4','5'\)/.test(block));
  check('[is_folder] …and it says so out loud instead of reporting success',
    /is_system_root absent \(run migration 0028\)/.test(block));

  // The exception has to be argued, not assumed. If someone later gates this
  // block anyway, or drops the reasoning, that is a decision worth re-reading.
  check('[is_folder] the block explains why it is NOT behind the flag',
    /WHY THIS BLOCK IS \*NOT\* BEHIND COA_BOOT_REPAIR/.test(block));
  check('[is_folder] display_order stays additive (only fills NULLs)',
    /WHERE display_order IS NULL/.test(server));
}

// ── 6. bootstrap.js, executed: no journal is posted unless the flag is set ─
//
// The static checks above prove the guard is written. This proves it WORKS,
// and — just as important — that it is not simply always-off. The three steps
// are plain functions of a `db` handle, so a stub connection is enough: no
// database, no server, no fixtures.
{
  const bootstrap = require('../lib/partyDimension/bootstrap');
  const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

  function harness() {
    const sql = [];
    const db = {
      async query(q, params) {
        sql.push(String(q).replace(/\s+/g, ' ').trim());
        const s = String(q);
        const p0 = (params || [])[0];
        if (/COALESCE\(SUM\(credit\) - SUM\(debit\), 0\) AS net/.test(s)) return [[{ net: 500, n: 3 }]];
        if (/GROUP BY j\.reference_type/.test(s)) {
          return [[{ reference_type: 'ApInvoice', reference_id: 'INV-1', net: 500 }]];
        }
        if (/FROM gl_entries WHERE account_code = \? AND party_id IS NULL/.test(s)) return [[{ n: 7 }]];
        if (/FROM gl_accounts WHERE code = \? AND \(dim_required/.test(s)) return [[{ n: 1 }]];
        if (/FROM gl_accounts WHERE code = \? AND is_active = 1/.test(s)) return [[{ n: 1 }]];
        if (/FROM gl_accounts WHERE code = \?/.test(s)) {
          if (p0 === '2100') return [[{ id: 'GL-2100', name_ar: 'دائنون متنوعون' }]];
          if (p0 === '2101') return [[{ id: 'GL-2101' }]];
          if (p0 === '2109') return [[{ id: 'GL-2109' }]];
          return [[{ id: 'GL-' + p0 }]];
        }
        if (WRITE.test(s)) return [{ affectedRows: 0 }];
        return [[]];
      },
    };
    const posted = [];
    const glPosting = {
      ensureCoreAccounts: async () => { posted.push('ensureCoreAccounts'); },
      postJournal: async () => { posted.push('postJournal'); return { success: true, journalNumber: 'JV-TEST' }; },
    };
    return { db, glPosting, sql, posted, log: () => {} };
  }

  async function runAllThree(h) {
    await bootstrap.nameControlAccount(h.db, h.log);
    await bootstrap.reclassifyLegacyAp(h.db, h.glPosting, h.log);
    await bootstrap.backfillParty(h.db, h.log);
  }

  probe = async () => {
    const before = process.env.COA_BOOT_REPAIR;
    try {
      // ── flag OFF ────────────────────────────────────────────────────────
      delete process.env.COA_BOOT_REPAIR;
      const off = harness();
      await runAllThree(off);
      check('flag OFF: NO journal is posted at boot', !off.posted.includes('postJournal'), off.posted);
      check('flag OFF: ensureCoreAccounts does not create ~25 accounts',
        !off.posted.includes('ensureCoreAccounts'), off.posted);
      const offWrites = off.sql.filter((s) => WRITE.test(s));
      check('flag OFF: not a single write statement is issued', offWrites.length === 0, offWrites);
      check('flag OFF: it still LOOKS — the detection queries do run', off.sql.length >= 5, off.sql.length);

      // ── flag ON — the contrapositive ────────────────────────────────────
      // A guard that can never open is a deletion wearing a flag. The repair
      // capability has to be provably still there.
      process.env.COA_BOOT_REPAIR = '1';
      const on = harness();
      await runAllThree(on);
      check('flag ON: the reclassification journal IS posted', on.posted.includes('postJournal'), on.posted);
      check('flag ON: the core accounts are ensured first',
        on.posted.indexOf('ensureCoreAccounts') < on.posted.indexOf('postJournal'), on.posted);
      const onWrites = on.sql.filter((s) => WRITE.test(s));
      check('flag ON: the writes are back', onWrites.length >= 3, onWrites.length);
      check('flag ON: the payables control account is renamed',
        onWrites.some((s) => /UPDATE gl_accounts SET name_ar = \?/.test(s)), onWrites);
      check('flag ON: 2101 is retired after the post',
        onWrites.some((s) => /UPDATE gl_accounts SET is_active = 0/.test(s)), onWrites);
      check('flag ON: the historical backfill lanes run',
        onWrites.some((s) => /UPDATE gl_entries/.test(s)), onWrites);

      // ── 'true' is not '1' ───────────────────────────────────────────────
      process.env.COA_BOOT_REPAIR = 'true';
      const fuzzy = harness();
      await runAllThree(fuzzy);
      check("a truthy-looking 'true' does NOT enable the repair",
        !fuzzy.posted.includes('postJournal') && fuzzy.sql.filter((s) => WRITE.test(s)).length === 0,
        fuzzy.posted);
    } finally {
      if (before === undefined) delete process.env.COA_BOOT_REPAIR;
      else process.env.COA_BOOT_REPAIR = before;
    }
  };
}

probe().then(() => {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✅ boot diagnoses the chart of accounts — it only rewrites it when COA_BOOT_REPAIR=1');
}).catch((e) => {
  console.error('\nFAILED (harness): ' + (e && e.stack || e));
  process.exit(1);
});
