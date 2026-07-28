'use strict';
/**
 * lib/coa/tree.js — the single structural authority for `gl_accounts`.
 *
 * WHY THIS EXISTS
 *
 * Three structural questions were being answered independently, in different
 * places, with different answers:
 *
 *   1. HOW DEEP IS AN ACCOUNT?  `routes/erp.js` `_coaComputeDepth` returned
 *      **0** for a root; every other writer and reader said **1**
 *      (`routes/erp.js:1513,1550,1987`, `lib/reports/trialBalance.js`).
 *      `POST /gl/deep-repair` ran BOTH in one transaction — first setting roots
 *      to 1, then recomputing 0-based — so it shifted every account down a
 *      level. The trial balance then flagged `levelMismatch` on EVERY account,
 *      and because that feeds `isClean`, the whole report rendered
 *      «غير سليم». The owner reported this as "a problem with account levels".
 *
 *   2. IN WHAT ORDER?  `display_order` exists and is backfilled at boot, but
 *      exactly ONE query in the codebase ordered by it (`routes/erp.js:136`,
 *      the CoA screen). Every report sorted by `code` as a STRING — and a
 *      lexicographic sort over variable-length codes puts `112` between `1110`
 *      and `1120`. The chart screen and the reports could never agree.
 *
 *   3. CAN IT BE POSTED TO?  The trial balance, the role registry and three
 *      report engines used `!is_folder && !hasChildren`. The account PICKER
 *      every transaction screen uses (`routes/accounting.js`) checked children
 *      only — so a childless account flagged `is_folder=1` was selectable and
 *      postable, while the trial balance refused to count it, surfacing as
 *      `nonLeafPostingActivity` and flipping `isClean` to false.
 *
 * The fix is not "correct each site" — that is how they diverged in the first
 * place. It is one module they all import.
 *
 * `computeDepths` below is LIFTED VERBATIM from lib/reports/trialBalance.js.
 * It was already correct, already cycle-safe and already 1-based; it is the
 * canonical implementation precisely because the trial balance's arithmetic
 * must not change by a single digit when it starts importing from here.
 */

/**
 * A root account has depth 1, not 0. Stated as a constant so the next person
 * to write a depth calculation has something to disagree with explicitly.
 */
const DEPTH_BASE = 1;

/**
 * The canonical ordering for a FLAT account query, as a SQL fragment.
 *
 *   1. `CHAR_LENGTH(code)` — this is what stops `1110 < 112 < 1120`. Sorting a
 *      VARCHAR lexicographically puts `112 المخزون` BETWEEN two `11xx`
 *      accounts. Siblings share a code length, so this never reorders true
 *      siblings; it only stops a SHORTER code from landing in the middle of a
 *      longer group when a query flattens the tree.
 *   2. `code` — the final, total tiebreak.
 *
 * ⚠️ `display_order` IS DELIBERATELY NOT HERE, and must never be added.
 * It is a PER-PARENT ordinal, not a global sequence: the boot backfill
 * (server.js, `counters[parent_id]`) and the CoA import both restart the
 * counter for every parent, and `normalizeDisplayOrder` below writes
 * 10/20/30… per parent. So EVERY parent has a child numbered 1. Making it the
 * primary key of a flat sort groups every parent's first child together and
 * shatters the chart — `100102` ends up hundreds of rows from `100101`, and
 * the paginated account picker shows one account from each of eighteen
 * different parents on page 1. It belongs in `compareAccounts` below, which is
 * only ever applied WITHIN one parent's children.
 *
 * ⚠️ DISPLAY ONLY. Do NOT use this to replace an `ORDER BY code ... LIMIT 1`
 * that PICKS an account to post to or GENERATES the next code — changing the
 * sort there changes where money lands. Those sites live in routes/erp/vat.js,
 * routes/custody.js and routes/erp.js (the repair-path pickers) and are
 * deliberately left alone; they belong to the account_roles migration.
 */
function ORDER_BY(alias = 'a') {
  const a = alias ? alias + '.' : '';
  return `CHAR_LENGTH(${a}code), ${a}code`;
}

/**
 * The canonical "may a journal line hit this account?" predicate, as SQL.
 *
 * AND-based on purpose: a folder flag alone is not enough, and a childless
 * structure alone is not enough — both must hold. A childless account someone
 * marked as a folder is NOT postable, and a non-folder that has grown children
 * is NOT postable either (its children are).
 */
function POSTING_LEAF_SQL(alias = 'a', { includeInactive = false } = {}) {
  const a = alias ? alias + '.' : '';
  const active = includeInactive ? '' : `${a}is_active = 1 AND `;
  return `${active}COALESCE(${a}is_folder, 0) = 0 ` +
    `AND NOT EXISTS (SELECT 1 FROM gl_accounts _c WHERE _c.parent_id = ${a}id)`;
}

// Cycle-safe tree depth (1-based) for every account, memoized. A cycle is
// broken the moment a node revisits an ancestor already on the current walk's
// path — that node is flagged, not looped on. Hard-capped at accounts.length
// so no malformed data can cause unbounded work.
//
// A plain A<->B cycle must flag BOTH nodes: the walk keeps `pathSet` (a Set,
// no ordering), so when the back-edge closing the cycle is found, only the
// single revisited id would be added — every OTHER node on the path back to it
// would be missed, even though it is equally part of the same cycle. Tracking
// the ancestry as an ORDERED array too fixes that: on a back-edge, every node
// from the repeated id's first occurrence onward IS the cycle. A node that
// merely points INTO a cycle (C -> A, where A<->B is the cycle) is correctly
// excluded — `path.indexOf(id)` isolates the true cycle, not the chain leading
// to it.
function computeDepths(accounts, byId) {
  const depth = new Map();
  const cycleMembers = new Set();
  const n = accounts.length;

  function walk(id, path, pathSet) {
    if (depth.has(id)) return depth.get(id);
    if (pathSet.has(id)) {
      const cycleStart = path.indexOf(id);
      for (let i = cycleStart; i < path.length; i++) cycleMembers.add(path[i]);
      cycleMembers.add(id);
      return DEPTH_BASE; // break the cycle here; still returns a finite depth
    }
    const acc = byId.get(id);
    if (!acc || !acc.parent_id || !byId.has(acc.parent_id)) {
      // No parent, or a parent_id that resolves to nothing (an orphan). Both
      // are roots for depth purposes; the orphan itself is reported separately
      // by whoever cares — a depth walk is not the place to raise it.
      depth.set(id, DEPTH_BASE);
      return DEPTH_BASE;
    }
    path.push(id);
    pathSet.add(id);
    let d;
    if (path.length > n + 1) {
      // Belt-and-suspenders against any pathological chain length.
      cycleMembers.add(id);
      d = DEPTH_BASE;
    } else {
      d = 1 + walk(acc.parent_id, path, pathSet);
    }
    path.pop();
    pathSet.delete(id);
    depth.set(id, d);
    return d;
  }

  accounts.forEach((a) => walk(a.id, [], new Set()));
  return { depth, cycleMembers };
}

/**
 * Build the full structure from a flat account list.
 *
 * Accepts rows in either shape — snake_case straight from MySQL (`parent_id`,
 * `is_folder`) or the camelCase the frontend uses — so a caller never has to
 * remap before asking a structural question.
 *
 * @returns {{byId: Map, childrenOf: Map, roots: Array, depth: Map,
 *            cycleMembers: Set, hasChildren: (id:string)=>boolean,
 *            isPostingLeaf: (acc:object)=>boolean}}
 */
function buildTree(accounts) {
  const rows = (accounts || []).map(normalize);
  const byId = new Map(rows.map((a) => [a.id, a]));
  const childrenOf = new Map();
  for (const a of rows) {
    // An account whose parent_id points at nothing is treated as a root, so it
    // still RENDERS. Dropping it would make a data problem look like a missing
    // account, which is the harder bug to notice.
    const pid = a.parent_id && byId.has(a.parent_id) ? a.parent_id : null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(a);
  }
  for (const list of childrenOf.values()) list.sort(compareAccounts);

  const { depth, cycleMembers } = computeDepths(rows, byId);
  const hasChildren = (id) => (childrenOf.get(id) || []).length > 0;
  const isPostingLeaf = (acc) => !!acc && !acc.is_folder && !hasChildren(acc.id);

  return {
    rows,
    byId,
    childrenOf,
    roots: childrenOf.get(null) || [],
    depth,
    cycleMembers,
    hasChildren,
    isPostingLeaf,
  };
}

/** Tolerant row shape normaliser — snake_case or camelCase, either way. */
function normalize(a) {
  return {
    ...a,
    id: a.id,
    code: String(a.code == null ? '' : a.code),
    parent_id: a.parent_id !== undefined ? (a.parent_id || null) : (a.parentId || null),
    is_folder: a.is_folder !== undefined ? !!Number(a.is_folder) : !!a.isFolder,
    display_order: a.display_order !== undefined ? a.display_order : (a.displayOrder ?? null),
  };
}

/**
 * Sibling comparator — for ordering ONE parent's children, never a flat list.
 *
 * This is the only place `display_order` may lead, because this is the only
 * scope in which it means anything: every writer numbers children 1,2,3… (or
 * 10,20,30…) restarting at each parent. `buildTree` applies it per child list;
 * `flattenDfs` then walks those lists depth-first, which is how the owner's
 * explicit ordering reaches a rendered tree without corrupting a flat query.
 * A NULL sorts last via a sentinel — an unordered account belongs at the
 * bottom of its group, not the top.
 */
function compareAccounts(a, b) {
  const ao = a.display_order == null ? 2147483647 : Number(a.display_order);
  const bo = b.display_order == null ? 2147483647 : Number(b.display_order);
  if (ao !== bo) return ao - bo;
  const ac = String(a.code || ''), bc = String(b.code || '');
  if (ac.length !== bc.length) return ac.length - bc.length;
  return ac.localeCompare(bc);
}

/**
 * Depth-first flatten in canonical display order, each row carrying its
 * 1-based `depth`. This — not `ORDER BY code` — is the only order that means
 * anything in a financial statement: a parent immediately followed by its own
 * children.
 *
 * Cycle-safe: a `seen` set means a cycle renders each member once instead of
 * hanging the request.
 */
function flattenDfs(tree) {
  const out = [];
  const seen = new Set();
  function visit(node, d) {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push({ ...node, depth: d });
    for (const ch of tree.childrenOf.get(node.id) || []) visit(ch, d + 1);
  }
  for (const r of tree.roots) visit(r, DEPTH_BASE);
  // Anything unreachable from a root (a pure cycle with no entry point) still
  // has to appear — an account that silently vanishes from a report is worse
  // than one that appears in an odd place.
  for (const a of tree.rows) if (!seen.has(a.id)) visit(a, tree.depth.get(a.id) || DEPTH_BASE);
  return out;
}

/**
 * Recompute and PERSIST `level` for a subtree (or the whole chart).
 *
 * `level` stays a stored column — `account_class` derivation, the CoA screen
 * and the import's identity matching all read it — but it becomes DERIVED
 * ONLY: this is its single writer, and no caller may supply it. Call it inside
 * the same transaction as any topology change, so a re-parent can never leave
 * descendants at a stale depth (which is exactly what `/move` used to do: it
 * cascaded codes but not levels).
 *
 * Not a trigger: MySQL cannot recursively update the table a trigger fires on.
 *
 * @param {object} conn a connection or pool with .query()
 * @param {object} [opts]
 * @param {string} [opts.rootId] limit the write to this node and its descendants
 * @returns {Promise<{scanned:number, updated:number, cycles:number}>}
 */
async function recomputeLevels(conn, opts = {}) {
  const [accounts] = await conn.query(
    'SELECT id, code, parent_id, level FROM gl_accounts'
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const { depth, cycleMembers } = computeDepths(accounts, byId);

  let scope = accounts;
  if (opts.rootId) {
    // Descendants of rootId, cycle-safe.
    const kids = new Map();
    for (const a of accounts) {
      const pid = a.parent_id || null;
      if (!kids.has(pid)) kids.set(pid, []);
      kids.get(pid).push(a);
    }
    const want = new Set();
    const stack = [opts.rootId];
    while (stack.length) {
      const id = stack.pop();
      if (want.has(id)) continue;
      want.add(id);
      for (const ch of kids.get(id) || []) stack.push(ch.id);
    }
    scope = accounts.filter((a) => want.has(a.id));
  }

  let updated = 0;
  for (const a of scope) {
    const d = depth.get(a.id) || DEPTH_BASE;
    if (Number(a.level) === d) continue;
    await conn.query('UPDATE gl_accounts SET level = ? WHERE id = ?', [d, a.id]);
    updated++;
  }
  return { scanned: scope.length, updated, cycles: cycleMembers.size };
}

/**
 * Rewrite one parent's children as 10, 20, 30… — gap-free but with room to
 * insert between two rows without renumbering the world.
 */
async function normalizeDisplayOrder(conn, parentId) {
  const [rows] = await conn.query(
    parentId
      ? 'SELECT id, code, display_order FROM gl_accounts WHERE parent_id = ?'
      : 'SELECT id, code, display_order FROM gl_accounts WHERE parent_id IS NULL',
    parentId ? [parentId] : []
  );
  const sorted = rows.map(normalize).sort(compareAccounts);
  let i = 0;
  for (const r of sorted) {
    i += 10;
    if (Number(r.display_order) === i) continue;
    await conn.query('UPDATE gl_accounts SET display_order = ? WHERE id = ?', [i, r.id]);
  }
  return sorted.length;
}

module.exports = {
  DEPTH_BASE,
  ORDER_BY,
  POSTING_LEAF_SQL,
  computeDepths,
  buildTree,
  flattenDfs,
  compareAccounts,
  recomputeLevels,
  normalizeDisplayOrder,
};
