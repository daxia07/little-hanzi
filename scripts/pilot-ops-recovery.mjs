/** Private encrypted recovery and read-only compatibility preflight. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  openArchive,
  archiveDigest,
  opsArchiveError,
} from './pilot-ops-archive.mjs';
import {
  validateStoryBackupEnvelope,
  restoreStoryBackupPayload,
  createStoryBackupPayload,
} from './pilot-story-libsql-backup.mjs';
import {
  validateOpsBackupEnvelope,
  restoreOpsLibsql,
  createOpsBackupPayload,
} from './pilot-ops-libsql.mjs';
import { verifyNodeManifest } from './readiness-node-runner.mjs';
import { storySchemaSource } from './pilot-story-schema.mjs';
import { pilotBackupFormatForCandidate } from './pilot-backup.mjs';
import { collectionSchemaSource } from './pilot-collection-schema.mjs';
import {
  createCollectionBackupPayload,
  validateCollectionBackupEnvelope,
  restoreCollectionBackupPayload,
  captureCollectionLibsql,
} from './pilot-collection-libsql-backup.mjs';
import { captureStoryLibsql } from './pilot-story-libsql-backup.mjs';
import { opsSchemaSource } from './pilot-ops-schema.mjs';
import { corpusSchemaSource } from './pilot-corpus-schema.mjs';
import { corpusProfile } from './readiness-corpus-profiles.mjs';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import {
  createCorpusBackupPayload,
  validateCorpusBackupEnvelope,
  restoreCorpusBackupPayload,
  captureCorpusLibsql,
} from './pilot-corpus-libsql-backup.mjs';

/** Closed source-derived adapter; caller payloads never select archive format. */
export function opsLearningAdapter(sourceRoot) {
  const format = pilotBackupFormatForCandidate({ snapshot: sourceRoot });
  if (format === 'pilot-admin-backup-4')
    return {
      format,
      schema: storySchemaSource(sourceRoot),
      create: createStoryBackupPayload,
      validate: validateStoryBackupEnvelope,
      restore: restoreStoryBackupPayload,
      capture: captureStoryLibsql,
    };
  if (format === 'pilot-admin-backup-5')
    return {
      format,
      schema: collectionSchemaSource(sourceRoot),
      create: createCollectionBackupPayload,
      validate: validateCollectionBackupEnvelope,
      restore: restoreCollectionBackupPayload,
      capture: captureCollectionLibsql,
    };
  if (format === 'pilot-admin-backup-6')
    return {
      format,
      schema: corpusSchemaSource(sourceRoot),
      create: createCorpusBackupPayload,
      validate: validateCorpusBackupEnvelope,
      restore: restoreCorpusBackupPayload,
      capture: captureCorpusLibsql,
    };
  throw opsArchiveError('OPS_ROLLBACK_INCOMPATIBLE');
}

const fail = (code) => {
  throw opsArchiveError(code);
};

/** Closed current-source pair; historical archive rows retain their own policy. */
export function assertOpsSourcePair(learningFormat, operationsFormat) {
  if (
    !(
      (learningFormat === 'pilot-admin-backup-4' &&
        ['pilot-ops-backup-1', 'pilot-ops-backup-2'].includes(
          operationsFormat,
        )) ||
      (learningFormat === 'pilot-admin-backup-5' &&
        operationsFormat === 'pilot-ops-backup-2') ||
      (learningFormat === 'pilot-admin-backup-6' &&
        operationsFormat === 'pilot-ops-backup-3')
    )
  )
    fail('OPS_SCHEMA_MISMATCH');
}
const digest = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const codeOf = (error) =>
  /^(?:OPS|BACKUP|RESTORE)_[A-Z_]+$/.test(error?.code ?? '')
    ? error.code
    : 'OPS_RECOVERY_UNCONFIRMED';

/** No destination is touched here. Returned plaintext stays in this private process. */
export async function readEncryptedPair({
  sourceRoot,
  archiveStore,
  keys,
  sourceScope,
  admission,
  resolveBuild,
  archiveIssuers = [],
  now = Date.now,
}) {
  if (
    admission?.job?.kind !== 'backup' ||
    !admission.objects?.learning ||
    !admission.objects?.operations
  )
    fail('OPS_ARCHIVE_PAIR_REQUIRED');
  const build = resolveBuild(admission.job.buildId);
  if (!build || build.candidateId !== admission.job.buildId)
    fail('OPS_ARCHIVE_SCOPE');
  const learningAdapter = opsLearningAdapter(sourceRoot);
  const operationsSource = opsSchemaSource(sourceRoot);
  assertOpsSourcePair(learningAdapter.format, operationsSource.format);
  const expected = {
    environment: sourceScope.environment,
    sourceInstallationId: sourceScope.installationId,
    opsInstallationId: sourceScope.opsInstallationId,
  };
  const payloads = {},
    metadata = [];
  for (const kind of ['learning', 'operations']) {
    const planned = admission.objects[kind],
      bytes = archiveStore.get(planned.objectId);
    if (!bytes) fail('OPS_EFFECT_UNCONFIRMED');
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('OPS_ARCHIVE_FORMAT');
    }
    const opened = openArchive({ envelope, keys, expected }),
      meta = opened.metadata;
    const format =
      kind === 'learning' ? learningAdapter.format : operationsSource.format;
    if (
      meta.archiveId !== planned.archiveId ||
      meta.payloadFormat !== format ||
      meta.candidateId !== build.candidateId ||
      meta.sourceDigest !== build.sourceDigest ||
      meta.artifactDigest !== build.artifactDigest
    )
      fail('OPS_ARCHIVE_SCOPE');
    let archive;
    try {
      archive = JSON.parse(opened.bytes.toString('utf8'));
    } catch {
      fail('OPS_ARCHIVE_FORMAT');
    }
    const p = archive.payload;
    if (
      p?.format !== format ||
      p.sourceInstallationId !== expected.sourceInstallationId ||
      (kind === 'learning' ? p.candidateId : p.buildId) !== build.candidateId ||
      'sha256:' + p.schemaDigest !== meta.schemaDigest ||
      Date.parse(p.createdAt) !== meta.createdAt ||
      (kind === 'operations' &&
        (p.sourceOpsInstallationId !== expected.opsInstallationId ||
          p.environment !== expected.environment))
    )
      fail('OPS_ARCHIVE_SCOPE');
    if (kind === 'learning')
      await learningAdapter.validate({
        archive,
        sourceRoot,
        archiveIssuers,
      });
    else await validateOpsBackupEnvelope({ archive, sourceRoot });
    payloads[kind] = archive;
    metadata.push({
      id: planned.archiveId,
      kind,
      format,
      objectRef: planned.objectId,
      keyId: meta.keyId,
      plaintextDigest: meta.plaintextDigest,
      ciphertextDigest: archiveDigest(bytes),
      byteSize: bytes.length,
      dataAt: meta.createdAt,
      createdAt: meta.createdAt,
      verifiedAt: now(),
      dailySlot: admission.utcSlot,
      weeklySlot:
        new Date(admission.utcSlot).getUTCDay() === 0
          ? admission.utcSlot
          : null,
    });
  }
  return { metadata, payloads };
}

export async function restoreEncryptedPair(
  options,
  { decorateLearning, decorateOperations } = {},
) {
  // Full checks of BOTH sources precede resource creation as well as queries/writes.
  const pair = await readEncryptedPair(options);
  const destination = await options.createDestination();
  const { learningClient, operationsClient, scope } = destination;
  if (
    scope.installationId === options.sourceScope.installationId ||
    scope.opsInstallationId === options.sourceScope.opsInstallationId
  )
    fail('OPS_RESTORE_NOT_FRESH');
  const common = {
    sourceRoot: options.sourceRoot,
    archiveIssuers: options.archiveIssuers ?? [],
  };
  let learning, operations;
  try {
    learning = await opsLearningAdapter(options.sourceRoot).restore(
      {
        ...common,
        archive: pair.payloads.learning,
        client: learningClient,
        installationId: scope.installationId,
      },
      { decorateClient: decorateLearning },
    );
  } catch (error) {
    return {
      status:
        codeOf(error) === 'RESTORE_NOT_COMMITTED'
          ? 'not-committed'
          : 'unconfirmed',
      learning: { error: codeOf(error) },
      operations: { status: 'not-run' },
      ...scope,
    };
  }
  try {
    operations = await restoreOpsLibsql(
      {
        sourceRoot: options.sourceRoot,
        archive: pair.payloads.operations,
        client: operationsClient,
        scope,
      },
      { decorateClient: decorateOperations },
    );
  } catch (error) {
    return {
      status: 'partial',
      learning,
      operations: { error: codeOf(error) },
      ...scope,
    };
  }
  return {
    status: 'confirmed',
    learning,
    operations,
    ...scope,
    sourceInstallationId: options.sourceScope.installationId,
    sourceOpsInstallationId: options.sourceScope.opsInstallationId,
    dataAt: Math.min(...pair.metadata.map((v) => v.dataAt)),
  };
}

export function assertRollbackCompatibility(current, target) {
  if (current.candidateId === target.candidateId)
    fail('OPS_ROLLBACK_SAME_BUILD');
  if (
    JSON.stringify(current.learningMigrations) !==
      JSON.stringify(target.learningMigrations) ||
    JSON.stringify(current.operationsMigrations) !==
      JSON.stringify(target.operationsMigrations) ||
    !Array.isArray(target.contentVersions) ||
    current.contentVersions.some((v) => !target.contentVersions.includes(v))
  )
    fail('OPS_ROLLBACK_INCOMPATIBLE');
  return true;
}

/** Derive the immutable contract from an actually verified retained candidate. */
export function opsCompatibility(
  manifest,
  operationsSourceRoot = manifest.snapshot,
) {
  verifyNodeManifest(manifest, { built: true });
  if (!['r3', 'r4', 'r5', 'r6'].includes(manifest.phase))
    fail('OPS_ROLLBACK_INCOMPATIBLE');
  const adapter = opsLearningAdapter(manifest.snapshot);
  if ((manifest.phase === 'r6') !== (adapter.format === 'pilot-admin-backup-6'))
    fail('OPS_ROLLBACK_INCOMPATIBLE');
  const learning = adapter.schema,
    operations = opsSchemaSource(operationsSourceRoot);
  assertOpsSourcePair(adapter.format, operations.format);
  const contentVersions = ['poc-1', 'forest-01-v1'];
  for (const version of ['forest-01-v2', 'forest-01-v4']) {
    const doc = JSON.parse(
      fs.readFileSync(
        path.join(manifest.snapshot, 'content/curriculum', version + '.json'),
        'utf8',
      ),
    );
    if (doc.lessonVersion !== version) fail('OPS_ROLLBACK_INCOMPATIBLE');
    contentVersions.push(version);
  }
  if (
    ['pilot-admin-backup-5', 'pilot-admin-backup-6'].includes(adapter.format)
  ) {
    for (const name of fs
      .readdirSync(
        path.join(manifest.snapshot, 'content/curriculum/collection'),
      )
      .filter((n) => /^path-(0[1-9]|10)-v[1-9][0-9]*\.json$/.test(n))) {
      const doc = JSON.parse(
        fs.readFileSync(
          path.join(manifest.snapshot, 'content/curriculum/collection', name),
          'utf8',
        ),
      );
      if (doc.lessonVersion !== name.slice(0, -5))
        fail('OPS_ROLLBACK_INCOMPATIBLE');
      contentVersions.push(doc.lessonVersion);
    }
  }
  if (adapter.format === 'pilot-admin-backup-6') {
    const read = (file) => {
      if (!manifest.files.includes(file)) fail('OPS_ROLLBACK_INCOMPATIBLE');
      return JSON.parse(
        fs.readFileSync(path.join(manifest.snapshot, file), 'utf8'),
      );
    };
    for (const name of ['draft-corpus', 'stress-corpus']) {
      const profile = corpusProfile(name);
      const corpus = inspectCorpusManifest(read(profile.manifestPath));
      for (const item of corpus.items) {
        const pkg = read(
          profile.packageDirectory + '/' + item.lessonVersion + '.json',
        );
        const actualDigest =
          'sha256:' +
          crypto
            .createHash('sha256')
            .update(canonicalPackage(pkg))
            .digest('hex');
        if (
          pkg.lessonVersion !== item.lessonVersion ||
          actualDigest !== item.contentDigest
        )
          fail('OPS_ROLLBACK_INCOMPATIBLE');
        contentVersions.push(item.lessonVersion);
      }
    }
    if (new Set(contentVersions).size !== contentVersions.length)
      fail('OPS_ROLLBACK_INCOMPATIBLE');
  }
  return {
    format: 'pilot-ops-compatibility-1',
    candidateId: manifest.candidateId,
    sourceDigest: 'sha256:' + manifest.digest,
    artifactDigest: 'sha256:' + manifest.artifactDigest,
    learningMigrations: learning.migrations,
    operationsMigrations: operations.migrations,
    archiveFormats: [adapter.format, operations.format],
    adapters: ['node-libsql', 'private-local-directory-1'],
    contentVersions,
    operationsTooling:
      operations.version === 1
        ? 'separate-retained-r4'
        : operations.version === 2
          ? 'separate-retained-r5'
          : 'separate-retained-r6',
    schemaDigest: digest({
      learning: learning.schema,
      operations: operations.schema,
    }),
  };
}

/** Read-only, semantic validation of actual installed data; never replaces a process. */
export async function preflightOpsRollback({
  currentManifest,
  targetManifest,
  operationsSourceRoot,
  learningClient,
  operationsClient,
  scope,
  archiveIssuers = [],
  now = Date.now(),
}) {
  const sourceRoot = operationsSourceRoot ?? currentManifest.snapshot;
  const current = opsCompatibility(currentManifest, sourceRoot),
    target = opsCompatibility(targetManifest, sourceRoot);
  assertRollbackCompatibility(current, target);
  const learning = await opsLearningAdapter(targetManifest.snapshot).create({
    sourceRoot: targetManifest.snapshot,
    client: learningClient,
    installationId: scope.installationId,
    candidateId: targetManifest.candidateId,
    archiveIssuers,
    createdAtMs: now,
  });
  if (
    Object.keys(learning.payload.contentIdentities.curriculum).some(
      (version) => !target.contentVersions.includes(version),
    )
  )
    fail('OPS_ROLLBACK_INCOMPATIBLE');
  const operations = await createOpsBackupPayload({
    client: operationsClient,
    sourceRoot,
    scope,
    buildId: currentManifest.candidateId,
    now,
  });
  return {
    status: 'compatible',
    current,
    target,
    learningDigest: learning.sha256,
    operationsDigest: operations.sha256,
  };
}
