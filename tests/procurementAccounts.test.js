#!/usr/bin/env node
'use strict';

const { ensureProcurementAccounts, codes } = require('../lib/procurement/accounts');
const { CORE_ACCOUNTS } = require('../lib/glPosting');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅', name);
  } catch (error) {
    failed++;
    console.log('  ❌', name, '-', error.message);
  }
}

function account(code, type) {
  return { id: `GL-${code}`, code, type, is_active: 1, is_folder: 0, account_class: 'detail' };
}

function fakeDb(overrides = {}) {
  const c = codes();
  const rowsByCode = {
    [c.inventory]: account(c.inventory, 'asset'),
    [c.grni]: account(c.grni, 'liability'),
    [c.ap]: account(c.ap, 'liability'),
    [c.inputVat]: account(c.inputVat, 'asset'),
    ...overrides,
  };
  return {
    async query(sql, params) {
      if (/SELECT id, code, type/.test(sql)) return [[rowsByCode[params[0]]].filter(Boolean)];
      if (/SELECT parent_id, level/.test(sql)) return [[{ parent_id: '200100', level: 3 }]];
      if (/INSERT IGNORE INTO gl_accounts/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

(async () => {
  console.log('\n▶ procurement account contract\n');

  await test('inventory uses the canonical central control account', async () => {
    if (codes().inventory !== CORE_ACCOUNTS.INVENTORY.code) {
      throw new Error('procurement inventory code drifted from CORE_ACCOUNTS');
    }
  });

  await test('returns inventory + GRNI + AP + input VAT as postable accounts', async () => {
    const resolved = await ensureProcurementAccounts(fakeDb());
    for (const key of ['inventory', 'grni', 'ap', 'inputVat']) {
      if (!resolved[key] || !resolved[key].id || !resolved[key].code) {
        throw new Error(`missing resolved account: ${key}`);
      }
    }
  });

  await test('fails closed when the inventory control account is missing', async () => {
    const c = codes();
    let thrown;
    try { await ensureProcurementAccounts(fakeDb({ [c.inventory]: null })); }
    catch (error) { thrown = error; }
    if (!thrown || thrown.code !== 'PROC_ACCOUNT_MISSING') {
      throw new Error(`expected PROC_ACCOUNT_MISSING, got ${thrown && thrown.code}`);
    }
  });

  await test('rejects a structural inventory folder as a posting target', async () => {
    const c = codes();
    const folder = { ...account(c.inventory, 'asset'), is_folder: 1 };
    let thrown;
    try { await ensureProcurementAccounts(fakeDb({ [c.inventory]: folder })); }
    catch (error) { thrown = error; }
    if (!thrown || thrown.code !== 'PROC_GRNI_STRUCTURAL') {
      throw new Error(`expected PROC_GRNI_STRUCTURAL, got ${thrown && thrown.code}`);
    }
  });

  console.log(`\nProcurement accounts: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
