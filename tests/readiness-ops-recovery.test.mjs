import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as recovery from '../scripts/pilot-ops-recovery.mjs';
import { sealArchive } from '../scripts/pilot-ops-archive.mjs';

test('[R4-E-008] unknown encryption key refuses before creating any destination', async () => {
  let destinations = 0;
  const key = crypto.randomBytes(32);
  const envelope = sealArchive({
    bytes: Buffer.from('{}'),
    key,
    metadata: {
      payloadFormat: 'pilot-admin-backup-4',
      archiveId: 'learning-1',
      environment: 'test',
      sourceInstallationId: 'source',
      opsInstallationId: 'ops',
      candidateId: 'candidate',
      sourceDigest: 'sha256:' + '1'.repeat(64),
      artifactDigest: 'sha256:' + '2'.repeat(64),
      schemaDigest: 'sha256:' + '3'.repeat(64),
      createdAt: 1000,
      keyId: 'old-key',
    },
  });
  await assert.rejects(
    () =>
      recovery.restoreEncryptedPair({
        sourceRoot: process.cwd(),
        archiveStore: { get: () => Buffer.from(JSON.stringify(envelope)) },
        keys: new Map([['new-key', crypto.randomBytes(32)]]),
        sourceScope: {
          environment: 'test',
          installationId: 'source',
          opsInstallationId: 'ops',
        },
        admission: {
          job: { kind: 'backup', id: 'job', buildId: 'candidate' },
          utcSlot: '1970-01-01T02:00:00.000Z',
          objects: {
            learning: { archiveId: 'learning-1', objectId: 'object-1' },
            operations: { archiveId: 'operations-1', objectId: 'object-2' },
          },
        },
        resolveBuild: () => ({
          candidateId: 'candidate',
          sourceDigest: 'sha256:' + '1'.repeat(64),
          artifactDigest: 'sha256:' + '2'.repeat(64),
        }),
        createDestination: async () => {
          destinations++;
          throw new Error('Destination should not open');
        },
      }),
    /OPS_ARCHIVE_KEY/,
  );
  assert.equal(destinations, 0);
});

test('[R4-E-009] compatibility refuses future schema/content and same-build rollback before replacement', () => {
  const current = {
    candidateId: 'new',
    learningMigrations: [{ name: '0000.sql', sha256: 'a' }],
    operationsMigrations: [{ name: '0000_ops.sql', sha256: 'b' }],
    contentVersions: ['poc-1', 'forest-01-v4'],
  };
  const target = { ...structuredClone(current), candidateId: 'old' };
  assert.equal(recovery.assertRollbackCompatibility(current, target), true);
  assert.throws(
    () => recovery.assertRollbackCompatibility(current, current),
    /OPS_ROLLBACK_SAME_BUILD/,
  );
  assert.throws(
    () =>
      recovery.assertRollbackCompatibility(current, {
        ...target,
        contentVersions: ['poc-1'],
      }),
    /OPS_ROLLBACK_INCOMPATIBLE/,
  );
  assert.throws(
    () =>
      recovery.assertRollbackCompatibility(current, {
        ...target,
        learningMigrations: [{ name: 'future.sql', sha256: 'c' }],
      }),
    /OPS_ROLLBACK_INCOMPATIBLE/,
  );
  assert.throws(
    () =>
      recovery.assertRollbackCompatibility(current, {
        ...target,
        operationsMigrations: [],
      }),
    /OPS_ROLLBACK_INCOMPATIBLE/,
  );
});
