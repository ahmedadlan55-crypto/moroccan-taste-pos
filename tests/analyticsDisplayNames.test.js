'use strict';
/**
 * tests/analyticsDisplayNames.test.js — a finished report must read as NAMES.
 * Run: node tests/analyticsDisplayNames.test.js
 *
 * REAL MySQL, REAL QueryService.run(). Nothing here asserts against a pasted
 * copy of a query or calls the resolver with hand-built rows: the fixture is
 * written with direct SQL (tests/fixtures/salesHubSeed), the engine is asked a
 * normal analytics question, and the labels on the answer are what is checked.
 *
 * TWO defects this pins:
 *
 * (a) EMPLOYEE DIMENSIONS HAD NO LABEL AT ALL. cashier/salesperson/void_by/…
 *     read VARCHAR usernames out of the fact row, so every employee report
 *     printed the LOGIN ID — the same defect lib/displayName.js exists to kill
 *     on the receipt. The label must be the string THAT helper produces, not a
 *     second opinion: its rule spans two stores (users.full_name →
 *     settings.user_meta[username].name → username) and a plain `users` read
 *     cannot see the second one. Two names for one person in one product is
 *     the failure mode, so the assertions below compare against the helper's
 *     own output — never against a constant that could drift away from it.
 *
 * (b) name_en WAS FETCHED AND THROWN AWAY. The menu_item descriptor already
 *     selected ['name','name_en'] and then always emitted cols[0], so English
 *     readers got Arabic. And once English is preferred, an item whose name_en
 *     is NULL falls back to Arabic — which is indistinguishable from a
 *     translation unless the row SAYS it fell back. The flag must be structured
 *     (row.labelFallback[dimId]), because a "‡" glued onto the label becomes
 *     part of the data the moment the report is exported to CSV.
 *
 * Fixture window 2032-03 under its own prefix (ITEST-ADN-*), disjoint from
 * every other suite. Cleanup before AND in finally; settings.user_meta is a
 * SHARED singleton row, so its original value is restored byte-for-byte.
 */
require('dotenv').config();

const db = require('../db/connection');
const QueryService = require('../services/analytics/QueryService');
const displayName = require('../lib/displayName');
const DIMS = require('../lib/analytics/registry/dimensions');
const seedMod = require('./fixtures/salesHubSeed');

const PREFIX = 'ITEST-ADN';
const RANGE = { from: '2032-03-01', to: '2032-03-31' };
const SCOPE = { all: true, caps: new Set(['analytics.view', 'analytics.employees.view']) };

// The fixture's own strings — written to the DB below, then read BACK out of
// it for every expectation, so the test measures what the engine resolved from
// the database rather than what this file believes is in it.
const AR_M1 = 'برجر تجريبي';
const EN_M1 = 'ADN Test Burger';
const AR_M2 = 'ماء تجريبي';          // name_en stays NULL → genuinely missing
const AR_M3 = 'كومبو تجريبي';        // name_en = '   ' → blank is ALSO missing
const FULL_NAME_C1 = 'أحمد عدلان';     // users.full_name
const META_NAME_C2 = 'سارة القحطاني';  // settings.user_meta only (legacy store)

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else {
    fail++; fails.push(name);
    console.log('  ❌', name, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 300) : '');
  }
}

const q = (over) => Object.assign({
  metrics: ['net_ex_vat'],
  dimensions: ['menu_item'],
  range: { from: RANGE.from, to: RANGE.to },
  // MAX_LIMIT — other suites seed this same far-future window under their own
  // prefixes, and a page that cut them off could hide one of OUR rows.
  limit: 500,
  noCache: true,
}, over);

const rowFor = (env, dim, key) =>
  (env.data.rows || []).find((r) => String(r.keys[dim]) === String(key));

(async () => {
  let metaOriginal = null;
  const I = seedMod.ids(PREFIX);
  const GHOST_USER = `${PREFIX}-ghost`;      // no users row, no user_meta entry
  const GHOST_MENU = `${PREFIX}-GHOSTM`;     // a menu id with no menu row

  await seedMod.cleanup(db, PREFIX);
  await db.query('DELETE FROM users WHERE username IN (?)', [[I.C1, I.C2]]);

  try {
    await seedMod.seed(db, PREFIX);

    // ── catalog: one item WITH English, one with NULL, one with BLANK ──
    await db.query('UPDATE menu SET name = ?, name_en = ? WHERE id = ?', [AR_M1, EN_M1, I.M1]);
    await db.query('UPDATE menu SET name = ?, name_en = NULL WHERE id = ?', [AR_M2, I.M2]);
    await db.query('UPDATE menu SET name = ?, name_en = ? WHERE id = ?', [AR_M3, '   ', I.M3]);

    // ── people: the two stores, and a person in neither ──
    await db.query(
      'INSERT INTO users (username, password, role, active, full_name) VALUES (?,?,?,1,?)',
      [I.C1, 'x', 'cashier', FULL_NAME_C1]);
    await db.query(
      'INSERT INTO users (username, password, role, active, full_name) VALUES (?,?,?,1,NULL)',
      [I.C2, 'x', 'cashier']);
    const [metaRows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
    metaOriginal = metaRows.length ? metaRows[0].setting_value : null;
    const meta = (() => { try { return JSON.parse(metaOriginal || '{}') || {}; } catch (_) { return {}; } })();
    meta[I.C2] = { name: META_NAME_C2, empNo: 'ADN-2' };
    if (metaRows.length) {
      await db.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'user_meta'", [JSON.stringify(meta)]);
    } else {
      await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?)', ['user_meta', JSON.stringify(meta)]);
    }

    // D8A: a sale booked by somebody who is in no store at all, on a line
    // whose menu id no longer exists in the catalog (a deleted item).
    await db.query('UPDATE analytics_order_facts SET created_by = ? WHERE document_id = ?', [GHOST_USER, I.D8A]);
    await db.query('UPDATE ar_document_lines SET menu_id = ? WHERE document_id = ?', [GHOST_MENU, I.D8A]);
    // A second employee dimension, to prove the resolver is not cashier-only.
    await db.query('UPDATE analytics_order_facts SET salesperson = ? WHERE document_id = ?', [I.C2, I.D1]);

    // What the DB actually holds — every expectation is read from here.
    const [menuRows] = await db.query('SELECT id, name, name_en FROM menu WHERE id IN (?)',
      [[I.M1, I.M2, I.M3]]);
    const menuById = Object.fromEntries(menuRows.map((r) => [r.id, r]));

    // ══ (a) employee dimensions ══════════════════════════════════════════
    console.log('\n── (a) people read as names ──');

    check('EVERY kind:"employee" dimension carries a label descriptor',
      DIMS.DIMENSIONS.filter((d) => d.kind === 'employee').length === 7 &&
      DIMS.DIMENSIONS.filter((d) => d.kind === 'employee').every((d) => !!d.label),
      DIMS.DIMENSIONS.filter((d) => d.kind === 'employee' && !d.label).map((d) => d.id));

    check('employee labels route to the PERSON resolver, not to a users-table read',
      DIMS.DIMENSIONS.filter((d) => d.kind === 'employee')
        .every((d) => !!d.label && d.label.resolver === 'person' && !d.label.table),
      DIMS.DIMENSIONS.filter((d) => d.kind === 'employee').map((d) => d.label));

    const enCashier = await QueryService.run(db, q({ dimensions: ['cashier'], lang: 'en' }), SCOPE);
    const arCashier = await QueryService.run(db, q({ dimensions: ['cashier'] }), SCOPE);

    // The authority itself, driven for the same usernames the report grouped on.
    const usernames = (enCashier.data.rows || []).map((r) => r.keys.cashier).filter((v) => v != null);
    const people = await displayName.resolveCashierIdentities(db, usernames.map(String));

    check('the report grouped on the usernames the fixture booked',
      usernames.includes(I.C1) && usernames.includes(GHOST_USER), usernames);

    const c1Row = rowFor(enCashier, 'cashier', I.C1);
    check('cashier label === the string lib/displayName produces (users.full_name)',
      !!c1Row && c1Row.labels.cashier === people[I.C1].name,
      { got: c1Row && c1Row.labels.cashier, helper: people[I.C1] && people[I.C1].name });
    check('…and that string is the NAME, not the login id',
      !!c1Row && c1Row.labels.cashier === FULL_NAME_C1 && c1Row.labels.cashier !== I.C1,
      c1Row && c1Row.labels.cashier);

    const ghostRow = rowFor(enCashier, 'cashier', GHOST_USER);
    check('an unknown employee id degrades to the login id — the helper\'s honest fallback, no throw',
      !!ghostRow && ghostRow.labels.cashier === people[GHOST_USER].name &&
      ghostRow.labels.cashier === GHOST_USER,
      ghostRow && ghostRow.labels);

    check('the Arabic request resolves people identically (a name has no language)',
      !!rowFor(arCashier, 'cashier', I.C1) &&
      rowFor(arCashier, 'cashier', I.C1).labels.cashier === people[I.C1].name);

    // The two-store rule: C2's users row has NO full_name, only user_meta does.
    const spEn = await QueryService.run(db, q({ dimensions: ['salesperson'], lang: 'en' }), SCOPE);
    const spRow = rowFor(spEn, 'salesperson', I.C2);
    const c2Identity = await displayName.resolveCashierIdentity(db, I.C2);
    check('a SECOND employee dimension resolves through the same authority',
      !!spRow && spRow.labels.salesperson === c2Identity.name,
      { got: spRow && spRow.labels.salesperson, helper: c2Identity.name });
    check('a name that lives ONLY in settings.user_meta still surfaces (no second opinion)',
      !!spRow && spRow.labels.salesperson === META_NAME_C2,
      spRow && spRow.labels);
    const spNull = (spEn.data.rows || []).find((r) => r.keys.salesperson == null);
    check('a NULL employee key yields no label and no crash',
      !!spNull && spNull.labels.salesperson === undefined, spNull && spNull.labels);

    // ══ (b) item names ═══════════════════════════════════════════════════
    console.log('\n── (b) items read in the requested language ──');

    const enItems = await QueryService.run(db, q({ lang: 'en' }), SCOPE);
    const arItems = await QueryService.run(db, q({ lang: 'ar' }), SCOPE);
    const noLang = await QueryService.run(db, q({}), SCOPE);

    check('the fixture is not vacuous: name_en differs from name',
      menuById[I.M1].name_en === EN_M1 && menuById[I.M1].name === AR_M1 &&
      menuById[I.M1].name_en !== menuById[I.M1].name);

    const m1En = rowFor(enItems, 'menu_item', I.M1);
    check('EN: an item WITH name_en reads in English',
      !!m1En && m1En.labels.menu_item === menuById[I.M1].name_en,
      m1En && m1En.labels);
    check('EN: a real translation is NOT flagged as a fallback',
      !!m1En && m1En.labelFallback.menu_item === undefined, m1En && m1En.labelFallback);

    const m2En = rowFor(enItems, 'menu_item', I.M2);
    check('EN: a NULL name_en falls back to the Arabic name…',
      !!m2En && m2En.labels.menu_item === menuById[I.M2].name && m2En.labels.menu_item === AR_M2,
      m2En && m2En.labels);
    check('…and the row CARRIES the missing-English flag',
      !!m2En && m2En.labelFallback.menu_item === true, m2En && m2En.labelFallback);
    check('the flag is STRUCTURED — the label string itself is the clean name',
      !!m2En && m2En.labels.menu_item === AR_M2 && !/[‡*†()]/.test(m2En.labels.menu_item),
      m2En && m2En.labels.menu_item);

    const m3En = rowFor(enItems, 'menu_item', I.M3);
    check('EN: a WHITESPACE-ONLY name_en is missing too (NULLIF(TRIM(x),"") semantics)',
      !!m3En && m3En.labels.menu_item === AR_M3 && m3En.labelFallback.menu_item === true,
      m3En && { l: m3En.labels, f: m3En.labelFallback });

    check('AR: every item reads Arabic and NOTHING is flagged',
      (arItems.data.rows || []).every((r) => !r.labelFallback || Object.keys(r.labelFallback).length === 0) &&
      rowFor(arItems, 'menu_item', I.M1).labels.menu_item === AR_M1 &&
      rowFor(arItems, 'menu_item', I.M2).labels.menu_item === AR_M2,
      (arItems.data.rows || []).map((r) => [r.keys.menu_item, r.labels.menu_item, r.labelFallback]));

    check('no lang ⇒ the Arabic path, unchanged (the pre-existing behaviour)',
      rowFor(noLang, 'menu_item', I.M1).labels.menu_item === AR_M1 &&
      rowFor(noLang, 'menu_item', I.M1).labelFallback.menu_item === undefined);

    const ghostItem = rowFor(enItems, 'menu_item', GHOST_MENU);
    check('an unknown item id degrades safely: the row survives with no label, no throw',
      !!ghostItem && ghostItem.labels.menu_item === undefined &&
      ghostItem.labelFallback.menu_item === undefined,
      ghostItem && { keys: ghostItem.keys, labels: ghostItem.labels });

    // ══ language is part of the CACHE identity ═══════════════════════════
    console.log('\n── language cannot be served out of the wrong cache entry ──');
    const cachedAr = await QueryService.run(db, q({ noCache: false }), SCOPE);
    const cachedEn = await QueryService.run(db, q({ noCache: false, lang: 'en' }), SCOPE);
    check('an English request is never answered from the Arabic cache entry',
      rowFor(cachedAr, 'menu_item', I.M1).labels.menu_item === AR_M1 &&
      rowFor(cachedEn, 'menu_item', I.M1).labels.menu_item === EN_M1,
      { ar: rowFor(cachedAr, 'menu_item', I.M1).labels, en: rowFor(cachedEn, 'menu_item', I.M1).labels });
  } finally {
    try { await seedMod.cleanup(db, PREFIX); } catch (_) { /* best effort */ }
    try { await db.query('DELETE FROM users WHERE username IN (?)', [[I.C1, I.C2]]); } catch (_) {}
    // settings.user_meta is shared with the whole install — put it back exactly.
    try {
      if (metaOriginal !== null) {
        await db.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'user_meta'", [metaOriginal]);
      } else {
        await db.query("DELETE FROM settings WHERE setting_key = 'user_meta'");
      }
    } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILURES: ' + fails.join(' | ')) +
    ` — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n❌ test harness threw:', e && e.stack ? e.stack : e);
  process.exit(1);
});
