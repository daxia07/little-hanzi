/** Fixed private rehearsal on the actual built evidence DB; no public request data. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import { acquireJob, completeJobVerified } from '../lib/pilot/ops-store.ts';
import { jobSlot } from '../lib/pilot/ops-domain.ts';
import { verifyNodeManifest } from './readiness-node-runner.mjs';
import { applyLibsqlMigrations } from './pilot-libsql-admin.mjs';
import {
  createCorpusBackupPayload,
  captureCorpusLibsql,
} from './pilot-corpus-libsql-backup.mjs';
import {
  initializeOpsLibsql,
  createOpsBackupPayload,
  captureOpsLibsql,
} from './pilot-ops-libsql.mjs';
import { sealArchive, opsArchiveError } from './pilot-ops-archive.mjs';
import { restoreEncryptedPair } from './pilot-ops-recovery.mjs';

const fail = (code) => {
  throw opsArchiveError(code);
};
const count = (tables) =>
  Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.length]),
  );
const normalized = (tables) =>
  canonicalPackage(
    Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [
        name,
        rows.map(canonicalPackage).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    ),
  );

export async function runCorpusOpsRecovery({
  manifest,
  client,
  installationId,
  archiveIssuers = [],
  at,
  signal,
}) {
  if (manifest?.phase !== 'r6') fail('OPS_CORPUS_CANDIDATE_REQUIRED');
  verifyNodeManifest(manifest, { built: true });
  const ownFile = 'scripts/readiness-corpus-ops-recovery.mjs';
  if (
    !manifest.files.includes(ownFile) ||
    !fs
      .readFileSync(fileURLToPath(import.meta.url))
      .equals(fs.readFileSync(path.join(manifest.snapshot, ownFile))) ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    typeof installationId !== 'string' ||
    !installationId
  )
    fail('OPS_CORPUS_CANDIDATE_REQUIRED');
  const checkAbort = () => {
    if (signal?.aborted) fail('OPS_RUNNER_ABORTED');
  };
  checkAbort();
  const started = performance.now();
  const directory = path.join(
    manifest.work,
    'corpus-ops-' + crypto.randomUUID(),
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = crypto.randomUUID();
  fs.writeFileSync(path.join(directory, '.hanzi-qa-owned'), marker, {
    mode: 0o600,
    flag: 'wx',
  });
  const owned = fs.lstatSync(directory),
    clients = [],
    key = crypto.randomBytes(32);
  const open = (name) => {
    checkAbort();
    const connection = createClient({
      url: 'file:' + path.join(directory, name + '.db'),
    });
    clients.push(connection);
    return connection;
  };
  const abort = () => {
    for (const connection of clients) connection.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  let result;
  try {
    const sourceRoot = manifest.snapshot;
    const sourceScope = {
      environment: 'r6-synthetic-operations',
      installationId,
      opsInstallationId: 'r6-ops-' + crypto.randomUUID(),
    };
    const operations = open('source-operations');
    await initializeOpsLibsql({
      client: operations,
      sourceRoot,
      scope: sourceScope,
      now: at,
    });
    const context = {
      db: createLibsqlD1(operations),
      ...sourceScope,
      buildId: manifest.candidateId,
      now: () => at,
    };
    await acquireJob(context, {
      jobId: 'r6-monitor',
      kind: 'monitor',
      utcSlot: jobSlot('monitor', at),
      attemptId: 'r6-attempt',
      eventId: 'r6-acquired',
      objects: {},
    });
    await completeJobVerified(context, {
      jobId: 'r6-monitor',
      attemptId: 'r6-attempt',
      expectedRevision: 1,
      eventId: 'r6-completed',
      result: { kind: 'monitor', health: 'healthy', checkedAt: at, code: null },
    });
    checkAbort();
    const archives = {
      learning: await createCorpusBackupPayload({
        sourceRoot,
        candidateId: manifest.candidateId,
        client,
        installationId,
        archiveIssuers,
        createdAtMs: at,
      }),
      operations: await createOpsBackupPayload({
        client: operations,
        sourceRoot,
        scope: sourceScope,
        buildId: manifest.candidateId,
        now: at,
      }),
    };
    if (
      archives.learning.payload.format !== 'pilot-admin-backup-6' ||
      archives.operations.payload.format !== 'pilot-ops-backup-3'
    )
      fail('OPS_SCHEMA_MISMATCH');
    const build = {
      candidateId: manifest.candidateId,
      sourceDigest: 'sha256:' + manifest.digest,
      artifactDigest: 'sha256:' + manifest.artifactDigest,
    };
    const admission = {
      job: { id: 'r6-pair', kind: 'backup', buildId: manifest.candidateId },
      utcSlot: new Date(at).toISOString().slice(0, 10) + 'T02:00:00.000Z',
      objects: {},
    };
    const store = new Map(),
      sizes = {};
    for (const kind of ['learning', 'operations']) {
      const archive = archives[kind],
        bytes = Buffer.from(JSON.stringify(archive));
      const object = { archiveId: 'r6-' + kind, objectId: 'r6-object-' + kind };
      admission.objects[kind] = object;
      const envelope = sealArchive({
        bytes,
        key,
        metadata: {
          payloadFormat: archive.payload.format,
          archiveId: object.archiveId,
          environment: sourceScope.environment,
          sourceInstallationId: installationId,
          opsInstallationId: sourceScope.opsInstallationId,
          ...build,
          schemaDigest: 'sha256:' + archive.payload.schemaDigest,
          createdAt: at,
          keyId: 'r6-ephemeral',
        },
      });
      store.set(object.objectId, Buffer.from(JSON.stringify(envelope)));
      sizes[kind] = bytes.length;
    }
    let destinationCount = 0,
      learningTarget,
      operationsTarget,
      restoredScope;
    const options = {
      sourceRoot,
      sourceScope,
      archiveIssuers,
      archiveStore: { get: (id) => store.get(id) },
      keys: new Map([['r6-ephemeral', key]]),
      admission,
      resolveBuild: (id) => (id === build.candidateId ? build : null),
      now: () => at,
      createDestination: async () => {
        checkAbort();
        destinationCount++;
        learningTarget = open('restored-learning');
        operationsTarget = open('restored-operations');
        await applyLibsqlMigrations({
          client: learningTarget,
          root: sourceRoot,
        });
        const restoredId = (
          await learningTarget.execute(
            'SELECT installation_id FROM pilot_installation',
          )
        ).rows[0].installation_id;
        restoredScope = {
          environment: sourceScope.environment,
          installationId: restoredId,
          opsInstallationId: 'r6-restored-ops-' + crypto.randomUUID(),
        };
        await initializeOpsLibsql({
          client: operationsTarget,
          sourceRoot,
          scope: restoredScope,
          now: at,
        });
        return {
          learningClient: learningTarget,
          operationsClient: operationsTarget,
          scope: restoredScope,
        };
      },
    };
    const objectId = admission.objects.operations.objectId,
      original = store.get(objectId);
    const broken = JSON.parse(original.toString('utf8'));
    broken.metadata.payloadFormat = 'pilot-ops-backup-2';
    store.set(objectId, Buffer.from(JSON.stringify(broken)));
    let sourceError;
    try {
      await restoreEncryptedPair(options);
    } catch (error) {
      sourceError = error;
    }
    if (
      !sourceError ||
      !/^OPS_[A-Z_]+$/.test(sourceError.code ?? '') ||
      destinationCount !== 0
    )
      fail('OPS_SOURCE_REFUSAL_INVALID');
    const sourceRefusal = { code: sourceError.code, destinationCount };
    store.set(objectId, original);
    checkAbort();
    const restored = await restoreEncryptedPair(options);
    if (restored.status !== 'confirmed' || destinationCount !== 1) {
      const error = opsArchiveError('OPS_RESTORE_UNCONFIRMED');
      error.details = {
        status: restored.status,
        learning: restored.learning,
        operations: restored.operations,
      };
      throw error;
    }
    const learned = await captureCorpusLibsql(
      learningTarget,
      restoredScope.installationId,
    );
    const operated = await captureOpsLibsql({
      client: operationsTarget,
      sourceRoot,
      scope: restoredScope,
    });
    const expectedOperations = {
      ...archives.operations.payload.tables,
      ops_installation: archives.operations.payload.tables.ops_installation.map(
        (row) => ({
          ...row,
          installation_id: restoredScope.opsInstallationId,
          learning_installation_id: restoredScope.installationId,
        }),
      ),
    };
    if (
      Object.keys(learned.tables).length !== 67 ||
      Object.keys(operated.tables).length !== 8 ||
      learned.sessionCount !== 0 ||
      restoredScope.installationId === installationId ||
      normalized(learned.tables) !==
        normalized(archives.learning.payload.tables) ||
      normalized(operated.tables) !== normalized(expectedOperations)
    )
      fail('OPS_RESTORE_READBACK_INVALID');
    checkAbort();
    result = {
      status: 'confirmed',
      formats: ['pilot-admin-backup-6', 'pilot-ops-backup-3'],
      sourceInstallationId: installationId,
      restoredInstallationId: restoredScope.installationId,
      learningCounts: count(learned.tables),
      operationsCounts: count(operated.tables),
      learningBytes: sizes.learning,
      operationsBytes: sizes.operations,
      encryptedBytes: [...store.values()].reduce(
        (total, value) => total + value.length,
        0,
      ),
      durationMs: 0,
      rowsMatch: true,
      restoredSessionCount: learned.sessionCount,
      sourceRefusal,
      cleanup: { clientsClosed: false, directoryRemoved: false },
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    let closed = true;
    for (const connection of clients) {
      try {
        connection.close();
      } catch {
        closed = false;
      }
    }
    key.fill(0);
    const current = fs.lstatSync(directory);
    if (
      !closed ||
      current.isSymbolicLink() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      current.uid !== process.getuid() ||
      fs.readFileSync(path.join(directory, '.hanzi-qa-owned'), 'utf8') !==
        marker
    )
      fail('OPS_CLEANUP_INCOMPLETE');
    fs.rmSync(directory, { recursive: true });
    if (result)
      result.cleanup = { clientsClosed: true, directoryRemoved: true };
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
