// Every HTML pattern must compile under the `v` flag exactly as browsers do, and accept/reject the right values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, stripControl } from './limits';

const html = (p: string) => new RegExp(`^(?:${p})$`, 'v');

test('every pattern is valid under the v flag (otherwise browsers ignore it)', () => {
  for (const [name, p] of Object.entries(PATTERNS)) assert.doesNotThrow(() => html(p), name);
});

test('patterns accept and reject the intended values', () => {
  const cases: [keyof typeof PATTERNS, string[], string[]][] = [
    ['phone', ['(512) 555-0142', '+92 300 1234567', '0300-1234567'], ['call me', '12', 'x'.repeat(41)]],
    ['countryCode', ['US', 'pk'], ['U', 'USA', '12']],
    ['uuid', ['019a2baa-c642-761d-8dea-0c9e4b02af72'], ['019a2baa', 'not-a-uuid']],
    ['httpsOrigin', ['https://www.example.com', 'https://shop.example.co:8443'], ['http://www.example.com', 'https://example.com/path']],
    ['devUserId', ['demo_owner', 'a-1'], ['a b', 'x:y', 'ab']],
    ['email', ['dana@example.com'], ['dana@example', 'a b@example.com', 'x:y@example.com']],
    ['holidays', ['', '2026-12-25', '2026-11-26, 2026-12-25'], ['25/12/2026', '2026-12-25,']],
    ['intervals', ['60', '60, 240, 1440'], ['', 'sixty', '60,,240']],
    ['noColon', ['Chris Patel'], ['a:b']],
  ];
  for (const [name, good, bad] of cases) {
    for (const v of good) assert.ok(html(PATTERNS[name]).test(v), `${name} should accept ${v}`);
    for (const v of bad) assert.ok(!html(PATTERNS[name]).test(v), `${name} should reject ${v}`);
  }
});

test('stripControl removes control characters and keeps newlines only for multi-line fields', () => {
  assert.equal(stripControl('Acme\u0007 Plumbing\u0000'), 'Acme Plumbing');
  assert.equal(stripControl('line1\nline2'), 'line1 line2');
  assert.equal(stripControl('line1\nline2\u001b', true), 'line1\nline2');
});
