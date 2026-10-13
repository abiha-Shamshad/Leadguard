// Worker unit tests. Timer claiming, alert firing, delivery, export building and the sweeper are exercised
// end to end against PostgreSQL by apps/api/test/{e2e,contract}.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../src/exports.ts';
import { channelsFor, DEFAULT_PREFS } from '@leadguard/db';

test('CSV cells: formula injection guard, quoting and dates', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('\tcmd'), `'\tcmd`);
  assert.equal(csvCell('a "quoted", value'), '"a ""quoted"", value"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(new Date('2026-10-14T15:42:10Z')), '2026-10-14T15:42:10.000Z');
  assert.equal(csvCell({ zip: '78704' }), '"{""zip"":""78704""}"');
  assert.equal(toCsv(['a', 'b'], [[1, 'x']]), 'a,b\r\n1,x\r\n');
});

test('alert channels: escalations always include in-app; email only with a configured provider', () => {
  const noInApp = { ...DEFAULT_PREFS, in_app: false, email: false };
  assert.deepEqual(channelsFor('reminder', DEFAULT_PREFS, { emailConfigured: false }), ['in_app']);
  assert.deepEqual(channelsFor('reminder', DEFAULT_PREFS, { emailConfigured: true }), ['in_app', 'email']);
  assert.deepEqual(channelsFor('reminder', noInApp, { emailConfigured: true }), []);
  assert.deepEqual(channelsFor('escalation', noInApp, { emailConfigured: true }), ['in_app', 'email']);
  assert.deepEqual(channelsFor('escalation', { ...noInApp, escalations_always_email: false }, { emailConfigured: true }), ['in_app']);
});
