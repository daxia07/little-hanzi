import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../scripts/pilot-ops-libsql.mjs';
import { OPS_DOMAIN_TABLES } from '../lib/pilot/ops-schema.ts';
const tables = () =>
  Object.fromEntries(OPS_DOMAIN_TABLES.map((name) => [name, []]));
const fresh = () => ({
  tables: {
    ...tables(),
    ops_installation: [
      {
        id: 1,
        installation_id: 'new-ops',
        environment: 'qa',
        learning_installation_id: 'new-learning',
        queue_revision: 0,
      },
    ],
  },
});
const archive = () => ({
  sourceOpsInstallationId: 'old-ops',
  tables: tables(),
});
test('[R4-E-008] operations restoration cannot resume old ownership or replace populated storage', () => {
  assert.doesNotThrow(() =>
    ops.assertFreshOpsSnapshot(fresh(), archive(), {
      opsInstallationId: 'new-ops',
      installationId: 'new-learning',
      environment: 'qa',
    }),
  );
  for (const alter of [
    (s) => {
      s.tables.ops_job.push({ id: 'existing' });
    },
    (s) => {
      s.tables.ops_installation[0].installation_id = 'old-ops';
    },
    (s) => {
      s.tables.ops_installation[0].queue_revision = 1;
    },
    (s) => {
      s.tables.ops_installation[0].learning_installation_id = 'foreign';
    },
  ]) {
    const snapshot = fresh();
    alter(snapshot);
    assert.throws(
      () =>
        ops.assertFreshOpsSnapshot(snapshot, archive(), {
          opsInstallationId: 'new-ops',
          installationId: 'new-learning',
          environment: 'qa',
        }),
      /OPS_RESTORE_NOT_FRESH/,
    );
  }
  const source = archive();
  source.tables.ops_job.push({ ops_installation_id: 'new-ops' });
  assert.throws(
    () =>
      ops.assertFreshOpsSnapshot(fresh(), source, {
        opsInstallationId: 'new-ops',
        installationId: 'new-learning',
        environment: 'qa',
      }),
    /OPS_RESTORE_NOT_FRESH/,
  );
});
test('[R4-E-008] invalid operations envelope is rejected before destination reads or writes', async () => {
  let calls = 0;
  const client = {
    execute() {
      calls++;
    },
    batch() {
      calls++;
    },
  };
  await assert.rejects(
    () =>
      ops.restoreOpsLibsql({
        client,
        sourceRoot: process.cwd(),
        archive: { payload: {}, sha256: '0'.repeat(64) },
        scope: {},
      }),
    /OPS_ARCHIVE_CHECKSUM/,
  );
  assert.equal(calls, 0);
});
