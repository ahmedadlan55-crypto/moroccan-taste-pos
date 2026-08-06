/**
 * glSecurity.api.test.js — FC-P1 server-side GL security contract.
 *
 * Proves that the /api/erp/gl/* journal + account routes are now:
 *   1. RBAC-gated (requireCapability, permissions_v3) — a cashier is refused
 *      create/post/reverse/account-management with 403; a manager passes.
 *   2. actor-from-JWT — a spoofed body.username is IGNORED; created_by/posted_by
 *      are the authenticated user.
 *   3. posted-immutable — PUT on a posted journal → 409; /unpost → 409.
 *   4. server-validated — a line on a non-leaf or inactive account → 400; a
 *      bad-type / oversize attachment → 400.
 *
 * Runs only against testHarness's local `*_test` database. It creates one
 * disposable fixture root directly (normal clients are correctly forbidden
 * from creating another ledger root), then creates all ordinary accounts via
 * the governed HTTP endpoint and deletes the fixtures at the end.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// Activate the local-only isolated database before db/connection is loaded.
// The harness rejects managed/remote database variables and supplies a
// deterministic JWT key for fresh worktrees that intentionally have no .env.
const harness = require('../helpers/testHarness');
harness.activate();
// Tier A.2 corrective gate — used ONLY for fixture-reclamation cleanup
// (below), never for HTTP calls (those still go through the spawned
// server via api()). The mgrCreate journal below is a REAL journal that
// gets approved+posted during this test — posted journals are correctly
// immutable via the API (DELETE /gl/journals/:id refuses them), so the old
// cleanup ("DELETE via the API, swallow any failure") silently leaked one
// journal row into the real dev DB on every single run that reached
// 'posted'. Direct SQL is the test reclaiming its OWN fixture data, not a
// business operation — same pattern trialBalance.api.test.js already uses.
const db = require(path.join(ROOT, 'db', 'connection'));

const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
let BASE = '';

const T = {
  admin:    jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  manager:  jwt.sign({ id: 900201, username: 'glsec_mgr', role: 'manager', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  // Tier A.2 corrective gate — a SECOND manager identity, distinct from the
  // one that creates the journal below. lib/glTransitions.js now enforces
  // maker/checker (self-approval denied) on the single-id /approve route —
  // the exact route this file's approve→post lifecycle drives. Approving
  // with the SAME user that created the journal would now be correctly
  // refused; this checker identity is what makes "approve → ok" a true
  // statement again, instead of accidentally asserting a security hole.
  manager2: jwt.sign({ id: 900203, username: 'glsec_mgr2', role: 'manager', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  cashier:  jwt.sign({ id: 900202, username: 'glsec_cash', role: 'cashier', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
};

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

function api(method, pathname, tok, body) {
  return fetch(BASE + '/api' + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function j(method, pathname, tok, body) {
  const r = await api(method, pathname, tok, body);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function main() {
  console.log('\n═══ GL security contract (RBAC · JWT actor · immutable · validation) ═══\n');

  let server = null;
  let directRootId = null;
  const madeAccounts = [];
  const madeJournals = [];

  try {
    await harness.ensureSchema();

    // Normal clients are correctly forbidden from creating a sixth ledger
    // root. Create one disposable class-1 root directly in the isolated DB,
    // then exercise all ordinary account writes through the governed API.
    let baseCode = null;
    for (let candidate = 198000; candidate <= 199990; candidate += 10) {
      const candidateCodes = Array.from({ length: 6 }, (_, i) => String(candidate + i));
      const [used] = await db.query(
        'SELECT code FROM gl_accounts WHERE company_id = ? AND code IN (?,?,?,?,?,?) LIMIT 1',
        ['CO-MAIN', ...candidateCodes]
      );
      if (!used.length) { baseCode = candidate; break; }
    }
    if (baseCode == null) throw new Error('No free six-digit GLSEC fixture code range');

    directRootId = `GLSEC-ROOT-${Date.now()}-${process.pid}`;
    await db.query(
      'INSERT INTO gl_accounts ' +
      '(id, code, name_ar, name_en, type, parent_id, level, is_folder, is_active, status, ' +
      'company_id, normal_balance, is_contra, report_section, cash_flow_activity, tax_nature, ' +
      'is_postable, version, is_system_root, system_managed, class_code, balance) ' +
      "VALUES (?,?,?,?,?,NULL,1,1,1,'active','CO-MAIN','debit',0,'cash',NULL,'none',0,1,0,0,'1',0)",
      [directRootId, String(baseCode), 'جذر اختبار أمان الأستاذ', 'GL security test root', 'asset']
    );

    server = await harness.spawnServer({
      timeoutMs: 120000,
      extraEnv: { NODE_ENV: 'development', RATE_LIMIT_MAX: '1000000' },
    });
    BASE = `http://127.0.0.1:${server.port}`;
    check('isolated test server up', true);

    // ── Fixtures (admin) ─────────────────────────────────────────────────────
    // Two active leaves, one inactive leaf, and a folder with a child. Codes
    // obey the canonical six-digit class-1 policy; service-generated IDs are
    // captured from each successful HTTP response.
    const codeOf = {};
    async function createFixture(key, offset, extra) {
      const code = String(baseCode + offset);
      const r = await j('POST', '/erp/gl/accounts', T.admin, {
        code,
        nameAr: `حساب اختبار ${key}`,
        nameEn: `GL security ${key}`,
        type: 'asset',
        parentId: directRootId,
        reportSection: 'cash',
        ...(extra || {}),
      });
      if (!(r.status === 200 && r.data && r.data.success === true && r.data.id)) {
        check('fixture account ' + key, false, r);
        throw new Error(`Failed to create governed fixture account ${key}`);
      }
      codeOf[r.data.id] = code;
      madeAccounts.push(r.data.id);
      return r.data.id;
    }
    const A = await createFixture('A', 1);
    const B = await createFixture('B', 2);
    const INACT = await createFixture('INACTIVE', 3, { isActive: false });
    const PARENT = await createFixture('PARENT', 4, { isFolder: true });
    await createFixture('CHILD', 5, { parentId: PARENT });

    // reverse resolves accounts by CODE (lib/glPosting), so entries must carry
    // the real account code, not the id.
    const balanced = (dAcc, cAcc) => ([
      { accountId: dAcc, accountCode: codeOf[dAcc], accountName: dAcc, debit: 100, credit: 0 },
      { accountId: cAcc, accountCode: codeOf[cAcc], accountName: cAcc, debit: 0, credit: 100 },
    ]);

    // ── 1. RBAC — cashier is refused, manager passes ─────────────────────────
    const cashCreate = await j('POST', '/erp/gl/journals', T.cashier, { journalDate: '2026-01-05', description: 'x', entries: balanced(A, B) });
    check('cashier create journal → 403', cashCreate.status === 403, cashCreate);
    const cashAcct = await j('POST', '/erp/gl/accounts', T.cashier, { code: 'Z', nameAr: 'Z', type: 'asset' });
    check('cashier manage account → 403', cashAcct.status === 403, { status: cashAcct.status });

    const mgrCreate = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'mgr create', username: 'HACKER', entries: balanced(A, B),
    });
    check('manager create journal → ok', mgrCreate.data && mgrCreate.data.success === true, mgrCreate.data);
    const jid = mgrCreate.data && mgrCreate.data.id;
    if (jid) madeJournals.push(jid);

    // ── 2. actor from JWT — body.username='HACKER' ignored ───────────────────
    const listed = await j('GET', '/erp/gl/journals', T.manager);
    const row = Array.isArray(listed.data) ? listed.data.find((r) => r.id === jid) : null;
    check('created_by = JWT user (not body HACKER)', !!row && row.createdBy === 'glsec_mgr', row && { createdBy: row.createdBy });

    // ── 3. approve + post lifecycle — checker (manager2) ≠ creator (manager) ──
    // Tier A.2 — glTransitions.js's maker/checker enforcement means the
    // CREATOR approving their own journal is denied; manager2 here is a
    // different user, so this correctly proves the happy path still works.
    const appr = await j('POST', `/erp/gl/journals/${jid}/approve`, T.manager2, { username: 'HACKER' });
    check('manager2 (different user) approve → ok', appr.data && appr.data.success === true, appr.data);
    const posted = await j('POST', `/erp/gl/journals/${jid}/post`, T.manager2, {});
    check('manager2 post → ok', posted.data && posted.data.success === true, posted.data);
    // cashier cannot post
    const cashPost = await j('POST', `/erp/gl/journals/${jid}/post`, T.cashier, {});
    check('cashier post → 403', cashPost.status === 403, { status: cashPost.status });

    // ── 4. posted is immutable — PUT → 409, unpost → 409 ─────────────────────
    const putPosted = await j('PUT', `/erp/gl/journals/${jid}`, T.manager, {
      journalDate: '2026-01-06', description: 'edit posted', entries: balanced(A, B),
    });
    check('PUT posted journal → 409', putPosted.status === 409, { status: putPosted.status, code: putPosted.data && putPosted.data.code });
    const unpost = await j('POST', `/erp/gl/journals/${jid}/unpost`, T.manager, {});
    check('unpost posted journal → 409', unpost.status === 409, { status: unpost.status, code: unpost.data && unpost.data.code });

    // cashier cannot reverse; manager can
    const cashRev = await j('POST', `/erp/gl/journals/${jid}/reverse`, T.cashier, { reason: 'x' });
    check('cashier reverse → 403', cashRev.status === 403, { status: cashRev.status });
    const mgrRev = await j('POST', `/erp/gl/journals/${jid}/reverse`, T.manager, { reason: 'correction' });
    check('manager reverse → ok', mgrRev.data && mgrRev.data.success === true, mgrRev.data);
    if (mgrRev.data && mgrRev.data.newJournalId) madeJournals.push(mgrRev.data.newJournalId);

    // ── 5. server-side line validation (manager create) ──────────────────────
    const nonLeaf = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'non-leaf', entries: balanced(PARENT, B),
    });
    check('post to non-leaf account → 400', nonLeaf.status === 400, { status: nonLeaf.status, err: nonLeaf.data && nonLeaf.data.error });
    const inactive = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'inactive', entries: balanced(INACT, B),
    });
    check('post to inactive account → 400', inactive.status === 400, { status: inactive.status, err: inactive.data && inactive.data.error });

    // ── 6. attachment validation ─────────────────────────────────────────────
    const badType = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'bad attach', attachment: 'data:text/plain;base64,AAAA', entries: balanced(A, B),
    });
    check('bad attachment type → 400', badType.status === 400, { status: badType.status });
    const huge = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);
    const bigAttach = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'huge attach', attachment: huge, entries: balanced(A, B),
    });
    check('oversize attachment → 400', bigAttach.status === 400, { status: bigAttach.status });

  } catch (e) {
    check('no exception', false, e && e.message);
  } finally {
    // cleanup — direct SQL for journals (this is fixture reclamation, not a
    // business operation; the API's DELETE correctly REFUSES a posted
    // journal, and mgrCreate's journal above is posted by the time cleanup
    // runs, so calling the API here would silently leak it — see the note
    // on the `db` require above), then accounts via the API.
    for (const id of madeJournals) {
      try { await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [id]); } catch (_) {}
    }
    for (const id of madeJournals.slice().reverse()) {
      try { await db.query('DELETE FROM gl_journals WHERE id = ?', [id]); } catch (_) {}
    }
    for (const id of madeAccounts.slice().reverse()) {
      try { if (server) await api('DELETE', '/erp/gl/accounts/' + id, T.admin); } catch (_) {}
      // If the server failed before HTTP cleanup, still reclaim only this
      // test's own rows from the isolated database.
      try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [id]); } catch (_) {}
    }
    if (directRootId) {
      try { await db.query('DELETE FROM gl_accounts WHERE id = ?', [directRootId]); } catch (_) {}
    }
    if (server) server.kill();
    try { await db.end(); } catch (_) {}
  }

  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}

main();
