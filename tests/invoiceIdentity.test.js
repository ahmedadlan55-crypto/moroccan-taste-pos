/** Unit — lib/invoiceIdentity.js (pure parts + a fake db). No live DB needed.
 *  Run: node tests/invoiceIdentity.test.js
 *
 *  Guards the two properties the receipt depends on:
 *   - SCOPE: branch → brand → company → global settings, most specific wins.
 *     `companies` (legal_name/cr_number/tax_number/logo_url) and `brands` were a
 *     fully-built identity model that NO receipt path read.
 *   - HISTORY: an identity hashes by content, so an issued invoice keeps the
 *     seller block it was printed with even after the owner edits the settings.
 */
'use strict';
const I = require('../lib/invoiceIdentity');
let _p = 0, _f = 0;
const check = (n, c, x) => { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x).slice(0, 200) : ''); } };

/** Minimal db stub: routes queries by the table named in the SQL. */
function fakeDb({ settings = {}, branches = [], brands = [], companies = [] }) {
  return {
    async query(sql, params) {
      if (/FROM settings/i.test(sql)) {
        return [Object.entries(settings).map(([k, v]) => ({ setting_key: k, setting_value: v }))];
      }
      if (/FROM branches/i.test(sql)) return [branches.filter((b) => b.id === params[0])];
      if (/FROM brands/i.test(sql)) return [brands.filter((b) => b.id === params[0])];
      if (/FROM companies/i.test(sql)) return [companies.filter((c) => c.id === params[0])];
      return [[]];
    },
  };
}

(async () => {
  console.log('\n═══ invoiceIdentity ═══');

  // ── scope resolution ──
  const db = fakeDb({
    settings: { CompanyName: 'Global Co', TaxNumber: '300000000000003', Currency: 'SAR', VATRate: '15', logo: 'global-logo', receiptFooter: 'global footer' },
    branches: [{ id: 'BR-1', name: 'فرع العليا', location: 'الرياض — العليا', company_name: 'شركة التشغيل', company_id: 'CO-1' }],
    brands: [{ id: 'BRAND-1', name: 'Burger Wagef', logo: 'brand-logo' }],
    companies: [{ id: 'CO-1', name: 'Company One', legal_name: 'شركة واحدة المحدودة', cr_number: '1010101010', tax_number: '311111111111113', base_currency: 'SAR', logo_url: 'company-logo' }],
  });

  const onlyGlobal = await I.resolveIdentity(db, {});
  check('global settings resolve when there is no scope', onlyGlobal.identity.sellerName === 'Global Co' && onlyGlobal.identity.taxNumber === '300000000000003');
  check('global source is reported', onlyGlobal.sources.sellerName === 'settings.CompanyName');

  const scoped = await I.resolveIdentity(db, { branchId: 'BR-1', brandId: 'BRAND-1' });
  check('company tax number overrides the global one', scoped.identity.taxNumber === '311111111111113', scoped.identity.taxNumber);
  check('CR number now resolves (companies.cr_number was never printed before)', scoped.identity.crNumber === '1010101010');
  check('legal name resolves', scoped.identity.legalName === 'شركة واحدة المحدودة');
  check('brand logo beats the company logo', scoped.identity.logo === 'brand-logo', scoped.identity.logo);
  check('brand name resolves', scoped.identity.brandName === 'Burger Wagef');
  check('branch name + address resolve', scoped.identity.branchName === 'فرع العليا' && scoped.identity.address === 'الرياض — العليا');
  check('operating company per branch resolves', scoped.identity.branchCompanyName === 'شركة التشغيل');
  check('source chain is reported for diagnosis', scoped.sources.taxNumber === 'companies.tax_number' && scoped.sources.logo === 'brands.logo', scoped.sources);
  check('vatRate is numeric', scoped.identity.vatRate === 15);

  // Falls back cleanly when the scope points at rows that do not exist.
  const missing = await I.resolveIdentity(db, { branchId: 'NOPE', brandId: 'NOPE' });
  check('unknown scope falls back to global without throwing', missing.identity.sellerName === 'Global Co');

  // ── content addressing / history ──
  const a = (await I.resolveIdentity(db, { branchId: 'BR-1', brandId: 'BRAND-1' })).identity;
  const b = (await I.resolveIdentity(db, { branchId: 'BR-1', brandId: 'BRAND-1' })).identity;
  check('same identity → same hash (one shared row, not one per sale)', I.identityHash(a) === I.identityHash(b));

  const changed = { ...a, taxNumber: '399999999999993' };
  check('changing the tax number mints a DIFFERENT hash (old sales keep the old row)', I.identityHash(a) !== I.identityHash(changed));

  const reordered = {};
  Object.keys(a).sort().reverse().forEach((k) => { reordered[k] = a[k]; });
  check('hash is stable under key order (canonical JSON)', I.identityHash(a) === I.identityHash(reordered));

  // ── snapshot round-trip against a stub store ──
  const store = new Map();
  const snapDb = {
    async query(sql, params) {
      if (/INSERT IGNORE INTO receipt_identities/i.test(sql)) { if (!store.has(params[0])) store.set(params[0], params[1]); return [{}]; }
      if (/FROM receipt_identities/i.test(sql)) { const v = store.get(params[0]); return [v ? [{ payload_json: v }] : []]; }
      return [[]];
    },
  };
  const id1 = await I.snapshotIdentity(snapDb, a);
  await I.snapshotIdentity(snapDb, a);
  check('snapshotting the same identity twice writes ONE row', store.size === 1);
  const loaded = await I.loadIdentity(snapDb, id1);
  check('snapshot round-trips the seller block', loaded && loaded.taxNumber === a.taxNumber && loaded.logo === a.logo);

  // THE guarantee: settings change afterwards, the issued invoice does not.
  const id2 = await I.snapshotIdentity(snapDb, changed);
  const stillOld = await I.loadIdentity(snapDb, id1);
  check('after the tax number changes, the ISSUED invoice still reads the old one',
    stillOld.taxNumber === '311111111111113' && id2 !== id1, { was: stillOld.taxNumber });

  check('unknown snapshot id → null (pre-migration sales fall back to live)', (await I.loadIdentity(snapDb, 'nope')) === null);
  check('null snapshot id → null', (await I.loadIdentity(snapDb, null)) === null);

  // ── showFields ──
  check('showFields defaults to everything on', I.showFields(null).qr === true && I.showFields(null).crNumber === true);
  check('showFields honours an explicit off', I.showFields('{"qr":false}').qr === false);
  check('showFields tolerates both boolean spellings', I.showFields('{"qr":"0","logo":"true"}').qr === false && I.showFields('{"qr":"0","logo":"true"}').logo === true);
  check('showFields survives malformed JSON', I.showFields('{not json').qr === true);

  console.log(`\n${_f === 0 ? '✅' : '❌'} invoiceIdentity: ${_p} passed, ${_f} failed`);
  process.exit(_f === 0 ? 0 : 1);
})();
