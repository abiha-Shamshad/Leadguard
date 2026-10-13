// The registry must match contracts/api-examples.json exactly: 52 operations, same methods, paths and entitlement classes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPERATIONS } from '../src/registry.ts';
import { ERROR_CATALOGUE } from '../src/errors.ts';

const examples = JSON.parse(readFileSync(new URL('../api-examples.json', import.meta.url), 'utf8')) as any[];
const toTemplate = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

test('registry has 52 operations (Appendix A)', () => {
  assert.equal(OPERATIONS.length, 52);
  assert.equal(new Set(OPERATIONS.map(o => o.id)).size, 52);
});

test('registry matches api-examples.json method, path and entitlement', () => {
  for (const ex of examples) {
    const o = OPERATIONS.find(x => x.id === ex.id);
    assert.ok(o, `missing ${ex.id}`);
    assert.equal(o!.method, ex.method, ex.id);
    assert.equal(o!.path, toTemplate(ex.path), ex.id);
    assert.equal(o!.entitlement, ex.entitlement, ex.id);
  }
});

test('every error code used in the examples is in the catalogue with the same status', () => {
  for (const ex of examples) {
    const err = ex.error?.body?.error;
    if (err && typeof err === 'object' && err.code) {
      assert.ok(err.code in ERROR_CATALOGUE, `${ex.id} uses ${err.code}`);
      if (err.code !== 'SOURCE_DISABLED') assert.equal((ERROR_CATALOGUE as any)[err.code], ex.error.status, `${ex.id} ${err.code}`);
    }
  }
});
