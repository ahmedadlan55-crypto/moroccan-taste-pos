const router = require('express').Router();
const db = require('../db/connection');
const { ensureCoreAccounts } = require('../lib/glPosting');
// v5.11.1 — official 150-account COA template (mirrored from the Excel
// the user attached). Loaded once at boot, used by /gl/seed-from-template
// to seed or refresh the chart of accounts in one click.
const COA_TEMPLATE = require('../db/coa-template.json');
// v5.11.3 — developer-only guard for destructive journal endpoints.
const { guardDeveloper } = require('../lib/transactionGuards');
// FC-P1 — fine-grained GL capability guard (permissions_v3). Fails closed.
const requireCapability = require('../middleware/requireCapability');
// Phase 0 (Contracts & Safety) — managerial RBAC for warehouse master-data
// mutations (a warehouse with movement may never be hard-deleted) and for the
// legacy warehouse_transfers stock-moving endpoints.
const MGR = require('../middleware/auth').requireRole('admin', 'manager');
// Phase 0 §5 — actor identity from the authenticated JWT, never a body field.
function _actor(req) {
  return (req.user && (req.user.username || req.user.name)) || '';
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
    const [rows] = await q.query(
      `SELECT a.is_active,
              (NOT EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_id = a.id)) AS is_leaf
         FROM gl_accounts a WHERE a.id = ? LIMIT 1`,
      [accId]
    );
    if (!rows.length) return 'حساب غير موجود في أحد السطور';
    if (!(rows[0].is_active === 1 || rows[0].is_active === true)) return 'لا يمكن الترحيل إلى حساب معطَّل';
    if (!Number(rows[0].is_leaf)) return 'لا يمكن الترحيل إلى حساب رئيسي (اختر حسابًا فرعيًا)';
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
router.use(require('./erp/purchase-reports'));
router.use(require('./erp/branches-full'));
router.use(require('./erp/vat'));

// v5.17.2 — Financial reports: each report in its own sub-file. Every
// endpoint behavior is identical to the inline version — these files
// were extracted verbatim from routes/erp.js without behavior changes.
router.use(require('./erp/reports/trial-balance'));
router.use(require('./erp/reports/income'));
router.use(require('./erp/reports/balance-sheet'));
router.use(require('./erp/reports/cash-flow'));
router.use(require('./erp/reports/gl-ledger'));

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
       ORDER BY COALESCE(a.display_order, 99999), a.code`);
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
      taxNature:     a.tax_nature || 'none'
    })));
  } catch (e) {
    res.json([]);
  }
});

// v5.10.40 — toggle is_folder on an account. Refuses to demote a folder
// that still has children (data integrity).
router.post('/gl/accounts/:id/folder', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const { isFolder } = req.body;
    const want = !!isFolder;
    const [rows] = await db.query('SELECT id, code FROM gl_accounts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.json({ success: false, error: 'الحساب غير موجود' });
    // Block demotion of root accounts (codes 1-5) — they must always be folders
    if (!want && ['1','2','3','4','5'].indexOf(rows[0].code) >= 0) {
      return res.json({ success: false, error: 'لا يمكن تحويل حساب رئيسي إلى ورقة' });
    }
    if (!want) {
      const [kids] = await db.query('SELECT id FROM gl_accounts WHERE parent_id = ? LIMIT 1', [req.params.id]);
      if (kids.length) return res.json({ success: false, error: 'لا يمكن إلغاء الفولدر — احذف الأبناء أولاً' });
    }
    await db.query('UPDATE gl_accounts SET is_folder = ? WHERE id = ?', [want ? 1 : 0, req.params.id]);
    res.json({ success: true, id: req.params.id, isFolder: want });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.48 — bulk import COA from an Excel file. Match priority:
//   (1) by internal `id` (column "المعرف (لا تحذف)" in the export) —
//       this is THE way to avoid duplicates when codes change in Excel,
//       and the way structural edits (rename/reparent) actually take
//       effect on the existing row instead of creating a sibling.
//   (2) by `code` if id is missing (legacy / hand-built files).
//   (3) otherwise INSERT new.
//
// Side effects we keep consistent in the same transaction:
//   - When a row's code changes, gl_entries.account_code gets the new
//     code so reports and ledger views don't go stale.
//   - codeMap is updated as we go, so children reparented to a renamed
//     parent resolve to the right id within the same batch.
router.post('/gl/accounts/import', requireCapability('finance.accounts.manage'), async (req, res) => {
  const { rows } = req.body || {};
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
        const orderRaw = r['الترتيب'] != null ? r['الترتيب'] : (r.order != null ? r.order : r.displayOrder);
        let displayOrder = (orderRaw === '' || orderRaw == null || isNaN(Number(orderRaw))) ? null : Number(orderRaw);
        if (displayOrder == null) {
          const parentKey = String(parentId || '__ROOT__');
          positionByParent[parentKey] = (positionByParent[parentKey] || 0) + 1;
          displayOrder = positionByParent[parentKey];
        }

        // v5.10.50 — parent resolution: NAME first, code as fallback.
        // v5.10.53 — code lookup now consults fileCodeToTargetId first,
        // so a parent referenced by its NEW code (which is currently in
        // temp form thanks to Phase A) still resolves correctly.
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
          const r = resolveParentByCode(parentCode);
          if (r) { parentId = r; parentByCode++; }
          else { parentMissing++; errors.push({ id, code, reason: 'parent-code-not-found:' + parentCode }); }
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
});

// v5.10.50 — atomic dedupe: for each group {keepId, deleteIds[]} re-parent
// any children of the deletees to the keeper, refuse to delete any account
// that has gl_entries rows (would orphan the journal), then DELETE the
// rest. Reports counts so the UI can tell the user exactly what happened.
router.post('/gl/accounts/dedupe', requireCapability('finance.accounts.manage'), async (req, res) => {
  const { groups } = req.body || {};
  if (!Array.isArray(groups) || !groups.length) {
    return res.status(400).json({ success: false, error: 'لا توجد مجموعات للحذف' });
  }
  let deleted = 0, reparented = 0;
  const skipped = [];
  try {
    await db.withTransaction(async (conn) => {
      for (const g of groups) {
        const keepId = String(g.keepId || '').trim();
        const delIds = Array.isArray(g.deleteIds) ? g.deleteIds.map(String) : [];
        if (!keepId || !delIds.length) continue;
        // Ensure keepId actually exists
        const [keepRows] = await conn.query('SELECT id FROM gl_accounts WHERE id = ?', [keepId]);
        if (!keepRows.length) { skipped.push({ id: keepId, reason: 'keep-not-found' }); continue; }
        for (const did of delIds) {
          if (did === keepId) continue;
          // Refuse to delete if account has any gl_entries (would orphan
          // posted journal lines). User must merge entries manually.
          const [entries] = await conn.query('SELECT id FROM gl_entries WHERE account_id = ? LIMIT 1', [did]);
          if (entries.length) { skipped.push({ id: did, reason: 'has-journal-entries' }); continue; }
          // Re-parent any children of the deletee to the keeper.
          const [kids] = await conn.query('SELECT id FROM gl_accounts WHERE parent_id = ?', [did]);
          if (kids.length) {
            await conn.query('UPDATE gl_accounts SET parent_id = ? WHERE parent_id = ?', [keepId, did]);
            reparented += kids.length;
          }
          // Refuse if a journal HEADER references it as account_id (rare,
          // but defensive) — none of our journals reference accounts at
          // header level so this is a no-op in practice.
          await conn.query('DELETE FROM gl_accounts WHERE id = ?', [did]);
          deleted++;
          console.log('[gl/accounts/dedupe] deleted ' + did + ' (kept ' + keepId + ', reparented ' + kids.length + ' children)');
        }
      }
    });
    res.json({ success: true, deleted, reparented, skipped });
  } catch (e) {
    console.error('[gl/accounts/dedupe] FAILED:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// v5.10.45 — move an account under a new parent and (optionally) renumber
// its code based on the new parent's existing children. When renumbering,
// every descendant's code is rewritten with the new prefix in the same
// transaction, and gl_entries.account_code (denormalized) is kept in sync.
// Refuses to make an account its own ancestor (cycle protection).
router.post('/gl/accounts/:id/move', requireCapability('finance.accounts.manage'), async (req, res) => {
  const { id } = req.params;
  const { parentId, autoRenumber } = req.body || {};
  const willRenumber = !!autoRenumber;
  try {
    const result = await db.withTransaction(async (conn) => {
      const [accRows] = await conn.query('SELECT id, code, parent_id, level FROM gl_accounts WHERE id = ?', [id]);
      if (!accRows.length) throw new Error('الحساب غير موجود');
      const acc = accRows[0];
      if (['1','2','3','4','5'].indexOf(String(acc.code)) >= 0) {
        throw new Error('لا يمكن نقل حساب رئيسي (الجذور 1-5)');
      }

      let newParent = null;
      if (parentId) {
        const [pRows] = await conn.query('SELECT id, code, level FROM gl_accounts WHERE id = ?', [parentId]);
        if (!pRows.length) throw new Error('الأب الجديد غير موجود');
        newParent = pRows[0];
        if (newParent.id === id) throw new Error('لا يمكن جعل الحساب أبًا لنفسه');
        // Cycle check: walk up parentId's chain — if we hit `id`, abort.
        let walkerId = newParent.id, hops = 0; const seen = new Set();
        while (walkerId && hops < 50) {
          if (seen.has(walkerId)) break;
          seen.add(walkerId);
          if (walkerId === id) throw new Error('لا يمكن نقل الحساب تحت أحد أبنائه');
          const [up] = await conn.query('SELECT parent_id FROM gl_accounts WHERE id = ?', [walkerId]);
          if (!up.length || !up[0].parent_id) break;
          walkerId = up[0].parent_id;
          hops++;
        }
      }

      // Compute new code (and cascade to descendants) when autoRenumber=true
      const renumbered = [];
      let newCode = acc.code;
      if (willRenumber && newParent) {
        const [siblings] = await conn.query(
          'SELECT code FROM gl_accounts WHERE parent_id = ? ORDER BY code',
          [newParent.id]);
        if (!siblings.length) {
          newCode = (Number(newParent.level) >= 3) ? (newParent.code + '01') : (newParent.code + '1');
        } else {
          const last = siblings[siblings.length - 1].code;
          const suffix = last.substring(newParent.code.length);
          const nextNum = parseInt(suffix, 10) + 1;
          newCode = newParent.code + String(nextNum).padStart(suffix.length || 1, '0');
        }

        // Cascade rename: every descendant whose code starts with the
        // moving account's old code gets its prefix rewritten to newCode.
        const oldPrefix = acc.code;
        const [descRows] = await conn.query(
          'SELECT id, code FROM gl_accounts WHERE code LIKE ? AND id != ?',
          [oldPrefix + '%', id]);
        for (const d of descRows) {
          if (!String(d.code).startsWith(oldPrefix)) continue;
          const newDescCode = newCode + d.code.substring(oldPrefix.length);
          const [clash] = await conn.query('SELECT id FROM gl_accounts WHERE code = ? AND id != ?', [newDescCode, d.id]);
          if (clash.length) throw new Error('تعارض كود: ' + newDescCode + ' موجود مسبقًا');
          await conn.query('UPDATE gl_accounts SET code = ? WHERE id = ?', [newDescCode, d.id]);
          await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [newDescCode, d.id]);
          renumbered.push({ id: d.id, oldCode: d.code, newCode: newDescCode });
        }
      }

      // Apply main update
      const [mainClash] = await conn.query('SELECT id FROM gl_accounts WHERE code = ? AND id != ?', [newCode, id]);
      if (mainClash.length) throw new Error('تعارض كود: ' + newCode + ' موجود مسبقًا');
      const newLevel = newParent ? (Number(newParent.level) + 1) : 1;
      await conn.query(
        'UPDATE gl_accounts SET code = ?, parent_id = ?, level = ? WHERE id = ?',
        [newCode, parentId || null, newLevel, id]);
      await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [newCode, id]);
      renumbered.push({ id, oldCode: acc.code, newCode });

      console.log('[gl/move] ' + acc.code + ' -> ' + newCode + ' under ' + (newParent ? newParent.code : 'root') + ' (renumbered ' + renumbered.length + ')');
      return { renumbered, oldCode: acc.code, newCode, newParentId: parentId || null };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[gl/move] FAILED:', e.message);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/gl/accounts', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    const { id, code, nameAr, nameEn, type, parentId, level, isFolder, isActive } = req.body;
    // v5.10.46 — accept explicit isFolder flag from the frontend modal so
    // L1/L2 main accounts get is_folder=1 even before any child is added.
    const hasFolderFlag = (typeof isFolder === 'boolean');
    const folderInt = hasFolderFlag ? (isFolder ? 1 : 0) : null;
    // FC-P1 — is_active is written ATOMICALLY inside the INSERT/UPDATE below
    // (E1 previously used a separate statement, which could leave a new account
    // active on partial failure). Legacy callers omit isActive → COALESCE keeps
    // the stored value on UPDATE and defaults to active (1) on INSERT.
    const hasActiveFlag = (typeof isActive === 'boolean');
    const activeInt = hasActiveFlag ? (isActive ? 1 : 0) : null;

    if (id) {
      const [existing] = await db.query('SELECT id FROM gl_accounts WHERE id = ?', [id]);
      if (existing.length) {
        if (hasFolderFlag) {
          await db.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=?, is_folder=?, is_active=COALESCE(?, is_active) WHERE id=?',
            [code, nameAr, nameEn || '', type, parentId || null, level || 1, folderInt, activeInt, id]
          );
        } else {
          await db.query(
            'UPDATE gl_accounts SET code=?, name_ar=?, name_en=?, type=?, parent_id=?, level=?, is_active=COALESCE(?, is_active) WHERE id=?',
            [code, nameAr, nameEn || '', type, parentId || null, level || 1, activeInt, id]
          );
        }
        return res.json({ success: true, id });
      }
    }

    const newId = id || 'GL-' + Date.now();
    const newActive = hasActiveFlag ? activeInt : 1; // new accounts default active
    if (hasFolderFlag) {
      await db.query(
        'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_folder, is_active) VALUES (?,?,?,?,?,?,?,?,?)',
        [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1, folderInt, newActive]
      );
    } else {
      await db.query(
        'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,?,?)',
        [newId, code, nameAr, nameEn || '', type, parentId || null, level || 1, newActive]
      );
    }

    // v5.10.46 — auto-promote the parent to a folder when a child is
    // inserted under it at L3+ (parent.level >= 2 means new child is L3+).
    // This mirrors what _coaForceFolderConsistency does at deep-repair
    // time, but applies it to the insert hot-path so the user sees the
    // parent flip to folder immediately, without needing to run repair.
    if (parentId) {
      try {
        const [parentRows] = await db.query('SELECT level, is_folder FROM gl_accounts WHERE id = ?', [parentId]);
        if (parentRows.length && Number(parentRows[0].level) >= 2 && !parentRows[0].is_folder) {
          await db.query('UPDATE gl_accounts SET is_folder = 1 WHERE id = ?', [parentId]);
          console.log('[gl/accounts] auto-promoted parent ' + parentId + ' to folder (child at L' + ((Number(parentRows[0].level)||1) + 1) + ')');
        }
      } catch (e) {
        console.error('[gl/accounts] auto-promote parent failed:', e.message);
      }
    }

    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete GL account
router.delete('/gl/accounts/:id', requireCapability('finance.accounts.manage'), async (req, res) => {
  try {
    // Check if account has children
    const [children] = await db.query('SELECT id FROM gl_accounts WHERE parent_id = ?', [req.params.id]);
    if (children.length) return res.json({ success: false, error: 'لا يمكن حذف حساب لديه حسابات فرعية' });
    // Check if account has journal entries
    const [entries] = await db.query('SELECT id FROM gl_entries WHERE account_id = ? LIMIT 1', [req.params.id]);
    if (entries.length) return res.json({ success: false, error: 'لا يمكن حذف حساب مستخدم في قيود محاسبية' });
    await db.query('DELETE FROM gl_accounts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.11.1 — expose the official template as a static resource so the
// frontend can fetch it once and feed it through the existing import
// flow (preview modal + replace-mode + cascade rename). 150 accounts,
// 6 IFRS-aligned roots: Assets / Liabilities / Equity / Revenue /
// COGS / Operating & Admin Expenses.
router.get('/gl/coa-template', async (req, res) => {
  res.json({ success: true, accounts: COA_TEMPLATE });
});

// v5.11.9 — Hard wipe + reseed CoA + purge transactional history.
// User asked for a clean accounting foundation: previous journals + sales
// must go, then CoA is rebuilt fresh from the template. Master data
// (customers, suppliers, items, brands, branches, periods) is preserved.
// Differs from /gl/accounts/import?mode=replace which preserves accounts
// with posted journal entries — that guard is exactly why the user's
// bank stayed under inventory.
router.post('/gl/coa/wipe-and-seed', async (req, res) => {
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
        if (c === '343' || c.startsWith('343'))   return 'zakat';
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
        // (Output VAT Payable). The simplified CoA doesn't carry separate
        // input-VAT / GOSI / Withholding / EOSB / Zakat accounts — those
        // can be added by extending MM under group 20 / 50 as needed.
        if (/^\d{6}$/.test(c) && c.startsWith('2003')) return 'vat_output';
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
router.post('/gl/seed', async (req, res) => {
  try {
    const [existing] = await db.query('SELECT COUNT(*) AS cnt FROM gl_accounts');
    if (existing[0].cnt > 0) return res.json({ success: true, msg: 'already seeded' });

    const accounts = [
      // ═══ 1 الأصول ═══
      {code:'1',name:'الأصول',type:'asset',parent:null,level:1},
      {code:'11',name:'الأصول المتداولة',type:'asset',parent:'1',level:2},
      {code:'111',name:'النقدية والبنوك',type:'asset',parent:'11',level:3},
      {code:'11101',name:'عهدة الكاشير / صناديق نقاط البيع (POS)',type:'asset',parent:'111',level:4},
      {code:'11102',name:'الحسابات البنكية الجارية',type:'asset',parent:'111',level:4},
      {code:'112',name:'المخزون',type:'asset',parent:'11',level:3},
      {code:'11201',name:'مخزون المواد الخام (البن، الحليب، المنكهات)',type:'asset',parent:'112',level:4},
      {code:'11202',name:'مخزون المنتجات الجاهزة (المخبوزات، الحلويات)',type:'asset',parent:'112',level:4},
      {code:'11203',name:'مخزون مواد التغليف والتعبئة (الأكواب، الأكياس)',type:'asset',parent:'112',level:4},
      {code:'11204',name:'مخزون المنتجات تحت التشغيل (WIP)',type:'asset',parent:'112',level:4},
      {code:'11205',name:'مخزون المنتجات التامة (Finished Goods)',type:'asset',parent:'112',level:4},
      {code:'113',name:'الذمم المدينة والأرصدة',type:'asset',parent:'11',level:3},
      {code:'11301',name:'ذمم تطبيقات التوصيل (جاهز، هنقرستيشن..)',type:'asset',parent:'113',level:4},
      {code:'11302',name:'سلف ومقدمات الموظفين',type:'asset',parent:'113',level:4},
      {code:'11303',name:'إيجارات مدفوعة مقدماً',type:'asset',parent:'113',level:4},
      // v5.10.61 — مخصص الديون المشكوك في تحصيلها (contra-asset under 113).
      // Recognized by name keyword "مخصص" + the contra-classification
      // logic added in the Balance Sheet build below.
      {code:'1131',name:'مخصص الديون المشكوك في تحصيلها',type:'asset',parent:'113',level:4},
      {code:'114',name:'ضريبة المدخلات',type:'asset',parent:'11',level:3},
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
      {code:'52',name:'المصروفات التشغيلية',type:'expense',parent:'5',level:2},
      {code:'521',name:'الرواتب والأجور',type:'expense',parent:'52',level:3},
      // v5.10.61 — sub-accounts under 521 so payroll postings can be
      // segregated by role/function (matches the granularity of 522/523/524).
      {code:'5211',name:'رواتب الإدارة والمحاسبة',type:'expense',parent:'521',level:4},
      {code:'5212',name:'رواتب الكاشيرز والباريستا',type:'expense',parent:'521',level:4},
      {code:'5213',name:'رواتب الإنتاج (الباستري)',type:'expense',parent:'521',level:4},
      {code:'5214',name:'مكافآت وحوافز',type:'expense',parent:'521',level:4},
      {code:'5215',name:'تأمينات اجتماعية (GOSI)',type:'expense',parent:'521',level:4},
      {code:'522',name:'الإيجارات والمنافع',type:'expense',parent:'52',level:3},
      {code:'5221',name:'إيجارات الفروع',type:'expense',parent:'522',level:4},
      {code:'5222',name:'الكهرباء والماء',type:'expense',parent:'522',level:4},
      {code:'5223',name:'اشتراكات الإنترنت والاتصالات',type:'expense',parent:'522',level:4},
      {code:'523',name:'التشغيل والصيانة',type:'expense',parent:'52',level:3},
      {code:'5231',name:'صيانة مكائن القهوة والمعدات',type:'expense',parent:'523',level:4},
      {code:'5232',name:'أدوات النظافة والتعقيم',type:'expense',parent:'523',level:4},
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
async function _repairInventoryClassification(db) {
  const repaired = [];
  // Resolve target parent (112 المخزون). If missing, try to create it under 11.
  let [p112] = await db.query("SELECT id FROM gl_accounts WHERE code = '112'");
  let target112Id = p112.length ? p112[0].id : null;
  if (!target112Id) {
    const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11'");
    if (p11.length) {
      target112Id = 'GL-112';
      await db.query(
        "INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)",
        [target112Id, '112', 'المخزون', 'asset', p11[0].id, 3]
      );
    }
  }
  if (!target112Id) return { ok: false, reason: 'no-parent-112', repaired };

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
    if (a.code === '112') return '112';
    if (!a.parent_id) return a.code;
    return ancestorCode(a.parent_id, depth + 1);
  }
  for (const a of allAcc) {
    if (!inventoryRegex.test(a.name_ar || '')) continue;
    if (a.code === '112') continue;            // skip the target parent itself
    if (String(a.code).startsWith('112')) continue; // already correct
    const anc = ancestorCode(a.parent_id);
    if (anc === '12') {
      // Misclassified — re-parent to 112
      await db.query("UPDATE gl_accounts SET parent_id = ? WHERE id = ?", [target112Id, a.id]);
      repaired.push({ id: a.id, code: a.code, name: a.name_ar, oldParent: a.parent_id, newParent: target112Id });
    }
  }
  return { ok: true, repaired };
}
// Expose helper on the router so server.js can run it at boot
router._repairInventoryClassification = _repairInventoryClassification;

router.post('/gl/repair-inventory-classification', async (req, res) => {
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
router.post('/gl/repair-classification', async (req, res) => {
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
    const expectedLevel = preferredParent.code.length + 1
                       || (Number(preferredParent.level) || 1) + 1;
    // Use the preferred parent's level + 1 — more reliable than code.length
    // for non-strict numeric codes.
    const targetLevel = (Number(preferredParent.level) || 1) + 1;

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

  return { repaired, skipped };
}
// Export so server.js / boot scripts can run it idempotently if needed.
router._repairCoaByPrefix = _repairCoaByPrefix;

router.post('/gl/repair-tree-by-prefix', async (req, res) => {
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

function _coaComputeDepth(byId, a, seen) {
  if (!a || !a.parent_id) return 0;
  if (seen.has(a.id)) return 0;
  seen.add(a.id);
  const p = byId[a.parent_id];
  return p ? _coaComputeDepth(byId, p, seen) + 1 : 0;
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
  for (const a of allAccs) {
    const seen = new Set();
    let walker = a, hops = 0, cycled = false;
    while (walker && walker.parent_id) {
      if (seen.has(walker.id)) { cycled = true; break; }
      seen.add(walker.id);
      walker = byId[walker.parent_id] || null;
      if (++hops > 50) break;
    }
    if (cycled) { cycles++; continue; }
    const d = _coaComputeDepth(byId, a, new Set());
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

async function _coaAutoFixLevels(db) {
  let orphansPromoted = 0, levelsCorrected = 0;
  const [orphans] = await db.query(
    `SELECT a.id FROM gl_accounts a
      WHERE a.parent_id IS NOT NULL
        AND a.parent_id NOT IN (SELECT id FROM (SELECT id FROM gl_accounts) p)`);
  for (const o of orphans) {
    await db.query('UPDATE gl_accounts SET parent_id = NULL, level = 0 WHERE id = ?', [o.id]);
    orphansPromoted++;
  }
  const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
  const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
  for (const a of allAccs) {
    const d = _coaComputeDepth(byId, a, new Set());
    if (Number(a.level || 0) !== d) {
      await db.query('UPDATE gl_accounts SET level = ? WHERE id = ?', [d, a.id]);
      levelsCorrected++;
    }
  }
  return { orphansPromoted, levelsCorrected };
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
router.post('/gl/deep-repair', async (req, res) => {
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

      lastStep = 'autoFixLevels';
      const lvl = await _coaAutoFixLevels(conn);
      console.log('[deep-repair] step 6: autoFixLevels → ' + lvl.orphansPromoted + ' orphans promoted, ' + lvl.levelsCorrected + ' levels corrected');

      lastStep = 'recomputeBalances';
      const balRecomp = await _coaRecomputeBalances(conn);
      console.log('[deep-repair] step 7: recomputeBalances → ' + balRecomp + ' balances rebuilt from gl_entries');

      // v5.10.44 — last-resort topology guarantee. If any account is still
      // in the wrong root subtree after the smart helpers, force-reparent
      // it directly under the correct root. Better flat-but-correct than
      // hierarchical-but-wrong.
      lastStep = 'bruteForceTopology';
      const brute = await _coaBruteForceRootTopology(conn);
      console.log('[deep-repair] step 7.5: bruteForceTopology → ' + brute.moved.length + ' force-reparented, missingRoots=[' + (brute.missingRoots || []).join(',') + ']');

      lastStep = 'forceFolderConsistency';
      const folderFixes = await _coaForceFolderConsistency(conn);
      console.log('[deep-repair] step 8: forceFolderConsistency → roots=' + folderFixes.roots + ' parents=' + folderFixes.parents);

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
    res.json([]);
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
    const journalId = 'JRN-' + Date.now();

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
    let journalNumber = '';
    await db.withTransaction(async (conn) => {
      const [lastJ] = await conn.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1 FOR UPDATE');
      let nextNum = 1;
      if (lastJ.length && lastJ[0].journal_number) {
        const match = lastJ[0].journal_number.match(/(\d+)/);
        if (match) nextNum = parseInt(match[1]) + 1;
      }
      journalNumber = 'JV-' + String(nextNum).padStart(6, '0');

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
    await auditLog('create_journal', 'gl_journal', journalId, actor,
      { journalNumber, totalDebit, totalCredit, description,
        brandId: brandId || null, branchId: branchId || null,
        projectId: projectId || null, costCenterId: costCenterId || null },
      req.ip);

    // Note: balances NOT updated yet — only on "post"
    res.json({ success: true, id: journalId, journalNumber });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Approve journal (draft → approved)
router.post('/gl/journals/:id/approve', requireCapability('finance.gl.approve'), async (req, res) => {
  try {
    const actor = _actor(req); // FC-P1 — actor from JWT
    const out = await db.withTransaction(async (conn) => {
      const [jrn] = await conn.query('SELECT status FROM gl_journals WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!jrn.length) return { error: 'القيد غير موجود' };
      if (jrn[0].status !== 'draft') return { error: 'فقط القيود المسودة يمكن اعتمادها' };
      await conn.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?',
        [actor, new Date(), req.params.id]);
      return { ok: true };
    });
    if (out.error) return res.json({ success: false, error: out.error });
    await auditLog('approve_journal', 'gl_journal', req.params.id, actor, {}, req.ip);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// V5.10.0 — Accounting periods: list / create / open / close / soft-close.
// The schema already exists (server.js:2382). These endpoints expose it.
router.get('/periods', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, company_id, period_name, start_date, end_date, status, closed_by, closed_at, notes
       FROM accounting_periods
       ORDER BY start_date DESC LIMIT 200`);
    res.json(rows.map(r => ({
      id: r.id, periodName: r.period_name, startDate: r.start_date, endDate: r.end_date,
      status: r.status, closedBy: r.closed_by || '', closedAt: r.closed_at, notes: r.notes || ''
    })));
  } catch(e) { res.json([]); }
});

router.post('/periods', async (req, res) => {
  try {
    const { id, periodName, startDate, endDate, notes } = req.body || {};
    if (!periodName || !startDate || !endDate) return res.json({ success:false, error: 'الاسم والتواريخ مطلوبة' });
    if (id) {
      await db.query(
        `UPDATE accounting_periods SET period_name=?, start_date=?, end_date=?, notes=? WHERE id=?`,
        [periodName, startDate, endDate, notes||null, id]);
      return res.json({ success:true, id });
    }
    const newId = 'PER-' + Date.now();
    await db.query(
      `INSERT INTO accounting_periods (id, company_id, period_name, start_date, end_date, status, notes)
       VALUES (?, 'CO-MAIN', ?, ?, ?, 'open', ?)`,
      [newId, periodName, startDate, endDate, notes||null]);
    res.json({ success:true, id:newId });
  } catch(e) { res.json({ success:false, error:e.message }); }
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
router.post('/periods/:id/lock', async (req, res) => {
  try {
    const { status, username } = req.body || {};
    if (!['open','soft_closed','closed'].includes(status)) {
      return res.json({ success:false, error:'الحالة غير صالحة' });
    }
    const [p] = await db.query('SELECT * FROM accounting_periods WHERE id=?', [req.params.id]);
    if (!p.length) return res.json({ success:false, error:'الفترة غير موجودة' });
    const period = p[0];
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
      await db.query('UPDATE accounting_periods SET status=?, closed_by=NULL, closed_at=NULL WHERE id=?',
        [status, req.params.id]);
    } else {
      await db.query('UPDATE accounting_periods SET status=?, closed_by=?, closed_at=NOW() WHERE id=?',
        [status, username||'', req.params.id]);
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

// V5.10.0 — Helper: refuse to post into a closed accounting period.
// `closed` periods are hard-locked (no posting at all). `soft_closed`
// allows admin override via {force:true}. `open` periods accept any post.
async function _checkPeriodOpen(journalDate, allowForce) {
  if (!journalDate) return { ok: true };
  const [p] = await db.query(
    `SELECT id, period_name, status FROM accounting_periods
     WHERE start_date <= ? AND end_date >= ? LIMIT 1`,
    [journalDate, journalDate]);
  if (!p.length) return { ok: true }; // no period defined for that date — allow
  const period = p[0];
  if (period.status === 'open') return { ok: true, period };
  if (period.status === 'soft_closed' && allowForce) return { ok: true, period, forced: true };
  return {
    ok: false,
    period,
    error: period.status === 'closed'
      ? `لا يمكن الترحيل: الفترة «${period.period_name}» مُقفلة نهائياً.`
      : `الفترة «${period.period_name}» مُقفلة (إقفال مبدئي). تواصل مع المحاسب الرئيسي للسماح بالترحيل.`
  };
}

// Post journal (approved → posted) — updates account balances
router.post('/gl/journals/:id/post', requireCapability('finance.gl.post'), async (req, res) => {
  try {
    const { force } = req.body || {};
    const actor = _actor(req); // FC-P1 — actor from JWT
    // FC-P1 — the whole post runs inside ONE transaction with the journal row
    // LOCKED (SELECT … FOR UPDATE) and the status re-checked under the lock, so
    // two concurrent posts can never both apply the balances (double-post race).
    const out = await db.withTransaction(async (conn) => {
      const [jrn] = await conn.query('SELECT status, journal_date FROM gl_journals WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!jrn.length) return { error: 'القيد غير موجود' };
      if (jrn[0].status !== 'approved') return { error: 'يجب اعتماد القيد أولاً قبل الترحيل' };

      // V5.10.0 — period lock guard
      const guard = await _checkPeriodOpen(jrn[0].journal_date, !!force);
      if (!guard.ok) return { error: guard.error };

      // Apply balances — sorted by account id so concurrent posters take the
      // per-account row locks in a consistent order (matches lib/glPosting).
      const [entries] = await conn.query(
        'SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ? AND account_id IS NOT NULL ORDER BY account_id',
        [req.params.id]
      );
      for (const e of entries) {
        const netAmount = (Number(e.debit) || 0) - (Number(e.credit) || 0);
        await conn.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [netAmount, e.account_id]);
      }
      await conn.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?',
        [actor, new Date(), req.params.id]);
      return { ok: true };
    });
    if (out.error) return res.json({ success: false, error: out.error });
    await auditLog('post_journal', 'gl_journal', req.params.id, actor, {}, req.ip);
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
router.post('/gl/journals/:id/reverse', requireCapability('finance.gl.reverse'), async (req, res) => {
  try {
    const result = await db.withTransaction(async (conn) => {
      // 1. Lock the original
      const [orig] = await conn.query(
        'SELECT * FROM gl_journals WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!orig.length) {
        const err = new Error('original-not-found'); err.status = 404; throw err;
      }
      const j = orig[0];
      if (j.status !== 'posted') {
        const err = new Error('only-posted-journals-can-be-reversed');
        err.status = 400; throw err;
      }
      if (j.reversed_by_journal_id) {
        const err = new Error('already-reversed'); err.status = 400; throw err;
      }

      // 2. Load original entries
      const [entries] = await conn.query(
        'SELECT * FROM gl_entries WHERE journal_id = ? ORDER BY id',
        [j.id]
      );
      if (!entries.length) {
        const err = new Error('original-has-no-entries'); err.status = 400; throw err;
      }

      // 3. Build mirrored set — DEBIT ↔ CREDIT swap, dimensions preserved
      const username = _actor(req) || 'system'; // FC-P1 — actor from JWT only
      const reason = String((req.body && req.body.reason) || 'correction').slice(0, 200);
      const reversedEntries = entries.map(function (e) {
        return {
          accountCode:  e.account_code,
          debit:        Number(e.credit) || 0,
          credit:       Number(e.debit)  || 0,
          description:  'REVERSAL of ' + (j.journal_number || j.id) +
                        (reason ? ' — ' + reason : ''),
          brandId:      e.brand_id     || null,
          branchId:     e.branch_id    || null,
          projectId:    e.project_id   || null,
          costCenterId: e.cost_center_id || null,
          warehouseId:  e.warehouse_id || null
        };
      });

      // 4. Post the reversal — use the existing helper so journal-number
      //    sequencing, balance updates, and audit fields all flow the
      //    same way real journals do.
      const gl = require('../lib/glPosting');
      const post = await gl.postJournal(conn, {
        journalDate:   new Date().toISOString().slice(0, 10),
        description:   'REVERSAL of ' + (j.journal_number || j.id) + ' — ' + reason,
        referenceType: 'reversal',
        referenceId:   j.id,
        entries:       reversedEntries,
        postedBy:      username
      });
      if (!post || !post.success) {
        throw new Error('reversal-post-failed: ' + ((post && post.error) || 'unknown'));
      }

      // 5. Link both rows for the audit trail
      try {
        await conn.query(
          'UPDATE gl_journals SET reversed_by_journal_id = ?, reversed_at = NOW(), reversed_by = ? WHERE id = ?',
          [post.journalId, username, j.id]
        );
        await conn.query(
          'UPDATE gl_journals SET reverses_journal_id = ? WHERE id = ?',
          [j.id, post.journalId]
        );
      } catch (_) { /* schema may not have the columns on a very old deploy — non-fatal */ }

      return {
        originalJournalId:     j.id,
        originalJournalNumber: j.journal_number,
        newJournalId:          post.journalId,
        newJournalNumber:      post.journalNumber,
        reason:                reason
      };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
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
  } catch (e) { res.json([]); }
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

    await auditLog('update_journal', 'gl_journal', journalId, actor,
      { brandId: out.effBrand, branchId: out.effBranch, projectId: out.effProject, costCenterId: out.effCC,
        totalDebit, totalCredit, lineCount: (entries || []).length }, req.ip);

    res.json({ success: true, journalNumber: out.journalNumber, reposted: false });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.11.0 — bulk action endpoint. Accepts { ids:[], action:'approve|post|unpost|delete', username }.
// Per-id outcome is reported so the UI can show partial-failure states.
// Each action goes through the same gating as its single-id counterpart;
// posted journals are protected by the same rules.
router.post('/gl/journals/bulk', requireCapability('finance.gl.view'), async (req, res) => {
  const { ids, action } = req.body || {};
  const actor = _actor(req); // FC-P1 — actor from JWT
  if (!Array.isArray(ids) || !ids.length) return res.json({ success: false, error: 'لا توجد قيود محدَّدة' });
  // FC-P1 — 'unpost' is gone (posted journals are immutable; use reverse).
  const allowed = ['approve','post','delete','approve_post'];
  if (allowed.indexOf(action) < 0) return res.json({ success: false, error: 'إجراء غير مدعوم' });

  // FC-P1 — enforce the SAME capability the single-id route requires, per action.
  const capFor = { approve: 'finance.gl.approve', post: 'finance.gl.post', approve_post: 'finance.gl.post' };
  if (capFor[action]) {
    const okCap = await requireCapability.hasCapability(req.user, capFor[action]);
    if (!okCap) return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لهذه العملية' });
  }
  // Bulk delete stays developer-only (matches the single DELETE guard).
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
    try {
      // FC-P1 — each id is processed under its own row lock inside a txn, with
      // the status re-checked in the lock (no bulk double-post race).
      const r = await db.withTransaction(async (conn) => {
        const [rows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [id]);
        if (!rows.length) return { ok: false, reason: 'not-found' };
        const jrn = rows[0];
        if (action === 'approve') {
          if (jrn.status !== 'draft') return { ok: false, reason: 'not-draft' };
          await conn.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?', [actor, new Date(), id]);
          return { ok: true, audit: 'approve_journal' };
        } else if (action === 'approve_post' || action === 'post') {
          if (action === 'approve_post' && jrn.status !== 'draft') return { ok: false, reason: 'not-draft' };
          if (action === 'post' && jrn.status === 'posted') return { ok: false, reason: 'already-posted' };
          if (action === 'post' && jrn.status !== 'approved') return { ok: false, reason: 'not-approved' };
          if (action === 'approve_post') {
            await conn.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?', [actor, new Date(), id]);
          }
          const [entries] = await conn.query('SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ? AND account_id IS NOT NULL ORDER BY account_id', [id]);
          for (const e of entries) {
            const net = (Number(e.debit) || 0) - (Number(e.credit) || 0);
            await conn.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, e.account_id]);
          }
          await conn.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?', [actor, new Date(), id]);
          return { ok: true, audit: action === 'approve_post' ? 'approve_post_journal' : 'post_journal' };
        } else if (action === 'delete') {
          if (jrn.status === 'posted') return { ok: false, reason: 'is-posted-needs-reverse' };
          await conn.query('DELETE FROM gl_entries WHERE journal_id = ?', [id]);
          await conn.query('DELETE FROM gl_journals WHERE id = ?', [id]);
          return { ok: true, audit: 'delete_journal' };
        }
        return { ok: false, reason: 'unsupported' };
      });
      if (r.ok) { await auditLog(r.audit, 'gl_journal', id, actor, { bulk: true }, req.ip); results.push({ id, ok: true }); ok++; }
      else { results.push({ id, ok: false, reason: r.reason }); failed++; }
    } catch (e) {
      results.push({ id, ok: false, reason: e.message });
      failed++;
    }
  }
  console.log('[gl/journals/bulk] action=' + action + ' total=' + ids.length + ' ok=' + ok + ' failed=' + failed);
  res.json({ success: true, action, ok, failed, results });
});

// Delete journal — reverse balances then delete.
// v5.11.3 — gated behind guardDeveloper so only the developer/admin
// role can erase journal records. Frontend hides the button for
// everyone else; this is the server-side safety net for direct calls.
router.delete('/gl/journals/:id', guardDeveloper, async (req, res) => {
  try {
    // FC-P1 — atomic: reverse balances + delete under the journal-row lock.
    await db.withTransaction(async (conn) => {
      const [jrn] = await conn.query('SELECT id FROM gl_journals WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!jrn.length) return;
      const [entries] = await conn.query('SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ? AND account_id IS NOT NULL ORDER BY account_id', [req.params.id]);
      for (const e of entries) {
        const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
        await conn.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [reverseAmount, e.account_id]);
      }
      await conn.query('DELETE FROM gl_entries WHERE journal_id = ?', [req.params.id]);
      await conn.query('DELETE FROM gl_journals WHERE id = ?', [req.params.id]);
    });
    await auditLog('delete_journal', 'gl_journal', req.params.id, _actor(req), {}, req.ip);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Repair: fix gl_entries with NULL account_id by matching account_code
router.post('/gl/repair', async (req, res) => {
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
            // Ensure parent account exists
            const parentCode = '1130';
            const [parentRow] = await db.query('SELECT id FROM gl_accounts WHERE code = ?', [parentCode]);
            let parentId = null;
            if (!parentRow.length) {
              const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' OR code = '113' ORDER BY code DESC LIMIT 1");
              parentId = p11.length ? p11[0].id : null;
              await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
                ['GL-1130', '1130', 'عهد الموظفين', 'asset', parentId, 3]);
              parentId = 'GL-1130';
            } else { parentId = parentRow[0].id; }
            // Create child account
            const [children] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '1130%' AND code != '1130' ORDER BY code DESC LIMIT 1");
            let nextCode = '11301';
            if (children.length) { nextCode = '1130' + String((parseInt(children[0].code.replace('1130',''))||0) + 1); }
            const newId = 'GL-' + nextCode;
            await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
              [newId, nextCode, entry.account_name, 'asset', parentId, 4]);
            accId = newId;
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
router.post('/gl/fix-tree', async (req, res) => {
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

router.post('/gl/repair-topups', async (req, res) => {
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
      const [custAccRows] = await db.query("SELECT id, code FROM gl_accounts WHERE name_ar LIKE ? AND code LIKE '1130%'", ['عهدة ' + (t.user_name||'').substring(0,20) + '%']);
      if (custAccRows.length) custAccId = custAccRows[0].id;
      if (!custAccId) {
        // Create it
        const parentId = 'GL-1130';
        await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
          [parentId, '1130', 'عهد الموظفين', 'asset', null, 3]);
        const [children] = await db.query("SELECT code FROM gl_accounts WHERE code LIKE '1130%' AND code != '1130' ORDER BY code DESC LIMIT 1");
        let nextCode = '11301';
        if (children.length) nextCode = '1130' + String((parseInt(children[0].code.replace('1130',''))||0)+1);
        custAccId = 'GL-' + nextCode;
        await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
          [custAccId, nextCode, 'عهدة ' + (t.user_name||''), 'asset', parentId, 4]);
      }

      // Find a default cash account for old topups (11101)
      let cashAccId = null;
      const [cashAcc] = await db.query("SELECT id FROM gl_accounts WHERE code = '11101' OR (code LIKE '1110%' AND type='asset') ORDER BY code LIMIT 1");
      if (cashAcc.length) cashAccId = cashAcc[0].id;

      if (!custAccId) continue;

      const jrnId = 'JRN-REPAIR-' + Date.now() + '-' + created;
      const [lastJrn] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
      let jrnNum = 1;
      if (lastJrn.length && lastJrn[0].journal_number) {
        const m = lastJrn[0].journal_number.match(/(\d+)/);
        if (m) jrnNum = parseInt(m[1]) + 1;
      }
      const journalNumber = 'JV-' + String(jrnNum).padStart(6, '0');
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
router.get('/gl/diagnose', async (req, res) => {
  try {
    const CORE_CODES = ['1110','1120','1150','1200','2100','2210','3100','4100','5100','5200','5300'];

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
    const [allAccs] = await db.query('SELECT id, code, name_ar, parent_id, level FROM gl_accounts');
    const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
    const computeDepth = function(a, seen) {
      if (!a || !a.parent_id) return 0;
      if (seen.has(a.id)) return -1; // cycle
      seen.add(a.id);
      const p = byId[a.parent_id];
      if (!p) return 0;  // orphan; treat as root
      const d = computeDepth(p, seen);
      return d < 0 ? d : d + 1;
    };
    const levelMismatch = [];
    const cycles = [];
    for (const a of allAccs) {
      const d = computeDepth(a, new Set());
      if (d < 0) { cycles.push({ id: a.id, code: a.code, name_ar: a.name_ar }); continue; }
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
router.post('/gl/auto-fix', async (req, res) => {
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

    // 2. Recompute levels for everyone
    const [allAccs] = await db.query('SELECT id, parent_id, level FROM gl_accounts');
    const byId = {}; allAccs.forEach(a => { byId[a.id] = a; });
    const depth = function(a, seen) {
      if (!a || !a.parent_id) return 0;
      if (seen.has(a.id)) return 0;
      seen.add(a.id);
      const p = byId[a.parent_id];
      return p ? depth(p, seen) + 1 : 0;
    };
    for (const a of allAccs) {
      const d = depth(a, new Set());
      if (Number(a.level || 0) !== d) {
        await db.query('UPDATE gl_accounts SET level = ? WHERE id = ?', [d, a.id]);
        result.levelsCorrected++;
      }
    }

    res.json({ success: true, ...result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Inventory Method & Valuation ───

// Get/Set inventory method
router.get('/inventory-method', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_method'");
    res.json({ method: rows.length ? rows[0].setting_value : 'perpetual' });
  } catch(e) { res.json({ method: 'perpetual' }); }
});
router.post('/inventory-method', async (req, res) => {
  try {
    const { method } = req.body;
    if (!['perpetual','periodic'].includes(method)) return res.json({ success: false, error: 'Invalid method' });
    await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('inventory_method',?) ON DUPLICATE KEY UPDATE setting_value=?", [method, method]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
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

// v5.10.88 — Resolve the inventory CoA parent. Priority:
//   1. settings.inventory_coa_parent_id (if the row exists in gl_accounts)
//   2. Auto-detect: '100300' (GGMMPP) → '113' (legacy) → '112' (older)
// Returns { id, code, level, name_ar, source } or null if nothing matches.
async function _resolveInventoryParent(opts) {
  opts = opts || {};
  if (!opts.ignoreSetting) {
    const [pset] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_coa_parent_id' LIMIT 1");
    const savedId = pset.length ? String(pset[0].setting_value || '') : '';
    if (savedId) {
      const [row] = await db.query('SELECT id, code, name_ar, level, type FROM gl_accounts WHERE id = ? LIMIT 1', [savedId]);
      if (row.length) return Object.assign({}, row[0], { source: 'setting' });
    }
  }
  // Auto-detect — prefer GGMMPP, then legacy fallbacks
  for (const code of ['100300', '113', '112']) {
    const [r] = await db.query('SELECT id, code, name_ar, level, type FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
    if (r.length) return Object.assign({}, r[0], { source: 'auto-detect' });
  }
  return null;
}

// v5.10.88 — GET /inventory-coa-parent
// Returns the resolved parent + the raw setting (if any) so the UI
// can show a mismatch banner when the saved id no longer resolves.
// Query param ?reset=1 ignores the setting and runs auto-detect only.
router.get('/inventory-coa-parent', async (req, res) => {
  try {
    const ignoreSetting = String(req.query.reset || '') === '1';
    const [pset] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_coa_parent_id' LIMIT 1");
    const savedId = pset.length ? String(pset[0].setting_value || '') : null;
    const [pcode] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'inventory_coa_parent_code' LIMIT 1");
    const savedCode = pcode.length ? String(pcode[0].setting_value || '') : null;
    const resolved = await _resolveInventoryParent({ ignoreSetting });
    let childrenCount = 0;
    if (resolved && resolved.id) {
      const [kids] = await db.query('SELECT COUNT(*) AS n FROM gl_accounts WHERE parent_id = ?', [resolved.id]);
      childrenCount = Number(kids[0].n) || 0;
    }
    res.json({
      success: true,
      settingId: savedId,
      settingCode: savedCode,
      resolved: resolved ? {
        id: resolved.id,
        code: resolved.code,
        nameAr: resolved.name_ar,
        level: resolved.level,
        type: resolved.type,
        childrenCount: childrenCount
      } : null,
      source: resolved ? resolved.source : null
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// v5.10.88 — Sync inventory CoA accounts. Reads its parent from
// settings via _resolveInventoryParent so the owner can re-target
// the auto-numbering through the UI. Sub-account codes follow the
// parent's prefix style:
//   • 6-digit GGMMPP parent (e.g. 100300) → 1003 PP slots
//     (100310, 100320, 100330, 100340, …). Used by the v5.10.85+
//     Saudi/International standard CoA.
//   • 3-digit legacy parent (e.g. 113) → 113xx 2-digit suffix
//     (11301, 11302, …) preserved for backward-compat.
router.post('/gl/sync-inventory', async (req, res) => {
  try {
    let parent = await _resolveInventoryParent();
    // Fall back: if nothing resolved, create '113' under '11' (legacy)
    if (!parent) {
      const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11'");
      const parentId = 'GL-113';
      await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [parentId, '113', 'المخزون', 'asset', p11.length ? p11[0].id : null, 3]);
      parent = { id: parentId, code: '113', name_ar: 'المخزون', level: 3, type: 'asset', source: 'created' };
    }

    const parentId = parent.id;
    const parentCode = String(parent.code || '');
    const parentLevel = Number(parent.level || 2);
    const childLevel = parentLevel + 1;

    // Determine code template for new children based on parent style
    // GGMMPP (6 digits): siblings of 100310/100320/…  use PP slot iteration
    //                    on the parent's first 4 chars (1003) + 2-digit PP
    // Legacy (3 chars):  '113' + 2-digit suffix → 11301, 11302, …
    const isGgmmpp = /^\d{6}$/.test(parentCode);
    const childPrefix = isGgmmpp ? parentCode.substr(0, 4) : parentCode;
    const childCodeRegex = isGgmmpp
      ? '^' + childPrefix + '[0-9]{2}$'
      : '^' + childPrefix + '[0-9]{2}$';

    // Get inventory categories
    const [cats] = await db.query('SELECT DISTINCT category FROM inv_items WHERE active = 1 AND category IS NOT NULL AND category != ""');
    let created = 0;

    const [existing] = await db.query(
      "SELECT code, name_ar FROM gl_accounts WHERE code REGEXP ? ORDER BY code",
      [childCodeRegex]
    );
    const existingNames = existing.map(e => (e.name_ar || '').toLowerCase());

    for (const cat of cats) {
      const catName = 'مخزون ' + cat.category;
      if (existingNames.includes(catName.toLowerCase())) continue;

      // Next code in the child-prefix range
      const [lastChild] = await db.query(
        "SELECT code FROM gl_accounts WHERE code REGEXP ? ORDER BY code DESC LIMIT 1",
        [childCodeRegex]
      );
      let nextCode;
      if (lastChild.length) {
        const suffix = lastChild[0].code.substr(childPrefix.length);
        const num = parseInt(suffix, 10) || 0;
        nextCode = childPrefix + String(num + 1).padStart(2, '0');
      } else {
        nextCode = childPrefix + '01';
      }
      const id = 'GL-' + nextCode;
      await db.query(
        'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level) VALUES (?,?,?,?,?,?)',
        [id, nextCode, catName, 'asset', parentId, childLevel]
      );

      // Update balance with current stock value for this category
      const [catItems] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE category = ? AND active = 1', [cat.category]);
      const catValue = Number(catItems[0].val) || 0;
      if (catValue > 0) await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [catValue, id]);
      existingNames.push(catName.toLowerCase());
      created++;
    }

    // Update ALL existing inventory sub-account balances (perpetual sync).
    // We match descendants of the resolved parent, not a hardcoded prefix.
    const [allInvAccounts] = await db.query(
      "SELECT id, name_ar FROM gl_accounts WHERE parent_id = ? AND id <> ?",
      [parentId, parentId]
    );
    for (const acc of allInvAccounts) {
      const catName = (acc.name_ar || '').replace(/^مخزون\s*/, '');
      if (catName) {
        const [catVal] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE category = ? AND active = 1', [catName]);
        await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [Number(catVal[0].val) || 0, acc.id]);
      }
    }

    // Update parent balance (total of all active inventory)
    const [totalVal] = await db.query('SELECT SUM(stock * cost) AS val FROM inv_items WHERE active = 1');
    await db.query('UPDATE gl_accounts SET balance = ? WHERE id = ?', [Number(totalVal[0].val) || 0, parentId]);

    res.json({
      success: true,
      categoriesCreated: created,
      totalCategories: cats.length,
      parent: { id: parentId, code: parentCode, source: parent.source }
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
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

async function auditLog(action, entityType, entityId, username, details, ip) {
  try {
    const id = 'AUD-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query('INSERT INTO audit_logs (id, action, entity_type, entity_id, username, details, ip_address) VALUES (?,?,?,?,?,?,?)',
      [id, action, entityType||'', entityId||'', username||'', typeof details === 'object' ? JSON.stringify(details) : (details||''), ip||'']);
  } catch(e) { /* Production: removed debug log */ }
}

// v5.17.1 — /audit-logs moved to routes/erp/audit-logs.js
// The auditLog() helper (above) stays here because many endpoints in
// this file (and elsewhere) still call it inline.

// v5.17.1 — /purchase-reports moved to routes/erp/purchase-reports.js

// v5.17.1 — /brands moved to routes/erp/brands.js

// v5.17.1 — Older /cost-centers duplicate block REMOVED. It was dead
// code (Express always reached the richer block above first via
// stack order). The active version now lives in routes/erp/cost-centers.js.

// ─── Warehouses (المستودعات المتعددة) ───

router.get('/warehouses-list', async (req, res) => {
  try {
    const scope = req.whScopeClause('w.id');
    const [rows] = await db.query(`
      SELECT w.*,
        b.name AS branch_name,
        bd.name AS brand_name,
        cc.name AS cost_center_name
      FROM warehouses w
      LEFT JOIN branches b ON w.branch_id = b.id
      LEFT JOIN brands bd ON w.brand_id = bd.id
      LEFT JOIN cost_centers cc ON w.cost_center_id = cc.id
      WHERE 1=1${scope.sql}
      ORDER BY w.code`, scope.params);
    res.json(rows.map(w => {
      let allowedBrands = [];
      try { if (w.allowed_brands) allowedBrands = JSON.parse(w.allowed_brands); } catch(e) {}
      return {
        id: w.id, code: w.code, name: w.name, type: w.type,
        branchId: w.branch_id || '', branchName: w.branch_name||'',
        brandId: w.brand_id || '', brandName: w.brand_name||'',
        costCenterId: w.cost_center_id || '', costCenterName: w.cost_center_name||'',
        location: w.location||'', manager: w.manager||'', isActive: w.is_active,
        // V3: array of allowed brand IDs (multi-brand storage rule)
        allowedBrands: allowedBrands
      };
    }));
  } catch(e) { res.json([]); }
});

router.post('/warehouses-list', async (req, res) => {
  try {
    const { id, code, name, type, brandId, branchId, costCenterId, location, manager, allowedBrands } = req.body;
    if (!code || !name) return res.json({ success: false, error: 'الرمز والاسم مطلوبان' });
    const allowedBrandsJson = Array.isArray(allowedBrands) ? JSON.stringify(allowedBrands) : null;
    if (id) {
      if (!req.guardWh(res, id)) return;
      try {
        await db.query('UPDATE warehouses SET code=?, name=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=?, allowed_brands=? WHERE id=?',
          [code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson, id]);
      } catch(e) {
        // Fallback for older deploys without allowed_brands column
        await db.query('UPDATE warehouses SET code=?, name=?, type=?, brand_id=?, branch_id=?, cost_center_id=?, location=?, manager=? WHERE id=?',
          [code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', id]);
      }
      return res.json({ success: true, id });
    }
    const newId = 'WH-' + Date.now();
    try {
      await db.query('INSERT INTO warehouses (id, code, name, type, brand_id, branch_id, cost_center_id, location, manager, allowed_brands) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [newId, code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'', allowedBrandsJson]);
    } catch(e) {
      await db.query('INSERT INTO warehouses (id, code, name, type, brand_id, branch_id, cost_center_id, location, manager) VALUES (?,?,?,?,?,?,?,?,?)',
        [newId, code, name, type||'branch', brandId||null, branchId||null, costCenterId||null, location||'', manager||'']);
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
