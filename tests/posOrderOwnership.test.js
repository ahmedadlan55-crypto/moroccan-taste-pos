'use strict';

const O = require('../lib/posOrderOwnership');
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, detail || ''); }
}

console.log('\nposOrderOwnership');

// Same durable account after a login-name rename: allowed.
check('stable user id survives username rename',
  O.isOwnedBy({ owner_user_id: 41, username: 'old.login' }, { id: 41, username: 'new.login', role: 'cashier' }));

// Stable ids are authoritative. A copied/display-equal name never grants access.
check('different stable account is denied even when username text matches',
  !O.isOwnedBy({ owner_user_id: 41, username: 'cashier' }, { id: 42, username: 'cashier', role: 'cashier' }));

check('another cashier is denied',
  !O.isOwnedBy({ owner_user_id: 41, username: 'a' }, { id: 42, username: 'b', role: 'cashier' }));

// Pre-migration rows keep working, including harmless case drift under the
// database's case-insensitive username collation.
check('legacy row falls back to normalized username',
  O.isOwnedBy({ owner_user_id: null, username: 'Cashier.One' }, { id: 41, username: 'cashier.one', role: 'cashier' }));
check('legacy row still denies a genuinely different username',
  !O.isOwnedBy({ owner_user_id: null, username: 'cashier.one' }, { id: 41, username: 'cashier.two', role: 'cashier' }));

check('manager can recover another cashier order',
  O.isOwnedBy({ owner_user_id: 41, username: 'a' }, { id: 99, username: 'mgr', role: 'manager' }));
check('admin can recover another cashier order',
  O.isOwnedBy({ owner_user_id: 41, username: 'a' }, { id: 99, username: 'adm', role: 'admin' }));

check('ownership message is actionable and bilingual',
  /سجّل دخول صاحبه/.test(O.ownershipMessage()) && /ask a manager/i.test(O.ownershipMessage()));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
