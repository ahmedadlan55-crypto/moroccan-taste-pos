const router = require('express').Router();
const db = require('../db/connection');
const { ensureCoreAccounts, nextFlatJournalNumber, CORE_ACCOUNTS } = require('../lib/glPosting');
// v5.11.1 — official 150-account COA template (mirrored from the Excel
// the user attached). Loaded once at boot, used by /gl/seed-from-template
// to seed or refresh the chart of accounts in one click.
const COA_TEMPLATE = require('../db/coa-template.json');
// v5.11.3 — developer-only guard for destructive journal endpoints.
// guardBreakGlass fences the one endpoint that deletes the whole ledger.
const { guardDeveloper, guardBreakGlass } = require('../lib/transactionGuards');
// FC-P1 — fine-grained GL capability guard (permissions_v3). Fails closed.
const requireCapability = require('../middleware/requireCapability');
const coaTree = require('../lib/coa/tree');
const coaClassify = require('../lib/coa/classify');
// Package D — the ONE write gate for the chart of accounts. Every mutation of
// gl_accounts that used to live inline in this file (the upsert, /move,
// /:id/folder, DELETE) now runs its guards, its version check and its audit
// row inside lib/coa/service.js, so the four writers can no longer know four
// different subsets of the rules.
const coaService = require('../lib/coa/service');
// Additive-only importer. Every request returns through this module before the
// quarantined historical implementation later in the handler can execute.
const coaImport = require('../lib/coa/import');
// Phase 0 (Contracts & Safety) — managerial RBAC for warehouse master-data
// mutations (a warehouse with movement may never be hard-deleted) and for the
// legacy warehouse_transfers stock-moving endpoints.
const MGR = require('../middleware/auth').requireRole('admin', 'manager');
// Tier A.2 corrective gate, Section 3 — the single canonical audit writer.
// This file used to keep its own local auditLog() helper, a duplicate that
// had drifted onto the wrong audit_logs column names for a while (fixed in
// Tier A.1) — exactly the risk a second copy of the same logic invites.
const { logAudit } = require('../lib/auditLogger');
// Phase 0 §5 — actor identity from the authenticated JWT, never a body field.
function _actor(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
}

// Package D — the single failure path for every chart-of-accounts mutation.
//
// Every COA handler below used to answer a rejected write with **HTTP 200 and
// `{success:false}`**. A 200 is a promise that the request was carried out, so
// every HTTP-level consumer — a proxy, a retry policy, a monitoring probe, a
// test asserting `res.ok`, a `fetch` wrapper that only throws on !ok — read a
// refused write as a completed one. The status now comes from the thrown
// error's own `httpStatus` (see lib/coa/service.js ERROR_STATUS), and a
// stable machine-readable `code` travels with it so a client can branch on the
// REASON without matching Arabic prose. `success:false` and `error` stay, so
// the existing frontend keeps working unchanged.
function _coaFail(res, e, where) {
  const mapped = coaService.toHttpError(e);
  if (mapped.httpStatus >= 500) {
    console.error('[coa/' + (where || 'write') + '] UNEXPECTED:', (e && e.stack) || e);
  } else {
    console.warn('[coa/' + (where || 'write') + '] ' + mapped.code + ': ' + mapped.error);
  }
  const body = { success: false, code: mapped.code, error: mapped.error };
  if (mapped.details) body.details = mapped.details;
  return res.status(mapped.httpStatus).json(body);
}

// Context every COA mutation needs: WHO (from the JWT, never the body), from
// WHERE, and the optimistic-concurrency token the caller is betting on.
function _coaCtx(req) {
  return {
    actor: _actor(req),
    ip: req.ip || req.headers['x-forwarded-for'] || '',
    expectedVersion: (req.body && req.body.expectedVersion) !== undefined
      ? req.body.expectedVersion
      : undefined,
  };
}


// FC-P1 — server-side journal-line validation shared by create + edit. Every
// posting line must reference an EXISTING, ACTIVE, LEAF (postable) account, so
// a client can never post to a header/group or a deactivated account. Returns
// an Arabic error string, or null when all lines are valid.
async function _validateJournalLines(conn, entries) {
  const q = conn || db;
  for (const e of (entries || [])) {
    const accId = e.accountId || e.account_id || null;
    if (!accId) continue; // balance/min-lines checks cover empty lines elsewhere
    // Package D — the postability rule lives in ONE place now. This site used
    // to check is_active + childless and nothing else, so a childless account
    // flagged is_folder=1 was postable here while the trial balance refused to
    // count it, and migration 0028's 'blocked' status (refuse new postings,
    // keep the account visible) had no effect at all on the posting path.
    const [rows] = await q.query(
      `SELECT a.is_active, a.is_folder, a.status,
              (NOT EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_id = a.id)) AS is_leaf
         FROM gl_accounts a WHERE a.id = ? LIMIT 1`,
      [accId]
    );
    if (!rows.length) return 'حساب غير موجود في أحد السطور';
    const problem = coaService.postabilityProblem(rows[0], { hasChildren: !Number(rows[0].is_leaf) });
    if (problem) return problem.message;
  }
  return null;
}

// FC-P1 — attachment guard: inline data URLs only, image/* or application/pdf,
// decoded size ≤ 5MB. Returns an Arabic error string, or null when acceptable
// (or absent — the attachment is optional).
function _validateAttachment(attachment) {
  if (attachment == null || attachment === '') return null;
  if (typeof attachment !== 'string') return 'صيغة المرفق غير صالحة';
  const m = /^data:([^;,]+)(;base64)?,/i.exec(attachment);
  if (!m) return 'صيغة المرفق غير صالحة (يجب أن يكون data URL)';
  const mime = m[1].toLowerCase();
  if (!(mime.startsWith('image/') || mime === 'application/pdf')) return 'نوع المرفق غير مسموح (صورة أو PDF فقط)';
  const comma = attachment.indexOf(',');
  const payload = comma >= 0 ? attachment.slice(comma + 1) : '';
  const bytes = m[2] ? Math.floor(payload.length * 3 / 4) : payload.length;
  if (bytes > 5 * 1024 * 1024) return 'حجم المرفق أكبر من 5 ميجابايت';
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// v5.17.1 — routes/erp/ split (Phase 1 of 5). Each sub-router below
// owns one domain and lives in its own file under routes/erp/. Mount
// order doesn't matter (paths are disjoint), but we mount BEFORE the
// inline endpoints so future migrations of inline → sub-file just
// require moving the block out and adjusting nothing else.
//
// URL prefixes are unchanged — paths like /api/erp/customers still
// resolve to GET /customers inside customers.js.
// ═══════════════════════════════════════════════════════════════════
router.use(require('./erp/customers'));
router.use(require('./erp/suppliers'));
router.use(require('./erp/brands'));
router.use(require('./erp/dashboard'));
router.use(require('./erp/cost-centers'));
router.use(require('./erp/projects'));
router.use(require('./erp/audit-logs'));
router.use(require('./erp/branches-full'));
router.use(require('./erp/menu-options'));
router.use(require('./erp/vat'));

// v5.17.2 — Financial reports: each report in its own sub-file. Every
// endpoint behavior is identical to the inline version — these files
// were extracted verbatim from routes/erp.js without behavior changes.
//
// Tier A COA/Trial Balance overhaul — routes/erp/reports/trial-balance.js's
// GET /reports/trial-balance was UNMOUNTED here (not just left to lose the
// mount-order race). It was already unreachable in practice: erp-core.js
// registers the same path earlier in server.js and never calls next(), and
// no frontend/test consumer used this file's distinct contract (confirmed
// by repo-wide search — see docs/adr/0002-chart-of-accounts-trial-balance.md
// section 6). Its calculation logic (opening-journal handling, abnormalSign,
// granular balance checks) now lives in lib/reports/trialBalance.js, used by
// the one live endpoint in routes/erp-core.js. The file itself is kept
// on disk (see its own header comment) but no longer required anywhere.
router.use(require('./erp/reports/income'));
router.use(require('./erp/reports/balance-sheet'));
router.use(require('./erp/reports/cash-flow'));
router.use(require('./erp/reports/gl-ledger'));
router.use(require('./erp/reports/production'));
router.use(require('./erp/reports/pdf'));

// v5.17.1 — /dashboard moved to routes/erp/dashboard.js

// ─── Customers ───

// v5.17.1 — /customers, /suppliers, /brands moved to routes/erp/*.js
// (see router.use calls at top of this file). The blocks were
// removed verbatim — no behavior changes.

// ─── GL Accounts (Chart of Accounts) ───

router.get('/gl/accounts', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    // v5.10.38 — derive `balance` from posted gl_entries (single source of
    // truth) so the COA tree never shows a "zombie" balance that lacks an
    // actual journal. The stored gl_accounts.balance column is exposed as
    // storedBalance for diagnostics only. movementCount lets the UI hide
    // accounts that have never been touched.
    // v5.10.51 — order by display_order (NULL falls to the bottom),
    // code as tiebreaker. The frontend re-sorts using the same rule.
    const [rows] = await db.query(`
      SELECT a.*,
             (SELECT COUNT(*)
                FROM gl_entries e
                JOIN gl_journals j ON j.id = e.journal_id
               WHERE e.account_id = a.id AND j.status = 'posted') AS movement_count,
             (SELECT IFNULL(SUM(e.debit - e.credit), 0)
                FROM gl_entries e
                JOIN gl_journals j ON j.id = e.journal_id
               WHERE e.account_id = a.id AND j.status = 'posted') AS computed_balance
        FROM gl_accounts a
       WHERE COALESCE(a.company_id, 'CO-MAIN') = ?
       ORDER BY COALESCE(a.display_order, 99999), a.code`, [coaService.LEDGER_COMPANY_ID]);
    res.json(rows.map(a => ({
      id: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en,
      type: a.type, parentId: a.parent_id, level: a.level,
      isActive: a.is_active,
      isFolder: !!a.is_folder,
      displayOrder: a.display_order == null ? null : Number(a.display_order),
      balance: Number(a.computed_balance || 0),
      storedBalance: Number(a.balance || 0),
      movementCount: Number(a.movement_count || 0),
      // v5.10.78 — IFRS+SOCPA classification columns exposed to the UI
      // so the tree can show level badges (M/S/A/D) and the Balance
      // Sheet legend can show which Saudi-tax bucket each account hits.
      accountClass:  a.account_class || 'detail',
      reportSection: a.report_section || null,
      taxNature:     a.tax_nature || 'none',
      // 0028 — the columns that let the UI STATE what an account is instead of
      // inferring it. Without them the tree falls back to guessing roots from
      // the code set ['1'..'5'], which is simply wrong in production where the
      // roots are 100000..500000, and a contra account reads as abnormal
      // because its normal side had to be derived from `type`. The client
      // normalizer tolerates their absence; only sending them makes it exact.
      companyId:         coaService.LEDGER_COMPANY_ID,
      normalBalance:     a.normal_balance || null,
      isContra:          !!a.is_contra,
      contraOfAccountId: a.contra_of_account_id || null,
      isPostable:        a.is_postable == null ? null : !!a.is_postable,
      isControl:         !!a.is_control,
      cashFlowActivity:  a.cash_flow_activity || null,
      status:            a.status || (a.is_active ? 'active' : 'archived'),
      version:           a.version == null ? null : Number(a.version),
      isSystemRoot:      !!a.is_system_root,
      systemManaged:     !!a.system_managed,
      classCode:         a.class_code || null,
      sourceEntityType:  a.source_entity_type || null,
      sourceEntityId:    a.source_entity_id || null,
    })));
  } catch (e) {
    // v7.5 — was res.json([]): a DB fault rendered as "the chart of accounts
    // is empty", which the COA screen dutifully displayed.
    console.error('[erp/gl/accounts] list failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل دليل الحسابات' });
  }
});

// v5.10.40 — toggle is_folder on an account.
//
// Package D — was three HTTP 200 + {success:false} answers (missing account,
// root demotion, still-has-children) and a hardcoded root test on codes
// '1'..'5' that is FALSE in production, where the roots are 100000..500000 —
// so the "you cannot demote a root" guard protected nothing at all there.
// `is_system_root` (migration 0028) travels with the row instead of with a
// numbering scheme. The promotion direction is now guarded too: turning an
// account that already CARRIES journal entries into a folder hides real
// postings behind a header account.
router.post('/gl/accounts/:id/folder', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const { isFolder } = req.body || {};
    // An absent flag used to mean "demote": a bodyless POST silently turned a
    // folder into a leaf. It is now a 400, not a mutation.
    if (isFolder === undefined || isFolder === null) {
      return _coaFail(res, new coaService.CoaError('IS_FOLDER_REQUIRED', 'قيمة isFolder مطلوبة (true/false)'), 'folder');
    }
    const out = await coaService.setFolder(req.params.id, !!isFolder, _coaCtx(req));
    res.json({ success: true, id: out.id, isFolder: out.isFolder, version: out.version });
  } catch (e) {
    _coaFail(res, e, 'folder');
  }
});

// Additive-only bulk import. Existing accounts match by immutable id (or by
// an unambiguous code when id is absent), and may update bilingual names only.
// New rows require a real parent and are inserted topologically. Renumbering,
// reparenting, retyping, folder conversion and replacement/deletion are
// explicitly rejected and the whole file is atomic.
router.post('/gl/accounts/import', requireCapability('finance.accounts.manage'), async (req, res) => {
  const { rows } = req.body || {};
  const requestedMode = String((req.body && req.body.mode) || 'update').toLowerCase();
  try {
    const result = await coaImport.importAccounts(rows, _coaCtx(req), requestedMode);
    return res.json({ success: true, mode: 'update', ...result });
  } catch (e) {
    return _coaFail(res, e, 'import');
  }

  /* RETIRED AND UNREACHABLE: both paths above return. The historical block
   * below remains temporarily for blame/history, but its FK-disable, delete,
   * reparent and renumber statements cannot receive an HTTP request. */
  async function retiredUnsafeImporter() { // never called; scheduled for mechanical deletion
  // v5.10.55 — mode controls destructive semantics:
  //   'update'  (default): upsert only. Accounts in DB but not in the
  //                        file are left alone. Safe.
  //   'replace':           the file IS the chart of accounts. Anything
  //                        in DB but not matched in the file gets
  //                        deleted, EXCEPT (a) the 5 IFRS roots and
  //                        (b) any account with posted journal entries
  //                        (would orphan ledger data). Skipped rows
  //                        come back in skippedDeletes[] so the user
  //                        can reconcile manually.
  const mode = String((req.body && req.body.mode) || 'update').toLowerCase();
  const isReplace = mode === 'replace';
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, error: 'لا توجد صفوف للاستيراد' });
  }
  let inserted = 0, updated = 0, skipped = 0, codeChanges = 0, parentChanges = 0;
  let deleted = 0;
  const skippedDeletes = [];
  const errors = [];
  try {
    await db.withTransaction(async (conn) => {
      // v5.10.50 — three indices: id (safest), normalized name (the user's
      // preferred identity), code (fallback). Names are trimmed +
      // case-folded so "بنك الراجحي" matches "  بنك الراجحي  ".
      // v5.10.51 — also pull level + display_order so per-row diffs can
      // include them in the response (so the user CAN SEE what changed).
      const [existing] = await conn.query('SELECT id, code, name_ar, parent_id, level, display_order FROM gl_accounts');
      const byId   = {};
      const byCode = {};
      const byName = {};   // normalizedName -> [id, id, ...] (multiple = ambiguous)
      const normName = function(s){ return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); };
      existing.forEach(e => {
        byId[String(e.id)] = {
          id: e.id, code: String(e.code || ''),
          name_ar: String(e.name_ar || ''),
          parent_id: e.parent_id || null,
          level: Number(e.level || 1),
          display_order: e.display_order == null ? null : Number(e.display_order)
        };
        if (e.code) byCode[String(e.code)] = e.id;
        const nn = normName(e.name_ar);
        if (nn) {
          if (!byName[nn]) byName[nn] = [];
          byName[nn].push(e.id);
        }
      });
      function lookupByName(name) {
        const nn = normName(name);
        if (!nn) return null;
        const list = byName[nn] || [];
        if (list.length === 1) return list[0];
        return null;  // 0 = no match, 2+ = ambiguous (caller decides)
      }

      // v5.10.54 — primary resolver: match by (name + level) and break
      // remaining ties with parent. This is the top tier of the new
      // priority chain because the user said "the name is the identity,
      // level disambiguates, position picks the survivor."
      // Returns the matched id or null. parentId may be null.
      function resolveByNameLevel(name, lvl, parentId) {
        const nn = normName(name);
        if (!nn) return null;
        const list = byName[nn] || [];
        if (!list.length) return null;
        if (list.length === 1) return list[0];
        // Multiple by name → filter by level
        const lvlNum = Number(lvl) || 0;
        const sameLevel = list.filter(mid => Number(byId[mid].level || 1) === lvlNum);
        if (sameLevel.length === 1) return sameLevel[0];
        if (sameLevel.length === 0) {
          // Level didn't match any of the name candidates — fall through
          // to the plain-name caller logic (which returns null for
          // ambiguity). Don't silently pick a level-mismatched row.
          return null;
        }
        // Still ambiguous → break tie by parent
        const sameParent = sameLevel.filter(mid => String(byId[mid].parent_id || '') === String(parentId || ''));
        if (sameParent.length >= 1) return sameParent[0];
        return sameLevel[0]; // last resort
      }

      // Sort by level ASC so parents are upserted before children.
      const sorted = rows.slice().sort((a, b) => {
        return Number(a['المستوى'] || a.level || 1) - Number(b['المستوى'] || b.level || 1);
      });

      // v5.10.53 — TWO-PHASE COMMIT.
      //
      // Without this, mass code reassignment fails: row X wants code 112
      // but row Y currently holds code 112; we process X first, the
      // UNIQUE(code) constraint trips, X is rejected, then Y still holds
      // 112 forever. The user reported 102 such collisions in a single
      // import that should have just renumbered the chart.
      //
      // Fix:
      //   Pre-walk: figure out (a) which existing rows will get a NEW
      //             code, and (b) what target each row in the file maps
      //             to.  Build fileCodeToTargetId so children can resolve
      //             parents by their NEW code.
      //   Phase A:  Move every "code-changing" row to a unique temporary
      //             code (`__TMP_<id>`). After this, the codes the file
      //             intends to assign are free.
      //   Phase B:  The existing per-row UPDATE loop runs; collisions can
      //             only happen against rows that are NOT in the import,
      //             which is the genuine error case.
      // v5.10.53 — refuse if the file has the SAME code on two rows.
      // (Two rows trying to claim the same code is a file authoring
      // error, not something Phase A can recover from.)
      {
        const codeOccurrences = {};
        for (const r of sorted) {
          const c = String(r['الكود'] || r.code || '').trim();
          if (!c) continue;
          codeOccurrences[c] = (codeOccurrences[c] || 0) + 1;
        }
        const dups = Object.keys(codeOccurrences).filter(c => codeOccurrences[c] > 1);
        if (dups.length) {
          throw new Error('الملف يحوي أكوادًا مكرَّرة: ' + dups.slice(0, 5).join(', ') + (dups.length > 5 ? ' … و' + (dups.length - 5) + ' آخر' : ''));
        }
      }

      const fileCodeToTargetId = {};
      const idsChangingCode = new Set();
      // v5.10.54 — pre-walk uses the new priority: NAME+LEVEL first, then
      // id, then code. The name is the identity; the file is the truth.
      for (const r of sorted) {
        const idP = String(r['المعرف (لا تحذف)'] || r.id || '').trim();
        const codeP = String(r['الكود'] || r.code || '').trim();
        if (!codeP) continue;
        const nameP = String(r['الاسم العربي'] || r.nameAr || '').trim();
        const lvlP = Number(r['المستوى'] || r.level || 1);
        let tid = null;
        // 1. NAME + LEVEL (top priority)
        if (nameP) tid = resolveByNameLevel(nameP, lvlP, null);
        // 2. id (still useful when name not unique enough — same level
        //    not present, or two-level disambiguation failed)
        if (!tid && idP && byId[idP]) tid = idP;
        // 3. plain name (no level constraint) — only if exactly one match
        if (!tid && nameP) tid = lookupByName(nameP);
        // 4. code (legacy fallback)
        if (!tid && byCode[codeP]) tid = byCode[codeP];
        if (tid && byId[tid]) {
          fileCodeToTargetId[codeP] = tid;
          if (byId[tid].code !== codeP) idsChangingCode.add(tid);
        }
      }
      // v5.10.55 — REPLACE MODE: delete every existing account that the
      // file did NOT match to. Roots 1-5 are preserved. Accounts with
      // posted journal entries are skipped (their deletion would orphan
      // gl_entries — the user must merge entries manually). We delete
      // children before parents (depth DESC) to keep parent_id valid
      // throughout, even though we briefly disable FK checks.
      if (isReplace) {
        const matchedIds = new Set();
        for (const tid of Object.values(fileCodeToTargetId)) matchedIds.add(tid);
        const deletionCandidates = [];
        for (const eid of Object.keys(byId)) {
          if (matchedIds.has(eid)) continue;
          const acc = byId[eid];
          if (['1','2','3','4','5'].indexOf(String(acc.code)) >= 0) continue;
          deletionCandidates.push(acc);
        }
        // Filter out anything with journal entries.
        const safeToDelete = [];
        for (const acc of deletionCandidates) {
          const [hits] = await conn.query('SELECT id FROM gl_entries WHERE account_id = ? LIMIT 1', [acc.id]);
          if (hits.length) {
            skippedDeletes.push({ id: acc.id, code: acc.code, name: acc.name_ar, reason: 'has-journal-entries' });
          } else {
            safeToDelete.push(acc);
          }
        }
        // Sort by computed depth DESC so children get deleted before parents.
        // We don't have depth on the in-memory model, so derive via parent
        // chain length. Cheap because the chart is small.
        function depthOf(acc) {
          let d = 0, walker = acc, hops = 0;
          while (walker && walker.parent_id && hops < 50) {
            walker = byId[walker.parent_id];
            d++; hops++;
          }
          return d;
        }
        safeToDelete.sort((a, b) => depthOf(b) - depthOf(a));
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const acc of safeToDelete) {
          await conn.query('DELETE FROM gl_accounts WHERE id = ?', [acc.id]);
          deleted++;
          // Drop in-memory indices so later phases don't see this id
          if (acc.code) delete byCode[acc.code];
          delete byId[acc.id];
          const nn = normName(acc.name_ar);
          if (nn && byName[nn]) {
            byName[nn] = byName[nn].filter(x => x !== acc.id);
            if (!byName[nn].length) delete byName[nn];
          }
        }
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        console.log('[gl/accounts/import] replace-mode deleted ' + deleted + ' rows, skipped ' + skippedDeletes.length + ' (have entries)');
      }

      // Phase A: clear codes for everything that will change. We stash
      // the real code on byId[tid].original_code so the diff modal still
      // shows the meaningful "from" value (not __TMP_xxx).
      for (const tid of idsChangingCode) {
        const oldCode = byId[tid].code;
        const tempCode = '__TMP_' + tid;
        await conn.query('UPDATE gl_accounts SET code = ? WHERE id = ?', [tempCode, tid]);
        if (oldCode) delete byCode[oldCode];
        byCode[tempCode] = tid;
        byId[tid].original_code = oldCode;
        byId[tid].code = tempCode;
      }
      console.log('[gl/accounts/import] phase-A moved ' + idsChangingCode.size + ' codes to temp');

      let nameMatches = 0, codeMatches = 0, idMatches = 0;
      let parentByName = 0, parentByCode = 0, parentMissing = 0;
      // v5.10.51 — per-row diffs: every UPDATE that actually changes a
      // tracked field gets pushed here. Surfaces in the response so the
      // user sees exactly what was applied (closes the "changes don't
      // reflect" feedback gap).
      const appliedChanges = [];
      let orderChanges = 0, levelChanges = 0;
      // v5.10.55 — when the file's "الترتيب" cell is empty, derive a
      // displayOrder from the row's position within its parent group.
      // In replace mode this is always done; in update mode it only
      // applies when the user left the cell empty (so existing orders
      // aren't trampled). Counter is per resolved parent_id.
      const positionByParent = {};

      for (const r of sorted) {
        const id     = String(r['المعرف (لا تحذف)'] || r.id || '').trim();
        const code   = String(r['الكود'] || r.code || '').trim();
        if (!code) { skipped++; errors.push({ id, code: '', reason: 'empty-code' }); continue; }
        const nameAr = String(r['الاسم العربي'] || r.nameAr || '').trim();
        const nameEn = String(r['الاسم الإنج'] || r['الاسم الانجليزي'] || r.nameEn || '').trim();
        const type   = String(r['النوع'] || r.type || 'asset').trim();
        const parentName = String(r['اسم الأب'] || r.parentName || '').trim();
        const parentCode = String(r['كود الأب'] || r.parentCode || '').trim();
        const level  = Number(r['المستوى'] || r.level || 1);
        const kindRaw= String(r['النوع الهيكلي'] || r.kind || '').trim();
        const isFolder = (kindRaw === 'رئيسي' || kindRaw === 'folder' || level <= 2) ? 1 : 0;
        // v5.10.51 — read the "الترتيب" cell. Empty/0/non-number → null
        // (means: leave existing display_order alone OR fall back to bottom).
        // v5.10.55 — when null, auto-derive from file row position within
        // parent group (every row gets a deterministic order, the file
        // sequence is preserved). Update mode does this too because the
        // user said: "I want the same order as the file."
        // v5.10.50 — parent resolution: NAME first, code as fallback.
        // v5.10.53 — code lookup now consults fileCodeToTargetId first,
        // so a parent referenced by its NEW code (which is currently in
        // temp form thanks to Phase A) still resolves correctly.
        //
        // ORDER MATTERS — this block MUST stay above the display_order block
        // below. It used to sit after it, while the display_order fallback
        // read `parentId` to group rows by parent. `let` is not hoisted with a
        // value, so that read hit the temporal dead zone and threw
        // `ReferenceError: Cannot access 'parentId' before initialization` —
        // caught by the outer handler and returned as a bare HTTP 500. It fired
        // on exactly the case the comment below calls the EXPECTED one (an
        // empty «الترتيب» cell), so the import endpoint was broken for the
        // scenario it was written for.
        let parentId = null;
        function resolveParentByCode(pc){
          return fileCodeToTargetId[pc] || byCode[pc] || null;
        }
        if (parentName) {
          const pid = lookupByName(parentName);
          if (pid) { parentId = pid; parentByName++; }
          else if (parentCode && resolveParentByCode(parentCode)) {
            parentId = resolveParentByCode(parentCode); parentByCode++;
          }
          else { parentMissing++; errors.push({ id, code, reason: 'parent-not-found:' + parentName }); }
        } else if (parentCode) {
          const resolved = resolveParentByCode(parentCode);
          if (resolved) { parentId = resolved; parentByCode++; }
          else { parentMissing++; errors.push({ id, code, reason: 'parent-code-not-found:' + parentCode }); }
        }

        // v5.10.51 — read the "الترتيب" cell. Empty/0/non-number → null
        // (means: leave existing display_order alone OR fall back to bottom).
        // v5.10.55 — when null, auto-derive from file row position within
        // parent group (every row gets a deterministic order, the file
        // sequence is preserved). Update mode does this too because the
        // user said: "I want the same order as the file."
        const orderRaw = r['الترتيب'] != null ? r['الترتيب'] : (r.order != null ? r.order : r.displayOrder);
        let displayOrder = (orderRaw === '' || orderRaw == null || isNaN(Number(orderRaw))) ? null : Number(orderRaw);
        if (displayOrder == null) {
          const parentKey = String(parentId || '__ROOT__');
          positionByParent[parentKey] = (positionByParent[parentKey] || 0) + 1;
          displayOrder = positionByParent[parentKey];
        }

        // v5.10.54 — NEW priority: name+level → id → plain name → code.
        // The name is the identity, level disambiguates duplicates, the
        // file is the truth. id is still honoured (and renamed when
        // explicitly different from the resolved target's id), but it
        // is no longer the primary key for matching.
        let target = null, matchedBy = null;
        let idRenameFromId = null;
        // 1. name + level
        if (nameAr) {
          const t = resolveByNameLevel(nameAr, level, parentId);
          if (t) { target = byId[t]; matchedBy = 'name+level'; nameMatches++; }
        }
        // 2. id (when name+level didn't resolve)
        if (!target && id && byId[id]) { target = byId[id]; matchedBy = 'id'; idMatches++; }
        // 3. plain name (single match)
        if (!target && nameAr) {
          const t = lookupByName(nameAr);
          if (t) { target = byId[t]; matchedBy = 'name'; nameMatches++; }
        }
        // 4. code (legacy)
        if (!target && byCode[code]) { target = byId[byCode[code]]; matchedBy = 'code'; codeMatches++; }
        // If the file specified an id and it differs from what we
        // resolved, treat that as a rename intent (v5.10.52 behaviour).
        // The match itself is by name+level; the id rename is a follow-up.
        if (target && id && id !== target.id) {
          if (byId[id]) {
            // Another row already owns the new id — refuse.
            skipped++;
            errors.push({ id, code, reason: 'id-rename-collision-with:' + id });
            continue;
          }
          idRenameFromId = target.id;
        }

        if (target) {
          // Collision: would we steal a code another row owns?
          const claimant = byCode[code];
          if (claimant && claimant !== target.id) {
            skipped++;
            errors.push({ id: target.id, code, reason: 'code-collision-with:' + claimant });
            continue;
          }
          // v5.10.52 — handle id rename if requested (matchedBy='id-rename').
          // The FK on gl_entries.account_id has no ON UPDATE CASCADE, so we
          // briefly suspend FK checks for the rename. parent_id is a plain
          // VARCHAR (no FK), so we just UPDATE every child manually.
          let idChanged = false;
          if (idRenameFromId && id && id !== idRenameFromId) {
            // Refuse if the new id is already in use by another row
            if (byId[id]) {
              skipped++;
              errors.push({ id, code, reason: 'id-rename-collision-with:' + id });
              continue;
            }
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            await conn.query('UPDATE gl_accounts SET id = ? WHERE id = ?', [id, idRenameFromId]);
            await conn.query('UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?', [id, idRenameFromId]);
            await conn.query('UPDATE gl_entries SET account_id = ? WHERE account_id = ?', [id, idRenameFromId]);
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
            console.log('[gl/accounts/import] ID RENAME ' + idRenameFromId + ' → ' + id + ' (account: ' + nameAr + ')');
            // Refresh indices to reflect the new id
            byId[id] = byId[idRenameFromId];
            byId[id].id = id;
            delete byId[idRenameFromId];
            // byCode keeps the same code → still points at the old id var,
            // so re-point it to the new id.
            if (byCode[target.code]) byCode[target.code] = id;
            // byName entry holds the old id; replace it.
            const nnX = normName(target.name_ar);
            if (nnX && byName[nnX]) {
              byName[nnX] = byName[nnX].map(x => x === idRenameFromId ? id : x);
            }
            target = byId[id];
            idChanged = true;
          }
          const oldName = target.name_ar;
          // v5.10.53 — when Phase A moved this row to a temp code, use
          // original_code for the user-visible diff. Otherwise just use
          // the current code.
          const oldCode = target.original_code != null ? target.original_code : target.code;
          const oldLevel = Number(target.level || 1);
          const oldOrder = target.display_order;
          const codeChanged = String(oldCode) !== code;
          const nameChanged = normName(oldName) !== normName(nameAr);
          const parentChanged = String(target.parent_id || '') !== String(parentId || '');
          const levelChanged = oldLevel !== level;
          // v5.10.51 — only treat as a change when the file ACTUALLY
          // specified an order; null means "leave it alone".
          const orderChanged = (displayOrder != null) && (oldOrder !== displayOrder);
          // Effective new order: keep old when file didn't specify
          const effectiveOrder = (displayOrder == null) ? oldOrder : displayOrder;
          await conn.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=?, is_folder=?, display_order=? WHERE id=?',
            [code, nameAr, nameEn, type, parentId, level, isFolder, effectiveOrder, target.id]);
          if (codeChanged) {
            await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [code, target.id]);
            // v5.10.53 — sweep ALL temp/original byCode entries that
            // currently point at this target. id-rename can detach them
            // from a derivable key, so we sweep by value to be safe.
            if (oldCode) delete byCode[String(oldCode)];
            Object.keys(byCode).forEach(function(k){
              if (byCode[k] === target.id && (k.indexOf('__TMP_') === 0 || k === oldCode)) delete byCode[k];
            });
            byCode[code] = target.id;
            target.code = code;
            target.original_code = null;
            codeChanges++;
          }
          if (nameChanged) {
            const oldNN = normName(oldName);
            if (oldNN && byName[oldNN]) {
              byName[oldNN] = byName[oldNN].filter(x => x !== target.id);
              if (!byName[oldNN].length) delete byName[oldNN];
            }
            const newNN = normName(nameAr);
            if (newNN) {
              if (!byName[newNN]) byName[newNN] = [];
              if (byName[newNN].indexOf(target.id) < 0) byName[newNN].push(target.id);
            }
            target.name_ar = nameAr;
          }
          if (parentChanged) { target.parent_id = parentId; parentChanges++; }
          if (levelChanged) { target.level = level; levelChanges++; }
          if (orderChanged) { target.display_order = effectiveOrder; orderChanges++; }
          // v5.10.52 — diff includes id when renamed
          if (codeChanged || nameChanged || parentChanged || levelChanged || orderChanged || idChanged) {
            const diff = {};
            if (idChanged)     diff.id     = { from: idRenameFromId, to: target.id };
            if (codeChanged)   diff.code   = { from: oldCode, to: code };
            if (nameChanged)   diff.name   = { from: oldName, to: nameAr };
            if (levelChanged)  diff.level  = { from: oldLevel, to: level };
            if (orderChanged)  diff.order  = { from: oldOrder, to: effectiveOrder };
            if (parentChanged) diff.parent = { from: byId[String(target.parent_id_was || '')] && byId[String(target.parent_id_was)].code || null, to: parentId };
            appliedChanges.push({ id: target.id, code, name: nameAr, diff });
          }
          updated++;
        } else {
          const newId = id || ('GL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
          // v5.10.51 — insert with display_order if specified, else NULL
          // (will fall to the bottom of its parent group at query time).
          await conn.query(
            'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_folder, display_order) VALUES (?,?,?,?,?,?,?,?,?)',
            [newId, code, nameAr, nameEn, type, parentId, level, isFolder, displayOrder]);
          byCode[code] = newId;
          const nn = normName(nameAr);
          if (nn) {
            if (!byName[nn]) byName[nn] = [];
            byName[nn].push(newId);
          }
          byId[newId] = { id: newId, code: code, name_ar: nameAr, parent_id: parentId, level: level, display_order: displayOrder };
          inserted++;
        }
      }
      console.log('[gl/accounts/import] inserted=' + inserted + ' updated=' + updated + ' skipped=' + skipped +
        ' | match: id=' + idMatches + ' name=' + nameMatches + ' code=' + codeMatches +
        ' | parent: name=' + parentByName + ' code=' + parentByCode + ' missing=' + parentMissing +
        ' | changes: code=' + codeChanges + ' parent=' + parentChanges + ' level=' + levelChanges + ' order=' + orderChanges);
      req._coaImportStats = { idMatches, nameMatches, codeMatches, parentByName, parentByCode, parentMissing };
      req._coaAppliedChanges = appliedChanges;
      req._coaCounters = { codeChanges, parentChanges, levelChanges, orderChanges };
    });

    // v5.10.51 — post-commit verification: re-read each touched id and
    // confirm the new values made it into the DB. Mismatches surface in
    // the server log so silent-rollback bugs become visible.
    const applied = req._coaAppliedChanges || [];
    if (applied.length) {
      const ids = applied.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const [verify] = await db.query(
        'SELECT id, code, level, display_order FROM gl_accounts WHERE id IN (' + placeholders + ')',
        ids);
      const byVerifyId = {};
      verify.forEach(v => { byVerifyId[v.id] = v; });
      let mismatches = 0;
      applied.forEach(c => {
        const v = byVerifyId[c.id];
        if (!v) { mismatches++; console.error('[gl/accounts/import] VERIFY MISSING ' + c.id); return; }
        if (c.diff.code  && String(v.code)  !== String(c.diff.code.to))  { mismatches++; console.error('[gl/accounts/import] VERIFY CODE FAIL '  + c.id + ' want=' + c.diff.code.to  + ' got=' + v.code); }
        if (c.diff.level && Number(v.level) !== Number(c.diff.level.to)) { mismatches++; console.error('[gl/accounts/import] VERIFY LEVEL FAIL ' + c.id + ' want=' + c.diff.level.to + ' got=' + v.level); }
      });
      console.log('[gl/accounts/import] applied ' + applied.length + ' changes, verified ' + (applied.length - mismatches) + ' rows' + (mismatches ? ' (' + mismatches + ' mismatches)' : ''));
    }
    const counters = req._coaCounters || {};
    res.json({
      success: true, inserted, updated, skipped, errors,
      // v5.10.55 — replace-mode metrics
      mode,
      deleted,
      skippedDeletes,
      codeChanges:   counters.codeChanges   || 0,
      parentChanges: counters.parentChanges || 0,
      levelChanges:  counters.levelChanges  || 0,
      orderChanges:  counters.orderChanges  || 0,
      appliedChanges: applied,
      matchStats: req._coaImportStats || null
    });
  } catch (e) {
    console.error('[gl/accounts/import] FAILED:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
  }
});

// Central statement-section catalog for the account form.  The browser must
// not carry a private copy: a value accepted by the UI and rejected by the
// report engine (or vice versa) is how accounts become silently unmapped.
router.get('/gl/statement-sections', requireCapability('finance.gl.view'), async (req, res) => {
  res.json({
    success: true,
    sections: coaClassify.SECTION_CATALOG.map((section) => ({
      id: section.id,
      statement: section.statement,
      group: section.group,
      nameAr: section.nameAr,
      nameEn: section.nameEn,
      normalBalance: section.normalBalance,
      isContra: section.isContra,
      displayOrder: section.displayOrder,
      cashFlowBucket: section.cfBucket,
    })),
  });
});

// Retired: this legacy endpoint bypassed the governed CoA write gate and could
// reparent/delete across companies without cycle, depth, root, version or
// audit checks. Duplicate remediation now requires an explicit migration
// manifest reviewed as a data migration; a public HTTP dedupe writer is not a
// safe accounting primitive.
router.post('/gl/accounts/dedupe', requireCapability('finance.accounts.manage'), async (req, res) => {
  return _coaFail(res, new coaService.CoaError(
    'COA_DEDUPE_RETIRED',
    'تم إيقاف الدمج المباشر للحسابات؛ استخدم manifest ترحيل محاسبي معتمد',
  ), 'dedupe');
});

// v5.10.45 — move an account under a new parent and (optionally) renumber
// its code based on the new parent's existing children. When renumbering,
// every descendant's code is rewritten with the new prefix in the same
// transaction, and gl_entries.account_code (denormalized) is kept in sync.
//
// Package D — the body of this route moved VERBATIM in behaviour (same
// renumbering arithmetic, same code-prefix descendant selection, same
// response fields) into lib/coa/service.js#moveAccountTx, and gained the
// guards it never had: type compatibility with the class root, the depth cap
// measured against the moving SUBTREE's height, a target that can actually
// hold children, an optimistic-concurrency check, and an audit row. Its root
// protection was `code in ('1'..'5')` — dev's numbering, not production's —
// and is now `is_system_root`.
//
// It also stops answering 400 for everything: a missing account is a 404, a
// concurrent edit is a 409, a rule violation is a 422, and an unexpected
// fault is a 500 instead of being dressed up as a client mistake.
router.post('/gl/accounts/:id/move', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const { parentId, autoRenumber, expectedVersion } = req.body || {};
    const result = await coaService.moveAccount(
      req.params.id, { parentId: parentId || null, autoRenumber: !!autoRenumber, expectedVersion },
      _coaCtx(req)
    );
    console.log('[gl/move] ' + result.oldCode + ' -> ' + result.newCode +
      ' under ' + (result.newParentId || 'root') +
      ' (renumbered ' + result.renumbered.length + ', levels ' + result.levelsUpdated + ')');
    res.json({ success: true, ...result });
  } catch (e) {
    _coaFail(res, e, 'move');
  }
});

// Package D — "what would this move do?", answered BEFORE anything is written.
//
// A move renumbers a whole subtree and rewrites gl_entries.account_code with
// it; there is no undo. This runs the identical guard set and the identical
// renumbering arithmetic as /move, issues SELECTs only, and returns every rule
// violation at once in `blockers` instead of surfacing one per failed attempt.
router.post('/gl/accounts/:id/move/preview', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const { parentId, autoRenumber } = req.body || {};
    const preview = await coaService.previewMove(
      req.params.id, parentId || null, { autoRenumber: !!autoRenumber }
    );
    res.json({ success: true, preview });
  } catch (e) {
    _coaFail(res, e, 'move/preview');
  }
});

// Upsert one account.
//
// Package D — this handler had four defects that a green test suite could not
// see, because nothing here ever returned a status code:
//
//   1. It destructured `level` from the body and then IGNORED it. Silently.
//      To every client that sent one, that read exactly like acceptance —
//      and `level` is DERIVED (lib/coa/tree.js#recomputeLevels is its only
//      writer). A field that does nothing must be REFUSED, not swallowed:
//      it is now a 400 with code LEVEL_NOT_ACCEPTED.
//   2. It wrote `parent_id` with NO existence check, NO cycle check and NO
//      type check. Only /move checked cycles — so the one endpoint that
//      cannot create a cycle was guarded and this one, which can (on its
//      UPDATE branch), was not. One POST could orphan an account under a
//      parent id that does not exist, or hang a revenue account off Assets.
//   3. Its catch-all answered **HTTP 200 with {success:false}**.
//   4. No version check and no audit row — two people editing the same
//      account last-write-wins in silence, and the ledger's own skeleton
//      changed with nothing written to audit_logs.
//
// Response fields are unchanged (`success`, `id`); `version` is additive.
router.post('/gl/accounts', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const out = await coaService.upsertAccount(req.body || {}, _coaCtx(req));
    res.json({ success: true, id: out.id, version: out.version, created: out.created });
  } catch (e) {
    _coaFail(res, e, 'accounts');
  }
});

// Delete GL account.
//
// Package D — all three exits (has children / has entries / unexpected) were
// HTTP 200 + {success:false}. They are now 422 / 422 / 500, each with a code,
// and the delete runs inside a transaction that also refuses a system root
// and writes its audit row BEFORE the row disappears (logAuditTx does not
// swallow failures, so an unrecordable delete rolls back instead of
// happening unrecorded).
router.delete('/gl/accounts/:id', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    await coaService.deleteAccount(req.params.id, _coaCtx(req));
    res.json({ success: true });
  } catch (e) {
    _coaFail(res, e, 'delete');
  }
});

// Package D — close an account WITHOUT destroying its history. This is the
// correct answer for an account that has postings: DELETE refuses it (422
// HAS_ENTRIES) because removing it would strand journal lines, but leaving it
// selectable in every picker forever is not an answer either. Archiving sets
// status='archived' + is_active=0 + is_postable=0, so historical reports still
// balance and nothing new can be posted to it.
router.post('/gl/accounts/:id/archive', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const out = await coaService.archiveAccount(req.params.id, _coaCtx(req));
    res.json({ success: true, id: out.id, status: out.status, version: out.version });
  } catch (e) {
    _coaFail(res, e, 'archive');
  }
});

// v5.11.1 — expose the official template as a static resource so the
// frontend can fetch it once and feed it through the safe additive/update
// import flow.  The canonical policy currently contains 224 bilingual rows
// below five presentation-class roots.  IFRS/SOCPA govern recognition and
// presentation; the six-digit numbering is this product's governance policy,
// not a claim that Saudi regulation prescribes a universal account code set.
router.get('/gl/coa-template', requireCapability('finance.accounts.manage'), async (req, res) => {
  res.json({ success: true, accounts: COA_TEMPLATE });
});

// v5.11.9 — Hard wipe + reseed CoA + purge transactional history.
// User asked for a clean accounting foundation: previous journals + sales
// must go, then CoA is rebuilt fresh from the template. Master data
// (customers, suppliers, items, brands, branches, periods) is preserved.
// Differs from /gl/accounts/import?mode=replace which preserves accounts
// with posted journal entries — that guard is exactly why the user's
// bank stayed under inventory.
// v7.5 SECURITY — every seed/repair endpoint below rewrites the chart of
// accounts (and some create journals). They were reachable with ANY
// authenticated token. Same capability as the other COA mutations above.
router.post('/gl/coa/wipe-and-seed',
  guardBreakGlass('محو دليل الحسابات وإعادة بذره'),
  requireCapability('finance.accounts.manage'), async (req, res) => {
  const phrase = (req.body && req.body.confirmPhrase) || '';
  if (phrase !== 'WIPE-COA-CONFIRMED') {
    return res.status(400).json({ success: false, error: 'تأكيد ناقص أو خاطئ' });
  }
  try {
    const counts = {};
    let inserted = 0;
    await db.withTransaction(async (conn) => {
      // Tally what we're about to wipe (so the response is honest).
      const tally = async (tbl) => {
        try {
          const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM ' + tbl);
          counts[tbl] = r.n;
        } catch (e) { counts[tbl] = 0; }
      };
      await tally('gl_entries');
      await tally('gl_journals');
      await tally('sales_items');
      await tally('sales');
      await tally('purchases');
      await tally('expenses');
      await tally('inventory_movements');
      await tally('payments');
      await tally('vat_reports');
      await tally('gl_accounts');

      // Order matters for cascading FKs. Children before parents:
      //   gl_entries     → CASCADEd by gl_journals delete (FK), but explicit
      //                    delete is cleaner and lets us count.
      //   sales_items    → CASCADEd by sales delete (FK).
      //   gl_accounts    → ON DELETE SET NULL on gl_entries.account_id,
      //                    but gl_entries is already gone by then.
      const safeDelete = async (tbl) => {
        try { await conn.query('DELETE FROM ' + tbl); } catch (e) { /* table may not exist */ }
      };
      await safeDelete('gl_entries');
      await safeDelete('gl_journals');
      await safeDelete('sales_items');
      await safeDelete('sales');
      await safeDelete('purchases');
      await safeDelete('expenses');
      await safeDelete('inventory_movements');
      await safeDelete('payments');
      await safeDelete('vat_reports');
      await safeDelete('gl_accounts');

      // Reseed CoA from the official template. DFS-ordered so parents
      // are inserted before children — no FK on parent_id, but the
      // ordering keeps the data clean for any downstream consumer.
      // v5.11.18 — also persist is_folder from the template's `kind`
      // field so reports can hide folders right after the reseed without
      // waiting for the next server restart's is_folder migration.
      // v5.10.78 — write account_class + report_section + tax_nature
      // derived from level + code, so the Balance Sheet generator has a
      // first-class column to query instead of fragile prefix-matching.
      function _deriveAccountClass(level, kind) {
        if (level <= 1) return 'main';
        if (level === 2) return 'sub';
        if (level === 3) return 'analytical';
        return 'detail';  // L4 + L5
      }
      function _deriveReportSection(code, type) {
        const c = String(code || '');
        // v5.10.84 — Saudi / International standard CoA: 6-digit GGMMPP.
        //   GG = group (10/20/30/40/50)
        //   MM = main account
        //   PP = sub-account
        // Reports are derived from the FIRST TWO DIGITS only:
        //   10 → BS Assets, 20 → BS Liabilities, 30 → BS Equity,
        //   40 → IS Revenue, 50 → IS Expense (incl. COGS).
        // The MM digit (positions 3-4) maps to the report_section bucket.
        if (/^\d{6}$/.test(c)) {
          // Leaf-level exceptions where one control group contains multiple
          // statement/tax concepts. These must outrank the broad MM mapping.
          if (c === '100250') return 'allowance_doubtful';
          if (c === '100451') return 'input_vat';
          if (c === '100700' || c === '100701') return 'rou';
          if (c === '100702') return 'acc_dep';
          if (c === '200301') return 'output_vat';
          if (c === '200302') return 'net_vat';
          if (c === '200303') return 'gosi';
          if (c === '200304') return 'withholding';
          if (c === '200305') return 'zakat';
          if (c === '200401' || c === '200431') return 'short_term_debt';
          if (c === '200402') return 'long_term_debt';
          if (c === '200430' || c === '200432') return 'lease_obligation';
          const gg = c.substr(0, 2);
          const mm = c.substr(2, 2);
          if (gg === '10') {
            if (mm === '00') return null;            // root header
            if (mm === '01') return 'cash';
            if (mm === '02') return 'receivables';
            if (mm === '03') return 'inventory';
            if (mm === '04') return 'prepaid';
            if (mm === '05') return 'ppe';
            if (mm === '06') return 'acc_dep';
            return 'other_current_asset';
          }
          if (gg === '20') {
            if (mm === '00') return null;
            if (mm === '01') return 'payables';
            if (mm === '02') return 'accrued';
            if (mm === '03') return 'vat_output';
            if (mm === '04') return 'long_term_debt';
            if (mm === '05') return 'eosb';                // v5.10.85 — EOSB IAS 19
            if (mm === '06') return 'customer_deposits';   // v5.10.85 — دفعات مقدمة من العملاء
            return 'other_current_liability';
          }
          if (gg === '30') {
            if (mm === '00') return null;
            if (mm === '01') return 'capital';
            if (mm === '02') return 'retained';
            if (mm === '03') return 'retained';      // period P&L lives under retained per IAS 1
            if (mm === '04') return 'reserves';      // v5.10.85 — الاحتياطيات
            if (mm === '05') return 'drawings';      // v5.10.85 — المسحوبات (contra)
            return 'capital';
          }
          if (gg === '40') return 'revenue';
          if (gg === '50') {
            // First three MM under expenses are COGS by brand
            if (['01', '02', '03'].includes(mm)) return 'cogs';
            return 'opex';
          }
          return null;
        }
        // ── Legacy fallback (pre-v5.10.84 installs with old codes) ──
        // Kept for backward compatibility so partial-migration systems
        // still classify correctly. New installs never hit this branch.
        if (c.startsWith('1161') || c.startsWith('1162') || c.startsWith('116')) return 'vat_input';
        if (c.startsWith('1111') || c.startsWith('1112') || c.startsWith('111')) return 'cash';
        if (c.startsWith('1124'))                 return 'allowance_doubtful';
        if (c.startsWith('112'))                  return 'receivables';
        if (c.startsWith('113'))                  return 'inventory';
        if (c.startsWith('114'))                  return 'prepaid';
        if (c.startsWith('115'))                  return 'receivables';
        if (c.startsWith('122'))                  return 'acc_dep';
        if (c.startsWith('124'))                  return 'rou';
        if (c.startsWith('121'))                  return 'ppe';
        if (c.startsWith('123'))                  return 'intangibles';
        if (c.startsWith('125') || c.startsWith('126')) return 'intangibles';
        if (c.startsWith('211'))                  return 'payables';
        if (c.startsWith('212'))                  return 'accrued';
        if (c === '2132' || c.startsWith('2132')) return 'net_vat';
        if (c.startsWith('2131') || c === '213')  return 'vat_output';
        if (c.startsWith('214'))                  return 'customer_deposits';
        if (c.startsWith('215'))                  return 'other_current_liability';
        if (c.startsWith('216'))                  return 'gosi';
        if (c.startsWith('217'))                  return 'withholding';
        if (c.startsWith('218') || c.startsWith('219')) return 'short_term_debt';
        if (c === '223' || c.startsWith('223'))   return 'eosb';
        if (c.startsWith('22'))                   return 'long_term_debt';
        if (c.startsWith('31'))                   return 'capital';
        if (c.startsWith('32'))                   return 'retained';
        if (c.startsWith('33'))                   return 'drawings';
        if (c === '343' || c.startsWith('343'))   return 'reserves';
        if (c.startsWith('34'))                   return 'reserves';
        if (c === '6244')                         return 'zakat_paid';
        if (c.startsWith('624'))                  return 'gov_fees';
        if (type === 'revenue')                   return 'revenue';
        if (c.startsWith('5'))                    return 'cogs';
        if (type === 'expense')                   return 'opex';
        return null;
      }
      function _deriveTaxNature(code) {
        const c = String(code || '');
        // v5.10.84 — Saudi/International standard: VAT lives under 2003xx
        // but the control group also carries GOSI, withholding and Zakat;
        // classify the leaf, never the whole group as output VAT.
        if (c === '100451') return 'vat_input';
        if (c === '200301') return 'vat_output';
        if (c === '200302') return 'vat_output';
        if (c === '200303') return 'gosi';
        if (c === '200304') return 'withholding';
        if (c === '200305') return 'zakat';
        if (c === '200500' || c === '200501') return 'eosb';
        // ── Legacy fallback (pre-v5.10.84) ──
        if (c.startsWith('116'))                return 'vat_input';
        if (c.startsWith('2131') || c === '213') return 'vat_output';
        if (c.startsWith('216'))                return 'gosi';
        if (c.startsWith('217'))                return 'withholding';
        if (c === '223' || c.startsWith('223')) return 'eosb';
        if (c === '343' || c === '6244')        return 'zakat';
        return 'none';
      }

      for (const a of COA_TEMPLATE) {
        const isFolder       = a.kind === 'folder' ? 1 : 0;
        const accountClass   = _deriveAccountClass(a.level, a.kind);
        const reportSection  = _deriveReportSection(a.code, a.type);
        const taxNature      = _deriveTaxNature(a.code);
        await conn.query(
          'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, balance, account_class, report_section, tax_nature) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)',
          [a.code, a.code, a.nameAr, a.nameEn || null, a.type, a.parentCode || null, a.level, isFolder, accountClass, reportSection, taxNature]
        );
        inserted++;
      }
    });
    console.log('[wipe-and-seed]', JSON.stringify({ deleted: counts, seeded: inserted }));
    res.json({ success: true, deleted: counts, seeded: inserted });
  } catch (e) {
    console.error('[wipe-and-seed]', e);
    res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
});

// Seed cafe GL accounts (دليل حسابات المقهى)
router.post('/gl/seed', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const [existing] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    if (existing[0].cnt > 0) return res.json({ success: true, msg: 'already seeded' });

    // The historical inline cafe chart below is retained only as migration
    // evidence. New databases must be born from the governed bilingual
    // six-digit template, whose inventory section contains exactly one
    // posting leaf (1200) under 100300.
    let seeded = 0;
    for (const a of COA_TEMPLATE) {
      await db.query(
        `INSERT INTO gl_accounts
           (id, code, name_ar, name_en, type, parent_id, level, is_active,
            is_folder, is_postable, balance, report_section, cash_flow_activity,
            normal_balance, is_contra, system_managed)
         VALUES (?,?,?,?,?,?,?,1,?,?,0,?,?,?,?,1)`,
        [a.code, a.code, a.nameAr, a.nameEn || null, a.type,
         a.parentCode || null, a.level, a.kind === 'folder' ? 1 : 0,
         a.kind === 'folder' ? 0 : 1, a.reportSection || null,
         a.cashFlowActivity || null,
         (a.type === 'asset' || a.type === 'expense') ? 'debit' : 'credit',
         a.isContra ? 1 : 0]
      );
      seeded++;
    }
    return res.json({ success: true, count: seeded, source: 'governed-coa-template' });

    /* istanbul ignore next -- unreachable pre-governance seed retained for forensic history */
    const accounts = [
      // ═══ 1 الأصول ═══
      {code:'1',name:'الأصول',type:'asset',parent:null,level:1},
      {code:'11',name:'الأصول المتداولة',type:'asset',parent:'1',level:2},
      {code:'111',name:'النقدية والبنوك',type:'asset',parent:'11',level:3},
      {code:'11101',name:'عهدة الكاشير / صناديق نقاط البيع (POS)',type:'asset',parent:'111',level:4},
      {code:'11102',name:'الحسابات البنكية الجارية',type:'asset',parent:'111',level:4},
      // ── CURRENT-ASSET FAMILIES — aligned to lib/glPosting.js:44-45 ──
      //
      // This block used to be the REVERSE of the posting engine, and that was
      // the source of the owner's «اثنان من المخزون»: the seed put Inventory at
      // 112 and Receivables at 113, while lib/glPosting.js — the module that
      // actually WRITES every journal — parents the warehouses (1200/1210/
      // 1220/1230) under 113 and AR (1150) under 112. Any chart touched by
      // both ended up with an inventory group in each.
      //
      // The canonical map, from lib/glPosting.js:44-45:
      //   111 Cash & Bank · 112 AR · 113 Inventory · 114 Prepayments ·
      //   115 Custody · 116 Input VAT
      //
      // Safe to change: /gl/seed is a hard no-op once ANY account exists (the
      // COUNT guard above), so this can never rewrite a live chart — it only
      // decides what a FRESH install is born with.
      {code:'112',name:'ذمم العملاء',type:'asset',parent:'11',level:3},
      {code:'11201',name:'ذمم تطبيقات التوصيل (جاهز، هنقرستيشن..)',type:'asset',parent:'112',level:4},
      // Contra-asset under AR. Recognised by the name keyword «مخصص» plus the
      // contra-classification logic in the Balance Sheet build below.
      {code:'1121',name:'مخصص الديون المشكوك في تحصيلها',type:'asset',parent:'112',level:4},
      {code:'113',name:'المخزون',type:'asset',parent:'11',level:3},
      {code:'11301',name:'مخزون المواد الخام (البن، الحليب، المنكهات)',type:'asset',parent:'113',level:4},
      {code:'11302',name:'مخزون المنتجات الجاهزة (المخبوزات، الحلويات)',type:'asset',parent:'113',level:4},
      {code:'11303',name:'مخزون مواد التغليف والتعبئة (الأكواب، الأكياس)',type:'asset',parent:'113',level:4},
      {code:'11304',name:'مخزون المنتجات تحت التشغيل (WIP)',type:'asset',parent:'113',level:4},
      {code:'11305',name:'مخزون المنتجات التامة (Finished Goods)',type:'asset',parent:'113',level:4},
      {code:'114',name:'المصروفات المدفوعة مقدمًا',type:'asset',parent:'11',level:3},
      {code:'11401',name:'إيجارات مدفوعة مقدماً',type:'asset',parent:'114',level:4},
      // 115 = Custody. routes/custody.js creates employee custody accounts as
      // 115x under this group — seeding it means the first custody entry finds
      // a real home instead of minting one wherever it lands.
      {code:'115',name:'العهد والسلف',type:'asset',parent:'11',level:3},
      {code:'11501',name:'سلف ومقدمات الموظفين',type:'asset',parent:'115',level:4},
      {code:'116',name:'ضريبة المدخلات',type:'asset',parent:'11',level:3},
      {code:'12',name:'الأصول الثابتة',type:'asset',parent:'1',level:2},
      {code:'121',name:'معدات وآلات الكافيه',type:'asset',parent:'12',level:3},
      {code:'122',name:'أجهزة نقاط البيع والأنظمة',type:'asset',parent:'12',level:3},
      {code:'123',name:'الأثاث والديكورات',type:'asset',parent:'12',level:3},
      {code:'124',name:'مجمع إهلاك الأصول الثابتة',type:'asset',parent:'12',level:3},
      // ═══ 2 الالتزامات ═══
      {code:'2',name:'الالتزامات',type:'liability',parent:null,level:1},
      {code:'21',name:'الالتزامات المتداولة',type:'liability',parent:'2',level:2},
      {code:'211',name:'الموردون والدائنون',type:'liability',parent:'21',level:3},
      {code:'21101',name:'موردو المواد الغذائية والبن',type:'liability',parent:'211',level:4},
      {code:'21102',name:'موردو التغليف والمعدات',type:'liability',parent:'211',level:4},
      {code:'212',name:'المصروفات المستحقة',type:'liability',parent:'21',level:3},
      {code:'21201',name:'رواتب وأجور مستحقة',type:'liability',parent:'212',level:4},
      {code:'21202',name:'إيجارات عقود مستحقة الدفع',type:'liability',parent:'212',level:4},
      {code:'21203',name:'فواتير منافع مستحقة',type:'liability',parent:'212',level:4},
      {code:'213',name:'الضرائب',type:'liability',parent:'21',level:3},
      {code:'21301',name:'ضريبة القيمة المضافة المستحقة (VAT)',type:'liability',parent:'213',level:4},
      // 215 — the parent lib/glPosting.js CORE_ACCOUNTS declares for
      // ROYALTY_PAYABLE (2310) and PLATFORM_PAYABLE (2320). It was absent from
      // this seed, so `ensureCoreAccounts` — which walks UP looking for the
      // declared parent and gives up when none of the prefixes exist — created
      // both as parentless ROOTS. ADR 0002 recorded exactly this drift on the
      // live chart. Every aggregator commission the register posts credits
      // 2320, so this is not a hypothetical branch.
      {code:'215',name:'مستحقات الامتياز والمنصات',type:'liability',parent:'21',level:3},
      // ═══ 3 حقوق الملكية ═══
      {code:'3',name:'حقوق الملكية',type:'equity',parent:null,level:1},
      {code:'31',name:'رأس المال',type:'equity',parent:'3',level:2},
      {code:'311',name:'رأس مال الشركاء أو المالك',type:'equity',parent:'31',level:3},
      {code:'32',name:'الأرباح المبقاة',type:'equity',parent:'3',level:2},
      {code:'321',name:'الأرباح أو الخسائر المرحلة',type:'equity',parent:'32',level:3},
      {code:'33',name:'المسحوبات',type:'equity',parent:'3',level:2},
      {code:'331',name:'جاري المالك (المسحوبات الشخصية)',type:'equity',parent:'33',level:3},
      // ═══ 4 الإيرادات ═══
      {code:'4',name:'الإيرادات',type:'revenue',parent:null,level:1},
      {code:'41',name:'الإيرادات التشغيلية',type:'revenue',parent:'4',level:2},
      {code:'411',name:'مبيعات نقاط البيع (POS)',type:'revenue',parent:'41',level:3},
      {code:'41101',name:'مبيعات المشروبات الساخنة والباردة',type:'revenue',parent:'411',level:4},
      {code:'41102',name:'مبيعات المأكولات والحلويات',type:'revenue',parent:'411',level:4},
      {code:'41103',name:'مبيعات منتجات التجزئة',type:'revenue',parent:'411',level:4},
      {code:'412',name:'مبيعات تطبيقات التوصيل',type:'revenue',parent:'41',level:3},
      {code:'41201',name:'مبيعات تطبيقات التوصيل',type:'revenue',parent:'412',level:4},
      {code:'42',name:'الإيرادات الأخرى',type:'revenue',parent:'4',level:2},
      {code:'421',name:'إيرادات خدمات الحفلات الخارجية (Catering)',type:'revenue',parent:'42',level:3},
      {code:'422',name:'إيرادات متنوعة',type:'revenue',parent:'42',level:3},
      // ═══ 5 المصروفات (تشمل COGS + التشغيلية + العمومية) ═══
      {code:'5',name:'المصروفات',type:'expense',parent:null,level:1},
      {code:'51',name:'تكلفة المبيعات (COGS)',type:'expense',parent:'5',level:2},
      {code:'511',name:'تكلفة المواد المستهلكة',type:'expense',parent:'51',level:3},
      {code:'5111',name:'تكلفة البن والمشروبات',type:'expense',parent:'511',level:4},
      {code:'5112',name:'تكلفة المأكولات والحلويات المباعة',type:'expense',parent:'511',level:4},
      {code:'5113',name:'تكلفة مواد التعبئة والتغليف',type:'expense',parent:'511',level:4},
      {code:'512',name:'الهالك والتوالف',type:'expense',parent:'51',level:3},
      {code:'5121',name:'هالك المواد الغذائية والبن',type:'expense',parent:'512',level:4},
      // ── 521/522/523 belong to the POSTING engine, not to opex ──
      //
      // The seed used to name 521 «الرواتب والأجور», 522 «الإيجارات والمنافع»
      // and 523 «التشغيل والصيانة». But lib/glPosting.js CORE_ACCOUNTS parents
      // its waste accounts under 521 (WASTE_EXPENSE 5200, WASTE_RAW 5121,
      // WASTE_FINISHED 5122, WASTE_EXPIRED 5123, WASTE_SPILL 5124,
      // WASTE_RETURNS 5125), stock/production variance under 522
      // (STOCK_VARIANCE 5300, PRODUCTION_VARIANCE 5420) and purchase price
      // variance under 523 (PPV 5350). Those parents are created automatically
      // on the first posted journal — so on a chart seeded the old way, every
      // waste entry in the business landed under «الرواتب والأجور».
      //
      // The families the posting engine owns keep their numbers; payroll, rent
      // and maintenance move to 526/527/528, which nothing else claims.
      {code:'52',name:'المصروفات التشغيلية',type:'expense',parent:'5',level:2},
      {code:'521',name:'الهدر والتوالف',type:'expense',parent:'52',level:3},
      {code:'522',name:'فروقات الجرد والإنتاج',type:'expense',parent:'52',level:3},
      {code:'523',name:'فروق أسعار المشتريات',type:'expense',parent:'52',level:3},
      {code:'526',name:'الرواتب والأجور',type:'expense',parent:'52',level:3},
      {code:'5261',name:'رواتب الإدارة والمحاسبة',type:'expense',parent:'526',level:4},
      {code:'5262',name:'رواتب الكاشيرز والباريستا',type:'expense',parent:'526',level:4},
      {code:'5263',name:'رواتب الإنتاج (الباستري)',type:'expense',parent:'526',level:4},
      {code:'5264',name:'مكافآت وحوافز',type:'expense',parent:'526',level:4},
      {code:'5265',name:'تأمينات اجتماعية (GOSI)',type:'expense',parent:'526',level:4},
      {code:'527',name:'الإيجارات والمنافع',type:'expense',parent:'52',level:3},
      {code:'5271',name:'إيجارات الفروع',type:'expense',parent:'527',level:4},
      {code:'5272',name:'الكهرباء والماء',type:'expense',parent:'527',level:4},
      {code:'5273',name:'اشتراكات الإنترنت والاتصالات',type:'expense',parent:'527',level:4},
      {code:'528',name:'التشغيل والصيانة',type:'expense',parent:'52',level:3},
      {code:'5281',name:'صيانة مكائن القهوة والمعدات',type:'expense',parent:'528',level:4},
      {code:'5282',name:'أدوات النظافة والتعقيم',type:'expense',parent:'528',level:4},
      {code:'524',name:'التسويق والعمولات',type:'expense',parent:'52',level:3},
      {code:'5241',name:'عمولات تطبيقات التوصيل',type:'expense',parent:'524',level:4},
      {code:'5242',name:'الحملات الإعلانية والتسويق',type:'expense',parent:'524',level:4},
      // v5.10.61 — مصاريف الإهلاك (the missing counterpart to 124 مجمع الإهلاك).
      // Without these, the monthly depreciation JE has nowhere to debit.
      {code:'525',name:'مصاريف الإهلاك',type:'expense',parent:'52',level:3},
      {code:'5251',name:'إهلاك معدات وآلات الكافيه',type:'expense',parent:'525',level:4},
      {code:'5252',name:'إهلاك أجهزة نقاط البيع',type:'expense',parent:'525',level:4},
      {code:'5253',name:'إهلاك الأثاث والديكورات',type:'expense',parent:'525',level:4},
      {code:'53',name:'المصروفات العمومية والإدارية',type:'expense',parent:'5',level:2},
      {code:'531',name:'رسوم اشتراكات الأنظمة والبرامج',type:'expense',parent:'53',level:3},
      {code:'532',name:'الرسوم الحكومية والتراخيص',type:'expense',parent:'53',level:3},
      {code:'533',name:'العمولات البنكية ورسوم شبكات الدفع',type:'expense',parent:'53',level:3},
      {code:'534',name:'مصروفات الضيافة والنثريات',type:'expense',parent:'53',level:3},
      // ═══ 6 مصروفات أخرى — the family CORE_ACCOUNTS points at ═══
      //
      // lib/glPosting.js declares parent '6' for OVERHEAD_APPLIED (5410) and
      // PLATFORM_COMMISSION (5500), and parent '651' for FRANCHISE_FEE (6100).
      // Neither existed in this seed, and `ensureCoreAccounts` walks UP the
      // parent code looking for an ancestor — when none of '6' / (nothing) is
      // found it gives up and inserts the account as a PARENTLESS ROOT.
      //
      // ADR 0002 recorded exactly this on the live chart: 5410, 5500 and 6100
      // sitting as stray roots beside «الأصول» and «الإيرادات». 5500 is not
      // theoretical — the register credits it on every aggregator order.
      {code:'6',name:'مصروفات أخرى',type:'expense',parent:null,level:1},
      {code:'65',name:'الامتياز والتحميلات',type:'expense',parent:'6',level:2},
      {code:'651',name:'رسوم الامتياز',type:'expense',parent:'65',level:3},
    ];

    // Build a code→id map so parent references work
    const codeToId = {};
    for (const a of accounts) {
      const id = 'GL-' + a.code;
      codeToId[a.code] = id;
    }
    for (const a of accounts) {
      const id = codeToId[a.code];
      const parentId = a.parent ? (codeToId[a.parent] || null) : null;
      await db.query(
        'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [id, a.code, a.name, a.type, parentId, a.level]
      );
    }
    res.json({ success: true, count: accounts.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── v5.10.5 — COA inventory classification repair ─────────────────────
// Walks the chart and fixes any account whose name screams "inventory" but
// whose parent_id chain is anchored at code 12 (الأصول الثابتة) instead of
// 112 (المخزون). Idempotent. Also exported as a helper so server.js can
// run it once at boot for self-healing on existing deployments.
// THE CAUSE OF «لماذا هناك اثنان من المخزون في الشجرة».
//
// This helper used to resolve — and CREATE — `112 المخزون`, then drag every
// inventory-named account under it. It runs at EVERY BOOT (server.js:3413).
//
// Later in the SAME boot, server.js:4893 (v5.11.14) runs with the opposite
// belief. Its own comment states that `112` is «الذمم المدينة / AR in the new
// chart» and it moves the inventory codes 1200/1210/1220/1230 to `113` and AR
// `1150` to `112`.
//
// So one boot created an inventory group at `112` and then moved inventory to
// `113`. Two groups named المخزون, re-created on every single restart. It was
// never a historical accident to be cleaned up once — it was a standing
// contradiction between two migrations.
//
// The governed six-digit chart has one Inventory folder (100300) and one
// posting leaf (1200). Warehouse/category/product detail is never a GL node.
const INVENTORY_GROUP_CODE = '113000';

async function _repairInventoryClassification(db) {
  const repaired = [];
  // Resolve the inventory group. It is NEVER created here: creating a group
  // from a repair helper is exactly how the second one appeared. If the chart
  // has no `100300`, this reports that and does nothing — a missing group is a
  // seeding problem, not something a classification pass should paper over.
  const [pInv] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [INVENTORY_GROUP_CODE]);
  const target112Id = pInv.length ? pInv[0].id : null;
  if (!target112Id) return { ok: false, reason: 'no-inventory-group-' + INVENTORY_GROUP_CODE, repaired };

  // Find candidates: name contains inventory keywords AND parent chain leads to code 12
  const inventoryRegex = /(مخزون|منتجات تامة|منتجات تحت التشغيل|finished good|wip|raw material)/i;
  const [allAcc] = await db.query(
    "SELECT id, code, name_ar, parent_id FROM gl_accounts WHERE type = 'asset'"
  );
  const byId = Object.fromEntries(allAcc.map(a => [a.id, a]));
  function ancestorCode(id, depth = 0) {
    if (depth > 10) return null;
    const a = byId[id]; if (!a) return null;
    if (a.code === '12') return '12';
    if (a.code === INVENTORY_GROUP_CODE) return INVENTORY_GROUP_CODE;
    if (!a.parent_id) return a.code;
    return ancestorCode(a.parent_id, depth + 1);
  }
  for (const a of allAcc) {
    if (!inventoryRegex.test(a.name_ar || '')) continue;
    if (a.code === INVENTORY_GROUP_CODE) continue;            // the target itself
    if (String(a.code).startsWith(INVENTORY_GROUP_CODE)) continue; // already correct
    const anc = ancestorCode(a.parent_id);
    // Narrow by design: only rescues accounts stranded under `12` (fixed
    // assets). It deliberately does NOT sweep the whole chart — an
    // inventory-NAMED account can legitimately sit elsewhere (a provision, a
    // clearing account), and a boot-time pass that re-parents on a name match
    // alone is how accounts started migrating on their own.
    if (anc === '12') {
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [target112Id, a.id]);
      repaired.push({ id: a.id, code: a.code, name: a.name_ar, oldParent: a.parent_id, newParent: target112Id });
    }
  }
  // Depth changed for anything that moved.
  if (repaired.length) {
    try { await coaTree.recomputeLevels(db); } catch (_) {}
  }
  return { ok: true, repaired };
}
// Expose helper on the router so server.js can run it at boot
router._repairInventoryClassification = _repairInventoryClassification;

router.post('/gl/repair-inventory-classification', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const r = await _repairInventoryClassification(db);
    res.json({ success: r.ok, fixed: r.repaired.length, repaired: r.repaired, reason: r.reason || null });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.10.35 — General-purpose chart-of-accounts repair. Walks every account
// and re-parents anything that:
//   1. Is an orphan (parent_id points at a deleted/missing row), OR
//   2. Has a name keyword that conflicts with its current branch
//      (e.g. account named "مخزون شيء" parented under fixed-assets tree)
//
// Idempotent: returns { fixed: 0 } when nothing needs changing.
//
// Response:
//   {
//     success, fixed, repaired: [{ id, code, nameAr, oldParentCode,
//       newParentCode, reason }],
//     skipped:  [{ id, code, nameAr, reason }]   // for human review
//   }
router.post('/gl/repair-classification', requireCapability('finance.accounts.manage'), async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'LEGACY_COA_REPAIR_RETIRED',
    error: 'تم إيقاف الإصلاح القائم على كلمات أسماء الحسابات؛ استخدم قالب دليل الحسابات والترحيل المعتمد.'
  });
  try {
    // Keyword → preferred parent code map (ordered: most-specific first)
    // Each entry: [regex, parentCode, label]
    const KEYWORD_RULES = [
      // Inventory must come BEFORE other matchers since "مخزون" is generic
      [/^(مخزون|inventory|raw\s*material|finished\s*goods|wip|تغليف|تعبئة)/i, '112', 'مخزون'],
      [/(عهدة|كاشير|صندوق|cash\s*box|petty\s*cash|نقدية)/i,                   '111', 'النقدية والبنوك'],
      [/(بنك\b|bank\b|حساب\s*جاري)/i,                                          '111', 'النقدية والبنوك'],
      [/(ذمم\s*مدين|عملاء|customers?\s*receivab|تطبيقات\s*التوصيل|سلف.*موظف|prepaid|مدفوعة\s*مقدم)/i, '113', 'الذمم المدينة'],
      [/(ضريبة\s*المدخلات|input\s*vat)/i,                                      '114', 'ضريبة المدخلات'],
      [/(معدات|آلات|أجهزة\s*pos|أثاث|ديكور|مجمع\s*إهلاك|equipment)/i,           '12',  'الأصول الثابتة'],
      [/(ذمم\s*دائن|موردون|suppliers?\s*payab|accounts?\s*payable)/i,           '211', 'الموردون والدائنون'],
      [/(رواتب\s*مستحق|إيجار.*مستحق|منافع\s*مستحق|accrued)/i,                  '212', 'المصروفات المستحقة'],
      [/(ضريبة\s*المخرجات|output\s*vat|زكاة|ضريبة\s*دخل)/i,                    '213', 'الضرائب'],
      [/(قروض|loans?)/i,                                                       '214', 'القروض'],
      [/(رأس\s*المال|capital)/i,                                                '31',  'رأس المال'],
      [/(أرباح\s*محتجزة|أرباح\s*مرحلة|retained\s*earnings)/i,                  '32',  'الأرباح المبقاة'],
      [/(مسحوبات|drawings|جاري\s*المالك)/i,                                    '33',  'المسحوبات'],
      [/(إيرادات.*مبيعات|sales\s*revenue|مبيعات\s*pos|مبيعات\s*المشروبات|مبيعات\s*المأكولات)/i, '411', 'مبيعات نقاط البيع'],
      [/(تطبيقات\s*التوصيل|delivery\s*apps?|جاهز|هنقرستيشن|كيتا|keeta)/i,      '412', 'مبيعات تطبيقات التوصيل'],
      [/(كاترينج|catering|حفلات\s*خارجي)/i,                                    '421', 'إيرادات الحفلات الخارجية'],
      [/(فروقات\s*جرد.*إيراد|stock\s*gain|إيراد.*متنوع)/i,                     '422', 'إيرادات متنوعة'],
      [/(تكلفة\s*المبيعات|cogs|cost\s*of\s*goods|تكلفة\s*البن|تكلفة\s*المواد)/i,'511', 'تكلفة المواد المستهلكة'],
      [/(هدر|تالف|waste|spoilage|فروقات\s*الجرد|stock\s*variance|فروقات\s*الإنتاج)/i, '512', 'الهالك والتوالف'],
      [/(رواتب|أجور|salaries|wages|عمالة)/i,                                   '521', 'الرواتب والأجور'],
      [/(إيجار|rent|كهرباء|ماء|إنترنت|اتصال|utilities)/i,                      '522', 'الإيجارات والمنافع'],
      [/(صيانة|maintenance|تشغيل|نظافة|تعقيم)/i,                               '523', 'التشغيل والصيانة'],
      [/(تسويق|marketing|إعلان|عمولة\s*تطبيق)/i,                               '524', 'التسويق والعمولات'],
      [/(اشتراك|software|نظام|برنامج)/i,                                       '531', 'رسوم الأنظمة والبرامج'],
      [/(رسوم\s*حكومي|تراخيص|licens)/i,                                        '532', 'الرسوم الحكومية والتراخيص'],
      [/(عمولة\s*بنك|رسوم\s*شبكة|رسوم\s*تحويل|merchant\s*fee)/i,               '533', 'العمولات البنكية ورسوم الدفع'],
      [/(ضيافة|نثريات)/i,                                                       '534', 'الضيافة والنثريات'],
      [/(امتياز|franchise|royalty)/i,                                          '533', 'رسوم الامتياز']
    ];

    // 1. Build code→id and id→row maps
    const [allRows] = await db.query(
      'SELECT id, code, name_ar, type, parent_id, level FROM gl_accounts');
    const byCode = {};
    const byId   = {};
    allRows.forEach(r => { byCode[r.code] = r; byId[r.id] = r; });

    const repaired = [];
    const skipped  = [];

    // Helper: resolve preferred parent for a code, walking up if absent
    function resolvePreferredParent(preferredCode) {
      let walk = String(preferredCode || '');
      while (walk.length > 0) {
        if (byCode[walk]) return byCode[walk];
        walk = walk.substring(0, walk.length - 1);
      }
      return null;
    }

    for (const acc of allRows) {
      // Skip top-level roots (codes 1..5)
      if (!acc.parent_id || ['1','2','3','4','5'].includes(acc.code)) continue;

      // (1) Orphan check: parent_id present but no matching row
      let currentParent = byId[acc.parent_id] || null;
      if (!currentParent) {
        // Try to derive parent from code prefix
        const prefix = acc.code.substring(0, acc.code.length - 1);
        const target = resolvePreferredParent(prefix);
        if (target && target.id !== acc.id) {
          await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
            [target.id, target.code.length + 1, acc.id]);
          repaired.push({
            id: acc.id, code: acc.code, nameAr: acc.name_ar,
            oldParentCode: '(orphan)', newParentCode: target.code,
            reason: 'orphan-reparented-by-prefix'
          });
          // refresh local cache so subsequent loops see the new parent
          byId[acc.id].parent_id = target.id;
          continue;
        }
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'orphan-no-prefix-match' });
        continue;
      }

      // (2) Keyword-based reclassification: if the name strongly hints at a
      //     known category, ensure the account sits under that branch.
      const nameForMatch = String(acc.name_ar || '');
      let matchedRule = null;
      for (const [re, parentCode, label] of KEYWORD_RULES) {
        if (re.test(nameForMatch)) { matchedRule = { parentCode, label }; break; }
      }
      if (!matchedRule) continue;

      // Walk up from acc to root collecting parent codes — if matchedRule's
      // root is already an ancestor, the account is correctly placed.
      const rootOfRule = matchedRule.parentCode.charAt(0);   // '1'..'5'
      let walker = currentParent;
      let seenRoot = null;
      const seenIds = new Set();
      while (walker) {
        if (seenIds.has(walker.id)) break;     // cycle guard
        seenIds.add(walker.id);
        if (walker.code === rootOfRule) { seenRoot = walker; break; }
        if (!walker.parent_id) { seenRoot = walker; break; }
        walker = byId[walker.parent_id] || null;
      }

      // Acceptable when account already lives under the right top-level root
      // AND its immediate parent code starts with the matchedRule's parentCode prefix
      const directParentCode = currentParent.code || '';
      const okBranch = (seenRoot && seenRoot.code === rootOfRule);
      const okSubtree = directParentCode.startsWith(matchedRule.parentCode) ||
                        matchedRule.parentCode.startsWith(directParentCode);
      if (okBranch && okSubtree) continue;

      // Otherwise re-parent under the preferred parent
      const target = resolvePreferredParent(matchedRule.parentCode);
      if (!target) {
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'preferred-parent-' + matchedRule.parentCode + '-missing' });
        continue;
      }
      if (target.id === acc.id) continue; // can't be its own parent

      // Don't re-parent a top-level root
      try {
        await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
          [target.id, target.code.length + 1, acc.id]);
        repaired.push({
          id: acc.id, code: acc.code, nameAr: acc.name_ar,
          oldParentCode: directParentCode, newParentCode: target.code,
          reason: 'keyword:' + matchedRule.label
        });
        byId[acc.id].parent_id = target.id;
      } catch (e) {
        skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'update-error:' + e.message });
      }
    }

    res.json({ success: true, fixed: repaired.length, repaired, skipped });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// v5.10.60 — Pure-prefix tree repair.
// Owner reported: "اجدة حسابات ليست تابعة للحساب الرئيسي" — accounts
// appearing at the wrong tree depth because their parent_id points to a
// VALID row but the WRONG one (e.g. "11201" parented under "1" instead
// of "112"). The existing /gl/repair-classification only fixes:
//   (1) orphan parent_id (target row deleted) → re-link by prefix
//   (2) name-keyword mismatches              → re-link by KEYWORD_RULES
// Neither catches the case above where parent_id IS valid but isn't the
// longest existing-code prefix of the child.
//
// This endpoint adds rule (3): for every non-root account, the parent's
// code must be the LONGEST existing code that's a strict prefix of the
// child's code. Walks the whole chart and re-parents anything that
// doesn't match. Also recomputes `level` from the parent chain depth so
// the UI's "depth" hint stays in sync.
//
// Response:
//   {
//     success, fixed, repaired: [{ id, code, nameAr, oldParentCode,
//       newParentCode, oldLevel, newLevel }],
//     skipped:  [{ id, code, reason }]   // for human review
//   }
// ───────────────────────────────────────────────────────────────────────
async function _repairCoaByPrefix(db) {
  const [allRows] = await db.query(
    'SELECT id, code, name_ar, type, parent_id, level FROM gl_accounts');
  const byCode = {};
  const byId   = {};
  allRows.forEach(r => { byCode[String(r.code)] = r; byId[r.id] = r; });

  // For a given child code, find the longest EXISTING strictly-prefix code.
  // e.g. "11201" → tries "1120", "112", "11", "1" in order; returns first hit.
  function longestExistingPrefix(childCode) {
    const code = String(childCode || '');
    for (let len = code.length - 1; len >= 1; len--) {
      const candidate = code.substring(0, len);
      if (byCode[candidate] && byCode[candidate].id !== byId[childCode] ? byId[childCode].id : null) {
        return byCode[candidate];
      }
      if (byCode[candidate]) return byCode[candidate];
    }
    return null;
  }

  // Compute level by walking up via parent_id (cycle-guarded, capped at 20).
  function computeLevelFromChain(accId) {
    let lvl = 1;
    let walker = byId[accId];
    const seen = new Set();
    while (walker && walker.parent_id && !seen.has(walker.id) && lvl < 20) {
      seen.add(walker.id);
      walker = byId[walker.parent_id];
      lvl++;
    }
    return lvl;
  }

  const repaired = [];
  const skipped  = [];
  const ROOTS = new Set(['1','2','3','4','5']);

  for (const acc of allRows) {
    // Never touch the 5 IFRS roots — they MUST have parent_id = NULL, level = 1.
    if (ROOTS.has(String(acc.code))) {
      // Defensive: if a root somehow got a parent_id or wrong level, fix it.
      if (acc.parent_id !== null || Number(acc.level) !== 1) {
        await db.query('UPDATE gl_accounts SET parent_id = NULL, level = 1 WHERE id = ?', [acc.id]);
        repaired.push({
          id: acc.id, code: acc.code, nameAr: acc.name_ar,
          oldParentCode: acc.parent_id ? (byId[acc.parent_id] || {}).code || '(deleted)' : '(none)',
          newParentCode: '(none — root)',
          oldLevel: acc.level, newLevel: 1,
          reason: 'root-must-have-no-parent'
        });
        byId[acc.id].parent_id = null;
        byId[acc.id].level = 1;
      }
      continue;
    }

    // Find the longest existing strict-prefix code of this account's code.
    const code = String(acc.code || '');
    let preferredParent = null;
    for (let len = code.length - 1; len >= 1; len--) {
      const cand = code.substring(0, len);
      if (byCode[cand] && byCode[cand].id !== acc.id) { preferredParent = byCode[cand]; break; }
    }

    if (!preferredParent) {
      // No prefix-parent exists in the table — leave it alone, it's likely
      // a custom code that doesn't follow the numeric hierarchy.
      skipped.push({
        id: acc.id, code: acc.code, nameAr: acc.name_ar,
        reason: 'no-prefix-parent-in-chart'
      });
      continue;
    }

    const currentParentCode = acc.parent_id ? (byId[acc.parent_id] || {}).code || null : null;
    // `expectedLevel` was computed here and never used — and `A || B` on two
    // numbers only ever picks B when A is 0, so it was not even the fallback it
    // looked like. Deleted.
    //
    // targetLevel is still written below so this helper's own before/after
    // report stays truthful, but it is no longer the last word: every caller
    // ends with coaTree.recomputeLevels(), which re-derives depth from the
    // final tree. Writing a level here and deriving it there cannot disagree,
    // because the derive always runs after the last re-parent.
    const targetLevel = (Number(preferredParent.level) || coaTree.DEPTH_BASE) + 1;

    const parentChanged = (acc.parent_id !== preferredParent.id);
    const levelChanged  = (Number(acc.level) !== targetLevel);

    if (!parentChanged && !levelChanged) continue;   // already correct

    try {
      await db.query(
        'UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
        [preferredParent.id, targetLevel, acc.id]);
      repaired.push({
        id: acc.id, code: acc.code, nameAr: acc.name_ar,
        oldParentCode: currentParentCode || '(none)',
        newParentCode: preferredParent.code,
        oldLevel: acc.level, newLevel: targetLevel,
        reason: parentChanged
          ? (levelChanged ? 'reparent+relevel-by-prefix' : 'reparent-by-prefix')
          : 'relevel-only'
      });
      // Update local cache for downstream level-recompute consistency.
      byId[acc.id].parent_id = preferredParent.id;
      byId[acc.id].level = targetLevel;
    } catch (e) {
      skipped.push({
        id: acc.id, code: acc.code, nameAr: acc.name_ar,
        reason: 'update-error:' + e.message
      });
    }
  }

  // Derive every level from the tree this helper just rewrote. Without this,
  // an account re-parented above could leave its own DESCENDANTS at the depth
  // they had under the old parent — the helper only ever touched the node it
  // moved. Runs on the same `db` handle it was given, so inside a caller's
  // transaction it is part of that transaction.
  const levels = await coaTree.recomputeLevels(db);

  return { repaired, skipped, levelsDerived: levels.updated };
}
// Export so server.js / boot scripts can run it idempotently if needed.
router._repairCoaByPrefix = _repairCoaByPrefix;

router.post('/gl/repair-tree-by-prefix', requireCapability('finance.accounts.manage'), async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'LEGACY_COA_REPAIR_RETIRED',
    error: 'تم إيقاف إعادة بناء الشجرة من بادئات الأرقام القديمة.'
  });
  try {
    const r = await _repairCoaByPrefix(db);
    res.json({
      success: true,
      fixed: r.repaired.length,
      skipped: r.skipped.length,
      repaired: r.repaired,
      skippedDetails: r.skipped
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// v5.10.38 — Deep repair (single atomic endpoint).
// Runs every COA integrity fix in one transaction and returns
// before/after diagnostic counts so the UI can show what changed.
// ───────────────────────────────────────────────────────────────────────

// Keyword → preferred parent code map (ordered: most-specific first).
// Banks regex strengthened over the inline rules used by /gl/repair-
// classification: matches "بنك" anywhere (no \b — Arabic word boundaries
// are unreliable) plus "البنوك / الحساب البنكي / حساب جاري / current account".
const _COA_KEYWORD_RULES = [
  [/^(مخزون|inventory|raw\s*material|finished\s*goods|wip|تغليف|تعبئة)/i, '112', 'مخزون'],
  [/(بنك|bank|البنوك|حساب\s*جاري|current\s*account|الحساب(?:ات)?\s*البنكي)/i, '111', 'النقدية والبنوك'],
  [/(عهدة|كاشير|صندوق|cash\s*box|petty\s*cash|نقدية)/i,                   '111', 'النقدية والبنوك'],
  [/(ذمم\s*مدين|عملاء|customers?\s*receivab|تطبيقات\s*التوصيل|سلف.*موظف|prepaid|مدفوعة\s*مقدم)/i, '113', 'الذمم المدينة'],
  [/(ضريبة\s*المدخلات|input\s*vat)/i,                                      '114', 'ضريبة المدخلات'],
  [/(معدات|آلات|أجهزة\s*pos|أثاث|ديكور|مجمع\s*إهلاك|equipment)/i,           '12',  'الأصول الثابتة'],
  [/(ذمم\s*دائن|موردون|suppliers?\s*payab|accounts?\s*payable)/i,           '211', 'الموردون والدائنون'],
  [/(رواتب\s*مستحق|إيجار.*مستحق|منافع\s*مستحق|accrued)/i,                  '212', 'المصروفات المستحقة'],
  [/(ضريبة\s*المخرجات|output\s*vat|زكاة|ضريبة\s*دخل)/i,                    '213', 'الضرائب'],
  [/(قروض|loans?)/i,                                                       '214', 'القروض'],
  [/(رأس\s*المال|capital)/i,                                               '31',  'رأس المال'],
  [/(أرباح\s*محتجزة|أرباح\s*مرحلة|retained\s*earnings)/i,                  '32',  'الأرباح المبقاة'],
  [/(مسحوبات|drawings|جاري\s*المالك)/i,                                    '33',  'المسحوبات'],
  [/(إيرادات.*مبيعات|sales\s*revenue|مبيعات\s*pos|مبيعات\s*المشروبات|مبيعات\s*المأكولات)/i, '411', 'مبيعات نقاط البيع'],
  [/(تطبيقات\s*التوصيل|delivery\s*apps?|جاهز|هنقرستيشن|كيتا|keeta)/i,      '412', 'مبيعات تطبيقات التوصيل'],
  [/(كاترينج|catering|حفلات\s*خارجي)/i,                                    '421', 'إيرادات الحفلات الخارجية'],
  [/(فروقات\s*جرد.*إيراد|stock\s*gain|إيراد.*متنوع)/i,                     '422', 'إيرادات متنوعة'],
  [/(تكلفة\s*المبيعات|cogs|cost\s*of\s*goods|تكلفة\s*البن|تكلفة\s*المواد)/i,'511', 'تكلفة المواد المستهلكة'],
  [/(هدر|تالف|waste|spoilage|فروقات\s*الجرد|stock\s*variance|فروقات\s*الإنتاج)/i, '512', 'الهالك والتوالف'],
  [/(رواتب|أجور|salaries|wages|عمالة)/i,                                   '521', 'الرواتب والأجور'],
  [/(إيجار|rent|كهرباء|ماء|إنترنت|اتصال|utilities)/i,                      '522', 'الإيجارات والمنافع'],
  [/(صيانة|maintenance|تشغيل|نظافة|تعقيم)/i,                               '523', 'التشغيل والصيانة'],
  [/(تسويق|marketing|إعلان|عمولة\s*تطبيق)/i,                               '524', 'التسويق والعمولات'],
  [/(اشتراك|software|نظام|برنامج)/i,                                       '531', 'رسوم الأنظمة والبرامج'],
  [/(رسوم\s*حكومي|تراخيص|licens)/i,                                        '532', 'الرسوم الحكومية والتراخيص'],
  [/(عمولة\s*بنك|رسوم\s*شبكة|رسوم\s*تحويل|merchant\s*fee)/i,               '533', 'العمولات البنكية ورسوم الدفع'],
  [/(ضيافة|نثريات)/i,                                                       '534', 'الضيافة والنثريات'],
  [/(امتياز|franchise|royalty)/i,                                          '533', 'رسوم الامتياز']
];

const _COA_ROOT_TYPE_BY_CODE = {
  '1': 'asset', '2': 'liability', '3': 'equity', '4': 'revenue', '5': 'expense'
};

// THE BUG THE OWNER REPORTED AS "a problem with account levels".
//
// This returned **0** for a root, while every other level writer and reader in
// the system says **1** (`_repairCoaByPrefix` :1513, `_coaFixRootsAndOrphans`
// :1987, and lib/reports/trialBalance.js). `POST /gl/deep-repair` ran BOTH in
// one transaction — an early step set roots to 1, then `_coaAutoFixLevels`
// recomputed 0-based — so a single click shifted every account in the chart
// down one level. The trial balance then flagged `levelMismatch` on EVERY
// account, and because that feeds `isClean`, the whole report rendered
// «غير سليم» even though the ledger arithmetic was perfect.
//
// Now a thin adapter over the one 1-based, cycle-safe implementation in
// lib/coa/tree.js — the same one the trial balance uses, so the two can no
// longer disagree. The old `seen` parameter is accepted and ignored: the
// shared walk carries its own cycle protection.
function _coaComputeDepth(byId, a) {
  if (!a || !a.id) return coaTree.DEPTH_BASE;
  const rows = Array.isArray(byId) ? byId : Object.values(byId || {});
  const { depth } = coaTree.computeDepths(rows, new Map(rows.map((r) => [r.id, r])));
  return depth.get(a.id) || coaTree.DEPTH_BASE;
}

// Snapshot of integrity issues. Used before/after deep-repair to
// quantify what changed.
async function _coaDiagnoseSnapshot(db) {
  const out = {};
  const [orphans] = await db.query(
    `SELECT id FROM gl_accounts
      WHERE parent_id IS NOT NULL
        AND parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
  out.orphans = orphans.length;

  const [tm] = await db.query(
    `SELECT c.id FROM gl_accounts c
       JOIN gl_accounts p ON p.id = c.parent_id
      WHERE c.type IS NOT NULL AND p.type IS NOT NULL AND c.type <> p.type`);
  out.typeMismatch = tm.length;

  const [ctm] = await db.query(
    `SELECT id FROM gl_accounts WHERE code IS NOT NULL AND (
       (LEFT(code,1)='1' AND type<>'asset')      OR
       (LEFT(code,1)='2' AND type<>'liability')  OR
       (LEFT(code,1)='3' AND type<>'equity')     OR
       (LEFT(code,1)='4' AND type<>'revenue')    OR
       (LEFT(code,1)='5' AND type<>'expense'))`);
  out.codeTypeMismatch = ctm.length;

  const [dup] = await db.query(
    `SELECT code FROM gl_accounts WHERE code IS NOT NULL GROUP BY code HAVING COUNT(*) > 1`);
  out.duplicateCodes = dup.length;

  const [bwe] = await db.query(
    `SELECT a.id FROM gl_accounts a
      WHERE ABS(IFNULL(a.balance,0)) > 0.001
        AND NOT EXISTS (SELECT 1 FROM gl_entries e
                          JOIN gl_journals j ON j.id = e.journal_id
                         WHERE e.account_id = a.id AND j.status='posted')`);
  out.balanceWithoutEntries = bwe.length;

  const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
  const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
  let levelMismatch = 0, cycles = 0;
  // One tree walk for the whole chart, not one per account: the shared
  // computeDepths already memoizes across the entire set and reports cycle
  // members itself, so the per-account ancestry crawl below is only kept for
  // its 50-hop guard on data the walk would classify as a cycle anyway.
  const { depth: depthMap, cycleMembers } = coaTree.computeDepths(
    allAccs, new Map(allAccs.map((r) => [r.id, r])));
  for (const a of allAccs) {
    if (cycleMembers.has(a.id)) { cycles++; continue; }
    const d = depthMap.get(a.id) || coaTree.DEPTH_BASE;
    if (Number(a.level || 0) !== d) levelMismatch++;
  }
  out.levelMismatch = levelMismatch;
  out.cycles = cycles;
  return out;
}

function _coaResolvePreferredParent(byCode, preferredCode) {
  let walk = String(preferredCode || '');
  while (walk.length > 0) {
    if (byCode[walk]) return byCode[walk];
    walk = walk.substring(0, walk.length - 1);
  }
  return null;
}

// Reparent accounts whose name strongly hints at a known IFRS branch.
// Bug fixes vs. the legacy /gl/repair-classification:
//   (a) orphan reparenting requires type compatibility
//   (b) level computed from target.level, not target.code.length
//   (c) banks regex no longer relies on \b word boundaries
async function _coaRepairByKeywords(db) {
  const [allRows] = await db.query(
    'SELECT id, code, name_ar, type, parent_id, level FROM gl_accounts');
  const byCode = {}, byId = {};
  allRows.forEach(r => { byCode[r.code] = r; byId[r.id] = r; });

  const repaired = [], skipped = [];

  for (const acc of allRows) {
    if (!acc.parent_id || ['1','2','3','4','5'].includes(acc.code)) continue;

    let currentParent = byId[acc.parent_id] || null;
    if (!currentParent) {
      const codeStr = String(acc.code || '');
      const prefix = codeStr.substring(0, Math.max(0, codeStr.length - 1));
      const target = _coaResolvePreferredParent(byCode, prefix);
      if (target && target.id !== acc.id) {
        const targetRootType = _COA_ROOT_TYPE_BY_CODE[String(target.code || '').charAt(0)];
        if (targetRootType && acc.type && acc.type !== targetRootType) {
          skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'type-conflict-needs-manual-review' });
          continue;
        }
        await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
          [target.id, (Number(target.level || 0) + 1), acc.id]);
        repaired.push({
          id: acc.id, code: acc.code, nameAr: acc.name_ar,
          oldParentCode: '(orphan)', newParentCode: target.code,
          reason: 'orphan-reparented-by-prefix'
        });
        byId[acc.id].parent_id = target.id;
        continue;
      }
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'orphan-no-prefix-match' });
      continue;
    }

    const nameForMatch = String(acc.name_ar || '');
    let matchedRule = null;
    for (const [re, parentCode, label] of _COA_KEYWORD_RULES) {
      if (re.test(nameForMatch)) { matchedRule = { parentCode, label }; break; }
    }
    if (!matchedRule) continue;

    const rootOfRule = matchedRule.parentCode.charAt(0);
    let walker = currentParent;
    let seenRoot = null;
    const seenIds = new Set();
    while (walker) {
      if (seenIds.has(walker.id)) break;
      seenIds.add(walker.id);
      if (walker.code === rootOfRule) { seenRoot = walker; break; }
      if (!walker.parent_id) { seenRoot = walker; break; }
      walker = byId[walker.parent_id] || null;
    }

    const directParentCode = currentParent.code || '';
    const okBranch = (seenRoot && seenRoot.code === rootOfRule);
    const okSubtree = directParentCode.startsWith(matchedRule.parentCode) ||
                      matchedRule.parentCode.startsWith(directParentCode);
    if (okBranch && okSubtree) continue;

    const target = _coaResolvePreferredParent(byCode, matchedRule.parentCode);
    if (!target) {
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'preferred-parent-' + matchedRule.parentCode + '-missing' });
      continue;
    }
    if (target.id === acc.id) continue;

    try {
      await db.query('UPDATE gl_accounts SET parent_id = ?, level = ? WHERE id = ?',
        [target.id, (Number(target.level || 0) + 1), acc.id]);
      repaired.push({
        id: acc.id, code: acc.code, nameAr: acc.name_ar,
        oldParentCode: directParentCode, newParentCode: target.code,
        reason: 'keyword:' + matchedRule.label
      });
      byId[acc.id].parent_id = target.id;
    } catch (e) {
      skipped.push({ id: acc.id, code: acc.code, nameAr: acc.name_ar, reason: 'update-error:' + e.message });
    }
  }
  return { repaired, skipped };
}

// v5.10.41 — physically move accounts whose code's first digit doesn't
// match their actual root ancestor. e.g. an account with code 41xxx
// sitting under root 5 (cost of sales) gets re-parented under root 4.
// v5.10.44 — silent try/catch replaced by per-account console.log; the
// returned object now exposes skipped[] (no candidate found) and failed[]
// (DB error during UPDATE) so the caller and Railway logs both see the
// truth instead of a swallowed failure.
async function _coaFixRootCodeMismatch(db) {
  const fixed = [];
  const skipped = [];
  const failed = [];
  const [allAccs] = await db.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
  const byId = {}, byCode = {};
  allAccs.forEach(a => { byId[a.id] = a; byCode[a.code] = a; });

  function ascendantCode(a) {
    let walker = a, hops = 0;
    const seen = new Set();
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) return null;
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) return null;
    }
    return walker ? walker.code : null;
  }

  for (const a of allAccs) {
    const codeStr = String(a.code || '');
    if (!codeStr) { skipped.push({ code: a.code, name: a.name_ar, reason: 'empty-code' }); continue; }
    const codeRoot = codeStr.charAt(0);
    if (['1','2','3','4','5'].indexOf(codeRoot) < 0) {
      skipped.push({ code: a.code, name: a.name_ar, reason: 'non-numeric-root:' + codeRoot });
      continue;
    }
    if (codeStr === codeRoot) continue; // root itself — silent skip
    const actualRoot = ascendantCode(a);
    if (!actualRoot) { skipped.push({ code: a.code, name: a.name_ar, reason: 'no-ancestor-root' }); continue; }
    if (actualRoot === codeRoot) continue; // already correct — silent skip

    let candidate = null;
    let walk = codeStr.substring(0, codeStr.length - 1);
    while (walk.length > 0) {
      const cand = byCode[walk];
      if (cand) {
        const candRoot = ascendantCode(cand);
        if (cand.code === codeRoot || candRoot === codeRoot) { candidate = cand; break; }
      }
      walk = walk.substring(0, walk.length - 1);
    }
    if (!candidate) candidate = byCode[codeRoot] || null;
    if (!candidate || candidate.id === a.id) {
      skipped.push({ code: a.code, name: a.name_ar, reason: 'no-valid-candidate', expectedRoot: codeRoot, actualRoot });
      continue;
    }

    try {
      await db.query('UPDATE gl_accounts SET parent_id = ? WHERE id = ?', [candidate.id, a.id]);
      console.log('[fixRootCodeMismatch] MOVED ' + a.code + ' (' + (a.name_ar || '') + ') from root ' + actualRoot + ' -> under ' + candidate.code);
      fixed.push({
        id: a.id, code: a.code, name: a.name_ar,
        oldRootCode: actualRoot,
        newParentCode: candidate.code,
        expectedRootCode: codeRoot
      });
      byId[a.id].parent_id = candidate.id;
    } catch (e) {
      console.error('[fixRootCodeMismatch] FAILED to move ' + a.code + ' (' + (a.name_ar || '') + '): ' + e.message);
      failed.push({ code: a.code, name: a.name_ar, error: e.message });
    }
  }
  return { fixed, skipped, failed };
}

// v5.10.44 — Last-resort topology guarantee. Runs AFTER all the smart
// helpers. For any account whose code's first digit doesn't match its
// reachable root, force-reparent it directly under the correct root.
// We sacrifice the original sub-hierarchy in exchange for guaranteed
// correctness — better that 41xxx ends up flat under root 4 than to
// keep it under root 5 because the smart helpers couldn't find a
// suitable intermediate parent.
async function _coaBruteForceRootTopology(db) {
  const moved = [];
  const failed = [];
  const [roots] = await db.query("SELECT id, code FROM gl_accounts WHERE code IN ('1','2','3','4','5') AND (parent_id IS NULL OR parent_id = '')");
  const rootIdByCode = {};
  roots.forEach(r => { rootIdByCode[r.code] = r.id; });

  const missingRoots = ['1','2','3','4','5'].filter(c => !rootIdByCode[c]);
  if (missingRoots.length) {
    console.error('[bruteForceTopology] ABORT - missing roots: ' + missingRoots.join(','));
    return { moved, failed, missingRoots };
  }

  const [allAccs] = await db.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
  const byId = {};
  allAccs.forEach(a => { byId[a.id] = a; });

  function reachableRootCode(a) {
    let walker = a, hops = 0;
    const seen = new Set();
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) return null;
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) return null;
    }
    return walker ? String(walker.code || '') : null;
  }

  for (const a of allAccs) {
    const code = String(a.code || '');
    if (!code) continue;
    const expectedRoot = code.charAt(0);
    if (['1','2','3','4','5'].indexOf(expectedRoot) < 0) continue;
    if (code === expectedRoot) continue; // root itself
    const actual = reachableRootCode(a);
    if (actual === expectedRoot) continue; // correctly placed
    const targetRootId = rootIdByCode[expectedRoot];
    if (!targetRootId || targetRootId === a.id) continue;
    try {
      await db.query('UPDATE gl_accounts SET parent_id = ? WHERE id = ?', [targetRootId, a.id]);
      console.log('[bruteForceTopology] MOVED ' + code + ' (' + (a.name_ar || '') + ') -> under root ' + expectedRoot);
      moved.push({ code: a.code, name: a.name_ar, fromRoot: actual, toRoot: expectedRoot });
      byId[a.id].parent_id = targetRootId;
    } catch (e) {
      console.error('[bruteForceTopology] FAILED ' + code + ' (' + (a.name_ar || '') + '): ' + e.message);
      failed.push({ code: a.code, name: a.name_ar, error: e.message });
    }
  }
  return { moved, failed, missingRoots: [] };
}

async function _coaAlignTypeWithParent(db) {
  const fixed = [];
  const [rows] = await db.query('SELECT id, code, type FROM gl_accounts WHERE code IS NOT NULL');
  for (const r of rows) {
    const expected = _COA_ROOT_TYPE_BY_CODE[String(r.code).charAt(0)];
    if (expected && r.type !== expected) {
      await db.query('UPDATE gl_accounts SET type = ? WHERE id = ?', [expected, r.id]);
      fixed.push({ id: r.id, code: r.code, oldType: r.type, newType: expected });
    }
  }
  return fixed;
}

async function _coaFixRootsAndOrphansByPrefix(db) {
  let fixed = 0;
  // Merge legacy code 6 into 5 (if both exist) or rename
  const [acc6] = await db.query("SELECT id FROM gl_accounts WHERE code = '6'");
  if (acc6.length) {
    const [acc5] = await db.query("SELECT id FROM gl_accounts WHERE code = '5'");
    if (acc5.length) {
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?", [acc5[0].id, acc6[0].id]);
      await db.query("DELETE FROM gl_accounts WHERE id = ? AND code = '6'", [acc6[0].id]);
      fixed++;
    } else {
      await db.query("UPDATE gl_accounts SET code = '5', name_ar = 'المصروفات', parent_id = NULL, level = 1 WHERE id = ?", [acc6[0].id]);
      fixed++;
    }
  }
  // Reparent orphans by code prefix (level>1 with no parent)
  const [orphans] = await db.query("SELECT id, code, level FROM gl_accounts WHERE level > 1 AND (parent_id IS NULL OR parent_id = '')");
  for (const o of orphans) {
    let parentCode = String(o.code || '');
    parentCode = parentCode.substring(0, Math.max(0, parentCode.length - 1));
    while (parentCode.length > 0) {
      const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = ?", [parentCode]);
      if (parent.length) {
        await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [parent[0].id, o.id]);
        fixed++;
        break;
      }
      parentCode = parentCode.substring(0, parentCode.length - 1);
    }
  }
  // Ensure roots 1..5 are level 1, parent NULL
  await db.query("UPDATE gl_accounts SET level = 1, parent_id = NULL WHERE code IN ('1','2','3','4','5') AND (level != 1 OR parent_id IS NOT NULL)");

  // v5.10.60 — Owner-reported gap: accounts with VALID but WRONG parent_id.
  // The block above only catches NULL parents. Many real-world COA rows
  // have a non-NULL parent_id pointing at the wrong row (e.g. account
  // "11201" attached to root "1" instead of "112"), which made them
  // render at the wrong tree depth. Fix: for every non-root account,
  // compute the longest existing strict-prefix code; if that's not what
  // parent_id currently points to, re-link it.
  const [allRows] = await db.query("SELECT id, code, parent_id FROM gl_accounts WHERE code NOT IN ('1','2','3','4','5')");
  const [allForLookup] = await db.query("SELECT id, code FROM gl_accounts");
  const byCode = {};
  const byId = {};
  allForLookup.forEach(r => { byCode[String(r.code)] = r; byId[r.id] = r; });
  for (const acc of allRows) {
    const code = String(acc.code || '');
    if (!code) continue;
    // Find longest existing strict-prefix code
    let preferred = null;
    for (let len = code.length - 1; len >= 1; len--) {
      const cand = code.substring(0, len);
      if (byCode[cand] && byCode[cand].id !== acc.id) { preferred = byCode[cand]; break; }
    }
    if (!preferred) continue;  // no prefix-parent exists in chart
    if (acc.parent_id === preferred.id) continue; // already correct
    try {
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [preferred.id, acc.id]);
      fixed++;
    } catch (_e) { /* tolerate FK or other errors; deeper repair step will retry */ }
  }
  return fixed;
}

// Promote dangling-parent orphans to roots, then re-derive every level from
// the actual tree. Two behaviour changes, both deliberate:
//
//   • an orphan promoted to a root gets level **1**, not 0. It IS a root once
//     its dangling parent_id is cleared, and a root is level 1 everywhere else
//     in the system. Writing 0 here is what seeded the whole 0-vs-1 mess.
//   • levels come from lib/coa/tree.js `recomputeLevels`, the same walk the
//     trial balance uses, so `diagnostics.levelMismatches` can finally reach
//     empty instead of listing the entire chart after every repair.
async function _coaAutoFixLevels(db) {
  const [orphans] = await db.query(
    `SELECT a.id FROM gl_accounts a
      WHERE a.parent_id IS NOT NULL
        AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
  for (const o of orphans) {
    await db.query('UPDATE gl_accounts SET parent_id = NULL WHERE id = ?', [o.id]);
  }
  const { updated } = await coaTree.recomputeLevels(db);
  return { orphansPromoted: orphans.length, levelsCorrected: updated };
}

// v5.10.43 — defense in depth: even if the boot migration failed, this
// runs at the end of every deep-repair and re-enforces is_folder=1 for
// the 5 main roots and any account that has children. Manual folder
// promotions (is_folder=1 with no children) are preserved.
async function _coaForceFolderConsistency(db) {
  const fixed = { roots: 0, parents: 0 };
  try {
    const [r1] = await db.query("UPDATE gl_accounts SET is_folder = 1 WHERE code IN ('1','2','3','4','5') AND (is_folder = 0 OR is_folder IS NULL)");
    fixed.roots = r1.affectedRows || 0;
  } catch (e) {
    console.error('[deep-repair] _coaForceFolderConsistency roots failed:', e.message);
  }
  try {
    const [parents] = await db.query("SELECT DISTINCT parent_id AS pid FROM gl_accounts WHERE parent_id IS NOT NULL");
    const ids = parents.map(p => p.pid).filter(Boolean);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const [r2] = await db.query(`UPDATE gl_accounts SET is_folder = 1 WHERE id IN (${ph}) AND (is_folder = 0 OR is_folder IS NULL)`, ids);
      fixed.parents = r2.affectedRows || 0;
    }
  } catch (e) {
    console.error('[deep-repair] _coaForceFolderConsistency parents failed:', e.message);
  }
  return fixed;
}

// Rebuild gl_accounts.balance from posted gl_entries — the only safe way
// to guarantee tree balances match the journal.
async function _coaRecomputeBalances(db) {
  await db.query('UPDATE gl_accounts SET balance = 0');
  const [agg] = await db.query(
    `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
      WHERE j.status = 'posted' AND e.account_id IS NOT NULL
      GROUP BY e.account_id`);
  for (const a of agg) {
    const net = (Number(a.d) || 0) - (Number(a.c) || 0);
    await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, a.account_id]);
  }
  return agg.length;
}

// POST /gl/deep-repair — single-shot atomic chart-of-accounts repair.
// v5.10.43 — every step now logs to server console so silent failures
// become visible. If a step throws, the transaction rolls back and the
// HTTP response includes the actual error message + the step that failed.
router.post('/gl/deep-repair', requireCapability('finance.accounts.manage'), async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'LEGACY_COA_REPAIR_RETIRED',
    error: 'تم إيقاف الإصلاح العميق القديم لأنه يعيد تصنيف الحسابات آليًا.'
  });
  let lastStep = 'init';
  try {
    const result = await db.withTransaction(async (conn) => {
      console.log('[deep-repair] ========== START ==========');

      lastStep = 'snapshot-before';
      const before = await _coaDiagnoseSnapshot(conn);
      console.log('[deep-repair] step 0: before snapshot — issues:', JSON.stringify(before));

      lastStep = 'ensureCoreAccounts';
      try { await ensureCoreAccounts(conn); } catch(e) { console.error('[deep-repair] ensureCoreAccounts:', e.message); }
      console.log('[deep-repair] step 1: ensureCoreAccounts done');

      lastStep = 'fixRootsAndOrphansByPrefix';
      const treeFixed = await _coaFixRootsAndOrphansByPrefix(conn);
      console.log('[deep-repair] step 2: fixRootsAndOrphansByPrefix → ' + treeFixed + ' rows touched');

      lastStep = 'fixRootCodeMismatch';
      const rootFixesResult = await _coaFixRootCodeMismatch(conn);
      console.log('[deep-repair] step 3: fixRootCodeMismatch → fixed=' + rootFixesResult.fixed.length + ' skipped=' + rootFixesResult.skipped.length + ' failed=' + rootFixesResult.failed.length);

      lastStep = 'repairByKeywords';
      const reclass = await _coaRepairByKeywords(conn);
      console.log('[deep-repair] step 4: repairByKeywords → ' + (reclass.repaired ? reclass.repaired.length : 0) + ' reclassified, ' + (reclass.skipped ? reclass.skipped.length : 0) + ' skipped');

      lastStep = 'alignTypeWithParent';
      const typeFixes = await _coaAlignTypeWithParent(conn);
      console.log('[deep-repair] step 5: alignTypeWithParent → ' + (typeFixes ? typeFixes.length : 0) + ' types corrected');

      lastStep = 'recomputeBalances';
      const balRecomp = await _coaRecomputeBalances(conn);
      console.log('[deep-repair] step 6: recomputeBalances → ' + balRecomp + ' balances rebuilt from gl_entries');

      // v5.10.44 — last-resort topology guarantee. If any account is still
      // in the wrong root subtree after the smart helpers, force-reparent
      // it directly under the correct root. Better flat-but-correct than
      // hierarchical-but-wrong.
      lastStep = 'bruteForceTopology';
      const brute = await _coaBruteForceRootTopology(conn);
      console.log('[deep-repair] step 7: bruteForceTopology → ' + brute.moved.length + ' force-reparented, missingRoots=[' + (brute.missingRoots || []).join(',') + ']');

      lastStep = 'forceFolderConsistency';
      const folderFixes = await _coaForceFolderConsistency(conn);
      console.log('[deep-repair] step 8: forceFolderConsistency → roots=' + folderFixes.roots + ' parents=' + folderFixes.parents);

      // ── LEVELS LAST. This ordering is the fix, not a tidy-up. ──
      // `autoFixLevels` used to run BEFORE `bruteForceTopology`, which
      // re-parents accounts — so every level it had just computed was stale the
      // moment the transaction committed. Combined with the old 0-based depth
      // helper, one click on "deep repair" left the entire chart one level off
      // and made the trial balance render «غير سليم». Derive depth only after
      // the last step that can move a node.
      lastStep = 'autoFixLevels';
      const lvl = await _coaAutoFixLevels(conn);
      console.log('[deep-repair] step 9: autoFixLevels → ' + lvl.orphansPromoted + ' orphans promoted, ' + lvl.levelsCorrected + ' levels corrected (1-based)');

      // v5.10.44 — final independent verification: walk every account's
      // parent chain and list any whose reachable root still doesn't
      // match its code prefix. This is the truth surfaced to the user.
      lastStep = 'verifyTopology';
      const [verifyAccs] = await conn.query('SELECT id, code, parent_id, name_ar FROM gl_accounts');
      const _byIdV = {}; verifyAccs.forEach(a => { _byIdV[a.id] = a; });
      function _walkRootV(a) {
        let w = a, hops = 0; const seen = new Set();
        while (w && w.parent_id) {
          if (seen.has(w.id)) return null;
          seen.add(w.id);
          w = _byIdV[w.parent_id] || null;
          if (++hops > 50) return null;
        }
        return w ? String(w.code || '') : null;
      }
      const stillMisplaced = [];
      for (const a of verifyAccs) {
        const code = String(a.code || '');
        if (!code) continue;
        const expected = code.charAt(0);
        if (['1','2','3','4','5'].indexOf(expected) < 0) continue;
        if (code === expected) continue;
        const actual = _walkRootV(a);
        if (actual && actual !== expected) {
          stillMisplaced.push({ code: a.code, name: a.name_ar, expected, actual });
        } else if (!actual) {
          stillMisplaced.push({ code: a.code, name: a.name_ar, expected, actual: 'orphan-or-cycle' });
        }
      }
      console.log('[deep-repair] FINAL VERIFICATION: ' + stillMisplaced.length + ' accounts still in wrong root');
      if (stillMisplaced.length) console.log(JSON.stringify(stillMisplaced));

      lastStep = 'snapshot-after';
      const after = await _coaDiagnoseSnapshot(conn);
      console.log('[deep-repair] step 9: after snapshot — issues:', JSON.stringify(after));

      console.log('[deep-repair] ========== COMMIT ==========');
      return {
        before, after,
        reclassified: reclass.repaired,
        skipped: reclass.skipped,
        typeFixed: typeFixes,
        rootFixed: rootFixesResult.fixed,
        rootFixSkipped: rootFixesResult.skipped,           // v5.10.44
        rootFixFailed: rootFixesResult.failed,             // v5.10.44
        bruteForcedTopology: brute.moved,                  // v5.10.44
        bruteForcedFailed: brute.failed,                   // v5.10.44
        missingRoots: brute.missingRoots || [],            // v5.10.44
        folderFixed: folderFixes,                          // v5.10.43
        treeFixed,
        orphansPromoted: lvl.orphansPromoted,
        levelsCorrected: lvl.levelsCorrected,
        balancesRecomputed: balRecomp,
        stillMisplaced                                     // v5.10.44 — TRUTH
      };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[deep-repair] ROLLBACK at step "' + lastStep + '":', e.message, e.stack);
    res.status(500).json({ success: false, error: e.message, failedStep: lastStep });
  }
});

// ─── GL Journals ───

router.get('/gl/journals', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    // v5.11.0 — JOIN brands/branches/projects/cost_centers so the list
    // can render dimension chips with human-readable names without an
    // extra round-trip per row. Filters by date, status, ref type, search,
    // AND every dimension. Soft-deleted rows are excluded.
    let query = `
      SELECT j.*,
             b.name  AS brand_name,
             br.name AS branch_name,
             p.name_ar AS project_name,
             cc.name AS cc_name
        FROM gl_journals j
        LEFT JOIN brands       b  ON b.id  = j.brand_id
        LEFT JOIN branches     br ON br.id = j.branch_id
        LEFT JOIN projects     p  ON p.id  = j.project_id
        LEFT JOIN cost_centers cc ON cc.id = j.cost_center_id
       WHERE 1=1`;
    const params = [];

    if (req.query.startDate)     { query += ' AND j.journal_date >= ?';   params.push(req.query.startDate); }
    if (req.query.endDate)       { query += ' AND j.journal_date <= ?';   params.push(req.query.endDate); }
    if (req.query.referenceType) { query += ' AND j.reference_type = ?';  params.push(req.query.referenceType); }
    if (req.query.status)        { query += ' AND j.status = ?';          params.push(req.query.status); }
    if (req.query.brandId)       { query += ' AND j.brand_id = ?';        params.push(req.query.brandId); }
    if (req.query.branchId)      { query += ' AND j.branch_id = ?';       params.push(req.query.branchId); }
    if (req.query.projectId)     { query += ' AND j.project_id = ?';      params.push(req.query.projectId); }
    if (req.query.costCenterId)  { query += ' AND j.cost_center_id = ?';  params.push(req.query.costCenterId); }
    if (req.query.q) {
      query += ' AND (j.description LIKE ? OR j.journal_number LIKE ? OR j.reference_id LIKE ?)';
      const t = '%' + req.query.q + '%'; params.push(t, t, t);
    }
    // Soft-delete filter is best-effort: column was added in v5.10.x;
    // the OR keeps legacy rows that predate the column visible.
    query += ' AND (j.deleted_at IS NULL OR j.deleted_at = 0)';
    query += ' ORDER BY j.journal_date DESC, j.created_at DESC LIMIT 500';

    const [journals] = await db.query(query, params);
    const result = [];

    // V5.7.18 — JOIN gl_accounts to ALWAYS surface the human-readable name,
    //           even for OLD entries written before glPosting started
    //           persisting account_name. Falls back gracefully:
    //             COALESCE(persisted_name, joined_name_ar, joined_name_en, code)
    for (const j of journals) {
      const [entries] = await db.query(
        `SELECT
            e.id, e.account_id, e.account_code, e.account_name AS persisted_name,
            e.debit, e.credit, e.description,
            e.branch_id, e.brand_id, e.cost_center_id, e.warehouse_id, e.project_id,
            ga.name_ar AS gl_name_ar, ga.name_en AS gl_name_en, ga.type AS gl_type
         FROM gl_entries e
         LEFT JOIN gl_accounts ga ON ga.id = e.account_id
         WHERE e.journal_id = ?
         ORDER BY e.id`,
        [j.id]
      );
      result.push({
        id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
        referenceType: j.reference_type, referenceId: j.reference_id,
        description: j.description, notes: j.notes || '',
        totalDebit: Number(j.total_debit), totalCredit: Number(j.total_credit),
        periodId: j.period_id, status: j.status,
        createdBy: j.created_by || '', approvedBy: j.approved_by || '', postedBy: j.posted_by || '',
        approvedAt: j.approved_at, postedAt: j.posted_at,
        attachment: j.attachment || '',
        // v5.11.0 — header dimensions surfaced for chip rendering
        brandId: j.brand_id || '', branchId: j.branch_id || '',
        projectId: j.project_id || '', costCenterId: j.cost_center_id || '',
        brandName: j.brand_name || '', branchName: j.branch_name || '',
        projectName: j.project_name || '', costCenterName: j.cc_name || j.cost_center_name || '',
        createdAt: j.created_at,
        // v6.4.2 — reversing-entry linkage (immutability via correction)
        //   reversedByJournalId: id of the reversal that nullified this
        //                        journal (set on the original).
        //   reversesJournalId:   id of the original this journal nullifies
        //                        (set on the reversal).
        // Null-safe — older deployments without these columns return null.
        reversedByJournalId: j.reversed_by_journal_id || null,
        reversesJournalId:   j.reverses_journal_id    || null,
        reversedAt:          j.reversed_at            || null,
        reversedBy:          j.reversed_by            || null,
        entries: entries.map(e => {
          // Resolve display name: persisted (V5.7.18+) → joined Arabic →
          //                       joined English → fallback to code
          const resolvedName = e.persisted_name && e.persisted_name.trim()
            ? e.persisted_name
            : (e.gl_name_ar || e.gl_name_en || e.account_code || '');
          return {
            id: e.id,
            accountId: e.account_id,
            accountCode: e.account_code,
            accountName: resolvedName,
            accountType: e.gl_type || '',
            debit: Number(e.debit),
            credit: Number(e.credit),
            description: e.description,
            branchId: e.branch_id,
            brandId: e.brand_id,
            projectId: e.project_id,
            costCenterId: e.cost_center_id,
            warehouseId: e.warehouse_id
          };
        })
      });
    }

    res.json(result);
  } catch (e) {
    // v7.5 — was res.json([]): a DB fault rendered as "no journals".
    console.error('[erp/gl/journals] list failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل القيود' });
  }
});

// Create journal entry (status: draft — no balance update until posted)
router.post('/gl/journals', requireCapability('finance.gl.create'), async (req, res) => {
  try {
    // v5.11.0 — accept all four accounting dimensions on the header.
    // Each entry inherits the header dim unless it explicitly overrides.
    const {
      journalDate, referenceType, referenceId, description, entries, username,
      attachment, notes, isOpening,
      brandId, branchId, projectId, costCenterId, costCenterName
    } = req.body;
    // FC-P1 — actor from JWT, never a body field.
    const actor = _actor(req);
    void username;
    const actualRefType = isOpening ? 'opening' : (referenceType || 'manual');
    const journalId = 'JRN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); // FC-B1 unique under concurrency (Date.now() alone collided same-ms)

    let totalDebit = 0, totalCredit = 0;
    if (entries && entries.length) {
      for (const entry of entries) {
        totalDebit += Number(entry.debit) || 0;
        totalCredit += Number(entry.credit) || 0;
      }
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.json({ success: false, error: 'القيد غير متوازن (مدين ≠ دائن)' });
    }
    // v5.11.0 — BR-1 reinforced: at least 2 entries
    if (!entries || entries.length < 2) {
      return res.json({ success: false, error: 'القيد يَجب أن يَحوي سطرين على الأقل' });
    }
    // FC-P1 — every posting line must hit an existing, active, LEAF account.
    const lineErr = await _validateJournalLines(db, entries);
    if (lineErr) return res.status(400).json({ success: false, error: lineErr });
    // FC-P1 — attachment must be an inline image/PDF ≤ 5MB.
    const attErr = _validateAttachment(attachment);
    if (attErr) return res.status(400).json({ success: false, error: attErr });
    // v5.11.0 — BR-4: project must belong to the same brand if both set
    if (brandId && projectId) {
      const [proj] = await db.query('SELECT brand_id FROM projects WHERE id = ?', [projectId]).catch(() => [[]]);
      if (proj && proj.length && proj[0].brand_id && proj[0].brand_id !== brandId) {
        return res.json({ success: false, error: 'المشروع المُختار يَتبع براندًا مختلفًا' });
      }
    }

    // FC-P1 — header + entries written atomically (no partial-write window); the
    // journal number is derived inside the txn and guarded by uq_journal_number.
    // FC-B1 — atomic global journal number (replaces `ORDER BY created_at DESC`
    // + parse + 1, which raced on the 1s-resolution created_at and mis-parsed
    // the coexisting dated form). Allocated in its own committed seq txn;
    // uq_journal_number is the absolute guard.
    const journalNumber = await nextFlatJournalNumber();
    await db.withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO gl_journals
           (id, journal_number, journal_date, reference_type, reference_id,
            description, total_debit, total_credit, status, created_by,
            attachment, notes,
            cost_center_id, cost_center_name,
            brand_id, branch_id, project_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [journalId, journalNumber, journalDate || new Date(), actualRefType, referenceId || '',
         description || '', totalDebit, totalCredit, 'draft', actor,
         attachment || null, notes || '',
         costCenterId || null, costCenterName || '',
         brandId || null, branchId || null, projectId || null]
      );

      let seq = 0;
      for (const entry of (entries || [])) {
        const entryId = 'GLE-' + Date.now() + '-' + (seq++) + '-' + Math.random().toString(36).substr(2, 4);
        await conn.query(
          `INSERT INTO gl_entries
             (id, journal_id, account_id, account_code, account_name,
              debit, credit, description,
              cost_center_id, brand_id, branch_id, project_id, warehouse_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [entryId, journalId, entry.accountId || null, entry.accountCode || '',
           entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '',
           // BR-3 inheritance: line value wins, header is the fallback.
           (entry.costCenterId != null && entry.costCenterId !== '') ? entry.costCenterId : (costCenterId || null),
           (entry.brandId    != null && entry.brandId    !== '') ? entry.brandId    : (brandId    || null),
           (entry.branchId   != null && entry.branchId   !== '') ? entry.branchId   : (branchId   || null),
           (entry.projectId  != null && entry.projectId  !== '') ? entry.projectId  : (projectId  || null),
           entry.warehouseId || null]
        );
      }
    });

    // Audit log — payload now includes the dimensions for full traceability
    await logAudit('create_journal', 'gl_journal', journalId, actor,
      { journalNumber, totalDebit, totalCredit, description,
        brandId: brandId || null, branchId: branchId || null,
        projectId: projectId || null, costCenterId: costCenterId || null },
      req.ip);

    // Note: balances NOT updated yet — only on "post"
    res.json({ success: true, id: journalId, journalNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve journal (draft → approved)
// Tier A.2 corrective gate — delegates to lib/glTransitions.js#approve, which
// is what actually closes the maker/checker gap on this exact route: this is
// the FIRST call frontend/erp's usePostJournal() makes (see JournalList.tsx/
// JournalEditor.tsx's "ترحيل"/"حفظ وترحيل" buttons), and before this fix it
// had no self-approval check at all — only the (frontend-unreachable) bulk
// endpoint did. Response envelope ({success,error}, implicit 200 on a
// business-rule denial) is unchanged so existing frontend error handling
// (usePostJournal throwing on success:false) keeps working; `code` is a new,
// additive field for callers that want it.
router.post('/gl/journals/:id/approve', requireCapability('finance.gl.approve'), async (req, res) => {
  const glTransitions = require('../lib/glTransitions');
  try {
    const out = await glTransitions.approve(req.params.id, req.user, { ip: req.ip });
    if (!out.ok) return res.json({ success: false, error: out.message, code: out.code });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// V5.10.0 — Accounting periods: list / create / open / close / soft-close.
// The schema already exists (server.js:2382). These endpoints expose it.
// v4 SECURITY — the /periods routes carried NO capability guard while their
// /gl/* neighbours did, so closing (or force-reopening) a financial period —
// which generates and reverses closing journal entries — was reachable with any
// valid token, including a cashier's.
// v4 BUGFIX — this SELECT named `company_id` and `notes`, and accounting_periods
// has NEITHER (its columns are period_label/closing_notes, with brand_id and
// branch_id for scope). Every call threw ER_BAD_FIELD_ERROR straight into the
// bare `catch` below, which answered `[]` — so the periods screen reported "لا
// توجد فترات" on a table holding 12 real rows, and the failure was invisible.
// The catch no longer lies: a real DB fault is now a 500, not a silent empty list.
router.get('/periods', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, period_name, period_label, start_date, end_date, status,
              brand_id, branch_id, closed_by, closed_at, closing_notes
       FROM accounting_periods
       ORDER BY start_date DESC LIMIT 200`);
    res.json(rows.map(r => ({
      id: r.id,
      // period_name was added later and is nullable; period_label is the older
      // NOT NULL column. Prefer the friendly name, fall back to the label.
      periodName: r.period_name || r.period_label || '',
      startDate: r.start_date, endDate: r.end_date,
      // The enum carries BOTH 'soft_close' and 'soft_closed' from an old
      // migration. Normalise so the client has one spelling to handle.
      status: r.status === 'soft_close' ? 'soft_closed' : r.status,
      brandId: r.brand_id || null, branchId: r.branch_id || null,
      closedBy: r.closed_by || '', closedAt: r.closed_at,
      notes: r.closing_notes || ''
    })));
  } catch (e) {
    console.error('[erp/periods] list failed:', e.code || e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل الفترات المحاسبية' });
  }
});

// v4 BUGFIX — same schema mismatch as the GET: this wrote `company_id` and
// `notes`, which do not exist on accounting_periods, so creating a period was
// IMPOSSIBLE — every attempt threw and surfaced as a raw SQL string in a toast.
// period_label is the older NOT NULL column and must be populated; both it and
// period_name are VARCHAR(20), so the name is validated rather than truncated
// silently into something the owner didn't type.
router.post('/periods', requireCapability('finance.periods.manage'), async (req, res) => {
  try {
    const { id, periodName, startDate, endDate, notes } = req.body || {};
    if (!periodName || !startDate || !endDate) return res.json({ success:false, error: 'الاسم والتواريخ مطلوبة' });
    const name = String(periodName).trim();
    if (name.length > 20) return res.json({ success:false, error: 'اسم الفترة يجب ألا يتجاوز 20 حرفًا' });
    if (String(endDate) < String(startDate)) {
      return res.json({ success:false, error: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    }
    if (id) {
      await db.query(
        `UPDATE accounting_periods SET period_name=?, period_label=?, start_date=?, end_date=?, closing_notes=? WHERE id=?`,
        [name, name, startDate, endDate, notes || null, id]);
      return res.json({ success:true, id });
    }
    const newId = 'PER-' + Date.now();
    await db.query(
      `INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status, closing_notes)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      [newId, name, name, startDate, endDate, notes || null]);
    res.json({ success:true, id:newId });
  } catch (e) {
    console.error('[erp/periods] save failed:', e.code || e.message);
    // Never echo a raw SQL error to the browser.
    res.json({ success:false, error:'تعذّر حفظ الفترة المحاسبية' });
  }
});

// Lock / unlock a period. status ∈ {open, soft_closed, closed}.
//
// v5.10.61 — When status transitions to 'closed' for the first time, an
// AUTOMATIC closing journal entry is generated:
//   • Dr each Revenue account at its period-end balance  →  zeroes it out
//   • Cr account 321 (Retained Earnings) by the sum      →  parks the income
//   • Dr account 321 by the total expense                →  reduces RE by it
//   • Cr each Expense account at its period-end balance  →  zeroes them out
//
// Net effect: Revenue & Expense accounts return to zero (ready for the next
// period), Retained Earnings (321) gains net income. This matches IFRS
// closing-entry mechanics. Idempotent — won't double-close. Reopening
// generates a REVERSE journal that undoes the closing without deleting it.
router.post('/periods/:id/lock', requireCapability('finance.periods.manage'), async (req, res) => {
  try {
    const { status } = req.body || {};
    // v4 SECURITY — the actor stamped on closed_by and on the generated/reversed
    // closing entries comes from the VERIFIED token, never from the request body.
    // It used to be read from req.body.username, so any caller could attribute a
    // period close to someone else on an audit field.
    const username = (req.user && req.user.username) || '';
    if (!['open','soft_closed','closed'].includes(status)) {
      return res.json({ success:false, error:'الحالة غير صالحة' });
    }
    const [p] = await db.query('SELECT * FROM accounting_periods WHERE id=?', [req.params.id]);
    if (!p.length) return res.json({ success:false, error:'الفترة غير موجودة' });
    const period = p[0];
    let closeTransitionCommitted = false;

    // ── «ترحيل المبيعات» guard ────────────────────────────────────────────
    // The SECOND close implementation. routes/erp/periods.js carries the same
    // guard; putting it on only one makes the bypass a matter of knowing which
    // URL to call.
    //
    // Sealing a period whose sales have not reached the ledger produces a
    // trial balance that looks finished and is wrong. Only on a real close —
    // `soft_closed` is a review state, and reopening must never be blocked.
    if (status === 'closed' && period.status !== 'closed') {
      const wantsForce = req.body && req.body.force === true;
      const reason = String((req.body && req.body.reason) || '').trim();
      const mayOverride = wantsForce
        ? await requireCapability.hasCapability(req.user, 'finance.periods.override_lock').catch(() => false)
        : false;
      const salesPosting = require('./erp/sales-posting');
      try {
        await db.withTransaction(async (conn) => {
        const [[lockedPeriod]] = await conn.query(
          'SELECT * FROM accounting_periods WHERE id=? FOR UPDATE', [req.params.id]);
        if (!lockedPeriod) { const e = new Error('period not found'); e.status = 404; throw e; }
        await salesPosting.assertNoUnpostedSales(conn, {
          from: period.start_date, to: period.end_date,
          brandId: period.brand_id, branchId: period.branch_id });
        await conn.query('UPDATE accounting_periods SET status=?, closed_by=?, closed_at=NOW() WHERE id=?',
          [status, username || '', req.params.id]);
        });
        closeTransitionCommitted = true;
      } catch (guardErr) {
        if (guardErr && guardErr.code === 'UNPOSTED_SALES_IN_PERIOD') {
          if (!wantsForce || !mayOverride || reason.length < 10) {
            return res.status(409).json({
              success: false, error: 'UNPOSTED_SALES_IN_PERIOD',
              message: guardErr.message,
              unpostedCount: guardErr.unpostedCount,
              firstDay: guardErr.firstDay, lastDay: guardErr.lastDay,
              link: '/accounting/sales-posting?from=' + (guardErr.firstDay || '') +
                    '&to=' + (guardErr.lastDay || ''),
              overrideRequires: 'force=true + finance.periods.override_lock + reason (10+ chars)',
            });
          }
          const stranded = await db.withTransaction(async (conn) => {
            await conn.query('SELECT id FROM accounting_periods WHERE id=? FOR UPDATE', [req.params.id]);
            const n = await salesPosting.strandUnposted(conn, {
              from: period.start_date, to: period.end_date,
              brandId: period.brand_id, branchId: period.branch_id });
            await conn.query('UPDATE accounting_periods SET status=?, closed_by=?, closed_at=NOW() WHERE id=?',
              [status, username || '', req.params.id]);
            return n;
          });
          closeTransitionCommitted = true;
          console.warn('[period.lock] FORCED close of ' + req.params.id + ' by ' + username +
            ' — ' + stranded + ' sale(s) marked stranded · reason: ' + reason);
        } else { throw guardErr; }
      }
    }

    if (period.status === 'closed' && status !== 'closed') {
      // Re-opening a hard-closed period requires a force flag (audit safety).
      if (!req.body || req.body.force !== true) {
        return res.json({ success:false, error:'الفترة مُقفلة نهائياً — يلزم force=true لإعادة فتحها' });
      }
    }

    let closingResult = null;     // populated when we generate / reverse closing entries
    if (status === 'open') {
      // v5.10.61 — Re-opening: reverse any prior closing entry for this period
      // (audit-safe: we don't delete the original, we post an offsetting JE).
      if (period.status === 'closed') {
        try {
          closingResult = await _reverseClosingEntries(req.params.id, username || '');
        } catch (e) {
          console.error('[period.lock] reverseClosingEntries failed:', e.message);
          // Don't block the reopen — the user can still post manual reversals.
        }
      }
      await db.withTransaction(async (conn) => {
        await conn.query('SELECT id FROM accounting_periods WHERE id=? FOR UPDATE', [req.params.id]);
        await conn.query('UPDATE accounting_periods SET status=?, closed_by=NULL, closed_at=NULL WHERE id=?',
          [status, req.params.id]);
        await require('./erp/sales-posting').recoverStranded(conn, {
          from: period.start_date, to: period.end_date,
          brandId: period.brand_id, branchId: period.branch_id });
      });
    } else {
      if (!closeTransitionCommitted) {
        await db.query('UPDATE accounting_periods SET status=?, closed_by=?, closed_at=NOW() WHERE id=?',
          [status, username||'', req.params.id]);
      }
      // v5.10.61 — Generate closing entries only on the open→closed transition
      // (NOT on open→soft_closed; soft-close is a review state, not a final).
      if (status === 'closed' && period.status !== 'closed') {
        try {
          closingResult = await _generateClosingEntries(req.params.id, username || '');
        } catch (e) {
          console.error('[period.lock] generateClosingEntries failed:', e.message);
          // Leave the period closed — operator can re-run manually if needed.
          closingResult = { ok: false, error: e.message };
        }
      }
    }
    res.json({ success:true, closing: closingResult });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// v5.10.61 — Closing-entries automation helpers.
//
// On period close (status → 'closed'), we generate ONE atomic journal:
//   Lines: [Dr each revenue@balance] [Cr 321 @ Σrevenue]
//          [Dr 321 @ Σexpense]        [Cr each expense@balance]
//   Sum check: ΣDr = ΣCr (defensive — refuses to post if unbalanced).
//
// On reopen (status → 'open'), we generate a REVERSE journal that
// debits/credits the same accounts in the opposite direction, restoring
// the period balances exactly. The original closing entry stays in the
// ledger as an audit record.
// ─────────────────────────────────────────────────────────────────────
async function _generateClosingEntries(periodId, actorUsername) {
  // 1. Fetch period bounds
  const [pRows] = await db.query(
    'SELECT id, period_name, start_date, end_date FROM accounting_periods WHERE id = ?',
    [periodId]);
  if (!pRows.length) return { ok: false, reason: 'period-not-found' };
  const period = pRows[0];

  // 2. Idempotency — skip if a closing JE already exists for this period
  const closingJournalId = 'CLOSE-' + period.id;
  const [existing] = await db.query(
    'SELECT id FROM gl_journals WHERE id = ?', [closingJournalId]);
  if (existing.length) return { ok: true, skipped: true, journalId: closingJournalId };

  // 3. Find Retained Earnings account (321 → 32 → 3 fallback). MUST exist.
  const [reRows] = await db.query(
    "SELECT id FROM gl_accounts WHERE code IN ('321','32','3') ORDER BY CHAR_LENGTH(code) DESC LIMIT 1");
  if (!reRows.length) return { ok: false, reason: 'no-retained-earnings-account' };
  const retainedEarningsAccountId = reRows[0].id;

  // 4. Compute net for every revenue + expense account in the period
  const [accounts] = await db.query(
    `SELECT a.id, a.code, a.type,
            COALESCE(SUM(e.debit),  0) AS d,
            COALESCE(SUM(e.credit), 0) AS c
       FROM gl_accounts a
       LEFT JOIN gl_entries  e ON e.account_id = a.id
       LEFT JOIN gl_journals j ON j.id = e.journal_id
                                  AND j.status = 'posted'
                                  AND COALESCE(j.is_closing_entry, 0) = 0
                                  AND DATE(j.journal_date) BETWEEN ? AND ?
      WHERE a.is_active = 1 AND a.type IN ('revenue','expense')
      GROUP BY a.id, a.code, a.type
      HAVING ABS(d) + ABS(c) > 0.001`,
    [period.start_date, period.end_date]);

  if (!accounts.length) return { ok: true, skipped: true, reason: 'no-activity' };

  // 5. Build JE lines + tally totals
  const lines = [];     // { account_id, debit, credit }
  let sumRevenueCredit = 0;   // = Σ(credit - debit) for revenue (normal positive)
  let sumExpenseDebit  = 0;   // = Σ(debit  - credit) for expense (normal positive)

  for (const a of accounts) {
    const debit  = Number(a.d) || 0;
    const credit = Number(a.c) || 0;
    if (a.type === 'revenue') {
      // Revenue is credit-normal. To zero it out we DEBIT (credit - debit).
      const closingAmount = credit - debit;
      if (Math.abs(closingAmount) < 0.001) continue;
      if (closingAmount > 0) {
        lines.push({ account_id: a.id, debit: closingAmount, credit: 0 });
        sumRevenueCredit += closingAmount;
      } else {
        // Abnormal balance — credit instead
        lines.push({ account_id: a.id, debit: 0, credit: -closingAmount });
        sumRevenueCredit += closingAmount;  // negative
      }
    } else if (a.type === 'expense') {
      // Expense is debit-normal. To zero it out we CREDIT (debit - credit).
      const closingAmount = debit - credit;
      if (Math.abs(closingAmount) < 0.001) continue;
      if (closingAmount > 0) {
        lines.push({ account_id: a.id, debit: 0, credit: closingAmount });
        sumExpenseDebit += closingAmount;
      } else {
        lines.push({ account_id: a.id, debit: -closingAmount, credit: 0 });
        sumExpenseDebit += closingAmount;
      }
    }
  }

  // 6. Balancing line through Retained Earnings (321):
  //    Cr 321 by sumRevenueCredit  +  Dr 321 by sumExpenseDebit
  //    = net effect: RE += (revenue − expense) = net income
  const reNet = sumRevenueCredit - sumExpenseDebit;  // signed net income
  if (Math.abs(reNet) >= 0.001) {
    if (reNet > 0) lines.push({ account_id: retainedEarningsAccountId, debit: 0, credit:  reNet });
    else           lines.push({ account_id: retainedEarningsAccountId, debit: -reNet, credit: 0 });
  }

  // 7. Defensive balance check before posting
  const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return { ok: false, reason: 'unbalanced-closing-entry', totalDebit, totalCredit };
  }

  // 8. Insert journal + entries
  await db.query(
    `INSERT INTO gl_journals
       (id, journal_date, description, status, posted_by, posted_at,
        is_closing_entry, closing_period_id, reference_type)
     VALUES (?, ?, ?, 'posted', ?, NOW(), 1, ?, 'period_close')`,
    [closingJournalId, period.end_date,
     'قيد إغلاق فترة ' + (period.period_name || period.id), actorUsername || '',
     period.id]);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, debit, credit, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['CLOSE-' + period.id + '-' + (i + 1), closingJournalId,
       l.account_id, l.debit, l.credit, 'إغلاق دوري']);
  }

  return {
    ok: true, journalId: closingJournalId,
    linesPosted: lines.length, netIncome: reNet,
    totalDebit, totalCredit
  };
}

async function _reverseClosingEntries(periodId, actorUsername) {
  const closingJournalId = 'CLOSE-' + periodId;
  const reverseJournalId = 'REOPEN-CLOSE-' + periodId;

  // Idempotency on the reverse side too
  const [existingReverse] = await db.query(
    'SELECT id FROM gl_journals WHERE id = ?', [reverseJournalId]);
  if (existingReverse.length) return { ok: true, skipped: true, journalId: reverseJournalId };

  const [closingExists] = await db.query(
    'SELECT id, journal_date FROM gl_journals WHERE id = ?', [closingJournalId]);
  if (!closingExists.length) return { ok: true, skipped: true, reason: 'no-closing-to-reverse' };

  const [origLines] = await db.query(
    'SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ?',
    [closingJournalId]);
  if (!origLines.length) return { ok: true, skipped: true, reason: 'no-lines-to-reverse' };

  await db.query(
    `INSERT INTO gl_journals
       (id, journal_date, description, status, posted_by, posted_at,
        is_closing_entry, closing_period_id, reference_type)
     VALUES (?, CURDATE(), ?, 'posted', ?, NOW(), 1, ?, 'period_reopen')`,
    [reverseJournalId,
     'قيد عكسي لإعادة فتح الفترة (يعكس ' + closingJournalId + ')',
     actorUsername || '', periodId]);

  for (let i = 0; i < origLines.length; i++) {
    const l = origLines[i];
    // Flip debit/credit to reverse
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, debit, credit, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reverseJournalId + '-' + (i + 1), reverseJournalId,
       l.account_id, l.credit, l.debit, 'عكس قيد إغلاق']);
  }

  return { ok: true, journalId: reverseJournalId, linesReversed: origLines.length };
}
// Expose helpers so admin tooling / future migration scripts can call them
router._generateClosingEntries = _generateClosingEntries;
router._reverseClosingEntries  = _reverseClosingEntries;

// Post journal (approved → posted) — updates account balances.
// Tier A.2 corrective gate — delegates to lib/glTransitions.js#post, which
// replaces the local _checkPeriodOpen this route used to hand-roll (it only
// recognized 'closed'/'soft_closed', not the 'locked'/'soft_close' states
// lib/glPosting.js#isPeriodClosed already knew about, and honored `force`
// for ANY caller holding finance.gl.post — no distinct capability gated the
// override despite a comment implying an admin-only bypass). The unified
// service's checkPeriodOpen requires Admin/Developer or the new
// finance.periods.override_lock capability before `force` clears a
// soft-closed period.
router.post('/gl/journals/:id/post', requireCapability('finance.gl.post'), async (req, res) => {
  const glTransitions = require('../lib/glTransitions');
  try {
    const { force } = req.body || {};
    const out = await glTransitions.post(req.params.id, req.user, { force: !!force, ip: req.ip });
    if (!out.ok) {
      // Tier A.3 Release Gate item 2 — the self-post denial specifically
      // gets a real HTTP 403 (not this route's usual implicit-200
      // success:false, which every OTHER denial here keeps unchanged, to
      // avoid touching already-tested behavior for not-approved/already-
      // posted/period-lock).
      if (out.code === 'sod-self-post-denied') return res.status(403).json({ success: false, error: out.message, code: out.code });
      return res.json({ success: false, error: out.message, code: out.code });
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Unpost journal — DISABLED (FC-P1). SOCPA/IFRS require posted journals to stay
// immutable; the only accepted correction is a reversing entry. Kept as a 409
// stub so any legacy caller gets a clear, auditable refusal instead of mutating
// the ledger.
router.post('/gl/journals/:id/unpost', requireCapability('finance.gl.post'), async (req, res) => {
  return res.status(409).json({
    success: false,
    code: 'posted-immutable',
    error: 'القيد المُرحَّل لا يُلغى ترحيله — أنشئ قيدًا عكسيًا للتصحيح.'
  });
});

// ─── v6.4.2 — Reversing Entry endpoint ──────────────────────────────
// SOCPA + IFRS require that posted journals stay immutable. The only
// accepted way to correct a posted journal is to issue a NEW journal
// with debits + credits swapped — a "reversing entry" — that offsets
// the original on the GL while keeping both rows in the audit trail.
//
// This endpoint does everything atomically inside one transaction:
//   1. Lock the original posted journal (SELECT … FOR UPDATE).
//   2. Refuse if not posted or if already reversed.
//   3. Load gl_entries, build a mirrored set with debit ↔ credit
//      swapped, preserving every dimension column.
//   4. Use lib/glPosting.postJournal to create + auto-post the new
//      journal (referenceType='reversal', referenceId=<original.id>).
//   5. Stamp the linking columns on both rows so the UI can hide the
//      Reverse button on already-reversed journals.
// Tier A.2 corrective gate — delegates to lib/glTransitions.js#reverse, which
// already routed through lib/glPosting.js#postJournal before this file
// existed (the one transition that already had correct period-lock
// behavior). Centralized here purely for a single call surface alongside
// approve/post/delete — its internals are unchanged from the inline version
// this replaces. Response contract preserved exactly: same status codes per
// failure code (not_found→404, only_posted_can_be_reversed→400,
// already_reversed→400, no_entries→400, reversal_post_failed→500), same
// success body shape.
router.post('/gl/journals/:id/reverse', requireCapability('finance.gl.reverse'), async (req, res) => {
  const glTransitions = require('../lib/glTransitions');
  try {
    const out = await glTransitions.reverse(req.params.id, req.user, {
      reason: req.body && req.body.reason,
      ip: req.ip,
    });
    if (!out.ok) {
      return res.status(out.status || 500).json({ success: false, error: out.message, code: out.code });
    }
    const { ok, audit, ...result } = out; // strip internal fields — keep the response shape identical to before
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get entries for a specific journal
router.get('/gl/journals/:id/entries', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    const [entries] = await db.query('SELECT * FROM gl_entries WHERE journal_id = ? ORDER BY id', [req.params.id]);
    res.json(entries.map(e => ({
      id: e.id, accountId: e.account_id, accountCode: e.account_code,
      accountName: e.account_name, debit: Number(e.debit), credit: Number(e.credit),
      description: e.description
    })));
  } catch (e) {
    // v7.5 — was res.json([]): a fault read as "this journal has no lines".
    console.error('[erp/gl/journals/:id/entries] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل سطور القيد' });
  }
});

// v5.17.2 — /reports/gl-ledger-multi moved to routes/erp/reports/gl-ledger.js


// Update journal — edit draft / approved / posted journal entries.
// v7.0 — posted journals are now editable in place: the OLD lines' impact on
// gl_accounts.balance is reversed and the NEW lines' impact re-applied inside
// one transaction, so balances stay correct and the journal keeps its
// 'posted' status (net change per account = newNet − oldNet). Automatic
// (sale/purchase/custody/…) journals are editable too — note this does NOT
// touch the source document, so the ledger may diverge from it; the frontend
// warns before proceeding. Both cases are audit-logged. The fully
// IAS/SOCPA-compliant alternative remains the reversing entry
// (POST /gl/journals/:id/reverse), still offered in the UI.
router.put('/gl/journals/:id', requireCapability('finance.gl.create'), async (req, res) => {
  try {
    const journalId = req.params.id;
    const actor = _actor(req); // FC-P1 — actor from JWT
    // v5.11.0 — accept all four header dimensions on edit too.
    const {
      journalDate, description, notes, entries,
      brandId, branchId, projectId, costCenterId, costCenterName, attachment
    } = req.body;

    // Validate balance
    let totalDebit = 0, totalCredit = 0;
    (entries || []).forEach(e => { totalDebit += Number(e.debit) || 0; totalCredit += Number(e.credit) || 0; });
    if (Math.abs(totalDebit - totalCredit) > 0.01) return res.json({ success: false, error: 'القيد غير متوازن' });
    if (!entries || entries.length < 2) return res.json({ success: false, error: 'القيد يَجب أن يَحوي سطرين على الأقل' });
    // FC-P1 — line + attachment validation (same rules as create).
    const lineErr = await _validateJournalLines(db, entries);
    if (lineErr) return res.status(400).json({ success: false, error: lineErr });
    const attErr = _validateAttachment(attachment);
    if (attErr) return res.status(400).json({ success: false, error: attErr });

    // BR-4: project must belong to the same brand
    if (brandId && projectId) {
      const [proj] = await db.query('SELECT brand_id FROM projects WHERE id = ?', [projectId]).catch(() => [[]]);
      if (proj && proj.length && proj[0].brand_id && proj[0].brand_id !== brandId) {
        return res.json({ success: false, error: 'المشروع المُختار يَتبع براندًا مختلفًا' });
      }
    }

    // FC-P1 — the whole edit runs under the journal-row lock. Posted journals
    // are IMMUTABLE (SOCPA/IFRS): editing one is refused with 409; the only
    // correction is a reversing entry. This replaces the old in-place
    // reverse-and-reapply behaviour.
    const out = await db.withTransaction(async (conn) => {
      const [jrnRows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
      if (!jrnRows.length) return { status: 404, error: 'القيد غير موجود' };
      const jrn = jrnRows[0];
      if (jrn.status === 'posted') {
        return { status: 409, code: 'posted-immutable', error: 'القيد المُرحَّل لا يُعدَّل — أنشئ قيدًا عكسيًا للتصحيح.' };
      }

      // Effective header dims: incoming value if defined, else preserve existing
      const effBrand   = brandId    !== undefined ? (brandId    || null) : jrn.brand_id;
      const effBranch  = branchId   !== undefined ? (branchId   || null) : jrn.branch_id;
      const effProject = projectId  !== undefined ? (projectId  || null) : jrn.project_id;
      const effCC      = costCenterId    !== undefined ? (costCenterId    || null) : jrn.cost_center_id;
      const effCCName  = costCenterName  !== undefined ? (costCenterName  || '')   : jrn.cost_center_name;
      const effAttachment = attachment !== undefined ? (attachment || null) : jrn.attachment;

      await conn.query('DELETE FROM gl_entries WHERE journal_id = ?', [journalId]);
      await conn.query(
        `UPDATE gl_journals
            SET journal_date=?, description=?, notes=?,
                total_debit=?, total_credit=?,
                brand_id=?, branch_id=?, project_id=?,
                cost_center_id=?, cost_center_name=?, attachment=?
          WHERE id=?`,
        [journalDate || jrn.journal_date, description || jrn.description, notes || '',
         totalDebit, totalCredit,
         effBrand, effBranch, effProject, effCC, effCCName, effAttachment,
         journalId]
      );
      let seq = 0;
      for (const entry of (entries || [])) {
        const entryId = 'GLE-' + Date.now() + '-' + (seq++) + '-' + Math.random().toString(36).substr(2, 4);
        await conn.query(
          `INSERT INTO gl_entries
             (id, journal_id, account_id, account_code, account_name,
              debit, credit, description,
              cost_center_id, brand_id, branch_id, project_id, warehouse_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [entryId, journalId, entry.accountId || null, entry.accountCode || '',
           entry.accountName || '', entry.debit || 0, entry.credit || 0, entry.description || '',
           (entry.costCenterId != null && entry.costCenterId !== '') ? entry.costCenterId : (effCC      || null),
           (entry.brandId    != null && entry.brandId    !== '') ? entry.brandId    : (effBrand   || null),
           (entry.branchId   != null && entry.branchId   !== '') ? entry.branchId   : (effBranch  || null),
           (entry.projectId  != null && entry.projectId  !== '') ? entry.projectId  : (effProject || null),
           entry.warehouseId || null]
        );
      }
      return { ok: true, journalNumber: jrn.journal_number, effBrand, effBranch, effProject, effCC };
    });

    if (out.error) return res.status(out.status || 400).json({ success: false, code: out.code, error: out.error });

    await logAudit('update_journal', 'gl_journal', journalId, actor,
      { brandId: out.effBrand, branchId: out.effBranch, projectId: out.effProject, costCenterId: out.effCC,
        totalDebit, totalCredit, lineCount: (entries || []).length }, req.ip);

    res.json({ success: true, journalNumber: out.journalNumber, reposted: false });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.11.0 — bulk action endpoint. Accepts { ids:[], action:'approve|post|delete|approve_post', force }.
// Per-id outcome is reported so the UI can show partial-failure states.
// Tier A.2 corrective gate — every action now calls the EXACT SAME
// lib/glTransitions.js function its single-id counterpart calls (no more
// hand-rolled SQL duplicated between the two paths). approve/post/delete
// keep their capability pre-checks here (those glTransitions functions do
// NOT self-check capabilities — that's a route-level concern, matching the
// single-id routes' requireCapability middleware). approve_post's pre-check
// is deliberately REMOVED: glTransitions.approvePost() already requires
// BOTH finance.gl.approve AND finance.gl.post internally — this bulk route
// used to require only finance.gl.post for approve_post, which is exactly
// the gap that internal check closes; checking it a second time here would
// just be a second, driftable copy of the same rule.
router.post('/gl/journals/bulk', requireCapability('finance.gl.view'), async (req, res) => {
  const glTransitions = require('../lib/glTransitions');
  const { ids, action, force } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.json({ success: false, error: 'لا توجد قيود محدَّدة' });
  const allowed = ['approve', 'post', 'delete', 'approve_post'];
  if (allowed.indexOf(action) < 0) return res.json({ success: false, error: 'إجراء غير مدعوم' });

  const capFor = { approve: 'finance.gl.approve', post: 'finance.gl.post' };
  if (capFor[action]) {
    const okCap = await requireCapability.hasCapability(req.user, capFor[action]);
    if (!okCap) return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لهذه العملية' });
  }
  // Bulk delete stays developer-only (matches the single DELETE guard) — this
  // check MUST stay here: glTransitions.deleteJournal() does not itself
  // check developer authorization (that's the route's job, same as the
  // single DELETE route's guardDeveloper middleware).
  if (action === 'delete') {
    let isDev = false;
    if (req.user && req.user.isDeveloper) isDev = true;
    else if ((req.user && req.user.username) === 'admin') isDev = true;
    else {
      const u = (req.user && req.user.username || '').trim();
      if (u) {
        try {
          const [rows] = await db.query('SELECT is_developer, role FROM users WHERE username = ? LIMIT 1', [u]);
          if (rows.length && (rows[0].is_developer || rows[0].role === 'developer')) isDev = true;
        } catch (_) {}
      }
    }
    if (!isDev) return res.status(403).json({ success: false, error: 'حذف القيود متاح للمطوِّر فقط' });
  }

  const results = [];
  let ok = 0, failed = 0;
  for (const id of ids) {
    let r;
    try {
      if (action === 'approve') r = await glTransitions.approve(id, req.user, { ip: req.ip });
      else if (action === 'post') r = await glTransitions.post(id, req.user, { force: !!force, ip: req.ip });
      else if (action === 'approve_post') r = await glTransitions.approvePost(id, req.user, { force: !!force, ip: req.ip });
      else if (action === 'delete') r = await glTransitions.deleteJournal(id, req.user, { ip: req.ip });
    } catch (e) {
      r = { ok: false, code: 'exception', message: e.message };
    }
    if (r.ok) { results.push({ id, ok: true }); ok++; }
    else { results.push({ id, ok: false, reason: r.code, message: r.message }); failed++; }
  }
  console.log('[gl/journals/bulk] action=' + action + ' total=' + ids.length + ' ok=' + ok + ' failed=' + failed);
  res.json({ success: true, action, ok, failed, results });
});

// Delete journal — draft-only hard delete.
// v5.11.3 — gated behind guardDeveloper so only the developer/admin
// role can erase journal records. Frontend hides the button for
// everyone else; this is the server-side safety net for direct calls.
// Tier A.2 corrective gate — delegates to lib/glTransitions.js#deleteJournal,
// which now owns the denial-code logic (byte-identical Arabic messages) AND
// the audit-log writes (success + denial) — do NOT add an auditLog(...) call
// back into this handler, that would double-log every deletion/denial.
router.delete('/gl/journals/:id', guardDeveloper, async (req, res) => {
  const glTransitions = require('../lib/glTransitions');
  try {
    const out = await glTransitions.deleteJournal(req.params.id, req.user, { ip: req.ip });
    if (!out.ok) {
      return res.status(out.status || 500).json({ success: false, code: out.code, error: out.message });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[gl/journals/:id DELETE] error', e);
    res.status(500).json({ success: false, code: 'DB_ERROR', error: e.message });
  }
});

// Repair: fix gl_entries with NULL account_id by matching account_code
router.post('/gl/repair', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const [nullEntries] = await db.query('SELECT e.id, e.account_code, e.account_name, e.debit, e.credit FROM gl_entries e WHERE e.account_id IS NULL');
    let fixed = 0, created = 0;
    for (const entry of nullEntries) {
      let accId = null;
      // Try to find by code
      if (entry.account_code) {
        const [rows] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [entry.account_code]);
        if (rows.length) accId = rows[0].id;
      }
      // Try by name
      if (!accId && entry.account_name) {
        const [rows] = await db.query('SELECT id FROM gl_accounts WHERE name_ar LIKE ?', ['%' + (entry.account_name||'').substring(0, 20) + '%']);
        if (rows.length) accId = rows[0].id;
      }
      // Auto-create if custody-related (عهدة) and not found
      if (!accId && entry.account_name && entry.account_name.indexOf('عهدة') >= 0) {
        const personName = entry.account_name.replace(/عهدة\s*/, '').trim();
        if (personName) {
          try {
            // A SECOND custody-account creator, a hand-copy of the one in
            // routes/custody.js — and it carried the same defect: code `1130`
            // parented under `113`, which is INVENTORY per the canonical map in
            // lib/glPosting.js:44-45. That is why the owner saw «العهدة تحت
            // بند المخزون». Both creators now go through ONE implementation
            // (custody is `115`), so they cannot drift apart again.
            const acc = await require('./custody').createCustodyUserGLAccount(personName);
            accId = acc.id;
            created++;
          } catch(e) { /* Production: removed debug log */ }
        }
      }
      // Also handle مصروفات عهدة
      if (!accId && entry.account_name && entry.account_name.indexOf('مصروفات') >= 0) {
        const [expAcc] = await db.query("SELECT id FROM gl_accounts WHERE type = 'expense' ORDER BY code LIMIT 1");
        if (expAcc.length) accId = expAcc[0].id;
      }
      if (accId) {
        await db.query('UPDATE gl_entries SET account_id = ? WHERE id = ?', [accId, entry.id]);
        fixed++;
      }
    }
    // Recalculate all account balances from posted entries
    await db.query('UPDATE gl_accounts SET balance = 0');
    const [allEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE j.status = 'posted' AND e.account_id IS NOT NULL
       GROUP BY e.account_id`
    );
    for (const e of allEntries) {
      const net = (Number(e.d)||0) - (Number(e.c)||0);
      await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, e.account_id]);
    }
    res.json({ success: true, nullFixed: fixed, accountsCreated: created, totalNull: nullEntries.length, balancesRecalculated: allEntries.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Repair: create GL entries for old custody topups that have no journal
// Fix: restructure to 5 main accounts (merge old 6 into 5)
router.post('/gl/fix-tree', requireCapability('finance.accounts.manage'), async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'LEGACY_COA_REPAIR_RETIRED',
    error: 'تم إيقاف أداة إصلاح الشجرة القديمة؛ الشجرة تُدار عبر القالب والترحيلات المعتمدة.'
  });
  try {
    let fixed = 0;

    // Force exactly 5 root accounts (level=1, parent=NULL)
    // Valid roots: codes 1,2,3,4,5 (or 6 renamed to 5)
    const validRootCodes = ['1','2','3','4','5'];

    // If code 6 exists as root, merge it into code 5
    const [acc6] = await db.query("SELECT id FROM gl_accounts WHERE code = '6'");
    if (acc6.length) {
      const [acc5] = await db.query("SELECT id FROM gl_accounts WHERE code = '5'");
      if (acc5.length) {
        // Move 6's children under 5
        await db.query("UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?", [acc5[0].id, acc6[0].id]);
        // Delete account 6
        await db.query("DELETE FROM gl_accounts WHERE id = ? AND code = '6'", [acc6[0].id]);
        fixed++;
      } else {
        // Rename 6 to become the root المصروفات (acts as 5)
        await db.query("UPDATE gl_accounts SET code = '5', name_ar = 'المصروفات', parent_id = NULL, level = 1 WHERE id = ?", [acc6[0].id]);
        fixed++;
      }
    }

    // Fix any account with level > 1 that has no parent — find correct parent
    const [orphans] = await db.query("SELECT id, code, level FROM gl_accounts WHERE level > 1 AND (parent_id IS NULL OR parent_id = '')");
    for (const o of orphans) {
      // Find parent by code prefix: e.g. code=11 → parent code=1, code=112 → parent code=11
      let parentCode = o.code.substring(0, o.code.length - 1);
      while (parentCode.length > 0) {
        const [parent] = await db.query("SELECT id FROM gl_accounts WHERE code = ?", [parentCode]);
        if (parent.length) {
          await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [parent[0].id, o.id]);
          fixed++;
          break;
        }
        parentCode = parentCode.substring(0, parentCode.length - 1);
      }
    }

    // Ensure all root accounts are level 1
    await db.query("UPDATE gl_accounts SET level = 1, parent_id = NULL WHERE code IN ('1','2','3','4','5') AND (level != 1 OR parent_id IS NOT NULL)");

    res.json({ success: true, fixed });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// repair-topups CREATES posted journals for historic custody top-ups — that is
// journal posting, not account maintenance, hence finance.gl.post.
router.post('/gl/repair-topups', requireCapability('finance.gl.post'), async (req, res) => {
  try {
    // Find topups without GL journals
    const [topups] = await db.query(
      `SELECT t.*, c.custody_number, c.user_name, c.user_id
       FROM custody_topups t JOIN custodies c ON t.custody_id = c.id
       WHERE NOT EXISTS (SELECT 1 FROM gl_journals j WHERE j.reference_type = 'custody_topup' AND j.reference_id = t.id)`
    );
    let created = 0;
    for (const t of topups) {
      const amt = Number(t.amount) || 0;
      if (amt <= 0) continue;

      // Find custody user GL account
      let custAccId = null;
      const [custAccRows] = await db.query(
        'SELECT id, code FROM gl_accounts WHERE code = ? AND is_active = 1 LIMIT 1',
        [CORE_ACCOUNTS.EMPLOYEE_ADVANCES.code]);
      if (custAccRows.length) custAccId = custAccRows[0].id;
      if (!custAccId) {
        throw new Error('CUSTODY_CONTROL_ACCOUNT_MISSING');
      }

      // Find a default cash account for old topups (11101)
      let cashAccId = null;
      const [cashAcc] = await db.query(
        'SELECT id FROM gl_accounts WHERE code = ? AND is_active = 1 LIMIT 1',
        [CORE_ACCOUNTS.CASH.code]);
      if (cashAcc.length) cashAccId = cashAcc[0].id;

      if (!custAccId) continue;

      const jrnId = 'JRN-REPAIR-' + Date.now() + '-' + created + '-' + Math.random().toString(36).slice(2, 6);
      const journalNumber = await nextFlatJournalNumber(); // FC-B1 atomic (was created_at DESC in a loop → guaranteed same-second ties)
      const desc = 'تغذية عهدة ' + (t.custody_number||'') + ' — ' + (t.user_name||'');

      await db.query(
        `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [jrnId, journalNumber, t.created_at || new Date(), 'custody_topup', t.id, desc, amt, amt, 'posted', t.created_by||'', 'repair', new Date()]
      );

      // Debit custody account
      await db.query(
        'INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
        ['GLE-R-'+Date.now()+'-'+created+'D', jrnId, custAccId, '', 'عهدة '+(t.user_name||''), amt, 0, desc]
      );

      // Credit cash (if available)
      if (cashAccId) {
        await db.query(
          'INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description) VALUES (?,?,?,?,?,?,?,?)',
          ['GLE-R-'+Date.now()+'-'+created+'C', jrnId, cashAccId, '11101', 'الصندوق', 0, amt, desc]
        );
      }
      created++;
    }

    // Recalculate all balances
    await db.query('UPDATE gl_accounts SET balance = 0');
    const [allEntries] = await db.query(
      `SELECT e.account_id, SUM(e.debit) AS d, SUM(e.credit) AS c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE j.status = 'posted' AND e.account_id IS NOT NULL
       GROUP BY e.account_id`
    );
    for (const e of allEntries) {
      const net = (Number(e.d)||0) - (Number(e.c)||0);
      await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [net, e.account_id]);
    }

    res.json({ success: true, topupsProcessed: created, totalTopups: topups.length, balancesRecalculated: allEntries.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Cost Centers (مراكز التكلفة) — v5.10.29 ─────────────────────────
// The cost_centers table is auto-created by routes/inventory.js migrations.
// These endpoints supply the master CRUD that AP/AR/budgets/journal entries
// already FK into.

// v5.17.1 — /cost-centers moved to routes/erp/cost-centers.js
// (the older duplicate block further down was dead code; only the
// rich version was ever reached due to Express stack order.)

// Diagnostic: check GL data
// v5.10.29 — Enhanced. Now surfaces concrete chart-of-accounts integrity
// issues so the operator can see what needs fixing:
//   • orphans: accounts whose parent_id doesn't match any existing account
//   • typeMismatch: accounts whose type ≠ parent's type (e.g. asset under revenue)
//   • levelMismatch: accounts whose stored level disagrees with computed depth
//   • duplicateCodes: same code used by more than one account
//   • unbalancedJournals: posted journals where SUM(debit) ≠ SUM(credit)
//   • orphanEntries: entries pointing at deleted accounts
//   • missingCoreAccounts: required core accounts (CASH/INVENTORY/COGS…) absent
router.get('/gl/diagnose', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const CORE_CODES = Array.from(new Set(Object.values(CORE_ACCOUNTS).map((row) => row.code)));

    const [accs] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    const [jrns] = await db.query('SELECT COUNT(*) AS cnt, status FROM gl_journals GROUP BY status');
    const [nullEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NULL');
    const [validEntries] = await db.query('SELECT COUNT(*) AS cnt FROM gl_entries WHERE account_id IS NOT NULL');
    const [nonZeroAccs] = await db.query('SELECT code, name_ar, type, balance FROM gl_accounts WHERE balance != 0 ORDER BY code');

    // Orphans: parent_id set but no matching parent row
    const [orphans] = await db.query(
      `SELECT a.id, a.code, a.name_ar, a.type, a.parent_id
         FROM gl_accounts a
        WHERE a.parent_id IS NOT NULL
          AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);

    // Type mismatch with parent
    const [typeMismatch] = await db.query(
      `SELECT c.id, c.code, c.name_ar, c.type AS child_type,
              p.code AS parent_code, p.name_ar AS parent_name, p.type AS parent_type
         FROM gl_accounts c
         JOIN gl_accounts p ON p.id = c.parent_id
        WHERE c.type IS NOT NULL AND p.type IS NOT NULL AND c.type <> p.type`);

    // Duplicate codes
    const [dupCodes] = await db.query(
      `SELECT code, COUNT(*) AS n FROM gl_accounts WHERE code IS NOT NULL GROUP BY code HAVING n > 1`);

    // Unbalanced posted journals
    const [unbalanced] = await db.query(
      `SELECT j.id, j.journal_number, j.journal_date, j.description,
              ROUND(SUM(e.debit), 4)  AS total_debit,
              ROUND(SUM(e.credit), 4) AS total_credit
         FROM gl_journals j JOIN gl_entries e ON e.journal_id = j.id
        WHERE j.status = 'posted'
        GROUP BY j.id
       HAVING ABS(IFNULL(total_debit,0) - IFNULL(total_credit,0)) > 0.01
        ORDER BY j.journal_date DESC LIMIT 20`);

    // Entries pointing at deleted accounts (account_id set but row missing)
    const [orphanEntries] = await db.query(
      `SELECT e.id, e.journal_id, e.account_id, e.account_code, e.account_name, e.debit, e.credit
         FROM gl_entries e
        WHERE e.account_id IS NOT NULL
          AND e.account_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)
        LIMIT 50`);

    // Missing core accounts
    const ph = CORE_CODES.map(() => '?').join(',');
    const [presentCore] = await db.query(
      `SELECT code FROM gl_accounts WHERE code IN (${ph})`, CORE_CODES);
    const presentSet = new Set(presentCore.map(r => r.code));
    const missingCoreAccounts = CORE_CODES.filter(c => !presentSet.has(c));

    // Computed levels: walk parent chain and compare against stored level
    // A THIRD private 0-based depth walk used to live here. It reported
    // `levelMismatch` against a base of 0 while the stored levels are 1-based,
    // so /gl/diagnose listed the entire chart as mismatched — the diagnostic
    // itself was the thing that was wrong. One shared 1-based walk now.
    const [allAccs] = await db.query('SELECT id, code, name_ar, parent_id, level FROM gl_accounts');
    const { depth: _depthMap, cycleMembers: _cycleSet } = coaTree.computeDepths(
      allAccs, new Map(allAccs.map((r) => [r.id, r])));
    const levelMismatch = [];
    const cycles = [];
    for (const a of allAccs) {
      if (_cycleSet.has(a.id)) { cycles.push({ id: a.id, code: a.code, name_ar: a.name_ar }); continue; }
      const d = _depthMap.get(a.id) || coaTree.DEPTH_BASE;
      if (Number(a.level || 0) !== d) {
        levelMismatch.push({ id: a.id, code: a.code, name_ar: a.name_ar, storedLevel: a.level, computedLevel: d });
      }
    }

    const [recentEntries] = await db.query(
      `SELECT e.account_id, e.account_code, e.account_name, e.debit, e.credit, j.journal_number, j.status, j.description
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id ORDER BY j.created_at DESC LIMIT 10`
    );

    // ─── v5.10.38 — three new integrity checks ───

    // (9) code prefix vs type mismatch
    //     e.g. account with code starting "11" (asset family) but type='liability'
    const [codeTypeMismatch] = await db.query(
      `SELECT id, code, name_ar, type FROM gl_accounts
        WHERE code IS NOT NULL AND (
          (LEFT(code,1)='1' AND type<>'asset')      OR
          (LEFT(code,1)='2' AND type<>'liability')  OR
          (LEFT(code,1)='3' AND type<>'equity')     OR
          (LEFT(code,1)='4' AND type<>'revenue')    OR
          (LEFT(code,1)='5' AND type<>'expense'))
        ORDER BY code`);

    // (10) THE USER'S COMPLAINT: balance != 0 but no posted journal entries
    //      means the gl_accounts.balance column is a "zombie" — a number
    //      not backed by any actual journal. Fix = recompute from gl_entries.
    const [balanceWithoutEntries] = await db.query(
      `SELECT a.id, a.code, a.name_ar, a.type, a.balance
         FROM gl_accounts a
        WHERE ABS(IFNULL(a.balance,0)) > 0.001
          AND NOT EXISTS (SELECT 1 FROM gl_entries e
                            JOIN gl_journals j ON j.id = e.journal_id
                           WHERE e.account_id = a.id AND j.status='posted')
        ORDER BY a.code`);

    // (11) account name strongly hints at a category but its placement
    //      disagrees (e.g. "بنك القاهرة" parented under inventory).
    //      Re-uses _COA_KEYWORD_RULES to compute expected root.
    // (12) v5.10.40 — root code mismatch: code starts with digit X but
    //      actual root ancestor is a different digit. Catches cases like
    //      "41 الإيرادات التشغيلية" sitting under root 5 (cost of sales).
    const nameVsPlacementMismatch = [];
    const rootCodeMismatch = [];
    {
      const [allAccs2] = await db.query('SELECT id, code, name_ar, parent_id FROM gl_accounts');
      const byId2 = {}; allAccs2.forEach(a => { byId2[a.id] = a; });
      const ascendantCode = function(a) {
        let walker = a, hops = 0;
        const seen = new Set();
        while (walker && walker.parent_id) {
          if (seen.has(walker.id)) return null;
          seen.add(walker.id);
          walker = byId2[walker.parent_id] || null;
          if (++hops > 50) return null;
        }
        return walker ? walker.code : null;
      };
      for (const a of allAccs2) {
        const codeStr = String(a.code || '');
        const codeRoot = codeStr.charAt(0);
        const actualRoot = ascendantCode(a);

        // (12) — code's first digit must match the root ancestor
        if (codeRoot && actualRoot && ['1','2','3','4','5'].indexOf(codeRoot) >= 0
            && actualRoot !== codeRoot) {
          rootCodeMismatch.push({
            id: a.id, code: a.code, name_ar: a.name_ar,
            expectedRootCode: codeRoot,
            actualRootCode: actualRoot
          });
        }

        // (11) — name keyword vs actual placement
        const name = String(a.name_ar || '');
        if (!name) continue;
        let rule = null;
        for (const [re, parentCode, label] of _COA_KEYWORD_RULES) {
          if (re.test(name)) { rule = { parentCode, label }; break; }
        }
        if (!rule) continue;
        const expectedRoot = rule.parentCode.charAt(0);
        if (actualRoot && actualRoot !== expectedRoot) {
          nameVsPlacementMismatch.push({
            id: a.id, code: a.code, name_ar: a.name_ar,
            expectedParentCode: rule.parentCode, expectedLabel: rule.label,
            actualRootCode: actualRoot
          });
        }
      }
    }

    const issuesCount =
      orphans.length + typeMismatch.length + dupCodes.length +
      unbalanced.length + orphanEntries.length + missingCoreAccounts.length +
      levelMismatch.length + cycles.length +
      codeTypeMismatch.length + balanceWithoutEntries.length +
      nameVsPlacementMismatch.length + rootCodeMismatch.length;

    res.json({
      summary: {
        accounts: accs[0].cnt,
        journals: jrns,
        nullEntries: nullEntries[0].cnt,
        validEntries: validEntries[0].cnt,
        issuesCount,
        healthy: issuesCount === 0
      },
      issues: {
        orphans,
        typeMismatch,
        duplicateCodes: dupCodes,
        unbalancedJournals: unbalanced,
        orphanEntries,
        missingCoreAccounts,
        levelMismatch,
        cycles,
        // v5.10.38
        codeTypeMismatch,
        balanceWithoutEntries,
        nameVsPlacementMismatch,
        // v5.10.40
        rootCodeMismatch
      },
      nonZeroAccounts: nonZeroAccs,
      recentEntries
    });
  } catch(e) { res.json({ error: e.message }); }
});

// v5.10.29 — Auto-fix safe issues found by /gl/diagnose:
//   • orphans → set parent_id to NULL (promote to root)
//   • level mismatches → recompute level from actual parent depth
// Does NOT touch type mismatches (operator decision), duplicate codes
// (need merge strategy), or unbalanced journals (need accounting review).
router.post('/gl/auto-fix', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const result = { orphansPromoted: 0, levelsCorrected: 0 };

    // 1. Orphans → root
    const [orphans] = await db.query(
      `SELECT a.id FROM gl_accounts a
        WHERE a.parent_id IS NOT NULL
          AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
    for (const o of orphans) {
      await db.query('UPDATE gl_accounts SET parent_id = NULL, level = 0 WHERE id = ?', [o.id]);
      result.orphansPromoted++;
    }

    // 2. Recompute levels for everyone.
    // A FOURTH private 0-based depth walk used to live here — and unlike the
    // diagnostic one, this endpoint WRITES. Every account it "corrected" was
    // pushed one level too shallow, which is one of the ways the chart ended up
    // 0-based in the first place. One shared 1-based derive now.
    const levels = await coaTree.recomputeLevels(db);
    result.levelsCorrected += levels.updated;

    res.json({ success: true, ...result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Inventory Method & Valuation ───

// Get/Set inventory method
// How many inventory movements have been posted since the last hard-closed
// period — i.e. movements whose COGS was computed under the CURRENT method and
// is still in an open period. Switching the method with these present would leave
// one period's COGS computed two different ways (IAS 2 consistency).
async function _movementsSinceLastClose() {
  let since = null;
  try {
    const [p] = await db.query(
      "SELECT end_date FROM accounting_periods WHERE status='closed' ORDER BY end_date DESC LIMIT 1");
    if (p.length) since = p[0].end_date;
  } catch (_) { /* no periods table → treat as "everything is open" */ }
  try {
    // inventory_movements dates its rows with `movement_date` — there is no
    // created_at on this table.
    const [r] = since
      ? await db.query('SELECT COUNT(*) c FROM inventory_movements WHERE movement_date > ?', [since])
      : await db.query('SELECT COUNT(*) c FROM inventory_movements');
    return { count: Number(r[0].c) || 0, since: since || null };
  } catch (_) {
    // Table missing → we cannot prove it is safe, so report unknown and let the
    // caller fail closed rather than silently allowing the switch.
    return { count: -1, since: since || null };
  }
}

router.get('/inventory-method', requireCapability('inventory.view'), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    const mv = await _movementsSinceLastClose();
    res.json({
      method: rows.length ? rows[0].setting_value : 'perpetual',
      // Surfaced so the screen can explain WHY the switch is blocked instead of
      // just disabling a control.
      movementsSinceLastClose: mv.count,
      lastCloseDate: mv.since,
      canChange: mv.count === 0,
    });
  } catch (e) {
    console.error('[erp/inventory-method] read failed:', e.code || e.message);
    res.status(500).json({ success: false, error: 'تعذّر قراءة طريقة تقييم المخزون' });
  }
});

// v4 — was unguarded and unprotected. The inventory valuation method decides how
// COGS is computed and posted to the GL; it was changeable by anyone holding any
// valid token, at any time, with no check on whether movements had already been
// costed under the outgoing method.
router.post('/inventory-method', requireCapability('inventory.method.manage'), async (req, res) => {
  try {
    const { method, force } = req.body || {};
    if (!['perpetual','periodic'].includes(method)) return res.json({ success: false, error: 'طريقة غير صالحة' });

    const [cur] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    const current = cur.length ? cur[0].setting_value : 'perpetual';
    if (current === method) return res.json({ success: true, unchanged: true });

    const mv = await _movementsSinceLastClose();
    if (mv.count !== 0 && force !== true) {
      return res.json({
        success: false,
        blocked: true,
        movementsSinceLastClose: mv.count,
        lastCloseDate: mv.since,
        error: mv.count < 0
          ? 'تعذّر التحقق من حركات المخزون — لا يمكن تغيير الطريقة قبل التأكد'
          : `توجد ${mv.count} حركة مخزون في فترة غير مُقفلة حُسبت تكلفتها بالطريقة الحالية. أقفل الفترة أولًا، أو أكِّد التغيير صراحةً.`,
      });
    }

    await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('inventory_method',?) ON DUPLICATE KEY UPDATE setting_value=?", [method, method]);
    console.log(`[erp/inventory-method] ${current} → ${method} by ${(req.user && req.user.username) || '?'}${force === true ? ' (FORCED over ' + mv.count + ' movements)' : ''}`);
    res.json({ success: true, from: current, to: method, forced: force === true });
  } catch (e) {
    console.error('[erp/inventory-method] save failed:', e.code || e.message);
    res.json({ success: false, error: 'تعذّر حفظ طريقة تقييم المخزون' });
  }
});

// Inventory valuation — real-time stock value (per-warehouse or aggregated)
router.get('/inventory-valuation', async (req, res) => {
  try {
    const { brand_id, warehouse_id, by } = req.query; // by = 'warehouse' | 'brand' | 'category'
    const [methodRow] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    const method = methodRow.length ? methodRow[0].setting_value : 'perpetual';

    // If per-warehouse/brand breakdown requested — use warehouse_stock
    if (by === 'warehouse' || by === 'brand' || warehouse_id || brand_id) {
      // Detect whether Phase-3 avg_cost column exists on warehouse_stock
      let hasAvgCost = false;
      try {
        const [cols] = await db.query("SHOW COLUMNS FROM warehouse_stock LIKE 'avg_cost'");
        hasAvgCost = cols.length > 0;
      } catch(e) { hasAvgCost = false; }

      const costExpr = hasAvgCost
        ? 'COALESCE(NULLIF(ws.avg_cost, 0), i.cost, 0)'
        : 'COALESCE(i.cost, 0)';

      // v5.15.2 — Raw materials + semi-finished products unified.
      // Semi-finished items live in menu (with is_semi_finished=1) and
      // are tracked via menu.stock + production_warehouse_id. We add
      // an item_type column so the admin UI can badge them. Zero-stock
      // semis are included so the admin sees the item exists even
      // before the first production order runs.
      let sql = `
        SELECT 'raw' AS item_type,
               ws.warehouse_id, w.name AS warehouse_name, w.brand_id, COALESCE(br.name,'') AS brand_name,
               ws.item_id, i.name AS item_name, i.category, i.unit,
               ${costExpr} AS cost,
               COALESCE(ws.qty, 0) AS qty
        FROM warehouse_stock ws
        JOIN warehouses w ON ws.warehouse_id = w.id
        LEFT JOIN brands br ON w.brand_id = br.id
        JOIN inv_items i ON ws.item_id = i.id
        WHERE COALESCE(i.active,1) = 1 AND COALESCE(w.is_active,1) = 1`;
      const params = [];
      if (brand_id) { sql += ' AND w.brand_id = ?'; params.push(brand_id); }
      if (warehouse_id) { sql += ' AND ws.warehouse_id = ?'; params.push(warehouse_id); }
      sql += `
        UNION ALL
        SELECT 'semi' AS item_type,
               m.production_warehouse_id AS warehouse_id,
               COALESCE(w2.name, 'بلا مستودع') AS warehouse_name,
               m.brand_id AS brand_id,
               COALESCE(br2.name, '') AS brand_name,
               m.id AS item_id, m.name AS item_name,
               COALESCE(m.category, 'نصف-مُصَنَّع') AS category,
               COALESCE(m.production_unit, 'pcs') AS unit,
               COALESCE(m.cost, 0) AS cost,
               COALESCE(m.stock, 0) AS qty
        FROM menu m
        LEFT JOIN warehouses w2 ON m.production_warehouse_id = w2.id
        LEFT JOIN brands br2 ON br2.id = m.brand_id
        WHERE m.is_semi_finished = 1 AND COALESCE(m.active, 1) = 1
          AND m.production_warehouse_id IS NOT NULL`;
      if (brand_id) { sql += ' AND m.brand_id = ?'; params.push(brand_id); }
      if (warehouse_id) { sql += ' AND m.production_warehouse_id = ?'; params.push(warehouse_id); }
      sql += ' ORDER BY warehouse_name, item_type, item_name';
      let rows = [];
      try {
        const [r] = await db.query(sql, params);
        rows = r;
      } catch(e) {
        // warehouse_stock may not exist yet — fall through to inv_items path
        console.warn('[inventory-valuation] warehouse_stock query failed, falling back:', e.message);
        rows = [];
      }

      // If we got rows from warehouse_stock, use them
      if (rows.length) {
        const byBrand = {}, byWarehouse = {}, byCategory = {};
        let totalValue = 0; let totalQty = 0;
        rows.forEach(r => {
          const val = (Number(r.qty)||0) * (Number(r.cost)||0);
          totalValue += val;
          totalQty += Number(r.qty) || 0;

          const bKey = r.brand_id || 'no_brand';
          if (!byBrand[bKey]) byBrand[bKey] = { brandId: r.brand_id, brandName: r.brand_name || 'بدون براند', totalValue: 0, items: 0 };
          byBrand[bKey].totalValue += val; byBrand[bKey].items++;

          if (!byWarehouse[r.warehouse_id]) byWarehouse[r.warehouse_id] = { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, brandName: r.brand_name, totalValue: 0, items: [] };
          byWarehouse[r.warehouse_id].totalValue += val;
          byWarehouse[r.warehouse_id].items.push({ name: r.item_name, qty: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit, category: r.category, itemType: r.item_type || 'raw' });

          const cat = r.category || 'أخرى';
          if (!byCategory[cat]) byCategory[cat] = { totalValue: 0, items: [] };
          byCategory[cat].totalValue += val;
          byCategory[cat].items.push({ name: r.item_name, stock: Number(r.qty)||0, cost: Number(r.cost)||0, value: val, unit: r.unit, itemType: r.item_type || 'raw' });
        });
        return res.json({ method, totalValue, totalQty, itemCount: rows.length, byBrand, byWarehouse, categories: byCategory });
      }
      // If warehouse_stock query returned no rows, fall through to inv_items aggregate
    }

    // Default: aggregate from inv_items (used when no warehouse_stock data yet)
    const [items] = await db.query(
      "SELECT id, name, category, COALESCE(cost,0) AS cost, COALESCE(stock,0) AS stock, unit " +
      "FROM inv_items WHERE COALESCE(active,1) = 1");
    const categories = {};
    const byBrand = {};
    let totalValue = 0;
    items.forEach(i => {
      const cat = i.category || 'أخرى';
      if (!categories[cat]) categories[cat] = { items: [], totalValue: 0 };
      const val = (Number(i.stock)||0) * (Number(i.cost)||0);
      categories[cat].items.push({ name: i.name, stock: Number(i.stock)||0, cost: Number(i.cost)||0, value: val, unit: i.unit });
      categories[cat].totalValue += val;
      totalValue += val;
    });
    res.json({ method, categories, totalValue, itemCount: items.length, byBrand: {}, byWarehouse: {} });
  } catch(e) {
    console.error('[inventory-valuation] error:', e);
    res.json({ method: 'perpetual', categories: {}, totalValue: 0, itemCount: 0, byBrand: {}, byWarehouse: {}, error: e.message });
  }
});

// Compatibility tombstone: inventory detail belongs to the stock subledger
// and dimensions. This endpoint must never create or mutate GL accounts.
router.post('/gl/sync-inventory', requireCapability('finance.accounts.manage'), async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'INVENTORY_COA_SYNC_RETIRED',
    error: 'يستخدم النظام حساب مراقبة مخزون واحد؛ التفاصيل متاحة في تقارير وحركات المخزون.',
  });
});

// ─── Financial Reports ───

// v5.17.2 — /reports/trial-balance moved to routes/erp/reports/trial-balance.js

// v5.17.2 — /reports/income moved to routes/erp/reports/income.js

// v5.17.2 — /reports/balance-sheet-ifrs moved to routes/erp/reports/balance-sheet.js

// v5.17.2 — /reports/cash-flow-ias7 moved to routes/erp/reports/cash-flow.js

// ─── VAT ───

// Get VAT transactions for period
// v5.17.1 — /vat/* moved to routes/erp/vat.js

// ─── Audit Log (سجل التدقيق) ───

// Tier A.2 corrective gate, Section 3 — this file used to keep its own
// local auditLog() helper, a byte-for-byte duplicate of lib/auditLogger.js#
// logAudit (both insert into audit_logs with the same column order), except
// this copy had drifted onto the WRONG column names for a while (fixed in
// Tier A.1, see git history) — exactly the kind of divergence a duplicated
// helper invites. Both of this file's remaining call sites (create_journal,
// update_journal) now call the one real implementation directly (imported
// at the top of this file); the local function is gone.

// v5.17.1 — /audit-logs moved to routes/erp/audit-logs.js

// v5.17.1 — /purchase-reports moved to routes/erp/purchase-reports.js

// v5.17.1 — /brands moved to routes/erp/brands.js

// v5.17.1 — Older /cost-centers duplicate block REMOVED. It was dead
// code (Express always reached the richer block above first via
// stack order). The active version now lives in routes/erp/cost-centers.js.

// ─── Warehouses (المستودعات المتعددة) ───

router.get('/warehouses-list', async (req, res) => {
  try {
    const scope = req.whScopeClause('w.id');
    // B3 — filter the warehouses still missing an English name (completion workflow).
    const missingEn = String(req.query.missingNameEn) === '1' ? " AND (w.name_en IS NULL OR w.name_en = '')" : '';
    const [rows] = await db.query(`
      SELECT w.*,
        b.name AS branch_name,
        bd.name AS brand_name,
        cc.name AS cost_center_name
      FROM warehouses w
      LEFT JOIN branches b ON w.branch_id = b.id
      LEFT JOIN brands bd ON w.brand_id = bd.id
      LEFT JOIN cost_centers cc ON w.cost_center_id = cc.id
      WHERE 1=1${scope.sql}${missingEn}
      ORDER BY w.code`, scope.params);
    res.json(rows.map(w => {
      let allowedBrands = [];
      try { if (w.allowed_brands) allowedBrands = JSON.parse(w.allowed_brands); } catch(e) {}
      return {
        id: w.id, code: w.code, name: w.name, nameEn: w.name_en || '', type: w.type,
        branchId: w.branch_id || '', branchName: w.branch_name||'',
        brandId: w.brand_id || '', brandName: w.brand_name||'',
        costCenterId: w.cost_center_id || '', costCenterName: w.cost_center_name||'',
        location: w.location||'', manager: w.manager||'', isActive: w.is_active,
        // V3: array of allowed brand IDs (multi-brand storage rule)
        allowedBrands: allowedBrands
      };
    }));
  } catch(e) {
    // v7.5 — was res.json([]): a DB fault rendered as "no warehouses exist".
    console.error('[erp/warehouses-list] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل المستودعات' });
  }
});

// v7.5 — warehouse master-data create/update. inventory.edit (admin/manager/
// inventory) so the store-keeper keeps the function while the till loses it;
// the harder DELETE below stays MGR.
router.post('/warehouses-list', requireCapability('inventory.edit'), async (req, res) => {
  try {
    const { id, code, name, nameEn, type, brandId, branchId, costCenterId, location, manager, allowedBrands } = req.body;
    if (!code || !name) return res.json({ success: false, error: 'الرمز والاسم مطلوبان' });
    // B3 — the English name is mandatory for NEW warehouses (bilingual master
    // data). Existing rows may still lack it and are completed via the
    // missing-English-name filter, so it is not forced on update.
    if (!id && (nameEn == null || String(nameEn).trim() === '')) {
      return res.status(422).json({ success: false, code: 'NAME_EN_REQUIRED', error: 'الاسم بالإنجليزية مطلوب للمستودعات الجديدة' });
    }
    const nEn = (nameEn != null && String(nameEn).trim() !== '') ? String(nameEn).trim() : null;
    const allowedBrandsJson = Array.isArray(allowedBrands) ? JSON.stringify(allowedBrands) : null;
    if (id) {
      if (!req.guardWh(res, id)) return;
      try {
        await db.query('UPDATE warehouses SET code=?, name=?, name_en=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=?, allowed_brands=? WHERE id=?',
          [code, name, nEn, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson, id]);
      } catch(e) {
        // Fallback for older deploys without allowed_brands column
        await db.query('UPDATE warehouses SET code=?, name=?, name_en=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=? WHERE id=?',
          [code, name, nEn, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', id]);
      }
      return res.json({ success: true, id });
    }
    const newId = 'WH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    try {
      await db.query('INSERT INTO warehouses (id, code, name, name_en, type, brand_id, branch_id, cost_center_id, location, manager, allowed_brands) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [newId, code, name, nEn, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson]);
    } catch(e) {
      await db.query('INSERT INTO warehouses (id, code, name, name_en, type, brand_id, branch_id, cost_center_id, location, manager) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [newId, code, name, nEn, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'']);
    }
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Phase 0 §7 — a warehouse that has EVER had movement (inventory_movements,
// stock_issues, or non-zero on-hand) is never hard-deleted: deleting it would
// strand its ledger history and break every report that joins on it. Such a
// warehouse is DEACTIVATED instead (is_active = 0) so it drops out of the
// pickers but its history stays intact. Only a pristine, never-used warehouse
// may be physically removed. Managers only. When in doubt (a probe query
// fails on an old schema) we fail SAFE → deactivate, never delete.
router.delete('/warehouses-list/:id', MGR, async (req, res) => {
  const id = req.params.id;
  if (!req.guardWh(res, id)) return;
  async function _count(sql, params) {
    try { const [r] = await db.query(sql, params); return Number((r[0] || {}).n) || 0; }
    catch (_) { return Infinity; } // unknown → treat as "has history" (fail safe)
  }
  try {
    const [whRows] = await db.query('SELECT id FROM warehouses WHERE id = ?', [id]);
    if (!whRows.length) return res.json({ success: false, error: 'المستودع غير موجود' });

    const used =
      (await _count('SELECT COUNT(*) AS n FROM inventory_movements WHERE warehouse_id = ?', [id])) +
      (await _count('SELECT COUNT(*) AS n FROM stock_issues WHERE from_warehouse_id = ? OR to_warehouse_id = ?', [id, id])) +
      (await _count('SELECT COUNT(*) AS n FROM warehouse_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ?', [id, id])) +
      (await _count('SELECT COUNT(*) AS n FROM warehouse_stock WHERE warehouse_id = ? AND qty <> 0', [id])) +
      (await _count('SELECT COUNT(*) AS n FROM warehouses WHERE parent_warehouse_id = ?', [id]));

    if (used > 0) {
      await db.query('UPDATE warehouses SET is_active = 0 WHERE id = ?', [id]);
      return res.json({
        success: true, deactivated: true,
        message: 'تم تعطيل المستودع بدل حذفه لوجود حركة/رصيد أو مستودعات فرعية مرتبطة. السجل محفوظ.'
      });
    }

    // Pristine warehouse — safe to physically remove (clears its empty
    // zero-qty stock rows first; there is no FK CASCADE configured).
    await db.withTransaction(async (conn) => {
      await conn.query('DELETE FROM warehouse_stock WHERE warehouse_id = ?', [id]);
      await conn.query('DELETE FROM warehouses WHERE id = ?', [id]);
    });
    res.json({ success: true, deleted: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Warehouse stock
router.get('/warehouse-stock-detail/:whId', async (req, res) => {
  try {
    if (!req.guardWh(res, req.params.whId)) return;
    const [rows] = await db.query(
      `SELECT ws.*, i.name, i.category, i.unit, i.cost FROM warehouse_stock ws
       JOIN inv_items i ON ws.item_id = i.id WHERE ws.warehouse_id = ? ORDER BY i.name`, [req.params.whId]);
    res.json(rows.map(r => ({ itemId: r.item_id, itemName: r.name, category: r.category, unit: r.unit, qty: Number(r.qty), cost: Number(r.cost) })));
  } catch(e) {
    // v7.5 — was res.json([]): a fault read as "this warehouse is empty".
    console.error('[erp/warehouse-stock-detail] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل مخزون المستودع' });
  }
});

// Warehouse transfers
// v5.10.21 — accepts ?warehouseId (matches either from or to), ?direction
// (in|out — only when warehouseId is set), ?status, ?startDate, ?endDate
// so the unified filter bar in the wh_transfers tab can scope server-side.
router.get('/warehouse-transfers', async (req, res) => {
  try {
    let sql =
      `SELECT t.*, wf.name AS from_name, wt.name AS to_name FROM warehouse_transfers t
       LEFT JOIN warehouses wf ON t.from_warehouse_id = wf.id
       LEFT JOIN warehouses wt ON t.to_warehouse_id = wt.id`;
    const conds = [];
    const params = [];
    const { warehouseId, direction, status, startDate, endDate } = req.query;
    if (warehouseId) {
      if (direction === 'in') {
        conds.push('t.to_warehouse_id = ?');   params.push(warehouseId);
      } else if (direction === 'out') {
        conds.push('t.from_warehouse_id = ?'); params.push(warehouseId);
      } else {
        conds.push('(t.from_warehouse_id = ? OR t.to_warehouse_id = ?)');
        params.push(warehouseId, warehouseId);
      }
    }
    if (status)    { conds.push('t.status = ?');                  params.push(status); }
    if (startDate) { conds.push('DATE(t.transfer_date) >= ?');    params.push(startDate); }
    if (endDate)   { conds.push('DATE(t.transfer_date) <= ?');    params.push(endDate); }
    const sf = req.whScopeClause('t.from_warehouse_id'), st = req.whScopeClause('t.to_warehouse_id');
    if (sf.sql) {
      conds.push('(' + sf.sql.replace(/^\s*AND\s+/i, '') + ' OR ' + st.sql.replace(/^\s*AND\s+/i, '') + ')');
      params.push(...sf.params, ...st.params);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY t.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(t => ({
      id: t.id, transferNumber: t.transfer_number, fromWarehouse: t.from_name||'', toWarehouse: t.to_name||'',
      fromId: t.from_warehouse_id, toId: t.to_warehouse_id,
      transferDate: t.transfer_date, status: t.status, items: JSON.parse(t.items_json||'[]'),
      notes: t.notes, createdBy: t.created_by, approvedBy: t.approved_by
    })));
  } catch(e) {
    // v7.5 — was res.json([]): a fault (or bad items_json) read as "no transfers".
    console.error('[erp/warehouse-transfers] list failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل تحويلات المستودعات' });
  }
});

router.post('/warehouse-transfers', MGR, async (req, res) => {
  try {
    const { fromWarehouseId, toWarehouseId, items, notes } = req.body;
    // Phase 0 §5 — creator from the JWT, never the body.
    const username = _actor(req);
    if (!fromWarehouseId || !toWarehouseId || !items || !items.length) {
      return res.status(400).json({ success: false, error: 'بيانات ناقصة' });
    }
    if (!req.guardTransfer(res, fromWarehouseId, toWarehouseId)) return;
    // v5.10.29 — block same-warehouse transfers; meaningless, would cancel out.
    if (String(fromWarehouseId) === String(toWarehouseId)) {
      return res.status(400).json({ success: false, error: 'لا يمكن التحويل إلى نفس المستودع' });
    }
    // Validate both warehouses exist
    const [whs] = await db.query(
      'SELECT id FROM warehouses WHERE id IN (?, ?)', [fromWarehouseId, toWarehouseId]);
    if (whs.length < 2) {
      return res.status(404).json({ success: false, error: 'أحد المستودعين غير موجود' });
    }
    // v5.10.29 — reject zero/negative quantities up-front so drafts never carry
    // garbage into approval. itemId required.
    // Phase U — a line may be entered in a major unit (or composite); resolve →
    // base and store base qty so the approve path moves stock in the item's base
    // unit. The frozen snapshot is kept alongside for the timeline/reports.
    const IU = require('../lib/itemUnits');
    const normItems = [];
    for (const it of items) {
      if (!it || !it.itemId) return res.status(400).json({ success: false, error: 'صنف بدون معرّف' });
      let u;
      try {
        u = await IU.resolveLineBase(db, it.itemId, {
          enteredUnitId: it.enteredUnitId, enteredUnitCode: it.enteredUnitCode,
          enteredQty: it.enteredQty != null ? it.enteredQty : it.qty,
          majorQty: it.majorQty, minorQty: it.minorQty, baseQty: it.baseQty,
        }, 'transfer');
      } catch (e) {
        const http = (require('../lib/inventoryTxContract').httpFor(e.code)) || 400;
        return res.status(http).json({ success: false, code: e.code || 'VALIDATION_ERROR', error: e.message });
      }
      const q = u.baseQty;
      if (!isFinite(q) || q <= 0) {
        return res.status(400).json({ success: false, error: 'الكمية يجب أن تكون أكبر من صفر' });
      }
      normItems.push(Object.assign({}, it, {
        qty: q, baseQty: q, enteredQty: u.enteredQty, enteredUnitId: u.enteredUnitId,
        enteredUnitCode: u.enteredUnitCode, conversionFactorSnapshot: u.conversionFactorSnapshot,
      }));
    }

    const id = 'WT-' + Date.now();
    const [last] = await db.query('SELECT transfer_number FROM warehouse_transfers ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].transfer_number) { const m = last[0].transfer_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
    const transferNumber = 'TR-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO warehouse_transfers (id, transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, items_json, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, transferNumber, fromWarehouseId, toWarehouseId, new Date(), JSON.stringify(normItems), notes||'', username||'']
    );
    res.status(201).json({ success: true, id, transferNumber });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// v5.10.29 — Atomic approval. Wraps the whole operation in a transaction:
//   1. Validate every line: source qty must cover the requested qty (else 409 + rollback)
//   2. Decrement source warehouse_stock (UPSERT pattern preserved)
//   3. Increment destination warehouse_stock
//   4. Write inventory_movements rows for both sides (out from source, in to dest)
//   5. Mark transfer "completed"
// On any failure all writes roll back, so a partial transfer can never leave
// stock missing or duplicated.
router.post('/warehouse-transfers/:id/approve', MGR, async (req, res) => {
  try {
    // Phase 0 §5/§6 — managers only; approver from the JWT, never the body.
    const username = _actor(req);
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.status(404).json({ success: false, error: 'التحويل غير موجود' });
    const t = transfers[0];
    if (!req.guardTransfer(res, t.from_warehouse_id, t.to_warehouse_id)) return;
    if (t.status !== 'draft') return res.status(409).json({ success: false, error: 'التحويل ليس في حالة مسودة' });

    const items = JSON.parse(t.items_json || '[]').filter(x => x && x.itemId && Number(x.qty) > 0);
    if (!items.length) return res.status(400).json({ success: false, error: 'لا توجد بنود صالحة' });

    // (1) Pre-flight check: source must hold enough stock for every line.
    //     One COALESCE'd query per line — cheap and avoids transaction
    //     entry on a doomed approval.
    const insufficient = [];
    for (const item of items) {
      const [rows] = await db.query(
        'SELECT COALESCE(qty, 0) AS qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?',
        [t.from_warehouse_id, item.itemId]);
      const onHand = rows.length ? Number(rows[0].qty) : 0;
      const need   = Number(item.qty) || 0;
      if (onHand < need) {
        insufficient.push({ itemId: item.itemId, itemName: item.itemName || item.itemId, onHand, need });
      }
    }
    if (insufficient.length) {
      return res.status(409).json({
        success: false,
        error: 'رصيد المصدر غير كافٍ في بعض البنود',
        insufficient
      });
    }

    const runner = async (conn) => {
      const c = conn || db;
      const nowIso = new Date().toISOString().slice(0,19).replace('T',' ');
      const today  = nowIso.slice(0,10);

      for (const item of items) {
        const qty = Number(item.qty) || 0;
        if (qty <= 0) continue;

        // (2) decrement source — UPSERT keeps schema unchanged
        await c.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty - VALUES(qty), last_updated = VALUES(last_updated)',
          ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
           t.from_warehouse_id, item.itemId, qty, nowIso, today, username || '', nowIso]);

        // (3) increment destination
        await c.query(
          'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty), last_updated = VALUES(last_updated)',
          ['WS-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
           t.to_warehouse_id, item.itemId, qty, nowIso, today, username || '', nowIso]);

        // (4) movement log on both sides — keeps the warehouse ledger correct
        const itemName = item.itemName || '';
        const refNote  = 'تحويل ' + (t.transfer_number || t.id);
        try {
          await c.query(
            `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
             nowIso, item.itemId, itemName, 'out', qty,
             'تحويل صادر', username || '', refNote, t.from_warehouse_id]);
          await c.query(
            `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
             nowIso, item.itemId, itemName, 'in', qty,
             'تحويل وارد', username || '', refNote, t.to_warehouse_id]);
        } catch (_) { /* older schemas without warehouse_id; skip */ }
      }

      // (5) mark complete
      await c.query(
        'UPDATE warehouse_transfers SET status = "completed", approved_by = ?, approved_at = ? WHERE id = ?',
        [username || '', nowIso, req.params.id]);
    };

    try {
      if (typeof db.withTransaction === 'function') await db.withTransaction(runner);
      else await runner(null);
    } catch (txErr) {
      console.error('[warehouse-transfers/:id/approve] tx failed:', txErr.message);
      return res.status(500).json({ success: false, error: txErr.message });
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Warehouse Transfers: cancel + view lines (consolidated from legacy) ───

router.post('/warehouse-transfers/:id/cancel', MGR, async (req, res) => {
  try {
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.json({ success: false, error: 'التحويل غير موجود' });
    if (!req.guardTransfer(res, transfers[0].from_warehouse_id, transfers[0].to_warehouse_id)) return;
    if (transfers[0].status !== 'draft') return res.json({ success: false, error: 'لا يمكن إلغاء تحويل مكتمل' });
    await db.query('UPDATE warehouse_transfers SET status = "cancelled" WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/warehouse-transfer-lines/:id', async (req, res) => {
  try {
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id = ?', [req.params.id]);
    if (!transfers.length) return res.json([]);
    if (!req.guardTransfer(res, transfers[0].from_warehouse_id, transfers[0].to_warehouse_id)) return;
    const items = JSON.parse(transfers[0].items_json || '[]');
    res.json(items.map(item => ({
      itemId: item.itemId, itemName: item.itemName||'',
      qty: Number(item.qty)||0, cost: Number(item.cost)||0
    })));
  } catch(e) {
    // v7.5 — was res.json([]): a fault (or corrupt items_json — JSON.parse
    // throws here) read as "this transfer has no lines".
    console.error('[erp/warehouse-transfer-lines] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل سطور التحويل' });
  }
});

// ─── Brands: count linked branches + products ───
router.get('/brands-stats', async (req, res) => {
  try {
    const [brands] = await db.query('SELECT * FROM brands ORDER BY name');
    const result = [];
    for (const b of brands) {
      const [branchCount] = await db.query('SELECT COUNT(*) AS cnt FROM branches WHERE brand_id = ?', [b.id]);
      const [menuCount] = await db.query('SELECT COUNT(*) AS cnt FROM menu WHERE brand_id = ?', [b.id]);
      const [empCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_employees WHERE brand_id = ?', [b.id]);
      result.push({
        id: b.id, name: b.name, code: b.code, logo: b.logo, isActive: !!b.is_active,
        branchCount: branchCount[0].cnt, menuCount: menuCount[0].cnt, employeeCount: empCount[0].cnt
      });
    }
    res.json(result);
  } catch(e) {
    // v7.5 — was res.json([]): a DB fault rendered as "no brands".
    console.error('[erp/brands-stats] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر تحميل إحصاءات البراندات' });
  }
});

// ─── LEGACY WAREHOUSE CODE REMOVED — consolidated into /warehouses-list, /warehouse-transfers ───

// ─── Branches (enhanced) ───

// V5.9.4 — branches-full: previously the GET response omitted brandId, so the
// edit modal opened with the brand dropdown reset to "اختر البراند"; saving
// without re-selecting wiped brand_id. We now project every column the form
// reads, and the POST preserves columns the form does not send instead of
// silently rewriting them to defaults (notably `type`).
// v5.17.1 — /branches-full moved to routes/erp/branches-full.js

module.exports = router;
