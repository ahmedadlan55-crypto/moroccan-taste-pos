/** Unit — lib/displayName.js (no DB; a fake pool records every query).
 *  Run: node tests/displayName.test.js
 *
 * THE LIVE DEFECT: the POS receipt printed the cashier's LOGIN ID ("2004")
 * instead of his name — «لا يجوز وغير قوي». The till had no name to print
 * because the JWT carried none, and the reprint path resolved one from a
 * DIFFERENT store (settings.user_meta) than every other reader in the repo
 * (users.full_name, routes/auth.js:696 / lib/transactionGuards.js:130).
 *
 * These guard the ONE rule that replaced both:
 *     users.full_name → settings.user_meta[username].name → username
 * with a whitespace-only value in any layer falling through, exactly like the
 * SQL COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) at server.js:3782.
 */
'use strict';
const D = require('../lib/displayName');

let _p = 0, _f = 0;
const check = (n, c, x) => {
  if (c) { _p++; console.log('  ✅', n); }
  else { _f++; console.log('  ❌', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); }
};

/** A fake mysql2 pool. `users` maps username → full_name (raw, untrimmed);
 *  `meta` is the settings.user_meta object. `fail` makes a table throw, which
 *  is how a pre-migration schema behaves. */
function fakeDb({ users = {}, meta = null, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM users/i.test(sql)) {
        if (fail.users) throw Object.assign(new Error("Unknown column 'full_name'"), { errno: 1054 });
        const wanted = (params && params[0]) || [];
        const rows = [];
        wanted.forEach((u) => {
          if (Object.prototype.hasOwnProperty.call(users, u)) {
            const raw = users[u];
            // Mirror COALESCE(NULLIF(TRIM(full_name), ''), '') server-side.
            rows.push({ username: u, display_name: raw == null ? '' : String(raw).trim() });
          }
        });
        return [rows];
      }
      if (/user_meta/i.test(sql)) {
        if (fail.settings) throw new Error('settings table missing');
        return [meta === null ? [] : [{ setting_value: JSON.stringify(meta) }]];
      }
      return [[]];
    },
  };
}

(async function run() {
  console.log('\n═══ displayName — one authority for "what is this person called" ═══');

  // ── pickDisplayName: the rule itself, pure ──
  console.log('\n── pickDisplayName (precedence) ──');
  check('full_name wins over BOTH user_meta and username',
    D.pickDisplayName({ fullName: 'أحمد عدلان', metaName: 'اسم قديم', username: '2004' }) === 'أحمد عدلان');
  check('user_meta.name is used when full_name is unset (legacy accounts keep their name)',
    D.pickDisplayName({ fullName: '', metaName: 'أحمد عدلان', username: '2004' }) === 'أحمد عدلان');
  check('username is the last resort — never blank on paper',
    D.pickDisplayName({ fullName: '', metaName: '', username: '2004' }) === '2004');
  check('whitespace-only full_name falls through (NULLIF(TRIM(x),"") semantics)',
    D.pickDisplayName({ fullName: '   ', metaName: 'أحمد', username: '2004' }) === 'أحمد');
  check('whitespace-only in EVERY layer ⇒ username',
    D.pickDisplayName({ fullName: '  ', metaName: '\t', username: '2004' }) === '2004');
  check('a real name is TRIMMED before it reaches paper',
    D.pickDisplayName({ fullName: '  أحمد عدلان  ', username: '2004' }) === 'أحمد عدلان');
  check('nothing at all ⇒ empty string, not "undefined"',
    D.pickDisplayName({}) === '' && D.pickDisplayName() === '');
  check('non-string values are coerced, not crashed on',
    D.pickDisplayName({ fullName: null, metaName: undefined, username: 2004 }) === '2004');

  // ── resolveCashierIdentity: the DB-backed form ──
  console.log('\n── resolveCashierIdentity ──');
  let db = fakeDb({ users: { 2004: 'أحمد عدلان' }, meta: { 2004: { name: 'اسم قديم', empNo: 'E-17' } } });
  let id = await D.resolveCashierIdentity(db, '2004');
  check('THE FIX: the disagreeing-stores case resolves to full_name',
    id.name === 'أحمد عدلان', id);
  check('empNo still comes from user_meta (no users column exists for it)', id.empNo === 'E-17');
  check('username echoed back for the caller', id.username === '2004');

  db = fakeDb({ users: { 2004: '' }, meta: { 2004: { name: 'أحمد عدلان' } } });
  id = await D.resolveCashierIdentity(db, '2004');
  check('blank full_name ⇒ user_meta name (no regression for legacy installs)', id.name === 'أحمد عدلان');

  db = fakeDb({ users: { 2004: null }, meta: null });
  id = await D.resolveCashierIdentity(db, '2004');
  check('no name anywhere ⇒ the login id, honestly', id.name === '2004' && id.empNo === '');

  db = fakeDb({ users: {}, meta: { 2004: { empNo: 'E-17' } } });
  id = await D.resolveCashierIdentity(db, '2004');
  check('empNo without a name ⇒ name falls to username, empNo still surfaces',
    id.name === '2004' && id.empNo === 'E-17');

  // Schema tolerance — the auth path must never 500 over a cosmetic name.
  db = fakeDb({ fail: { users: true }, meta: { 2004: { name: 'أحمد عدلان' } } });
  id = await D.resolveCashierIdentity(db, '2004');
  check('users.full_name missing (pre-server.js:3695 schema) ⇒ degrades, does not throw',
    id.name === 'أحمد عدلان');

  db = fakeDb({ users: { 2004: 'أحمد عدلان' }, fail: { settings: true } });
  id = await D.resolveCashierIdentity(db, '2004');
  check('settings unreadable ⇒ still resolves from users.full_name', id.name === 'أحمد عدلان');

  db = fakeDb({ fail: { users: true, settings: true } });
  id = await D.resolveCashierIdentity(db, '2004');
  check('BOTH stores unreadable ⇒ the username, never a throw', id.name === '2004');

  db = fakeDb();
  id = await D.resolveCashierIdentity(db, '   ');
  check('blank username ⇒ empty identity and ZERO queries',
    id.name === '' && id.username === '' && db.calls.length === 0, db.calls);

  // The caller-supplied-full_name shortcut used by the login handler
  // (routes/auth.js SELECT * already has the row in hand).
  db = fakeDb({ users: { 2004: 'من قاعدة البيانات' }, meta: null });
  id = await D.resolveCashierIdentity(db, '2004', { fullName: 'أحمد عدلان' });
  check('opts.fullName is used verbatim and SKIPS the users query',
    id.name === 'أحمد عدلان' && !db.calls.some((c) => /FROM users/i.test(c)), db.calls);

  db = fakeDb({ users: { 2004: 'من قاعدة البيانات' }, meta: { 2004: { name: 'من user_meta' } } });
  id = await D.resolveCashierIdentity(db, '2004', { fullName: null });
  check('opts.fullName=null means KNOWN-empty ⇒ next layer, no users query',
    id.name === 'من user_meta' && !db.calls.some((c) => /FROM users/i.test(c)), db.calls);

  db = fakeDb({ users: { 2004: 'من قاعدة البيانات' }, meta: null });
  id = await D.resolveCashierIdentity(db, '2004', { fullName: undefined });
  check('opts.fullName=undefined (old schema: column absent from the row) ⇒ DOES query',
    id.name === 'من قاعدة البيانات' && db.calls.some((c) => /FROM users/i.test(c)), db.calls);

  db = fakeDb({ users: { 2004: 'أحمد عدلان' } });
  id = await D.resolveCashierIdentity(db, '2004', { userMeta: { 2004: { empNo: 'E-9' } } });
  check('opts.userMeta SKIPS the settings query (bulk callers)',
    id.empNo === 'E-9' && !db.calls.some((c) => /user_meta/i.test(c)), db.calls);

  // ── resolveCashierIdentities: bulk, still two queries ──
  console.log('\n── resolveCashierIdentities (bulk) ──');
  db = fakeDb({
    users: { 2004: 'أحمد عدلان', 2005: '   ' },
    meta: { 2005: { name: 'سارة', empNo: 'E-2' } },
  });
  const many = await D.resolveCashierIdentities(db, ['2004', '2005', '2006', '2004', '  ', null]);
  check('TWO queries total regardless of row count', db.calls.length === 2, db.calls);
  check('each username resolves by the same rule',
    many['2004'].name === 'أحمد عدلان' && many['2005'].name === 'سارة' && many['2006'].name === '2006', many);
  check('unknown username still gets an entry (its own login id)', many['2006'].empNo === '');
  check('duplicates and blanks are dropped', Object.keys(many).length === 3, Object.keys(many));

  db = fakeDb();
  check('empty list ⇒ {} and ZERO queries',
    Object.keys(await D.resolveCashierIdentities(db, [])).length === 0 && db.calls.length === 0);

  // ── the SQL fragment stays byte-identical to the repo's existing rule ──
  console.log('\n── DISPLAY_NAME_SQL ──');
  check('matches server.js:3782 / routes/hr.js:666 exactly',
    D.DISPLAY_NAME_SQL === "COALESCE(NULLIF(TRIM(u.full_name), ''), u.username)", D.DISPLAY_NAME_SQL);

  console.log('\n' + (_f === 0 ? '✅ ALL PASS' : '❌ FAILURES') + ` — ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n❌ test harness threw:', e);
  process.exit(1);
});
