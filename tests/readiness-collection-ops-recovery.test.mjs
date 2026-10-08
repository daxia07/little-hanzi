import { legacyCollectionRoot } from './helpers/legacy-pilot-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import {
  createCollectionBackupPayload,
  captureCollectionLibsql,
} from '../scripts/pilot-collection-libsql-backup.mjs';
import {
  createOpsBackupPayload,
  initializeOpsLibsql,
  captureOpsLibsql,
} from '../scripts/pilot-ops-libsql.mjs';
import { sealArchive } from '../scripts/pilot-ops-archive.mjs';
import { restoreEncryptedPair } from '../scripts/pilot-ops-recovery.mjs';

const root = legacyCollectionRoot(
  fs.realpathSync(fileURLToPath(new URL('../', import.meta.url))),
);
test('[R5-E-012] actual encrypted paired45 learning +8ops restore validates both before fresh database creation', async () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r5-ops-pair-')),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'r5-ops-pair');
  const clients = [];
  const fresh = (name) => {
    const client = createClient({
      url: 'file:' + path.join(work, name + '.db'),
    });
    clients.push(client);
    return client;
  };
  try {
    const source = fresh('source'),
      ops = fresh('ops');
    await applyLibsqlMigrations({ client: source, root });
    const installationId = (
      await source.execute('SELECT installation_id FROM pilot_installation')
    ).rows[0].installation_id;
    const sourceScope = {
      environment: 'synthetic-pair',
      installationId,
      opsInstallationId: 'source-ops',
    };
    const clock = Date.parse('2026-09-27T03:00:00Z');
    await initializeOpsLibsql({
      client: ops,
      sourceRoot: root,
      scope: sourceScope,
      now: clock,
    });
    const archives = {
      learning: await createCollectionBackupPayload({
        sourceRoot: root,
        candidateId: 'synthetic-build',
        client: source,
        installationId,
        createdAtMs: clock,
      }),
      operations: await createOpsBackupPayload({
        client: ops,
        sourceRoot: root,
        scope: sourceScope,
        buildId: 'synthetic-build',
        now: clock,
      }),
    };
    const key = crypto.randomBytes(32),
      objects = new Map(),
      build = {
        candidateId: 'synthetic-build',
        sourceDigest: 'sha256:' + '1'.repeat(64),
        artifactDigest: 'sha256:' + '2'.repeat(64),
      };
    const admission = {
      job: { id: 'synthetic-job', kind: 'backup', buildId: build.candidateId },
      utcSlot: '2026-09-27T02:00:00.000Z',
      objects: {},
    };
    for (const kind of ['learning', 'operations']) {
      const archive = archives[kind],
        planned = { archiveId: kind + '-archive', objectId: kind + '-object' };
      admission.objects[kind] = planned;
      objects.set(
        planned.objectId,
        Buffer.from(
          JSON.stringify(
            sealArchive({
              bytes: Buffer.from(JSON.stringify(archive)),
              key,
              metadata: {
                payloadFormat: archive.payload.format,
                archiveId: planned.archiveId,
                environment: sourceScope.environment,
                sourceInstallationId: installationId,
                opsInstallationId: sourceScope.opsInstallationId,
                ...build,
                schemaDigest: 'sha256:' + archive.payload.schemaDigest,
                createdAt: clock,
                keyId: 'synthetic-key',
              },
            }),
          ),
        ),
      );
    }
    let destinations = 0,
      target,
      targetOps,
      scope;
    const options = {
      sourceRoot: root,
      sourceScope,
      archiveStore: { get: (id) => objects.get(id) },
      keys: new Map([['synthetic-key', key]]),
      admission,
      resolveBuild: () => build,
      now: () => clock,
      createDestination: async () => {
        destinations++;
        target = fresh('target');
        targetOps = fresh('target-ops');
        await applyLibsqlMigrations({ client: target, root });
        const newId = (
          await target.execute('SELECT installation_id FROM pilot_installation')
        ).rows[0].installation_id;
        scope = {
          environment: sourceScope.environment,
          installationId: newId,
          opsInstallationId: 'target-ops',
        };
        await initializeOpsLibsql({
          client: targetOps,
          sourceRoot: root,
          scope,
          now: clock,
        });
        return { learningClient: target, operationsClient: targetOps, scope };
      },
    };
    const result = await restoreEncryptedPair(options);
    assert.equal(result.status, 'confirmed');
    assert.equal(destinations, 1);
    assert.equal(
      Object.keys(
        (await captureCollectionLibsql(target, scope.installationId)).tables,
      ).length,
      45,
    );
    assert.equal(
      Object.keys(
        (await captureOpsLibsql({ client: targetOps, sourceRoot: root, scope }))
          .tables,
      ).length,
      8,
    );
    assert.notEqual(scope.installationId, installationId);
    const original = objects.get('learning-object');
    const bad = JSON.parse(original.toString());
    bad.metadata.payloadFormat = 'pilot-admin-backup-6';
    objects.set('learning-object', Buffer.from(JSON.stringify(bad)));
    await assert.rejects(() => restoreEncryptedPair(options));
    assert.equal(destinations, 1);
  } finally {
    for (const client of clients) client.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[OPS5-001] populated schema1 migration preserves immutable facts and final-ledger failure rolls back all rebuilds', async () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-ops-upgrade-')),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'ops-upgrade');
  const client = createClient({ url: 'file:' + path.join(work, 'ops.db') });
  const scope = {
    environment: 'synthetic-upgrade',
    installationId: 'learning-old',
    opsInstallationId: 'ops-old',
  };
  const clock = Date.parse('2026-09-27T03:00:00Z');
  try {
    await initializeOpsLibsql({
      client,
      sourceRoot: root,
      scope,
      now: clock,
      version: 1,
    });
    const { createLibsqlD1 } = await import('../lib/platform/libsql-d1.ts');
    const store = await import('../lib/pilot/ops-store.ts');
    const { jobSlot } = await import('../lib/pilot/ops-domain.ts');
    const ctx = {
      db: createLibsqlD1(client),
      ...scope,
      buildId: 'synthetic-build',
      now: () => clock,
    };
    await store.acquireJob(ctx, {
      jobId: 'monitor-one',
      kind: 'monitor',
      utcSlot: jobSlot('monitor', clock),
      attemptId: 'attempt-one',
      eventId: 'monitor-acquired',
      objects: {},
    });
    await store.completeJobVerified(ctx, {
      jobId: 'monitor-one',
      attemptId: 'attempt-one',
      expectedRevision: 1,
      eventId: 'monitor-completed',
      result: {
        kind: 'monitor',
        health: 'healthy',
        checkedAt: clock,
        code: null,
      },
    });
    await client.execute(
      'UPDATE ops_installation SET queue_revision=7 WHERE id=1',
    );
    const before = await captureOpsLibsql({ client, sourceRoot: root, scope });
    const { migrateOpsLibsql } =
      await import('../scripts/pilot-ops-libsql.mjs');
    const fault = {
      execute: client.execute.bind(client),
      batch: (statements, mode) =>
        client.batch(
          mode === 'write'
            ? [
                ...statements,
                {
                  sql: 'INSERT INTO ops_schema_history SELECT * FROM ops_schema_history WHERE version=0',
                  args: [],
                },
              ]
            : statements,
          mode,
        ),
    };
    await assert.rejects(() =>
      migrateOpsLibsql({
        client: fault,
        sourceRoot: root,
        scope,
        now: clock + 1,
      }),
    );
    assert.deepEqual(
      (await captureOpsLibsql({ client, sourceRoot: root, scope })).tables,
      before.tables,
    );
    await migrateOpsLibsql({ client, sourceRoot: root, scope, now: clock + 1 });
    const after = await captureOpsLibsql({ client, sourceRoot: root, scope });
    for (const table of Object.keys(before.tables).filter(
      (t) => !['ops_installation', 'ops_schema_history'].includes(t),
    ))
      assert.deepEqual(after.tables[table], before.tables[table]);
    assert.deepEqual(after.tables.ops_installation[0], {
      ...before.tables.ops_installation[0],
      schema_version: 'pilot-ops-schema-2',
    });
    assert.deepEqual(
      after.tables.ops_schema_history[0],
      before.tables.ops_schema_history[0],
    );
    assert.equal(after.tables.ops_schema_history.length, 2);
    const archive = await createOpsBackupPayload({
      client,
      sourceRoot: root,
      scope,
      buildId: 'synthetic-build',
      now: clock + 2,
    });
    assert.equal(archive.payload.format, 'pilot-ops-backup-2');
  } finally {
    client.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[OPS5-002/004] actual source-bound V5 executor durably verifies learning5/ops2 and future source refuses before effects', async () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-ops-v5-executor-')),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'ops-v5-executor');
  const learning = createClient({
      url: 'file:' + path.join(work, 'learning.db'),
    }),
    ops = createClient({ url: 'file:' + path.join(work, 'ops.db') });
  const clock = Date.parse('2026-09-27T03:00:00Z');
  try {
    await applyLibsqlMigrations({ client: learning, root });
    const installationId = (
      await learning.execute('SELECT installation_id FROM pilot_installation')
    ).rows[0].installation_id;
    const scope = {
      environment: 'synthetic-executor',
      installationId,
      opsInstallationId: 'ops-executor',
    };
    await initializeOpsLibsql({
      client: ops,
      sourceRoot: root,
      scope,
      now: clock,
    });
    const { createOpsExecutor } = await import('../scripts/pilot-ops-jobs.mjs');
    const objects = new Map();
    const options = {
      sourceRoot: root,
      learningClient: learning,
      operationsClient: ops,
      scope,
      archiveStore: {
        put: (id, value) => objects.set(id, value),
        get: (id) => objects.get(id),
      },
      keys: new Map([['synthetic-key', crypto.randomBytes(32)]]),
      activeKeyId: 'synthetic-key',
      now: () => clock,
      build: () => ({
        candidateId: 'synthetic-build',
        sourceDigest: 'sha256:' + '1'.repeat(64),
        artifactDigest: 'sha256:' + '2'.repeat(64),
      }),
      probe: async () => 'healthy',
    };
    const executor = await createOpsExecutor(options);
    const result = await executor.dispatch('backup');
    assert.equal(result.status, 'verified');
    const captured = await captureOpsLibsql({
      client: ops,
      sourceRoot: root,
      scope,
    });
    assert.deepEqual(captured.tables.ops_archive.map((a) => a.format).sort(), [
      'pilot-admin-backup-5',
      'pilot-ops-backup-2',
    ]);
    assert.equal(objects.size, 2);
    const future = path.join(work, 'future');
    fs.mkdirSync(path.join(future, 'db/pilot-migrations'), { recursive: true });
    for (const name of fs.readdirSync(path.join(root, 'db/pilot-migrations')))
      fs.copyFileSync(
        path.join(root, 'db/pilot-migrations', name),
        path.join(future, 'db/pilot-migrations', name),
      );
    fs.writeFileSync(
      path.join(future, 'db/pilot-migrations/0007_unknown.sql'),
      'SELECT 1;',
    );
    await assert.rejects(() =>
      createOpsExecutor({ ...options, sourceRoot: future }),
    );
    fs.rmSync(path.join(future, 'db/pilot-migrations/0007_unknown.sql'));
    fs.cpSync(path.join(root, 'lib'), path.join(future, 'lib'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(root, 'db/pilot-ops-migrations'),
      path.join(future, 'db/pilot-ops-migrations'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(future, 'db/pilot-ops-migrations/0002_unknown.sql'),
      'SELECT 1;',
    );
    await assert.rejects(
      () => createOpsExecutor({ ...options, sourceRoot: future }),
      /OPS_SCHEMA_SOURCE_INVALID/,
    );
    assert.equal(objects.size, 2);
  } finally {
    learning.close();
    ops.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
