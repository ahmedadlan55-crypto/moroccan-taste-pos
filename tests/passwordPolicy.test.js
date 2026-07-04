/** Unit — lib/passwordPolicy.js (pure). Run: node tests/passwordPolicy.test.js */
'use strict';
const P = require('../lib/passwordPolicy');
let _p = 0, _f = 0;
const check = (n, c, x) => { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x) : ''); } };

console.log('\n═══ passwordPolicy ═══');
check('strong password passes', P.validate('Str0ng#Pass!2026').ok);
check('under 12 fails', !P.validate('Ab#1cdef').ok);
check('no digit fails', !P.validate('Abcdefgh#jkl').ok);
check('no special fails', !P.validate('Abcdefgh12345').ok);
check('common (admin123) fails', !P.validate('admin123').ok);
check('common (password) fails', !P.validate('password').ok);
check('equals username fails', !P.validate('Cashier#User1', { username: 'Cashier#User1' }).ok);
check('16+ mixed → strength 4', P.strength('Str0ng#Passphrase!2026') === 4);
check('common → strength 0', P.strength('admin123') === 0);
check('errors array populated on failure', P.validate('short').errors.length >= 1);
check(`${_f === 0 ? '✅' : '❌'} passwordPolicy: ${_p} passed, ${_f} failed`, _f === 0);
process.exit(_f === 0 ? 0 : 1);
