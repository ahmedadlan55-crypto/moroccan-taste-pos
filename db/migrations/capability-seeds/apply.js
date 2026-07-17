'use strict';
/**
 * db/migrations/capability-seeds/apply.js — applies every *.json in this
 * directory into permissions_v3 + role_permissions. Idempotent (INSERT IGNORE),
 * additive-only: it never revokes a grant and never edits an existing
 * capability's labels — a live install's admin customizations survive.
 *
 * Why a directory of JSON instead of code: the closure work ran as parallel
 * streams that each guarded their own routes; letting each stream edit the
 * central seeder meant guaranteed merge conflicts on one hot file. Streams
 * declare, this module applies.
 *
 * Shape per file: [{ id, label_ar, label_en, is_sensitive, roles: [...] }]
 * Called at boot from server.js next to seedO2CCapabilities. Also runnable
 * standalone:  node db/migrations/capability-seeds/apply.js
 */
const fs = require('fs');
const path = require('path');

async function applyCapabilitySeeds(db, log = () => {}) {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  let caps = 0, grants = 0;
  for (const f of files) {
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { console.error(`[capability-seeds] ${f} is not valid JSON — REFUSING to continue:`, e.message); throw e; }
    if (!Array.isArray(list)) { throw new Error(`[capability-seeds] ${f}: expected a top-level array`); }
    for (const c of list) {
      if (!c.id || !Array.isArray(c.roles)) throw new Error(`[capability-seeds] ${f}: entry missing id/roles: ${JSON.stringify(c).slice(0, 80)}`);
      const [r1] = await db.query(
        `INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order)
         VALUES (?, 'closure', ?, ?, ?, 990)`,
        [c.id, c.label_ar || c.id, c.label_en || c.id, c.is_sensitive ? 1 : 0]);
      if (r1.affectedRows) caps++;
      for (const role of c.roles) {
        const [r2] = await db.query(
          'INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', [role, c.id]);
        if (r2.affectedRows) grants++;
      }
    }
    log(`  ✓ ${f}: ${list.length} capabilities`);
  }
  log(`  capability-seeds: +${caps} capabilities, +${grants} grants (idempotent)`);
  return { caps, grants };
}

module.exports = { applyCapabilitySeeds };

if (require.main === module) {
  const db = require('../../connection');
  applyCapabilitySeeds(db, console.log)
    .then(async (r) => { console.log('done', r); await db.end(); process.exit(0); })
    .catch(async (e) => { console.error('FAILED:', e.message); try { await db.end(); } catch (_) {} process.exit(1); });
}
