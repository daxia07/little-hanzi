import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPS_SCHEMA, OPS_MIGRATION_SHA } from '../lib/pilot/ops-schema.ts';
// Controlled binding configuration unit: replace only the platform env import.
// This does not authenticate HTTP, emulate the app, or claim hosted DB evidence.
const source = await fs.readFile(
  new URL('../lib/pilot/ops-runtime.ts', import.meta.url),
  'utf8',
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ops-runtime-boundary-'),
);
const target = pathToFileURL(path.join(temporary, 'boundary.ts'));
await fs.writeFile(
  target,
  source
    .replace(
      "import { pilotBindings } from './runtime.ts';",
      'const pilotBindings=()=>globalThis.__opsUnitBindings;',
    )
    .replaceAll(
      /from '(\.[^']+)'/g,
      (_match, relative) =>
        "from '" +
        new URL(
          relative,
          new URL('../lib/pilot/ops-runtime.ts', import.meta.url),
        ).href +
        "'",
    ),
);
const { opsContext } = await import(target.href);
await fs.rm(temporary, { recursive: true, force: true });
const config = {
  candidateId: 'build-unit',
  testMode: true,
  testToken: 'synthetic-token',
  testRunId: 'synthetic-run',
  candidateExplicitlyBound: true,
};
function setup() {
  const ledger = {
    installation_id: 'ops-unit',
    environment: 'qa-unit',
    learning_installation_id: 'learn-unit',
    schema_version: 'pilot-ops-schema-1',
  };
  const db = {
    prepare: (sql) => ({
      first: async () => ledger,
      all: async () => ({
        success: true,
        results: sql.includes('ops_schema_history')
          ? [{ version: 0, name: '0000_ops.sql', checksum: OPS_MIGRATION_SHA }]
          : OPS_SCHEMA,
      }),
    }),
  };
  const session = {
    config,
    db: {
      prepare: () => ({
        first: async () => ({ installation_id: 'learn-unit' }),
      }),
    },
  };
  return {
    bindings: { OPS_DB: db, HANZI_OPS_ENVIRONMENT: 'qa-unit' },
    session,
    ledger,
  };
}
test('R4-E001 optional binding throw/missing and cross-scope ledger fail only ops context', async () => {
  const { session, bindings, ledger } = setup();
  for (const value of [
    { HANZI_OPS_ENVIRONMENT: 'qa-unit' },
    new Proxy(
      {},
      {
        get() {
          throw Error('private factory failure');
        },
      },
    ),
  ]) {
    globalThis.__opsUnitBindings = value;
    await assert.rejects(
      opsContext(session),
      (e) => e.code === 'OPS_UNAVAILABLE',
    );
  }
  ledger.learning_installation_id = 'wrong-learning';
  globalThis.__opsUnitBindings = bindings;
  await assert.rejects(
    opsContext(session),
    (e) => e.code === 'OPS_UNAVAILABLE',
  );
});
test('R4-E001 guarded operations clock stays separate from curriculum and denies incomplete config', async () => {
  const { session, bindings } = setup();
  globalThis.__opsUnitBindings = {
    ...bindings,
    HANZI_OPS_TEST_NOW: '1790441964908',
    HANZI_CURRICULUM_TEST_NOW: '0',
  };
  assert.equal((await opsContext(session)).now(), 1790441964908);
  for (const field of [
    'testMode',
    'testToken',
    'testRunId',
    'candidateExplicitlyBound',
  ])
    await assert.rejects(
      opsContext({ ...session, config: { ...config, [field]: false } }),
      (e) => e.code === 'OPS_UNAVAILABLE',
    );
  globalThis.__opsUnitBindings = { ...bindings, HANZI_OPS_TEST_NOW: '-1' };
  await assert.rejects(
    opsContext(session),
    (e) => e.code === 'OPS_UNAVAILABLE',
  );
});

test('R4-E001 empty optional ops clock is absent; whitespace remains invalid', async () => {
  const { session, bindings } = setup();
  globalThis.__opsUnitBindings = { ...bindings, HANZI_OPS_TEST_NOW: '' };
  const ordinary = await opsContext(session);
  assert(ordinary.now() > 0);
  globalThis.__opsUnitBindings = { ...bindings, HANZI_OPS_TEST_NOW: ' ' };
  await assert.rejects(
    opsContext(session),
    (e) => e.code === 'OPS_UNAVAILABLE',
  );
});

test('R4-E015 fully guarded named final-write fault maps private context; ordinary config refuses', async () => {
  const { session, bindings } = setup();
  globalThis.__opsUnitBindings = {
    ...bindings,
    HANZI_OPS_TEST_FAULT: 'feedback-final-write',
  };
  assert.equal((await opsContext(session)).testFault, 'feedback-final-write');
  await assert.rejects(
    opsContext({ ...session, config: { ...config, testMode: false } }),
    (e) => e.code === 'OPS_UNAVAILABLE',
  );
  globalThis.__opsUnitBindings = {
    ...bindings,
    HANZI_OPS_TEST_FAULT: 'arbitrary-sql',
  };
  await assert.rejects(
    opsContext(session),
    (e) => e.code === 'OPS_UNAVAILABLE',
  );
});
