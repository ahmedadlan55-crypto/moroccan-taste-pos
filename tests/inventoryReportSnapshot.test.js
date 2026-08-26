'use strict';
const fs = require('fs');
const path = require('path');
let passed = 0;
function check(name, ok) { if (!ok) throw new Error('FAIL: ' + name); passed++; console.log('✓ ' + name); }
const items = fs.readFileSync(path.join(__dirname, '..', 'routes', 'inventory-items.js'), 'utf8');
const lots = fs.readFileSync(path.join(__dirname, '..', 'routes', 'inventory-lots.js'), 'utf8');
check('replenishment snapshot has a 5,000 row ceiling', /REPORT_SNAPSHOT_LIMIT\s*=\s*5000/.test(items));
check('replenishment snapshot refuses overflow with 413', /snapshot[\s\S]*_snapshotTooLarge/.test(items) && /status\(413\)/.test(items));
check('replenishment CSV applies status and risk to the complete export', /statusFilter[\s\S]*reorderStatus/.test(items));
check('lots snapshot is bounded to 5,001 sentinel rows', /REPORT_SNAPSHOT_LIMIT \+ 1/.test(lots) && /LIMIT \?/.test(lots));
check('lots snapshot refuses overflow with 413', /snapshot && total > REPORT_SNAPSHOT_LIMIT/.test(lots));
check('lot risk is applied in SQL before COUNT and paging', /const riskSql = _expiryRiskSql\(q\.risk\)/.test(lots));
check('expiry level is applied in SQL before COUNT and paging', /const levelSql = _expiryRiskSql\(req\.query\.level\)/.test(lots));
check('expiry snapshot returns its bounded result or 413', /REPORT_SNAPSHOT_LIMIT \+ 1/.test(lots) && /snapshot && total > REPORT_SNAPSHOT_LIMIT/.test(lots));
console.log(`\n${passed}/${passed} inventory snapshot contract checks passed`);
