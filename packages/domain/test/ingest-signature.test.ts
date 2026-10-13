// Ported unchanged from the delivered domain/ingest-signature.test.mjs (SIG-01..06), plus secret_header mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV1, verifyV1, verifySecretHeader } from '../src/ingest-signature.ts';

const body = Buffer.from('{"entry_id":"wpf_entry_8841","email":"dana.morales@example.com"}');
const now = 1792000000, ts = String(now);
const cur = 'whsec_test_current', old = 'whsec_test_previous';

test('SIG-01 valid signature accepted', () => {
  assert.deepEqual(verifyV1({ secrets: [cur], timestampHeader: ts, signatureHeader: signV1(cur, ts, body), rawBody: body, nowSeconds: now }), { ok: true });
});
test('SIG-02 forged signature rejected', () => {
  const r = verifyV1({ secrets: [cur], timestampHeader: ts, signatureHeader: signV1('wrong', ts, body), rawBody: body, nowSeconds: now });
  assert.equal(r.ok ? null : r.reason, 'SIGNATURE_INVALID');
});
test('SIG-03 body changed after signing (re-serialized JSON) rejected', () => {
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
  const r = verifyV1({ secrets: [cur], timestampHeader: ts, signatureHeader: signV1(cur, ts, body), rawBody: reserialized, nowSeconds: now });
  assert.equal(r.ok ? null : r.reason, 'SIGNATURE_INVALID');
});
test('SIG-04 timestamp older than 300 s rejected', () => {
  const r = verifyV1({ secrets: [cur], timestampHeader: ts, signatureHeader: signV1(cur, ts, body), rawBody: body, nowSeconds: now + 301 });
  assert.equal(r.ok ? null : r.reason, 'TIMESTAMP_OUT_OF_WINDOW');
});
test('SIG-05 previous secret accepted during rotation window, rejected after', () => {
  const sig = signV1(old, ts, body);
  assert.equal(verifyV1({ secrets: [cur, old], timestampHeader: ts, signatureHeader: sig, rawBody: body, nowSeconds: now }).ok, true);
  assert.equal(verifyV1({ secrets: [cur, null], timestampHeader: ts, signatureHeader: sig, rawBody: body, nowSeconds: now }).ok, false);
});
test('SIG-06 missing headers rejected', () => {
  const r = verifyV1({ secrets: [cur], timestampHeader: undefined, signatureHeader: undefined, rawBody: body, nowSeconds: now });
  assert.equal(r.ok ? null : r.reason, 'SIGNATURE_MISSING');
});
test('secret_header mode: exact secret accepted, other values rejected', () => {
  assert.equal(verifySecretHeader([cur], cur), true);
  assert.equal(verifySecretHeader([cur, old], old), true);
  assert.equal(verifySecretHeader([cur], cur + 'x'), false);
  assert.equal(verifySecretHeader([cur], undefined), false);
});
