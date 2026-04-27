/**
 * V4 — Transaction Schema validator tests
 */
'use strict';

const { validate, schemas } = require('../lib/transactionSchema');

let _passed = 0, _failed = 0;
function test(name, fn) {
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name, '-', e.message); }
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
function assertFalse(v, msg) { if (v) throw new Error(msg || 'expected false'); }

console.log('\n═══ Transaction Schema Validator ═══');

console.log('\n─── Action schema ───');
test('Valid approve action passes', () => {
  const r = validate({ action: 'approve', username: 'admin', note: 'looks good' }, schemas.action);
  assertTrue(r.valid, r.errors.join(';'));
});
test('Missing action fails', () => {
  const r = validate({ username: 'admin' }, schemas.action);
  assertFalse(r.valid);
});
test('Invalid action enum fails', () => {
  const r = validate({ action: 'destroy', username: 'admin' }, schemas.action);
  assertFalse(r.valid);
});
test('Note over 5000 chars fails', () => {
  const r = validate({ action: 'reject', username: 'admin', note: 'x'.repeat(5001) }, schemas.action);
  assertFalse(r.valid);
});

console.log('\n─── Reply schema ───');
test('Valid reply passes', () => {
  const r = validate({ replyText: 'مرحبا', username: 'admin' }, schemas.reply);
  assertTrue(r.valid, r.errors.join(';'));
});
test('Empty reply text fails', () => {
  const r = validate({ replyText: '', username: 'admin' }, schemas.reply);
  assertFalse(r.valid);
});

console.log('\n─── Force-delete schema ───');
test('Valid force-delete passes', () => {
  const r = validate({ confirm: 'DELETE-FOREVER', reason: 'duplicate row' }, schemas.forceDelete);
  assertTrue(r.valid, r.errors.join(';'));
});
test('Wrong confirm phrase fails', () => {
  const r = validate({ confirm: 'yes', reason: 'whatever' }, schemas.forceDelete);
  assertFalse(r.valid);
});
test('Short reason fails', () => {
  const r = validate({ confirm: 'DELETE-FOREVER', reason: 'x' }, schemas.forceDelete);
  assertFalse(r.valid);
});

console.log('\n─── Create schema ───');
test('Valid create passes', () => {
  const r = validate({
    transactionTypeId: 'TT-1',
    subject: 'طلب صرف عهدة',
    username: 'creator',
    amount: 1000,
    importance: 'medium'
  }, schemas.create);
  assertTrue(r.valid, r.errors.join(';'));
});
test('Subject too short fails', () => {
  const r = validate({
    transactionTypeId: 'TT-1', subject: 'X', username: 'creator'
  }, schemas.create);
  assertFalse(r.valid);
});
test('Negative amount fails', () => {
  const r = validate({
    transactionTypeId: 'TT-1', subject: 'valid subject', username: 'creator', amount: -1
  }, schemas.create);
  assertFalse(r.valid);
});
test('Invalid importance enum fails', () => {
  const r = validate({
    transactionTypeId: 'TT-1', subject: 'valid subject', username: 'creator', importance: 'urgent'
  }, schemas.create);
  assertFalse(r.valid);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Total: ${_passed + _failed} | Passed: ${_passed} | Failed: ${_failed}`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(_failed > 0 ? 1 : 0);
