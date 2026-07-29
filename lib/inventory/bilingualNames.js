'use strict';
/**
 * lib/inventory/bilingualNames.js — the ONE implementation of the bilingual
 * inventory-name repair.
 *
 * The defect (owner-reported): `inv_items` rows carry ENGLISH text in the
 * Arabic-name column with `name_en` empty and no SKU, so the catalogue shows
 * English under «الاسم (عربي)» beside a «الاسم الإنجليزي مفقود» badge.
 *
 * TWO CALLERS, ONE BRAIN. `scripts/inventory/fix-bilingual-names.js` is the
 * CLI (preview / CSV / apply) and the `InventoryBilingualNames_v*` boot
 * migration in server.js runs it unattended on deploy. They MUST agree, so
 * the candidate rule, the translation, the SKU allocator and — above all —
 * the write statement live here and nowhere else. Two copies of a migration
 * are two migrations.
 *
 * SAFETY CONTRACT (asserted by tests/inventoryArDictionary.test.js):
 *   • writes exactly four columns: name, name_en, sku, sku_norm
 *   • one row per statement, keyed by primary key
 *   • never DELETEs, never touches a table other than inv_items
 *   • never touches a row whose `name` already contains Arabic
 *   • never overwrites a human-typed `name_en`, and never an existing sku
 */

const dict = require('../inventory-ar-dictionary');

/** Default SKU prefix. Codes are `INV-00001`-shaped and never reused. */
const DEFAULT_SKU_PREFIX = 'INV';

const trim = (v) => String(v == null ? '' : v).trim();

/**
 * Is this row suffering from the defect?
 *
 * Two conditions, and the second one is subtle. `name_en` must be empty OR
 * equal to `name` — because a previous run sets `name_en` first, and a row
 * whose vocabulary the dictionary did not know keeps its English `name`. Only
 * accepting an EMPTY `name_en` would freeze those rows out of every future
 * run, so a better dictionary could never reach them. `name_en === name` is
 * exactly the fingerprint of "we moved it but could not translate it".
 *
 * A row with a DIFFERENT human-typed `name_en` is never a candidate: fixing it
 * would mean choosing which of two human-entered values to destroy.
 */
function isCandidate(row) {
  if (!dict.isLatinOnly(row && row.name)) return false;
  const en = trim(row.name_en);
  return en === '' || en === trim(row.name);
}

/**
 * Build the full change plan from rows already read out of `inv_items`.
 * Pure — no DB, no clock, no randomness — so the CLI preview and the boot
 * migration provably plan the same thing.
 *
 * @param {Array<{id:*,name:string,name_en:?string,sku:?string,sku_norm:?string}>} rows  ALL rows, not just candidates
 * @param {{skuPrefix?:string, limit?:number}} [opts]
 */
function planBilingualNames(rows, opts = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const skuPrefix = String(opts.skuPrefix || DEFAULT_SKU_PREFIX)
    .toUpperCase().replace(/[^A-Z0-9-]/g, '') || DEFAULT_SKU_PREFIX;

  const candidates = all.filter(isCandidate);
  const alreadyArabic = all.filter((r) => !dict.isLatinOnly(r.name));
  const humanEnglish = all.filter((r) => dict.isLatinOnly(r.name) && !isCandidate(r));

  // SKU allocation. Seeded from the highest existing PREFIX-NNNNN so a re-run
  // never reuses a number, and every generated code is checked against the
  // live sku_norm set (uq_inv_items_sku_norm is UNIQUE) before it is handed
  // out. sku_norm is UPPER(TRIM(sku)) — the same normalisation the route uses.
  const used = new Set(
    all.map((r) => trim(r.sku_norm) || trim(r.sku).toUpperCase()).filter(Boolean)
  );
  const seqRe = new RegExp('^' + skuPrefix + '-(\\d+)$');
  let seq = 0;
  for (const code of used) {
    const m = seqRe.exec(code);
    if (m) seq = Math.max(seq, Number(m[1]) || 0);
  }
  const nextSku = () => {
    for (;;) {
      seq += 1;
      const sku = skuPrefix + '-' + String(seq).padStart(5, '0');
      if (!used.has(sku)) { used.add(sku); return sku; }
    }
  };

  const work = opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;
  const plan = work.map((r) => {
    const t = dict.toArabic(r.name);
    const hadSku = !!trim(r.sku);
    return {
      id: r.id,
      oldName: r.name,
      newNameEn: r.name,                 // verbatim — it IS the English
      newNameAr: t.ar || r.name,
      sku: trim(r.sku) || nextSku(),
      hadSku,
      matched: t.matched,
      tokens: t.tokens,
      untranslated: t.untranslated,
      needsReview: t.matched === 0,
      wordOrderRisk: !!t.wordOrderRisk,
    };
  });

  const review = plan.filter((p) => p.needsReview);
  const ordering = plan.filter((p) => !p.needsReview && p.wordOrderRisk);
  const partial = plan.filter((p) => !p.needsReview && !p.wordOrderRisk && p.untranslated.length);

  return {
    plan,
    review,
    ordering,
    partial,
    skipped: { alreadyArabic, humanEnglish },
    vocabulary: [...new Set(plan.flatMap((p) => p.untranslated.map((w) => w.toLowerCase())))].sort(),
    stats: {
      total: all.length,
      candidates: candidates.length,
      planned: plan.length,
      newSkus: plan.filter((p) => !p.hadSku).length,
      alreadyArabic: alreadyArabic.length,
      humanEnglish: humanEnglish.length,
      needsReview: review.length,
      wordOrderRisk: ordering.length,
      partial: partial.length,
      clean: plan.length - review.length - ordering.length - partial.length,
    },
  };
}

/** Columns this migration owns. Anything not here must not appear in the SET. */
const WRITABLE_COLUMNS = Object.freeze(['name', 'name_en', 'sku', 'sku_norm']);

/**
 * Apply a plan. One statement per row, keyed by primary key, naming only the
 * four columns above. A set-based statement would be faster and would also be
 * the kind of statement that can wreck a catalogue if its WHERE clause is
 * wrong.
 *
 * A row that fails (duplicate SKU from a concurrent write, oversized value) is
 * counted and reported; it never aborts the rest, because a half-fixed
 * catalogue is strictly better than a wholly broken one and the next run picks
 * the failure back up.
 *
 * @param {{query:Function}} conn  a mysql2 pool/connection
 */
async function applyPlan(conn, plan) {
  let updated = 0;
  const failures = [];
  for (const p of plan) {
    try {
      await conn.query(
        'UPDATE inv_items SET name = ?, name_en = ?, sku = ?, sku_norm = ? WHERE id = ?',
        [p.newNameAr, p.newNameEn, p.sku, p.sku.trim().toUpperCase(), p.id]
      );
      updated += 1;
    } catch (e) {
      failures.push({ id: p.id, name: p.oldName, error: e.code || e.message });
    }
  }
  return { updated, failures };
}

/** The columns the plan needs. Kept here so both callers select the same set. */
const SELECT_SQL =
  'SELECT id, name, name_en, sku, sku_norm FROM inv_items ORDER BY name';

module.exports = {
  planBilingualNames,
  applyPlan,
  isCandidate,
  SELECT_SQL,
  WRITABLE_COLUMNS,
  DEFAULT_SKU_PREFIX,
};
