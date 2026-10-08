/** Private job executor. Browser callers never provide effects, paths, keys or success claims. */
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import {
  readEncryptedPair,
  opsLearningAdapter,
  assertOpsSourcePair,
} from './pilot-ops-recovery.mjs';
export { assertOpsSourcePair } from './pilot-ops-recovery.mjs';
import {
  createOpsBackupPayload,
  captureOpsLibsql,
} from './pilot-ops-libsql.mjs';
import { opsSchemaSource } from './pilot-ops-schema.mjs';
import {
  sealArchive,
  dailySlot,
  retentionPoints,
  opsArchiveError,
} from './pilot-ops-archive.mjs';

const fail = (c) => {
  throw opsArchiveError(c);
};
const id = () => crypto.randomUUID();
const keyOf = (...v) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(v))
    .digest('hex')
    .slice(0, 48);
const opaque = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(s);
export const safeOpsCode = (error) =>
  typeof error?.code === 'string' &&
  /^(?:OPS|BACKUP|RESTORE)_[A-Z_]+$/.test(error.code)
    ? error.code
    : 'OPS_UNAVAILABLE';
const iso = (ms) => new Date(ms).toISOString();
const fence = (admission) => ({
  jobId: admission.job.id,
  attemptId: admission.attemptId,
  expectedRevision: admission.job.revision,
  eventId: id(),
});

export async function createOpsExecutor(options) {
  const {
    sourceRoot,
    learningClient,
    operationsClient,
    scope,
    archiveStore,
    keys,
    activeKeyId,
    archiveIssuers = [],
    now = Date.now,
    build,
    probe,
    effects = {},
  } = options;
  if (
    !['environment', 'installationId', 'opsInstallationId'].every((k) =>
      opaque(scope?.[k]),
    ) ||
    !(keys instanceof Map) ||
    !keys.has(activeKeyId) ||
    typeof probe !== 'function'
  )
    fail('OPS_CONFIG_INVALID');
  const learningAdapter = opsLearningAdapter(sourceRoot);
  const operationsSource = opsSchemaSource(sourceRoot);
  const installed = await captureOpsLibsql({
    client: operationsClient,
    sourceRoot,
    scope,
  });
  if (installed.format !== operationsSource.format) fail('OPS_SCHEMA_MISMATCH');
  assertOpsSourcePair(learningAdapter.format, installed.format);
  const store = await import(
    pathToFileURL(path.join(sourceRoot, 'lib/pilot/ops-store.ts')).href
  );
  const context = () => ({
    db: createLibsqlD1(operationsClient),
    ...scope,
    buildId: build().candidateId,
    now,
  });
  const hook = async (stage, facts = {}) => {
    if (effects[stage]) await effects[stage](facts);
  };
  const scopeExpected = {
    environment: scope.environment,
    sourceInstallationId: scope.installationId,
    opsInstallationId: scope.opsInstallationId,
  };

  async function readPair(admission) {
    const pair = await readEncryptedPair({
      sourceRoot,
      archiveStore,
      keys,
      sourceScope: scope,
      admission,
      archiveIssuers,
      now,
      resolveBuild: (candidateId) =>
        options.resolveBuild?.(candidateId) ??
        (build().candidateId === candidateId ? build() : null),
    });
    return pair.metadata;
  }

  async function backup(admission) {
    await hook('beforeCapture', { jobId: admission.job.id });
    const currentBuild = build();
    if (currentBuild.candidateId !== admission.job.buildId)
      fail('OPS_BUILD_CHANGED');
    const learning = await learningAdapter.create({
      sourceRoot,
      client: learningClient,
      installationId: scope.installationId,
      candidateId: currentBuild.candidateId,
      archiveIssuers,
      createdAtMs: now(),
    });
    const operations = await createOpsBackupPayload({
      client: operationsClient,
      sourceRoot,
      scope,
      buildId: currentBuild.candidateId,
      now: now(),
    });
    for (const [kind, archive] of [
      ['learning', learning],
      ['operations', operations],
    ]) {
      const planned = admission.objects[kind];
      const envelope = sealArchive({
        bytes: Buffer.from(JSON.stringify(archive)),
        key: keys.get(activeKeyId),
        metadata: {
          payloadFormat: archive.payload.format,
          archiveId: planned.archiveId,
          ...scopeExpected,
          candidateId: currentBuild.candidateId,
          sourceDigest: currentBuild.sourceDigest,
          artifactDigest: currentBuild.artifactDigest,
          schemaDigest: 'sha256:' + archive.payload.schemaDigest,
          createdAt: Date.parse(archive.payload.createdAt),
          keyId: activeKeyId,
        },
      });
      await hook('beforeUpload', { jobId: admission.job.id, kind });
      archiveStore.put(planned.objectId, Buffer.from(JSON.stringify(envelope)));
      await hook('afterUpload', { jobId: admission.job.id, kind });
    }
    await hook('beforeReadback', { jobId: admission.job.id });
    return { kind: 'backup', archives: await readPair(admission) };
  }

  async function deletionPlan(ctx) {
    const rows = (await store.listVerifiedArchives(ctx)).filter(
      (r) => !r.deleted,
    );
    const grouped = new Map();
    for (const row of rows) {
      const a = grouped.get(row.jobId) ?? [];
      a.push(row);
      grouped.set(row.jobId, a);
    }
    const points = [...grouped]
      .filter(
        ([, a]) =>
          a.length === 2 &&
          a.some((r) => r.kind === 'learning') &&
          a.some((r) => r.kind === 'operations'),
      )
      .map(([jobId, a]) => ({
        id: jobId,
        slot: Date.parse(a[0].dailySlot),
        verified: true,
      }));
    const plan = retentionPoints(points);
    const newest = [...points].sort(
      (a, b) => b.slot - a.slot || b.id.localeCompare(a.id),
    )[0];
    if (!newest) fail('OPS_BACKUP_MISSING');
    return {
      archiveIds: plan.delete.flatMap((jobId) =>
        grouped.get(jobId).map((r) => r.id),
      ),
      verifiedPointJobId: newest.id,
    };
  }

  async function retention(admission, ctx) {
    const all = await store.listVerifiedArchives(ctx);
    for (const archiveId of admission.objects.archiveIds) {
      const archive = all.find((r) => r.id === archiveId);
      if (!archive || archive.jobId === admission.objects.verifiedPointJobId)
        fail('OPS_RETENTION_INPUT');
      if (archive.deleted) continue;
      await hook('beforeDelete', { jobId: admission.job.id, archiveId });
      archiveStore.delete(archive.objectRef, archive.ciphertextDigest);
      await hook('afterDelete', { jobId: admission.job.id, archiveId });
    }
    await store.expireFeedback(ctx, { limit: 50 });
    return {
      kind: 'retention',
      deletedArchiveIds: admission.objects.archiveIds,
    };
  }

  async function reconcileSubject(admission, ctx) {
    const subject = await store.readJobForReconcile(
      ctx,
      admission.objects.subjectJobId,
    );
    if (subject.job.status === 'succeeded')
      return {
        kind: 'reconcile',
        subjectJobId: subject.job.id,
        outcome: 'confirmed',
      };
    if (subject.job.status === 'failed')
      return {
        kind: 'reconcile',
        subjectJobId: subject.job.id,
        outcome: 'not-committed',
      };
    if (subject.admission === 'busy') fail('OPS_EFFECT_UNCONFIRMED');
    let result;
    if (subject.job.kind === 'backup')
      result = { kind: 'backup', archives: await readPair(subject) };
    else if (subject.job.kind === 'retention') {
      const rows = await store.listVerifiedArchives(ctx);
      const planned = subject.objects.archiveIds.map((archiveId) =>
        rows.find((r) => r.id === archiveId),
      );
      if (
        planned.some((row) => !row || archiveStore.get(row.objectRef) !== null)
      )
        fail('OPS_EFFECT_UNCONFIRMED');
      result = {
        kind: 'retention',
        deletedArchiveIds: subject.objects.archiveIds,
      };
    } else fail('OPS_EFFECT_UNCONFIRMED');
    await store.reconcileJob(ctx, {
      ...fence(subject),
      observation: { outcome: 'confirmed', result },
    });
    return {
      kind: 'reconcile',
      subjectJobId: subject.job.id,
      outcome: 'confirmed',
    };
  }

  async function dispatch(kind, input = {}) {
    if (
      !['backup', 'monitor', 'retention', 'reconcile'].includes(kind) ||
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => k !== 'subjectJobId') ||
      (kind === 'reconcile'
        ? !opaque(input.subjectJobId)
        : Object.keys(input).length !== 0)
    )
      fail('OPS_JOB_INPUT');
    const ctx = context(),
      at = now();
    const slot = iso(
      ['backup', 'retention'].includes(kind)
        ? dailySlot(at)
        : Math.floor(at / 60000) * 60000,
    );
    const jobId = 'job-' + keyOf(scope, kind, slot);
    let objects = {};
    if (kind === 'backup')
      objects = Object.fromEntries(
        ['learning', 'operations'].map((k) => [
          k,
          {
            archiveId: 'archive-' + keyOf(scope, jobId, k),
            objectId: 'object-' + keyOf(scope, jobId, k),
          },
        ]),
      );
    else if (kind === 'retention') objects = await deletionPlan(ctx);
    else if (kind === 'reconcile')
      objects = { subjectJobId: input.subjectJobId };
    const admission = await store.acquireJob(ctx, {
      jobId,
      kind,
      utcSlot: slot,
      attemptId: id(),
      eventId: id(),
      objects,
    });
    if (admission.admission === 'terminal' || admission.admission === 'busy')
      return resultOf(admission);
    try {
      await hook('afterLease', { jobId: admission.job.id });
      let result;
      if (admission.admission === 'reconcile') {
        if (kind !== 'backup') fail('OPS_EFFECT_UNCONFIRMED');
        result = { kind: 'backup', archives: await readPair(admission) };
        await store.reconcileJob(ctx, {
          ...fence(admission),
          observation: { outcome: 'confirmed', result },
        });
      } else {
        if (kind === 'backup') result = await backup(admission);
        else if (kind === 'retention') result = await retention(admission, ctx);
        else if (kind === 'reconcile')
          result = await reconcileSubject(admission, ctx);
        else {
          const health = await probe();
          if (!['healthy', 'unhealthy'].includes(health))
            fail('OPS_MONITOR_UNKNOWN');
          result = {
            kind: 'monitor',
            health,
            checkedAt: now(),
            code: health === 'healthy' ? null : 'OPS_PROBE_FAILED',
          };
        }
        await hook('beforeCommit', { jobId: admission.job.id });
        await store.completeJobVerified(ctx, { ...fence(admission), result });
        await hook('afterCommit', { jobId: admission.job.id });
      }
    } catch (error) {
      const current = await store.readJobForReconcile(ctx, admission.job.id);
      if (!['succeeded', 'failed'].includes(current.job.status)) {
        try {
          await store.markJobUncertain(ctx, {
            ...fence(current),
            code: 'OPS_EFFECT_UNCONFIRMED',
          });
        } catch {
          /* A concurrent fence may have settled it; read authoritative state below. */
        }
      }
      const actual = await store.readJobForReconcile(ctx, admission.job.id);
      return {
        ...resultOf(actual),
        code: actual.job.status === 'succeeded' ? null : safeOpsCode(error),
      };
    }
    return resultOf(await store.readJobForReconcile(ctx, admission.job.id));
  }
  function resultOf(admission) {
    return {
      jobId: admission.job.id,
      archiveId: admission.job.kind === 'backup' ? admission.job.id : null,
      status:
        admission.job.status === 'succeeded' && admission.job.kind === 'backup'
          ? 'verified'
          : admission.job.status,
      revision: admission.job.revision,
      archives: admission.job.archives,
    };
  }
  return { dispatch, readPair, context, store };
}
