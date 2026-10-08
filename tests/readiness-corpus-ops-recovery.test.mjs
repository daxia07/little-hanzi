import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import { withOwnedCorpusFixture } from '../scripts/readiness-corpus-bootstrap.mjs';
import { populateCorpusVisits } from './helpers/corpus-populated-fixture.mjs';
import {
  createCorpusBackupPayload,
  captureCorpusLibsql,
} from '../scripts/pilot-corpus-libsql-backup.mjs';
import {
  createOpsBackupPayload,
  initializeOpsLibsql,
  captureOpsLibsql,
} from '../scripts/pilot-ops-libsql.mjs';
import { sealArchive } from '../scripts/pilot-ops-archive.mjs';
import {
  restoreEncryptedPair,
  opsLearningAdapter,
} from '../scripts/pilot-ops-recovery.mjs';
import { backupPilot, restorePilot } from '../scripts/pilot-backup.mjs';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import { acquireJob, completeJobVerified } from '../lib/pilot/ops-store.ts';
import { jobSlot } from '../lib/pilot/ops-domain.ts';

const root = path.resolve(import.meta.dirname, '..');
const tablesEqual = (actual, expected) => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [table, rows] of Object.entries(expected)) {
    const normalize = (items) =>
      items
        .map((row) =>
          JSON.stringify(
            Object.keys(row)
              .sort()
              .map((key) => [key, row[key]]),
          ),
        )
        .sort();
    assert.deepEqual(normalize(actual[table]), normalize(rows), table);
  }
};

test('[R6-E-013/015] exact source chooses V6 Node recovery; unsupported Worker CLI refuses before path/database effects', async () => {
  assert.equal(opsLearningAdapter(root).format, 'pilot-admin-backup-6');
  for (const command of [backupPilot, restorePilot]) {
    await assert.rejects(
      () => command({ manifest: { snapshot: root } }),
      (error) => error.code === 'BACKUP_BACKEND_UNSUPPORTED',
    );
  }
});

test('[R6-E-013] actual encrypted pair restores all67 learning and8 operations tables after three visits, validating both before destination creation', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const facts = await populateCorpusVisits(f);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-ops-pair-'));
    fs.chmodSync(work, 0o700);
    fs.writeFileSync(
      path.join(work, '.hanzi-qa-owned'),
      'R6 actual encrypted recovery author fixture',
    );
    const clients = [];
    const fresh = (name) => {
      const client = createClient({
        url: 'file:' + path.join(work, name + '.db'),
      });
      clients.push(client);
      return client;
    };
    try {
      const sourceScope = {
        environment: 'synthetic-pair',
        installationId: f.installationId,
        opsInstallationId: 'source-ops',
      };
      const clock = facts.at;
      const ops = fresh('ops');
      await initializeOpsLibsql({
        client: ops,
        sourceRoot: root,
        scope: sourceScope,
        now: clock,
      });
      const context = {
        db: createLibsqlD1(ops),
        ...sourceScope,
        buildId: f.config.candidateId,
        now: () => clock,
      };
      await acquireJob(context, {
        jobId: 'monitor',
        kind: 'monitor',
        utcSlot: jobSlot('monitor', clock),
        attemptId: 'attempt',
        eventId: 'acquired',
        objects: {},
      });
      await completeJobVerified(context, {
        jobId: 'monitor',
        attemptId: 'attempt',
        expectedRevision: 1,
        eventId: 'completed',
        result: {
          kind: 'monitor',
          health: 'healthy',
          checkedAt: clock,
          code: null,
        },
      });
      const archives = {
        learning: await createCorpusBackupPayload({
          sourceRoot: root,
          candidateId: f.config.candidateId,
          client: f.client,
          installationId: f.installationId,
          createdAtMs: clock,
        }),
        operations: await createOpsBackupPayload({
          client: ops,
          sourceRoot: root,
          scope: sourceScope,
          buildId: f.config.candidateId,
          now: clock,
        }),
      };
      assert.equal(archives.learning.payload.format, 'pilot-admin-backup-6');
      assert.equal(archives.operations.payload.format, 'pilot-ops-backup-3');
      assert.equal(archives.learning.payload.tables.pilot_corpus_run.length, 3);
      assert(archives.operations.payload.tables.ops_job.length > 0);
      assert(archives.operations.payload.tables.ops_job_event.length > 0);
      // Synthetic build attribution exercises encryption/scope only, not built proof or human review.
      const key = crypto.randomBytes(32),
        objects = new Map();
      const build = {
        candidateId: f.config.candidateId,
        sourceDigest: 'sha256:' + '1'.repeat(64),
        artifactDigest: 'sha256:' + '2'.repeat(64),
      };
      const admission = {
        job: {
          id: 'synthetic-job',
          kind: 'backup',
          buildId: build.candidateId,
        },
        utcSlot: new Date(clock).toISOString().slice(0, 10) + 'T02:00:00.000Z',
        objects: {},
      };
      for (const kind of ['learning', 'operations']) {
        const archive = archives[kind],
          planned = {
            archiveId: kind + '-archive',
            objectId: kind + '-object',
          };
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
                  sourceInstallationId: f.installationId,
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
          const installationId = (
            await target.execute(
              'SELECT installation_id FROM pilot_installation',
            )
          ).rows[0].installation_id;
          scope = {
            environment: sourceScope.environment,
            installationId,
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
      // A broken second archive is rejected after validating the first, still before creation.
      const originalOps = objects.get('operations-object');
      const bad = JSON.parse(originalOps.toString('utf8'));
      bad.metadata.payloadFormat = 'pilot-ops-backup-2';
      objects.set('operations-object', Buffer.from(JSON.stringify(bad)));
      await assert.rejects(() => restoreEncryptedPair(options));
      assert.equal(destinations, 0);
      objects.set('operations-object', originalOps);
      const result = await restoreEncryptedPair(options);
      assert.equal(result.status, 'confirmed');
      assert.equal(destinations, 1);
      const learning = await captureCorpusLibsql(target, scope.installationId);
      const operations = await captureOpsLibsql({
        client: targetOps,
        sourceRoot: root,
        scope,
      });
      assert.equal(Object.keys(learning.tables).length, 67);
      assert.equal(Object.keys(operations.tables).length, 8);
      tablesEqual(learning.tables, archives.learning.payload.tables);
      // Operations retains historical rows but its current installation is freshly bound.
      tablesEqual(operations.tables, {
        ...archives.operations.payload.tables,
        ops_installation:
          archives.operations.payload.tables.ops_installation.map((row) => ({
            ...row,
            installation_id: scope.opsInstallationId,
            learning_installation_id: scope.installationId,
          })),
      });
      assert.equal(learning.sessionCount, 0);
      assert.notEqual(scope.installationId, f.installationId);
      assert.notEqual(scope.opsInstallationId, sourceScope.opsInstallationId);
    } finally {
      for (const client of clients) client.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
