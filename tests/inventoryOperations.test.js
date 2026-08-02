/**
 * Unified inventory-operations read model — pure unit tests. No DB, no express.
 * Run: node tests/inventoryOperations.test.js
 */
'use strict';
const M = require('../lib/inventoryOperations');

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

// A scope stub shaped exactly like req.whScopeClause / WS.scopeSqlClause.
function scopeStub(col) { return { sql: ' AND ' + col + ' IN (?)', params: ['W1'] }; }
function noScope() { return { sql: '', params: [] }; }
function allCaps() { return true; }
function noCaps() { return false; }
function allAvail() { return true; }

console.log('\n═══ Inventory operations read model ═══');

// ── descriptor sanity ───────────────────────────────────────────────────────
console.log('\n─── SOURCES descriptor ───');
check('11 document sources covered', M.SOURCES.length === 11, M.SOURCES.length);
check('document types are unique', new Set(M.DOCUMENT_TYPES).size === M.DOCUMENT_TYPES.length, M.DOCUMENT_TYPES);
check('9 canonical statuses', M.CANONICAL_STATUSES.length === 9, M.CANONICAL_STATUSES);
check('every statusMap target is canonical',
  M.SOURCES.every((s) => Object.keys(s.statusMap).every((k) => M.CANONICAL_STATUSES.indexOf(s.statusMap[k]) !== -1)));
check('every source declares source+destination kinds',
  M.SOURCES.every((s) => !!(s.source && s.source.kind && s.destination && s.destination.kind)));
check('only procurement branches require a capability',
  M.SOURCES.filter((s) => s.capability).map((s) => s.documentType).join(',') === 'purchase_receipt,purchase_return',
  M.SOURCES.filter((s) => s.capability).map((s) => s.documentType));
check('procurement.view is the only capability needed',
  JSON.stringify(M.capabilitiesRequired()) === JSON.stringify(['procurement.view']), M.capabilitiesRequired());
check('the two numberless/nullable-number sources fall back to the PK',
  M.sourceFor('purchase_legacy').numberColumn === null &&
  M.sourceFor('adjustment_legacy').numberFallbackToPk === true);
check('the two DATETIME business dates are flagged for DATE() casting',
  M.sourceFor('purchase_legacy').dateIsDatetime === true &&
  M.sourceFor('adjustment_legacy').dateIsDatetime === true &&
  M.SOURCES.filter((s) => s.dateIsDatetime).length === 2);
check('legacy creators use `username`, not `created_by`',
  M.sourceFor('purchase_legacy').createdByColumn === 'username' &&
  M.sourceFor('adjustment_legacy').createdByColumn === 'username');
check('legacy purchases expose NO approver (receive_approved_by approves the RECEIPT)',
  M.sourceFor('purchase_legacy').approvedByColumn === null);
check('purchases lines live in items_json, not a line table',
  M.sourceFor('purchase_legacy').lines === null && M.sourceFor('purchase_legacy').itemsJsonColumn === 'items_json');
check('soft-deleted purchases are excluded by the descriptor',
  /deleted_at IS NULL/.test(M.sourceFor('purchase_legacy').extraWhere || ''));
check('production is split into v2 / legacy by `source`',
  /source = 'v2'/.test(M.sourceFor('production').extraWhere || '') &&
  /source <> 'v2'/.test(M.sourceFor('production_legacy').extraWhere || ''));
check('allTables() lists every header + line table',
  M.allTables().indexOf('inv_receipts') !== -1 &&
  M.allTables().indexOf('purchase_return_lines') !== -1 &&
  M.allTables().indexOf('purchases') !== -1);

// ── canonicalStatus — ALL vocabularies ──────────────────────────────────────
console.log('\n─── canonicalStatus: (a) v2 receipts/issues/adjustments ───');
['receipt', 'issue', 'adjustment'].forEach((t) => {
  check(t + ': draft/approved/posted/cancelled/reversed map 1:1',
    M.canonicalStatus(t, 'draft') === 'draft' &&
    M.canonicalStatus(t, 'approved') === 'approved' &&
    M.canonicalStatus(t, 'posted') === 'posted' &&
    M.canonicalStatus(t, 'cancelled') === 'cancelled' &&
    M.canonicalStatus(t, 'reversed') === 'reversed');
});

console.log('\n─── canonicalStatus: (b) transfers (stock_issues) ───');
check('issued → in_progress', M.canonicalStatus('transfer', 'issued') === 'in_progress');
check('partially_received → partially_completed', M.canonicalStatus('transfer', 'partially_received') === 'partially_completed');
check('received → completed', M.canonicalStatus('transfer', 'received') === 'completed');
check('draft/approved/cancelled/reversed pass through',
  M.canonicalStatus('transfer', 'draft') === 'draft' &&
  M.canonicalStatus('transfer', 'approved') === 'approved' &&
  M.canonicalStatus('transfer', 'cancelled') === 'cancelled' &&
  M.canonicalStatus('transfer', 'reversed') === 'reversed');

console.log('\n─── canonicalStatus: (c) purchase receipts (GRN) ───');
check('draft/approved/posted/reversed/cancelled map 1:1',
  M.canonicalStatus('purchase_receipt', 'draft') === 'draft' &&
  M.canonicalStatus('purchase_receipt', 'approved') === 'approved' &&
  M.canonicalStatus('purchase_receipt', 'posted') === 'posted' &&
  M.canonicalStatus('purchase_receipt', 'reversed') === 'reversed' &&
  M.canonicalStatus('purchase_receipt', 'cancelled') === 'cancelled');

console.log('\n─── canonicalStatus: (d) purchase returns (RTV) ───');
check('settled → completed', M.canonicalStatus('purchase_return', 'settled') === 'completed');
check('draft/approved/posted/cancelled pass through',
  M.canonicalStatus('purchase_return', 'draft') === 'draft' &&
  M.canonicalStatus('purchase_return', 'approved') === 'approved' &&
  M.canonicalStatus('purchase_return', 'posted') === 'posted' &&
  M.canonicalStatus('purchase_return', 'cancelled') === 'cancelled');

console.log('\n─── canonicalStatus: (e) stocktakes ───');
check('counting → in_progress', M.canonicalStatus('stocktake', 'counting') === 'in_progress');
check('submitted → pending_approval', M.canonicalStatus('stocktake', 'submitted') === 'pending_approval');
check('draft/approved/posted/cancelled pass through',
  M.canonicalStatus('stocktake', 'draft') === 'draft' &&
  M.canonicalStatus('stocktake', 'approved') === 'approved' &&
  M.canonicalStatus('stocktake', 'posted') === 'posted' &&
  M.canonicalStatus('stocktake', 'cancelled') === 'cancelled');

console.log('\n─── canonicalStatus: (f) production V2 + legacy ───');
check('V2: in_progress → in_progress, completed → completed, closed → posted',
  M.canonicalStatus('production', 'in_progress') === 'in_progress' &&
  M.canonicalStatus('production', 'completed') === 'completed' &&
  M.canonicalStatus('production', 'closed') === 'posted');
check('V2: draft/approved/cancelled/reversed pass through',
  M.canonicalStatus('production', 'draft') === 'draft' &&
  M.canonicalStatus('production', 'approved') === 'approved' &&
  M.canonicalStatus('production', 'cancelled') === 'cancelled' &&
  M.canonicalStatus('production', 'reversed') === 'reversed');
check('legacy: planned → draft, released → in_progress',
  M.canonicalStatus('production_legacy', 'planned') === 'draft' &&
  M.canonicalStatus('production_legacy', 'released') === 'in_progress');

console.log('\n─── canonicalStatus: (g) legacy purchases, (h) legacy adjustments ───');
check('purchases: draft → draft, received → posted (stock + GL moved)',
  M.canonicalStatus('purchase_legacy', 'draft') === 'draft' &&
  M.canonicalStatus('purchase_legacy', 'received') === 'posted');
check('legacy adjustment: pending → pending_approval, approved → posted',
  M.canonicalStatus('adjustment_legacy', 'pending') === 'pending_approval' &&
  M.canonicalStatus('adjustment_legacy', 'approved') === 'posted');

console.log('\n─── canonicalStatus: edge cases ───');
check('unknown document type → null (a bug, not data)', M.canonicalStatus('nope', 'draft') === null);
check('status lookup is case-insensitive', M.canonicalStatus('transfer', 'PARTIALLY_RECEIVED') === 'partially_completed');
check('unmapped raw status falls back to draft (unreachable for a full enum)',
  M.canonicalStatus('receipt', 'zzz_not_an_enum_value') === 'draft');
check('rawStatusesFor() reverses the map',
  M.rawStatusesFor(M.sourceFor('transfer'), ['completed']).join(',') === 'received',
  M.rawStatusesFor(M.sourceFor('transfer'), ['completed']));

// ── buildUnionSql: branch selection ─────────────────────────────────────────
console.log('\n─── buildUnionSql: branch selection ───');
{
  const all = M.buildUnionSql(M.SOURCES, { hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope });
  check('no filters → one branch per source',
    all.includedTypes.length === M.SOURCES.length &&
    all.sql.split('UNION ALL').length === M.SOURCES.length, all.includedTypes.length);
  check('every branch selects the same projected columns',
    all.sql.split('UNION ALL').every((b) => (b.match(/ AS `/g) || []).length === 19),
    all.sql.split('UNION ALL').map((b) => (b.match(/ AS `/g) || []).length));
  check('composite surrogate id is CONCAT(type, ":", pk)',
    all.sql.indexOf("CONCAT('receipt', ':', t.id) AS `id`") !== -1);
  check('no filters → no bound params', all.params.length === 0, all.params);
}
{
  const two = M.buildUnionSql(M.SOURCES, {
    types: ['transfer', 'issue'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check('types filter → exactly the requested branches',
    two.includedTypes.join(',') === 'issue,transfer', two.includedTypes);
  check('one UNION ALL for two branches', two.sql.split('UNION ALL').length === 2);
  check('unrequested branches are reported as not_requested',
    two.excludedTypes.every((x) => x.reason === 'not_requested') && two.excludedTypes.length === 9,
    two.excludedTypes.length);
  check('only the requested tables appear',
    two.sql.indexOf('FROM stock_issues t') !== -1 &&
    two.sql.indexOf('FROM inv_issues t') !== -1 &&
    two.sql.indexOf('FROM purchase_receipts t') === -1);
}

// ── buildUnionSql: per-branch capability (NOT one gate) ─────────────────────
console.log('\n─── buildUnionSql: per-branch capability ───');
{
  const denied = M.buildUnionSql(M.SOURCES, { hasCapability: noCaps, isAvailable: allAvail, scopeFor: noScope });
  check('no procurement.view → procurement branches dropped',
    denied.includedTypes.indexOf('purchase_receipt') === -1 &&
    denied.includedTypes.indexOf('purchase_return') === -1, denied.includedTypes);
  check('…but every other branch still shows (no blanket 403)',
    denied.includedTypes.length === M.SOURCES.length - 2, denied.includedTypes.length);
  check('the drop is reported with reason=capability',
    denied.excludedTypes.filter((x) => x.reason === 'capability').map((x) => x.documentType).join(',')
      === 'purchase_receipt,purchase_return');
  check('the procurement tables never reach the SQL',
    denied.sql.indexOf('purchase_receipts') === -1 && denied.sql.indexOf('purchase_returns') === -1);
  const only = M.buildUnionSql(M.SOURCES, {
    hasCapability: (c) => c === 'procurement.view', isAvailable: allAvail, scopeFor: noScope,
  });
  check('granting procurement.view restores both procurement branches',
    only.includedTypes.indexOf('purchase_receipt') !== -1 && only.includedTypes.indexOf('purchase_return') !== -1);
}
{
  const missing = M.buildUnionSql(M.SOURCES, {
    hasCapability: allCaps, scopeFor: noScope,
    isAvailable: (t) => t !== 'purchase_returns' && t !== 'purchase_return_lines',
  });
  check('an absent table drops its branch as unavailable (never a false-empty page)',
    missing.includedTypes.indexOf('purchase_return') === -1 &&
    missing.excludedTypes.some((x) => x.documentType === 'purchase_return' && x.reason === 'unavailable'));
}

// ── buildUnionSql: warehouse scope per branch ───────────────────────────────
console.log('\n─── buildUnionSql: warehouse scope per branch ───');
{
  const t = M.buildUnionSql(M.SOURCES, {
    types: ['transfer'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: scopeStub,
  });
  check('transfer scopes BOTH warehouse columns',
    t.sql.indexOf('t.from_warehouse_id IN (?)') !== -1 && t.sql.indexOf('t.to_warehouse_id IN (?)') !== -1, t.sql);
  check('the two ends are OR-ed (visible when EITHER end is in scope)',
    /\(\(t\.from_warehouse_id IN \(\?\)\) OR \(t\.to_warehouse_id IN \(\?\)\)\)/.test(t.sql), t.sql);
  check('one scope param per column', t.params.length === 2 && t.params.join(',') === 'W1,W1', t.params);
}
{
  const p = M.buildUnionSql(M.SOURCES, {
    types: ['production'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: scopeStub,
  });
  check('production scopes warehouse_id AND output_warehouse_id',
    p.sql.indexOf('t.warehouse_id IN (?)') !== -1 && p.sql.indexOf('t.output_warehouse_id IN (?)') !== -1, p.sql);
}
{
  const r = M.buildUnionSql(M.SOURCES, {
    types: ['receipt'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: scopeStub,
  });
  check('single-warehouse branch scopes exactly one column',
    (r.sql.match(/IN \(\?\)/g) || []).length === 1 && r.params.length === 1, r.params);
}
{
  const off = M.buildUnionSql(M.SOURCES, {
    types: ['receipt'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check('scope disabled → no scope clause and no params', off.sql.indexOf('IN (?)') === -1 && off.params.length === 0);
}

// ── buildUnionSql: filters + binding ────────────────────────────────────────
console.log('\n─── buildUnionSql: filters are bound, never interpolated ───');
{
  const f = M.buildUnionSql(M.SOURCES, {
    types: ['receipt'], statuses: ['posted'], warehouseId: 'W9',
    dateFrom: '2026-01-01', dateTo: '2026-01-31', search: "x' OR 1=1 --",
    hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check('status filter is translated to the branch RAW status',
    f.params[0] === 'posted' && f.sql.indexOf('t.status IN (?)') !== -1, f.params);
  check('params are ordered status → warehouse → dateFrom → dateTo → search',
    JSON.stringify(f.params) === JSON.stringify(['posted', 'W9', '2026-01-01', '2026-01-31', "%x' OR 1=1 --%"]), f.params);
  check('the injected search string never reaches the SQL text', f.sql.indexOf('OR 1=1') === -1);
}
{
  const f = M.buildUnionSql(M.SOURCES, {
    statuses: ['partially_completed'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check('a status only transfers can have drops every other branch',
    f.includedTypes.join(',') === 'transfer', f.includedTypes);
  check('the dropped branches are reported with reason=status_filter',
    f.excludedTypes.every((x) => x.reason === 'status_filter'));
}
{
  const f = M.buildUnionSql(M.SOURCES, {
    statuses: ['posted'], types: ['adjustment_legacy'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check("canonical 'posted' maps back to the legacy RAW value 'approved'",
    f.params[0] === 'approved', f.params);
}
{
  const f = M.buildUnionSql(M.SOURCES, {
    warehouseId: 'W1', hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope,
  });
  check('an explicit warehouse filter matches BOTH ends of a two-sided doc',
    /\(t\.from_warehouse_id = \? OR t\.to_warehouse_id = \?\)/.test(f.sql));
  check('DATETIME date columns are DATE()-cast in the projection',
    f.sql.indexOf('DATE(t.purchase_date) AS `date`') !== -1 &&
    f.sql.indexOf('DATE(t.adjustment_date) AS `date`') !== -1);
}
{
  const a = M.buildUnionSql(M.SOURCES, {
    types: ['adjustment'], hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope, includeAggregates: true,
  });
  check('includeAggregates projects lineCount + totalQuantity',
    a.sql.indexOf('AS `lineCount`') !== -1 && a.sql.indexOf('AS `totalQuantity`') !== -1);
  check('adjustment quantity uses ABS(delta) — delta is SIGNED',
    a.sql.indexOf('SUM(ABS(li.delta))') !== -1);
}

// ── generated CASE mirrors the JS mapping exactly ───────────────────────────
console.log('\n─── SQL CASE ↔ canonicalStatus agreement ───');
{
  let mismatch = null;
  M.SOURCES.forEach((s) => {
    const one = M.buildUnionSql([s], { hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope });
    Object.keys(s.statusMap).forEach((raw) => {
      const frag = "WHEN '" + raw + "' THEN '" + M.canonicalStatus(s.documentType, raw) + "'";
      if (one.sql.indexOf(frag) === -1) mismatch = s.documentType + '/' + raw;
    });
  });
  check('every WHEN in the emitted CASE equals canonicalStatus()', mismatch === null, mismatch);
}

// ── identifier / literal guards ─────────────────────────────────────────────
console.log('\n─── injection guards ───');
{
  let threw = false;
  try { M.ident('id; DROP TABLE users'); } catch (_) { threw = true; }
  check('ident() rejects anything but a bare identifier', threw);
  const bad = JSON.parse(JSON.stringify(M.sourceFor('receipt')));
  bad.table = 'inv_receipts WHERE 1=1 UNION SELECT';
  let threw2 = false;
  try { M.buildUnionSql([bad], { hasCapability: allCaps, isAvailable: allAvail, scopeFor: noScope }); } catch (_) { threw2 = true; }
  check('a poisoned descriptor table name throws instead of emitting SQL', threw2);
}

// ── pageSql / countSql wrappers ─────────────────────────────────────────────
console.log('\n─── page / count wrappers ───');
{
  const inner = 'SELECT 1';
  check('sort key is taken from the allow-list',
    M.pageSql(inner, 'totalValue', 'asc').indexOf('ORDER BY u.`totalValue` ASC') !== -1);
  check('a non-allow-listed sort falls back to the default column',
    M.pageSql(inner, 'id; DROP TABLE users', 'desc').indexOf('ORDER BY u.`date` DESC') !== -1,
    M.pageSql(inner, 'id; DROP TABLE users', 'desc'));
  check('a deterministic tiebreaker is always appended',
    M.pageSql(inner, 'date', 'desc').indexOf(', u.`id` ASC LIMIT ? OFFSET ?') !== -1);
  check('countSql / countsByTypeSql wrap the same inner union',
    M.countSql(inner) === 'SELECT COUNT(*) AS total FROM (SELECT 1) u' &&
    M.countsByTypeSql(inner).indexOf('GROUP BY u.`documentType`') !== -1);
}

// ── parseOperationsQuery ────────────────────────────────────────────────────
console.log('\n─── parseOperationsQuery ───');
{
  const d = M.parseOperationsQuery({});
  check('defaults: page 1, pageSize 25, sort date DESC, no filters',
    d.page === 1 && d.pageSize === 25 && d.offset === 0 && d.sort === 'date' && d.dir === 'DESC' &&
    d.types.length === 0 && d.statuses.length === 0 && d.hasInvalid === false, d);
}
{
  check('pageSize is capped at 100', M.parseOperationsQuery({ pageSize: 5000 }).pageSize === 100);
  check('pageSize below 1 is clamped up', M.parseOperationsQuery({ pageSize: 0 }).pageSize === 1);
  check('a garbage pageSize falls back to the default', M.parseOperationsQuery({ pageSize: 'abc' }).pageSize === 25);
  check('page below 1 is clamped', M.parseOperationsQuery({ page: -3 }).page === 1);
  check('offset is derived from page/pageSize',
    M.parseOperationsQuery({ page: 4, pageSize: 10 }).offset === 30);
}
{
  const s = M.parseOperationsQuery({ sort: 'total_value; DROP TABLE users--' });
  check('a non-allow-listed sort column is rejected → default', s.sort === 'date', s.sort);
  check('a raw table column is NOT accepted as a sort key',
    M.parseOperationsQuery({ sort: 'receipt_date' }).sort === 'date');
  check('an allow-listed sort key is honoured',
    M.parseOperationsQuery({ sort: 'documentNumber', dir: 'asc' }).sort === 'documentNumber' &&
    M.parseOperationsQuery({ sort: 'documentNumber', dir: 'asc' }).dir === 'ASC');
}
{
  const t = M.parseOperationsQuery({ type: 'transfer,receipt,transfer' });
  check('types parse from CSV and de-duplicate', t.types.join(',') === 'transfer,receipt', t.types);
  const bad = M.parseOperationsQuery({ type: 'transfer,not_a_type' });
  check('an unknown type is reported, not silently widened to "all"',
    bad.types.join(',') === 'transfer' && bad.invalid.types.join(',') === 'not_a_type' && bad.hasInvalid === true, bad.invalid);
  const st = M.parseOperationsQuery({ status: 'posted,bogus' });
  check('a non-canonical status is reported',
    st.statuses.join(',') === 'posted' && st.invalid.statuses.join(',') === 'bogus' && st.hasInvalid === true);
  check('an array-valued type param is accepted',
    M.parseOperationsQuery({ types: ['issue', 'receipt'] }).types.join(',') === 'issue,receipt');
}
{
  const good = M.parseOperationsQuery({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });
  check('well-formed dates pass through', good.dateFrom === '2026-01-01' && good.dateTo === '2026-01-31' && good.hasInvalid === false);
  const badDate = M.parseOperationsQuery({ dateFrom: '01/01/2026' });
  check('a malformed date is rejected, not coerced', badDate.dateFrom === '' && badDate.invalid.dateFrom === '01/01/2026' && badDate.hasInvalid === true);
}
{
  const q = M.parseOperationsQuery({ q: '  RCV-2026  ' });
  check('search is trimmed', q.search === 'RCV-2026');
  check('search is length-capped at 120', M.parseOperationsQuery({ q: 'x'.repeat(500) }).search.length === 120);
  check('warehouseId is stringified', M.parseOperationsQuery({ warehouseId: 7 }).warehouseId === '7');
}

// ── productSummary ──────────────────────────────────────────────────────────
console.log('\n─── productSummary ───');
check('single line → the item name alone', M.productSummary('طماطم', 1) === 'طماطم');
check('multi line → name + remaining count', M.productSummary('طماطم', 4) === 'طماطم (+3)');
check('no name but a count → count only', M.productSummary('', 3) === '3 أصناف');
check('nothing at all → empty string', M.productSummary(null, 0) === '');

console.log(`\n${_f === 0 ? '✅' : '❌'} inventoryOperations: ${_p} passed, ${_f} failed\n`);
process.exit(_f === 0 ? 0 : 1);
