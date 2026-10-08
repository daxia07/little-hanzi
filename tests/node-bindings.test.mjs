import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeBindings } from '../lib/platform/node-bindings.ts';

await test('[V-AC-001] missing runtime database configuration never creates a local database', () => {
  const bindings = createNodeBindings({
    HANZI_PILOT_MODE: '1',
    UNRELATED_SECRET: 'hidden',
  });
  assert.equal(bindings.HANZI_PILOT_MODE, '1');
  assert.equal(bindings.DB, undefined);
  assert.equal(bindings.UNRELATED_SECRET, undefined);
  assert.equal(bindings.HANZI_AUTH_IP_HEADER, 'x-forwarded-for');
  assert.equal(
    createNodeBindings({ HANZI_AUTH_IP_HEADER: 'cf-connecting-ip' })
      .HANZI_AUTH_IP_HEADER,
    'x-forwarded-for',
  );
  assert.equal(
    createNodeBindings({ HANZI_DATABASE_URL: 'libsql://db.example' }).DB,
    undefined,
  );
});

await test('[V-AC-001] Vercel cannot use an ephemeral filesystem or a local test database', () => {
  for (const url of [
    'file:/tmp/family.db',
    ':memory:',
    'http://127.0.0.1:8080',
    'http://external.example',
  ]) {
    const bindings = createNodeBindings({
      VERCEL: '1',
      HANZI_ALLOW_LOCAL_DATABASE: '1',
      HANZI_DATABASE_URL: url,
    });
    assert.throws(() => bindings.DB);
  }
});
