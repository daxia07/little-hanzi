import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeBindings } from '../lib/platform/node-bindings.ts';
test('R4-E001 optional ops database is lazy and cannot poison the learning binding', () => {
  const bindings = createNodeBindings({
    HANZI_DATABASE_URL: 'https://learning.example',
    HANZI_DATABASE_AUTH_TOKEN: 'synthetic-unused',
    HANZI_OPS_DATABASE_URL: 'file:/tmp/forbidden-ops.db',
  });
  assert(bindings.DB);
  assert.throws(() => bindings.OPS_DB);
  assert.equal(bindings.DB, bindings.DB);
});
test('R4-E001 ops and learning databases use separate cached clients', () => {
  const bindings = createNodeBindings({
    HANZI_DATABASE_URL: 'https://learning.example',
    HANZI_DATABASE_AUTH_TOKEN: 'synthetic-unused',
    HANZI_OPS_DATABASE_URL: 'https://ops.example',
    HANZI_OPS_DATABASE_AUTH_TOKEN: 'synthetic-unused-ops',
  });
  assert(bindings.OPS_DB);
  assert.notEqual(bindings.OPS_DB, bindings.DB);
  assert.equal(bindings.OPS_DB, bindings.OPS_DB);
});
test('R4-E001 missing optional ops binding remains absent; production denies local ops URL', () => {
  assert.equal(createNodeBindings({}).OPS_DB, undefined);
  const bindings = createNodeBindings({
    VERCEL: '1',
    HANZI_OPS_ALLOW_LOCAL_DATABASE: '1',
    HANZI_OPS_DATABASE_URL: 'http://127.0.0.1:9999',
  });
  assert.throws(() => bindings.OPS_DB);
});
