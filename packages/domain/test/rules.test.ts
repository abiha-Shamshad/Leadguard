// One test per row of the Section 30.1 transition table, plus policy schema bounds and contact helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTargets, checkTransition } from '../src/lead-transitions.ts';
import { policyBodySchema, defaultPolicy } from '../src/policy-schema.ts';
import { normalizePhone, normalizeEmail, hashDedupeKey, maskPhone } from '../src/contact.ts';
import { validateDays } from '../src/business-hours-schema.ts';
import { uuidv7, UUID_RE } from '../src/uuid.ts';

test('T-1 new -> attempted, contacted', () => {
  assert.equal(checkTransition('new', 'attempted', 'member', null).ok, true);
  assert.equal(checkTransition('new', 'contacted', 'member', null).ok, true);
});
test('T-2 new -> lost, spam require reason', () => {
  assert.equal(checkTransition('new', 'lost', 'member', null).ok, false);
  assert.equal(checkTransition('new', 'spam', 'member', 'robot').ok, true);
});
test('T-3 attempted -> contacted, lost, spam', () => {
  assert.deepEqual(allowedTargets('attempted', 'member'), ['contacted', 'lost', 'spam']);
});
test('T-4 contacted -> qualified, won, lost (lost needs reason)', () => {
  assert.deepEqual(allowedTargets('contacted', 'member'), ['qualified', 'won', 'lost']);
  assert.equal(checkTransition('contacted', 'won', 'member', null).ok, true);
  assert.equal(checkTransition('contacted', 'lost', 'member', '').ok, false);
});
test('T-5 qualified -> won, lost', () => {
  assert.deepEqual(allowedTargets('qualified', 'member'), ['won', 'lost']);
});
test('T-6 reopen won/lost/spam -> attempted is manager/owner only and needs reason', () => {
  assert.deepEqual(allowedTargets('won', 'member'), []);
  assert.equal(checkTransition('lost', 'attempted', 'manager', null).ok, false);
  const r = checkTransition('spam', 'attempted', 'owner', 'Real customer');
  assert.ok(r.ok && r.reopen);
});
test('T-7 merged is terminal and never a target of API-029', () => {
  assert.deepEqual(allowedTargets('merged', 'owner'), []);
  assert.equal(checkTransition('new', 'merged', 'owner', 'x').ok, false);
});
test('API-029 example: new -> won is rejected with the allowed list', () => {
  const r = checkTransition('new', 'won', 'owner', null);
  assert.ok(!r.ok);
  if (!r.ok) assert.deepEqual(r.allowed, ['attempted', 'contacted', 'lost', 'spam']);
});

test('policy: default policy is valid', () => {
  const { version, ...body } = defaultPolicy();
  assert.equal(version, 1);
  assert.ok(policyBodySchema.safeParse(body).success);
});
test('policy: bounds and unknown keys rejected', () => {
  const { version, ...body } = defaultPolicy();
  assert.equal(policyBodySchema.safeParse({ ...body, first_response: { target_minutes: 4, business_hours_only: true } }).success, false);
  assert.equal(policyBodySchema.safeParse({ ...body, follow_up: { attempt_intervals_minutes: [60], max_attempts: 7 } }).success, false);
  assert.equal(policyBodySchema.safeParse({ ...body, script: 'x' }).success, false);
  assert.equal(policyBodySchema.safeParse({ ...body, unassigned_escalation_minutes: 241 }).success, false);
});

test('phone normalization: US formats to E.164; garbage kept raw', () => {
  assert.deepEqual(normalizePhone('(512) 555-0142'), { e164: '+15125550142', raw: null });
  assert.deepEqual(normalizePhone('call me'), { e164: null, raw: 'call me' });
  assert.equal(maskPhone('+15125550199', null), '(512) ***-0199');
});
test('email normalization lowercases and rejects invalid', () => {
  assert.equal(normalizeEmail(' Dana.Morales@Example.com '), 'dana.morales@example.com');
  assert.equal(normalizeEmail('nope'), null);
});
test('hash dedupe key is stable within the same minute', () => {
  const a = hashDedupeKey('s', 'a@b.co', null, 'hi', '2026-10-14T15:42:10Z');
  const b = hashDedupeKey('s', 'a@b.co', null, 'hi', '2026-10-14T15:42:55Z');
  assert.equal(a, b);
  assert.ok(a.startsWith('hash:') && a.length <= 200);
});
test('business hours: inverted and overlapping intervals rejected', () => {
  assert.equal(validateDays([{ weekday: 'mon', open: '18:00', close: '07:30' }])[0].path, 'days[0].close');
  assert.equal(validateDays([{ weekday: 'mon', open: '08:00', close: '12:00' }, { weekday: 'mon', open: '11:00', close: '14:00' }]).length, 1);
  assert.equal(validateDays([{ weekday: 'sat', open: null, close: null }])[0].path, 'days');
});
test('uuidv7 has version 7 and sorts by time', () => {
  const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
  assert.ok(UUID_RE.test(a) && a[14] === '7');
  assert.ok(a < b);
});
