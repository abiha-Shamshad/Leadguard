// Ported unchanged from the delivered domain/business-time.test.mjs (RUL-04a..k), plus port-specific cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessMinutes, parseLocalWallTime, businessMinutesBetween, formatLocal, type BusinessHours, type DayHours } from '../src/business-time.ts';

const weekdays: DayHours[] = (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map(w => ({ weekday: w, open: '08:00', close: '18:00' }));
const V3: BusinessHours = { zone: 'America/Chicago', days: weekdays, holidays: ['2026-11-26', '2026-12-25'] };
const V2: BusinessHours = { ...V3, days: [...weekdays, { weekday: 'sat', open: '09:00', close: '13:00' }] };

test('RUL-04a in-hours arrival: 10:42 CDT + 15 min = 10:57 CDT (API-025 example)', () => {
  assert.equal(addBusinessMinutes('2026-10-14T15:42:10Z', 15, V3), '2026-10-14T15:57:10Z');
});

test('RUL-04b Friday 17:55 + 15 min, Saturday closed -> Monday 08:10 CDT (API-035 example, hours v3)', () => {
  assert.equal(addBusinessMinutes('2026-10-16T22:55:00Z', 15, V3), '2026-10-19T13:10:00Z');
});

test('RUL-04c same arrival with Saturday open (hours v2) -> Saturday 09:10 CDT', () => {
  assert.equal(addBusinessMinutes('2026-10-16T22:55:00Z', 15, V2), '2026-10-17T14:10:00Z');
});

test('RUL-04d escalation 30 business minutes after the Monday 08:10 due time -> 08:40 CDT', () => {
  assert.equal(addBusinessMinutes('2026-10-19T13:10:00Z', 30, V3), '2026-10-19T13:40:00Z');
});

test('RUL-04e holiday (Thanksgiving Thu 2026-11-26) is skipped', () => {
  assert.equal(addBusinessMinutes('2026-11-25T23:50:00Z', 20, V3), '2026-11-27T14:10:00Z');
});

test('RUL-04f across DST end (Nov 1 2026): Fri Oct 30 17:50 CDT + 20 -> Mon Nov 2 08:10 CST', () => {
  assert.equal(addBusinessMinutes('2026-10-30T22:50:00Z', 20, V3), '2026-11-02T14:10:00Z');
});

test('RUL-04g before opening: 06:00 arrival + 15 -> 08:15 same day', () => {
  assert.equal(addBusinessMinutes('2026-10-14T11:00:00Z', 15, V3), '2026-10-14T13:15:00Z');
});

test('RUL-04h no open hours at all -> NO_BUSINESS_HOURS', () => {
  assert.throws(() => addBusinessMinutes('2026-10-14T15:00:00Z', 15, { ...V3, days: [] }), /NO_BUSINESS_HOURS/);
});

test('RUL-04i snooze local time: normal time converts (API-030 example)', () => {
  assert.equal(parseLocalWallTime('2026-10-15T09:00', 'America/Chicago'), '2026-10-15T14:00:00Z');
});

test('RUL-04j snooze in DST gap (2027-03-14 02:30 Chicago) is rejected', () => {
  assert.throws(() => parseLocalWallTime('2027-03-14T02:30', 'America/Chicago'), /LOCAL_TIME_IN_DST_GAP/);
});

test('RUL-04k snooze in repeated hour (2026-11-01 01:30 Chicago) is rejected', () => {
  assert.throws(() => parseLocalWallTime('2026-11-01T01:30', 'America/Chicago'), /LOCAL_TIME_AMBIGUOUS/);
});

// ---- port-specific
test('follow-up interval of 1440 business minutes spans several days', () => {
  // Wed 10:50 CDT + 1440 (=2.4 ten-hour days) -> Fri 14:50 CDT
  assert.equal(addBusinessMinutes('2026-10-14T15:50:00Z', 1440, V3), '2026-10-16T19:50:00Z');
});

test('intervals above 1440 are accepted up to 10080; above rejected', () => {
  assert.ok(addBusinessMinutes('2026-10-14T15:50:00Z', 10080, V3));
  assert.throws(() => addBusinessMinutes('2026-10-14T15:50:00Z', 10081, V3), /MINUTES_OUT_OF_RANGE/);
});

test('businessMinutesBetween is the inverse of addBusinessMinutes', () => {
  const due = addBusinessMinutes('2026-10-16T22:55:00Z', 15, V3);
  assert.equal(businessMinutesBetween('2026-10-16T22:55:00Z', due, V3), 15);
  assert.equal(businessMinutesBetween(due, '2026-10-16T22:55:00Z', V3), 0);
});

test('formatLocal produces the due_at_local format', () => {
  assert.equal(formatLocal('2026-10-14T15:57:10Z', 'America/Chicago'), 'Oct 14, 10:57 AM CDT');
});
