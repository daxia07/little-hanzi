import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { opsSchemaSource } from '../scripts/pilot-ops-schema.mjs';
import {
  initializeOpsLibsql,
  captureOpsLibsql,
  createOpsBackupPayload,
  restoreOpsLibsql,
  migrateOpsLibsql,
} from '../scripts/pilot-ops-libsql.mjs';
import { validateOpsArchive } from '../lib/pilot/ops-archive.ts';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import { acquireJob, completeJobVerified } from '../lib/pilot/ops-store.ts';
import { jobSlot } from '../lib/pilot/ops-domain.ts';
const root = path.resolve(import.meta.dirname, '..');
const SHA = '524eaf2c844099b1eb76de1434ded5b05cefac0eb214f5dbda4b36df4da6ec20';
const sqlPath =
  process.env.HANZI_OPS3_SQL ??
  path.join(root, 'db/pilot-ops-migrations/0002_corpus_archives.sql');
function fixture() {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-ops3-author-')),
  );
  fs.chmodSync(work, 0o700);
  fs.writeFileSync(
    path.join(work, '.hanzi-qa-owned'),
    'Synthetic ops3 author fixture',
    { mode: 0o600 },
  );
  const dir = path.join(work, 'db/pilot-ops-migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['0000_ops.sql', '0001_collection_archives.sql'])
    fs.copyFileSync(
      path.join(root, 'db/pilot-ops-migrations', name),
      path.join(dir, name),
    );
  const sql = fs.readFileSync(sqlPath);
  assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), SHA);
  fs.writeFileSync(path.join(dir, '0002_corpus_archives.sql'), sql);
  return {
    work,
    close: () => fs.rmSync(work, { recursive: true, force: true }),
  };
}
const scope = {
  environment: 'synthetic',
  installationId: 'old-learning',
  opsInstallationId: 'old-ops',
};
const now = Date.parse('2026-09-27T03:00:00Z');
test('[OPS6-004] exact third source derives schema3 while old prefixes retain closed formats', () => {
  const f = fixture();
  try {
    const s = opsSchemaSource(f.work);
    assert.equal(s.version, 3);
    assert.equal(s.format, 'pilot-ops-backup-3');
    assert.equal(s.migrations.length, 3);
    assert.equal(s.migrations[2].sha256, SHA);
    for (const v of [1, 2])
      assert.equal(
        opsSchemaSource(f.work, { version: v }).format,
        `pilot-ops-backup-${v}`,
      );
    fs.writeFileSync(
      path.join(f.work, 'db/pilot-ops-migrations/0003_unknown.sql'),
      'SELECT 1;',
    );
    assert.throws(() => opsSchemaSource(f.work), /OPS_SCHEMA_SOURCE_INVALID/);
  } finally {
    f.close();
  }
});
test('[OPS6-001][OPS6-003] populated schema2 upgrades atomically, captures3 and restores only fresh3 with attributed history', async () => {
  const f = fixture();
  const client = createClient({
      url: 'file:' + path.join(f.work, 'source.db'),
    }),
    target = createClient({ url: 'file:' + path.join(f.work, 'target.db') });
  try {
    await initializeOpsLibsql({
      client,
      sourceRoot: f.work,
      scope,
      version: 2,
      now,
    });
    const c = {
      db: createLibsqlD1(client),
      ...scope,
      buildId: 'build-author',
      now: () => now,
    };
    await acquireJob(c, {
      jobId: 'monitor',
      kind: 'monitor',
      utcSlot: jobSlot('monitor', now),
      attemptId: 'attempt',
      eventId: 'acquired',
      objects: {},
    });
    await completeJobVerified(c, {
      jobId: 'monitor',
      attemptId: 'attempt',
      expectedRevision: 1,
      eventId: 'completed',
      result: {
        kind: 'monitor',
        health: 'healthy',
        checkedAt: now,
        code: null,
      },
    });
    await client.execute(
      'UPDATE ops_installation SET queue_revision=7 WHERE id=1',
    );
    const before = await captureOpsLibsql({
      client,
      sourceRoot: f.work,
      scope,
    });
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
        sourceRoot: f.work,
        scope,
        version: 3,
        now: now + 1,
      }),
    );
    assert.deepEqual(
      (await captureOpsLibsql({ client, sourceRoot: f.work, scope })).tables,
      before.tables,
    );
    await migrateOpsLibsql({
      client,
      sourceRoot: f.work,
      scope,
      version: 3,
      now: now + 1,
    });
    const after = await captureOpsLibsql({ client, sourceRoot: f.work, scope });
    assert.equal(after.format, 'pilot-ops-backup-3');
    for (const t of Object.keys(before.tables).filter(
      (t) => !['ops_installation', 'ops_schema_history'].includes(t),
    ))
      assert.deepEqual(after.tables[t], before.tables[t]);
    assert.deepEqual(after.tables.ops_installation[0], {
      ...before.tables.ops_installation[0],
      schema_version: 'pilot-ops-schema-3',
    });
    assert.deepEqual(
      after.tables.ops_schema_history.slice(0, 2),
      before.tables.ops_schema_history,
    );
    assert.equal(after.tables.ops_schema_history.length, 3);
    await migrateOpsLibsql({
      client,
      sourceRoot: f.work,
      scope,
      version: 3,
      now: now + 2,
    });
    assert.deepEqual(
      (await captureOpsLibsql({ client, sourceRoot: f.work, scope })).tables,
      after.tables,
    );
    const archive = await createOpsBackupPayload({
      client,
      sourceRoot: f.work,
      scope,
      buildId: 'build-author',
      now: now + 3,
    });
    assert.equal(archive.payload.format, 'pilot-ops-backup-3');
    await validateOpsArchive(archive.payload);
    const fresh = {
      environment: 'synthetic',
      installationId: 'new-learning',
      opsInstallationId: 'new-ops',
    };
    await initializeOpsLibsql({
      client: target,
      sourceRoot: f.work,
      scope: fresh,
      version: 3,
      now: now + 4,
    });
    await restoreOpsLibsql({
      client: target,
      sourceRoot: f.work,
      scope: fresh,
      archive,
    });
    const restored = await captureOpsLibsql({
      client: target,
      sourceRoot: f.work,
      scope: fresh,
    });
    assert.deepEqual(restored.tables.ops_job, after.tables.ops_job);
    assert.equal(restored.tables.ops_installation[0].queue_revision, 0);
    assert.equal(
      restored.tables.ops_installation[0].installation_id,
      'new-ops',
    );
    await assert.rejects(
      () =>
        restoreOpsLibsql({
          client: target,
          sourceRoot: f.work,
          scope: fresh,
          archive,
        }),
      /OPS_RESTORE_NOT_FRESH/,
    );
  } finally {
    client.close();
    target.close();
    f.close();
  }
});
test('[OPS6-004] exact source rejects checksum drift before any database call', () => {
  const f = fixture();
  try {
    const p = path.join(
      f.work,
      'db/pilot-ops-migrations/0002_corpus_archives.sql',
    );
    fs.appendFileSync(p, '\n');
    assert.throws(() => opsSchemaSource(f.work), /OPS_SCHEMA_SOURCE_INVALID/);
  } finally {
    f.close();
  }
});
import { assertOpsSourcePair } from '../scripts/pilot-ops-jobs.mjs';
test('[OPS6-002] new live pair is6/3, historical policy never widens live old-source pairs', () => {
  for (const [learning, operations] of [
    [4, 1],
    [4, 2],
    [5, 2],
    [6, 3],
  ])
    assert.doesNotThrow(() =>
      assertOpsSourcePair(
        `pilot-admin-backup-${learning}`,
        `pilot-ops-backup-${operations}`,
      ),
    );
  for (const [learning, operations] of [
    [4, 3],
    [5, 3],
    [5, 1],
    [6, 1],
    [6, 2],
    [7, 3],
    [6, 4],
  ])
    assert.throws(
      () =>
        assertOpsSourcePair(
          `pilot-admin-backup-${learning}`,
          `pilot-ops-backup-${operations}`,
        ),
      /OPS_SCHEMA_MISMATCH/,
    );
});
test('[OPS6-004] old archive identities remain strict under third source and unknown future formats refuse', async () => {
  const f = fixture();
  const clients = [];
  try {
    for (const version of [1, 2, 3]) {
      const client = createClient({
        url: 'file:' + path.join(f.work, `archive-${version}.db`),
      });
      clients.push(client);
      await initializeOpsLibsql({
        client,
        sourceRoot: f.work,
        scope,
        version,
        now,
      });
      const archive = await createOpsBackupPayload({
        client,
        sourceRoot: f.work,
        scope,
        buildId: 'build-author',
        now: now + 1,
      });
      await validateOpsArchive(archive.payload);
      for (const forgedVersion of [1, 2, 3, 4].filter((v) => v !== version)) {
        const forged = structuredClone(archive.payload);
        forged.format = `pilot-ops-backup-${forgedVersion}`;
        await assert.rejects(() => validateOpsArchive(forged));
      }
      const incompatible = structuredClone(archive.payload);
      incompatible.migrations.push({
        name: '0003_unknown.sql',
        version: 3,
        sha256: '0'.repeat(64),
      });
      await assert.rejects(() => validateOpsArchive(incompatible));
    }
  } finally {
    for (const c of clients) c.close();
    f.close();
  }
});
test('[OPS6-004] schema3 store admits exact6/3 metadata but rejects format-kind mismatches before final facts', async () => {
  const f = fixture(),
    client = createClient({
      url: 'file:' + path.join(f.work, 'format-store.db'),
    });
  try {
    await initializeOpsLibsql({
      client,
      sourceRoot: f.work,
      scope,
      version: 3,
      now,
    });
    const c = {
      db: createLibsqlD1(client),
      ...scope,
      buildId: 'build-author',
      now: () => now,
    };
    const objects = {
      learning: { archiveId: 'learning-meta', objectId: 'learning-object' },
      operations: { archiveId: 'ops-meta', objectId: 'ops-object' },
    };
    await acquireJob(c, {
      jobId: 'backup',
      kind: 'backup',
      utcSlot: jobSlot('backup', now),
      attemptId: 'backup-attempt',
      eventId: 'backup-start',
      objects,
    });
    const archives = ['learning', 'operations'].map((kind) => ({
      id: objects[kind].archiveId,
      kind,
      format:
        kind === 'learning' ? 'pilot-admin-backup-6' : 'pilot-ops-backup-3',
      objectRef: objects[kind].objectId,
      keyId: 'synthetic-key',
      plaintextDigest: 'sha256:' + 'a'.repeat(64),
      ciphertextDigest: 'sha256:' + 'b'.repeat(64),
      byteSize: 100,
      dataAt: now,
      createdAt: now,
      verifiedAt: now,
      dailySlot: jobSlot('backup', now),
      weeklySlot: null,
    }));
    const input = {
      jobId: 'backup',
      attemptId: 'backup-attempt',
      expectedRevision: 1,
      eventId: 'backup-end',
      result: { kind: 'backup', archives },
    };
    for (const badFormat of ['pilot-ops-backup-2', 'pilot-admin-backup-7']) {
      const bad = structuredClone(input);
      bad.result.archives[0].format = badFormat;
      await assert.rejects(() => completeJobVerified(c, bad));
      assert.equal(
        (await client.execute('SELECT COUNT(*) n FROM ops_archive')).rows[0].n,
        0,
      );
    }
    await completeJobVerified(c, input);
    assert.equal(
      (await client.execute('SELECT COUNT(*) n FROM ops_archive')).rows[0].n,
      2,
    );
    const payload = await createOpsBackupPayload({
      client,
      sourceRoot: f.work,
      scope,
      buildId: 'build-author',
      now: now + 1,
    });
    await validateOpsArchive(payload.payload);
  } finally {
    client.close();
    f.close();
  }
});
