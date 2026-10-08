import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateOpsArchive } from '../lib/pilot/ops-archive.ts';
import { OPS_TABLES } from '../lib/pilot/ops-schema.ts';
import { createClient } from '@libsql/client';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import { opsSchemaSource } from '../scripts/pilot-ops-schema.mjs';
import * as store from '../lib/pilot/ops-store.ts';
import { hash, canonicalPackage } from '../lib/pilot/ops-domain.ts';
import { jobSlot } from '../lib/pilot/ops-domain.ts';
const start = Date.parse('2026-09-27T03:00:00Z');
async function fresh(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-ops-store-'));
  const client = createClient({ url: 'file:' + path.join(dir, 'owned.db') });
  try {
    const schema = opsSchemaSource(undefined, { version: 1 });
    await client.executeMultiple(schema.sql);
    await client.execute({
      sql: 'INSERT INTO ops_installation VALUES(1,?,?,?,?,0,?)',
      args: ['ops-unit', 'qa-unit', 'learn-unit', 'pilot-ops-schema-1', start],
    });
    await client.execute({
      sql: 'INSERT INTO ops_schema_history VALUES(0,?,?,?)',
      args: ['0000_ops.sql', schema.migrations[0].sha256, start],
    });
    let clock = start;
    const ctx = {
      db: createLibsqlD1(client),
      environment: 'qa-unit',
      installationId: 'learn-unit',
      opsInstallationId: 'ops-unit',
      buildId: 'build-unit',
      now: () => clock,
    };
    await callback(ctx, client, (value) => (clock = value));
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const objects = {
  learning: { archiveId: 'archive-learning', objectId: 'object-learning' },
  operations: { archiveId: 'archive-ops', objectId: 'object-ops' },
};
const acquire = (ctx) => ({
  jobId: 'job-backup',
  kind: 'backup',
  utcSlot: jobSlot('backup', ctx.now()),
  attemptId: 'attempt-one',
  eventId: 'job-acquired',
  objects,
});
const fence = {
  jobId: 'job-backup',
  attemptId: 'attempt-one',
  expectedRevision: 1,
  eventId: 'job-completed',
};
function pair(ctx) {
  return ['learning', 'operations'].map((kind) => ({
    id: objects[kind].archiveId,
    kind,
    format: kind === 'learning' ? 'pilot-admin-backup-4' : 'pilot-ops-backup-1',
    objectRef: objects[kind].objectId,
    keyId: 'synthetic-key-ref',
    plaintextDigest: 'sha256:' + 'a'.repeat(64),
    ciphertextDigest: 'sha256:' + 'b'.repeat(64),
    byteSize: 100,
    dataAt: ctx.now(),
    createdAt: ctx.now(),
    verifiedAt: ctx.now(),
    dailySlot: jobSlot('backup', ctx.now()),
    weeklySlot: jobSlot('backup', ctx.now()),
  }));
}
test('R4-E004 actual freshSQL slot admission preventsduplicate andexpiredlease onlyreconciles', async () =>
  fresh(async (ctx, client, set) => {
    const first = await store.acquireJob(ctx, acquire(ctx));
    assert.equal(first.admission, 'dispatch');
    assert.equal(
      (
        await store.acquireJob(ctx, {
          ...acquire(ctx),
          eventId: 'different-admission',
        })
      ).admission,
      'busy',
    );
    set(start + 300000);
    assert.equal(
      (
        await store.acquireJob(ctx, {
          ...acquire(ctx),
          eventId: 'lease-expired',
        })
      ).admission,
      'reconcile',
    );
    assert.equal(
      Number(
        (await client.execute('SELECT count(*) AS n FROM ops_job')).rows[0].n,
      ),
      1,
    );
  }));
test('R4-E003/005 verifiedpair commitsonce; changedreplay/stalefence cannotappend', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    const input = { ...fence, result: { kind: 'backup', archives: pair(ctx) } };
    const first = await store.completeJobVerified(ctx, input);
    assert.equal(first.status, 'succeeded');
    assert.deepEqual(await store.completeJobVerified(ctx, input), first);
    await assert.rejects(
      store.completeJobVerified(ctx, {
        ...input,
        result: {
          kind: 'backup',
          archives: pair(ctx).map((a) => ({ ...a, byteSize: 101 })),
        },
      }),
      (e) => e.code === 'OPS_CONFLICT',
    );
    assert.equal(
      Number(
        (await client.execute('SELECT count(*) AS n FROM ops_archive')).rows[0]
          .n,
      ),
      2,
    );
  }));
test('R4-E005 partialpair/terminalSQLfault cannotleaveacceptedprojection orarchivefacts', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    await assert.rejects(
      store.completeJobVerified(ctx, {
        ...fence,
        result: { kind: 'backup', archives: [pair(ctx)[0]] },
      }),
    );
    await client.execute(
      "CREATE TRIGGER unit_final_fault BEFORE INSERT ON ops_job_event WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT,'UNIT_FINAL_FAILURE'); END",
    );
    await assert.rejects(
      store.completeJobVerified(ctx, {
        ...fence,
        result: { kind: 'backup', archives: pair(ctx) },
      }),
    );
    assert.equal(
      (await client.execute("SELECT status FROM ops_job WHERE id='job-backup'"))
        .rows[0].status,
      'running',
    );
    assert.equal(
      Number(
        (await client.execute('SELECT count(*) AS n FROM ops_archive')).rows[0]
          .n,
      ),
      0,
    );
  }));
test('R4-E006 dataage preventsreconciledoldpair pretendingfresh', async () =>
  fresh(async (ctx, client, set) => {
    await store.acquireJob(ctx, acquire(ctx));
    await store.completeJobVerified(ctx, {
      ...fence,
      result: { kind: 'backup', archives: pair(ctx) },
    });
    set(start + 93600001);
    const monitor = {
      jobId: 'job-monitor',
      kind: 'monitor',
      utcSlot: jobSlot('monitor', ctx.now()),
      attemptId: 'monitor-one',
      eventId: 'monitor-acquired',
      objects: {},
    };
    await store.acquireJob(ctx, monitor);
    await store.completeJobVerified(ctx, {
      jobId: 'job-monitor',
      attemptId: 'monitor-one',
      expectedRevision: 1,
      eventId: 'monitor-completed',
      result: {
        kind: 'monitor',
        health: 'healthy',
        checkedAt: ctx.now(),
        code: null,
      },
    });
    const status = await store.readOpsStatus(ctx);
    assert.equal(status.monitorState, 'unhealthy');
    assert.equal(status.backupAgeMs, 93600001);
    assert.equal(status.lastBackupDataAt, start);
  }));
test('R4-E010/012 privateexpiry redactsallrevisions whileoriginalreceipt exactreplays', async () =>
  fresh(async (ctx, client, set) => {
    const actor = { id: 'parent-unit', role: 'parent' };
    const input = {
      requestId: 'feedback-one',
      runId: 'run-unit',
      category: 'sound',
      observed: 'PRIVATE sound stopped',
      expected: 'PRIVATE listen',
    };
    const source = {
      childId: 'child-unit',
      runId: 'run-unit',
      runInstallationId: 'old-learn',
      candidateId: 'old-build',
      lessonId: 'forest-01',
      lessonVersion: 'forest-01-v4',
      contentDigest: 'sha256:' + 'a'.repeat(64),
      buildId: 'old-build',
    };
    const receipt = await store.createFeedback(ctx, actor, input, source);
    assert.equal(
      (await store.readFeedback(ctx, receipt.recordId)).buildId,
      'old-build',
    );
    await store.triageFeedback(
      ctx,
      { id: 'operator-unit', role: 'operator' },
      receipt.recordId,
      {
        requestId: 'triage-one',
        expectedRevision: 1,
        severity: 'high',
        ownerRef: 'PRIVATE owner',
        status: 'in-progress',
        acIds: ['R4-E-010'],
        disposition: 'PRIVATE diagnosis',
        retestRef: 'PRIVATE ref',
        nextReviewAt: start + 1,
      },
    );
    set(start + 2592000000);
    const detail = await store.readFeedback(ctx, receipt.recordId);
    assert.equal(detail.status, 'expired');
    assert.equal(detail.details, null);
    assert.equal(detail.ownerRef, null);
    assert(!JSON.stringify(detail).includes('PRIVATE'));
    assert.deepEqual(
      await store.createFeedback(ctx, actor, input, source),
      receipt,
    );
    const rows = await client.execute(
      'SELECT request_json,private_json FROM ops_feedback_event',
    );
    assert(
      rows.rows.every(
        (r) => r.request_json === null && r.private_json === null,
      ),
    );
  }));
test('R4-E003/010 expired/history mutations cannotreopen andqueuecursor revision isbound', async () =>
  fresh(async (ctx) => {
    const actor = { id: 'operator-unit', role: 'operator' };
    const obs = {
      requestId: 'obs-one',
      observation: {
        kind: 'synthetic',
        participantLabel: 'QA',
        candidateId: 'build',
        lessonVersion: 'forest-01-v4',
        contentDigest: 'sha256:' + 'a'.repeat(64),
        observedAt: start,
        device: 'QA',
        browser: 'QA',
        parentAgreementRef: 'SIMULATED',
        tasks: ['Story'],
        completion: 'ended',
        savedRecapRef: null,
        adultHelp: '',
        interruptions: '',
        observedBehavior: '',
        observerInterpretation: '',
        laterRecall: { status: 'not-run' },
      },
    };
    const one = await store.createObservation(ctx, actor, obs);
    await store.createObservation(ctx, actor, { ...obs, requestId: 'obs-two' });
    const page = await store.listFeedback(ctx, { limit: 1 });
    assert(page.nextCursor);
    await store.triageFeedback(ctx, actor, one.recordId, {
      requestId: 'triage',
      expectedRevision: 1,
      severity: 'normal',
      ownerRef: null,
      status: 'open',
      acIds: [],
      disposition: '',
      retestRef: null,
      nextReviewAt: null,
    });
    await assert.rejects(
      store.listFeedback(ctx, { limit: 1, cursor: page.nextCursor }),
      (e) => e.code === 'OPS_CURSOR_STALE',
    );
    const historical = { ...ctx, opsInstallationId: 'fresh-ops' };
    assert.equal(
      (await store.readFeedback(historical, one.recordId)).historical,
      true,
    );
    await assert.rejects(
      store.triageFeedback(historical, actor, one.recordId, {
        requestId: 'new',
        expectedRevision: 2,
        severity: 'normal',
        ownerRef: null,
        status: 'open',
        acIds: [],
        disposition: '',
        retestRef: null,
        nextReviewAt: null,
      }),
      (e) => e.code === 'OPS_HISTORY_ONLY',
    );
  }));

test('R4-E004 original UTC slot and durable reconcile identity survive admission', async () =>
  fresh(async (ctx) => {
    await store.acquireJob(ctx, acquire(ctx));
    const input = {
      jobId: 'job-reconcile',
      kind: 'reconcile',
      utcSlot: jobSlot('reconcile', ctx.now()),
      attemptId: 'reconcile-attempt',
      eventId: 'reconcile-acquired',
      objects: { subjectJobId: 'job-backup' },
    };
    const result = await store.acquireJob(ctx, input);
    assert.equal(result.utcSlot, input.utcSlot);
    assert.deepEqual(result.objects, input.objects);
    await assert.rejects(
      store.completeJobVerified(ctx, {
        jobId: input.jobId,
        attemptId: input.attemptId,
        expectedRevision: 1,
        eventId: 'reconcile-completed',
        result: {
          kind: 'reconcile',
          subjectJobId: 'wrong-job',
          outcome: 'confirmed',
        },
      }),
      (e) => e.code === 'INVALID_REQUEST',
    );
  }));
test('R4-E003 confirmed reconcile stores original request and exact replay', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    const input = {
      ...fence,
      observation: {
        outcome: 'confirmed',
        result: { kind: 'backup', archives: pair(ctx) },
      },
    };
    const result = await store.reconcileJob(ctx, input);
    assert.deepEqual(await store.reconcileJob(ctx, input), result);
    const event = (
      await client.execute(
        "SELECT public_json FROM ops_job_event WHERE id='job-completed'",
      )
    ).rows[0];
    assert.deepEqual(JSON.parse(event.public_json).request, input);
  }));

test('R4-E005/008 purearchive validatesactualfacts andrefuses forgeddigest/chain/pair', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    await store.completeJobVerified(ctx, {
      ...fence,
      result: { kind: 'backup', archives: pair(ctx) },
    });
    const source = opsSchemaSource(undefined, { version: 1 }),
      schema = source.schema;
    const tables = {};
    for (const table of OPS_TABLES)
      tables[table] = (await client.execute('SELECT * FROM ' + table)).rows.map(
        (r) => Object.fromEntries(Object.entries(r)),
      );
    const payload = {
      format: 'pilot-ops-backup-1',
      createdAt: new Date(ctx.now()).toISOString(),
      sourceOpsInstallationId: ctx.opsInstallationId,
      sourceInstallationId: ctx.installationId,
      environment: ctx.environment,
      buildId: ctx.buildId,
      migrations: source.migrations,
      schemaDigest: crypto
        .createHash('sha256')
        .update(JSON.stringify(schema))
        .digest('hex'),
      schema,
      tables,
    };
    await validateOpsArchive(payload, { source });
    const poisoned = structuredClone(payload),
      event = poisoned.tables.ops_job_event[0],
      pub = JSON.parse(event.public_json);
    pub.request.url = 'https://private.invalid';
    event.public_json = canonicalPackage(pub);
    event.request_digest = await hash(pub.request);
    await assert.rejects(
      validateOpsArchive(poisoned, { source }),
      /OPS_ARCHIVE_INVALID/,
    );
    for (const change of [
      (p) => p.tables.ops_archive.pop(),
      (p) => (p.tables.ops_job_event[1].previous_event_id = 'forged'),
      (p) =>
        (p.tables.ops_job_event[1].request_digest = 'sha256:' + 'c'.repeat(64)),
      (p) => (p.tables.ops_installation[0].installation_id = 'wrong'),
    ]) {
      const tampered = structuredClone(payload);
      change(tampered);
      await assert.rejects(
        validateOpsArchive(tampered, { source }),
        /OPS_ARCHIVE_INVALID/,
      );
    }
  }));

test('R4-E006 uncertain backup opens condition; ack does not resolve; paired recovery resolves', async () =>
  fresh(async (ctx) => {
    await store.acquireJob(ctx, acquire(ctx));
    await store.markJobUncertain(ctx, {
      ...fence,
      eventId: 'uncertain',
      code: 'OPS_EFFECT_UNCONFIRMED',
    });
    let status = await store.readOpsStatus(ctx);
    const alert = status.alerts.find((a) => a.code === 'OPS_BACKUP_FAILED');
    assert(alert);
    await store.acknowledgeAlert(
      ctx,
      { id: 'operator-unit', role: 'operator' },
      alert.id,
      { requestId: 'ack-alert', expectedRevision: alert.revision },
    );
    status = await store.readOpsStatus(ctx);
    assert.equal(
      status.alerts.find((a) => a.id === alert.id).status,
      'acknowledged',
    );
    await store.completeJobVerified(ctx, {
      ...fence,
      expectedRevision: 2,
      result: { kind: 'backup', archives: pair(ctx) },
    });
    status = await store.readOpsStatus(ctx);
    assert(!status.alerts.some((a) => a.id === alert.id));
  }));
test('R4-E006 missing pair and missing monitor produce bounded visible conditions', async () =>
  fresh(async (ctx) => {
    const first = await store.readOpsStatus(ctx);
    assert.equal(first.monitorState, 'unknown');
    assert(first.alerts.some((a) => a.code === 'OPS_BACKUP_STALE'));
    assert(first.alerts.some((a) => a.code === 'OPS_MONITOR_UNKNOWN'));
    const again = await store.readOpsStatus(ctx);
    assert.deepEqual(
      again.alerts.map((a) => a.id),
      first.alerts.map((a) => a.id),
    );
  }));

test('R4-E012 expiry crossing between detail and history never serves held private projection', async () =>
  fresh(async (ctx) => {
    const source = {
      childId: 'child-unit',
      runId: 'run-unit',
      runInstallationId: 'learn-unit',
      candidateId: 'build-unit',
      lessonId: 'forest-01',
      lessonVersion: 'forest-01-v4',
      contentDigest: 'sha256:' + 'a'.repeat(64),
      buildId: 'build-unit',
    };
    const saved = await store.createFeedback(
      ctx,
      { id: 'parent-unit', role: 'parent' },
      {
        requestId: 'cross-expiry',
        runId: 'run-unit',
        category: 'other',
        observed: 'SECRET crossing',
        expected: '',
      },
      source,
    );
    let calls = 0;
    const moving = {
      ...ctx,
      now: () => start + 2592000000 + (calls++ === 0 ? -1 : 0),
    };
    const detail = await store.readFeedback(moving, saved.recordId);
    assert.equal(detail.details, null);
    assert.equal(detail.status, 'expired');
    assert(!JSON.stringify(detail).includes('SECRET'));
  }));

test('R4-E007 retention admission cannot delete protected seven-day point', async () =>
  fresh(async (ctx, _client, set) => {
    await store.acquireJob(ctx, acquire(ctx));
    await store.completeJobVerified(ctx, {
      ...fence,
      result: { kind: 'backup', archives: pair(ctx) },
    });
    set(start + 86400000);
    const plan = {
      learning: { archiveId: 'learning-two', objectId: 'object-learning-two' },
      operations: { archiveId: 'ops-two', objectId: 'object-ops-two' },
    };
    await store.acquireJob(ctx, {
      ...acquire(ctx),
      jobId: 'backup-two',
      attemptId: 'attempt-two',
      eventId: 'acquired-two',
      objects: plan,
    });
    await store.completeJobVerified(ctx, {
      jobId: 'backup-two',
      attemptId: 'attempt-two',
      expectedRevision: 1,
      eventId: 'completed-two',
      result: {
        kind: 'backup',
        archives: pair(ctx).map((a) => ({
          ...a,
          id: plan[a.kind].archiveId,
          objectRef: plan[a.kind].objectId,
          weeklySlot: null,
        })),
      },
    });
    await assert.rejects(
      store.acquireJob(ctx, {
        jobId: 'retention-one',
        kind: 'retention',
        utcSlot: jobSlot('retention', ctx.now()),
        attemptId: 'retention-attempt',
        eventId: 'retention-acquired',
        objects: {
          archiveIds: ['archive-learning', 'archive-ops'],
          verifiedPointJobId: 'backup-two',
        },
      }),
      (e) => e.code === 'INVALID_REQUEST',
    );
  }));

test('R4-E011/012 correction enum and irreversible expiry remain archive valid', async () =>
  fresh(async (ctx, client, set) => {
    const actor = { id: 'operator-unit', role: 'operator' },
      observation = {
        kind: 'synthetic',
        participantLabel: 'QA',
        candidateId: 'build',
        lessonVersion: 'forest-01-v4',
        contentDigest: 'sha256:' + 'a'.repeat(64),
        observedAt: start,
        device: 'QA',
        browser: 'QA',
        parentAgreementRef: 'SIMULATED',
        tasks: ['Story'],
        completion: 'ended',
        savedRecapRef: null,
        adultHelp: '',
        interruptions: '',
        observedBehavior: '',
        observerInterpretation: '',
        laterRecall: { status: 'not-run' },
      };
    const saved = await store.createObservation(ctx, actor, {
      requestId: 'observation-original',
      observation,
    });
    await store.correctObservation(ctx, actor, saved.recordId, {
      requestId: 'observation-correction',
      expectedRevision: 1,
      observation: { ...observation, participantLabel: 'corrected QA' },
      correctionReason: 'attribution correction',
    });
    const source = opsSchemaSource(undefined, { version: 1 }),
      schema = source.schema;
    async function capture() {
      const tables = {};
      for (const table of OPS_TABLES)
        tables[table] = (
          await client.execute('SELECT * FROM ' + table)
        ).rows.map((r) => Object.fromEntries(Object.entries(r)));
      return {
        format: 'pilot-ops-backup-1',
        createdAt: new Date(ctx.now()).toISOString(),
        sourceOpsInstallationId: ctx.opsInstallationId,
        sourceInstallationId: ctx.installationId,
        environment: ctx.environment,
        buildId: ctx.buildId,
        migrations: source.migrations,
        schemaDigest: crypto
          .createHash('sha256')
          .update(JSON.stringify(schema))
          .digest('hex'),
        schema,
        tables,
      };
    }
    const before = await capture();
    assert.equal(before.tables.ops_feedback_event[1].kind, 'corrected');
    await validateOpsArchive(before, { source });
    set(start + 2592000000);
    await store.readFeedback(ctx, saved.recordId);
    const after = await capture();
    await validateOpsArchive(after, { source });
    const forged = structuredClone(after);
    forged.tables.ops_feedback_event[0].private_json = '{}';
    await assert.rejects(validateOpsArchive(forged, { source }));
  }));
test('R4-E006 notification result exact replay is private and visible failure condition', async () =>
  fresh(async (ctx) => {
    const status = await store.readOpsStatus(ctx),
      alert = status.alerts[0],
      input = {
        alertId: alert.id,
        eventId: 'notification-unit',
        outcome: 'failed',
      };
    const ack = await store.recordOpsNotification(ctx, input);
    assert.deepEqual(await store.recordOpsNotification(ctx, input), ack);
    await assert.rejects(
      store.recordOpsNotification(ctx, { ...input, outcome: 'delivered' }),
      (e) => e.code === 'OPS_CONFLICT',
    );
    assert(
      (await store.readOpsStatus(ctx)).alerts.some(
        (a) => a.code === 'OPS_NOTIFICATION_FAILED',
      ),
    );
  }));

test('R4-E007 settled retention appends explicit deletion fact', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    await store.completeJobVerified(ctx, {
      ...fence,
      result: { kind: 'backup', archives: pair(ctx) },
    });
    await store.acquireJob(ctx, {
      jobId: 'retention-empty',
      kind: 'retention',
      utcSlot: jobSlot('retention', ctx.now()),
      attemptId: 'retention-attempt',
      eventId: 'retention-start',
      objects: { archiveIds: [], verifiedPointJobId: 'job-backup' },
    });
    await store.completeJobVerified(ctx, {
      jobId: 'retention-empty',
      attemptId: 'retention-attempt',
      expectedRevision: 1,
      eventId: 'retention-finish',
      result: { kind: 'retention', deletedArchiveIds: [] },
    });
    assert.equal(
      (
        await client.execute(
          "SELECT kind FROM ops_job_event WHERE id='retention-finish'",
        )
      ).rows[0].kind,
      'archive-deleted',
    );
  }));

test('R4-E004 verified reconciliation refuses unconfirmed outcome without terminal credit', async () =>
  fresh(async (ctx, client) => {
    await store.acquireJob(ctx, acquire(ctx));
    const input = {
      jobId: 'reconcile-unconfirmed',
      kind: 'reconcile',
      utcSlot: jobSlot('reconcile', ctx.now()),
      attemptId: 'reconcile-attempt',
      eventId: 'reconcile-start',
      objects: { subjectJobId: 'job-backup' },
    };
    await store.acquireJob(ctx, input);
    await assert.rejects(
      store.completeJobVerified(ctx, {
        jobId: input.jobId,
        attemptId: input.attemptId,
        expectedRevision: 1,
        eventId: 'unconfirmed-finish',
        result: {
          kind: 'reconcile',
          subjectJobId: 'job-backup',
          outcome: 'unconfirmed',
        },
      }),
      (e) => e.code === 'INVALID_REQUEST',
    );
    assert.equal(
      (
        await client.execute(
          "SELECT status FROM ops_job WHERE id='reconcile-unconfirmed'",
        )
      ).rows[0].status,
      'running',
    );
  }));

test('R4-E003 named final feedback write fault aborts projection and full event batch', async () =>
  fresh(async (ctx, client) => {
    const actor = { id: 'parent-unit', role: 'parent' },
      source = {
        childId: 'child-unit',
        runId: 'run-unit',
        runInstallationId: 'learn-unit',
        candidateId: 'build-unit',
        lessonId: 'forest-01',
        lessonVersion: 'forest-01-v4',
        contentDigest: 'sha256:' + 'a'.repeat(64),
        buildId: 'build-unit',
      },
      input = {
        requestId: 'final-fault-feedback',
        runId: 'run-unit',
        category: 'other',
        observed: 'SYNTHETIC',
        expected: '',
      };
    await assert.rejects(
      store.createFeedback(
        { ...ctx, testFault: 'feedback-final-write' },
        actor,
        input,
        source,
      ),
    );
    assert.equal(
      Number(
        (await client.execute('SELECT count(*) n FROM ops_feedback')).rows[0].n,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.execute('SELECT count(*) n FROM ops_feedback_event'))
          .rows[0].n,
      ),
      0,
    );
  }));

test('R4-E010 foreign history record binding refuses before stale revision classification', async () =>
  fresh(async (ctx) => {
    const actor = { id: 'parent-unit', role: 'parent' },
      source = {
        childId: 'child-unit',
        runId: 'run-unit',
        runInstallationId: 'learn-unit',
        candidateId: 'build-unit',
        lessonId: 'forest-01',
        lessonVersion: 'forest-01-v4',
        contentDigest: 'sha256:' + 'a'.repeat(64),
        buildId: 'build-unit',
      },
      input = {
        requestId: 'cursor-a',
        runId: 'run-unit',
        category: 'other',
        observed: 'SYNTHETIC cursor',
        expected: '',
      };
    const first = await store.createFeedback(ctx, actor, input, source),
      second = await store.createFeedback(
        ctx,
        actor,
        { ...input, requestId: 'cursor-b' },
        source,
      );
    await store.triageFeedback(
      ctx,
      { id: 'operator-unit', role: 'operator' },
      first.recordId,
      {
        requestId: 'cursor-triage',
        expectedRevision: 1,
        severity: 'normal',
        ownerRef: null,
        status: 'open',
        acIds: [],
        disposition: '',
        retestRef: null,
        nextReviewAt: null,
      },
    );
    const history = await store.readFeedbackHistory(ctx, first.recordId, {
      limit: 1,
    });
    assert(history.nextCursor);
    await assert.rejects(
      store.readFeedbackHistory(ctx, second.recordId, {
        cursor: history.nextCursor,
      }),
      (e) => e.code === 'INVALID_REQUEST' && e.status === 400,
    );
  }));
