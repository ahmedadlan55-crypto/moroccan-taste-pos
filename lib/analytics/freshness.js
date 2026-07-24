/**
 * lib/analytics/freshness.js — the honesty header every analytics response
 * carries. This wave serves LIVE fact queries only (rollup routing is a later
 * wave), so `source` is always 'live'; the watermark is the rollup worker's
 * high-water mark when one exists (analytics_rollup_state), else the moment
 * the response was generated. lagSeconds / pendingDays stay null until the
 * rollup path lands — null means "not measured", never "zero".
 */
'use strict';

const WATERMARK_KEY = 'rollup_watermark';

/**
 * @param {object} db  pool/connection (mysql2 promise interface)
 * @param {Date}   [now]  injected clock for tests
 * @returns {Promise<{source:'live',watermark:string,lagSeconds:null,pendingDays:null}>}
 */
async function read(db, now) {
  let watermark = null;
  try {
    const [rows] = await db.query(
      'SELECT v FROM analytics_rollup_state WHERE k = ? LIMIT 1', [WATERMARK_KEY]);
    if (rows.length && rows[0].v != null && String(rows[0].v) !== '') {
      watermark = String(rows[0].v);
    }
  } catch (_) {
    // table not migrated yet — live reads still work, watermark = generatedAt
  }
  const generatedAt = (now instanceof Date ? now : new Date()).toISOString();
  return {
    source: 'live',
    watermark: watermark || generatedAt,
    lagSeconds: null,
    pendingDays: null,
  };
}

module.exports = { read, WATERMARK_KEY };
