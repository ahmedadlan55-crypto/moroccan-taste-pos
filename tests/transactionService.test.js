/**
 * Phase 1 — TransactionService unit tests
 *
 * Tests run WITHOUT a database. The repository layer is swapped for
 * in-memory mocks via Node's `require` cache so we can exercise the
 * service's orchestration logic in isolation.
 *
 * Run with: node tests/transactionService.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let _passed = 0, _failed = 0, _total = 0;

function test(name, fn) {
  _total++;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(() => { _passed++; console.log('  ✅', name); })
                .catch(e => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
    }
    _passed++;
    console.log('  ✅', name);
  } catch (e) {
    _failed++;
    console.log('  ❌', name);
    console.log('     ', e.message);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || 'assertDeepEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

async function assertThrows(fn, expectedCode) {
  try {
    await fn();
  } catch (e) {
    if (expectedCode && e.code !== expectedCode) {
      throw new Error('expected error code ' + expectedCode + ', got ' + e.code + ' (' + e.message + ')');
    }
    return;
  }
  throw new Error('expected fn to throw');
}

// ─── Mock infrastructure ─────────────────────────────────────────────
// Replace repository + DB modules in the require cache BEFORE loading
// TransactionService. The service will pick up the mocks transparently.
const REPO_ROOT = path.resolve(__dirname, '..');

function _resolvedPath(rel) { return require.resolve(path.join(REPO_ROOT, rel)); }

function installMocks(overrides) {
  // Repository mocks
  const txMock = Object.assign({
    nextDailySerial: async () => 1,
    insertTx: async () => 'TXN-MOCK',
    updateOptionalFieldsTx: async () => {},
    insertRecipientsTx: async () => 0,
    insertStepLogTx: async () => 'LOG-MOCK',
    findSnapshotById: async () => null,
    forceDeleteCascadeTx: async () => {}
  }, overrides.tx || {});
  const workflowMock = Object.assign({
    findTypeById: async () => ({ id: 1, code: 'PUR', name: 'Purchase' }),
    getInitiatorFirstStep: async () => null,
    getFirstStepForType: async () => null,
    normalizePositionStep: (r) => r,
    getPositionName: async () => ''
  }, overrides.workflow || {});
  const usersMock = Object.assign({
    findBranchById: async () => null,
    findDepartmentById: async () => null,
    getPermissionProfile: async () => ({
      isEmployee: false, role: 'employee', canCreate: true,
      branchCode: 'HQ', branchName: 'HQ', branchId: '',
      deptCode: 'OPS', deptName: 'Ops', deptId: '',
      positionId: '', positionName: '', managerId: ''
    }),
    findUsernameByEmployeeCode: async () => '',
    findUsernameByEmployeeName: async () => '',
    findManagerUsername: async () => '',
    getPositionNameForUser: async () => '',
    findCandidateEmployee: async () => null,
    findCandidateUserByPosition: async () => null
  }, overrides.users || {});

  require.cache[_resolvedPath('repositories/TransactionRepository.js')] = {
    id: _resolvedPath('repositories/TransactionRepository.js'),
    filename: _resolvedPath('repositories/TransactionRepository.js'),
    loaded: true, exports: txMock
  };
  require.cache[_resolvedPath('repositories/WorkflowRepository.js')] = {
    id: _resolvedPath('repositories/WorkflowRepository.js'),
    filename: _resolvedPath('repositories/WorkflowRepository.js'),
    loaded: true, exports: workflowMock
  };
  require.cache[_resolvedPath('repositories/UserRepository.js')] = {
    id: _resolvedPath('repositories/UserRepository.js'),
    filename: _resolvedPath('repositories/UserRepository.js'),
    loaded: true, exports: usersMock
  };
  // Force the barrel to re-resolve with our mocks
  delete require.cache[_resolvedPath('repositories/index.js')];

  // db mock — withTransaction invokes the callback with a stub conn
  const dbMock = {
    query: async () => [[], []],
    withTransaction: async (fn) => fn({ query: async () => [[], []] })
  };
  require.cache[_resolvedPath('db/connection.js')] = {
    id: _resolvedPath('db/connection.js'),
    filename: _resolvedPath('db/connection.js'),
    loaded: true, exports: dbMock
  };

  // Audit + notify side effects shouldn't matter for our assertions
  const auditMock = {
    record: async () => {}, appendChain: async () => {},
    recordForceDelete: async () => {}, recordCreate: async () => {}
  };
  const notifyMock = {
    notify: async () => {}, notifyTransactionAction: async () => {}
  };
  require.cache[_resolvedPath('services/AuditService.js')] = {
    id: _resolvedPath('services/AuditService.js'),
    filename: _resolvedPath('services/AuditService.js'),
    loaded: true, exports: auditMock
  };
  require.cache[_resolvedPath('services/NotificationService.js')] = {
    id: _resolvedPath('services/NotificationService.js'),
    filename: _resolvedPath('services/NotificationService.js'),
    loaded: true, exports: notifyMock
  };

  // Reset the service module so it picks up the mocks
  delete require.cache[_resolvedPath('services/TransactionService.js')];
  delete require.cache[_resolvedPath('services/AssigneeResolverService.js')];

  return {
    tx: txMock, workflow: workflowMock, users: usersMock,
    db: dbMock, audit: auditMock, notify: notifyMock
  };
}

function uninstallMocks() {
  delete require.cache[_resolvedPath('repositories/TransactionRepository.js')];
  delete require.cache[_resolvedPath('repositories/WorkflowRepository.js')];
  delete require.cache[_resolvedPath('repositories/UserRepository.js')];
  delete require.cache[_resolvedPath('repositories/index.js')];
  delete require.cache[_resolvedPath('db/connection.js')];
  delete require.cache[_resolvedPath('services/AuditService.js')];
  delete require.cache[_resolvedPath('services/NotificationService.js')];
  delete require.cache[_resolvedPath('services/TransactionService.js')];
  delete require.cache[_resolvedPath('services/AssigneeResolverService.js')];
}

// ─── Tests ───────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log(' TransactionService — Phase 1 unit tests');
console.log('═══════════════════════════════════════════════════════════');

console.log('\n─── ValidationError throwing ───');

(async function group1() {
  installMocks({});
  const svc = require('../services/TransactionService');

  await test('create() rejects missing transactionTypeId', async () => {
    await assertThrows(
      () => svc.create({ title: 'X', username: 'u' }, { username: 'u' }),
      'VALIDATION'
    );
  });

  await test('create() rejects missing title', async () => {
    await assertThrows(
      () => svc.create({ transactionTypeId: 1, username: 'u' }, { username: 'u' }),
      'VALIDATION'
    );
  });

  await test('create() rejects missing actor username', async () => {
    await assertThrows(
      () => svc.create({ transactionTypeId: 1, title: 'X' }, {}),
      'VALIDATION'
    );
  });

  uninstallMocks();
})();

console.log('\n─── PermissionDeniedError when canCreate=false ───');

(async function group2() {
  installMocks({
    users: {
      getPermissionProfile: async () => ({
        canCreate: false, branchCode: 'X', branchName: '',
        deptCode: '', deptName: '', positionId: ''
      })
    }
  });
  const svc = require('../services/TransactionService');

  await test('create() denies user with canCreate=false', async () => {
    await assertThrows(
      () => svc.create({ transactionTypeId: 1, title: 'X' }, { username: 'limited_user' }),
      'PERMISSION_DENIED'
    );
  });

  uninstallMocks();
})();

console.log('\n─── NotFoundError when type missing ───');

(async function group3() {
  installMocks({
    workflow: {
      findTypeById: async () => null,
      getInitiatorFirstStep: async () => null,
      getFirstStepForType: async () => null,
      normalizePositionStep: (r) => r,
      getPositionName: async () => ''
    }
  });
  const svc = require('../services/TransactionService');

  await test('create() throws NOT_FOUND when transaction type missing', async () => {
    await assertThrows(
      () => svc.create({ transactionTypeId: 999, title: 'X' }, { username: 'u' }),
      'NOT_FOUND'
    );
  });

  uninstallMocks();
})();

console.log('\n─── forceDelete flow ───');

(async function group4() {
  let cascadeCalled = false;
  installMocks({
    tx: {
      findSnapshotById: async (id) => ({
        id, txnNumber: 'BR-DEP-T-20260523-0001',
        title: 'Test', subject: 'Test', createdBy: 'creator', amount: 500
      }),
      forceDeleteCascadeTx: async () => { cascadeCalled = true; }
    }
  });
  const svc = require('../services/TransactionService');

  await test('forceDelete() throws NOT_FOUND on missing txn', async () => {
    // Mock returns null for any other id
    installMocks({
      tx: {
        findSnapshotById: async () => null,
        forceDeleteCascadeTx: async () => {}
      }
    });
    const svc2 = require('../services/TransactionService');
    await assertThrows(
      () => svc2.forceDelete('nonexistent', { reason: 'test reason' }, { username: 'admin' }),
      'NOT_FOUND'
    );
    uninstallMocks();
  });

  // Re-install for happy path
  cascadeCalled = false;
  installMocks({
    tx: {
      findSnapshotById: async (id) => ({
        id, txnNumber: 'BR-DEP-T-20260523-0001',
        title: 'Test', subject: 'Test', createdBy: 'creator', amount: 500
      }),
      forceDeleteCascadeTx: async () => { cascadeCalled = true; }
    }
  });
  const svc3 = require('../services/TransactionService');

  await test('forceDelete() returns success on happy path', async () => {
    const r = await svc3.forceDelete('TXN-1', { reason: 'test reason 12345' }, { username: 'admin' });
    assertEqual(r.success, true, 'success flag');
    assertEqual(r.deletedId, 'TXN-1', 'deletedId echoed');
    assertEqual(r.txnNumber, 'BR-DEP-T-20260523-0001', 'txnNumber from snapshot');
  });

  await test('forceDelete() rejects empty txnId', async () => {
    await assertThrows(
      () => svc3.forceDelete('', { reason: 'x' }, { username: 'admin' }),
      'VALIDATION'
    );
  });

  uninstallMocks();
})();

console.log('\n─── transition() is stubbed (Phase 1.5) ───');

(async function group5() {
  installMocks({});
  const svc = require('../services/TransactionService');

  await test('transition() is intentionally not yet migrated', async () => {
    await assertThrows(
      () => svc.transition('TXN-1', 'approve', {}, { username: 'admin' })
    );
  });

  uninstallMocks();
})();

// ─── AssigneeResolverService tests ───────────────────────────────────

console.log('\n─── AssigneeResolverService ───');

(async function group6() {
  installMocks({});
  const ar = require('../services/AssigneeResolverService');

  await test('resolveForCreate() prefers explicit recipientUsername', async () => {
    const r = await ar.resolveForCreate({
      recipientUsername: 'explicit_user',
      recipients: [{ username: 'fallback_user' }],
      firstStep: null,
      sender: {}
    });
    assertEqual(r.username, 'explicit_user', 'explicit pick wins');
    assertEqual(r.source, 'recipient_username', 'source recorded');
  });

  await test('resolveForCreate() uses recipients[0].username when no explicit pick', async () => {
    const r = await ar.resolveForCreate({
      recipients: [{ username: 'first_recipient' }],
      firstStep: null,
      sender: {}
    });
    assertEqual(r.username, 'first_recipient', 'first recipient');
    assertEqual(r.source, 'recipients[0].username', 'source recorded');
  });

  await test('resolveForCreate() returns empty when nothing resolves', async () => {
    const r = await ar.resolveForCreate({
      recipients: [],
      firstStep: null,
      sender: { managerId: '' }
    });
    assertEqual(r.username, '', 'no assignee resolved');
  });

  uninstallMocks();

  // Manager fallback (level 6)
  installMocks({
    users: {
      findManagerUsername: async () => 'manager_user',
      findCandidateEmployee: async () => null,
      findCandidateUserByPosition: async () => null,
      findUsernameByEmployeeCode: async () => '',
      findUsernameByEmployeeName: async () => '',
      getPositionNameForUser: async () => ''
    },
    workflow: {
      getPositionName: async () => '',
      normalizePositionStep: (r) => r
    }
  });
  const ar2 = require('../services/AssigneeResolverService');
  await test('resolveForCreate() falls back to managerId when no other source', async () => {
    const r = await ar2.resolveForCreate({
      recipients: [],
      firstStep: null,
      sender: { managerId: 5 }
    });
    assertEqual(r.username, 'manager_user', 'manager picked');
    assertEqual(r.source, 'manager', 'source = manager');
  });

  uninstallMocks();
})();

// ─── Repository helper tests (pure) ──────────────────────────────────

console.log('\n─── TransactionRepository helpers ───');

(async function group7() {
  // No mocks here — we test the real _toDomain helper. Ensure any prior
  // mocks are cleared so we get the real module.
  uninstallMocks();
  const repo = require('../repositories/TransactionRepository');

  await test('_toDomain returns null for null row', () => {
    assertEqual(repo._toDomain(null), null);
  });

  await test('_toDomain maps snake_case → camelCase', () => {
    const d = repo._toDomain({
      id: 'TXN-1', transaction_number: 'BR-DEP', current_assignee: 'admin',
      version: 3, amount: 100, return_count: 2
    });
    assertEqual(d.id, 'TXN-1');
    assertEqual(d.txnNumber, 'BR-DEP');
    assertEqual(d.currentAssignee, 'admin');
    assertEqual(d.version, 3);
    assertEqual(d.returnCount, 2);
  });
})();

// ─── Migration runner — SQL splitter tests ───────────────────────────

console.log('\n─── Migration runner SQL splitter ───');

(async function group8() {
  const m = require('../db/migrate');

  await test('_splitStatements handles plain statements', () => {
    const stmts = m._splitStatements('SELECT 1; SELECT 2;');
    assertDeepEqual(stmts, ['SELECT 1', 'SELECT 2']);
  });

  await test('_splitStatements ignores semicolons in strings', () => {
    const stmts = m._splitStatements("INSERT INTO t VALUES ('a; b'); SELECT 2;");
    assertDeepEqual(stmts, ["INSERT INTO t VALUES ('a; b')", 'SELECT 2']);
  });

  await test('_splitStatements skips line comments', () => {
    const stmts = m._splitStatements("-- ignore; me\nSELECT 1;");
    assertDeepEqual(stmts, ['SELECT 1']);
  });

  await test('_splitStatements skips block comments', () => {
    const stmts = m._splitStatements("/* a; b */ SELECT 1;");
    assertDeepEqual(stmts, ['SELECT 1']);
  });

  await test('_splitStatements handles statement without trailing semicolon', () => {
    const stmts = m._splitStatements('SELECT 1');
    assertDeepEqual(stmts, ['SELECT 1']);
  });

  await test('_checksum is deterministic', () => {
    const a = m._checksum('hello world');
    const b = m._checksum('hello world');
    assertEqual(a, b, 'same input → same checksum');
  });
})();

// ─── Final report ────────────────────────────────────────────────────

// Schedule the report after all microtasks resolve
setImmediate(() => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Total:', _total, '| Passed:', _passed, '| Failed:', _failed);
  console.log('═══════════════════════════════════════════════════════════');
  if (_failed > 0) process.exit(1);
});
