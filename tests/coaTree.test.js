#!/usr/bin/env node
'use strict';
/**
 * tests/coaTree.test.js — the chart-of-accounts structure the owner reported
 * as "a problem with levels and ordering".
 *
 * Two defects, both of which shipped green because nothing asserted the SHAPE
 * of the chart — only that accounts existed:
 *
 *  1. TWO DEPTH BASES. `routes/erp.js` `_coaComputeDepth` returned 0 for a
 *     root; `lib/reports/trialBalance.js` and every other writer said 1.
 *     `/gl/deep-repair` ran both in one transaction, so one click shifted the
 *     whole chart down a level and the trial balance flagged EVERY account as
 *     a level mismatch — which feeds `isClean`, so the report rendered
 *     «غير سليم» while its arithmetic was perfect.
 *
 *  2. LEXICOGRAPHIC ORDER. Sorting VARCHAR codes puts `112` between `1110`
 *     and `1120`, so the chart screen and every report listed accounts in
 *     different sequences and neither was wrong on its own terms.
 *
 * Run: node tests/coaTree.test.js   (pure, no DB)
 */
const assert = require('assert');
const t = require('../lib/coa/tree');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}

const acc = (id, code, parent_id, extra = {}) => ({ id, code, parent_id, ...extra });

// ── 1. Depth is 1-based, everywhere, always ────────────────────────────────
{
  const rows = [
    acc('r', '1', null),
    acc('a', '11', 'r'),
    acc('b', '111', 'a'),
    acc('c', '1111', 'b'),
  ];
  const tree = t.buildTree(rows);
  check('DEPTH_BASE is 1', t.DEPTH_BASE === 1, t.DEPTH_BASE);
  check('a root is depth 1, not 0', tree.depth.get('r') === 1, tree.depth.get('r'));
  check('a child is depth 2', tree.depth.get('a') === 2, tree.depth.get('a'));
  check('a grandchild is depth 3', tree.depth.get('b') === 3, tree.depth.get('b'));
  check('a great-grandchild is depth 4', tree.depth.get('c') === 4, tree.depth.get('c'));
  check('no depth is ever 0', ![...tree.depth.values()].includes(0));
}

// ── 2. An orphan (parent_id points at nothing) is a root, not a crash ──────
{
  const rows = [acc('r', '1', null), acc('x', '999', 'GHOST')];
  const tree = t.buildTree(rows);
  check('orphan gets root depth', tree.depth.get('x') === 1, tree.depth.get('x'));
  check('orphan still renders as a root', tree.roots.some((n) => n.id === 'x'));
  check('orphan is not silently dropped', t.flattenDfs(tree).some((n) => n.id === 'x'));
}

// ── 3. Cycles are broken, flagged in FULL, and never hang ──────────────────
{
  // A <-> B is a two-node cycle; C points INTO it but is not part of it.
  const rows = [acc('A', '1', 'B'), acc('B', '2', 'A'), acc('C', '3', 'A')];
  const tree = t.buildTree(rows);
  check('both members of an A<->B cycle are flagged',
    tree.cycleMembers.has('A') && tree.cycleMembers.has('B'),
    [...tree.cycleMembers]);
  check('a node pointing INTO a cycle is not itself flagged',
    !tree.cycleMembers.has('C'), [...tree.cycleMembers]);
  check('every account still gets a finite depth',
    rows.every((r) => Number.isFinite(tree.depth.get(r.id))));
  // flattenDfs must terminate and emit every account exactly once.
  const flat = t.flattenDfs(tree);
  check('flatten emits each account exactly once even inside a cycle',
    flat.length === rows.length && new Set(flat.map((f) => f.id)).size === rows.length,
    flat.map((f) => f.id));
}

// ── 4. Ordering: a short code no longer splits a longer sibling group ──────
{
  // The exact live shape: 1110 / 112 / 1120 under one parent. Lexicographic
  // sort gives 1110 < 112 < 1120 — `112 المخزون` lands BETWEEN two 11xx
  // accounts. Length-first fixes it without inventing a new numbering scheme.
  const rows = [
    acc('r', '1', null),
    acc('x', '1110', 'r'),
    acc('y', '112', 'r'),
    acc('z', '1120', 'r'),
  ];
  const tree = t.buildTree(rows);
  const order = (tree.childrenOf.get('r') || []).map((n) => n.code);
  check('short code sorts before the longer group, not inside it',
    JSON.stringify(order) === JSON.stringify(['112', '1110', '1120']), order);

  // Lexicographic would have produced this — pinned so the regression is
  // recognisable if anyone reverts the comparator.
  check('the OLD lexicographic order is no longer produced',
    JSON.stringify(order) !== JSON.stringify(['1110', '112', '1120']), order);
}

// ── 5. display_order wins over code, and NULLs sort last ───────────────────
{
  const rows = [
    acc('r', '1', null),
    acc('a', '11', 'r', { display_order: 30 }),
    acc('b', '12', 'r', { display_order: 10 }),
    acc('c', '13', 'r', { display_order: null }),
    acc('d', '14', 'r', { display_order: 20 }),
  ];
  const tree = t.buildTree(rows);
  const order = (tree.childrenOf.get('r') || []).map((n) => n.code);
  check('explicit display_order is honoured',
    JSON.stringify(order) === JSON.stringify(['12', '14', '11', '13']), order);
  check('a NULL display_order sorts last, not first',
    order[order.length - 1] === '13', order);
}

// ── 6. The SQL fragments say what the JS does ──────────────────────────────
{
  const ob = t.ORDER_BY('a');
  check('ORDER_BY leads with display_order', /^COALESCE\(a\.display_order/.test(ob), ob);
  check('ORDER_BY breaks the lexicographic trap with CHAR_LENGTH',
    ob.includes('CHAR_LENGTH(a.code)'), ob);
  check('ORDER_BY ends on code as a total tiebreak', /a\.code$/.test(ob), ob);

  const leaf = t.POSTING_LEAF_SQL('a');
  check('posting-leaf requires NOT a folder', leaf.includes('COALESCE(a.is_folder, 0) = 0'), leaf);
  check('posting-leaf requires NO children', leaf.includes('NOT EXISTS'), leaf);
  check('posting-leaf requires active by default', leaf.includes('a.is_active = 1'), leaf);
  check('posting-leaf can opt out of the active check',
    !t.POSTING_LEAF_SQL('a', { includeInactive: true }).includes('is_active'),
    t.POSTING_LEAF_SQL('a', { includeInactive: true }));
  // The subquery alias must not collide with the outer alias, or MySQL errors.
  check('posting-leaf subquery uses its own alias', leaf.includes('_c.parent_id'), leaf);
}

// ── 7. isPostingLeaf is AND-based — the picker bug, in one assertion ───────
{
  const rows = [
    acc('parent', '1', null, { is_folder: 1 }),
    acc('leaf', '11', 'parent', { is_folder: 0 }),
    acc('childless_folder', '12', 'parent', { is_folder: 1 }),
    acc('nonfolder_parent', '13', 'parent', { is_folder: 0 }),
    acc('kid', '131', 'nonfolder_parent', { is_folder: 0 }),
  ];
  const tree = t.buildTree(rows);
  check('a real leaf is postable', tree.isPostingLeaf(tree.byId.get('leaf')));
  check('a CHILDLESS FOLDER is NOT postable — the picker used to offer it',
    !tree.isPostingLeaf(tree.byId.get('childless_folder')));
  check('a non-folder WITH children is NOT postable',
    !tree.isPostingLeaf(tree.byId.get('nonfolder_parent')));
  check('the deepest child is postable', tree.isPostingLeaf(tree.byId.get('kid')));
}

// ── 8. flattenDfs = parent immediately followed by its own subtree ─────────
{
  const rows = [
    acc('r1', '1', null), acc('r2', '2', null),
    acc('a', '11', 'r1'), acc('b', '12', 'r1'), acc('a1', '111', 'a'),
    acc('c', '21', 'r2'),
  ];
  const tree = t.buildTree(rows);
  const flat = t.flattenDfs(tree).map((n) => n.code + '@' + n.depth);
  check('DFS order puts a child directly under its parent',
    JSON.stringify(flat) === JSON.stringify(['1@1', '11@2', '111@3', '12@2', '2@1', '21@2']),
    flat);
}

// ── 9. camelCase rows work too (the frontend shape) ───────────────────────
{
  const tree = t.buildTree([
    { id: 'r', code: '1', parentId: null, isFolder: true },
    { id: 'a', code: '11', parentId: 'r', isFolder: false },
  ]);
  check('camelCase parentId is understood', tree.depth.get('a') === 2, tree.depth.get('a'));
  check('camelCase isFolder is understood', !tree.isPostingLeaf(tree.byId.get('r')));
}

// ── 10. The duplicates are actually GONE, and stay gone ───────────────────
// The unit assertions above prove the shared module is right. They cannot
// prove anyone USES it — which is exactly how four different answers to
// "is this account postable?" accumulated in the first place.
{
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // (a) The 0-based depth helper must never come back.
  const erp = read('routes/erp.js');
  check('routes/erp.js no longer defines its own 0-based root depth',
    !/if \(!a \|\| !a\.parent_id\) return 0;/.test(erp));
  check('routes/erp.js delegates depth to lib/coa/tree',
    /require\(['"]\.\.\/lib\/coa\/tree['"]\)/.test(erp));

  // (b) The trial balance must import the shared walk, not keep a copy.
  const tb = read('lib/reports/trialBalance.js');
  check('trialBalance imports the shared tree module',
    /require\(['"]\.\.\/coa\/tree['"]\)/.test(tb));
  check('trialBalance no longer defines computeDepths itself',
    !/^function computeDepths\(/m.test(tb));

  // (c) Every account PICKER uses the AND-based predicate. A picker that
  // offers a childless folder is what produces `nonLeafPostingActivity` and
  // flips the trial balance to «غير سليم».
  for (const f of ['routes/accounting.js', 'routes/inventory-transactions.js']) {
    const src = read(f);
    check(`${f} uses the shared posting-leaf predicate`,
      /POSTING_LEAF_SQL\(/.test(src));
    check(`${f} no longer hand-writes a children-only leaf test`,
      !/NOT EXISTS \(SELECT 1 FROM gl_accounts c WHERE c\.parent_id\s*=\s*a\.id\)/.test(src));
  }

  // (d) The gl-ledger's JS leaf test is AND-based too.
  const ledger = read('routes/erp/reports/gl-ledger.js');
  check('gl-ledger isLeaf checks is_folder as well as children',
    /const isLeaf = \(a\) => !Number\(a\.is_folder\)/.test(ledger));

  // (e) The display ORDER BY is shared, not re-typed.
  for (const f of ['lib/reports/trialBalance.js', 'routes/accounting.js',
                   'routes/erp/reports/gl-ledger.js']) {
    check(`${f} orders accounts via the shared ORDER_BY`,
      /ORDER_BY\(['"]a['"]\)/.test(read(f)), f);
  }

  // (f) The import TDZ: `let parentId` must be DECLARED before the
  // display_order fallback reads it. This threw ReferenceError -> HTTP 500 on
  // the very case the code calls expected (an empty «الترتيب» cell).
  const lines = erp.split('\n');
  const declAt = lines.findIndex((l) => /^\s*let parentId = null;/.test(l));
  const useAt = lines.findIndex((l) => /const parentKey = String\(parentId/.test(l));
  check('import: parentId is declared before the display_order fallback reads it',
    declAt >= 0 && useAt >= 0 && declAt < useAt, { declAt: declAt + 1, useAt: useAt + 1 });

  // (g) deep-repair derives levels AFTER the last step that re-parents.
  // Computing them before bruteForceTopology left every level stale on commit.
  const bruteAt = erp.indexOf("lastStep = 'bruteForceTopology'");
  const levelsAt = erp.indexOf("lastStep = 'autoFixLevels'");
  check('deep-repair recomputes levels after the last re-parenting step',
    bruteAt > 0 && levelsAt > 0 && levelsAt > bruteAt, { bruteAt, levelsAt });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ coa tree: 1-based depth, cycle-safe, length-aware ordering, AND-based posting leaf');
